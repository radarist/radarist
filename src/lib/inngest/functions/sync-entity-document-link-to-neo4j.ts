/**
 * @file lib/inngest/functions/sync-entity-document-link-to-neo4j.ts
 * @description Inngest job for syncing EntityDocumentLink entities to Neo4j
 *
 * This module handles synchronization of entity-document links to the Neo4j graph:
 * - Creates relationships between Entity nodes and Document nodes
 * - Supports all entity types (Technology, Company, Signal, etc.)
 * - Uses the appropriate relationship type (DOCUMENTED_BY, EVIDENCE_FOR, etc.)
 * - Updates Firestore sync status after successful/failed sync
 *
 * **Relationship Mapping:**
 * - documentation → DOCUMENTED_BY
 * - case_study → HAS_CASE_STUDY
 * - technical_spec → HAS_TECHNICAL_SPEC
 * - research_paper → HAS_RESEARCH
 * - competitive_intel → HAS_COMPETITIVE_INTEL
 * - evidence → HAS_EVIDENCE
 * - pitch_deck → HAS_PITCH_DECK
 * - contract → HAS_CONTRACT
 * - other → LINKED_TO
 *
 * **Trigger:** Event-driven (`app/entity-document-link.sync.requested`)
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { extractFailureEventData } from '../utils';
import { checkHealth, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import {
  adminGetEntityDocumentLinkById,
  adminMarkLinkSynced,
  adminMarkLinkSyncFailed,
} from '@/lib/entity-document-link-admin';
import { clearConvergedEntityGraphSyncAnchor, readEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';
import { ENTITY_DOCUMENT_LINK_ANCHOR_TYPE } from '@/lib/entity-document-link-handoff';
import { buildEntityDocumentLinkProjectionFingerprint } from '@/lib/entity-document-link-sync-server';
import { SKIP_REASONS } from '@/lib/inngest/skip-reasons';
import { createLogger } from '@/lib/logger';
import { invalidateCachesForEntity } from '@/lib/graph/query-cache';
import {
  DOCUMENT_LINK_ENTITY_LABELS,
  DOCUMENT_LINK_RELATIONSHIP_TYPES,
} from '@/lib/graph/entity-document-link-graph-contract';

const log = createLogger('inngest/sync-entity-document-link');
import type { TransformationEntityType, DocumentRelationshipType, EntityType } from '@/lib/types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface LinkSyncEventData {
  operation: 'create' | 'update' | 'delete';
  linkId: string;
  entityId?: string;
  entityType?: TransformationEntityType;
  documentId?: string;
  relationshipType?: DocumentRelationshipType;
  relevance?: string;
  tags?: string[];
  note?: string;
}

interface SyncResult {
  linkId: string;
  operation: 'created' | 'updated' | 'deleted';
  relationshipType: string;
  cacheEntityIds?: string[];
  /**
   * GRAPH-069 — fingerprint of the link content this run actually projected.
   * The anchor settlement step compares it against a fresh read: equal proves
   * the edge describes the current source, unequal proves the source moved
   * mid-write and the recovery anchor must survive. Absent for deletes.
   */
  projectedFingerprint?: string;
}

interface SkippedSyncResult {
  linkId: string;
  skipped: true;
  reason:
    | typeof SKIP_REASONS.STALE_ENTITY_DOCUMENT_LINK_DELETE
    | typeof SKIP_REASONS.STALE_ENTITY_DOCUMENT_LINK_UPSERT
    | typeof SKIP_REASONS.ENTITY_DOCUMENT_LINK_NOT_FOUND;
}

type SyncStepResult = SyncResult | SkippedSyncResult;

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Map entity types to Neo4j node labels
 */
const ENTITY_TYPE_TO_LABEL = DOCUMENT_LINK_ENTITY_LABELS;

/**
 * Map document relationship types to Neo4j relationship types
 */
const RELATIONSHIP_TYPE_TO_NEO4J = DOCUMENT_LINK_RELATIONSHIP_TYPES;

const DELETE_SOURCE_WAIT_SECONDS = [1, 2, 4, 8] as const;

