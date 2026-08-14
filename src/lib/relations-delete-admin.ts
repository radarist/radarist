/**
 * @file relations-delete-admin.ts
 * @description Admin-SDK lock-aware bulk deletion for relation records.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import type { RelationType } from '@/lib/types';
import { resolveCorrelationId } from '@/lib/observability/correlation';
import type { RelationDeleteOptions, RelationDeleteTarget } from '@/lib/relations-delete-client';
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

/** Admin-SDK twin of `deleteRelationsWithOwnedLocks`. */
export async function adminDeleteRelationsWithOwnedLocks(
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
    const chunkDeletedIds = await db.runTransaction(async (tx) => {
      const relationRefs = chunk.map((target) => db.collection('relations').doc(target.id));
      const relationSnaps = await Promise.all(relationRefs.map((ref) => tx.get(ref)));
      const liveRelations = relationSnaps.flatMap((snap, index) => {
        if (!snap.exists) return [];
        const data = snap.data() as {
          sourceId?: string;
          targetId?: string;
          relationType?: RelationType;
          sourceSnapshot?: { id?: string };
          targetSnapshot?: { id?: string };
        };
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
          relation.keys.map((key) => [
            key,
            db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(key),
          ] as const)
        )
      );
      const lockSnaps = await Promise.all([...lockRefsByKey.values()].map((ref) => tx.get(ref)));
      const liveIds = new Set(liveRelations.map((relation) => relation.id));
      const targetsById = new Map(chunk.map((target) => [target.id, target]));

      for (const relation of liveRelations) tx.delete(relation.ref);
      const outboxTimestamp = Date.now();
      for (const relation of liveRelations) {
        tx.set(
          db.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(relation.id),
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
        const owner = lockSnap?.exists
          ? (lockSnap.data() as { relationId?: string } | undefined)?.relationId
          : undefined;
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
