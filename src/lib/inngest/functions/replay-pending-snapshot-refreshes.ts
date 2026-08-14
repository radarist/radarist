/**
 * @file lib/inngest/functions/replay-pending-snapshot-refreshes.ts
 * @description ARUN-028 — durable replay for missed post-research snapshot refreshes.
 *
 * When a completed research attempt could not dispatch its
 * `app/technology.updated` placement-snapshot refresh, the handler records
 * durable `pendingSnapshotRefresh` debt on the technology document. This job
 * drains that debt: it re-dispatches the refresh idempotently and clears the
 * marker on success. A failed re-dispatch leaves the debt for the next cycle,
 * and the placement-snapshot consumer is idempotent, so a duplicate delivery is
 * safe. Research is never touched — it is already `completed`.
 *
 * **Trigger:** Cron (every 10 minutes) or on demand.
 * **Retries:** 1
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import {
  clearPendingSnapshotRefresh,
  listTechnologiesWithPendingSnapshotRefresh,
} from '@/lib/technology-research-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/replay-pending-snapshot-refreshes');

/** Upper bound on refreshes drained per cycle — a runaway-backlog guard. */
export const REPLAY_PENDING_SNAPSHOT_REFRESH_BATCH = 100;

export const replayPendingSnapshotRefreshesJob = inngest.createFunction(
  {
    id: 'replay-pending-snapshot-refreshes',
    name: 'Replay Pending Post-Research Snapshot Refreshes',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('Replay pending snapshot refreshes failure', new Error(error.message));
    },
  },
  { cron: 'TZ=UTC */10 * * * *' },
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('replay-pending-snapshot-refreshes');

    const pending = await step.run('list-pending-snapshot-refreshes', async () =>
      listTechnologiesWithPendingSnapshotRefresh(REPLAY_PENDING_SNAPSHOT_REFRESH_BATCH)
    );

    if (pending.length === 0) {
      return { replayed: 0, cleared: 0, failed: 0 };
    }

    const result = await step.run('replay-and-clear', async () => {
      let replayed = 0;
      let cleared = 0;
      let failed = 0;
      for (const { id, attemptToken } of pending) {
        try {
          const accepted = await inngest.send({
            name: 'app/technology.updated',
            data: { technologyId: id, updatedFields: [] },
          });
          // A send with no accepted ids (e.g. the Inngest kill switch) did NOT
          // enqueue the refresh — retain the debt instead of destroying it.
          if (!accepted?.ids?.length) {
            failed++;
            log.warn('Replay send was not acknowledged; debt retained for next cycle', { technologyId: id });
            continue;
          }
          replayed++;
          // Clear only the exact attempt's debt. A newer attempt that recorded
          // fresh debt in the meantime keeps its marker (token mismatch).
          if (await clearPendingSnapshotRefresh(id, attemptToken)) cleared++;
        } catch (error) {
          failed++;
          log.warn('Failed to replay pending snapshot refresh; debt retained for next cycle', {
            technologyId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { replayed, cleared, failed };
    });

    log.info('Replayed pending snapshot refreshes', result);
    return result;
  }
);
