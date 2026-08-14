/**
 * GRAPH-058 + GRAPH-059 — real-Firestore acceptance for the two durable outboxes
 * this lane made truthful.
 *
 * Everything here runs against a REAL Firestore emulator through the production
 * Admin-SDK repositories. Nothing is mocked: the recovery anchor a browser writes
 * and the delete marker the relation deleter writes are the same documents these
 * assertions read back, and the bounded retry policy is applied through the same
 * pure planner the replayer uses.
 *
 * GRAPH-058 (per library entity type, all eight):
 *   1. saved-local     — an anchor exists after a lost handoff;
 *   2. reload          — a fresh listing reconstructs it, scoped to its type;
 *   3. Retry           — a dispatch is recorded WITHOUT retiring the anchor;
 *   4. convergence     — only a generation-matched clear retires it;
 *   5. exhaustion      — the attempt bound is terminal and idempotent.
 *
 * GRAPH-059 (relation delete outbox):
 *   6. a permanent failure exhausts exactly once and stops being claimable;
 *   7. a transient failure inside the budget still converges;
 *   8. replay is idempotent — a re-run neither re-exhausts nor re-dispatches.
 *
 * @jest-environment node
 */

export {};

import { db as adminDb } from '@/lib/firebase-admin';
import {
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  MAX_ENTITY_GRAPH_SYNC_ATTEMPTS,
  advanceEntityGraphSyncOutboxRecord,
  entityGraphSyncOutboxDocumentId,
  markEntityGraphSyncOutboxDispatched,
  parseEntityGraphSyncOutboxRecord,
} from '@/lib/entity-graph-sync-outbox';
import {
  clearConvergedEntityGraphSyncAnchor,
  listEntityGraphSyncAnchorsForType,
  readEntityGraphSyncAnchor,
  recordEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-admin';
import { LIBRARY_ENTITY_SYNC_TYPES, type LibraryEntitySyncType } from '@/lib/entity-sync-contract';
import { LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME } from '@/lib/mutation-outcome/coverage';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import {
  MAX_RELATION_DELETE_ATTEMPTS,
  RELATION_DELETE_REPLAY_DELAY_MS,
  RELATION_SYNC_OUTBOX_COLLECTION,
  buildRelationDeleteOutboxRecord,
  createRelationDeleteToken,
  parseRelationDeleteOutboxRecord,
  planRelationDeleteReplay,
} from '@/lib/relation-sync-outbox';

const PREFIX = 'graph-recovery-lifecycle-';

async function deleteOwnedDocuments(): Promise<void> {
  for (const collectionName of [ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, RELATION_SYNC_OUTBOX_COLLECTION]) {
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await adminDb.collection(collectionName).get();
    const owned = snapshot.docs.filter((document) => document.id.includes(PREFIX));
    if (owned.length === 0) continue;
    const batch = adminDb.batch();
    for (const document of owned) batch.delete(document.ref);
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
    throw new Error(`This acceptance requires a loopback Firestore emulator, got "${host}"`);
  }
  await deleteOwnedDocuments();
});

afterAll(async () => {
  await deleteOwnedDocuments();
});

// ============================================================================
// GRAPH-058 — per-type saved-locally recovery against real Firestore
// ============================================================================

