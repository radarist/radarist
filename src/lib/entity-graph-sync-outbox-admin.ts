/**
 * @file entity-graph-sync-outbox-admin.ts
 * @description Admin-SDK reads and convergence clears for the entity
 * graph-sync recovery anchor.
 *
 * GRAPH-056. Retiring an anchor is a server-only decision because it requires
 * comparing the fingerprint stamped on the Neo4j node against the one derived
 * from the authoritative Firestore document — neither of which the browser can
 * see. The browser may record an anchor and hide a local recovery row, but it
 * never retires durable recovery state.
 *
 * The clear is a compare-and-delete on the anchor's immutable generation. Between
 * the caller observing convergence and issuing the delete, a *new* mutation may
 * have failed its handoff and rewritten the anchor; that anchor describes debt
 * the caller never settled, so a blind delete would silently drop it. This is
 * also what makes a delayed completion safe in the other direction: if the
 * document moved during the graph write, the fingerprints no longer agree, the
 * caller never reaches the clear, and the anchor survives for the next round.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  buildEntityGraphSyncOutboxRecord,
  entityGraphSyncOutboxDocumentId,
  parseEntityGraphSyncOutboxRecord,
  type EntityGraphSyncOutboxOperation,
  type EntityGraphSyncOutboxRecord,
  type EntityGraphSyncAnchorType,
} from '@/lib/entity-graph-sync-outbox';

const log = createLogger('entity-graph-sync-outbox-admin');
export const MAX_RECONCILIATION_ENTITY_GRAPH_SYNC_ANCHORS = 100;

export type EntityGraphSyncAnchorClearOutcome =
  /** Anchor removed; the projection provably matches the source. */
  | 'cleared'
  /** Nothing to clear. */
  | 'absent'
  /** A newer anchor replaced the one the caller settled; its debt stands. */
  | 'superseded';

function anchorRef(entityType: EntityGraphSyncAnchorType, entityId: string) {
  return db.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).doc(entityGraphSyncOutboxDocumentId(entityType, entityId));
}

/**
 * Record that a server-side mutation's graph handoff was not acknowledged.
 *
 * The server twin of the browser recorder. A server mutation has no session to
 * return to, so this anchor is diagnostic rather than a retry affordance —
 * convergence comes from the version-aware reconciler. It still fails soft: the
 * entity has already committed, and turning a bookkeeping failure into a thrown
 * error would misreport a saved entity as rejected.
 */
export async function recordEntityGraphSyncAnchor(options: {
  entityType: EntityGraphSyncAnchorType;
  entityId: string;
  operation: EntityGraphSyncOutboxOperation;
  observedUpdatedAt?: number | null;
  error?: unknown;
}): Promise<EntityGraphSyncOutboxRecord | null> {
  try {
    const record = buildEntityGraphSyncOutboxRecord({
      entityType: options.entityType,
      entityId: options.entityId,
      operation: options.operation,
      observedUpdatedAt: options.observedUpdatedAt,
      lastError: options.error,
    });
    await anchorRef(options.entityType, options.entityId).set(record);
    log.warn('Recorded durable graph sync recovery anchor', {
      entityType: options.entityType,
      entityId: options.entityId,
      operation: options.operation,
    });
    return record;
  } catch (error) {
    log.error(
      'Failed to record graph sync recovery anchor; reconciliation remains the backstop',
      error instanceof Error ? error : undefined,
      { entityType: options.entityType, entityId: options.entityId }
    );
    return null;
  }
}

/**
 * Read the current anchor. A malformed document throws rather than reading as
 * absent, so corruption cannot be mistaken for a settled debt.
 */
export async function readEntityGraphSyncAnchor(
  entityType: EntityGraphSyncAnchorType,
  entityId: string
): Promise<EntityGraphSyncOutboxRecord | null> {
  const snapshot = await anchorRef(entityType, entityId).get();
  if (!snapshot.exists) return null;
  const record = parseEntityGraphSyncOutboxRecord(snapshot.id, snapshot.data());
  if (!record) {
    throw new Error(`Malformed entity graph sync anchor for ${entityType} ${entityId}`);
  }
  return record;
}

/** Bounded server-side inventory used by reconciliation to retire settled debt. */
export async function listEntityGraphSyncAnchorsForType(
  entityType: EntityGraphSyncAnchorType
): Promise<EntityGraphSyncOutboxRecord[]> {
  const snapshot = await db
    .collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION)
    .where('entityType', '==', entityType)
    .limit(MAX_RECONCILIATION_ENTITY_GRAPH_SYNC_ANCHORS)
    .get();
  return snapshot.docs.flatMap((document) => {
    const parsed = parseEntityGraphSyncOutboxRecord(document.id, document.data());
    if (!parsed) {
      log.warn('Skipped malformed entity graph sync recovery anchor during reconciliation', {
        entityType,
        anchorId: document.id,
      });
      return [];
    }
    return [parsed];
  });
}

/**
 * Retire an anchor the caller has proven converged.
 *
 * `expectedGeneration` must come from the anchor read *before* the graph write.
 * It is an immutable random token, so two mutations in one millisecond remain
 * distinct and a delayed completion cannot clear a newer debt.
 */
export async function clearConvergedEntityGraphSyncAnchor(
  entityType: EntityGraphSyncAnchorType,
  entityId: string,
  expectedGeneration: string
): Promise<EntityGraphSyncAnchorClearOutcome> {
  const ref = anchorRef(entityType, entityId);
  const outcome = await db.runTransaction<EntityGraphSyncAnchorClearOutcome>(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return 'absent';

    const record = parseEntityGraphSyncOutboxRecord(snapshot.id, snapshot.data());
    if (!record) {
      // A malformed anchor cannot be proven settled, but leaving it forever
      // would strand the entity in a permanently "pending" UI. Removing it is
      // safe: reconciliation repairs from fingerprint drift, not from anchors.
      transaction.delete(ref);
      return 'cleared';
    }

    if (record.generation !== expectedGeneration) return 'superseded';

    transaction.delete(ref);
    return 'cleared';
  });

  if (outcome === 'superseded') {
    log.info('Left a newer graph sync anchor in place after convergence', { entityType, entityId });
  }
  return outcome;
}
