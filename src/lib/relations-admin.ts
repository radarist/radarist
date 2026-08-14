/**
 * @file relations-admin.ts
 * @description Admin-SDK twin of the relations service for SERVER-side callers.
 *
 * WHY: `relations-core.ts`, `relations-queries.ts`, and `relations-validation.ts`
 * are all CLIENT-SDK modules (they use `db` from `@/lib/firebase` +
 * `firebase/firestore`). When the relation CRUD is invoked server-side — AI-chat
 * tool executors (`assertions-tools`, `linker-tools`, `enrichment`,
 * `document-tools`, `entity-creation`) and the `/api/relations/*` routes — the
 * client SDK either throws `FIRESTORE INTERNAL ASSERTION FAILED a540` (poisoning
 * the in-process client) or fails with `code: 'unavailable'` because it can't
 * hold a persistent connection in a stateless serverless context.
 *
 * This module reproduces the relation service's behavior EXACTLY via the Admin
 * SDK while honoring the Relation Write Contract:
 *  - same `rel-<ts>-<rand>` id format, same `createdAt`/`updatedAt` audit fields
 *  - same idempotency guard (checkDuplicateRelation), same symmetric-direction
 *    handling, same SelfReferenceError / DuplicateRelationError semantics
 *  - same post-commit Inngest event (`app/relation.sync.requested`) with the
 *    SAME payload the client `createRelation`/`updateRelation`/`deleteRelation`
 *    fires, so the sync handler picks the correct Class A/B/C write path
 *  - same `createRelationFromIds` snapshot-building flow, mirrored against admin
 *    reads of the appropriate Firestore collection
 *
 * The error classes (DuplicateRelationError, SelfReferenceError) and the
 * CreateRelationInput type is imported from the
 * client modules so the two paths can NEVER drift. Importing those modules
 * pulls in the client `db` proxy at module-load, but that only runs
 * initializeApp — getFirestore() is never called here (this file talks to the
 * admin `db`), so no a540. This matches the entity-factory-admin pattern.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { Relation, RelationType, EntityType, EntitySnapshot } from '@/lib/types';
import { safeResolve, needsResolution } from '@/lib/migration';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { DuplicateRelationError, SelfReferenceError } from '@/lib/relations-core';
import type { CreateRelationInput, CleanupOrphanedRelationsResult } from '@/lib/relations-validation';
import {
  buildRelationTripleKey,
  buildRelationTripleLockKeyCandidates,
  RELATION_TRIPLE_KEY_VERSION,
  RELATION_TRIPLE_LOCK_COLLECTION,
} from '@/lib/relations-triple-key';
import { isSymmetricRelationType } from '@/lib/relation-symmetry-contract';
import { adminDeleteRelationsWithOwnedLocks } from '@/lib/relations-delete-admin';
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
  resolveRelationSourceFingerprint,
} from '@/lib/relation-source-version';

const log = createLogger('relations-admin');

type RelationCreateData = Omit<
  Relation,
  'id' | 'createdAt' | 'updatedAt' | 'sourceCorrelationId' | 'sourceFingerprint'
>;
type RelationUpdateData = Partial<
  Omit<Relation, 'id' | 'createdAt' | 'sourceCorrelationId' | 'sourceFingerprint'>
>;
type RelationFreshUpdateData = Partial<
  Omit<Relation, 'id' | 'createdAt' | 'updatedAt' | 'sourceCorrelationId' | 'sourceFingerprint'>
>;

function sanitizeRelationMutation<T extends object>(input: T): Omit<T, 'sourceCorrelationId' | 'sourceFingerprint'> {
  const sanitized = { ...sanitizeForFirestore(input) } as Record<string, unknown>;
  delete sanitized.sourceCorrelationId;
  delete sanitized.sourceFingerprint;
  return sanitized as Omit<T, 'sourceCorrelationId' | 'sourceFingerprint'>;
}

/** Re-export the typed errors + input types so admin callers import from one place. */
export { DuplicateRelationError, SelfReferenceError };
export type { CreateRelationInput, CleanupOrphanedRelationsResult };

// adminCleanupOrphanedRelations resolves an EntityType to its Firestore
// collection via the canonical ENTITY_COLLECTIONS map imported at the top of
// this file — the SAME map entity-factory derives its collection config from.
// This previously had a hand-maintained copy with `useCases`/`orgUnits`
// spellings that did NOT match the factory's `use-cases`/`org-units`, so the
// nightly cleanup deleted every valid relation touching an app-created use case
// or org unit.

