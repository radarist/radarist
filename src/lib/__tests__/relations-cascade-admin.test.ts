/**
 * F138: the shared entity-relation cascade must fire a delete sync for every
 * removed relation so the mirrored Neo4j edge/Assertion is dropped — the nine
 * per-entity copies previously deleted the Firestore docs but left orphan
 * graph edges behind.
 */

const mockSend = jest.fn();
const relationDocs: Array<{ id: string }> = [];

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockSend(...args) },
}));

const mockTransactionDelete = jest.fn();
const mockTransactionSet = jest.fn();
const mockRunTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback({
    get: async (ref: { collection: string; id: string }) => {
      if (ref.collection === 'relations' && relationDocs.some((relation) => relation.id === ref.id)) {
        return {
          exists: true,
          data: () => ({
            id: ref.id,
            relationType: 'uses',
            sourceSnapshot: { id: 'source' },
            targetSnapshot: { id: `target-${ref.id}` },
          }),
        };
      }
      return { exists: false, data: () => undefined };
    },
    delete: mockTransactionDelete,
    update: jest.fn(),
    set: mockTransactionSet,
  })
);

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (collection: string) => ({
      where: () => ({
        get: async () => ({ docs: relationDocs.map((d) => ({ id: d.id })) }),
      }),
      doc: (id: string) => ({ collection, id }),
    }),
    runTransaction: (callback: (tx: unknown) => Promise<unknown>) => mockRunTransaction(callback),
  },
}));

import { adminDeleteRelationsForEntity } from '../relations-cascade-admin';

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('adminDeleteRelationsForEntity (F138 delete-sync fan-out)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    relationDocs.length = 0;
    mockSend.mockResolvedValue({ ids: ['delete-sync-event'] });
  });

  it('returns 0 and fires nothing when the entity has no relations', async () => {
    const n = await adminDeleteRelationsForEntity('entity-x', {
      correlationId: TEST_CORRELATION_ID,
    });
    expect(n).toBe(0);
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deletes each relation and fires a delete sync per relation', async () => {
    // Both the source and target query return the same two ids — dedup to two.
    relationDocs.push({ id: 'rel-a' }, { id: 'rel-b' });

    const n = await adminDeleteRelationsForEntity('entity-x', {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(n).toBe(2);
    expect(mockTransactionDelete).toHaveBeenCalledTimes(2);
    // One delete-sync event per unique relation.
    const deleteEvents = mockSend.mock.calls
      .map((c) => c[0])
      .filter((e) => e?.name === 'app/relation.sync.requested' && e?.data?.operation === 'delete');
    expect(deleteEvents.map((e) => e.data.relationId).sort()).toEqual(['rel-a', 'rel-b']);
    expect(deleteEvents.map((event) => event.data.correlationId)).toEqual([
      TEST_CORRELATION_ID,
      TEST_CORRELATION_ID,
    ]);
    expect(mockTransactionSet).toHaveBeenCalledTimes(2);
    expect(
      mockTransactionSet.mock.calls.map(([, marker]) => marker.correlationId)
    ).toEqual([TEST_CORRELATION_ID, TEST_CORRELATION_ID]);
  });

  it('rejects caller-controlled correlation text before reading or deleting', async () => {
    relationDocs.push({ id: 'rel-a' });

    await expect(
      adminDeleteRelationsForEntity('entity-x', { correlationId: 'private customer note' })
    ).rejects.toThrow('Invalid correlation ID');
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('surfaces a failed handoff while retaining the durable delete marker', async () => {
    relationDocs.push({ id: 'rel-a' });
    mockSend.mockRejectedValueOnce(new Error('inngest down'));

    await expect(adminDeleteRelationsForEntity('entity-x')).rejects.toThrow('not acknowledged');
    expect(mockTransactionSet).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'relationSyncOutbox', id: 'rel-a' }),
      expect.objectContaining({ relationId: 'rel-a', status: 'pending' })
    );
  });
});
