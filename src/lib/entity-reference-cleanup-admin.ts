/**
 * @file entity-reference-cleanup-admin.ts
 * @description Admin-SDK executor for the Firebase-free entity deletion policy.
 *
 * Planning and mutation are deliberately separate. Every reverse-reference and
 * blocker query completes before the caller performs a graph handoff or any
 * Firestore write. A failed query therefore leaves the entity and all of its
 * dependants untouched. Applying a completed plan uses only idempotent deletes
 * and arrayRemove writes in bounded transactions, so a partially completed cleanup
 * can be retried safely while the source entity remains the retry anchor.
 */

import 'server-only';

import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { mapSettledWithBoundedConcurrency } from '@/lib/bounded-concurrency';
import {
  ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT,
  EntityDeletionBlockedError,
  getEntityDeletionReferencePolicy,
  type DeletionReferenceEntityType,
  type EntityDeletionBlockerMatch,
  type EntityDeletionReferencePolicy,
} from '@/lib/entity-deletion-reference-policy';
import { db } from '@/lib/firebase-admin';

/** Keep headroom below Firestore's hard 500-write transaction limit. */
export const ENTITY_REFERENCE_CLEANUP_BATCH_SIZE = 450;

const ENTITY_REFERENCE_PREFLIGHT_CONCURRENCY = 8;

type PlannedReferenceMutation =
  | {
      readonly kind: 'delete';
      readonly reference: DocumentReference<DocumentData>;
      /** Collection-query ownership must still match at transaction commit. */
      readonly ownerField?: string;
      readonly ownerId?: string;
    }
  | {
      readonly kind: 'array-remove';
      readonly reference: DocumentReference<DocumentData>;
      readonly fieldPath: string;
      readonly entityId: string;
    };

/** Opaque result of the read-only phase, consumed after graph handoff. */
export interface AdminEntityReferenceCleanupPlan {
  readonly entityType: DeletionReferenceEntityType;
  readonly entityId: string;
  readonly mutations: readonly PlannedReferenceMutation[];
  /** Rows observed during preflight but owned by the established notes helper. */
  readonly delegatedReferences: number;
}

export interface AdminEntityReferenceCleanupResult {
  readonly ownedReferencesDeleted: number;
  readonly liveReferencesRemoved: number;
  readonly delegatedReferences: number;
  /** Transaction chunks that committed at least one actual mutation. */
  readonly batchesCommitted: number;
}

export interface FailedAdminEntityReferenceCleanupPreflight {
  readonly id: string;
  readonly error: unknown;
}

function withCursor(
  query: Query<DocumentData>,
  cursor: QueryDocumentSnapshot<DocumentData> | undefined
): Query<DocumentData> {
  return cursor ? query.startAfter(cursor) : query;
}

async function readAllPages(
  createQuery: () => Query<DocumentData>,
  targetDescription: string
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const references: QueryDocumentSnapshot<DocumentData>[] = [];
  const seenDocumentPaths = new Set<string>();
  let cursor: QueryDocumentSnapshot<DocumentData> | undefined;

  while (true) {
    const snapshot = await withCursor(createQuery(), cursor).get();
    if (snapshot.docs.length > ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
      throw new Error(`Entity reference cleanup query exceeded its bound for ${targetDescription}`);
    }
    if (snapshot.empty || snapshot.docs.length === 0) break;

    for (const reference of snapshot.docs) {
      if (seenDocumentPaths.has(reference.ref.path)) {
        throw new Error(`Entity reference cleanup pagination made no progress for ${targetDescription}`);
      }
      seenDocumentPaths.add(reference.ref.path);
      references.push(reference);
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) break;
  }

  return references;
}

async function assertNoBlockers(
  policy: EntityDeletionReferencePolicy,
  entityId: string
): Promise<void> {
  const matches: EntityDeletionBlockerMatch[] = [];

  for (const blocker of policy.blockers) {
    const references = await readAllPages(
      () =>
        db
          .collection(blocker.collection)
          .where(blocker.fieldPath, '==', entityId)
          .orderBy(FieldPath.documentId())
          .limit(ENTITY_REFERENCE_CLEANUP_BATCH_SIZE),
      `${blocker.collection}/${blocker.fieldPath}`
    );

    if (references.length > 0) {
      matches.push({
        collection: blocker.collection,
        fieldPath: blocker.fieldPath,
        count: references.length,
        sampleDocumentIds: references
          .map((reference) => reference.id)
          .sort((left, right) => left.localeCompare(right))
          .slice(0, ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT),
        reason: blocker.reason,
      });
    }
  }

  if (matches.length > 0) {
    throw new EntityDeletionBlockedError(policy.entityType, entityId, matches);
  }
}

function isDelegatedNotesSubcollection(
  reference: EntityDeletionReferencePolicy['ownedReferences'][number]
): boolean {
  // Notes already have a dedicated, bounded client/Admin cleanup pair. Keeping
  // that helper authoritative avoids deleting the same rows through two paths.
  return reference.kind === 'subcollection' && reference.subcollection === 'notes';
}

