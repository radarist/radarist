/**
 * @file refresh-community-reports.ts
 * @description Nightly F2 overlay: re-runs Louvain + regenerates the
 * top-N :CommunityReport nodes. Off the hot write path by design — this
 * is a batch indexing layer, not something chat/agent writes should
 * trigger. Chat retrieval uses queryCommunityReports on the existing
 * reports.
 */
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/refresh-community-reports');

export const refreshCommunityReportsJob = inngest.createFunction(
  {
    id: 'refresh-community-reports',
    name: 'Refresh Community Reports',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error(
        'refresh-community-reports failed permanently',
        error instanceof Error ? error : new Error(String(error))
      );
    },
  },
  // Daily at 03:00 UTC + on-demand via event.
  [{ event: 'app/schedule.community-reports.refresh' }, { cron: 'TZ=UTC 0 3 * * *' }],
  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('refresh-community-reports');
    const startedAt = await step.run('record-start', async () => Date.now());
    const {
      topN = 10,
      minSize = 5,
      dryRun = false,
    } = (event?.data ?? {}) as {
      topN?: number;
      minSize?: number;
      dryRun?: boolean;
    };

    const result = await step.run('build-community-reports', async () => {
      const { buildCommunityReports } = await import('@/lib/graph/community-reports');
      return buildCommunityReports({ topN, minSize, dryRun });
    });

    const durationMs = Date.now() - startedAt;

    await step.run('emit-completion-event', async () => {
      await inngest.send({
        name: 'app/schedule.community-reports.refresh.completed',
        data: {
          reportCount: result.reports.length,
          communitiesFailed: result.communitiesFailed,
          modularity: result.modularity,
          durationMs,
        },
      });
    });

    log.info('refresh-community-reports complete', {
      reportCount: result.reports.length,
      communitiesFailed: result.communitiesFailed,
      modularity: result.modularity,
      durationMs,
    });

    return {
      // P3-B run-summary honesty: a run with partial failures reports them
      // (total failure throws inside buildCommunityReports and fails the cron).
      success: result.communitiesFailed === 0,
      reportCount: result.reports.length,
      communitiesFailed: result.communitiesFailed,
      modularity: result.modularity,
      durationMs,
      dryRun,
    };
  }
);
