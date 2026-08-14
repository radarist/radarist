/**
 * @file lib/inngest/functions/sync-technology-to-neo4j.ts
 * @description Inngest job for syncing Technology entities between Firestore and Neo4j
 *
 * This module handles synchronization of technology facts to the Neo4j graph:
 * - Creates Technology nodes with all fact-based properties
 * - Creates relationships: (Technology)-[:DEVELOPED_BY]->(Company)
 * - Creates relationships: (Technology)-[:ENABLES]->(UseCase)
 * - Handles delete cascades to prevent orphaned placements
 *
 * **Execution Flow:**
 * 1. Receive event with technology data
 * 2. Check Neo4j health
 * 3. Create/update/delete Technology node
 * 4. Create/update relationships to Companies and UseCases
 * 5. Handle delete cascades for RadarPlacements
 * 6. Send completion event
 *
 * **Trigger:** Event-driven (`app/technology.sync.requested`)
 * **Timeout:** 1 minute per technology
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Phase 1 Task 1.2.1
 * @author Radarist Team
 * @created 2026-01-10
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { SKIP_REASONS } from '../skip-reasons';
import { extractFailureEventData } from '../utils';
import { maybeBuildEntityCreateVerificationEvent } from '../entity-verification-dispatch';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/sync-technology-to-neo4j');
import { checkHealth, deleteEntityFromGraph, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import { scheduleEntityEmbed } from '@/lib/graph/embedding-sync';
import { invalidateCachesForEntity } from '@/lib/graph/query-cache';
import {
  captureEntityTagConceptIdsFromNeo4j,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
  reconcileEntityTagConcepts,
} from '@/lib/graph/entity-tag-concept-projection';
import type { Technology } from '@/lib/types';
import {
  createEntitySourceFingerprint,
  normalizeEntityGraphSet,
} from '@/lib/entity-source-version';
import {
  clearConvergedEntityGraphSyncAnchor,
  readEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-admin';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface TechnologyData {
  name: string;
  slug: string;
  description?: string;
  category?: string;
  tags?: string[];
  websiteUrl?: string;
  githubUrl?: string;
  documentationUrl?: string;
  linkedCompanies?: string[];
  linkedUseCases?: string[];
  conceptIds?: string[];
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt?: number;
  updatedAt?: number;
}

interface SyncResult {
  technologyId: string;
  operation: 'created' | 'updated' | 'deleted';
  relationshipsCreated?: number;
  placementsDeleted?: number;
  /**
   * P3-B (H7 model): company/use-case/concept link writes that failed this
   * run. Non-zero ⇒ the run must not report success:true — previously these
   * were warn-and-continue masked while the run reported blanket success.
   */
  linkFailures?: number;
  skipped?: 'source-missing';
  sourceFingerprint?: string;
}

const DELETE_SOURCE_WAIT_SECONDS = [1, 2, 4, 8] as const;

async function loadTechnologyFromFirestore(technologyId: string): Promise<Technology | null> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snap = await adminDb.collection('technologies').doc(technologyId).get();
  if (!snap.exists) return null;
  return snap.data() as Technology;
}

