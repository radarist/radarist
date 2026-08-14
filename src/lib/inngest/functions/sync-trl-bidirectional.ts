/**
 * @file lib/inngest/functions/sync-trl-bidirectional.ts
 * @description Scheduled job to ensure TRL and TimeToImpact are synced
 * between Technologies and their RadarPlacements.
 *
 * This function acts as a safety net to catch any drift that may occur
 * if real-time sync is missed (e.g., due to network issues, race conditions).
 *
 * **Sync Strategy:**
 * - Technology is the source of truth for TRL/TimeToImpact
 * - If a Technology has values, sync TO all its RadarPlacements
 * - If a Technology is missing values but placements have them, sync FROM placement
 *
 * **Features:**
 * - Hourly sync check
 * - Only syncs records that are out of sync (efficient)
 * - Logs all sync operations
 * - Reports metrics for monitoring
 *
 * **Trigger:** Cron (hourly at minute 30)
 * **Timeout:** 5 minutes
 * **Retries:** 2 attempts
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import type { Technology, RadarPlacement, TimeToImpact } from '@/lib/types';

const log = createLogger('inngest/sync-trl-bidirectional');

interface SyncResult {
  techToRadar: {
    synced: number;
    failed: string[];
  };
  radarToTech: {
    synced: number;
    failed: string[];
  };
}

/**
 * Find and sync TRL/TimeToImpact mismatches
 */
async function syncTRLMismatches(): Promise<SyncResult> {
  const result: SyncResult = {
    techToRadar: { synced: 0, failed: [] },
    radarToTech: { synced: 0, failed: [] },
  };

  // Fetch all technologies (admin SDK)
  const techSnapshot = await db.collection('technologies').get();
  const technologies = new Map<string, Technology>();
  techSnapshot.docs.forEach((d) => {
    technologies.set(d.id, { id: d.id, ...d.data() } as Technology);
  });

  // Fetch all radar placements
  const placementsSnapshot = await db.collection('radarPlacements').get();
  const placements = placementsSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as RadarPlacement);

  // Group placements by technology
  const placementsByTech = new Map<string, RadarPlacement[]>();
  for (const placement of placements) {
    const techPlacements = placementsByTech.get(placement.technologyId) || [];
    techPlacements.push(placement);
    placementsByTech.set(placement.technologyId, techPlacements);
  }

  // Use batch writes for efficiency (admin SDK uses db.batch())
  let batch = db.batch();
  let batchCount = 0;
  const BATCH_LIMIT = 500;

  const commitBatchIfNeeded = async (force = false) => {
    if (batchCount >= BATCH_LIMIT || (force && batchCount > 0)) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  };

  // Check each technology with placements
  for (const [techId, techPlacements] of placementsByTech) {
    const tech = technologies.get(techId);
    if (!tech) {
      log.warn('Technology not found but has placements', { techId, placementCount: techPlacements.length });
      continue;
    }

    // Strategy 1: Tech → Radar (Tech has values, sync to placements)
    if (tech.trl !== undefined || tech.timeToImpact !== undefined) {
      for (const placement of techPlacements) {
        const needsTRLSync = tech.trl !== undefined && placement.trlScore !== tech.trl;
        // Technology.timeToImpact excludes 'unknown', RadarPlacement.timeToImpact includes it
        const needsTTISync = tech.timeToImpact !== undefined && placement.timeToImpact !== tech.timeToImpact;

        if (needsTRLSync || needsTTISync) {
          try {
            const updates: Partial<RadarPlacement> = {
              updatedAt: Date.now(),
            };
            if (needsTRLSync) updates.trlScore = tech.trl;
            if (needsTTISync) updates.timeToImpact = tech.timeToImpact;

            batch.update(db.collection('radarPlacements').doc(placement.id), updates);
            batchCount++;
            result.techToRadar.synced++;

            log.info('Tech to Radar sync', {
              techName: tech.name,
              placementId: placement.id,
              oldTrl: placement.trlScore,
              newTrl: tech.trl,
              oldTti: placement.timeToImpact,
              newTti: tech.timeToImpact,
            });

            await commitBatchIfNeeded();
          } catch (error) {
            log.error('Failed to sync placement', error instanceof Error ? error : undefined, {
              placementId: placement.id,
            });
            result.techToRadar.failed.push(placement.id);
          }
        }
      }
    }

    // Strategy 2: Radar → Tech (Tech missing values, get from placement)
    if (tech.trl === undefined || tech.timeToImpact === undefined) {
      // Find the "best" placement (most recent, with values)
      const placementsWithValues = techPlacements
        .filter((p) => p.trlScore !== undefined || p.timeToImpact !== undefined)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      if (placementsWithValues.length > 0) {
        const bestPlacement = placementsWithValues[0];
        const updates: Record<string, number | TimeToImpact | number> = {
          updatedAt: Date.now(),
        };

        if (tech.trl === undefined && bestPlacement.trlScore !== undefined) {
          updates.trl = bestPlacement.trlScore;
        }
        if (
          tech.timeToImpact === undefined &&
          bestPlacement.timeToImpact !== undefined &&
          bestPlacement.timeToImpact !== 'unknown'
        ) {
          updates.timeToImpact = bestPlacement.timeToImpact;
        }

        if (Object.keys(updates).length > 1) {
          // More than just updatedAt
          try {
            batch.update(db.collection('technologies').doc(techId), updates);
            batchCount++;
            result.radarToTech.synced++;

            log.info('Radar to Tech sync', {
              placementId: bestPlacement.id,
              techName: tech.name,
              trl: bestPlacement.trlScore,
              tti: bestPlacement.timeToImpact,
            });

            await commitBatchIfNeeded();
          } catch (error) {
            log.error('Failed to sync technology', error instanceof Error ? error : undefined, { techId });
            result.radarToTech.failed.push(techId);
          }
        }
      }
    }
  }

  // Commit any remaining batch writes
  await commitBatchIfNeeded(true);

  return result;
}

