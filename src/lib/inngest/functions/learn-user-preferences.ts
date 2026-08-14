/**
 * @file inngest/functions/learn-user-preferences.ts
 * @description Nightly Inngest cron that harvests per-user preferences
 * from mission history. Writes `userPreferences/{uid}` for each user who
 * has dispatched at least one mission in the last 30 days.
 *
 * Companion to the orchestrator preamble injector — keeps the profile
 * fresh without any user action.
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { harvestUserPreferences } from '@/lib/user-preferences';

const log = createLogger('inngest/learn-user-preferences');

const HARVEST_WINDOW_DAYS = 30;

export const learnUserPreferences = inngest.createFunction(
  {
    id: 'learn-user-preferences',
    name: 'Learn User Preferences (Nightly)',
    retries: 2,
  },
  // 03:00 UTC daily — low-traffic window
  { cron: 'TZ=UTC 0 3 * * *' },
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('learn-user-preferences');
    const cutoff = new Date(Date.now() - HARVEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const activeUserIds = await step.run('collect-active-users', async () => {
      const snap = await db.collection('missions').where('createdAt', '>=', cutoff).select('userId').get();
      const uids = new Set<string>();
      for (const d of snap.docs) {
        const userId = (d.data() as { userId?: string }).userId;
        if (userId) uids.add(userId);
      }
      return [...uids];
    });

    log.info('Harvesting preferences for active users', { userCount: activeUserIds.length });

    let harvested = 0;
    for (const userId of activeUserIds) {
      try {
        await step.run(`harvest-${userId}`, async () => {
          await harvestUserPreferences(userId);
        });
        harvested += 1;
      } catch (err) {
        log.warn('harvestUserPreferences failed for one user', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't let one user's failure abort the batch.
      }
    }

    return { userCount: activeUserIds.length, harvested };
  }
);