type DeleteSourceState = 'deleted' | 'matching' | 'stale';

function classifyDeleteSource(
  link: Awaited<ReturnType<typeof adminGetEntityDocumentLinkById>>,
  eventData: LinkSyncEventData
): DeleteSourceState {
  if (!link) return 'deleted';
  if (endpointsDisagree(link, eventData)) return 'stale';
  return 'matching';
}

/**
 * GRAPH-069 — does this event still describe the link it was dispatched for?
 *
 * Create/update events now carry the endpoint triple the dispatcher read from
 * authoritative Firestore. A replay that arrives after the link id has been
 * reused for different endpoints must NOT project: the caller committed one
 * link and the graph would receive another. Legacy events that carry no
 * endpoints keep projecting — there is nothing to contradict.
 */
function endpointsDisagree(
  link: NonNullable<Awaited<ReturnType<typeof adminGetEntityDocumentLinkById>>>,
  eventData: LinkSyncEventData
): boolean {
  return (
    (eventData.entityId !== undefined && link.entityId !== eventData.entityId) ||
    (eventData.documentId !== undefined && link.documentId !== eventData.documentId)
  );
}

function toLinkSyncData(link: NonNullable<Awaited<ReturnType<typeof adminGetEntityDocumentLinkById>>>) {
  return {
    linkId: link.id,
    entityId: link.entityId,
    entityType: link.entityType,
    documentId: link.documentId,
    relationshipType: link.relationshipType,
    relevance: link.relevance,
    tags: link.tags,
    note: link.note,
  };
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/** Atomically replace every same-ID projection with one authoritative edge. */
function buildReplaceRelationshipQuery(entityLabel: string, relType: string): string {
  return `
    OPTIONAL MATCH ()-[stale {linkId: $linkId}]->()
    WITH collect(stale) AS staleRelationships
    WITH staleRelationships,
         coalesce(
           head([
             relationship IN staleRelationships
             WHERE relationship.createdAt IS NOT NULL
             | relationship.createdAt
           ]),
           $createdAt
         ) AS relationshipCreatedAt,
         size(staleRelationships) AS replaced,
         [relationship IN staleRelationships | startNode(relationship).id] AS previousEntityIds,
         [relationship IN staleRelationships | endNode(relationship).id] AS previousDocumentIds
    FOREACH (relationship IN staleRelationships | DELETE relationship)
    WITH relationshipCreatedAt, replaced, previousEntityIds, previousDocumentIds
    MATCH (e:${entityLabel} {id: $entityId})
    MATCH (d:Document {id: $documentId})
    MERGE (e)-[r:${relType} {linkId: $linkId}]->(d)
    ON CREATE SET
      r.relevance = $relevance,
      r.tags = $tags,
      r.note = $note,
      r.createdAt = relationshipCreatedAt
    ON MATCH SET
      r.relevance = $relevance,
      r.tags = $tags,
      r.note = $note,
      r.updatedAt = $updatedAt
    RETURN r, replaced, previousEntityIds, previousDocumentIds
  `;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function invalidateLinkCaches(linkId: string, entityIds: readonly string[]): void {
  for (const entityId of new Set(entityIds)) {
    try {
      invalidateCachesForEntity(entityId);
    } catch (error) {
      log.warn('Entity-document link cache invalidation failed (non-fatal)', {
        linkId,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function queueMissingLinkEndpoint(
  entityType: TransformationEntityType | 'document',
  entityId: string
): Promise<void> {
  const canonicalEntityType: EntityType | 'document' =
    entityType === 'org_unit' ? 'orgUnit' : entityType === 'pain_point' ? 'painPoint' : entityType;
  const event =
    canonicalEntityType === 'technology'
      ? {
          name: 'app/technology.sync.requested' as const,
          data: { operation: 'update' as const, technologyId: entityId },
        }
      : canonicalEntityType === 'document'
        ? { name: 'app/document.sync.requested' as const, data: { operation: 'update' as const, documentId: entityId } }
        : {
            name: 'app/unified-entity.sync.requested' as const,
            data: { operation: 'update' as const, entityType: canonicalEntityType, entityId },
          };
  const accepted = await inngest.send(event);
  if (!accepted.ids?.length) throw new Error(`Inngest accepted no ${entityType} endpoint sync for ${entityId}`);
}

/**
 * Delete relationship by link ID
 */
const DELETE_RELATIONSHIP = `
  MATCH ()-[r {linkId: $linkId}]->()
  DELETE r
  RETURN count(r) as deleted
`;

/**
 * Check if entity exists in Neo4j
 */
function buildCheckEntityExistsQuery(entityLabel: string): string {
  return `
    MATCH (e:${entityLabel} {id: $entityId})
    RETURN e.id as id
  `;
}

/**
 * Check if document exists in Neo4j
 */
const CHECK_DOCUMENT_EXISTS = `
  MATCH (d:Document {id: $documentId})
  RETURN d.id as id
`;

/**
 * Check if relationship exists
 */
const CHECK_RELATIONSHIP_EXISTS = `
  MATCH ()-[r {linkId: $linkId}]->()
  RETURN r.linkId as linkId
`;

// ============================================================================
// SYNC ENTITY-DOCUMENT LINK JOB
// ============================================================================

/**
 * Sync a single EntityDocumentLink to Neo4j
 *
 * **Trigger:** app/entity-document-link.sync.requested event
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts
 */
export const syncEntityDocumentLinkToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-entity-document-link-to-neo4j-v2',
    name: 'Sync Entity-Document Link to Neo4j (v2)',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },
    concurrency: {
      key: 'event.data.linkId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<LinkSyncEventData>(event.data);
      const linkId = data.linkId || 'unknown';
      log.error('Sync entity-document link final failure', new Error(error.message), { linkId });

      // Update Firestore sync status to failed (skip when the id couldn't be recovered)
      if (linkId !== 'unknown') {
        try {
          await adminMarkLinkSyncFailed(linkId);
        } catch (updateError) {
          log.error('Failed to update sync status', updateError instanceof Error ? updateError : undefined, {
            linkId,
          });
        }
      }

      await inngest.send({
        name: 'app/entity-document-link.sync.failed',
        data: {
          linkId,
          operation: data.operation || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/entity-document-link.sync.requested' },

  async ({ event, step }) => {
    const eventData = event.data as LinkSyncEventData;
    const { operation, linkId } = eventData;

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
        let sourceState: DeleteSourceState = 'matching';
        for (const [index, seconds] of DELETE_SOURCE_WAIT_SECONDS.entries()) {
          sourceState = await step.run(`check-link-source-deleted-${index}`, async () =>
            classifyDeleteSource(await adminGetEntityDocumentLinkById(linkId), eventData)
          );
          if (sourceState !== 'matching') break;
          await step.sleep(`wait-for-link-source-delete-${index}`, `${seconds}s`);
        }

        if (sourceState === 'matching') {
          sourceState = await step.run('require-link-source-deleted', async () => {
            const currentState = classifyDeleteSource(await adminGetEntityDocumentLinkById(linkId), eventData);
            if (currentState === 'matching') {
              throw new Error(
                `Cannot delete graph entity-document link ${linkId} while its Firestore source still exists`
              );
            }
            return currentState;
          });
        }

        if (sourceState === 'stale') {
          log.warn('Skipping stale entity-document link delete event', {
            linkId,
            eventEntityId: eventData.entityId,
            eventDocumentId: eventData.documentId,
          });
          return {
            success: true,
            skipped: true,
            reason: SKIP_REASONS.STALE_ENTITY_DOCUMENT_LINK_DELETE,
            linkId,
          };
        }
      }

      // Step 2: Load link from Firestore if needed
      const linkData = await step.run('load-link-data', async () => {
        if (operation === 'delete') {
          // For delete, we only need the linkId
          return {
            linkId,
            entityId: eventData.entityId,
            entityType: eventData.entityType,
            documentId: eventData.documentId,
            relationshipType: eventData.relationshipType || 'other',
            relevance: eventData.relevance,
            tags: eventData.tags || [],
            note: eventData.note,
          };
        }

        // For create/update, load from Firestore
        const link = await adminGetEntityDocumentLinkById(linkId);
        if (!link) {
          return null;
        }
        return toLinkSyncData(link);
      });

      if (!linkData) {
        log.info('Skipping entity-document link sync because the Firestore source is missing', { linkId });
        return {
          success: true,
          skipped: true,
          reason: SKIP_REASONS.ENTITY_DOCUMENT_LINK_NOT_FOUND,
          linkId,
        };
      }

      // GRAPH-069 — read the durable recovery anchor BEFORE the graph write.
      // The generation observed here is what the settle step compares against:
      // a mutation that fails its handoff DURING this run writes a newer
      // anchor, and generation-CAS keeps that newer debt from being retired by
      // a convergence it never had. Deletes are excluded — their anchor is the
      // Firestore row the caller has not yet removed.
      const anchorGeneration =
        operation === 'delete'
          ? null
          : await step.run('read-graph-sync-anchor', async () => {
              try {
                const anchor = await readEntityGraphSyncAnchor(ENTITY_DOCUMENT_LINK_ANCHOR_TYPE, linkId);
                return anchor?.generation ?? null;
              } catch (error) {
                // Recovery bookkeeping must never fail a projection.
                log.warn('Could not read entity-document link graph sync anchor', {
                  linkId,
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              }
            });

      // Step 3: Perform operation
      const result = await step.run('sync-link', async (): Promise<SyncStepResult> => {
        switch (operation) {
          case 'create':
          case 'update': {
            // Durable steps may replay the earlier load result after a delete or
            // edit. Re-read at the graph mutation boundary and use only current
            // authoritative fields so an old event cannot resurrect/stale-write.
            const currentLink = await adminGetEntityDocumentLinkById(linkId);
            if (!currentLink) {
              return {
                linkId,
                skipped: true,
                reason: SKIP_REASONS.ENTITY_DOCUMENT_LINK_NOT_FOUND,
              };
            }
            // GRAPH-069: a conflicting replay fails closed. The dispatcher put
            // the endpoints it read into the event; if the link now has other
            // endpoints, this event describes a mutation that is no longer the
            // current one and must not be projected.
            if (endpointsDisagree(currentLink, eventData)) {
              log.warn('Skipping stale entity-document link upsert event', {
                linkId,
                eventEntityId: eventData.entityId,
                eventDocumentId: eventData.documentId,
              });
              return {
                linkId,
                skipped: true,
                reason: SKIP_REASONS.STALE_ENTITY_DOCUMENT_LINK_UPSERT,
              };
            }
            const current = toLinkSyncData(currentLink);
            const entityLabel = ENTITY_TYPE_TO_LABEL[current.entityType as TransformationEntityType] || 'Entity';
            const neo4jRelType =
              RELATIONSHIP_TYPE_TO_NEO4J[current.relationshipType as DocumentRelationshipType] || 'LINKED_TO';
            const now = Date.now();

            // Verify entity exists in Neo4j
            const entityExistsQuery = buildCheckEntityExistsQuery(entityLabel);
            const entityResult = await runReadTransaction<{ id: string }>(entityExistsQuery, {
              entityId: current.entityId,
            });

            if (entityResult.records.length === 0) {
              log.warn('Entity not found in Neo4j, skipping link', { entityLabel, entityId: current.entityId });
              await queueMissingLinkEndpoint(current.entityType, current.entityId);
              throw new Error(`Entity ${entityLabel}:${current.entityId} not found in Neo4j`);
            }

            // Verify document exists in Neo4j
            const docResult = await runReadTransaction<{ id: string }>(CHECK_DOCUMENT_EXISTS, {
              documentId: current.documentId,
            });

            if (docResult.records.length === 0) {
              log.warn('Document not found in Neo4j, skipping link', { documentId: current.documentId });
              await queueMissingLinkEndpoint('document', current.documentId);
              throw new Error(`Document ${current.documentId} not found in Neo4j`);
            }

            // One graph transaction removes all old/corrupt/duplicate
            // projections for this link ID and writes exactly the current edge.
            const replaceQuery = buildReplaceRelationshipQuery(entityLabel, neo4jRelType);
            const replaceResult = await runWriteTransaction<{
              previousEntityIds?: unknown;
              previousDocumentIds?: unknown;
            }>(replaceQuery, {
              entityId: current.entityId,
              documentId: current.documentId,
              linkId: current.linkId,
              relevance: current.relevance || 'medium',
              tags: current.tags || [],
              note: current.note || null,
              createdAt: now,
              updatedAt: now,
            });
            if (replaceResult.records.length === 0) {
              throw new Error(
                `Cannot project entity-document link ${current.linkId}: current graph endpoints disappeared`
              );
            }

            return {
              linkId: current.linkId,
              operation: operation === 'create' ? 'created' : 'updated',
              relationshipType: neo4jRelType,
              cacheEntityIds: [
                current.entityId,
                current.documentId,
                ...stringIds(replaceResult.records[0]?.previousEntityIds),
                ...stringIds(replaceResult.records[0]?.previousDocumentIds),
              ],
              projectedFingerprint: buildEntityDocumentLinkProjectionFingerprint(currentLink),
            };
          }

          case 'delete': {
            const neo4jRelType =
              RELATIONSHIP_TYPE_TO_NEO4J[linkData.relationshipType as DocumentRelationshipType] || 'LINKED_TO';
            // Check if relationship exists
            const existsResult = await runReadTransaction<{ linkId: string }>(CHECK_RELATIONSHIP_EXISTS, {
              linkId: linkData.linkId,
            });

            if (existsResult.records.length === 0) {
              // Already deleted
              return {
                linkId: linkData.linkId,
                operation: 'deleted',
                relationshipType: neo4jRelType,
                cacheEntityIds: [linkData.entityId, linkData.documentId].filter(
                  (id): id is string => typeof id === 'string'
                ),
              };
            }

            // The source may have been recreated after the wait steps. Re-read
            // at the graph mutation boundary so an old event cannot delete a
            // newly-created edge that reused the same link ID.
            const mutationSourceState = classifyDeleteSource(await adminGetEntityDocumentLinkById(linkId), eventData);
            if (mutationSourceState === 'matching') {
              throw new Error(
                `Cannot delete graph entity-document link ${linkId} while its Firestore source still exists`
              );
            }
            if (mutationSourceState === 'stale') {
              log.warn('Skipping stale entity-document link delete at graph mutation boundary', {
                linkId,
                eventEntityId: eventData.entityId,
                eventDocumentId: eventData.documentId,
              });
              return {
                linkId,
                skipped: true,
                reason: SKIP_REASONS.STALE_ENTITY_DOCUMENT_LINK_DELETE,
              };
            }

            // Delete the relationship
            await runWriteTransaction(DELETE_RELATIONSHIP, { linkId: linkData.linkId });

            return {
              linkId: linkData.linkId,
              operation: 'deleted',
              relationshipType: neo4jRelType,
              cacheEntityIds: [linkData.entityId, linkData.documentId].filter(
                (id): id is string => typeof id === 'string'
              ),
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      if ('skipped' in result) {
        return { success: true, ...result };
      }

      invalidateLinkCaches(result.linkId, result.cacheEntityIds ?? []);

      // Step 4: Update Firestore sync status
      await step.run('update-sync-status', async () => {
        if (operation !== 'delete') {
          await adminMarkLinkSynced(linkId);
        }
      });

      // GRAPH-069 — retire the durable recovery anchor, and only on proof.
      //
      // The proof is a fresh read: if the link's projection fingerprint still
      // equals the one this run wrote, the single edge left by the replace
      // query provably describes the current source. If the source moved
      // mid-write the fingerprints differ, the anchor survives, and the next
      // event (or the reconciler) settles it. The clear is compare-and-delete
      // on the generation observed before the write, so a NEWER anchor written
      // during this run — describing debt this run never settled — is left in
      // place. Every failure here is swallowed: recovery bookkeeping must not
      // turn a successful projection into a failed sync.
      if (anchorGeneration) {
        await step.run('settle-entity-graph-sync-anchor', async () => {
          try {
            const current = await adminGetEntityDocumentLinkById(linkId);
            if (!current) {
              return {
                outcome: await clearConvergedEntityGraphSyncAnchor(
                  ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
                  linkId,
                  anchorGeneration
                ),
                reason: 'link-deleted',
              };
            }
            if (!result.projectedFingerprint) return { outcome: 'no-projection-written' };
            if (buildEntityDocumentLinkProjectionFingerprint(current) !== result.projectedFingerprint) {
              return { outcome: 'source-moved' };
            }
            return {
              outcome: await clearConvergedEntityGraphSyncAnchor(
                ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
                linkId,
                anchorGeneration
              ),
            };
          } catch (error) {
            log.warn('Could not settle entity-document link graph sync recovery anchor', {
              linkId,
              error: error instanceof Error ? error.message : String(error),
            });
            return { outcome: 'settle-failed' };
          }
        });
      }

      // Step 5: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/entity-document-link.sync.completed',
          data: {
            linkId: result.linkId,
            operation: result.operation,
            relationshipType: result.relationshipType,
            syncedAt: Date.now(),
          },
        });
      });

      log.info('Sync entity-document link completed', {
        linkId,
        operation: result.operation,
        relationshipType: result.relationshipType,
      });

      return {
        success: true,
        ...result,
      };
    } catch (error) {
      log.error('Sync entity-document link failed', error instanceof Error ? error : undefined, { linkId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple EntityDocumentLinks to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/entity-document-link.batch-sync.requested event
 * **Timeout:** 10 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncEntityDocumentLinksJob = inngest.createFunction(
  {
    id: 'batch-sync-entity-document-links-to-neo4j',
    name: 'Batch Sync Entity-Document Links to Neo4j',
    retries: 2,

    onFailure: async ({ error }) => {
      log.error('Batch sync entity-document links final failure', new Error(error.message));
    },
  },

  { event: 'app/entity-document-link.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-entity-document-links-to-neo4j');
    const { linkIds, options } = event.data as {
      linkIds: string[];
      options?: { batchSize?: number };
    };

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
      });

      // Step 2: Process links in batches
      const batchSize = options?.batchSize || 20;
      const results = {
        synced: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < linkIds.length; i += batchSize) {
        const batch = linkIds.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          for (const linkId of batch) {
            try {
              // Trigger individual sync for each link
              await inngest.send({
                name: 'app/entity-document-link.sync.requested',
                data: {
                  operation: 'update' as const,
                  linkId,
                },
              });

              results.synced++;
            } catch (error) {
              results.failed++;
              results.errors.push(
                `Failed to queue sync for ${linkId}: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }

          return { batchNum, processed: batch.length };
        });
      }

      log.info('Batch sync entity-document links completed', {
        synced: results.synced,
        total: linkIds.length,
        failed: results.failed,
      });

      return {
        success: results.failed === 0,
        ...results,
      };
    } catch (error) {
      log.error('Batch sync entity-document links failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trigger an entity-document link sync from application code
 */
export async function triggerEntityDocumentLinkSync(
  linkId: string,
  operation: 'create' | 'update' | 'delete',
  additionalData?: Partial<Omit<LinkSyncEventData, 'linkId' | 'operation'>>
): Promise<void> {
  await inngest.send({
    name: 'app/entity-document-link.sync.requested',
    data: {
      operation,
      linkId,
      ...additionalData,
    },
  });
}

/**
 * Trigger batch sync of multiple entity-document links
 */
export async function triggerBatchEntityDocumentLinkSync(
  linkIds: string[],
  options?: { batchSize?: number }
): Promise<void> {
  await inngest.send({
    name: 'app/entity-document-link.batch-sync.requested',
    data: {
      linkIds,
      options,
    },
  });
}
