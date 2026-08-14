/**
 * @file replay-placement-delete-outbox.ts
 * @description GRAPH-060 #1 — scheduled reconciliation that redrives durable
 * RadarPlacement delete tombstones whose graph removal was never acknowledged.
 * Mirrors `replay-relation-delete-outbox`: claim each due marker under a token
 * CAS (bump attempt + push nextAttemptAt), then re-dispatch a `delete` sync event
 * carrying the token so the sync handler removes the Neo4j node/edges and clears
 * the tombstone. The tombstone survives until Neo4j confirms — so a delete can
 * never be lost even though the Firestore doc is already gone.
 */
import { inngest } from '../client';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  parseRadarPlacementDeleteOutboxRecord,
  RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION,
  RADAR_PLACEMENT_DELETE_REPLAY_DELAY_MS,
  radarPlacementDeleteSyncEventId,
} from '@/lib/radar-placement-delete-outbox';

const log = createLogger('inngest/replay-placement-delete-outbox');
const REPLAY_BATCH_SIZE = 100;

export const replayPlacementDeleteOutboxJob = inngest.createFunction(
  {
    id: 'replay-placement-delete-outbox',
    name: 'Replay RadarPlacement Delete Outbox',
    retries: 2,
  },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const pending = await step.run('load-pending-placement-deletes', async () => {
      const now = Date.now();
      const snapshot = await db
        .collection(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION)
        .where('nextAttemptAt', '<=', now)
        .orderBy('nextAttemptAt', 'asc')
        .limit(REPLAY_BATCH_SIZE)
        .get();
      const claims = await Promise.all(
        snapshot.docs.map(async (document) => {
          const record = parseRadarPlacementDeleteOutboxRecord(document.id, document.data());
          if (!record) {
            log.error('Malformed placement delete outbox marker', undefined, { markerId: document.id });
            return null;
          }
          if (record.nextAttemptAt > now) return null;

          return db.runTransaction(async (transaction) => {
            const markerRef = db.collection(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION).doc(document.id);
            const currentSnapshot = await transaction.get(markerRef);
            const current = currentSnapshot.exists
              ? parseRadarPlacementDeleteOutboxRecord(document.id, currentSnapshot.data())
              : null;
            if (!current || current.deleteToken !== record.deleteToken || current.nextAttemptAt > now) {
              return null;
            }

            const attempt = current.attempt + 1;
            transaction.update(markerRef, {
              attempt,
              nextAttemptAt: now + RADAR_PLACEMENT_DELETE_REPLAY_DELAY_MS,
              updatedAt: now,
            });
            return { placementId: current.placementId, deleteToken: current.deleteToken, attempt };
          });
        })
      );
      return claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    });

    if (pending.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      'dispatch-pending-placement-deletes',
      pending.map(({ placementId, deleteToken, attempt }) => ({
        id: radarPlacementDeleteSyncEventId(deleteToken, attempt),
        name: 'app/radar-placement.sync.requested' as const,
        data: { operation: 'delete' as const, placementId, deleteToken },
      }))
    );
    return { dispatched: pending.length };
  }
);
