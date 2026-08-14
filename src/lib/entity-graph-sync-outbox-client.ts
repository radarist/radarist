/**
 * @file entity-graph-sync-outbox-client.ts
 * @description Browser-SDK writes for the entity graph-sync recovery anchor.
 *
 * GRAPH-056. The anchor is written from the browser on purpose. A dispatch
 * outage has two shapes — Inngest rejecting the event, and the API route itself
 * being unreachable — and only the browser sits upstream of both. Firestore is
 * provably reachable at that moment, because the entity write just committed
 * through it.
 *
 * Every function here fails soft. The entity mutation has already committed by
 * the time an anchor is written, so throwing would misreport a saved entity as
 * rejected — the exact defect this row exists to fix. A lost anchor costs the
 * in-session retry affordance, not convergence: the version-aware reconciler
 * repairs from fingerprint drift and never consults these records.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  runTransaction,
  setDoc,
} from 'firebase/firestore';
import { createLogger } from '@/lib/logger';
import type { LibraryEntitySyncType } from '@/lib/entity-sync-contract';
import {
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  advanceEntityGraphSyncOutboxRecord,
  buildEntityGraphSyncOutboxRecord,
  entityGraphSyncOutboxDocumentId,
  markEntityGraphSyncOutboxDispatched,
  parseEntityGraphSyncOutboxRecord,
  isLibraryEntitySyncTypeValue,
  type EntityGraphSyncAnchorType,
  type EntityGraphSyncOutboxOperation,
  type EntityGraphSyncOutboxRecord,
} from '@/lib/entity-graph-sync-outbox';

const log = createLogger('entity-graph-sync-outbox-client');

/**
 * Upper bound on anchors read back on mount. Anchors exist only for failed
 * handoffs, so this is a runaway guard rather than a working limit; ordering by
 * `updatedAt` keeps the most recent failures visible if it is ever reached.
 */
export const MAX_REHYDRATED_ANCHORS = 50;

function clientDb() {
  // Every call follows an authenticated entity read/write or a mounted app
  // hook, so the default Firebase app is already initialized. Resolving the
  // singleton here avoids importing the broad bootstrap module back into the
  // entity-sync delivery graph.
  return getFirestore();
}

function anchorRef(entityType: EntityGraphSyncAnchorType, entityId: string) {
  return doc(clientDb(), ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, entityGraphSyncOutboxDocumentId(entityType, entityId));
}

export async function readEntityGraphSyncAnchor(
  entityType: LibraryEntitySyncType,
  entityId: string
): Promise<EntityGraphSyncOutboxRecord | null> {
  try {
    const snapshot = await getDoc(anchorRef(entityType, entityId));
    if (!snapshot.exists()) return null;
    return parseEntityGraphSyncOutboxRecord(snapshot.id, snapshot.data());
  } catch (error) {
    log.warn('Failed to read graph sync recovery anchor', {
      entityType,
      entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Record that a committed mutation's graph handoff was not acknowledged.
 *
 * A fresh failure replaces any existing anchor rather than merging into it: the
 * document now holds new content, so the previous attempt count and error no
 * longer describe the outstanding debt, and an `exhausted` anchor must become
 * retryable again.
 *
 * Accepts every anchor type, not just the eight library entities, because
 * GRAPH-069 routes entity-document link handoffs through the same recorder. The
 * retry helpers below stay library-scoped: they back the in-session Retry
 * affordance, and link anchors are retired server-side by reconciliation.
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
    await setDoc(anchorRef(options.entityType, options.entityId), record);
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
 * Note that a retry reached the queue. Deliberately does not delete the anchor:
 * an acknowledged dispatch is not a completed graph write.
 */
export async function markEntityGraphSyncAnchorDispatched(
  entityType: LibraryEntitySyncType,
  entityId: string,
  expectedGeneration: string
): Promise<EntityGraphSyncOutboxRecord | null> {
  try {
    const ref = anchorRef(entityType, entityId);
    return await runTransaction(clientDb(), async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return null;
      const existing = parseEntityGraphSyncOutboxRecord(snapshot.id, snapshot.data());
      if (!existing || existing.generation !== expectedGeneration) return null;
      const dispatched = markEntityGraphSyncOutboxDispatched(existing);
      transaction.set(ref, dispatched);
      return dispatched;
    });
  } catch (error) {
    log.warn('Failed to stamp graph sync anchor dispatch', {
      entityType,
      entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Advance the attempt count after a retry failed, terminating at the bound. */
export async function advanceEntityGraphSyncAnchor(
  entityType: LibraryEntitySyncType,
  entityId: string,
  expectedGeneration: string,
  error?: unknown
): Promise<EntityGraphSyncOutboxRecord | null> {
  try {
    const ref = anchorRef(entityType, entityId);
    return await runTransaction(clientDb(), async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return null;
      const existing = parseEntityGraphSyncOutboxRecord(snapshot.id, snapshot.data());
      if (!existing || existing.generation !== expectedGeneration) return null;
      const advanced = advanceEntityGraphSyncOutboxRecord(existing, { lastError: error });
      transaction.set(ref, advanced);
      return advanced;
    });
  } catch (writeError) {
    log.warn('Failed to advance graph sync anchor attempt', {
      entityType,
      entityId,
      error: writeError instanceof Error ? writeError.message : String(writeError),
    });
    return null;
  }
}

/**
 * Read back outstanding anchors so a reload reconstructs the pending operation.
 *
 * Filtering by entity type happens in memory: pairing a `where` with the
 * `orderBy` would demand a composite index for a collection that is empty in
 * the healthy case.
 */
export async function listEntityGraphSyncAnchors(
  entityType?: LibraryEntitySyncType
): Promise<Array<EntityGraphSyncOutboxRecord & { entityType: LibraryEntitySyncType }>> {
  try {
    const snapshot = await getDocs(
      query(
        collection(clientDb(), ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION),
        orderBy('updatedAt', 'desc'),
        limit(MAX_REHYDRATED_ANCHORS)
      )
    );
    return snapshot.docs.flatMap((snap) => {
      const record = parseEntityGraphSyncOutboxRecord(snap.id, snap.data());
      if (!record) {
        // Surface corruption rather than rendering a half-parsed anchor.
        log.warn('Skipped malformed graph sync recovery anchor', { anchorId: snap.id });
        return [];
      }
      // The browser recovery UI currently owns the eight library entity
      // mutation surfaces. Document anchors are settled server-side only.
      if (!isLibraryEntitySyncTypeValue(record.entityType)) return [];
      const libraryRecord = record as EntityGraphSyncOutboxRecord & {
        entityType: LibraryEntitySyncType;
      };
      return !entityType || libraryRecord.entityType === entityType ? [libraryRecord] : [];
    });
  } catch (error) {
    log.warn('Failed to load graph sync recovery anchors', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
