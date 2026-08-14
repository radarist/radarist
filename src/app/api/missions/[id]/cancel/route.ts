/**
 * @file app/api/missions/[id]/cancel/route.ts
 * @description Cancel a running build mission. Stops the sandbox container
 * directly (Inngest's cancelOn terminates the run without executing cleanup
 * steps), then emits the cancel event that cancelOn matches.
 *
 * POST /api/missions/:id/cancel
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { isSystemPrincipal } from '@/lib/system-principals';
import { importSandbox } from '@/lib/agent-import';
import { inngest } from '@/lib/inngest/client';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';
import { createLogger } from '@/lib/logger';
import { getMissionById, reconcileBuildMissionCostAccounting, updateMission } from '@/lib/missions';

const log = createLogger('api-mission-cancel');

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const { id } = await params;
  const releaseOperation = acquireBuildRuntimeOperation(id);
  if (!releaseOperation) {
    return NextResponse.json(
      {
        error: 'A runtime operation is already in progress for this mission.',
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
    if (mission.kind !== 'build') {
      return NextResponse.json({ error: 'Cancel only applies to build missions' }, { status: 400 });
    }
    if (mission.status === 'completed' || mission.status === 'failed') {
      return NextResponse.json({ error: `Mission already ${mission.status}` }, { status: 409 });
    }

    // Stop the container ourselves — cancelOn kills the run, it does not
    // run cleanup. The volume is ALWAYS kept (resume/forensics).
    //
    // BUILD-026 verify-after: the docker driver's `stop` swallows a non-zero
    // exit, so trusting it let cancel report success over a still-running
    // container (the "cancelled" row lied while the build kept burning budget).
    // Confirm the container is actually down; if it isn't, this is a real
    // failure — do NOT mark the mission failed or fire cancelOn, so the
    // operation stays retryable (the terminal-status guard above only trips
    // once the mission is genuinely terminal). An already-exited container
    // (the run crashed) reports not-running, which correctly lets cancel
    // proceed to reconcile the status.
    if (mission.sandbox) {
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
      const stillRunning = await driver.isRunning(ref);
      if (stillRunning) {
        log.warn('Cancel could not stop the sandbox — leaving the run uncancelled', { missionId: id });
        return NextResponse.json(
          {
            error: 'Could not stop the build sandbox — the run was not cancelled. Please retry.',
            code: 'cancel-stop-failed',
          },
          { status: 502 }
        );
      }
    }

    // Fire the run-abort BEFORE flipping the mission to failed, so a delivery
    // failure leaves the mission in its current (non-terminal) state — the
    // terminal-status guard above then still lets a retry through, instead of
    // stranding a mission marked "failed" whose run was never actually aborted.
    await inngest.send({ name: 'app/build-mission.cancel.requested', data: { missionId: id, userId: auth.uid } });

    const completedAt = new Date().toISOString();
    const recovery = mission.recovery;
    const cancelledRecovery = recovery
      ? {
          terminal: {
            reason: 'cancelled' as const,
            recordedAt: completedAt,
            phase: mission.buildPhase && mission.buildPhase !== 'published' ? mission.buildPhase : '00-inception',
            ...(mission.buildStatusObservedAt ? { statusObservedAt: mission.buildStatusObservedAt } : {}),
          },
          ...(recovery.authorizedMaxTurns ? { authorizedMaxTurns: recovery.authorizedMaxTurns } : {}),
          attempts: recovery.attempts.map((attempt) =>
            attempt.id === recovery.activeOperationId
              ? { ...attempt, status: 'completed' as const, completedAt, failure: 'cancelled by user' }
              : attempt
          ),
        }
      : undefined;
    await updateMission(id, {
      status: 'failed',
      buildState: 'paused',
      completedAt,
      errors: ['cancelled by user'],
      ...(mission.sandbox ? { sandbox: { ...mission.sandbox, state: 'stopped' } } : {}),
      ...(cancelledRecovery ? { recovery: cancelledRecovery } : {}),
    });
    await reconcileBuildMissionCostAccounting(id, { state: 'terminal', observedAt: completedAt });

    log.info('Build mission cancelled', { missionId: id, userId: auth.uid });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error('Failed to cancel mission', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    return NextResponse.json({ error: 'Failed to cancel mission' }, { status: 500 });
  } finally {
    releaseOperation();
  }
}
