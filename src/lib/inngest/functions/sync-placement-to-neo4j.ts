/**
 * @file lib/inngest/functions/sync-placement-to-neo4j.ts
 * @description Inngest job for syncing RadarPlacement between Firestore and Neo4j
 *
 * This module handles synchronization of radar placements to the Neo4j graph:
 * - Creates RadarPlacement nodes
 * - Creates relationships: (RadarPlacement)-[:PLACES]->(Technology)
 * - Creates relationships: (RadarPlacement)-[:ON_RADAR]->(Radar)
 * - Handles delete cascades to prevent orphaned claims
 *
 * **Execution Flow:**
 * 1. Receive event with placement data
 * 2. Check Neo4j health
 * 3. Create/update/delete RadarPlacement node
 * 4. Create/update relationships to Technology and Radar
 * 5. Handle delete cascades for related Claims
 * 6. Send completion event
 *
 * **Trigger:** Event-driven (`app/radar-placement.sync.requested`)
 * **Timeout:** 1 minute per placement
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Phase 0 Task 0.1.3
 * @author Radarist Team
 * @created 2026-01-10
 */

import { createHash } from 'node:crypto';

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { toMillis, extractFailureEventData } from '../utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/sync-placement-to-neo4j');
import { checkHealth, deleteEntityFromGraph, runWriteTransaction } from '@/lib/graph';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import { buildRadarPlacementPairKey } from '@/lib/radar-placement-pair-key';
import type { RadarData, RadarPlacement } from '@/lib/types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface PlacementData {
  technologyId: string;
  radarId: string;
  quadrantId: string;
  /** Denormalized display name for Neo4j read performance. */
  quadrantName?: string;
  ring: string;
  rationale?: string;
  placedBy: string;
  createdAt?: number;
  updatedAt?: number;
}

interface SyncResult {
  placementId: string;
  operation: 'created' | 'updated' | 'deleted';
  relationshipsCreated?: number;
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/**
 * Create or update a RadarPlacement node
 */
const UPSERT_PLACEMENT = `
  MERGE (p:RadarPlacement {id: $placementId})
  ON CREATE SET
    p.technologyId = $technologyId,
    p.radarId = $radarId,
    p.quadrantId = $quadrantId,
    p.quadrantName = $quadrantName,
    p.pairKey = $pairKey,
    p.ring = $ring,
    p.rationale = $rationale,
    p.placedBy = $placedBy,
    p.createdAt = $createdAt,
    p.updatedAt = $updatedAt
  ON MATCH SET
    p.quadrantId = $quadrantId,
    p.quadrantName = $quadrantName,
    p.pairKey = $pairKey,
    p.ring = $ring,
    p.rationale = $rationale,
    p.updatedAt = $updatedAt
  RETURN p
`;

/**
 * Create relationship from RadarPlacement to Technology.
 *
 * `PLACES` is structural wiring (membership), not a factual assertion, so it
 * doesn't participate in F1 supersession. We still stamp t_observed / t_valid
 * and a confidence of 100 so `graph:health` sees full temporal+confidence
 * coverage across every edge — keeps the threshold honest without carving
 * out exceptions for wiring edges.
 */
const CREATE_PLACES_RELATIONSHIP = `
  MATCH (p:RadarPlacement {id: $placementId})
  MATCH (t:Entity:Technology {id: $technologyId})
  MERGE (p)-[r:PLACES]->(t)
  ON CREATE SET r.createdAt = $createdAt,
                r.t_observed = toString(datetime()),
                r.t_valid = toString(datetime()),
                r.confidence = 100,
                r.assertedConfidence = 100,
                r.effectiveConfidence = 100
  RETURN r
`;

/**
 * Create relationship from RadarPlacement to Radar.
 * Same wiring rationale as PLACES above.
 */
const CREATE_ON_RADAR_RELATIONSHIP = `
  MATCH (p:RadarPlacement {id: $placementId})
  MATCH (r:Radar {id: $radarId})
  MERGE (p)-[rel:ON_RADAR]->(r)
  ON CREATE SET rel.createdAt = $createdAt,
                rel.t_observed = toString(datetime()),
                rel.t_valid = toString(datetime()),
                rel.confidence = 100,
                rel.assertedConfidence = 100,
                rel.effectiveConfidence = 100
  RETURN rel
`;

/**
 * GRAPH-066 — remove structural wiring that no longer matches the placement's
 * CURRENT endpoints.
 *
 * `UPSERT_PLACEMENT` merges on the placement id and the two edge queries merge
 * on their pattern, so every projection is additive: an endpoint that ever
 * differed (a legacy row, a repaired document, a drifted projection) leaves its
 * old `PLACES`/`ON_RADAR` behind and the node ends up with two of a structural
 * edge that must be singular. Pruning runs AFTER the correct edges exist, so the
 * node is never transiently unwired.
 */
const PRUNE_STALE_PLACEMENT_EDGES = `
  MATCH (p:RadarPlacement {id: $placementId})-[r]->(other)
  WHERE (type(r) = 'PLACES' AND other.id <> $technologyId)
     OR (type(r) = 'ON_RADAR' AND other.id <> $radarId)
  DELETE r
`;

async function requestMissingRadarProjection(radarId: string, dispatchKey: string): Promise<void> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snapshot = await adminDb.collection('radars').doc(radarId).get();
  if (!snapshot.exists) {
    throw new Error(`Radar ${radarId} no longer exists in Firestore`);
  }

