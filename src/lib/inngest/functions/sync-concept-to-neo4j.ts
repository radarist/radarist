/**
 * @file lib/inngest/functions/sync-concept-to-neo4j.ts
 * @description Inngest job for syncing Concept entities to Neo4j
 *
 * This module handles synchronization of normalized concepts to the Neo4j graph:
 * - Creates/updates Concept nodes with normalized slugs and canonical names
 * - Supports concept hierarchies via PARENT_CONCEPT relationships
 * - Updates Firestore sync status after successful/failed sync
 *
 * **Concept Node Properties:**
 * - id: concept-{slug} (e.g., "concept-artificial-intelligence")
 * - slug: URL-safe identifier (e.g., "artificial-intelligence")
 * - canonicalName: Display name (e.g., "Artificial Intelligence")
 * - type: ConceptType (tag, category, industry, capability, domain)
 * - aliases: Array of input variations (e.g., ["AI", "ai", "A.I."])
 * - description: Optional description
 * - entityCount: Number of entities linked to this concept
 *
 * **Trigger:** Event-driven (`app/concept.sync.requested`)
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 * @author Radarist Team
 * @created 2026-01-14
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { extractFailureEventData } from '../utils';
import { checkHealth, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import {
  adminGetConceptById as getConceptById,
  adminMarkConceptSynced as markConceptSynced,
  adminMarkConceptSyncFailed as markConceptSyncFailed,
} from '@/lib/concept-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/sync-concept-to-neo4j');
import type { ConceptType } from '@/lib/types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ConceptSyncEventData {
  operation: 'create' | 'update' | 'delete';
  conceptId: string;
  slug?: string;
  canonicalName?: string;
  type?: ConceptType;
  aliases?: string[];
  description?: string;
  parentId?: string;
  entityCount?: number;
}

interface SyncResult {
  conceptId: string;
  operation: 'created' | 'updated' | 'deleted';
  slug: string;
  /**
   * P3-B (H7 model): PARENT_CONCEPT edge writes that failed
   * this run. Non-zero ⇒ the run must not report success:true — previously
   * these were warn-and-continue masked.
   */
  edgeFailures?: number;
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/**
 * Create or update a Concept node
 */
const UPSERT_CONCEPT = `
  MERGE (c:Concept {id: $id})
  ON CREATE SET
    c.slug = $slug,
    c.canonicalName = $canonicalName,
    c.type = $type,
    c.aliases = $aliases,
    c.description = $description,
    c.createdAt = $createdAt,
    c.updatedAt = $updatedAt
  ON MATCH SET
    c.slug = $slug,
    c.canonicalName = $canonicalName,
    c.type = $type,
    c.aliases = $aliases,
    c.description = $description,
    c.updatedAt = $updatedAt
  RETURN c
`;

/**
 * Delete a Concept node and its relationships
 */
const DELETE_CONCEPT = `
  MATCH (c:Concept {id: $id})
  DETACH DELETE c
  RETURN count(c) as deleted
`;

/**
 * Check if Concept node exists
 */
const CHECK_CONCEPT_EXISTS = `
  MATCH (c:Concept {id: $id})
  RETURN c.id as id
`;

/**
 * Set or remove parent relationship
 */
const SET_PARENT_CONCEPT = `
  MATCH (child:Concept {id: $childId})
  OPTIONAL MATCH (child)-[oldRel:PARENT_CONCEPT]->()
  DELETE oldRel
  WITH child
  MATCH (parent:Concept {id: $parentId})
  CREATE (child)-[:PARENT_CONCEPT]->(parent)
  RETURN child, parent
`;

/**
 * Remove parent relationship
 */
const REMOVE_PARENT_CONCEPT = `
  MATCH (child:Concept {id: $childId})-[r:PARENT_CONCEPT]->()
  DELETE r
  RETURN count(r) as removed
`;

// ============================================================================
// SYNC CONCEPT JOB
// ============================================================================

/**
 * Sync a single Concept to Neo4j
 *
 * **Trigger:** app/concept.sync.requested event
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts
 */