function toTechnologyData(technology: Technology): TechnologyData {
  return {
    name: technology.name,
    slug: technology.slug,
    description: technology.description,
    category: technology.category,
    tags: technology.tags,
    websiteUrl: technology.websiteUrl,
    githubUrl: technology.githubUrl,
    documentationUrl: technology.documentationUrl,
    linkedCompanies: technology.linkedCompanies,
    linkedUseCases: technology.linkedUseCases,
    conceptIds: (technology as { conceptIds?: string[] }).conceptIds,
    approvalStatus: technology.approvalStatus,
    createdBy: technology.createdBy,
    createdAt: technology.createdAt,
    updatedAt: technology.updatedAt,
  };
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/**
 * Create or update a Technology node
 * Uses Entity label for compatibility with generic graph queries
 */
const UPSERT_TECHNOLOGY = `
  MERGE (t:Entity:Technology {id: $technologyId})
  ON CREATE SET
    t.name = $name,
    t.slug = $slug,
    t.description = $description,
    t.category = $category,
    t.tags = $tags,
    t.websiteUrl = $websiteUrl,
    t.githubUrl = $githubUrl,
    t.documentationUrl = $documentationUrl,
    t.approvalStatus = $approvalStatus,
    t.createdBy = $createdBy,
    t.createdAt = $createdAt,
    t.updatedAt = $updatedAt,
    t.entityType = 'technology'
  ON MATCH SET
    t.name = $name,
    t.slug = $slug,
    t.description = $description,
    t.category = $category,
    t.tags = $tags,
    t.websiteUrl = $websiteUrl,
    t.githubUrl = $githubUrl,
    t.documentationUrl = $documentationUrl,
    t.approvalStatus = $approvalStatus,
    t.updatedAt = $updatedAt
  RETURN t
`;

const STAMP_TECHNOLOGY_SOURCE_FINGERPRINT = `
  MATCH (t:Entity:Technology {id: $technologyId})
  SET t.sourceFingerprint = $sourceFingerprint
  RETURN t.id AS technologyId
`;

/**
 * Create relationship from Technology to Company (developed by)
 */
const CREATE_DEVELOPED_BY_RELATIONSHIP = `
  MATCH (t:Technology {id: $technologyId})
  MATCH (c:Entity:Company {id: $companyId})
  MERGE (t)-[r:DEVELOPED_BY]->(c)
  ON CREATE SET r.createdAt = $createdAt
  RETURN r
`;

/**
 * Create relationship from Technology to UseCase (enables)
 */
const CREATE_ENABLES_RELATIONSHIP = `
  MATCH (t:Technology {id: $technologyId})
  MATCH (uc:Entity:UseCase {id: $useCaseId})
  MERGE (t)-[r:ENABLES]->(uc)
  ON CREATE SET r.createdAt = $createdAt
  RETURN r
`;

/**
 * Delete only the implicit company links owned by the Technology projection.
 * Explicit Relation/Assertion projections of the same type have independent
 * lifecycles and must survive routine Technology property updates.
 */
const DELETE_COMPANY_RELATIONSHIPS = `
  MATCH (t:Technology {id: $technologyId})-[r:DEVELOPED_BY]->()
  WHERE r.relationId IS NULL AND r.claimId IS NULL
  DELETE r
  RETURN count(r) as deleted
`;

/**
 * Delete only the implicit use-case links owned by the Technology projection.
 * Explicit Relation/Assertion projections of the same type have independent
 * lifecycles and must survive routine Technology property updates.
 */
const DELETE_USECASE_RELATIONSHIPS = `
  MATCH (t:Technology {id: $technologyId})-[r:ENABLES]->()
  WHERE r.relationId IS NULL AND r.claimId IS NULL
  DELETE r
  RETURN count(r) as deleted
`;

/**
 * Find every graph placement owned by this Technology. The property branch
 * also catches a partially projected placement whose PLACES edge is missing.
 */
const GET_RELATED_PLACEMENTS = `
  MATCH (p:RadarPlacement {technologyId: $technologyId})
  RETURN p.id as placementId
  UNION
  MATCH (p:RadarPlacement)-[:PLACES]->(:Technology {id: $technologyId})
  RETURN p.id as placementId
`;

// ============================================================================
// SYNC TECHNOLOGY JOB
// ============================================================================

/**
 * Sync a single Technology to Neo4j
 *
 * **Trigger:** app/technology.sync.requested event
 * **Timeout:** 1 minute
 * **Retries:** 3 attempts
 */
export const syncTechnologyToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-technology-to-neo4j',
    name: 'Sync Technology to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },
    concurrency: {
      key: 'event.data.technologyId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<{ technologyId?: string }>(event.data);
      const technologyId = data.technologyId || 'unknown';
      log.error('Sync technology final failure', new Error(error.message), { technologyId });

      await inngest.send({
        name: 'app/technology.sync.failed',
        data: {
          technologyId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/technology.sync.requested' },

  async ({ event, step }) => {
    const { operation, technologyId } = event.data;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      if (operation === 'delete') {
        let sourceExists = true;
        for (const [index, seconds] of DELETE_SOURCE_WAIT_SECONDS.entries()) {
          sourceExists = await step.run(`check-source-deleted-${index}`, async () => {
            return (await loadTechnologyFromFirestore(technologyId)) !== null;
          });
          if (!sourceExists) break;
          await step.sleep(`wait-for-source-delete-${index}`, `${seconds}s`);
        }
        if (sourceExists) {
          await step.run('require-source-deleted', async () => {
            if ((await loadTechnologyFromFirestore(technologyId)) !== null) {
              throw new Error(`Cannot delete graph technology ${technologyId} while its Firestore source still exists`);
            }
            return true;
          });
        }
      }

      // Step 2: Load the technology from Firestore — ALWAYS (M1 / decision
      // D2). The old inline fast path read `technologyData` from the event,
      // which no producer sent (they sent `payload`) — and consuming an
      // inline patch payload would demote approved technologies, because
      // partial updates lack `approvalStatus`/`conceptIds`. One load path.
      const techData = await step.run('load-technology-data', async () => {
        // Load from Firestore for reconciliation/backfill scenarios. Read via
        // the admin SDK directly instead of going through `@/lib/technology-service`
        // → technology-core.ts → @/lib/firebase (client SDK). Server-side the
        // client SDK has no auth context; its gRPC Listen stream hangs ~5–50s
        // before failing with "Failed to get document because the client is
        // offline". Same bug class as the relation sync fix on 2026-05-12.
        const technology = await loadTechnologyFromFirestore(technologyId);
        if (!technology) {
          // Entity may have been deleted - return null to skip sync gracefully
          log.warn('Technology not found in Firestore - will skip sync', { technologyId });
          return null;
        }
        return toTechnologyData(technology);
      });

      // If technology not found in Firestore and not a delete operation, skip sync
      if (!techData && operation !== 'delete') {
        log.info('Skipped technology - not found in Firestore', { technologyId });
        await step.run('settle-anchor-for-missing-source', async () => {
          try {
            const anchor = await readEntityGraphSyncAnchor('technology', technologyId);
            if (!anchor) return { settled: false, outcome: 'absent' };
            if ((await loadTechnologyFromFirestore(technologyId)) !== null) {
              return { settled: false, outcome: 'source-reappeared' };
            }
            const outcome = await clearConvergedEntityGraphSyncAnchor(
              'technology',
              technologyId,
              anchor.generation
            );
            return { settled: outcome === 'cleared', outcome };
          } catch (error) {
            log.warn('Could not settle Technology graph sync anchor for a missing source', {
              technologyId,
              error: error instanceof Error ? error.message : String(error),
            });
            return { settled: false };
          }
        });
        return {
          success: true,
          skipped: true,
          reason: SKIP_REASONS.TECHNOLOGY_NOT_FOUND,
        };
      }

      // Persist the pre-delete topology independently from the destructive
      // step. If the process dies after DETACH DELETE, the retry still knows
      // exactly which shared Concept counts must be recomputed.
      const deletionConceptIds =
        operation === 'delete'
          ? await step.run('capture-tag-concepts-before-delete', async () => {
              return captureEntityTagConceptIdsFromNeo4j(technologyId);
            })
          : [];

      // Step 3: Perform operation
      const result = await step.run('sync-technology', async (): Promise<SyncResult> => {
        switch (operation) {
          case 'create':
          case 'update': {
            // Re-read at the graph-write boundary. The earlier load step may be
            // memoized across retries and must not resurrect a deleted source.
            const currentTechnology = await loadTechnologyFromFirestore(technologyId);
            if (!currentTechnology) {
              return {
                technologyId,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }
            const tagConceptProjection = await reconcileEntityTagConcepts(technologyId, 'technology');
            if (!tagConceptProjection) {
              return {
                technologyId,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }
            // Tag reconciliation may have persisted conceptIds. Load the
            // complete authoritative document again so both the graph params
            // and source version describe the same committed state.
            const reconciledTechnology = await loadTechnologyFromFirestore(technologyId);
            if (!reconciledTechnology) {
              return {
                technologyId,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }
            const technologyData = toTechnologyData(reconciledTechnology);
            const graphProjection = {
              node: {
                name: technologyData.name,
                slug: technologyData.slug,
                description: technologyData.description ?? null,
                category: technologyData.category ?? null,
                tags: normalizeEntityGraphSet(technologyData.tags),
                websiteUrl: technologyData.websiteUrl ?? null,
                githubUrl: technologyData.githubUrl ?? null,
                documentationUrl: technologyData.documentationUrl ?? null,
                approvalStatus: technologyData.approvalStatus ?? 'pending',
                createdBy: technologyData.createdBy || 'system-auto-sync',
                createdAt:
                  typeof technologyData.createdAt === 'number' && Number.isFinite(technologyData.createdAt)
                    ? technologyData.createdAt
                    : 0,
                updatedAt:
                  typeof technologyData.updatedAt === 'number' && Number.isFinite(technologyData.updatedAt)
                    ? technologyData.updatedAt
                    : 0,
              },
              relationships: {
                linkedCompanies: normalizeEntityGraphSet(technologyData.linkedCompanies),
                linkedUseCases: normalizeEntityGraphSet(technologyData.linkedUseCases),
                conceptIds: normalizeEntityGraphSet(technologyData.conceptIds),
              },
            };
            const sourceFingerprint = await createEntitySourceFingerprint(
              'technology',
              technologyId,
              reconciledTechnology as unknown as Record<string, unknown>
            );
            const now = Date.now();

            const params = {
              technologyId,
              ...graphProjection.node,
              sourceFingerprint,
            };

            // Create/update the technology node
            await runWriteTransaction(UPSERT_TECHNOLOGY, params);

            // GRAPH-054: every Technology writer converges through the same
            // server-owned tag mapper. Concepts are upserted before edges and
            // only implicit HAS_CONCEPT links are reconciled; failures throw
            // so the durable worker retries instead of hiding graph drift.
            const tagGraphReceipt = await projectEntityTagConceptsToNeo4j(technologyId, tagConceptProjection);

            // P5-C: keep the technology's semantic embedding fresh. Fire-and-
            // forget: scheduleEntityEmbed is key-guarded (no-op when keyless)
            // and never rejects; the extra try/catch means even a synchronous
            // scheduling failure can't fail the sync.
            try {
              void scheduleEntityEmbed({
                entityId: technologyId,
                label: 'Technology',
                  name: graphProjection.node.name ?? '',
                  description: graphProjection.node.description ?? undefined,
              });
            } catch (embedError) {
              log.warn('Embedding scheduling failed (non-fatal)', {
                technologyId,
                error: embedError instanceof Error ? embedError.message : String(embedError),
              });
            }

            let relationshipsCreated = tagGraphReceipt.relationshipsCreated;
            let linkFailures = 0;

            // Update company relationships (delete old, create new)
            await runWriteTransaction(DELETE_COMPANY_RELATIONSHIPS, { technologyId });
            if (graphProjection.relationships.linkedCompanies.length) {
              for (const companyId of graphProjection.relationships.linkedCompanies) {
                try {
                  const result = await runWriteTransaction(CREATE_DEVELOPED_BY_RELATIONSHIP, {
                    technologyId,
                    companyId,
                    createdAt: now,
                  });
                  // Cypher MATCH is a silent no-op when the target is absent:
                  // it returns zero rows rather than throwing. A returned row
                  // acknowledges either a newly-created or pre-existing edge.
                  if (result.records.length === 0) {
                    throw new Error(`Company graph target ${companyId} was not found`);
                  }
                  if (result.summary.counters.relationshipsCreated > 0) {
                    relationshipsCreated++;
                  }
                } catch (_err) {
                  // Company might not exist in Neo4j yet — count it (P3-B) and continue
                  linkFailures++;
                  log.warn('Failed to link company', { technologyId, companyId });
                }
              }
            }

            // Update use case relationships (delete old, create new)
            await runWriteTransaction(DELETE_USECASE_RELATIONSHIPS, { technologyId });
            if (graphProjection.relationships.linkedUseCases.length) {
              for (const useCaseId of graphProjection.relationships.linkedUseCases) {
                try {
                  const result = await runWriteTransaction(CREATE_ENABLES_RELATIONSHIP, {
                    technologyId,
                    useCaseId,
                    createdAt: now,
                  });
                  if (result.records.length === 0) {
                    throw new Error(`UseCase graph target ${useCaseId} was not found`);
                  }
                  if (result.summary.counters.relationshipsCreated > 0) {
                    relationshipsCreated++;
                  }
                } catch (_err) {
                  // UseCase might not exist in Neo4j yet — count it (P3-B) and continue
                  linkFailures++;
                  log.warn('Failed to link use case', { technologyId, useCaseId });
                }
              }
            }

            const completeProjection = linkFailures === 0;
            if (completeProjection) {
              await runWriteTransaction(STAMP_TECHNOLOGY_SOURCE_FINGERPRINT, {
                technologyId,
                sourceFingerprint,
              });
            }

            return {
              technologyId,
              operation: operation === 'create' ? 'created' : 'updated',
              relationshipsCreated,
              linkFailures,
              ...(completeProjection ? { sourceFingerprint } : {}),
            };
          }

          case 'delete': {
            if ((await loadTechnologyFromFirestore(technologyId)) !== null) {
              throw new Error(`Cannot delete graph technology ${technologyId} while its Firestore source still exists`);
            }
            // Placement delete events are a best-effort latency optimization.
            // The required Technology event is the durable convergence owner:
            // remove each exact-owned placement (including its Assertion
            // topology) before removing the Technology endpoint.
            const placementsResult = await runReadTransaction<{ placementId: string }>(GET_RELATED_PLACEMENTS, {
              technologyId,
            });
            const relatedPlacements = placementsResult.records.map((r) => r.placementId);

            if (relatedPlacements.length > 0) {
              log.info('Cascade deleting graph placements with technology', {
                technologyId,
                relatedPlacementsCount: relatedPlacements.length,
              });
            }

            for (const placementId of relatedPlacements) {
              await deleteEntityFromGraph(placementId, 'radarPlacement');
            }

            // Delete the endpoint and every Assertion that names it in one
            // transaction. This must run even when the endpoint is already
            // absent so a prior partial delete cannot strand claim topology.
            await deleteEntityFromGraph(technologyId, 'technology');
            await reconcileConceptEntityCounts(deletionConceptIds);

            return {
              technologyId,
              operation: 'deleted',
              placementsDeleted: relatedPlacements.length,
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      await step.run('settle-entity-graph-sync-anchor', async () => {
        try {
          const anchor = await readEntityGraphSyncAnchor('technology', technologyId);
          if (!anchor) return { outcome: 'absent' };
          const current = await loadTechnologyFromFirestore(technologyId);
          if (!current) {
            return {
              outcome: await clearConvergedEntityGraphSyncAnchor(
                'technology',
                technologyId,
                anchor.generation
              ),
              reason: 'entity-deleted',
            };
          }
          if (!result.sourceFingerprint || (result.linkFailures ?? 0) > 0) {
            return { outcome: 'no-complete-projection-written' };
          }
          const currentFingerprint = await createEntitySourceFingerprint(
            'technology',
            technologyId,
            current as unknown as Record<string, unknown>
          );
          if (currentFingerprint !== result.sourceFingerprint) return { outcome: 'source-moved' };
          return {
            outcome: await clearConvergedEntityGraphSyncAnchor(
              'technology',
              technologyId,
              anchor.generation
            ),
          };
        } catch (error) {
          log.warn('Could not settle Technology graph sync recovery anchor', {
            technologyId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { outcome: 'settle-failed' };
        }
      });

      if (result.skipped === 'source-missing') {
        log.info('Skipped technology upsert because source disappeared before the write', {
          technologyId,
        });
        return { success: true, ...result };
      }

      // M6: the technology node changed (upsert or delete) — drop stale
      // neighbor/path/business cache entries for it. A property-only update
      // (no relation change) never flows through relation sync, so without
      // this the caches would serve pre-write results until TTL/reconcile.
      // Fire-and-forget: never fail the sync.
      try {
        invalidateCachesForEntity(technologyId);
      } catch (cacheError) {
        log.warn('Cache invalidation failed (non-fatal)', {
          technologyId,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }

      // GRAPH-048: verification dispatch is a separate durable step. Reject
      // or empty acknowledgement so the function retries; deterministic event
      // ids make already-accepted retries converge at Inngest ingestion. Run
      // this before the terminal completion event so a final dispatch failure
      // cannot produce contradictory completed and failed outcomes.
      const verificationEvent = maybeBuildEntityCreateVerificationEvent({
        entityType: 'technology',
        entityId: result.technologyId,
        operation: result.operation,
      });
      if (verificationEvent) {
        await step.run('dispatch-entity-verification', async () => {
          const accepted = await inngest.send(verificationEvent);
          if (!accepted.ids?.length) {
            throw new Error(`Inngest accepted no entity verification event for ${result.technologyId}`);
          }
          return accepted.ids;
        });
      }

      // Step 4: Send completion only after required post-commit dispatches.
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/technology.sync.completed',
          data: {
            technologyId: result.technologyId,
            operation: result.operation,
            syncedAt: Date.now(),
          },
        });
      });

      return {
        // P3-B (H7 model): a run that failed to write link edges must not
        // report blanket success — downstream graph traversals silently miss them.
        success: (result.linkFailures ?? 0) === 0,
        ...result,
      };
    } catch (error) {
      log.error('Sync technology failed', error instanceof Error ? error : undefined, { technologyId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple Technologies to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/technology.batch-sync.requested event
 * **Timeout:** 10 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncTechnologiesJob = inngest.createFunction(
  {
    id: 'batch-sync-technologies-to-neo4j',
    name: 'Batch Sync Technologies to Neo4j',
    retries: 2,

    onFailure: async ({ error }) => {
      log.error('Batch sync technologies final failure', new Error(error.message));

      await inngest.send({
        name: 'app/technology.batch-sync.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/technology.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-technologies-to-neo4j');
    const { technologies, options } = event.data;

    try {
      // A second direct writer cannot share the single-item function's per-id
      // concurrency boundary. Batch work therefore delegates identifier-only
      // events to that canonical writer instead of racing its prune/link/stamp
      // sequence. Deterministic event ids make a retried batch converge.
      const batchSize = options?.batchSize || 50;
      const uniqueTechnologies = [...new Map(technologies.map((technology) => [technology.id, technology])).values()];
      const results = {
        created: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < uniqueTechnologies.length; i += batchSize) {
        const batch = uniqueTechnologies.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          const accepted = await inngest.send(
            batch.map((technology) => ({
              id: `technology-batch:${event.id}:${technology.id}`,
              name: 'app/technology.sync.requested' as const,
              data: { technologyId: technology.id, operation: 'update' as const },
            }))
          );
          if (accepted.ids?.length !== batch.length) {
            throw new Error(
              `Inngest acknowledged ${accepted.ids?.length ?? 0}/${batch.length} Technology sync events`
            );
          }
          results.created += batch.length;
          return { batchNum, processed: batch.length };
        });
      }

      // Step 3: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/technology.batch-sync.completed',
          data: {
            totalTechnologies: uniqueTechnologies.length,
            created: results.created,
            failed: results.failed,
            syncedAt: Date.now(),
          },
        });
      });

      return {
        success: results.failed === 0,
        ...results,
      };
    } catch (error) {
      log.error('Batch sync technologies failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// HELPER FUNCTION
// ============================================================================

/**
 * Trigger a technology sync from application code.
 *
 * M1 / decision D2: identifier-only event — the handler always loads the
 * full doc from Firestore admin, so no inline data field is accepted.
 */
export async function triggerTechnologySync(
  technologyId: string,
  operation: 'create' | 'update' | 'delete'
): Promise<void> {
  await inngest.send({
    name: 'app/technology.sync.requested',
    data: {
      technologyId,
      operation,
    },
  });
}