  const radar = { ...(snapshot.data() as Omit<RadarData, 'id'>), id: snapshot.id } as RadarData;
  const accepted = await inngest.send(createRadarProjectionEvent(radar, dispatchKey));
  if (!accepted.ids?.length) {
    throw new Error(`Inngest accepted no projection event for Radar ${radarId}`);
  }
}

function dependencyEventId(kind: 'technology' | 'placement-retry', dispatchKey: string, entityId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['placement-projection-dependency-v1', kind, dispatchKey, entityId]))
    .digest('hex');
  return `placement-dependency-v1-${kind}-${digest}`;
}

async function loadPlacementProjectionSource(placementId: string): Promise<PlacementData | null> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snap = await adminDb.collection('radarPlacements').doc(placementId).get();
  if (!snap.exists) return null;

  const placement = snap.data() as RadarPlacement;
  return {
    technologyId: placement.technologyId,
    radarId: placement.radarId,
    quadrantId: placement.quadrantId,
    quadrantName: placement.quadrantName,
    ring: placement.ring,
    rationale: placement.rationale,
    placedBy: placement.placedBy,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
  } as PlacementData;
}

/**
 * Requeue the exact Technology endpoint before failing the placement step.
 *
 * Technology and placement projection events are independent, so a placement
 * worker can reach Neo4j before the Technology worker even when Firestore was
 * written in the correct order. A zero-row PLACES query is therefore a
 * retryable dependency race, not a successful partial projection.
 */
async function requestMissingTechnologyProjection(technologyId: string, dispatchKey: string): Promise<void> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snapshot = await adminDb.collection('technologies').doc(technologyId).get();
  if (!snapshot.exists) {
    throw new Error(`Technology ${technologyId} no longer exists in Firestore`);
  }

  const accepted = await inngest.send({
    id: dependencyEventId('technology', dispatchKey, technologyId),
    name: 'app/technology.sync.requested',
    data: {
      operation: 'update',
      technologyId,
    },
  });
  if (!accepted.ids?.length) {
    throw new Error(`Inngest accepted no projection event for Technology ${technologyId}`);
  }
}

async function requestPlacementProjectionRetry(placementId: string, dispatchKey: string): Promise<void> {
  const accepted = await inngest.send({
    id: dependencyEventId('placement-retry', dispatchKey, placementId),
    name: 'app/radar-placement.sync.requested',
    data: {
      operation: 'update',
      placementId,
    },
  });
  if (!accepted.ids?.length) {
    throw new Error(`Inngest accepted no retry event for RadarPlacement ${placementId}`);
  }
}

// ============================================================================
// SYNC PLACEMENT JOB
// ============================================================================

/**
 * Sync a single RadarPlacement to Neo4j
 *
 * **Trigger:** app/radar-placement.sync.requested event
 * **Timeout:** 1 minute
 * **Retries:** 3 attempts
 */
