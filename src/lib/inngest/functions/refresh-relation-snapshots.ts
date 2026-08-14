/**
 * @file lib/inngest/functions/refresh-relation-snapshots.ts
 * @description Background job to refresh stale relation snapshots
 *
 * This function runs daily and updates entity snapshots in relations
 * that are older than 7 days. This ensures relation data stays fresh
 * without requiring N+1 queries at read time.
 *
 * **Execution Flow:**
 * 1. Find all relations with snapshots > 7 days old
 * 2. For each stale relation:
 *    - Fetch fresh entity data
 *    - Update snapshots
 *    - Mark with new timestamp
 * 3. Report statistics
 *
 * **Retry Strategy:**
 * - Max retries: 3
 * - Backoff: Exponential (1min, 5min, 15min)
 * - Timeout: 10 minutes
 *
 * **Monitoring:**
 * - Check Inngest dashboard for execution logs
 * - Track refresh counts and failures
 *
 * @see https://www.inngest.com/docs/functions/scheduled
 * @author Radarist Team
 * @created 2025-11-27
 *
 * @deprecated-pending D6 (graph-foundation master plan, 2026-07-02): this is
 * the companion snapshot-refresh writer under the same retire review as
 * refresh-placement-snapshots (`technologySnapshot`) — the denormalized
 * snapshot payloads it refreshes are rendered nowhere beyond the name/type
 * captured at write time. Do NOT build new readers against the refreshed
 * fields. Removal is a follow-up once P5 confirms no reader appears — data
 * and handlers are intentionally kept intact until then.
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { adminGetStaleRelations, adminUpdateRelation } from '@/lib/relations-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/refresh-relation-snapshots');
import { adminGetCompanies } from '@/lib/companies-admin';
import { adminGetUseCases } from '@/lib/use-cases-admin';
import { adminGetPrototypes } from '@/lib/prototypes-admin';
import { adminGetStrategies } from '@/lib/strategies-admin';
import { adminGetSignals } from '@/lib/signals-admin';
import { db } from '@/lib/firebase-admin';
import type { EntitySnapshot, EntityType, RadarEntry } from '@/lib/types';

/**
 * Fetch fresh entity data by type and ID
 */
async function fetchEntityData(entityType: EntityType, entityId: string): Promise<EntitySnapshot | null> {
  try {
    switch (entityType) {
      case 'company': {
        const companies = await adminGetCompanies();
        const company = companies.find((c) => c.id === entityId);
        if (!company) return null;

        return {
          type: 'company',
          id: company.id,
          name: company.name,
          description: company.description || '',
          tags: company.tags || [],
          metadata: {
            industry: company.industry,
            location: company.location,
          },
          snapshotAt: Date.now(),
        };
      }

      case 'technology': {
        // M10: snapshots hold plain 'tech-…' Firestore doc ids since the
        // Technology/RadarPlacement decoupling. Parsing every id as the
        // legacy 'radarId:entryId' compound format skipped EVERY technology
        // relation nightly (forever re-qualifying as stale). The legacy
        // radar-entry parse applies only when a ':' is actually present.
        if (entityId.includes(':')) {
          const [radarId, entryIdStr] = entityId.split(':');
          const entryId = parseInt(entryIdStr, 10);

          if (!radarId || isNaN(entryId)) {
            log.warn('Invalid legacy technology ID format', { entityId });
            return null;
          }

          const entriesSnapshot = await db.collection('radars').doc(radarId).collection('entries').get();

          const entry = entriesSnapshot.docs.map((doc) => doc.data() as RadarEntry).find((e) => e.id === entryId);

          if (entry) {
            return {
              type: 'technology',
              id: entityId, // Keep the compound ID
              name: entry.name,
              description: entry.description || '',
              status: entry.ring, // Adopt, Trial, Assess, Hold
              tags: entry.tags || [],
              metadata: {
                // Stable id reference + best-effort denormalized name for display.
                quadrantId: entry.quadrantId,
                quadrantName: entry.quadrantName,
                moved: entry.moved,
              },
              snapshotAt: Date.now(),
            };
          }
          return null;
        }

        // Canonical path: decoupled Technology doc keyed by its own id.
        const techSnap = await db.collection('technologies').doc(entityId).get();
        if (!techSnap.exists) return null;
        const tech = techSnap.data() as {
          name?: string;
          description?: string;
          approvalStatus?: string;
          tags?: string[];
          category?: string;
        };

        return {
          type: 'technology',
          id: entityId,
          name: tech.name || 'Unknown Technology',
          description: tech.description || '',
          status: tech.approvalStatus || 'approved',
          tags: tech.tags || [],
          metadata: {
            ...(tech.category ? { category: tech.category } : {}),
          },
          snapshotAt: Date.now(),
        };
      }

      case 'useCase': {
        const useCases = await adminGetUseCases();
        const useCase = useCases.find((uc) => uc.id === entityId);
        if (!useCase) return null;

        return {
          type: 'useCase',
          id: useCase.id,
          name: useCase.title,
          description: useCase.description || '',
          tags: useCase.tags || [],
          status: useCase.status,
          metadata: {
            category: useCase.category,
            problem: useCase.problem,
          },
          snapshotAt: Date.now(),
        };
      }

      case 'prototype': {
        const prototypes = await adminGetPrototypes();
        const prototype = prototypes.find((p) => p.id === entityId);
        if (!prototype) return null;

        return {
          type: 'prototype',
          id: prototype.id,
          name: prototype.name,
          description: prototype.description || '',
          status: prototype.status,
          tags: prototype.linkedTechnologies || [], // Use linkedTechnologies as tags
          metadata: {
            estimatedValue: prototype.impact?.estimatedValue,
            actualValue: prototype.impact?.actualValue,
            targetBusinessUnit: prototype.targetBusinessUnit,
          },
          snapshotAt: Date.now(),
        };
      }

      case 'strategy': {
        const strategies = await adminGetStrategies();
        const strategy = strategies.find((s) => s.id === entityId);
        if (!strategy) return null;

        // Extract tags from directives
        const tags = strategy.mainDirectives?.map((d) => d.category) || [];

        return {
          type: 'strategy',
          id: strategy.id,
          name: strategy.name,
          description: strategy.description || '',
          tags: [...new Set(tags)], // Unique categories
          metadata: {
            directiveCount: strategy.mainDirectives?.length || 0,
          },
          snapshotAt: Date.now(),
        };
      }

      case 'signal': {
        const signals = await adminGetSignals();
        const signal = signals.find((s) => s.id === entityId);
        if (!signal) return null;

        return {
          type: 'signal',
          id: signal.id,
          name: signal.title,
          description: signal.aiSummary || signal.description || '',
          status: signal.status,
          tags: signal.alignedStrategies || [],
          metadata: {
            source: signal.source,
            relevanceScore: signal.relevanceScore,
            signalType: signal.type,
          },
          snapshotAt: Date.now(),
        };
      }

      default:
        log.warn('Unknown entity type', { entityType });
        return null;
    }
  } catch (error) {
    log.error('Error fetching entity data', error instanceof Error ? error : undefined, { entityType, entityId });
    return null;
  }
}