/**
 * Fire the relation-specific Neo4j sync event the client service fires.
 * Mirrors triggerRelationSyncSafely in relations-core.ts. The boolean is false
 * for a rejected send and for the kill-switch's empty acknowledgement.
 */
async function triggerRelationSyncSafely(
  relationId: string,
  operation: 'create' | 'update' | 'delete',
  payload?: Record<string, unknown>,
  context: CorrelationContext = {}
): Promise<boolean> {
  const correlationId = resolveCorrelationId(context.correlationId);
  try {
    const { inngest } = await import('@/lib/inngest/client');
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

async function triggerRelationUpdateSyncSafely(
  relation: Relation,
  context: CorrelationContext = {}
): Promise<void> {
  const correlationId = resolveCorrelationId(relation.sourceCorrelationId ?? context.correlationId);
  const sourceFingerprint = resolveRelationSourceFingerprint(relation.sourceFingerprint);
  const syncTriggered = await triggerRelationSyncSafely(relation.id, 'update', {
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
    // B1: observability parity only -- the sync handler re-reads Firestore.
    agentName: relation.agentName,
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
  }, { correlationId });
  requireRelationSyncAcknowledgement(syncTriggered, relation.id, 'update');
  if (syncTriggered) {
    log.info('Triggered Neo4j sync for relation update', { id: relation.id });
  }
}

/**
 * Admin-SDK equivalent of `relations-core.checkDuplicateRelation`.
 * For symmetric relations, checks both directions.
 */
export async function adminCheckDuplicateRelation(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<Relation | null> {
  const isSymmetric = isSymmetricRelationType(relationType);

  const forwardSnap = await db
    .collection('relations')
    .where('sourceSnapshot.id', '==', sourceId)
    .where('targetSnapshot.id', '==', targetId)
    .where('relationType', '==', relationType)
    .get();
  if (!forwardSnap.empty) {
    return forwardSnap.docs[0].data() as Relation;
  }

  if (isSymmetric) {
    const reverseSnap = await db
      .collection('relations')
      .where('sourceSnapshot.id', '==', targetId)
      .where('targetSnapshot.id', '==', sourceId)
      .where('relationType', '==', relationType)
      .get();
    if (!reverseSnap.empty) {
      return reverseSnap.docs[0].data() as Relation;
    }
  }

  return null;
}

/**
 * Admin-SDK equivalent of `relations-core.getRelationById`.
 * Returns the Relation or null if not found.
 */
export async function adminGetRelationById(id: string): Promise<Relation | null> {
  const snap = await db.collection('relations').doc(id).get();
  if (snap.exists) {
    return snap.data() as Relation;
  }
  return null;
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

async function adminFindDuplicateRelationIds(
  relationId: string,
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<string[]> {
  const queryFor = (source: string, target: string) =>
    db
      .collection('relations')
      .where('sourceSnapshot.id', '==', source)
      .where('targetSnapshot.id', '==', target)
      .where('relationType', '==', relationType)
      .get();
  const snapshots = await Promise.all([
    queryFor(sourceId, targetId),
    ...(isSymmetricRelationType(relationType) ? [queryFor(targetId, sourceId)] : []),
  ]);
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
 * Admin-SDK equivalent of the client's `createRelationWithTripleLock`
 * (relations-core.ts). Serializes duplicate-check + create on a deterministic
 * "triple lock" doc via `db.runTransaction` so two concurrent admin-side
 * creates (or a client-side create racing an admin-side one, since both
 * twins share the same `buildRelationTripleKey`) for the SAME triple can
 * never both win (LIVE-2 fix — the live-verified race that minted twin
 * Assertions for one AI-tool call).
 *
 * @throws DuplicateRelationError if a concurrent transaction already
 *   committed this exact triple
 */
async function adminCreateRelationWithTripleLock(
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
  ).map((key) => ({ key, ref: db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(key) }));
  const lockRef = lockRefs[0].ref;

  return db.runTransaction(async (tx) => {
    for (let index = 0; index < lockRefs.length; index += 1) {
      const lockSnap = await tx.get(lockRefs[index].ref);
      if (!lockSnap?.exists) continue;
      const lockData = lockSnap.data() as { relationId?: string } | undefined;
      if (!lockData?.relationId) continue;
      const existingRelationSnap = await tx.get(db.collection('relations').doc(lockData.relationId));
      if (!existingRelationSnap.exists) continue;
      const existing = existingRelationSnap.data() as Relation;
      const currentKey = buildRelationTripleKey(
        existing.sourceSnapshot.id,
        existing.targetSnapshot.id,
        existing.relationType
      );
      if (lockRefs[index].key === tripleKey || currentKey === tripleKey) {
        throw new DuplicateRelationError(existing);
      }
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
    // Denormalized relation record with snapshots — no slug, no entity-factory.
    tx.set(db.collection('relations').doc(id), relation);

    return relation;
  });
}

/**
 * Admin-SDK equivalent of `relations-core.createRelation`.
 *
 * Preserves the EXACT contract:
 *  - idempotency guard via adminCheckDuplicateRelation (returns existing on hit)
 *  - self-reference check (by id, or by same-type + same-name) → SelfReferenceError
 *  - `rel-<ts>-<rand>` id, createdAt/updatedAt audit fields
 *  - setDoc-equivalent write (no entity-factory — relations are denormalized,
 *    no slug needed)
 *  - fires `app/relation.sync.requested` with the same `create` payload so the
 *    sync handler selects the correct Class A/B/C write path
 *
 * LIVE-2: the actual write now happens inside `adminCreateRelationWithTripleLock`
 * (a transaction), which is the AUTHORITY that closes the check-then-create
 * race. `adminCheckDuplicateRelation` above stays as a cheap fast-path
 * optimization for the common non-concurrent case.
 *
 * @throws SelfReferenceError for self-referencing relations
 * @throws DuplicateRelationError if a concurrent transaction already
 *   committed this exact triple
 */
export async function adminCreateRelation(
  relationData: RelationCreateData,
  context: CorrelationContext = {}
): Promise<Relation> {
  const sourceCorrelationId = resolveCorrelationId(context.correlationId);
  const correlationContext = { correlationId: sourceCorrelationId };
  assertCanonicalRelationType(relationData.relationType);
  const sanitizedRelationData = sanitizeRelationMutation(relationData);

  // Idempotency guard — return existing instead of creating a duplicate.
  const existing = await adminCheckDuplicateRelation(
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
    // A retry may be the recovery path for an earlier unacknowledged sync
    // failure. Refresh the authoritative source version from the latest row
    // in a transaction, then let the update service emit the single
    // post-commit resync request with that exact correlation/fingerprint pair.
    return adminUpdateRelation(existing.id, {}, correlationContext);
  }

  const sourceId = sanitizedRelationData.sourceSnapshot.id;
  const targetId = sanitizedRelationData.targetSnapshot.id;
  const sourceName = sanitizedRelationData.sourceSnapshot.name.toLowerCase().trim();
  const targetName = sanitizedRelationData.targetSnapshot.name.toLowerCase().trim();
  const sameType = sanitizedRelationData.sourceSnapshot.type === sanitizedRelationData.targetSnapshot.type;

  if (sourceId === targetId || (sameType && sourceName === targetName)) {
    throw new SelfReferenceError(sourceId, sanitizedRelationData.sourceSnapshot.name);
  }

  const sourceFingerprint = await createRelationSourceFingerprint(sanitizedRelationData);
  const relation = await adminCreateRelationWithTripleLock(
    sanitizedRelationData,
    sourceCorrelationId,
    sourceFingerprint
  );

  log.info('Created relation in Firestore', {
    id: relation.id,
    sourceName: relation.sourceSnapshot.name,
    targetName: relation.targetSnapshot.name,
  });

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
    // B1: observability parity only — the sync handler re-reads the real
    // value from the Firestore doc for create/update.
    agentName: relation.agentName,
    sourceFingerprint: relation.sourceFingerprint,
  }, correlationContext);
  requireRelationSyncAcknowledgement(syncTriggered, relation.id, 'create');
  log.info('Triggered Neo4j sync for relation', { id: relation.id });

  return relation;
}

/**
 * Admin-SDK equivalent of `relations-core.updateRelation`.
 * Reads the doc, applies updates + updatedAt, re-reads, then fires the same
 * `update` sync payload the client fires.
 *
 * @throws Error if relation not found
 */
export async function adminUpdateRelation(
  id: string,
  updates: RelationUpdateData,
  context: CorrelationContext = {}
): Promise<Relation> {
  const sourceCorrelationId = resolveCorrelationId(context.correlationId);
  const correlationContext = { correlationId: sourceCorrelationId };
  const docRef = db.collection('relations').doc(id);
  if (Object.prototype.hasOwnProperty.call(updates, 'relationType')) {
    assertCanonicalRelationType(updates.relationType);
  }
  const sanitizedUpdates = sanitizeRelationMutation(updates);
  let updatedRelation: Relation;

  if (updatesRelationTriple(sanitizedUpdates)) {
    const preflightSnap = await docRef.get();
    if (!preflightSnap.exists) {
      throw new Error(`Relation with id ${id} not found`);
    }
    const preflightExisting = preflightSnap.data() as Relation;
    const preflightNext: Relation = { ...preflightExisting, ...sanitizedUpdates };
    assertNotSelfReferencing(preflightNext);
    const preflightTopologyKey = rawRelationTopologyKey(preflightExisting);
    // Legacy rows may predate triple locks. Query their document IDs first,
    // then re-read those exact rows inside the write transaction. Normal
    // concurrent creates are still serialized by the destination v2 lock.
    const duplicateRelationIds = await adminFindDuplicateRelationIds(
      id,
      preflightNext.sourceSnapshot.id,
      preflightNext.targetSnapshot.id,
      preflightNext.relationType
    );

    updatedRelation = await db.runTransaction(async (tx) => {
      const relationSnap = await tx.get(docRef);
      if (!relationSnap.exists) {
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
        db.collection('relations').doc(duplicateId)
      );
      const duplicateSnaps = await Promise.all(duplicateRefs.map((ref) => tx.get(ref)));
      for (const duplicateSnap of duplicateSnaps) {
        if (!duplicateSnap.exists) continue;
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
          db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(key),
        ])
      );
      const lockEntries = [...lockRefs.entries()];
      const lockSnaps = await Promise.all(lockEntries.map(([, ref]) => tx.get(ref)));

      for (const key of newKeys) {
        const index = lockEntries.findIndex(([candidate]) => candidate === key);
        const lockSnap = lockSnaps[index];
        if (!lockSnap?.exists) continue;
        const owner = (lockSnap.data() as { relationId?: string } | undefined)?.relationId;
        if (!owner || owner === id) continue;
        const duplicateSnap = await tx.get(db.collection('relations').doc(owner));
        if (!duplicateSnap.exists) continue;
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
        if (key === newTripleKey || !lockSnaps[index]?.exists) continue;
        if ((lockSnaps[index].data() as { relationId?: string } | undefined)?.relationId === id) {
          tx.delete(ref);
        }
      }

      return next;
    });
  } else {
    updatedRelation = await db.runTransaction(async (tx) => {
      const relationSnap = await tx.get(docRef);
      if (!relationSnap.exists) {
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

  await triggerRelationUpdateSyncSafely(updatedRelation, correlationContext);

  return updatedRelation;
}

/**
 * Applies a metadata-only update derived from the latest committed Relation.
 * Firestore may retry the callback, so `deriveUpdates` must be deterministic
 * and side-effect free. Returning `null` records an idempotent no-op.
 *
 * This is intentionally separate from `adminUpdateRelation`: callers that
 * merge bounded sets (for example proposal provenance) cannot safely compute
 * an update from a relation snapshot read before a concurrent approval. The
 * fresh read and write happen in one transaction, while the normal Neo4j sync
 * event is still emitted after a changed transaction commits.
 *
 * Topology edits are rejected here because they require the triple-lock
 * migration performed by `adminUpdateRelation`.
 */
export async function adminUpdateRelationFromFreshState(
  id: string,
  deriveUpdates: (
    current: Readonly<Relation>
  ) => RelationFreshUpdateData | null,
  context: CorrelationContext = {}
): Promise<Relation> {
  const correlationContext = { correlationId: resolveCorrelationId(context.correlationId) };
  const docRef = db.collection('relations').doc(id);
  const result = await db.runTransaction(async (tx) => {
    const relationSnap = await tx.get(docRef);
    if (!relationSnap.exists) {
      throw new Error(`Relation with id ${id} not found`);
    }

    const current = relationSnap.data() as Relation;
    const updates = deriveUpdates(current);
    if (updates === null) {
      return { changed: false as const, relation: current };
    }
    const sanitizedUpdates = sanitizeRelationMutation(updates);
    if (updatesRelationTriple(sanitizedUpdates)) {
      throw new Error('adminUpdateRelationFromFreshState only accepts metadata updates');
    }

    const updatedAt = Date.now();
    const projectionNext: Relation = { ...current, ...sanitizedUpdates, updatedAt };
    const sourceFingerprint = await createRelationSourceFingerprint(projectionNext);
    const relation: Relation = {
      ...projectionNext,
      sourceCorrelationId: correlationContext.correlationId,
      sourceFingerprint,
    };
    tx.update(docRef, {
      ...sanitizedUpdates,
      sourceCorrelationId: correlationContext.correlationId,
      sourceFingerprint,
      updatedAt,
    });
    return { changed: true as const, relation };
  });

  if (result.changed) {
    await triggerRelationUpdateSyncSafely(result.relation, correlationContext);
  }
  return result.relation;
}

/**
 * Admin-SDK equivalent of `relations-core.deleteRelation`.
 * Deletes the doc then requires acknowledgement of the `delete` sync event.
 *
 * Deletes the relation and its currently owned triple lock in one transaction.
 * Re-reading topology and ownership inside that transaction prevents a
 * concurrent relation edit or lock takeover from orphaning or deleting the
 * wrong lock.
 */
export async function adminDeleteRelation(
  id: string,
  context: CorrelationContext = {}
): Promise<void> {
  const correlationId = resolveCorrelationId(context.correlationId);
  await adminDeleteRelationsWithOwnedLocks([{ id }], {
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
 * Admin-SDK equivalent of the (private) `relations-validation.buildEntitySnapshot`.
 *
 * The client version dynamically imports per-entity service getters
 * (getCompanyById, getPrototypeById, …) which are themselves client-SDK
 * modules. Here we read the exact same collections directly via the admin SDK,
 * preserving each type's name-field mapping (useCase/painPoint/document/signal
 * use `title`; everything else uses `name`), the technology `tech-` id
 * resolution + format guard, and the same "not found" Error messages.
 *
 * @throws Error if the entity is not found, or for an unknown entity type, or
 *   when a technology id can't be resolved to `tech-xxx`.
 */
export async function buildEntitySnapshot(entityId: string, entityType: EntityType): Promise<EntitySnapshot> {
  const now = Date.now();

  switch (entityType) {
    case 'company': {
      const snap = await db.collection('companies').doc(entityId).get();
      if (!snap.exists) throw new Error(`Company not found: ${entityId}`);
      const company = snap.data() as { id: string; name: string; description?: string; status?: string };
      return {
        type: 'company',
        id: company.id,
        name: company.name,
        description: company.description,
        status: company.status,
        snapshotAt: now,
      };
    }
    case 'prototype': {
      const snap = await db.collection('prototypes').doc(entityId).get();
      if (!snap.exists) throw new Error(`Prototype not found: ${entityId}`);
      const prototype = snap.data() as { id: string; name: string; description?: string; status?: string };
      return {
        type: 'prototype',
        id: prototype.id,
        name: prototype.name,
        description: prototype.description,
        status: prototype.status,
        snapshotAt: now,
      };
    }
    case 'useCase': {
      const snap = await db.collection('use-cases').doc(entityId).get();
      if (!snap.exists) throw new Error(`UseCase not found: ${entityId}`);
      const useCase = snap.data() as { id: string; title: string; description?: string; status?: string };
      return {
        type: 'useCase',
        id: useCase.id,
        name: useCase.title,
        description: useCase.description,
        status: useCase.status,
        snapshotAt: now,
      };
    }
    case 'strategy': {
      const snap = await db.collection('strategies').doc(entityId).get();
      if (!snap.exists) throw new Error(`Strategy not found: ${entityId}`);
      const strategy = snap.data() as { id: string; name: string; description?: string };
      return {
        type: 'strategy',
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        // Strategy doesn't have a status field
        snapshotAt: now,
      };
    }
    case 'technology': {
      const resolvedId = needsResolution(entityId) ? safeResolve(entityId) : entityId;
      if (!resolvedId.startsWith('tech-')) {
        throw new Error(`Technology ID must be in format "tech-xxx": ${entityId}`);
      }

      const snap = await db.collection('technologies').doc(resolvedId).get();
      if (!snap.exists) {
        throw new Error(`Technology not found: ${resolvedId}`);
      }
      const tech = snap.data() as { name?: string; description?: string; approvalStatus?: string };

      return {
        type: 'technology',
        id: resolvedId,
        name: tech.name || 'Unknown Technology',
        description: tech.description,
        status: tech.approvalStatus || 'approved',
        snapshotAt: now,
      };
    }
    case 'signal': {
      const snap = await db.collection('signals').doc(entityId).get();
      if (!snap.exists) throw new Error(`Signal not found: ${entityId}`);
      const signal = snap.data() as { title?: string; description?: string; status?: string };
      return {
        type: 'signal',
        id: entityId,
        name: signal.title || 'Unknown Signal',
        description: signal.description,
        status: signal.status,
        snapshotAt: now,
      };
    }
    case 'orgUnit': {
      const snap = await db.collection('org-units').doc(entityId).get();
      if (!snap.exists) throw new Error(`OrgUnit not found: ${entityId}`);
      const orgUnit = snap.data() as { id: string; name: string; description?: string };
      return {
        type: 'orgUnit',
        id: orgUnit.id,
        name: orgUnit.name,
        description: orgUnit.description,
        snapshotAt: now,
      };
    }
    case 'initiative': {
      const snap = await db.collection('initiatives').doc(entityId).get();
      if (!snap.exists) throw new Error(`Initiative not found: ${entityId}`);
      const initiative = snap.data() as { id: string; name: string; description?: string; status?: string };
      return {
        type: 'initiative',
        id: initiative.id,
        name: initiative.name,
        description: initiative.description,
        status: initiative.status,
        snapshotAt: now,
      };
    }
    case 'painPoint': {
      const snap = await db.collection('painPoints').doc(entityId).get();
      if (!snap.exists) throw new Error(`PainPoint not found: ${entityId}`);
      const painPoint = snap.data() as { id: string; title: string; description?: string; status?: string };
      return {
        type: 'painPoint',
        id: painPoint.id,
        name: painPoint.title,
        description: painPoint.description,
        status: painPoint.status,
        snapshotAt: now,
      };
    }
    case 'document': {
      const snap = await db.collection('documents').doc(entityId).get();
      if (!snap.exists) throw new Error(`Document not found: ${entityId}`);
      const document = snap.data() as { id: string; title: string; description?: string; status?: string };
      return {
        type: 'document',
        id: document.id,
        name: document.title, // Document uses 'title', not 'name'
        description: document.description,
        status: document.status,
        snapshotAt: now,
      };
    }
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Admin-SDK equivalent of `relations-validation.createRelationFromIds`.
 * Fetches both entities (via admin buildEntitySnapshot) and delegates to
 * adminCreateRelation. Preserves the early id-based self-reference check, the
 * default `notes: ''` / `confidence: 100` defaults, and the conditional spread
 * of Phase-4 (Relations-as-Claims) fields.
 *
 * @throws SelfReferenceError if sourceId === targetId
 * @throws Error if either entity is not found
 */
export async function adminCreateRelationFromIds(
  input: CreateRelationInput,
  context: CorrelationContext = {}
): Promise<Relation> {
  const correlationId = resolveCorrelationId(context.correlationId);
  assertCanonicalRelationType(input.relationType);
  const {
    sourceId,
    sourceType,
    targetId,
    targetType,
    relationType,
    notes,
    confidence,
    aiSuggested = false,
    agentName,
    // Phase 4: Relations-as-Claims fields
    evidenceRefs,
    reasoningSummary,
    claimStatus,
  } = input;

  // Early self-reference check by ID (fail fast before fetching).
  if (sourceId === targetId) {
    throw new SelfReferenceError(sourceId, `Entity ${sourceId}`);
  }

  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    buildEntitySnapshot(sourceId, sourceType),
    buildEntitySnapshot(targetId, targetType),
  ]);

  // Firebase rejects undefined values, so provide defaults for optional fields.
  return adminCreateRelation(
    {
      relationType,
      sourceSnapshot,
      targetSnapshot,
      notes: notes || '', // Default to empty string
      confidence: confidence ?? 100, // Default to 100% confidence if not specified
      aiSuggested,
      // Phase 4: Relations-as-Claims fields (only include if defined)
      ...(evidenceRefs && { evidenceRefs }),
      ...(reasoningSummary && { reasoningSummary }),
      ...(claimStatus && { claimStatus }),
      ...(agentName && { agentName }),
    },
    { correlationId }
  );
}

// ---------------------------------------------------------------------------
// GET-path read helpers (mirror relations-core.getRelations,
// relations-queries.getRelations{BySource,ByTarget,ForEntity},
// getAISuggestedRelations, getStaleRelations). Used by /api/relations GET.
// ---------------------------------------------------------------------------

/**
 * Admin-SDK equivalent of `relations-core.getRelations`.
 * Fetches all relations from Firestore.
 *
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function adminGetRelations(): Promise<Relation[]> {
  const snap = await db.collection('relations').get();
  return snap.docs.map((doc) => doc.data() as Relation);
}

/**
 * Admin-SDK equivalent of `relations-queries.getRelationsBySource`.
 * Fetches relations filtered by source entity ID.
 *
 * @param sourceId - The source entity ID
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function adminGetRelationsBySource(sourceId: string): Promise<Relation[]> {
  const snap = await db.collection('relations').where('sourceSnapshot.id', '==', sourceId).get();
  return snap.docs.map((doc) => doc.data() as Relation);
}

/**
 * Admin-SDK equivalent of `relations-queries.getRelationsByTarget`.
 * Fetches relations filtered by target entity ID.
 *
 * @param targetId - The target entity ID
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function adminGetRelationsByTarget(targetId: string): Promise<Relation[]> {
  const snap = await db.collection('relations').where('targetSnapshot.id', '==', targetId).get();
  return snap.docs.map((doc) => doc.data() as Relation);
}

/**
 * Admin-SDK equivalent of `relations-queries.getRelationsForEntity`.
 * Fetches all relations for a given entity (both source and target), deduped by id.
 *
 * @param entityId - The entity ID to fetch relations for
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function adminGetRelationsForEntity(entityId: string): Promise<Relation[]> {
  const [sourceRelations, targetRelations] = await Promise.all([
    adminGetRelationsBySource(entityId),
    adminGetRelationsByTarget(entityId),
  ]);

  // Deduplicate by ID (shouldn't happen but just in case)
  const allRelations = [...sourceRelations, ...targetRelations];
  const uniqueRelations = Array.from(new Map(allRelations.map((rel) => [rel.id, rel])).values());

  return uniqueRelations;
}

/**
 * Admin-SDK equivalent of `relations-queries.getAISuggestedRelations`.
 * Fetches AI-suggested relations pending approval, ordered by confidence desc.
 *
 * @param minConfidence - Minimum confidence score threshold (0-100)
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function adminGetAISuggestedRelations(minConfidence: number = 0): Promise<Relation[]> {
  const snap = await db
    .collection('relations')
    .where('aiSuggested', '==', true)
    .where('confidence', '>=', minConfidence)
    .orderBy('confidence', 'desc')
    .get();
  return snap.docs.map((doc) => doc.data() as Relation);
}

/**
 * Admin-SDK equivalent of `relations-queries.getStaleRelations`.
 * Finds stale relation snapshots (either snapshot older than `staleDays`).
 *
 * @param staleDays - Days after which a snapshot is considered stale (default: 30)
 * @returns Promise resolving to an array of Relation objects with stale snapshots
 * @throws Error if Firestore query fails
 */
export async function adminGetStaleRelations(staleDays: number = 30): Promise<Relation[]> {
  const staleTimestamp = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const allRelations = await adminGetRelations();

  return allRelations.filter(
    (rel) => rel.sourceSnapshot.snapshotAt < staleTimestamp || rel.targetSnapshot.snapshotAt < staleTimestamp
  );
}

/**
 * Admin-SDK equivalent of `relations-validation.cleanupOrphanedRelations`.
 *
 * Finds and deletes orphaned relations where the source or target entity no
 * longer exists in Firestore. Defense-in-depth against orphans from race
 * conditions, partial failures, or past missing-cascade bugs.
 *
 * Replicates the client procedure EXACTLY:
 *  - early return `{ checked: 0, orphaned: 0, deleted: 0 }` when there are no
 *    relations
 *  - groups unique entity ids by collection (via the shared ENTITY_COLLECTIONS
 *    map above)
 *  - checks existence in parallel batches of 50; on a per-doc read error it
 *    conservatively assumes the entity EXISTS (so a transient read failure never
 *    deletes a live relation)
 *  - unknown entity types (no ENTITY_COLLECTIONS entry) are treated as existing
 *  - a relation is orphaned iff source OR target is missing
 *  - early return `{ checked, orphaned: 0, deleted: 0 }` when nothing is orphaned
 *  - lock-aware transactionally deletes orphans in chunks of 90 (at most 450
 *    relation, owned-lock-candidate, and durable-outbox writes) and emits one tokenized
 *    Neo4j delete sync per relation after each chunk commits,
 *    then logs `deleted`/`total`
 *
 * The only mechanical difference from the client version is the SDK surface:
 * admin `db.collection(name).doc(id).get()` / `snap.exists` (property, not the
 * client's `exists()` method) for reads, and admin `db.batch()` /
 * `batch.delete(ref)` / `batch.commit()` for deletes.
 *
 * @returns Promise resolving to cleanup results
 */
export async function adminCleanupOrphanedRelations(): Promise<CleanupOrphanedRelationsResult> {
  const allRelations = await adminGetRelations();

  if (allRelations.length === 0) {
    return { checked: 0, orphaned: 0, deleted: 0 };
  }

  // Collect unique entity IDs to check, grouped by collection.
  const entitiesToCheck = new Map<string, Set<string>>(); // collectionName -> Set<entityId>

  for (const rel of allRelations) {
    const sourceCollection = ENTITY_COLLECTIONS[rel.sourceSnapshot.type];
    const targetCollection = ENTITY_COLLECTIONS[rel.targetSnapshot.type];

    if (sourceCollection) {
      if (!entitiesToCheck.has(sourceCollection)) {
        entitiesToCheck.set(sourceCollection, new Set());
      }
      entitiesToCheck.get(sourceCollection)!.add(rel.sourceSnapshot.id);
    }

    if (targetCollection) {
      if (!entitiesToCheck.has(targetCollection)) {
        entitiesToCheck.set(targetCollection, new Set());
      }
      entitiesToCheck.get(targetCollection)!.add(rel.targetSnapshot.id);
    }
  }

  // Check entity existence in parallel batches of 50.
  const existingEntities = new Set<string>(); // "collection:id" keys
  const checkPromises: Promise<void>[] = [];

  for (const [collectionName, entityIds] of entitiesToCheck) {
    const ids = Array.from(entityIds);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      checkPromises.push(
        Promise.all(
          batch.map(async (id) => {
            try {
              const docSnap = await db.collection(collectionName).doc(id).get();
              if (docSnap.exists) {
                existingEntities.add(`${collectionName}:${id}`);
              }
            } catch {
              // If check fails, assume entity exists (conservative).
              existingEntities.add(`${collectionName}:${id}`);
            }
          })
        ).then(() => undefined)
      );
    }
  }

  await Promise.all(checkPromises);

  // Find orphaned relations.
  const orphanedRelations: Relation[] = [];

  for (const rel of allRelations) {
    const sourceCollection = ENTITY_COLLECTIONS[rel.sourceSnapshot.type];
    const targetCollection = ENTITY_COLLECTIONS[rel.targetSnapshot.type];

    const sourceExists = sourceCollection ? existingEntities.has(`${sourceCollection}:${rel.sourceSnapshot.id}`) : true; // Unknown type -> conservative, assume exists
    const targetExists = targetCollection ? existingEntities.has(`${targetCollection}:${rel.targetSnapshot.id}`) : true;

    if (!sourceExists || !targetExists) {
      orphanedRelations.push(rel);
    }
  }

  if (orphanedRelations.length === 0) {
    return { checked: allRelations.length, orphaned: 0, deleted: 0 };
  }

  // One exact cleanup operation owns one trace across every chunk/relation.
  const correlationId = resolveCorrelationId();
  const deleted = (
    await adminDeleteRelationsWithOwnedLocks(
      orphanedRelations.map((relation) => ({ id: relation.id })),
      {
        correlationId,
        onChunkDeleted: async (_relationIds, dispatches) => {
          await Promise.all(
            dispatches.map(async ({ relationId, deleteToken }) => {
              const syncTriggered = await triggerRelationSyncSafely(
                relationId,
                'delete',
                { deleteToken },
                { correlationId }
              );
              requireRelationSyncAcknowledgement(syncTriggered, relationId, 'delete');
            })
          );
        },
      }
    )
  ).length;

  log.info('Cleaned up orphaned relations', { deleted, total: allRelations.length });

  return {
    checked: allRelations.length,
    orphaned: orphanedRelations.length,
    deleted,
  };
}
