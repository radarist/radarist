/**
 * Client-SDK executor for the dependency-free entity deletion reference policy.
 *
 * Cleanup is split into preflight and apply phases so every bounded query can
 * succeed before the first reverse-reference write. The resulting mutations
 * are exact and replay-safe: owned rows are deleted by document reference and
 * live arrays use Firestore's atomic arrayRemove transform.
 */

import {
  arrayRemove,
  collection,
  documentId,
  getDocs,
  limit as firestoreLimit,
  orderBy,
  query,
  runTransaction,
  startAfter,
  where,
  type DocumentData,
  type Firestore,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { mapSettledWithBoundedConcurrency } from '@/lib/bounded-concurrency';
import {
  ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT,
  EntityDeletionBlockedError,
  getEntityDeletionReferencePolicy,
  type DeletionBlockerPolicy,
  type DeletionReferenceEntityType,
  type EntityDeletionBlockerMatch,
  type LiveArrayReferencePolicy,
  type OwnedReferencePolicy,
} from '@/lib/entity-deletion-reference-policy';

export { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
export type { EntityDeletionBlockerMatch } from '@/lib/entity-deletion-reference-policy';

/** Leave headroom below Firestore's 500-write transaction limit. */
export const ENTITY_REFERENCE_CLEANUP_BATCH_SIZE = 450;
export const ENTITY_REFERENCE_PREFLIGHT_MAX_CONCURRENCY = 8;

interface PlannedOwnedReference {
  readonly policy: OwnedReferencePolicy;
  readonly documents: readonly QueryDocumentSnapshot<DocumentData>[];
  /** Notes retain their established deleteAllEntityNotes owner. */
  readonly delegated: boolean;
}

interface PlannedLiveArrayReference {
  readonly policy: LiveArrayReferencePolicy;
  readonly documents: readonly QueryDocumentSnapshot<DocumentData>[];
}

export interface EntityReferenceCleanupPlan {
  readonly entityType: DeletionReferenceEntityType;
  readonly entityId: string;
  readonly ownedReferences: readonly PlannedOwnedReference[];
  readonly liveArrayReferences: readonly PlannedLiveArrayReference[];
}

export interface EntityReferenceCleanupResult {
  readonly ownedReferencesDeleted: number;
  readonly liveReferencesRemoved: number;
  readonly delegatedReferences: number;
  /** Transaction chunks that committed at least one actual mutation. */
  readonly batchesCommitted: number;
}

export interface PreparedEntityReferenceCleanup {
  readonly id: string;
  readonly plan: EntityReferenceCleanupPlan;
}

export interface FailedEntityReferenceCleanupPreflight {
  readonly id: string;
  readonly error: unknown;
}

function isDelegatedOwnedReference(policy: OwnedReferencePolicy): boolean {
  return policy.kind === 'subcollection' && policy.subcollection === 'notes';
}

async function collectBoundedDocuments(
  firestore: Firestore,
  collectionPath: readonly [string, ...string[]],
  filter: QueryConstraint | undefined,
  label: string
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const documents: QueryDocumentSnapshot<DocumentData>[] = [];
  const seenDocumentIds = new Set<string>();
  let cursor: QueryDocumentSnapshot<DocumentData> | undefined;

  while (true) {
    const constraints: QueryConstraint[] = [];
    if (filter) constraints.push(filter);
    constraints.push(orderBy(documentId()), firestoreLimit(ENTITY_REFERENCE_CLEANUP_BATCH_SIZE));
    if (cursor) constraints.push(startAfter(cursor));

    const snapshot = await getDocs(query(collection(firestore, ...collectionPath), ...constraints));
    if (snapshot.docs.length > ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
      throw new Error(`Entity reference cleanup query exceeded its bound for ${label}`);
    }
    if (snapshot.docs.length === 0) break;

    for (const reference of snapshot.docs) {
      if (seenDocumentIds.has(reference.id)) {
        throw new Error(`Entity reference cleanup pagination made no progress for ${label}`);
      }
      seenDocumentIds.add(reference.id);
      documents.push(reference);
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) break;
  }

  return documents;
}

async function collectBlockers(
  firestore: Firestore,
  policy: DeletionBlockerPolicy,
  entityId: string
): Promise<EntityDeletionBlockerMatch | null> {
  const documents = await collectBoundedDocuments(
    firestore,
    [policy.collection],
    where(policy.fieldPath, '==', entityId),
    `${policy.collection}/${policy.fieldPath}`
  );

  if (documents.length === 0) return null;

  return {
    collection: policy.collection,
    fieldPath: policy.fieldPath,
    count: documents.length,
    sampleDocumentIds: [...new Set(documents.map((document) => document.id))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT),
    reason: policy.reason,
  };
}

async function collectOwnedReference(
  firestore: Firestore,
  policy: OwnedReferencePolicy,
  entityId: string
): Promise<PlannedOwnedReference> {
  const documents =
    policy.kind === 'subcollection'
      ? await collectBoundedDocuments(
          firestore,
          [policy.parentCollection, entityId, policy.subcollection],
          undefined,
          `${policy.parentCollection}/${entityId}/${policy.subcollection}`
        )
      : await collectBoundedDocuments(
          firestore,
          [policy.collection],
          where(policy.ownerField, '==', entityId),
          `${policy.collection}/${policy.ownerField}`
        );

  return {
    policy,
    documents,
    delegated: isDelegatedOwnedReference(policy),
  };
}

async function collectLiveArrayReference(
  firestore: Firestore,
  policy: LiveArrayReferencePolicy,
  entityId: string
): Promise<PlannedLiveArrayReference> {
  const documents = await collectBoundedDocuments(
    firestore,
    [policy.collection],
    where(policy.fieldPath, 'array-contains', entityId),
    `${policy.collection}/${policy.fieldPath}`
  );
  return { policy, documents };
}

/**
 * Reads every blocker and cleanup target without mutating Firestore.
 * Blockers fail closed before any owned/live-reference query can be applied.
 */
export async function preflightEntityReferenceCleanup(
  entityType: DeletionReferenceEntityType,
  entityId: string,
  firestore: Firestore
): Promise<EntityReferenceCleanupPlan> {
  if (entityId.trim().length === 0) {
    throw new Error('Entity reference cleanup requires a non-empty entity ID');
  }

  const policy = getEntityDeletionReferencePolicy(entityType);
  const blockerMatches: EntityDeletionBlockerMatch[] = [];
  for (const blocker of policy.blockers) {
    const match = await collectBlockers(firestore, blocker, entityId);
    if (match) blockerMatches.push(match);
  }
  if (blockerMatches.length > 0) {
    throw new EntityDeletionBlockedError(entityType, entityId, blockerMatches);
  }

  const ownedReferences: PlannedOwnedReference[] = [];
  for (const ownedReference of policy.ownedReferences) {
    ownedReferences.push(await collectOwnedReference(firestore, ownedReference, entityId));
  }

  const liveArrayReferences: PlannedLiveArrayReference[] = [];
  for (const liveReference of policy.liveArrayReferences) {
    liveArrayReferences.push(await collectLiveArrayReference(firestore, liveReference, entityId));
  }

  return { entityType, entityId, ownedReferences, liveArrayReferences };
}

/**
 * Bounded multi-ID preflight used by bulk deletes before graph handoff.
 * Exact ID-level failures are returned rather than aborting unrelated parents.
 */
export async function preflightEntityReferenceCleanups(
  entityType: DeletionReferenceEntityType,
  entityIds: readonly string[],
  firestore: Firestore
): Promise<{
  prepared: PreparedEntityReferenceCleanup[];
  failed: FailedEntityReferenceCleanupPreflight[];
}> {
  const outcomes = await mapSettledWithBoundedConcurrency(
    entityIds,
    ENTITY_REFERENCE_PREFLIGHT_MAX_CONCURRENCY,
    (entityId) => preflightEntityReferenceCleanup(entityType, entityId, firestore)
  );

  const prepared: PreparedEntityReferenceCleanup[] = [];
  const failed: FailedEntityReferenceCleanupPreflight[] = [];
  outcomes.forEach((outcome, index) => {
    const id = entityIds[index];
    if (outcome.status === 'fulfilled') {
      prepared.push({ id, plan: outcome.value });
    } else {
      failed.push({ id, error: outcome.reason });
    }
  });

  return { prepared, failed };
}

type PlannedMutation =
  | {
      readonly kind: 'delete';
      readonly document: QueryDocumentSnapshot<DocumentData>;
      /** Collection-query ownership must still match when the transaction commits. */
      readonly ownerField?: string;
    }
  | {
      readonly kind: 'array-remove';
      readonly document: QueryDocumentSnapshot<DocumentData>;
      readonly fieldPath: string;
    };

/** Applies a previously preflighted plan in replay-safe transactions of at most 450 writes. */
export async function applyEntityReferenceCleanup(
  plan: EntityReferenceCleanupPlan,
  firestore: Firestore
): Promise<EntityReferenceCleanupResult> {
  const mutations: PlannedMutation[] = [];
  let delegatedReferences = 0;

  for (const ownedReference of plan.ownedReferences) {
    if (ownedReference.delegated) {
      delegatedReferences += ownedReference.documents.length;
      continue;
    }
    for (const document of ownedReference.documents) {
      mutations.push({
        kind: 'delete',
        document,
        ...(ownedReference.policy.kind === 'collection-query'
          ? { ownerField: ownedReference.policy.ownerField }
          : {}),
      });
    }
  }

  for (const liveReference of plan.liveArrayReferences) {
    for (const document of liveReference.documents) {
      mutations.push({
        kind: 'array-remove',
        document,
        fieldPath: liveReference.policy.fieldPath,
      });
    }
  }

  let ownedReferencesDeleted = 0;
  let liveReferencesRemoved = 0;
  let batchesCommitted = 0;

  for (let offset = 0; offset < mutations.length; offset += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const chunk = mutations.slice(offset, offset + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);
    const committed = await runTransaction(firestore, async (transaction) => {
      // Read every current row before scheduling a write. This protects an
      // owned join that was reassigned or recreated after the preflight.
      const currentDocuments = await Promise.all(
        chunk.map((mutation) => transaction.get(mutation.document.ref))
      );
      let owned = 0;
      let live = 0;

      chunk.forEach((mutation, index) => {
        const current = currentDocuments[index];
        if (!current.exists()) return;

        if (mutation.kind === 'delete') {
          if (mutation.ownerField && current.get(mutation.ownerField) !== plan.entityId) return;
          transaction.delete(mutation.document.ref);
          owned += 1;
          return;
        }

        const currentIds = current.get(mutation.fieldPath);
        if (!Array.isArray(currentIds) || !currentIds.includes(plan.entityId)) return;
        transaction.update(mutation.document.ref, {
          [mutation.fieldPath]: arrayRemove(plan.entityId),
        });
        live += 1;
      });

      return { owned, live };
    });

    ownedReferencesDeleted += committed.owned;
    liveReferencesRemoved += committed.live;
    if (committed.owned + committed.live > 0) batchesCommitted += 1;
  }

  return {
    ownedReferencesDeleted,
    liveReferencesRemoved,
    delegatedReferences,
    batchesCommitted,
  };
}
