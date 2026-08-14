/**
 * @file cleanup-stuck-missions.ts
 * @description H4 + H8 — scheduled GC for missions stuck in non-terminal
 * states. Runs every 6 hours (matches the sweep cadence) and forces any
 * mission still in 'running' or 'pending' past the threshold into
 * 'failed' with a marker error.
 *
 * Why this exists: Inngest's onFailure only fires when the function
 * throws. If the worker process dies (OOM, deploy, segfault), the
 * function vanishes silently and the mission stays 'running' forever.
 * Audit (2026-05-04) found 11 such missions outstanding for >24h.
 *
 * Repairs terminal state and garbage-collects stale mission artifacts.
 */
import { inngest } from '../client';
import { getStuckMissions, markMissionStuck } from '@/lib/missions';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/cleanup-stuck-missions');

const DEFAULT_THRESHOLD_HOURS = 24;

export const cleanupStuckMissionsJob = inngest.createFunction(
  {
    id: 'cleanup-stuck-missions',
    name: 'Cleanup Stuck Missions',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('cleanup-stuck-missions failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  [{ event: 'app/schedule.missions.cleanup' }, { cron: 'TZ=UTC 0 */6 * * *' }],
  async ({ event, step }) => {
    const { thresholdHours = DEFAULT_THRESHOLD_HOURS } = (event?.data ?? {}) as {
      thresholdHours?: number;
    };

    const stuck = await step.run('list-stuck-missions', async () => getStuckMissions(thresholdHours));

    let cleaned = 0;
    let failed = 0;
    const reason = `Mission stuck in non-terminal state for >${thresholdHours}h — force-failed by lifecycle GC.`;

    await step.run('mark-stuck-missions', async () => {
      for (const mission of stuck) {
        try {
          await markMissionStuck(mission.id, reason);
          cleaned++;
        } catch (err) {
          failed++;
          log.warn('Failed to mark mission stuck', {
            missionId: mission.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    await step.run('emit-completion-event', async () => {
      await inngest.send({
        name: 'app/schedule.missions.cleanup.completed',
        data: { cleaned, failed, thresholdHours, total: stuck.length },
      });
    });

    log.info('cleanup-stuck-missions complete', { cleaned, failed, thresholdHours, total: stuck.length });
    return { cleaned, failed, thresholdHours };
  }
);