/**
 * Resolve every required cleanup row without performing any write. The caller
 * must complete this phase before graph handoff, link cleanup, or relation
 * cleanup. Historical provenance fields are intentionally absent from the
 * mutation plan.
 */
export async function adminPlanEntityReferenceCleanup(
  entityType: DeletionReferenceEntityType,
  entityId: string
): Promise<AdminEntityReferenceCleanupPlan> {
  if (entityId.trim().length === 0) {
    throw new Error('Entity reference cleanup requires a non-empty entity ID');
  }

  const policy = getEntityDeletionReferencePolicy(entityType);

  await assertNoBlockers(policy, entityId);

  const mutations: PlannedReferenceMutation[] = [];
  let delegatedReferences = 0;

  for (const ownedReference of policy.ownedReferences) {
    const references =
      ownedReference.kind === 'subcollection'
        ? await readAllPages(
            () =>
              db
                .collection(ownedReference.parentCollection)
                .doc(entityId)
                .collection(ownedReference.subcollection)
                .orderBy(FieldPath.documentId())
                .limit(ENTITY_REFERENCE_CLEANUP_BATCH_SIZE),
            `${ownedReference.parentCollection}/{id}/${ownedReference.subcollection}`
          )
        : await readAllPages(
            () =>
              db
                .collection(ownedReference.collection)
                .where(ownedReference.ownerField, '==', entityId)
                .orderBy(FieldPath.documentId())
                .limit(ENTITY_REFERENCE_CLEANUP_BATCH_SIZE),
            `${ownedReference.collection}/${ownedReference.ownerField}`
          );

    if (isDelegatedNotesSubcollection(ownedReference)) {
      delegatedReferences += references.length;
      continue;
    }

    for (const reference of references) {
      mutations.push({
        kind: 'delete',
        reference: reference.ref,
        ...(ownedReference.kind === 'collection-query'
          ? { ownerField: ownedReference.ownerField, ownerId: entityId }
          : {}),
      });
    }
  }

  for (const liveReference of policy.liveArrayReferences) {
    const references = await readAllPages(
      () =>
        db
          .collection(liveReference.collection)
          .where(liveReference.fieldPath, 'array-contains', entityId)
          .orderBy(FieldPath.documentId())
          .limit(ENTITY_REFERENCE_CLEANUP_BATCH_SIZE),
      `${liveReference.collection}/${liveReference.fieldPath}`
    );

    for (const reference of references) {
      mutations.push({
        kind: 'array-remove',
        reference: reference.ref,
        fieldPath: liveReference.fieldPath,
        entityId,
      });
    }
  }

  return { entityType, entityId, mutations, delegatedReferences };
}

/** Run independent entity preflights with bounded concurrency and exact IDs. */
export async function adminPlanEntityReferenceCleanups(
  entityType: DeletionReferenceEntityType,
  entityIds: readonly string[]
): Promise<{
  planned: AdminEntityReferenceCleanupPlan[];
  failed: FailedAdminEntityReferenceCleanupPreflight[];
}> {
  const outcomes = await mapSettledWithBoundedConcurrency(
    entityIds,
    ENTITY_REFERENCE_PREFLIGHT_CONCURRENCY,
    (entityId) => adminPlanEntityReferenceCleanup(entityType, entityId)
  );

  const planned: AdminEntityReferenceCleanupPlan[] = [];
  const failed: FailedAdminEntityReferenceCleanupPreflight[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      planned.push(outcome.value);
    } else {
      failed.push({ id: entityIds[index], error: outcome.reason });
    }
  });

  return { planned, failed };
}

/** Apply a preflighted plan after the required graph handoff succeeds. */
export async function adminApplyEntityReferenceCleanup(
  plan: AdminEntityReferenceCleanupPlan
): Promise<AdminEntityReferenceCleanupResult> {
  let ownedReferencesDeleted = 0;
  let liveReferencesRemoved = 0;
  let batchesCommitted = 0;

  for (let offset = 0; offset < plan.mutations.length; offset += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const chunk = plan.mutations.slice(offset, offset + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);
    const committed = await db.runTransaction(async (transaction) => {
      const currentDocuments = await Promise.all(
        chunk.map((mutation) => transaction.get(mutation.reference))
      );
      let owned = 0;
      let live = 0;

      chunk.forEach((mutation, index) => {
        const current = currentDocuments[index];
        if (!current.exists) return;

        if (mutation.kind === 'delete') {
          if (mutation.ownerField && current.get(mutation.ownerField) !== mutation.ownerId) return;
          transaction.delete(mutation.reference);
          owned += 1;
          return;
        }

        const currentIds = current.get(mutation.fieldPath);
        if (!Array.isArray(currentIds) || !currentIds.includes(mutation.entityId)) return;
        transaction.update(
          mutation.reference,
          mutation.fieldPath,
          FieldValue.arrayRemove(mutation.entityId)
        );
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
    delegatedReferences: plan.delegatedReferences,
    batchesCommitted,
  };
}