export const syncPlacementToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-placement-to-neo4j',
    name: 'Sync RadarPlacement to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },
    concurrency: {
      key: 'event.data.placementId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<{ placementId?: string }>(event.data);
      const placementId = data.placementId || 'unknown';
      log.error('Sync placement final failure', new Error(error.message), { placementId });

      await inngest.send({
        name: 'app/radar-placement.sync.failed',
        data: {
          placementId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/radar-placement.sync.requested' },

  async ({ event, step }) => {
    const { operation, placementId, placementData, deleteToken } = event.data;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      // Step 2: Load placement from Firestore if not provided
      const placeData = await step.run('load-placement-data', async () => {
        if (placementData) {
          return placementData;
        }

        // Load from Firestore for reconciliation/backfill scenarios. Read via
        // the admin SDK directly instead of `@/lib/radar-placement-service`,
        // which transitively imports the client SDK and hangs gRPC streams
        // server-side. Same bug class as the relation sync fix on 2026-05-12.
        const placement = await loadPlacementProjectionSource(placementId);
        if (!placement) {
          // Doc absent in Firestore. For 'delete' that's the EXPECTED state
          // (the doc was just removed) — the delete branch below only needs
          // placementId. For create/update the write-boundary read below owns
          // the final decision and removes any earlier partial graph node.
          log.info('Placement doc not found in Firestore', { placementId, operation });
          return null;
        }
        return placement;
      });

      // A completed Inngest load step is memoized across retries. Do not use a
      // missing or present preflight snapshot as the graph-write authority;
      // the create/update branch re-reads Firestore inside its retryable step.
      if (!placeData && operation !== 'delete') {
        log.info('Placement absent during preflight; write-boundary reconciliation required', {
          placementId,
          operation,
        });
      }

      // Step 3: Perform operation
      const result = await step.run('sync-placement', async (): Promise<SyncResult> => {
        switch (operation) {
          case 'create':
          case 'update': {
            // Re-read at the graph-write boundary. The preflight load step is
            // memoized across retries and an inline event payload can be stale.
            const currentPlaceData = await loadPlacementProjectionSource(placementId);
            if (!currentPlaceData) {
              await deleteEntityFromGraph(placementId, 'radarPlacement');
              log.info('Removed graph placement because its Firestore source disappeared', {
                placementId,
                operation,
              });
              return { placementId, operation: 'deleted' };
            }
            const now = Date.now();
            const params = {
              placementId,
              technologyId: currentPlaceData.technologyId,
              radarId: currentPlaceData.radarId,
              quadrantId: currentPlaceData.quadrantId,
              // GRAPH-066: deterministic pair identity mirrored onto the node so
              // graph health/drift and the pair-key uniqueness constraint have a
              // property to enforce.
              pairKey: buildRadarPlacementPairKey(currentPlaceData.radarId, currentPlaceData.technologyId),
              // Denormalized display name — Neo4j reads skip the join with this populated.
              quadrantName: currentPlaceData.quadrantName ?? null,
              ring: currentPlaceData.ring,
              rationale: currentPlaceData.rationale || null,
              placedBy: currentPlaceData.placedBy,
              // Convert timestamps (handles serialized Firestore timestamps from Inngest events)
              createdAt: toMillis(currentPlaceData.createdAt, now),
              updatedAt: toMillis(currentPlaceData.updatedAt, now),
            };

            // Create/update the placement node
            await runWriteTransaction(UPSERT_PLACEMENT, params);

            // Create relationships
            let relationshipsCreated = 0;

            // Create PLACES relationship to Technology
            const placesResult = await runWriteTransaction(CREATE_PLACES_RELATIONSHIP, {
              placementId,
              technologyId: currentPlaceData.technologyId,
              createdAt: now,
            });
            if (placesResult.records.length === 0) {
              await requestMissingTechnologyProjection(
                currentPlaceData.technologyId,
                `single:${event.id}:${placementId}`
              );
              throw new Error(
                `Technology ${currentPlaceData.technologyId} is not projected yet; retry placement ${placementId}`
              );
            }
            if (placesResult.summary.counters.relationshipsCreated > 0) {
              relationshipsCreated++;
            }

            // Create ON_RADAR relationship to Radar
            const onRadarResult = await runWriteTransaction(CREATE_ON_RADAR_RELATIONSHIP, {
              placementId,
              radarId: currentPlaceData.radarId,
              createdAt: now,
            });
            if (onRadarResult.records.length === 0) {
              await requestMissingRadarProjection(currentPlaceData.radarId, `placement:${event.id}`);
              throw new Error(`Radar ${currentPlaceData.radarId} is not projected yet; retry placement ${placementId}`);
            }
            if (onRadarResult.summary.counters.relationshipsCreated > 0) {
              relationshipsCreated++;
            }

            // GRAPH-066 — both current edges now exist; drop any that point at a
            // superseded endpoint so exactly one PLACES and one ON_RADAR remain.
            const pruned = await runWriteTransaction(PRUNE_STALE_PLACEMENT_EDGES, {
              placementId,
              technologyId: currentPlaceData.technologyId,
              radarId: currentPlaceData.radarId,
            });
            if (pruned.summary.counters.relationshipsDeleted > 0) {
              log.info('Pruned superseded placement structural edges', {
                placementId,
                pruned: pruned.summary.counters.relationshipsDeleted,
              });
            }

            return {
              placementId,
              operation: operation === 'create' ? 'created' : 'updated',
              relationshipsCreated,
            };
          }

          case 'delete': {
            // Remove endpoint-backed Assertions and the placement atomically,
            // even when an earlier partial delete already removed the node.
            const { assertionsDeleted } = await deleteEntityFromGraph(placementId, 'radarPlacement');
            if (assertionsDeleted > 0) {
              log.info('Deleted placement assertion topology', { placementId, assertionsDeleted });
            }

            return {
              placementId,
              operation: 'deleted',
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      // Step 3.5 (GRAPH-060 #1): clear the durable delete tombstone ONLY after the
      // graph removal above succeeded (reaching here means step 3 did not throw).
      // A token CAS ensures a delayed redelivery can't drop a newer delete debt.
      if (operation === 'delete' && deleteToken) {
        await step.run('clear-placement-delete-outbox', async () => {
          const { db: adminDb } = await import('@/lib/firebase-admin');
          const { RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION, parseRadarPlacementDeleteOutboxRecord } =
            await import('@/lib/radar-placement-delete-outbox');
          const markerRef = adminDb.collection(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION).doc(placementId);
          await adminDb.runTransaction(async (transaction) => {
            const marker = await transaction.get(markerRef);
            if (!marker.exists) return;
            const record = parseRadarPlacementDeleteOutboxRecord(placementId, marker.data());
            if (record?.deleteToken === deleteToken) transaction.delete(markerRef);
          });
        });
      }

      // Step 4: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/radar-placement.sync.completed',
          data: {
            placementId: result.placementId,
            operation: result.operation,
            syncedAt: Date.now(),
          },
        });
      });

      return {
        success: true,
        ...result,
      };
    } catch (error) {
      log.error('Sync placement failed', error instanceof Error ? error : undefined, { placementId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple RadarPlacements to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/radar-placement.batch-sync.requested event
 * **Timeout:** 10 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncPlacementsJob = inngest.createFunction(
  {
    id: 'batch-sync-placements-to-neo4j',
    name: 'Batch Sync RadarPlacements to Neo4j',
    retries: 2,

    onFailure: async ({ error }) => {
      log.error('Batch sync placements final failure', new Error(error.message));

      await inngest.send({
        name: 'app/radar-placement.batch-sync.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for backfills.
  { event: 'app/radar-placement.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-placements-to-neo4j');
    const { placements, options } = event.data;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
      });

      // Step 2: Process placements in batches
      const batchSize = options?.batchSize || 50;
      const results = {
        created: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < placements.length; i += batchSize) {
        const batch = placements.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          const now = Date.now();

          for (const placement of batch) {
            try {
              const params = {
                placementId: placement.id,
                technologyId: placement.technologyId,
                radarId: placement.radarId,
                quadrantId: placement.quadrantId,
                // GRAPH-066: deterministic pair identity mirrored onto the node.
                pairKey: buildRadarPlacementPairKey(placement.radarId, placement.technologyId),
                // Denormalized display name for Neo4j read performance.
                quadrantName: placement.quadrantName ?? null,
                ring: placement.ring,
                rationale: placement.rationale || null,
                placedBy: placement.placedBy,
                // Convert timestamps (handles serialized Firestore timestamps)
                createdAt: toMillis(placement.createdAt, now),
                updatedAt: toMillis(placement.updatedAt, now),
              };

              // Create placement and relationships
              await runWriteTransaction(UPSERT_PLACEMENT, params);
              const placesResult = await runWriteTransaction(CREATE_PLACES_RELATIONSHIP, {
                placementId: placement.id,
                technologyId: placement.technologyId,
                createdAt: now,
              });
              if (placesResult.records.length === 0) {
                const dispatchKey = `batch:${event.id}:${placement.id}`;
                await requestMissingTechnologyProjection(placement.technologyId, dispatchKey);
                await requestPlacementProjectionRetry(placement.id, dispatchKey);
                throw new Error(
                  `Technology ${placement.technologyId} is not projected yet; queued retry for placement ${placement.id}`
                );
              }
              const onRadarResult = await runWriteTransaction(CREATE_ON_RADAR_RELATIONSHIP, {
                placementId: placement.id,
                radarId: placement.radarId,
                createdAt: now,
              });
              if (onRadarResult.records.length === 0) {
                const dispatchKey = `placement-batch:${event.id}:${placement.id}`;
                await requestMissingRadarProjection(placement.radarId, dispatchKey);
                await requestPlacementProjectionRetry(placement.id, dispatchKey);
                throw new Error(
                  `Radar ${placement.radarId} is not projected yet; queued retry for placement ${placement.id}`
                );
              }

              // GRAPH-066 — same singular-wiring guarantee on the backfill path.
              await runWriteTransaction(PRUNE_STALE_PLACEMENT_EDGES, {
                placementId: placement.id,
                technologyId: placement.technologyId,
                radarId: placement.radarId,
              });

              results.created++;
            } catch (error) {
              results.failed++;
              results.errors.push(
                `Failed to sync placement ${placement.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }
          return { batchNum, processed: batch.length };
        });
      }

      // Step 3: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/radar-placement.batch-sync.completed',
          data: {
            totalPlacements: placements.length,
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
      log.error('Batch sync placements failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
