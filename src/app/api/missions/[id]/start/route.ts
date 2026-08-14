/**
 * @file app/api/missions/[id]/start/route.ts
 * @description Start a published app artifact's stopped sandbox so its live
 * preview is reachable again. The persisted workspace volume is retained, but
 * the runtime is recreated from current trusted config before the preview is
 * relaunched. POST /api/missions/:id/start
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { isSystemPrincipal } from '@/lib/system-principals';
import { importSandbox } from '@/lib/agent-import';
import { waitForPreviewReady } from '@/lib/build-preview-readiness';
import { launchReviewedPreview } from '@/lib/build-preview-workspace';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';
import { createLogger } from '@/lib/logger';
import { getMissionById, updateMission } from '@/lib/missions';

const log = createLogger('api-mission-start');

function isExplicitlyMissingDockerVolume(result: { code: number; stdout: string; stderr: string }): boolean {
  if (result.code === 0) return false;
  return /no such volume/i.test(`${result.stderr}\n${result.stdout}`);
}

class StartFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.error === 'string' ? body.error : 'Artifact start failed');
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const releaseOperation = acquireBuildRuntimeOperation(id);
  if (!releaseOperation) {
    return NextResponse.json(
      { error: 'This artifact is already being started.', code: 'start-in-progress' },
      { status: 409 }
    );
  }
  let cleanupRecreatedRuntime: (() => Promise<void>) | null = null;

  try {
    const mission = await getMissionById(id);
    if (!mission) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    // ARUN-005: in local single-user mode the signed-in user may operate on
    // system-dispatched missions too (visible rows must not carry dead 403
    // buttons; a system build paused on a human gate must be resolvable).
    // Missions of another HUMAN user stay forbidden.
    if (mission.userId !== auth.uid && !isSystemPrincipal(mission.userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (
      mission.kind !== 'build' ||
      mission.status !== 'completed' ||
      (mission.artifactKind ?? 'solution') !== 'solution'
    ) {
      return NextResponse.json(
        {
          error: 'Only a completed solution artifact can be started.',
          code: 'artifact-not-startable',
        },
        { status: 409 }
      );
    }
    if (!mission.sandbox) return NextResponse.json({ error: 'No sandbox to start' }, { status: 400 });
    const acceptedReview = mission.artifact?.acceptedReview;
    if (mission.buildMode === 'limitless' && !acceptedReview) {
      return NextResponse.json(
        {
          error:
            'This Limitless artifact predates durable reviewer evidence and cannot be restarted automatically.',
          code: 'artifact-integrity-evidence-missing',
        },
        { status: 409 }
      );
    }
    // The GC reclaims the container AND volume past the retention window, then
    // writes `sandbox.state: 'destroyed'` (the object survives, so !mission.sandbox
    // is false). Without this guard `driver.resume` fails on a missing container
    // and the caller got an opaque 500. 410 Gone + a `sandbox-reclaimed` code lets
    // the UI say the preview is unrecoverable, mirroring the Iterate path.
    if (mission.sandbox.state === 'destroyed') {
      return NextResponse.json(
        {
          error:
            'The retained sandbox workspace for this artifact is no longer available — its live preview is gone and ' +
            'cannot be restarted. Start a new mission to rebuild it.',
          code: 'sandbox-reclaimed',
        },
        { status: 410 }
      );
    }
    if (mission.sandbox.state !== 'stopped') {
      return NextResponse.json(
        {
          error: `The artifact sandbox is ${mission.sandbox.state}, not stopped.`,
          code: 'sandbox-not-stopped',
        },
        { status: 409 }
      );
    }
    const hostPort = mission.sandbox.hostPort;
    if (hostPort === undefined || !Number.isInteger(hostPort) || hostPort <= 0) {
      return NextResponse.json(
        {
          error: 'The sandbox runtime is missing its persisted preview port and cannot be restarted safely.',
          code: 'sandbox-runtime-incomplete',
        },
        { status: 409 }
      );
    }

    const sandbox = await importSandbox();
    const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
    const ref = {
      driver: mission.sandbox.driver,
      missionId: id,
      containerName: mission.sandbox.containerName,
      volumeName: mission.sandbox.volumeName,
      image: mission.sandbox.image,
      hostPort,
      workspacePath: mission.sandbox.workspacePath,
    };
    const driver = sandbox.getDriver(cfg.driver);
    const volumeProbe = await sandbox.defaultExec('docker', ['volume', 'inspect', ref.volumeName]);
    if (volumeProbe.code !== 0) {
      // A non-zero inspect result is not necessarily absence: daemon outages,
      // permissions, and host command failures must leave the stopped state
      // retryable. Only Docker's explicit missing-volume response proves the
      // retained workspace is gone.
      if (!isExplicitlyMissingDockerVolume(volumeProbe)) {
        log.warn('Could not verify the persisted artifact volume', {
          missionId: id,
          exitCode: volumeProbe.code,
        });
        return NextResponse.json(
          {
            error: 'The persisted artifact volume could not be verified. Please check Docker and retry.',
            code: 'sandbox-volume-probe-failed',
          },
          { status: 503 }
        );
      }
      await updateMission(id, {
        sandbox: {
          ...mission.sandbox,
          state: 'destroyed',
        },
      });
      log.info('Persisted artifact volume is missing; marked sandbox as destroyed', { missionId: id });
      return NextResponse.json(
        {
          error: 'The persisted artifact volume is missing and cannot be restarted.',
          code: 'sandbox-volume-missing',
        },
        { status: 410 }
      );
    }
    // A stopped container retains its original configured environment and
    // writable layer. Preserve only the named mission volume + host port and
    // recreate the runtime from current config/env before executing artifact
    // code again.
    const recreated = await sandbox.recreateSandboxRuntime({
      cfg,
      missionId: id,
      driver,
      ref,
      hostPort,
      artifactKind: mission.artifactKind ?? 'solution',
      purpose: 'preview',
    });
    const activeRef = recreated.ref;
    const sandboxCreatedAt = mission.sandbox.createdAt;
    cleanupRecreatedRuntime = async () => {
      await driver.destroy(activeRef, { removeVolume: false });
      if (await driver.isRunning(activeRef)) {
        throw new Error(`Replacement sandbox ${activeRef.containerName} is still running after cleanup`);
      }
      await updateMission(id, {
        sandbox: {
          driver: activeRef.driver,
          image: activeRef.image,
          containerName: activeRef.containerName,
          volumeName: activeRef.volumeName,
          hostPort: activeRef.hostPort,
          workspacePath: activeRef.workspacePath,
          state: 'stopped',
          createdAt: sandboxCreatedAt,
        },
      });
    };
    for (const warning of recreated.warnings) {
      log.warn('Artifact runtime recreation warning', { missionId: id, warning });
    }

    const assertAcceptedWorkspace = async () => {
      if (!acceptedReview) return;
      await sandbox.resetWorkspaceGitControlPlane(driver, activeRef);
      const [gitHead, residualChanges, workspaceSnapshot] = await Promise.all([
        sandbox.readWorkspaceGitHead(driver, activeRef),
        sandbox.listWorkspaceChangesSince(driver, activeRef, acceptedReview.gitHead),
        sandbox.captureReviewerWorkspaceSnapshot(driver, activeRef, acceptedReview.sessionIndex),
      ]);
      if (
        gitHead !== acceptedReview.gitHead ||
        JSON.stringify([...residualChanges].sort()) !==
          JSON.stringify([...acceptedReview.residualChanges].sort()) ||
        !workspaceSnapshot ||
        workspaceSnapshot.version !== acceptedReview.workspaceSnapshot.version ||
        workspaceSnapshot.algorithm !== acceptedReview.workspaceSnapshot.algorithm ||
        workspaceSnapshot.digest !== acceptedReview.workspaceSnapshot.digest ||
        workspaceSnapshot.entries !== acceptedReview.workspaceSnapshot.entries ||
        workspaceSnapshot.bytes !== acceptedReview.workspaceSnapshot.bytes
      ) {
        throw new StartFailure(409, {
          error:
            'The retained artifact workspace no longer matches the generation accepted by the Limitless reviewer.',
          code: 'artifact-integrity-mismatch',
        });
      }
    };

    // BUILD-026 verify-after: runtime creation returning is a self-report.
    // Confirm the replacement is actually up before recording it.
    const running = await driver.isRunning(activeRef);
    if (!running) {
      log.warn('Start could not verify the sandbox is running', { missionId: id });
      throw new StartFailure(502, {
        error: 'The sandbox did not come back up. Please retry.',
        code: 'start-unverified',
      });
    }
    await assertAcceptedWorkspace();
    await launchReviewedPreview({
      driver,
      ref: activeRef,
      buildSanitizedShellCommand: sandbox.buildSanitizedShellCommand,
      retainedWorkspacePath: activeRef.workspacePath,
      containerPort: cfg.containerPort,
      forbiddenValues: sandbox.resolveContainerSecretValues(
        cfg,
        process.env,
        sandbox.platformServersFor(cfg, mission.artifactKind ?? 'solution')
      ),
    });

    const previewUrl = `http://localhost:${activeRef.hostPort}`;
    // The route only commits the running state after a successful 2xx probe.
    const previewReady = await waitForPreviewReady(previewUrl);
    if (!previewReady) {
      log.warn('Start restarted the sandbox but the preview never became reachable', { missionId: id });
      throw new StartFailure(503, {
        error:
          'The sandbox restarted but its live preview did not become reachable in time. It may still be ' +
          'starting — please retry in a moment.',
        code: 'preview-unreachable',
        previewUrl,
      });
    }
    // A reviewed lifecycle hook could still mutate the retained volume while
    // starting the preview. Recheck before making the running state durable.
    await assertAcceptedWorkspace();
    await updateMission(id, {
      sandbox: {
        driver: activeRef.driver,
        image: activeRef.image,
        containerName: activeRef.containerName,
        volumeName: activeRef.volumeName,
        hostPort: activeRef.hostPort,
        workspacePath: activeRef.workspacePath,
        state: 'running',
        createdAt: new Date().toISOString(),
      },
    });
    cleanupRecreatedRuntime = null;
    log.info('Build artifact started', { missionId: id });
    return NextResponse.json({ ok: true, previewUrl });
  } catch (error) {
    if (cleanupRecreatedRuntime) {
      try {
        await cleanupRecreatedRuntime();
      } catch (cleanupError) {
        log.error(
          'Failed to clean up replacement runtime after unsuccessful artifact start',
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          {
            missionId: id,
            startError: error instanceof Error ? error.message : String(error),
          }
        );
        return NextResponse.json(
          {
            error: 'The artifact failed to start and its replacement runtime could not be safely cleaned up.',
            code: 'start-cleanup-failed',
          },
          { status: 500 }
        );
      }
    }
    if (error instanceof StartFailure) {
      return NextResponse.json(error.body, { status: error.status });
    }
    log.error('Failed to start artifact', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    return NextResponse.json({ error: 'Failed to start the artifact sandbox' }, { status: 500 });
  } finally {
    releaseOperation();
  }
}
