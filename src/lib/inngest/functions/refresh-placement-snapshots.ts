/**
 * @file lib/inngest/functions/refresh-placement-snapshots.ts
 * @description Background job to refresh technology snapshots in RadarPlacements
 *
 * This function is triggered when a technology is updated and refreshes the
 * denormalized `technologySnapshot` field on all RadarPlacements for that technology.
 * This ensures radar visualizations show current technology data without N+1 queries.
 *
 * **Execution Flow:**
 * 1. Receive technology.updated event with technology ID
 * 2. Fetch all RadarPlacements for that technology
 * 3. Build fresh TechnologySnapshot from updated technology data
 * 4. Batch update all placements with new snapshot
 *
 * **Retry Strategy:**
 * - Max retries: 3
 * - Backoff: Exponential (1min, 5min, 15min)
 *
 * **Monitoring:**
 * - Check Inngest dashboard for execution logs
 * - Track update counts and failures
 *
 * @see https://www.inngest.com/docs/functions
 * @author Radarist Team
 * @created 2026-01-10
 *
 * @deprecated-pending D6 (graph-foundation master plan, 2026-07-02): the
 * denormalized `technologySnapshot` field this job maintains is rendered
 * nowhere in the UI and is slated for retirement. Do NOT build new readers
 * against it. The job (and the field) will be removed in a follow-up once
 * P5 confirms no reader appears — data and handlers are intentionally kept
 * intact until then.
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { extractFailureEventData } from '../utils';
import { adminGetTechnologyById } from '@/lib/technology-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/refresh-placement-snapshots');
import { adminGetPlacementsForTechnology, adminUpdateRadarPlacement } from '@/lib/radar-placement-admin';
import type { TechnologySnapshot } from '@/lib/types';

/**
 * Build a fresh TechnologySnapshot from technology data
 * Filters out undefined values to avoid Firebase errors
 */
function buildTechnologySnapshot(
  technology: NonNullable<Awaited<ReturnType<typeof adminGetTechnologyById>>>
): TechnologySnapshot {
  const snapshot: TechnologySnapshot = {
    name: technology.name,
    slug: technology.slug,
    snapshotUpdatedAt: Date.now(),
  };

  // Only include category if defined (optional field)
  if (technology.category) {
    snapshot.category = technology.category;
  }

  return snapshot;
}

/**
 * Refresh placement snapshots when technology is updated
 *
 * **Trigger:** `app/technology.updated` event
 * **Timeout:** 5 minutes
 * **Retries:** 3 attempts with exponential backoff
 */
