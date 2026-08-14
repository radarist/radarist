/**
 * @file relations-core.ts
 * @description CRUD operations, error classes, and shared helpers for Denormalized Relations.
 *
 * Split from relations.ts — contains create, read, update, delete, duplicate check,
 * self-reference check, snapshot update helpers, and batch deletion.
 */

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  where,
  runTransaction,
} from 'firebase/firestore';
import type { Relation, RelationType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import type { EntitySnapshot } from '@/lib/types';
import {
  buildRelationTripleKey,
  buildRelationTripleLockKeyCandidates,
  RELATION_TRIPLE_KEY_VERSION,
  RELATION_TRIPLE_LOCK_COLLECTION,
} from '@/lib/relations-triple-key';
import { isSymmetricRelationType } from '@/lib/relation-symmetry-contract';
import { deleteRelationsWithOwnedLocks, type RelationDeleteTarget } from '@/lib/relations-delete-client';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { assertCanonicalRelationType } from '@/lib/relation-type-contract';
import { requireRelationSyncAcknowledgement } from '@/lib/relation-sync-dispatch';
import { relationDeleteSyncEventId } from '@/lib/relation-sync-outbox';
import {
  resolveCorrelationId,
  type CorrelationContext,
} from '@/lib/observability/correlation';
import {
  createRelationSourceFingerprint,
} from '@/lib/relation-source-version';
import {
  createRelationViaApi,
  deleteRelationViaApi,
  deleteRelationsForEntityViaApi,
  isBrowserRelationClient,
  updateRelationViaApi,
} from '@/lib/relation-api-client';

const log = createLogger('relations');

type RelationCreateData = Omit<
  Relation,
  'id' | 'createdAt' | 'updatedAt' | 'sourceCorrelationId' | 'sourceFingerprint'
>;
type RelationUpdateData = Partial<
  Omit<Relation, 'id' | 'createdAt' | 'sourceCorrelationId' | 'sourceFingerprint'>
>;

function sanitizeRelationMutation<T extends object>(input: T): Omit<T, 'sourceCorrelationId' | 'sourceFingerprint'> {
  const sanitized = { ...sanitizeForFirestore(input) } as Record<string, unknown>;
  delete sanitized.sourceCorrelationId;
  delete sanitized.sourceFingerprint;
  return sanitized as Omit<T, 'sourceCorrelationId' | 'sourceFingerprint'>;
}

export async function triggerRelationSyncSafely(
  relationId: string,
  operation: 'create' | 'update' | 'delete',
  payload?: Record<string, unknown>,
  context: CorrelationContext = {}
): Promise<boolean> {
  // Fire the relation-specific event that syncRelationToNeo4jJob consumes.
  // Historically this routed through triggerEntitySync() which fires the
  // UNIFIED ENTITY sync event — that handler doesn't know how to materialize
  // a relation, so createRelation() calls from scripts/tools landed no Claim
  // and no typed edge. Only the /api/relations/* routes fire the correct
  // event inline; everything else (scripts, direct service-layer calls) was
  // silently syncing to nothing until this change.
  //
  // Call inngest.send() directly rather than safeSendEvent. safeSendEvent
  // guards on NODE_ENV === 'development' which trips tsx scripts (undefined
  // NODE_ENV) into "not configured" and returns false even when
  // INNGEST_DEV_URL is set. Matches the triggerEntitySync pattern in
  // entity-sync.ts.
  //
  // Importing sync-relation-to-neo4j.ts directly (to reach triggerRelationSync)
  // pulls the graph/ subtree into the client bundle and breaks the Next build
  // (proactive-insights -> agent-events -> firebase-admin -> child_process).
  const correlationId = resolveCorrelationId(context.correlationId);
  try {
    const { inngest } = await import('@/lib/inngest/send-client');
    const deleteToken = operation === 'delete' && typeof payload?.deleteToken === 'string'
      ? payload.deleteToken
      : undefined;
    const accepted = await inngest.send({
      ...(deleteToken ? { id: relationDeleteSyncEventId(deleteToken, 0) } : {}),
      name: 'app/relation.sync.requested',
      data: { operation, relationId, ...(payload ?? {}), correlationId },
    });
    return Boolean(accepted.ids?.length);
  } catch {
    return false;
  }
}

/**
 * Checks if a relation already exists between two entities.
 * For symmetric relations, checks both directions.
 *
 * @param sourceId - The source entity ID
 * @param targetId - The target entity ID
 * @param relationType - The type of relation
 * @returns Promise resolving to the existing relation or null
 */
export async function checkDuplicateRelation(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<Relation | null> {
  const isSymmetric = isSymmetricRelationType(relationType);

  // Check for exact match: sourceId -> targetId with same type
  const forwardQuery = query(
    collection(db, 'relations'),
    where('sourceSnapshot.id', '==', sourceId),
    where('targetSnapshot.id', '==', targetId),
    where('relationType', '==', relationType)
  );

  const forwardSnap = await getDocs(forwardQuery);
  if (!forwardSnap.empty) {
    return forwardSnap.docs[0].data() as Relation;
  }

  // For symmetric relations, also check reverse direction
  if (isSymmetric) {
    const reverseQuery = query(
      collection(db, 'relations'),
      where('sourceSnapshot.id', '==', targetId),
      where('targetSnapshot.id', '==', sourceId),
      where('relationType', '==', relationType)
    );

    const reverseSnap = await getDocs(reverseQuery);
    if (!reverseSnap.empty) {
      return reverseSnap.docs[0].data() as Relation;
    }
  }

  return null;
}

/**
 * Fetches all relations from Firestore.
 *
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getRelations(): Promise<Relation[]> {
  const querySnapshot = await getDocs(collection(db, 'relations'));
  return querySnapshot.docs.map((doc) => doc.data() as Relation);
}

/**
 * Fetches a single relation by ID.
 *
 * @param id - The unique identifier of the relation
 * @returns Promise resolving to the Relation object or null if not found
 * @throws Error if Firestore query fails
 */
export async function getRelationById(id: string): Promise<Relation | null> {
  const docRef = doc(db, 'relations', id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as Relation;
  }
  return null;
}

/**
 * Error thrown when attempting to create a duplicate relation.
 */
export class DuplicateRelationError extends Error {
  public readonly existingRelation: Relation;

  constructor(existingRelation: Relation) {
    super(
      `A relation already exists between ${existingRelation.sourceSnapshot.name} and ${existingRelation.targetSnapshot.name} with type "${existingRelation.relationType}"`
    );
    this.name = 'DuplicateRelationError';
    this.existingRelation = existingRelation;
  }
}

/**
 * Error thrown when attempting to create a self-referencing relation.
 */
export class SelfReferenceError extends Error {
  public readonly entityName: string;
  public readonly entityId: string;

  constructor(entityId: string, entityName: string) {
    super(`Cannot create a self-referencing relation: ${entityName} (${entityId}) cannot relate to itself`);
    this.name = 'SelfReferenceError';
    this.entityId = entityId;
    this.entityName = entityName;
  }
}

function mintRelationId(): string {
  return `rel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function updatesRelationTriple(updates: Partial<Omit<Relation, 'id' | 'createdAt'>>): boolean {
  return ['sourceSnapshot', 'targetSnapshot', 'relationType'].some((field) =>
    Object.prototype.hasOwnProperty.call(updates, field)
  );
}

function rawRelationTopologyKey(relation: Pick<Relation, 'sourceSnapshot' | 'targetSnapshot' | 'relationType'>): string {
  return JSON.stringify([
    relation.relationType,
    relation.sourceSnapshot.id,
    relation.targetSnapshot.id,
  ]);
}

async function findDuplicateRelationIds(
  relationId: string,
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<string[]> {
  const queries = [
    query(
      collection(db, 'relations'),
      where('sourceSnapshot.id', '==', sourceId),
      where('targetSnapshot.id', '==', targetId),
      where('relationType', '==', relationType)
    ),
  ];
  if (isSymmetricRelationType(relationType)) {
    queries.push(
      query(
        collection(db, 'relations'),
        where('sourceSnapshot.id', '==', targetId),
        where('targetSnapshot.id', '==', sourceId),
        where('relationType', '==', relationType)
      )
    );
  }

  const snapshots = await Promise.all(queries.map((candidateQuery) => getDocs(candidateQuery)));
  return [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.docs.flatMap((relationDoc) => {
          const data = relationDoc.data() as Relation;
          const candidateId = relationDoc.id || data.id;
          return candidateId && candidateId !== relationId ? [candidateId] : [];
        })
      )
    ),
  ].sort();
}

function assertNotSelfReferencing(relation: Relation): void {
  const sourceName = relation.sourceSnapshot.name.toLowerCase().trim();
  const targetName = relation.targetSnapshot.name.toLowerCase().trim();
  const sameType = relation.sourceSnapshot.type === relation.targetSnapshot.type;

  if (
    relation.sourceSnapshot.id === relation.targetSnapshot.id ||
    (sameType && sourceName === targetName)
  ) {
    throw new SelfReferenceError(relation.sourceSnapshot.id, relation.sourceSnapshot.name);
  }
}

/**
 * Creates the relation INSIDE a Firestore transaction serialized on a
 * deterministic "triple lock" doc (LIVE-2 fix).
 *
 * The plain query-based `checkDuplicateRelation` fast path above is only an
 * optimization — two concurrent callers can both pass it before either write
 * lands (classic check-then-create TOCTOU). This transaction is the
 * AUTHORITY: Firestore serializes any two transactions that touch the same
 * lock doc, so the loser retries, sees the lock, and throws
 * `DuplicateRelationError` instead of minting a second edge for the same
 * triple.
 *
 * Lock takeover: if the lock doc exists but the relation it points to was
 * deleted since, this takes over the stale lock and proceeds with the
 * create — a leaked/stale lock must never permanently block re-creation.
 *
 * @throws DuplicateRelationError if a concurrent transaction already
 *   committed this exact triple
 */
async function createRelationWithTripleLock(
  relationData: RelationCreateData,
  sourceCorrelationId: string,
  sourceFingerprint: string
): Promise<Relation> {
  const tripleKey = buildRelationTripleKey(
    relationData.sourceSnapshot.id,
    relationData.targetSnapshot.id,
    relationData.relationType
  );
  const lockRefs = buildRelationTripleLockKeyCandidates(
    relationData.sourceSnapshot.id,
    relationData.targetSnapshot.id,
    relationData.relationType
  ).map((key) => ({ key, ref: doc(db, RELATION_TRIPLE_LOCK_COLLECTION, key) }));
  const lockRef = lockRefs[0].ref;

  return runTransaction(db, async (tx) => {
    for (let index = 0; index < lockRefs.length; index += 1) {
      const lockSnap = await tx.get(lockRefs[index].ref);
      if (!lockSnap?.exists()) continue;
      const lockData = lockSnap.data() as { relationId?: string };
      if (!lockData.relationId) continue;
      const existingRelationSnap = await tx.get(doc(db, 'relations', lockData.relationId));
      if (!existingRelationSnap.exists()) continue;
      const existing = existingRelationSnap.data() as Relation;
      const currentKey = buildRelationTripleKey(
        existing.sourceSnapshot.id,
        existing.targetSnapshot.id,
        existing.relationType
      );
      if (lockRefs[index].key === tripleKey || currentKey === tripleKey) {
        throw new DuplicateRelationError(existing);
      }
      // A v1 slash-replacement collision can point at an unrelated live row.
      // It is neither overwritten nor treated as a duplicate.
    }

    const id = mintRelationId();
    const now = Date.now();
    const relation: Relation = {
      id,
      ...relationData,
      sourceCorrelationId,
      sourceFingerprint,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(lockRef, {
      relationId: id,
      sourceId: relationData.sourceSnapshot.id,
      targetId: relationData.targetSnapshot.id,
      relationType: relationData.relationType,
      createdAt: now,
      keyVersion: RELATION_TRIPLE_KEY_VERSION,
    });
    // Uses tx.set (not entity-factory) — relation record with denormalized snapshots, no slug needed.
    tx.set(doc(db, 'relations', id), relation);

    return relation;
  });
}

/**
 * Creates a new relation in Firestore with entity snapshots.
 * Automatically generates an ID and timestamps.
 * By default, checks for duplicate relations and throws DuplicateRelationError if found.
 *
 * @param relationData - The relation data without system-managed fields
 * @param options - Optional creation options
 * @returns Promise resolving to the newly created Relation object
 * @throws DuplicateRelationError if a similar relation already exists
 * @throws Error if Firestore operation fails
 */
export async function createRelation(
  relationData: RelationCreateData
): Promise<Relation> {
  assertCanonicalRelationType(relationData.relationType);
  if (isBrowserRelationClient()) return createRelationViaApi(relationData);
  const sourceCorrelationId = resolveCorrelationId();
  const sanitizedRelationData = sanitizeRelationMutation(relationData);

  // Fast-path idempotency guard: a plain query is cheap and catches the
  // common (non-concurrent) case without paying for a transaction
  // round-trip. This is an OPTIMIZATION, not the guarantee — the
  // transactional triple lock below is the authority that actually closes
  // the check-then-create race (LIVE-2). This also prevents races when both
  // the agent and Inngest sync try to create the same relation concurrently.
  const existing = await checkDuplicateRelation(
    sanitizedRelationData.sourceSnapshot.id,
    sanitizedRelationData.targetSnapshot.id,
    sanitizedRelationData.relationType
  );

  if (existing) {
    log.debug('Relation already exists, skipping create (idempotency guard)', {
      sourceId: sanitizedRelationData.sourceSnapshot.id,
      targetId: sanitizedRelationData.targetSnapshot.id,
      type: sanitizedRelationData.relationType,
      existingId: existing.id,
    });
    // Preserve API retry convergence after route-level duplicate dispatch
    // was removed. Refresh the authoritative source version from the latest
    // committed row, then emit one post-commit resync with the same pair.
    return updateRelation(existing.id, {}, { correlationId: sourceCorrelationId });
  }

  const sourceId = sanitizedRelationData.sourceSnapshot.id;
  const targetId = sanitizedRelationData.targetSnapshot.id;
  const sourceName = sanitizedRelationData.sourceSnapshot.name.toLowerCase().trim();
  const targetName = sanitizedRelationData.targetSnapshot.name.toLowerCase().trim();
  const sameType = sanitizedRelationData.sourceSnapshot.type === sanitizedRelationData.targetSnapshot.type;

  // Self-relations are invalid graph data, so no internal bypass is exposed.
  if (sourceId === targetId || (sameType && sourceName === targetName)) {
    throw new SelfReferenceError(sourceId, sanitizedRelationData.sourceSnapshot.name);
  }

  const sourceFingerprint = await createRelationSourceFingerprint(sanitizedRelationData);
  const relation = await createRelationWithTripleLock(
    sanitizedRelationData,
    sourceCorrelationId,
    sourceFingerprint
  );

  log.info('Created relation in Firestore', {
    id: relation.id,
    sourceName: relation.sourceSnapshot.name,
    targetName: relation.targetSnapshot.name,
  });

  // Require a Neo4j handoff acknowledgement OUTSIDE
  // the transaction: Firestore may retry the transaction callback on
  // contention, and a side effect like an Inngest send must fire exactly
  // once per successful commit, not once per retry attempt. The committed
  // Firestore row remains the retry anchor if this handoff is not acknowledged.
  const syncTriggered = await triggerRelationSyncSafely(relation.id, 'create', {
    sourceId: relation.sourceSnapshot.id,
    sourceType: relation.sourceSnapshot.type,
    sourceName: relation.sourceSnapshot.name,
    targetId: relation.targetSnapshot.id,
    targetType: relation.targetSnapshot.type,
    targetName: relation.targetSnapshot.name,
    relationType: relation.relationType,
    confidence: relation.confidence,
    notes: relation.notes,
    aiSuggested: relation.aiSuggested,
    claimStatus: relation.claimStatus,
    sourceFingerprint: relation.sourceFingerprint,
  }, { correlationId: sourceCorrelationId });
  requireRelationSyncAcknowledgement(syncTriggered, relation.id, 'create');
  log.info('Triggered Neo4j sync for relation', { id: relation.id });

  return relation;
}

/**
 * Updates an existing relation in Firestore.
 *
 * @param id - The relation ID to update
 * @param updates - Partial relation data to update
 * @returns Promise resolving to the updated Relation object
 * @throws Error if relation not found or Firestore operation fails
 */
export async function updateRelation(
  id: string,
  updates: RelationUpdateData,
  context: CorrelationContext = {}
): Promise<Relation> {
  if (isBrowserRelationClient()) return updateRelationViaApi(id, updates);
  const sourceCorrelationId = resolveCorrelationId(context.correlationId);
  const docRef = doc(db, 'relations', id);
  if (Object.prototype.hasOwnProperty.call(updates, 'relationType')) {
    assertCanonicalRelationType(updates.relationType);
  }
  const sanitizedUpdates = sanitizeRelationMutation(updates);
  let updatedRelation: Relation;

  if (updatesRelationTriple(sanitizedUpdates)) {
    const preflightSnap = await getDoc(docRef);
    if (!preflightSnap.exists()) {
      throw new Error(`Relation with id ${id} not found`);
    }
    const preflightExisting = preflightSnap.data() as Relation;
    const preflightNext: Relation = { ...preflightExisting, ...sanitizedUpdates };
    assertNotSelfReferencing(preflightNext);
    const preflightTopologyKey = rawRelationTopologyKey(preflightExisting);
    // Legacy rows may predate triple locks. Query their document IDs first,
    // then re-read those exact rows inside the write transaction. Normal
    // concurrent creates are still serialized by the destination v2 lock.
    const duplicateRelationIds = await findDuplicateRelationIds(
      id,
      preflightNext.sourceSnapshot.id,
      preflightNext.targetSnapshot.id,
      preflightNext.relationType
    );

    updatedRelation = await runTransaction(db, async (tx) => {
      const relationSnap = await tx.get(docRef);
      if (!relationSnap.exists()) {
        throw new Error(`Relation with id ${id} not found`);
      }

      const existing = relationSnap.data() as Relation;
      if (rawRelationTopologyKey(existing) !== preflightTopologyKey) {
        throw new Error(`Relation topology changed while updating ${id}; retry the operation`);
      }
      const updatedAt = Date.now();
      const projectionNext: Relation = { ...existing, ...sanitizedUpdates, updatedAt };
      assertNotSelfReferencing(projectionNext);
      const sourceFingerprint = await createRelationSourceFingerprint(projectionNext);
      const next: Relation = {
        ...projectionNext,
        sourceCorrelationId,
        sourceFingerprint,
      };

      const newTripleKey = buildRelationTripleKey(
        next.sourceSnapshot.id,
        next.targetSnapshot.id,
        next.relationType
      );
      const oldKeys = buildRelationTripleLockKeyCandidates(
        existing.sourceSnapshot.id,
        existing.targetSnapshot.id,
        existing.relationType
      );
      const newKeys = buildRelationTripleLockKeyCandidates(
        next.sourceSnapshot.id,
        next.targetSnapshot.id,
        next.relationType
      );
      const duplicateRefs = duplicateRelationIds.map((duplicateId) =>
        doc(db, 'relations', duplicateId)
      );
      const duplicateSnaps = await Promise.all(duplicateRefs.map((ref) => tx.get(ref)));
      for (const duplicateSnap of duplicateSnaps) {
        if (!duplicateSnap.exists()) continue;
        const duplicate = duplicateSnap.data() as Relation;
        const duplicateKey = buildRelationTripleKey(
          duplicate.sourceSnapshot.id,
          duplicate.targetSnapshot.id,
          duplicate.relationType
        );
        if (duplicateKey === newTripleKey) {
          throw new DuplicateRelationError(duplicate);
        }
      }
      const oldTripleKey = oldKeys[0];
      const lockRefs = new Map(
        [...new Set([oldTripleKey, newTripleKey, ...oldKeys.slice(1), ...newKeys.slice(1)])].map((key) => [
          key,
          doc(db, RELATION_TRIPLE_LOCK_COLLECTION, key),
        ])
      );
      const lockEntries = [...lockRefs.entries()];
      const lockSnaps = await Promise.all(lockEntries.map(([, ref]) => tx.get(ref)));

      for (const key of newKeys) {
        const index = lockEntries.findIndex(([candidate]) => candidate === key);
        const lockSnap = lockSnaps[index];
        if (!lockSnap?.exists()) continue;
        const owner = (lockSnap.data() as { relationId?: string }).relationId;
        if (!owner || owner === id) continue;
        const duplicateSnap = await tx.get(doc(db, 'relations', owner));
        if (!duplicateSnap.exists()) continue;
        const duplicate = duplicateSnap.data() as Relation;
        const duplicateKey = buildRelationTripleKey(
          duplicate.sourceSnapshot.id,
          duplicate.targetSnapshot.id,
          duplicate.relationType
        );
        if (key === newTripleKey || duplicateKey === newTripleKey) {
          throw new DuplicateRelationError(duplicate);
        }
      }

      tx.update(docRef, {
        ...sanitizedUpdates,
        sourceCorrelationId,
        sourceFingerprint,
        updatedAt,
      });
      tx.set(lockRefs.get(newTripleKey)!, {
        relationId: id,
        sourceId: next.sourceSnapshot.id,
        targetId: next.targetSnapshot.id,
        relationType: next.relationType,
        createdAt: next.createdAt,
        keyVersion: RELATION_TRIPLE_KEY_VERSION,
      });
      for (let index = 0; index < lockEntries.length; index += 1) {
        const [key, ref] = lockEntries[index];
        if (key === newTripleKey || !lockSnaps[index]?.exists()) continue;
        if ((lockSnaps[index].data() as { relationId?: string }).relationId === id) {
          tx.delete(ref);
        }
      }

      return next;
    });
  } else {
    updatedRelation = await runTransaction(db, async (tx) => {
      const relationSnap = await tx.get(docRef);
      if (!relationSnap.exists()) {
        throw new Error(`Relation with id ${id} not found`);
      }
      const updatedAt = Date.now();
      const projectionNext: Relation = {
        ...(relationSnap.data() as Relation),
        ...sanitizedUpdates,
        updatedAt,
      };
      const sourceFingerprint = await createRelationSourceFingerprint(projectionNext);
      const relation: Relation = {
        ...projectionNext,
        sourceCorrelationId,
        sourceFingerprint,
      };
      tx.update(docRef, {
        ...sanitizedUpdates,
        sourceCorrelationId,
        sourceFingerprint,
        updatedAt,
      });
      return relation;
    });
  }

  // Surface an unacknowledged handoff after the committed update so callers
  // retry the same idempotent operation instead of reporting false convergence.
  const syncTriggered = await triggerRelationSyncSafely(id, 'update', {
    sourceId: updatedRelation.sourceSnapshot.id,
    sourceType: updatedRelation.sourceSnapshot.type,
    sourceName: updatedRelation.sourceSnapshot.name,
    targetId: updatedRelation.targetSnapshot.id,
    targetType: updatedRelation.targetSnapshot.type,
    targetName: updatedRelation.targetSnapshot.name,
    relationType: updatedRelation.relationType,
    confidence: updatedRelation.confidence,
    notes: updatedRelation.notes,
    aiSuggested: updatedRelation.aiSuggested,
    claimStatus: updatedRelation.claimStatus,
    sourceFingerprint: updatedRelation.sourceFingerprint,
  }, { correlationId: sourceCorrelationId });
  requireRelationSyncAcknowledgement(syncTriggered, id, 'update');
  log.info('Triggered Neo4j sync for relation update', { id });

  return updatedRelation;
}

/**
 * Updates the source snapshot of a relation.
 * Used when the source entity changes.
 *
 * @param relationId - The relation ID to update
 * @param newSnapshot - The new source snapshot
 * @returns Promise resolving when update is complete
 * @throws Error if relation not found or Firestore operation fails
 */
export async function updateSourceSnapshot(relationId: string, newSnapshot: EntitySnapshot): Promise<void> {
  await updateRelation(relationId, {
    sourceSnapshot: newSnapshot,
  });
}

/**
 * Updates the target snapshot of a relation.
 * Used when the target entity changes.
 *
 * @param relationId - The relation ID to update
 * @param newSnapshot - The new target snapshot
 * @returns Promise resolving when update is complete
 * @throws Error if relation not found or Firestore operation fails
 */
export async function updateTargetSnapshot(relationId: string, newSnapshot: EntitySnapshot): Promise<void> {
  await updateRelation(relationId, {
    targetSnapshot: newSnapshot,
  });
}

/**
 * Deletes a relation from Firestore.
 *
 * The relation and its currently owned triple lock are deleted in one
 * transaction. Re-reading topology and ownership inside that transaction
 * prevents a concurrent relation edit or lock takeover from orphaning or
 * deleting the wrong lock.
 *
 * @param id - The relation ID to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if Firestore operation fails
 */
export async function deleteRelation(id: string): Promise<void> {
  if (isBrowserRelationClient()) return deleteRelationViaApi(id);
  const correlationId = resolveCorrelationId();
  await deleteRelationsWithOwnedLocks(db, [{ id }], {
    correlationId,
    onChunkDeleted: async (_ids, dispatches) => {
      const [{ deleteToken }] = dispatches;
      const syncTriggered = await triggerRelationSyncSafely(id, 'delete', { deleteToken }, { correlationId });
      requireRelationSyncAcknowledgement(syncTriggered, id, 'delete');
      log.info('Triggered Neo4j delete sync for relation', { id });
    },
  });
}

/**
 * Deletes a relation between two specific entities with a specific type.
 * Handles symmetric relations by checking both directions.
 *
 * @param sourceId - The source entity ID
 * @param targetId - The target entity ID
 * @param relationType - The relation type
 * @returns Promise resolving to the deleted relation ID, or null if not found
 * @throws Error if Firestore operation fails
 */
export async function deleteRelationBetween(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<string | null> {
  assertCanonicalRelationType(relationType);
  // Find the existing relation (handles symmetric relations automatically)
  const existing = await checkDuplicateRelation(sourceId, targetId, relationType);

  if (!existing) {
    log.warn('No relation found between and of type', { sourceId, targetId, relationType });
    return null;
  }

  // Delete the relation
  await deleteRelation(existing.id);
  log.info('Deleted relation between and', { id: existing.id, sourceId, targetId });

  return existing.id;
}

/**
 * Deletes all relations where the given entity is either source or target.
 * Used for cascade cleanup when deleting entities.
 *
 * @param entityId - The entity ID to delete relations for
 * @returns Promise resolving to the number of relations deleted
 * @throws Error if Firestore operation fails
 */
export async function deleteRelationsForEntity(entityId: string): Promise<number> {
  if (isBrowserRelationClient()) return deleteRelationsForEntityViaApi(entityId);
  // Find relations where entity is source
  const sourceQuery = query(collection(db, 'relations'), where('sourceSnapshot.id', '==', entityId));

  // Find relations where entity is target
  const targetQuery = query(collection(db, 'relations'), where('targetSnapshot.id', '==', entityId));

  const [sourceSnap, targetSnap] = await Promise.all([getDocs(sourceQuery), getDocs(targetQuery)]);

  const uniqueIds = [...new Set([...sourceSnap.docs, ...targetSnap.docs].map((relationDoc) => relationDoc.id))];

  if (uniqueIds.length === 0) return 0;

  const targets: RelationDeleteTarget[] = uniqueIds.map((id) => ({ id }));
  const correlationId = resolveCorrelationId();
  const deletedIds = await deleteRelationsWithOwnedLocks(db, targets, {
    correlationId,
    // Fan out immediately after every committed chunk. If a later transaction
    // fails, already-deleted Firestore rows do not remain live in Neo4j.
    onChunkDeleted: async (ids, dispatches) => {
      const acknowledgements = await Promise.all(
        dispatches.map(({ relationId, deleteToken }) =>
          triggerRelationSyncSafely(relationId, 'delete', { deleteToken }, { correlationId })
        )
      );
      acknowledgements.forEach((acknowledged, index) =>
        requireRelationSyncAcknowledgement(acknowledged, ids[index], 'delete')
      );
    },
  });

  const deleted = deletedIds.length;

  log.info('Deleted relations for entity (Neo4j delete sync triggered)', { entityId, deleted });

  return deleted;
}