describe('GRAPH-058 durable recovery anchor, per library entity type', () => {
  it('covers every library entity type', () => {
    expect([...LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME].sort()).toEqual([...LIBRARY_ENTITY_SYNC_TYPES].sort());
  });

  describe.each(LIBRARY_ENTITY_SYNC_TYPES.map((entityType) => ({ entityType })))(
    '$entityType',
    ({ entityType }: { entityType: LibraryEntitySyncType }) => {
      const entityId = `${PREFIX}${entityType}-1`;
      const anchorId = entityGraphSyncOutboxDocumentId(entityType, entityId);

      afterEach(async () => {
        await adminDb.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).doc(anchorId).delete();
      });

      it('records, reconstructs, survives a retry, and clears only on convergence', async () => {
        // 1 — saved-local. The dispatch error is the exact one a committed write
        // raises when its graph handoff is lost.
        const dispatchError = new EntitySyncDispatchError(
          entityType,
          entityId,
          'update',
          new Error('graph queue unreachable')
        );
        const recorded = await recordEntityGraphSyncAnchor({
          entityType,
          entityId,
          operation: 'update',
          error: dispatchError,
        });
        expect(recorded).toMatchObject({ entityType, entityId, status: 'pending', attempt: 0 });

        // The document really is on disk and parses strictly.
        const stored = await adminDb.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).doc(anchorId).get();
        expect(stored.exists).toBe(true);
        expect(parseEntityGraphSyncOutboxRecord(anchorId, stored.data())).not.toBeNull();

        // 2 — reload reconstruction, scoped to this type.
        const listed = await listEntityGraphSyncAnchorsForType(entityType);
        expect(listed.map((anchor) => anchor.entityId)).toContain(entityId);
        for (const anchor of listed) expect(anchor.entityType).toBe(entityType);

        const generation = recorded!.generation;

        // 3 — an accepted retry records the dispatch and does NOT retire the debt.
        await adminDb
          .collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION)
          .doc(anchorId)
          .set(markEntityGraphSyncOutboxDispatched(recorded!, 1_700_000_000_000));
        const afterDispatch = await readEntityGraphSyncAnchor(entityType, entityId);
        expect(afterDispatch).toMatchObject({
          status: 'pending',
          attempt: 0,
          lastDispatchedAt: 1_700_000_000_000,
          generation,
        });

        // 4a — a stale generation must not clear a live debt.
        await expect(clearConvergedEntityGraphSyncAnchor(entityType, entityId, 'f'.repeat(32))).resolves.toBe(
          'superseded'
        );
        expect(await readEntityGraphSyncAnchor(entityType, entityId)).not.toBeNull();

        // 4b — only the server, holding the generation it projected, retires it.
        await expect(clearConvergedEntityGraphSyncAnchor(entityType, entityId, generation)).resolves.toBe('cleared');
        expect(await readEntityGraphSyncAnchor(entityType, entityId)).toBeNull();
        // Reload after convergence shows nothing.
        expect((await listEntityGraphSyncAnchorsForType(entityType)).map((a) => a.entityId)).not.toContain(entityId);
      });

      it('terminates at the attempt bound and stays terminal', async () => {
        const recorded = await recordEntityGraphSyncAnchor({
          entityType,
          entityId,
          operation: 'create',
          error: new Error('graph queue unreachable'),
        });
        let current = recorded!;

        for (let attempt = 1; attempt <= MAX_ENTITY_GRAPH_SYNC_ATTEMPTS; attempt += 1) {
          current = advanceEntityGraphSyncOutboxRecord(current, { lastError: `attempt ${attempt} failed` });
          // eslint-disable-next-line no-await-in-loop
          await adminDb.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).doc(anchorId).set(current);
        }

        const exhausted = await readEntityGraphSyncAnchor(entityType, entityId);
        expect(exhausted).toMatchObject({
          status: 'exhausted',
          attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS,
        });

        // Advancing past the bound cannot inflate the counter or leave the
        // terminal state — the record is a fixpoint.
        const again = advanceEntityGraphSyncOutboxRecord(exhausted!, { lastError: 'one more' });
        expect(again).toMatchObject({ status: 'exhausted', attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS });

        // Exhaustion is a client retry budget, not a lost write: the debt is still
        // clearable by server-side convergence.
        await expect(clearConvergedEntityGraphSyncAnchor(entityType, entityId, exhausted!.generation)).resolves.toBe(
          'cleared'
        );
      });
    }
  );
});

// ============================================================================
// GRAPH-059 — bounded relation delete replay against real Firestore
// ============================================================================

