/**
 * @file lib/inngest/functions/cleanup-archived-signals.ts
 * @description Scheduled job to clean up old archived signals (L4.6)
 *
 * This function runs weekly to permanently delete archived signals
 * that have exceeded the retention period.
 *
 * **Features:**
 * - Configurable retention period (default: 90 days)
 * - Reads retention setting from platform configuration
 * - Batch deletes for efficiency
 * - Logs cleanup statistics
 *
 * **Trigger:** Cron (weekly on Sunday at 2:00 AM UTC)
 * **Timeout:** 5 minutes
 * **Retries:** 1 attempt
 *
 * @author Radarist Team
 * @created 2025-12-04
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import {
  adminCleanupArchivedSignals as cleanupArchivedSignals,
  adminGetArchivedSignals as getArchivedSignals,
} from '@/lib/signals-admin';
import { adminGetPlatformConfig as getPlatformConfig } from '@/lib/platform-config-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/cleanup-archived-signals');

/**
 * Cleanup archived signals job
 *
 * **Trigger:** Cron (weekly on Sunday at 2:00 AM UTC)
 * **Timeout:** 5 minutes
 */
export const cleanupArchivedSignalsJob = inngest.createFunction(
  {
    id: 'cleanup-archived-signals',
    name: 'Cleanup Archived Signals',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('Cleanup archived signals job failure', new Error(error.message));
      // Send failure event for monitoring
      await inngest.send({
        name: 'app/signals.cleanup.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  /**
   * Cron trigger - weekly on Sunday at 2:00 AM UTC
   */
  { cron: '0 2 * * 0' },

  /**
   * Main function handler
   */
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('cleanup-archived-signals');
    /**
     * Step 1: Get platform configuration for retention period
     */
    const config = await step.run('get-config', async () => {
      log.info('Loading platform configuration');
      const platformConfig = await getPlatformConfig();
      const retentionDays = platformConfig.archiveRetentionDays;
      log.info('Retention period configured', { retentionDays });
      return { retentionDays };
    });

    /**
     * Step 2: Get count of archived signals for logging
     */
    const preStats = await step.run('get-pre-stats', async () => {
      const archived = await getArchivedSignals();
      log.info('Found archived signals', { count: archived.length });
      return { totalArchived: archived.length };
    });

    /**
     * Step 3: Run cleanup
     */
    const result = await step.run('cleanup', async () => {
      log.info('Running cleanup');

      const cleanupResult = await cleanupArchivedSignals(config.retentionDays);

      log.info('Cleanup complete');
      log.info('Cleanup deleted signals', { deleted: cleanupResult.deleted });
      if (cleanupResult.failed.length > 0) {
        log.warn('Some cleanups failed', { failedCount: cleanupResult.failed.length });
      }

      return cleanupResult;
    });

    /**
     * Step 4: Send completion event
     */
    await step.run('send-completion', async () => {
      await inngest.send({
        name: 'app/signals.cleanup.completed',
        data: {
          retentionDays: config.retentionDays,
          totalArchived: preStats.totalArchived,
          deleted: result.deleted,
          failed: result.failed.length,
          completedAt: Date.now(),
        },
      });

      log.info('Job completed');
    });

    return {
      success: true,
      retentionDays: config.retentionDays,
      signalsBefore: preStats.totalArchived,
      signalsDeleted: result.deleted,
      signalsFailed: result.failed.length,
    };
  }
);
