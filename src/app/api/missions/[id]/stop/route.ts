/**
 * @file app/api/missions/[id]/stop/route.ts
 * @description Stop (pause) a published app artifact's sandbox container — keeps
 * the volume AND the mission's `completed` status (this is NOT cancel, which
 * fails an in-flight run). Frees the host while the app isn't being demoed; a
 * later Start revives it. POST /api/missions/:id/stop
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { isSystemPrincipal } from '@/lib/system-principals';
import { importSandbox } from '@/lib/agent-import';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';
import { createLogger } from '@/lib/logger';
import { getMissionById, updateMission } from '@/lib/missions';

const log = createLogger('api-mission-stop');

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;
  const releaseOperation = acquireBuildRuntimeOperation(id);
  if (!releaseOperation) {
    return NextResponse.json(
      {
        error: 'A start or stop operation is already in progress for this artifact.',
        code: 'sandbox-operation-in-progress',
      },
      { status: 409 }
    );
  }

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
          error: 'Only a completed solution artifact can be stopped.',
          code: 'artifact-not-stoppable',
        },
        { status: 409 }
      );
    }
    if (!mission.sandbox) return NextResponse.json({ error: 'No sandbox to stop' }, { status: 400 });
    if (mission.sandbox.state !== 'running') {
      return NextResponse.json(
        {
          error: `The artifact sandbox is ${mission.sandbox.state}, not running.`,
          code: 'sandbox-not-running',
        },
        { status: 409 }
      );
    }

    const sandbox = await importSandbox();
    const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
    const driver = sandbox.getDriver(cfg.driver);
    const ref = {
      driver: mission.sandbox.driver,
      missionId: id,
      containerName: mission.sandbox.containerName,
      volumeName: mission.sandbox.volumeName,
      image: mission.sandbox.image,
      hostPort: mission.sandbox.hostPort ?? 0,
      workspacePath: mission.sandbox.workspacePath,
    };
    if (await driver.isRunning(ref)) {
      await driver.stop(ref);
    }

    // BUILD-026 verify-after: confirm the container is actually down before flipping the row to
    // "Stopped" — otherwise we'd report success over a still-running container.
    // An already-gone container (GC-reclaimed) reports not-running here, which
    // is the correct "stopped" outcome.
    const stillRunning = await driver.isRunning(ref);
    if (stillRunning) {
      log.warn('Stop could not verify the sandbox is down', { missionId: id });
      return NextResponse.json(
        { error: 'The sandbox did not stop. Please retry.', code: 'stop-unverified' },
        { status: 502 }
      );
    }
    await updateMission(id, { sandbox: { ...mission.sandbox, state: 'stopped' } });

    log.info('Build artifact stopped', { missionId: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error('Failed to stop artifact', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    return NextResponse.json({ error: 'Failed to stop the artifact sandbox' }, { status: 500 });
  } finally {
    releaseOperation();
  }
}