describe('GRAPH-059 bounded relation delete outbox', () => {
  const markerRef = (relationId: string) => adminDb.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(relationId);

  /**
   * One replay sweep, using the production query and the production policy.
   * Returns what the replayer would have dispatched or terminated.
   */
  async function sweep(now: number): Promise<{ dispatched: string[]; exhausted: string[] }> {
    const snapshot = await adminDb
      .collection(RELATION_SYNC_OUTBOX_COLLECTION)
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', now)
      .orderBy('nextAttemptAt', 'asc')
      .limit(100)
      .get();

    const dispatched: string[] = [];
    const exhausted: string[] = [];
    for (const document of snapshot.docs) {
      if (!document.id.includes(PREFIX)) continue;
      const record = parseRelationDeleteOutboxRecord(document.id, document.data());
      if (!record) continue;
      const decision = planRelationDeleteReplay(record, { now });
      // eslint-disable-next-line no-await-in-loop
      await markerRef(document.id).update(decision.updates);
      if (decision.kind === 'dispatch') dispatched.push(document.id);
      else exhausted.push(document.id);
    }
    return { dispatched, exhausted };
  }

  it('exhausts a permanently failing marker exactly once and never claims it again', async () => {
    const relationId = `${PREFIX}relation-permanent`;
    const token = createRelationDeleteToken(relationId);
    await markerRef(relationId).set(buildRelationDeleteOutboxRecord(relationId, token, 0));

    // A fresh marker is due one replay delay after it was written, and each sweep
    // re-arms that delay — so walk the clock at exactly the production cadence.
    let now = RELATION_DELETE_REPLAY_DELAY_MS;
    const dispatchCounts: number[] = [];
    for (let round = 0; round < MAX_RELATION_DELETE_ATTEMPTS; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await sweep(now);
      dispatchCounts.push(result.dispatched.length);
      expect(result.exhausted).toEqual([]);
      now += RELATION_DELETE_REPLAY_DELAY_MS;
    }
    expect(dispatchCounts).toEqual(Array.from({ length: MAX_RELATION_DELETE_ATTEMPTS }, () => 1));

    // The budget is spent: the next sweep terminates instead of dispatching.
    const terminal = await sweep(now);
    expect(terminal.dispatched).toEqual([]);
    expect(terminal.exhausted).toEqual([relationId]);

    const exhausted = parseRelationDeleteOutboxRecord(relationId, (await markerRef(relationId).get()).data());
    expect(exhausted).toMatchObject({
      status: 'exhausted',
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      exhaustedAt: now,
    });

    // Idempotent replay: a further sweep sees nothing, so the terminal
    // transition — and its one operator-visible report — happens exactly once.
    now += RELATION_DELETE_REPLAY_DELAY_MS;
    await expect(sweep(now)).resolves.toEqual({ dispatched: [], exhausted: [] });
    const unchanged = parseRelationDeleteOutboxRecord(relationId, (await markerRef(relationId).get()).data());
    expect(unchanged).toEqual(exhausted);

    await markerRef(relationId).delete();
  });

  it('lets a transient failure converge inside the budget', async () => {
    const relationId = `${PREFIX}relation-transient`;
    const token = createRelationDeleteToken(relationId);
    await markerRef(relationId).set(buildRelationDeleteOutboxRecord(relationId, token, 0));

    let now = RELATION_DELETE_REPLAY_DELAY_MS;
    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sweep(now);
      now += RELATION_DELETE_REPLAY_DELAY_MS;
    }
    const midFlight = parseRelationDeleteOutboxRecord(relationId, (await markerRef(relationId).get()).data());
    expect(midFlight).toMatchObject({ status: 'pending', attempt: 3 });

    // The graph teardown finally succeeds: the sync handler removes the marker.
    await markerRef(relationId).delete();

    expect((await markerRef(relationId).get()).exists).toBe(false);
    await expect(sweep(now)).resolves.toEqual({ dispatched: [], exhausted: [] });
  });

  it('keeps an exhausted marker out of the claimable query so it cannot starve live ones', async () => {
    const doomedId = `${PREFIX}relation-doomed`;
    const freshId = `${PREFIX}relation-fresh`;
    await markerRef(doomedId).set({
      ...buildRelationDeleteOutboxRecord(doomedId, createRelationDeleteToken(doomedId), 0),
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      status: 'exhausted',
      exhaustedAt: 5,
    });
    await markerRef(freshId).set(buildRelationDeleteOutboxRecord(freshId, createRelationDeleteToken(freshId), 0));

    const result = await sweep(1_000_000);

    expect(result.dispatched).toEqual([freshId]);
    expect(result.exhausted).toEqual([]);

    await markerRef(doomedId).delete();
    await markerRef(freshId).delete();
  });

  it('reads a terminal marker back through the operator-facing census query', async () => {
    const relationId = `${PREFIX}relation-census`;
    await markerRef(relationId).set({
      ...buildRelationDeleteOutboxRecord(relationId, createRelationDeleteToken(relationId), 0),
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      status: 'exhausted',
      exhaustedAt: 9_000,
      lastError: 'Neo4j refused the connection',
    });

    // The exact query the daily failure digest runs.
    const snapshot = await adminDb.collection(RELATION_SYNC_OUTBOX_COLLECTION).where('status', '==', 'exhausted').get();
    const owned = snapshot.docs
      .filter((document) => document.id.includes(PREFIX))
      .map((document) => parseRelationDeleteOutboxRecord(document.id, document.data()));

    expect(owned).toEqual([
      expect.objectContaining({
        relationId,
        status: 'exhausted',
        exhaustedAt: 9_000,
        lastError: 'Neo4j refused the connection',
      }),
    ]);

    await markerRef(relationId).delete();
  });
});