/**
 * Daily snapshot refresh function
 *
 * **Trigger:** Runs daily at 3 AM UTC (cron schedule)
 * **Timeout:** 10 minutes
 * **Retries:** 3 attempts with exponential backoff
 */
export const refreshRelationSnapshots = inngest.createFunction(
  {
    id: 'refresh-relation-snapshots',
    name: 'Refresh Relation Snapshots',

    /**
     * Retry configuration
     */
    retries: 3,

    /**
     * Rate limit: Only allow one execution at a time
     */
    concurrency: {
      limit: 1,
    },

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error }) => {
      log.error('Final failure after all retries', new Error(error.message));

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/relations.refresh.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
          severity: 'low', // Not critical - snapshots can be stale temporarily
        },
      });
    },
  },

  /**
   * Cron trigger: Daily at 3 AM UTC — cron-only, there is no event trigger.
   * (An earlier comment here claimed a manual `app/schedule.daily.refresh-snapshots`
   * event existed; it never did.) To run manually, invoke the
   * `refresh-relation-snapshots` function from the Inngest dev UI.
   */
  { cron: '0 3 * * *' },

  /**
   * Main function handler
   */
  async ({ event: _event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('refresh-relation-snapshots');
    const startTime = Date.now();

    try {
      /**
       * Step 1: Get stale relations (snapshots > 7 days old)
       */
      const staleRelations = await step.run('fetch-stale-relations', async () => {
        log.info('Fetching stale relations');
        const relations = await adminGetStaleRelations(7); // 7 days
        log.info('Found stale relations', { count: relations.length });
        return relations;
      });

      if (staleRelations.length === 0) {
        log.info('No stale relations found');
        return {
          success: true,
          refreshed: 0,
          failed: 0,
          skipped: 0,
          duration: Date.now() - startTime,
        };
      }

      /**
       * Step 2: Refresh each stale relation
       */
      const results = {
        refreshed: 0,
        failed: 0,
        skipped: 0,
      };

      for (const relation of staleRelations) {
        await step.run(`refresh-relation-${relation.id}`, async () => {
          try {
            // Fetch fresh snapshots
            const [freshSource, freshTarget] = await Promise.all([
              fetchEntityData(relation.sourceSnapshot.type, relation.sourceSnapshot.id),
              fetchEntityData(relation.targetSnapshot.type, relation.targetSnapshot.id),
            ]);

            // If either entity no longer exists, skip (don't delete relation)
            if (!freshSource || !freshTarget) {
              log.warn('Entity not found for relation', {
                relationId: relation.id,
                sourceFound: !!freshSource,
                targetFound: !!freshTarget,
              });
              results.skipped++;
              return;
            }

            // Update relation with fresh snapshots
            await adminUpdateRelation(relation.id, {
              sourceSnapshot: freshSource,
              targetSnapshot: freshTarget,
            });

            results.refreshed++;
            log.info('Refreshed relation', { relationId: relation.id });
          } catch (error) {
            log.error('Failed to refresh relation', error instanceof Error ? error : undefined, {
              relationId: relation.id,
            });
            results.failed++;
          }
        });
      }

      const duration = Date.now() - startTime;

      log.info('Refresh snapshots completed', { ...results, durationMs: duration });

      return {
        success: true,
        ...results,
        duration,
      };
    } catch (error) {
      log.error('Refresh snapshots job failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
