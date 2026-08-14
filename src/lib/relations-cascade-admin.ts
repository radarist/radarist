/**
 * @file relations-cascade-admin.ts
 * @description Shared admin-SDK cascade deletion of an entity's relations.
 *
 * Every entity's admin delete path (companies, technologies, signals, documents,
 * use-cases, org-units, initiatives, strategies, prototypes) must remove the
 * relation docs that point at the entity AND tell the graph to drop the mirrored
 * Neo4j edges/Assertions. Nine near-identical private copies of this logic used
 * to exist; all of them deleted the Firestore docs but NONE fired the
 * `app/relation.sync.requested` delete event (F138), so every cascade left
 * orphan typed edges (and their :Assertion nodes) live in Neo4j pointing at a
 * now-deleted entity. This single implementation deletes AND fans out the delete
 * sync, and is the only copy the entity admin modules import.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { adminDeleteRelationsWithOwnedLocks } from '@/lib/relations-delete-admin';
import { requireRelationSyncAcknowledgement } from '@/lib/relation-sync-dispatch';
import { relationDeleteSyncEventId } from '@/lib/relation-sync-outbox';
import {
  resolveCorrelationId,
  type CorrelationContext,
} from '@/lib/observability/correlation';

const log = createLogger('relations-cascade-admin');

const RELATIONS_COLLECTION = 'relations';

/**
 * Fire the relation-specific Neo4j delete sync and require queue acceptance.
 * The transactionally-created outbox marker remains until the graph worker
 * confirms deletion, so an unavailable dispatcher cannot lose the relation ID.
 */
async function triggerRelationDeleteSync(
  relationId: string,
  deleteToken: string,
  correlationId: string
): Promise<void> {
  let acknowledged = false;
  try {
    const { inngest } = await import('@/lib/inngest/client');
    const result = await inngest.send({
      id: relationDeleteSyncEventId(deleteToken, 0),
      name: 'app/relation.sync.requested',
      data: { operation: 'delete', relationId, deleteToken, correlationId },
    });
    acknowledged = Boolean(result.ids?.length);
  } catch (err) {
    log.warn('relation delete sync failed', {
      relationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  requireRelationSyncAcknowledgement(acknowledged, relationId, 'delete');
}

/**
 * Delete every relation whose source or target is `entityId`, and drop the
 * mirrored graph edges/Assertions for each. Returns the number of relation
 * docs deleted.
 */
export async function adminDeleteRelationsForEntity(
  entityId: string,
  context: CorrelationContext = {}
): Promise<number> {
  const correlationId = resolveCorrelationId(context.correlationId);
  const [sourceSnap, targetSnap] = await Promise.all([
    db.collection(RELATIONS_COLLECTION).where('sourceSnapshot.id', '==', entityId).get(),
    db.collection(RELATIONS_COLLECTION).where('targetSnapshot.id', '==', entityId).get(),
  ]);

  // Deduplicate (a self-referential relation appears in both snapshots).
  const uniqueIds = [...new Set([...sourceSnap.docs, ...targetSnap.docs].map((relationDoc) => relationDoc.id))];

  if (uniqueIds.length === 0) return 0;

  const deletedIds = await adminDeleteRelationsWithOwnedLocks(
    uniqueIds.map((id) => ({ id })),
    {
      correlationId,
      // Fan out after every committed chunk, before another chunk can fail.
      onChunkDeleted: async (_ids, dispatches) => {
        await Promise.all(
          dispatches.map(({ relationId, deleteToken }) =>
            triggerRelationDeleteSync(relationId, deleteToken, correlationId)
          )
        );
      },
    }
  );

  return deletedIds.length;
}
