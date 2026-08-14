/**
 * @file inngest/functions/daily-digest.ts
 * @description Daily digest generator — cron job that aggregates 24h of agent
 * events into per-user digest summaries for the notification bell.
 *
 * Schedule: 6 AM daily
 *
 * @phase Impulse v1.0 — Phase 4: Intelligence Layer
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest:daily-digest');

export const dailyDigestJob = inngest.createFunction(
  {
    id: 'daily-digest-generator',
    retries: 1,
  },
  { cron: '0 6 * * *' },
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('daily-digest-generator');
    // Step 1: Get active user IDs
    const userIds = await step.run('get-active-users', async () => {
      try {
        const { getActiveUserIds } = await import('@/lib/graph/session-memory');
        return await getActiveUserIds();
      } catch {
        log.warn('Failed to get active users, falling back to empty');
        return [];
      }
    });

    if (userIds.length === 0) {
      log.info('No active users, skipping digest generation');
      return { digests: 0 };
    }

    // Step 2: Query last 24h of agent events
    const eventCounts = await step.run('count-events', async () => {
      try {
        // Admin SDK only — client SDK in Inngest runtime throws
        // `code: 'unavailable'` because there's no persistent connection.
        // Per firebase-admin migration plan v2.4 T1.1.
        const { db } = await import('@/lib/firebase-admin');
        const { Timestamp } = await import('firebase-admin/firestore');

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const snap = await db.collection('agent-events').where('timestamp', '>=', Timestamp.fromDate(since)).get();

        let signalsDiscovered = 0;
        let connectionsFound = 0;
        let entitiesEnriched = 0;
        let insightsGenerated = 0;

        for (const doc of snap.docs) {
          const data = doc.data();
          switch (data.type) {
            case 'agent.discovery':
              signalsDiscovered++;
              break;
            case 'graph.updated':
              connectionsFound++;
              break;
            case 'agent.completed':
              entitiesEnriched++;
              break;
            case 'insight.created':
              insightsGenerated++;
              break;
          }
        }

        return {
          signalsDiscovered,
          connectionsFound,
          entitiesEnriched,
          insightsGenerated,
        };
      } catch (error) {
        log.warn('Failed to count events', { error: String(error) });
        return {
          signalsDiscovered: 0,
          connectionsFound: 0,
          entitiesEnriched: 0,
          insightsGenerated: 0,
        };
      }
    });

    // Step 3: Create digest for each active user
    const digestCount = await step.run('create-digests', async () => {
      const { createDigest, isZeroActivityDigest } = await import('@/lib/digests');

      // eventCounts is one shared 24h window for the whole run (not
      // per-user), so a zero window means every user's digest would be
      // empty — skip the batch entirely instead of writing N identical
      // "0 signals, 0 connections, 0 insights" documents that just pile up
      // unread in Firestore.
      if (isZeroActivityDigest(eventCounts)) {
        log.info('No activity in the last 24h — skipping digest creation', { eventCounts });
        return 0;
      }

      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      let count = 0;

      for (const userId of userIds) {
        try {
          await createDigest({
            userId,
            date,
            summary: {
              ...eventCounts,
              tokenUsage: 0,
              tokenBudget: 100000,
            },
            highlights: [],
          });
          count++;
        } catch (error) {
          log.warn('Failed to create digest for user', {
            userId,
            error: String(error),
          });
        }
      }

      return count;
    });

    log.info('Daily digest generation complete', {
      users: userIds.length,
      digests: digestCount,
    });
    return { digests: digestCount };
  }
);
