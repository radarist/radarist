import { inngest } from '../client';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  MAX_RELATION_DELETE_ATTEMPTS,
  parseRelationDeleteOutboxRecord,
  planRelationDeleteReplay,
  RELATION_DELETE_REPLAY_DELAY_MS,
  RELATION_SYNC_OUTBOX_COLLECTION,
  relationDeleteSyncEventId,
} from '@/lib/relation-sync-outbox';

const log = createLogger('inngest/replay-relation-delete-outbox');
const REPLAY_BATCH_SIZE = 100;

export const replayRelationDeleteOutboxJob = inngest.createFunction(
  {
    id: 'replay-relation-delete-outbox',
    name: 'Replay Relation Delete Outbox',
    retries: 2,
  },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const claims = await step.run('load-pending-relation-deletes', async () => {
      const now = Date.now();
      // GRAPH-059: `status == 'pending'` is what makes exhaustion terminal AND
      // keeps the batch budget for markers that can still make progress — an
      // in-memory filter would let accumulated exhausted markers, whose
      // nextAttemptAt is permanently in the past, starve the live ones.
      const snapshot = await db
        .collection(RELATION_SYNC_OUTBOX_COLLECTION)
        .where('status', '==', 'pending')
        .where('nextAttemptAt', '<=', now)
        .orderBy('nextAttemptAt', 'asc')
        .limit(REPLAY_BATCH_SIZE)
        .get();
      const claimed = await Promise.all(
        snapshot.docs.map(async (document) => {
          const record = parseRelationDeleteOutboxRecord(document.id, document.data());
          if (!record) {
            log.error('Malformed relation delete outbox marker', undefined, { markerId: document.id });
            return null;
          }
          if (record.status !== 'pending' || record.nextAttemptAt > now) return null;

          return db.runTransaction(async (transaction) => {
            const markerRef = db.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(document.id);
            const currentSnapshot = await transaction.get(markerRef);
            const current = currentSnapshot.exists
              ? parseRelationDeleteOutboxRecord(document.id, currentSnapshot.data())
              : null;
            if (
              !current ||
              current.deleteToken !== record.deleteToken ||
              current.status !== 'pending' ||
              current.nextAttemptAt > now
            ) {
              return null;
            }

            const decision = planRelationDeleteReplay(current, {
              now,
              delayMs: RELATION_DELETE_REPLAY_DELAY_MS,
              maxAttempts: MAX_RELATION_DELETE_ATTEMPTS,
            });
            transaction.update(markerRef, decision.updates);
            return {
              kind: decision.kind,
              relationId: current.relationId,
              deleteToken: current.deleteToken,
              correlationId: current.correlationId,
              attempt: decision.attempt,
            };
          });
        })
      );
      return claimed.filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    });

    // The pending -> exhausted transition happens inside the claim transaction
    // above and is unrepeatable, so this is the one and only report per marker.
    const exhausted = claims.filter((claim) => claim.kind === 'exhausted');
    if (exhausted.length > 0) {
      log.error(
        'Relation delete markers exhausted their replay budget — the Neo4j projection may still exist',
        undefined,
        {
          maxAttempts: MAX_RELATION_DELETE_ATTEMPTS,
          exhausted: exhausted.map(({ relationId, deleteToken, attempt }) => ({
            relationId,
            deleteToken,
            attempt,
          })),
        }
      );
    }

    const pending = claims.filter((claim) => claim.kind === 'dispatch');
    if (pending.length === 0) return { dispatched: 0, exhausted: exhausted.length };

    await step.sendEvent(
      'dispatch-pending-relation-deletes',
      pending.map(({ relationId, deleteToken, correlationId, attempt }) => ({
        id: relationDeleteSyncEventId(deleteToken, attempt),
        name: 'app/relation.sync.requested' as const,
        data: {
          operation: 'delete' as const,
          relationId,
          deleteToken,
          ...(correlationId ? { correlationId } : {}),
        },
      }))
    );
    return { dispatched: pending.length, exhausted: exhausted.length };
  }
);