export const syncConceptToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-concept-to-neo4j',
    name: 'Sync Concept to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<ConceptSyncEventData>(event.data);
      const conceptId = data.conceptId || 'unknown';
      log.error('Sync concept final failure', new Error(error.message), { conceptId });

      // Update Firestore sync status to failed (skip when the id couldn't be recovered)
      if (conceptId !== 'unknown') {
        try {
          await markConceptSyncFailed(conceptId);
        } catch (updateError) {
          log.error('Failed to update sync status', updateError instanceof Error ? updateError : undefined, {
            conceptId,
          });
        }
      }

      await inngest.send({
        name: 'app/concept.sync.failed',
        data: {
          conceptId,
          operation: data.operation || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/concept.sync.requested' },

  async ({ event, step }) => {
    const eventData = event.data as ConceptSyncEventData;
    const { operation, conceptId } = eventData;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      // Step 2: Load concept from Firestore if needed
      const conceptData = await step.run('load-concept-data', async () => {
        if (operation === 'delete') {
          // For delete, we only need the conceptId
          return {
            id: conceptId,
            slug: eventData.slug || conceptId.replace('concept-', ''),
            canonicalName: eventData.canonicalName || '',
            type: eventData.type || 'tag',
            aliases: eventData.aliases || [],
            description: eventData.description,
            parentId: eventData.parentId,
            entityCount: eventData.entityCount || 0,
          };
        }

        // For create/update, load from Firestore
        const concept = await getConceptById(conceptId);
        if (!concept) {
          throw new Error(`Concept ${conceptId} not found in Firestore`);
        }

        return {
          id: concept.id,
          slug: concept.slug,
          canonicalName: concept.canonicalName,
          type: concept.type,
          aliases: concept.aliases,
          description: concept.description,
          parentId: concept.parentId,
          entityCount: concept.entityCount || 0,
        };
      });

      // Step 3: Perform operation
      const result = await step.run('sync-concept', async (): Promise<SyncResult> => {
        const now = Date.now();

        switch (operation) {
          case 'create':
          case 'update': {
            let edgeFailures = 0;

            // Create/update the Concept node
            await runWriteTransaction(UPSERT_CONCEPT, {
              id: conceptData.id,
              slug: conceptData.slug,
              canonicalName: conceptData.canonicalName,
              type: conceptData.type,
              aliases: conceptData.aliases,
              description: conceptData.description || null,
              createdAt: now,
              updatedAt: now,
            });

            // Handle parent relationship
            if (conceptData.parentId) {
              try {
                await runWriteTransaction(SET_PARENT_CONCEPT, {
                  childId: conceptData.id,
                  parentId: conceptData.parentId,
                });
              } catch (_parentError) {
                // Don't throw for parent-edge issues, but count them (P3-B)
                // so the run summary stays honest.
                edgeFailures++;
                log.warn('Failed to set parent concept', { childId: conceptData.id, parentId: conceptData.parentId });
              }
            } else {
              // Remove any existing parent relationship
              try {
                await runWriteTransaction(REMOVE_PARENT_CONCEPT, {
                  childId: conceptData.id,
                });
              } catch {
                // Ignore - no parent relationship exists
              }
            }

            // HAS_CONCEPT topology and entityCount are owned exclusively by
            // entity sync. The old Concept-side collection scans were capped at
            // 100 rows, created unowned edges, and could overwrite a newer
            // topology-derived count with a stale Firestore snapshot.

            return {
              conceptId: conceptData.id,
              operation: operation === 'create' ? 'created' : 'updated',
              slug: conceptData.slug,
              edgeFailures,
            };
          }

          case 'delete': {
            // Check if concept exists
            const existsResult = await runReadTransaction<{ id: string }>(CHECK_CONCEPT_EXISTS, { id: conceptData.id });

            if (existsResult.records.length === 0) {
              // Already deleted
              return {
                conceptId: conceptData.id,
                operation: 'deleted',
                slug: conceptData.slug,
              };
            }

            // Delete the concept and its relationships
            await runWriteTransaction(DELETE_CONCEPT, { id: conceptData.id });

            return {
              conceptId: conceptData.id,
              operation: 'deleted',
              slug: conceptData.slug,
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      // Step 4: Update Firestore sync status
      await step.run('update-sync-status', async () => {
        if (operation !== 'delete') {
          await markConceptSynced(conceptId);
        }
      });

      // Step 5: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/concept.sync.completed',
          data: {
            conceptId: result.conceptId,
            operation: result.operation,
            slug: result.slug,
            syncedAt: Date.now(),
          },
        });
      });

      log.info('Sync concept completed', {
        conceptId,
        operation: result.operation,
        slug: result.slug,
        edgeFailures: result.edgeFailures ?? 0,
      });

      return {
        // P3-B (H7 model): a run that failed edge writes must not report
        // blanket success — concept traversal silently misses those edges.
        success: (result.edgeFailures ?? 0) === 0,
        ...result,
      };
    } catch (error) {
      log.error('Sync concept failed', error instanceof Error ? error : undefined, { conceptId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple Concepts to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/concept.batch-sync.requested event
 * **Timeout:** 10 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncConceptsJob = inngest.createFunction(
  {
    id: 'batch-sync-concepts-to-neo4j',
    name: 'Batch Sync Concepts to Neo4j',
    retries: 2,

    onFailure: async ({ error }) => {
      log.error('Batch sync concepts final failure', new Error(error.message));
    },
  },

  { event: 'app/concept.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-concepts-to-neo4j');
    const { conceptIds, options } = event.data as {
      conceptIds: string[];
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

      // Step 2: Process concepts in batches
      const batchSize = options?.batchSize || 20;
      const results = {
        synced: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < conceptIds.length; i += batchSize) {
        const batch = conceptIds.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          for (const conceptId of batch) {
            try {
              // Trigger individual sync for each concept
              await inngest.send({
                name: 'app/concept.sync.requested',
                data: {
                  operation: 'update' as const,
                  conceptId,
                },
              });

              results.synced++;
            } catch (error) {
              results.failed++;
              results.errors.push(
                `Failed to queue sync for ${conceptId}: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }

          return { batchNum, processed: batch.length };
        });
      }

      log.info('Batch sync concepts completed', {
        synced: results.synced,
        total: conceptIds.length,
        failed: results.failed,
      });

      return {
        success: results.failed === 0,
        ...results,
      };
    } catch (error) {
      log.error('Batch sync concepts failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trigger a concept sync from application code
 */
export async function triggerConceptSync(
  conceptId: string,
  operation: 'create' | 'update' | 'delete',
  additionalData?: Partial<Omit<ConceptSyncEventData, 'conceptId' | 'operation'>>
): Promise<void> {
  await inngest.send({
    name: 'app/concept.sync.requested',
    data: {
      operation,
      conceptId,
      ...additionalData,
    },
  });
}

/**
 * Trigger batch sync of multiple concepts
 */
export async function triggerBatchConceptSync(conceptIds: string[], options?: { batchSize?: number }): Promise<void> {
  await inngest.send({
    name: 'app/concept.batch-sync.requested',
    data: {
      conceptIds,
      options,
    },
  });
}
