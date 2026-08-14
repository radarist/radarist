/**
 * @jest-environment node
 *
 * Disposable Firestore proof for the production Admin relation-delete
 * transaction. This suite is opt-in and refuses non-loopback or non-demo data.
 */
import { deleteApp, type App } from 'firebase-admin/app';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

import {
  RELATION_DELETE_REPLAY_DELAY_MS,
  RELATION_SYNC_OUTBOX_COLLECTION,
  type RelationDeleteOutboxRecord,
} from '@/lib/relation-sync-outbox';
import {
  buildRelationTripleLockKeyCandidates,
  buildRelationTripleLockEntry,
  RELATION_LOCK_AWARE_DELETE_BATCH_SIZE,
  RELATION_TRIPLE_LOCK_COLLECTION,
  type RelationTripleLockDocument,
} from '@/lib/relations-triple-key';
import type {
  RelationDeleteDispatch,
  RelationDeleteOptions,
  RelationDeleteTarget,
} from '@/lib/relations-delete-client';
import type { Relation } from '@/lib/types';

const PROJECT_ID = 'demo-radarist';
const requested = process.env.RELATION_DELETE_OUTBOX_INTEGRATION === '1';
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const configuredProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT;

function isLoopbackEmulator(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

if (requested) {
  if (!isLoopbackEmulator(emulatorHost)) {
    throw new Error('Relation delete integration requires a loopback FIRESTORE_EMULATOR_HOST');
  }
  if (configuredProject !== PROJECT_ID) {
    throw new Error(`Relation delete integration requires disposable project ${PROJECT_ID}`);
  }
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR = 'true';
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT_ID;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
}

const describeIntegration = requested ? describe : describe.skip;
const PREFIX = `relation-delete-outbox-int-${Date.now()}`;

interface SeededRelation {
  relationId: string;
  lockId: string;
  relation: Record<string, unknown>;
  lock: RelationTripleLockDocument;
}

describeIntegration('Admin relation delete outbox (disposable Firestore)', () => {
  let app: App;
  let db: Firestore;
  let adminDeleteRelationsWithOwnedLocks: (
    targets: readonly RelationDeleteTarget[],
    options?: RelationDeleteOptions
  ) => Promise<string[]>;
  let adminUpdateRelation: (id: string, updates: Partial<Omit<Relation, 'id' | 'createdAt'>>) => Promise<Relation>;
  const cleanupRefs: Array<{ collection: string; id: string }> = [];

  beforeAll(async () => {
    const firebaseAdmin = await import('@/lib/firebase-admin');
    const relationDeleteAdmin = await import('@/lib/relations-delete-admin');
    const relationsAdmin = await import('@/lib/relations-admin');
    app = firebaseAdmin.adminApp;
    db = firebaseAdmin.db;
    adminDeleteRelationsWithOwnedLocks = relationDeleteAdmin.adminDeleteRelationsWithOwnedLocks;
    adminUpdateRelation = relationsAdmin.adminUpdateRelation;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (cleanupRefs.length === 0) return;
    const cleanup = db.batch();
    for (const ref of cleanupRefs) cleanup.delete(db.collection(ref.collection).doc(ref.id));
    cleanupRefs.splice(0);
    await cleanup.commit();
  });

  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seedOwnedRelation(suffix: string): Promise<SeededRelation> {
    const relationId = `${PREFIX}-${suffix}`;
    const sourceId = `${relationId}-source`;
    const targetId = `${relationId}-target`;
    const relation = {
      id: relationId,
      relationType: 'uses',
      sourceSnapshot: {
        id: sourceId,
        type: 'technology',
        name: 'Disposable source',
        snapshotAt: 1,
      },
      targetSnapshot: {
        id: targetId,
        type: 'technology',
        name: 'Disposable target',
        snapshotAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const lockEntry = buildRelationTripleLockEntry(relationId, sourceId, targetId, 'uses', 1);
    const relationRef = db.collection('relations').doc(relationId);
    const lockRef = db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(lockEntry.id);
    const outboxRef = db.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(relationId);
    cleanupRefs.push(
      { collection: 'relations', id: relationId },
      { collection: RELATION_TRIPLE_LOCK_COLLECTION, id: lockEntry.id },
      { collection: RELATION_SYNC_OUTBOX_COLLECTION, id: relationId }
    );

    const seed = db.batch();
    seed.set(relationRef, relation);
    seed.set(lockRef, lockEntry.data);
    seed.delete(outboxRef);
    await seed.commit();

    return {
      relationId,
      lockId: lockEntry.id,
      relation,
      lock: lockEntry.data,
    };
  }

  async function readDeleteState(seed: SeededRelation) {
    const [relation, lock, outbox] = await db.getAll(
      db.collection('relations').doc(seed.relationId),
      db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(seed.lockId),
      db.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(seed.relationId)
    );
    return { relation, lock, outbox };
  }

  it('atomically removes the relation and owned lock while creating a replayable marker', async () => {
    const seeded = await seedOwnedRelation('committed');
    const onChunkDeleted = jest.fn(
      async (_relationIds: readonly string[], _dispatches: readonly RelationDeleteDispatch[]) => undefined
    );

    await expect(adminDeleteRelationsWithOwnedLocks([{ id: seeded.relationId }], { onChunkDeleted })).resolves.toEqual([
      seeded.relationId,
    ]);

    const state = await readDeleteState(seeded);
    expect(state.relation.exists).toBe(false);
    expect(state.lock.exists).toBe(false);
    expect(state.outbox.exists).toBe(true);

    const marker = state.outbox.data() as RelationDeleteOutboxRecord;
    expect(marker).toEqual({
      relationId: seeded.relationId,
      deleteToken: expect.stringMatching(new RegExp(`^${seeded.relationId}:\\d+:`)),
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: expect.any(Number),
      // GRAPH-059: a fresh marker is pending with no terminal instant and no
      // recorded reason — the bounded policy has not spent anything yet.
      lastError: null,
      exhaustedAt: null,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(marker.updatedAt).toBe(marker.createdAt);
    expect(marker.nextAttemptAt).toBe(marker.createdAt + RELATION_DELETE_REPLAY_DELAY_MS);
    expect(onChunkDeleted).toHaveBeenCalledWith(
      [seeded.relationId],
      [{ relationId: seeded.relationId, deleteToken: marker.deleteToken }]
    );
  });

  it('rolls back all staged writes when the real emulator transaction aborts', async () => {
    const seeded = await seedOwnedRelation('aborted');
    const originalRunTransaction = db.runTransaction.bind(db);
    const abortAfterProductionCallback = (async (updateFunction: (transaction: Transaction) => Promise<unknown>) =>
      originalRunTransaction(async (transaction) => {
        await updateFunction(transaction);
        throw new Error('synthetic transaction abort after staged writes');
      })) as Firestore['runTransaction'];
    jest.spyOn(db, 'runTransaction').mockImplementation(abortAfterProductionCallback);

    await expect(adminDeleteRelationsWithOwnedLocks([{ id: seeded.relationId }])).rejects.toThrow(
      'synthetic transaction abort after staged writes'
    );

    const state = await readDeleteState(seeded);
    expect(state.relation.data()).toEqual(seeded.relation);
    expect(state.lock.data()).toEqual(seeded.lock);
    expect(state.outbox.exists).toBe(false);
  });

  it('does not replace the durable marker when deletion is retried after commit', async () => {
    const seeded = await seedOwnedRelation('repeated');

    await expect(adminDeleteRelationsWithOwnedLocks([{ id: seeded.relationId }])).resolves.toEqual([seeded.relationId]);
    const firstState = await readDeleteState(seeded);
    const originalMarker = firstState.outbox.data();
    expect(originalMarker).toBeDefined();

    const repeatedCallback = jest.fn(async () => undefined);
    await expect(
      adminDeleteRelationsWithOwnedLocks([{ id: seeded.relationId }], { onChunkDeleted: repeatedCallback })
    ).resolves.toEqual([]);

    const repeatedState = await readDeleteState(seeded);
    expect(repeatedState.relation.exists).toBe(false);
    expect(repeatedState.lock.exists).toBe(false);
    expect(repeatedState.outbox.data()).toEqual(originalMarker);
    expect(repeatedCallback).not.toHaveBeenCalled();
  });

  it('rejects a topology move onto an existing legacy row with no lock', async () => {
    const sourceId = `${PREFIX}-unlocked-source`;
    const oldTargetId = `${PREFIX}-unlocked-old-target`;
    const occupiedTargetId = `${PREFIX}-unlocked-occupied-target`;
    const movingId = `${PREFIX}-unlocked-moving`;
    const occupiedId = `${PREFIX}-unlocked-existing`;
    const snapshot = (id: string, name: string) => ({
      id,
      type: 'technology' as const,
      name,
      snapshotAt: 1,
    });
    const moving = {
      id: movingId,
      relationType: 'uses' as const,
      sourceSnapshot: snapshot(sourceId, 'Source'),
      targetSnapshot: snapshot(oldTargetId, 'Old target'),
      createdAt: 1,
      updatedAt: 1,
    };
    const occupied = {
      id: occupiedId,
      relationType: 'uses' as const,
      sourceSnapshot: snapshot(sourceId, 'Source'),
      targetSnapshot: snapshot(occupiedTargetId, 'Occupied target'),
      createdAt: 1,
      updatedAt: 1,
    };
    cleanupRefs.push({ collection: 'relations', id: movingId }, { collection: 'relations', id: occupiedId });
    const seed = db.batch();
    seed.set(db.collection('relations').doc(movingId), moving);
    seed.set(db.collection('relations').doc(occupiedId), occupied);
    await seed.commit();

    await expect(
      adminUpdateRelation(movingId, {
        targetSnapshot: snapshot(occupiedTargetId, 'Occupied target'),
      })
    ).rejects.toMatchObject({ name: 'DuplicateRelationError' });

    await expect(db.collection('relations').doc(movingId).get()).resolves.toMatchObject({
      exists: true,
    });
    const movingAfter = await db.collection('relations').doc(movingId).get();
    expect(movingAfter.get('targetSnapshot.id')).toBe(oldTargetId);
    const destinationLock = buildRelationTripleLockEntry(movingId, sourceId, occupiedTargetId, 'uses', 1);
    cleanupRefs.push({ collection: RELATION_TRIPLE_LOCK_COLLECTION, id: destinationLock.id });
    await expect(db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(destinationLock.id).get()).resolves.toMatchObject({
      exists: false,
    });
  });

  it('commits the maximum lock-aware delete chunk below Firestore write limits', async () => {
    const targets: RelationDeleteTarget[] = [];
    const seed = db.batch();
    for (let index = 0; index < RELATION_LOCK_AWARE_DELETE_BATCH_SIZE; index += 1) {
      const relationId = `${PREFIX}-max-shape-${index}`;
      const sourceId = `${relationId}-source`;
      const targetId = `${relationId}-target`;
      const relation = {
        id: relationId,
        relationType: 'parallels',
        sourceSnapshot: {
          id: sourceId,
          type: 'signal',
          name: `Source ${index}`,
          snapshotAt: 1,
        },
        targetSnapshot: {
          id: targetId,
          type: 'signal',
          name: `Target ${index}`,
          snapshotAt: 1,
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const lockKeys = buildRelationTripleLockKeyCandidates(sourceId, targetId, 'parallels');
      expect(lockKeys).toHaveLength(3);
      targets.push({ id: relationId });
      seed.set(db.collection('relations').doc(relationId), relation);
      cleanupRefs.push(
        { collection: 'relations', id: relationId },
        { collection: RELATION_SYNC_OUTBOX_COLLECTION, id: relationId }
      );
      for (const [lockIndex, lockId] of lockKeys.entries()) {
        seed.set(db.collection(RELATION_TRIPLE_LOCK_COLLECTION).doc(lockId), {
          relationId,
          sourceId,
          targetId,
          relationType: 'parallels',
          createdAt: 1,
          ...(lockIndex === 0 ? { keyVersion: 2 } : {}),
        });
        cleanupRefs.push({ collection: RELATION_TRIPLE_LOCK_COLLECTION, id: lockId });
      }
    }
    await seed.commit();
    const onChunkDeleted = jest.fn(
      async (_relationIds: readonly string[], _dispatches: readonly RelationDeleteDispatch[]) => undefined
    );

    await expect(adminDeleteRelationsWithOwnedLocks(targets, { onChunkDeleted })).resolves.toEqual(
      targets.map(({ id }) => id)
    );
    expect(onChunkDeleted).toHaveBeenCalledTimes(1);
    expect(onChunkDeleted.mock.calls[0][0]).toHaveLength(RELATION_LOCK_AWARE_DELETE_BATCH_SIZE);

    const remainingRelations = await db.collection('relations').where('relationType', '==', 'parallels').get();
    expect(remainingRelations.docs.filter((document) => document.id.startsWith(`${PREFIX}-max-shape-`))).toEqual([]);
    const remainingLocks = await db.collection(RELATION_TRIPLE_LOCK_COLLECTION).get();
    expect(
      remainingLocks.docs.filter((document) => String(document.get('relationId')).startsWith(`${PREFIX}-max-shape-`))
    ).toEqual([]);
    const outboxes = await Promise.all(
      targets.map(({ id }) => db.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(id).get())
    );
    expect(outboxes.every((document) => document.exists)).toBe(true);
  });
});
