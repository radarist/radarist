/** @jest-environment node */

import { buildRelationTripleKey } from '@/lib/relations-triple-key';

type Ref = { collection: string; id: string };
type StoredRelation = {
  sourceSnapshot: { id: string };
  targetSnapshot: { id: string };
  relationType: 'uses';
};

const mockRelations = new Map<string, StoredRelation>();
const mockLocks = new Map<string, { relationId: string }>();
const mockTransactions: Array<{
  deletes: Ref[];
  updates: Array<{ ref: Ref; data: unknown }>;
  sets: Array<{ ref: Ref; data: unknown }>;
  gets: Ref[];
}> = [];
const mockRunTransaction = jest.fn(async (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => {
  const operations = {
    deletes: [] as Ref[],
    updates: [] as Array<{ ref: Ref; data: unknown }>,
    sets: [] as Array<{ ref: Ref; data: unknown }>,
    gets: [] as Ref[],
  };
  mockTransactions.push(operations);
  const tx = {
    get: jest.fn(async (ref: Ref) => {
      operations.gets.push(ref);
      const value = ref.collection === 'relations' ? mockRelations.get(ref.id) : mockLocks.get(ref.id);
      return { exists: () => value !== undefined, data: () => value };
    }),
    delete: jest.fn((ref: Ref) => operations.deletes.push(ref)),
    update: jest.fn((ref: Ref, data: unknown) => operations.updates.push({ ref, data })),
    set: jest.fn((ref: Ref, data: unknown) => operations.sets.push({ ref, data })),
  };
  return callback(tx);
});

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, collection: string, id: string) => ({ collection, id })),
  runTransaction: (db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
    mockRunTransaction(db, callback),
}));

import { deleteRelationsWithOwnedLocks } from '../relations-delete-client';

const CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

function relation(sourceId: string, targetId: string): StoredRelation {
  return { sourceSnapshot: { id: sourceId }, targetSnapshot: { id: targetId }, relationType: 'uses' };
}

describe('deleteRelationsWithOwnedLocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRelations.clear();
    mockLocks.clear();
    mockTransactions.length = 0;
  });

  it('re-reads current topology and never deletes a lock taken over by another relation', async () => {
    mockRelations.set('rel-1', relation('source', 'current-target'));
    const currentKey = buildRelationTripleKey('source', 'current-target', 'uses');
    mockLocks.set(currentKey, { relationId: 'rel-new-owner' });

    await expect(deleteRelationsWithOwnedLocks({} as never, [{ id: 'rel-1' }])).resolves.toEqual(['rel-1']);

    expect(mockTransactions[0].gets).toContainEqual({ collection: 'relationTriples', id: currentKey });
    expect(mockTransactions[0].deletes).toEqual([{ collection: 'relations', id: 'rel-1' }]);
    expect(mockTransactions[0].sets).toEqual([
      {
        ref: { collection: 'relationSyncOutbox', id: 'rel-1' },
        data: expect.objectContaining({ relationId: 'rel-1', operation: 'delete', status: 'pending' }),
      },
    ]);
  });

  it('persists a validated correlation token on the durable delete marker', async () => {
    mockRelations.set('rel-correlated', relation('source', 'target'));

    await deleteRelationsWithOwnedLocks(
      {} as never,
      [{ id: 'rel-correlated' }],
      { correlationId: CORRELATION_ID }
    );

    expect(mockTransactions[0].sets).toEqual([
      {
        ref: { collection: 'relationSyncOutbox', id: 'rel-correlated' },
        data: expect.objectContaining({ correlationId: CORRELATION_ID }),
      },
    ]);
  });

  it('rejects malformed correlation text before opening a transaction', async () => {
    await expect(
      deleteRelationsWithOwnedLocks(
        {} as never,
        [{ id: 'rel-invalid' }],
        { correlationId: 'private arbitrary text' }
      )
    ).rejects.toThrow('Invalid correlation ID');

    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('deletes an owned lock and transfers duplicate ownership when a replacement is declared', async () => {
    mockRelations.set('rel-delete', relation('source', 'target'));
    const key = buildRelationTripleKey('source', 'target', 'uses');
    mockLocks.set(key, { relationId: 'rel-delete' });

    await deleteRelationsWithOwnedLocks(
      {} as never,
      [{ id: 'rel-delete', replacementRelationId: 'rel-keep' }]
    );

    expect(mockTransactions[0].deletes).toEqual([{ collection: 'relations', id: 'rel-delete' }]);
    expect(mockTransactions[0].updates).toEqual([
      { ref: { collection: 'relationTriples', id: key }, data: { relationId: 'rel-keep' } },
    ]);
  });

  it('caps relation, lock, and outbox writes below 500 and fans out each committed chunk', async () => {
    for (let index = 0; index < 161; index++) {
      const id = `rel-${index}`;
      const targetId = `target-${index}`;
      mockRelations.set(id, relation('source', targetId));
      mockLocks.set(buildRelationTripleKey('source', targetId, 'uses'), { relationId: id });
    }
    const onChunkDeleted = jest.fn().mockResolvedValue(undefined);

    const deleted = await deleteRelationsWithOwnedLocks(
      {} as never,
      [...mockRelations.keys()].map((id) => ({ id })),
      { onChunkDeleted }
    );

    expect(deleted).toHaveLength(161);
    expect(mockTransactions).toHaveLength(2);
    expect(mockTransactions.map((transaction) => transaction.deletes.length)).toEqual([180, 142]);
    expect(mockTransactions.map((transaction) => transaction.sets.length)).toEqual([90, 71]);
    expect(
      mockTransactions.every(
        (transaction) => transaction.deletes.length + transaction.sets.length <= 450
      )
    ).toBe(true);
    expect(onChunkDeleted).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['rel-0', 'rel-89']),
      expect.arrayContaining([
        expect.objectContaining({ relationId: 'rel-0', deleteToken: expect.any(String) }),
        expect.objectContaining({ relationId: 'rel-89', deleteToken: expect.any(String) }),
      ])
    );
    expect(onChunkDeleted).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['rel-90', 'rel-160']),
      expect.arrayContaining([
        expect.objectContaining({ relationId: 'rel-90', deleteToken: expect.any(String) }),
        expect.objectContaining({ relationId: 'rel-160', deleteToken: expect.any(String) }),
      ])
    );
  });
});
