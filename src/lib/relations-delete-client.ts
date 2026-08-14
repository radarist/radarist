/**
 * @file relations-delete-client.ts
 * @description Client-SDK lock-aware bulk deletion for relation records.
 */

import { doc, runTransaction, type Firestore } from 'firebase/firestore';
import type { RelationType } from '@/lib/types';
import { resolveCorrelationId } from '@/lib/observability/correlation';
import {
  buildRelationTripleLockKeyCandidates,
  RELATION_LOCK_AWARE_DELETE_BATCH_SIZE,
  RELATION_TRIPLE_LOCK_COLLECTION,
} from '@/lib/relations-triple-key';
import {
  buildRelationDeleteOutboxRecord,
  createRelationDeleteToken,
  RELATION_SYNC_OUTBOX_COLLECTION,
} from '@/lib/relation-sync-outbox';

export interface RelationDeleteTarget {
  id: string;
  /** Keep the lock but transfer ownership when deleting a duplicate row. */
  replacementRelationId?: string;
}

export interface RelationDeleteOptions {
  /** Stable mutation token persisted for durable graph-delete replay. */
  correlationId?: string;
  /** Runs after each committed chunk, before the next chunk starts. */
  onChunkDeleted?: (
    relationIds: readonly string[],
    dispatches: readonly RelationDeleteDispatch[]
  ) => Promise<void>;
}

export interface RelationDeleteDispatch {
  relationId: string;
  deleteToken: string;
}

interface StoredRelationTopology {
  sourceId?: string;
  targetId?: string;
  relationType?: RelationType;
  sourceSnapshot?: { id?: string };
  targetSnapshot?: { id?: string };
}

/**
 * Deletes relation documents and any triple locks they still own. Each
 * transaction re-reads the relation's current topology before resolving its
 * lock, so a concurrent topology move or lock takeover forces Firestore to
 * retry instead of letting a stale batch delete another relation's lock.
 *
 * Returns the unique relation ids that still existed in the transaction.
 */
export async function deleteRelationsWithOwnedLocks(
  db: Firestore,
  targets: readonly RelationDeleteTarget[],
  options: RelationDeleteOptions = {}
): Promise<string[]> {
  const correlationId =
    options.correlationId === undefined ? undefined : resolveCorrelationId(options.correlationId);
  const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
  const deleteTokens = new Map(uniqueTargets.map((target) => [target.id, createRelationDeleteToken(target.id)]));
  const deletedIds: string[] = [];

  for (let offset = 0; offset < uniqueTargets.length; offset += RELATION_LOCK_AWARE_DELETE_BATCH_SIZE) {
    const chunk = uniqueTargets.slice(offset, offset + RELATION_LOCK_AWARE_DELETE_BATCH_SIZE);
    const chunkDeletedIds = await runTransaction(db, async (tx) => {
      const relationRefs = chunk.map((target) => doc(db, 'relations', target.id));
      const relationSnaps = await Promise.all(relationRefs.map((ref) => tx.get(ref)));
      const liveRelations = relationSnaps.flatMap((snap, index) => {
        if (!snap.exists()) return [];
        const data = snap.data() as StoredRelationTopology;
        const sourceId = data.sourceSnapshot?.id ?? data.sourceId;
        const targetId = data.targetSnapshot?.id ?? data.targetId;
        if (!sourceId || !targetId || !data.relationType) {
          throw new Error(`Relation ${chunk[index].id} is missing lock topology`);
        }
        const keys = buildRelationTripleLockKeyCandidates(sourceId, targetId, data.relationType);
        return [{ id: chunk[index].id, ref: relationRefs[index], keys }];
      });
      const lockRefsByKey = new Map(
        liveRelations.flatMap((relation) =>
          relation.keys.map((key) => [key, doc(db, RELATION_TRIPLE_LOCK_COLLECTION, key)] as const)
        )
      );
      const lockSnaps = await Promise.all([...lockRefsByKey.values()].map((ref) => tx.get(ref)));
      const liveIds = new Set(liveRelations.map((relation) => relation.id));
      const targetsById = new Map(chunk.map((target) => [target.id, target]));

      for (const relation of liveRelations) tx.delete(relation.ref);
      const outboxTimestamp = Date.now();
      for (const relation of liveRelations) {
        tx.set(
          doc(db, RELATION_SYNC_OUTBOX_COLLECTION, relation.id),
          buildRelationDeleteOutboxRecord(
            relation.id,
            deleteTokens.get(relation.id)!,
            outboxTimestamp,
            correlationId
          )
        );
      }
      [...lockRefsByKey.entries()].forEach(([, lockRef], index) => {
        const lockSnap = lockSnaps[index];
        const owner = lockSnap?.exists() ? (lockSnap.data() as { relationId?: string }).relationId : undefined;
        if (!owner || !liveIds.has(owner)) return;
        const replacementRelationId = targetsById.get(owner)?.replacementRelationId;
        if (replacementRelationId) {
          tx.update(lockRef, { relationId: replacementRelationId });
        } else {
          tx.delete(lockRef);
        }
      });

      return liveRelations.map((relation) => relation.id);
    });

    deletedIds.push(...chunkDeletedIds);
    if (chunkDeletedIds.length > 0) {
      await options.onChunkDeleted?.(
        chunkDeletedIds,
        chunkDeletedIds.map((relationId) => ({
          relationId,
          deleteToken: deleteTokens.get(relationId)!,
        }))
      );
    }
  }

  return deletedIds;
}