/**
 * Hourly TRL/TimeToImpact bidirectional sync job
 *
 * **Trigger:** Cron (hourly at minute 30)
 * **Timeout:** 5 minutes
 */
export const syncTRLBidirectionalJob = inngest.createFunction(
  {
    id: 'sync-trl-bidirectional',
    name: 'Sync TRL/TimeToImpact Bidirectional',
    retries: 2,
    onFailure: async ({ error }) => {
      log.error('TRL sync job failure', new Error(error.message));
      await inngest.send({
        name: 'app/trl-sync.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { cron: '30 * * * *' },

  /**
   * Main function handler
   */
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('sync-trl-bidirectional');
    /**
     * Step 1: Count entities before sync
     */
    const preStats = await step.run('get-pre-stats', async () => {
      log.info('Starting hourly sync check');

      const techSnapshot = await db.collection('technologies').get();
      const placementsSnapshot = await db.collection('radarPlacements').get();

      const stats = {
        technologies: techSnapshot.size,
        placements: placementsSnapshot.size,
      };

      log.info('Found entities for sync', { technologies: stats.technologies, placements: stats.placements });
      return stats;
    });

    /**
     * Step 2: Run sync
     */
    const syncResult = await step.run('sync-mismatches', async () => {
      log.info('Checking for mismatches');

      const result = await syncTRLMismatches();

      const totalSynced = result.techToRadar.synced + result.radarToTech.synced;
      const totalFailed = result.techToRadar.failed.length + result.radarToTech.failed.length;

      if (totalSynced === 0 && totalFailed === 0) {
        log.info('All TRL/TimeToImpact values in sync');
      } else {
        log.info('Sync complete');
        log.info('Tech to Radar summary', {
          synced: result.techToRadar.synced,
          failed: result.techToRadar.failed.length,
        });
        log.info('Radar to Tech summary', {
          synced: result.radarToTech.synced,
          failed: result.radarToTech.failed.length,
        });
      }

      return result;
    });

    /**
     * Step 3: Send completion event (only if there were syncs or failures)
     */
    const totalSynced = syncResult.techToRadar.synced + syncResult.radarToTech.synced;
    const totalFailed = syncResult.techToRadar.failed.length + syncResult.radarToTech.failed.length;

    if (totalSynced > 0 || totalFailed > 0) {
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/trl-sync.completed',
          data: {
            technologies: preStats.technologies,
            placements: preStats.placements,
            techToRadarSynced: syncResult.techToRadar.synced,
            techToRadarFailed: syncResult.techToRadar.failed.length,
            radarToTechSynced: syncResult.radarToTech.synced,
            radarToTechFailed: syncResult.radarToTech.failed.length,
            completedAt: Date.now(),
          },
        });

        log.info('Job completed with changes');
      });
    }

    return {
      success: true,
      technologies: preStats.technologies,
      placements: preStats.placements,
      techToRadar: syncResult.techToRadar,
      radarToTech: syncResult.radarToTech,
      inSync: totalSynced === 0 && totalFailed === 0,
    };
  }
);

/**
 * Manual trigger for TRL sync (for debugging or immediate sync)
 *
 * **Trigger:** Event 'app/trl-sync.requested'
 */
export const syncTRLManualJob = inngest.createFunction(
  {
    id: 'sync-trl-manual',
    name: 'Sync TRL/TimeToImpact (Manual)',
    retries: 1,
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for debugging or immediate sync.
  { event: 'app/trl-sync.requested' },

  async ({ event, step }) => {
    log.info('Manual sync requested', { requestedBy: event.data?.requestedBy || 'unknown' });

    const result = await step.run('sync', async () => {
      return await syncTRLMismatches();
    });

    return {
      success: true,
      techToRadar: result.techToRadar,
      radarToTech: result.radarToTech,
    };
  }
);