export const refreshPlacementSnapshots = inngest.createFunction(
  {
    id: 'refresh-placement-snapshots',
    name: 'Refresh Placement Snapshots',

    /**
     * Retry configuration
     */
    retries: 3,

    /**
     * Rate limit: Allow up to 5 concurrent executions (free plan limit)
     */
    concurrency: {
      limit: 5,
    },

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const technologyId = extractFailureEventData<{ technologyId?: string }>(event.data).technologyId || 'unknown';
      log.error('Final failure after all retries', new Error(error.message), { technologyId });

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/placement.snapshot-refresh.failed',
        data: {
          technologyId,
          error: error.message,
          failedAt: Date.now(),
          severity: 'low', // Not critical - snapshots can be stale temporarily
        },
      });
    },
  },

  /**
   * Event trigger: When a technology is updated
   */
  { event: 'app/technology.updated' },

  /**
   * Main function handler
   */
  async ({ event, step }) => {
    const { technologyId } = event.data;
    const startTime = Date.now();

    log.info('Starting for technology', { technologyId });

    try {
      /**
       * Step 1: Fetch the updated technology
       */
      const technology = await step.run('fetch-technology', async () => {
        const tech = await adminGetTechnologyById(technologyId);
        if (!tech) {
          throw new Error(`Technology ${technologyId} not found`);
        }
        log.info('Found technology', { name: tech.name });
        return tech;
      });

      /**
       * Step 2: Get all placements for this technology
       */
      const placements = await step.run('fetch-placements', async () => {
        const placementList = await adminGetPlacementsForTechnology(technologyId);
        log.info('Found placements', { count: placementList.length });
        return placementList;
      });

      if (placements.length === 0) {
        log.info('No placements to update');
        return {
          success: true,
          technologyId,
          updated: 0,
          failed: 0,
          duration: Date.now() - startTime,
        };
      }

      /**
       * Step 3: Build fresh snapshot
       */
      const freshSnapshot = buildTechnologySnapshot(technology);

      /**
       * Step 4: Update all placements with fresh snapshot
       */
      const results = {
        updated: 0,
        failed: 0,
      };

      for (const placement of placements) {
        await step.run(`update-placement-${placement.id}`, async () => {
          try {
            await adminUpdateRadarPlacement(placement.id, {
              technologySnapshot: freshSnapshot,
            });
            results.updated++;
            log.info('Updated placement', { placementId: placement.id });
          } catch (error) {
            log.error('Failed to update placement', error instanceof Error ? error : undefined, {
              placementId: placement.id,
            });
            results.failed++;
          }
        });
      }

      const duration = Date.now() - startTime;

      log.info('Refresh placement snapshots completed', { technologyId, ...results, durationMs: duration });

      return {
        success: true,
        technologyId,
        ...results,
        duration,
      };
    } catch (error) {
      log.error('Refresh placement snapshots job failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

/**
 * Daily batch refresh of stale placement snapshots
 *
 * **Trigger:** Daily at 4 AM UTC (after relation snapshot refresh)
 * **Timeout:** 15 minutes
 * **Retries:** 3 attempts with exponential backoff
 *
 * Refreshes any placement snapshots older than 7 days.
 */
export const batchRefreshPlacementSnapshots = inngest.createFunction(
  {
    id: 'batch-refresh-placement-snapshots',
    name: 'Batch Refresh Placement Snapshots',

    retries: 3,

    concurrency: {
      limit: 1,
    },

    onFailure: async ({ error }) => {
      log.error('Batch refresh placement snapshots final failure', new Error(error.message));

      await inngest.send({
        name: 'app/placement.batch-snapshot-refresh.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
          severity: 'low',
        },
      });
    },
  },

  /**
   * Cron trigger: Daily at 4 AM UTC (after relation snapshots at 3 AM)
   */
  { cron: '0 4 * * *' },

  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-refresh-placement-snapshots');
    const startTime = Date.now();
    const STALE_THRESHOLD_DAYS = 7;
    const staleThreshold = Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    log.info('Starting daily batch refresh');

    try {
      /**
       * Step 1: Get all technologies
       */
      const { adminGetTechnologies } = await import('@/lib/technology-admin');
      const technologies = await step.run('fetch-technologies', async () => {
        const techs = await adminGetTechnologies();
        log.info('Found technologies for batch refresh', { count: techs.length });
        return techs;
      });

      /**
       * Step 2: For each technology, check and update stale placements
       */
      const results = {
        technologiesProcessed: 0,
        placementsUpdated: 0,
        placementsFailed: 0,
        placementsSkipped: 0,
      };

      for (const technology of technologies) {
        await step.run(`process-technology-${technology.id}`, async () => {
          const placements = await adminGetPlacementsForTechnology(technology.id);
          results.technologiesProcessed++;

          for (const placement of placements) {
            const snapshotAge = placement.technologySnapshot?.snapshotUpdatedAt || 0;

            if (snapshotAge < staleThreshold) {
              // Snapshot is stale, update it
              try {
                const freshSnapshot = buildTechnologySnapshot(technology);
                await adminUpdateRadarPlacement(placement.id, {
                  technologySnapshot: freshSnapshot,
                });
                results.placementsUpdated++;
              } catch (error) {
                log.error('Batch refresh failed to update placement', error instanceof Error ? error : undefined, {
                  placementId: placement.id,
                });
                results.placementsFailed++;
              }
            } else {
              results.placementsSkipped++;
            }
          }
        });
      }

      const duration = Date.now() - startTime;

      log.info('Batch refresh placement snapshots completed', { ...results, durationMs: duration });

      return {
        success: true,
        ...results,
        duration,
      };
    } catch (error) {
      log.error('Batch refresh placement snapshots job failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
