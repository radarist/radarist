/** @jest-environment node */

type Ref = { collection: string; id: string };
type StoredRelation = {
  sourceSnapshot: { id: string };
  targetSnapshot: { id: string };
  relationType: 'uses';
};

const mockRelations = new Map<string, StoredRelation>();
const mockLocks = new Map<string, { relationId: string }>();
const mockDeletes: Ref[] = [];
const mockSets: Array<{ ref: Ref; data: unknown }> = [];
const mockRunTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    get: jest.fn(async (ref: Ref) => {
      const value = ref.collection === 'relations' ? mockRelations.get(ref.id) : mockLocks.get(ref.id);
      return { exists: value !== undefined, data: () => value };
    }),
    delete: jest.fn((ref: Ref) => mockDeletes.push(ref)),
    update: jest.fn(),
    set: jest.fn((ref: Ref, data: unknown) => mockSets.push({ ref, data })),
  };
  return callback(tx);
});

jest.mock('server-only', () => ({}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (collection: string) => ({ doc: (id: string) => ({ collection, id }) }),
    runTransaction: (callback: (tx: unknown) => Promise<unknown>) => mockRunTransaction(callback),
  },
}));

import { buildRelationTripleKey } from '@/lib/relations-triple-key';
import { adminDeleteRelationsWithOwnedLocks } from '../relations-delete-admin';

const CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('adminDeleteRelationsWithOwnedLocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRelations.clear();
    mockLocks.clear();
    mockDeletes.length = 0;
    mockSets.length = 0;
  });

  it('transactionally deletes the relation and only the lock it currently owns', async () => {
    mockRelations.set('rel-admin', {
      sourceSnapshot: { id: 'source' },
      targetSnapshot: { id: 'target' },
      relationType: 'uses',
    });
    const key = buildRelationTripleKey('source', 'target', 'uses');
    mockLocks.set(key, { relationId: 'rel-admin' });

    await expect(adminDeleteRelationsWithOwnedLocks([{ id: 'rel-admin' }])).resolves.toEqual(['rel-admin']);

    expect(mockDeletes).toEqual([
      { collection: 'relations', id: 'rel-admin' },
      { collection: 'relationTriples', id: key },
    ]);
    expect(mockSets).toEqual([
      {
        ref: { collection: 'relationSyncOutbox', id: 'rel-admin' },
        data: expect.objectContaining({ relationId: 'rel-admin', operation: 'delete', status: 'pending' }),
      },
    ]);
  });

  it('does not delete a lock whose ownership changed before the transaction snapshot', async () => {
    mockRelations.set('rel-admin', {
      sourceSnapshot: { id: 'source' },
      targetSnapshot: { id: 'target' },
      relationType: 'uses',
    });
    mockLocks.set(buildRelationTripleKey('source', 'target', 'uses'), { relationId: 'new-owner' });

    await adminDeleteRelationsWithOwnedLocks([{ id: 'rel-admin' }]);

    expect(mockDeletes).toEqual([{ collection: 'relations', id: 'rel-admin' }]);
  });

  it('persists a validated correlation token on the durable delete marker', async () => {
    mockRelations.set('rel-correlated', {
      sourceSnapshot: { id: 'source' },
      targetSnapshot: { id: 'target' },
      relationType: 'uses',
    });

    await adminDeleteRelationsWithOwnedLocks(
      [{ id: 'rel-correlated' }],
      { correlationId: CORRELATION_ID }
    );

    expect(mockSets).toEqual([
      {
        ref: { collection: 'relationSyncOutbox', id: 'rel-correlated' },
        data: expect.objectContaining({ correlationId: CORRELATION_ID }),
      },
    ]);
  });

  it('rejects malformed correlation text before opening a transaction', async () => {
    await expect(
      adminDeleteRelationsWithOwnedLocks(
        [{ id: 'rel-invalid' }],
        { correlationId: 'private arbitrary text' }
      )
    ).rejects.toThrow('Invalid correlation ID');

    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});
