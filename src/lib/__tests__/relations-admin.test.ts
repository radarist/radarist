/**
 * @jest-environment node
 *
 * Focused read-path tests for relations-admin (the highest-blast, previously-
 * untested admin twin). Covers adminGetRelationById + adminCheckDuplicateRelation
 * (the idempotency guard), plus the transactional triple-lock write path added
 * for LIVE-2 (adminCreateRelation / adminDeleteRelation).
 */
export {};

import type { Relation } from '@/lib/types';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['relation-sync-event'] }) },
}));

const mockQueryGet = jest.fn();
const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockDocUpdate = jest.fn();
const mockDocDelete = jest.fn();
const mockRunTransaction = jest.fn();

jest.mock('@/lib/firebase-admin', () => {
  const docRef = { get: mockDocGet, set: mockDocSet, update: mockDocUpdate, delete: mockDocDelete };
  const ref: Record<string, unknown> = { get: mockQueryGet, doc: jest.fn(() => docRef) };
  ref.where = jest.fn(() => ref);
  return { db: { collection: jest.fn(() => ref), runTransaction: mockRunTransaction } };
});

const {
  adminGetRelationById,
  adminCheckDuplicateRelation,
  adminCreateRelation,
  adminCreateRelationFromIds,
  adminUpdateRelation,
  adminUpdateRelationFromFreshState,
  adminDeleteRelation,
  adminCleanupOrphanedRelations,
  DuplicateRelationError,
} = require('../relations-admin');
const { RelationSyncDispatchError } = require('../relation-sync-dispatch');
const { relationProjectionFingerprint } = require('../graph/projection-reconciliation');
const { inngest: mockedInngest } = jest.requireMock('@/lib/inngest/client') as {
  inngest: { send: jest.Mock };
};

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

const docSnap = (data: unknown) => ({ exists: data !== null, id: 'rel-1', data: () => data });
const querySnap = (docs: object[]) => ({
  empty: docs.length === 0,
  docs: docs.map((d) => ({ data: () => d })),
});

/**
 * Wires the next `db.runTransaction(fn)` call to invoke `fn` with a fake
 * ADMIN transaction double. Admin SDK snapshots expose `.exists` as a
 * boolean property (unlike the client SDK's `.exists()` method) — mirrors
 * adminCreateRelationWithTripleLock's read sequence: first `tx.get(lockRef)`,
 * then — only when the lock exists — `tx.get(existingRelationRef)`.
 */
function mockTripleLockTransaction(
  opts: {
    lockExists?: boolean;
    lockData?: Record<string, unknown>;
    relationExists?: boolean;
    relationData?: Record<string, unknown>;
  } = {}
) {
  const txGet = jest.fn();
  txGet.mockResolvedValueOnce({
    exists: opts.lockExists ?? false,
    data: () => opts.lockData,
  });
  if (opts.lockExists) {
    txGet.mockResolvedValueOnce({
      exists: opts.relationExists ?? false,
      data: () => opts.relationData,
    });
  }
  const txSet = jest.fn();
  mockRunTransaction.mockImplementationOnce(async (fn: (tx: { get: typeof txGet; set: typeof txSet }) => unknown) =>
    fn({ get: txGet, set: txSet })
  );
  return { txGet, txSet };
}

function mockTripleMigrationTransaction(
  existing: Record<string, unknown>,
  opts: {
    newLockExists?: boolean;
    newLockOwner?: string;
    duplicateRelation?: Record<string, unknown> | null;
    queryDuplicates?: Array<Record<string, unknown>>;
  } = {}
) {
  mockDocGet.mockResolvedValueOnce(docSnap(existing));
  mockQueryGet.mockResolvedValueOnce(querySnap(opts.queryDuplicates ?? []));
  const txGet = jest.fn().mockResolvedValueOnce({ exists: true, data: () => existing });
  for (const duplicate of opts.queryDuplicates ?? []) {
    txGet.mockResolvedValueOnce({ exists: true, data: () => duplicate });
  }
  txGet
    .mockResolvedValueOnce({ exists: true, data: () => ({ relationId: existing.id }) })
    .mockResolvedValueOnce({
      exists: opts.newLockExists ?? false,
      data: () => ({ relationId: opts.newLockOwner }),
    });
  if (opts.newLockExists && opts.newLockOwner && opts.newLockOwner !== existing.id) {
    txGet.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    txGet.mockResolvedValueOnce({
      exists: opts.duplicateRelation != null,
      data: () => opts.duplicateRelation,
    });
  }
  const txSet = jest.fn();
  const txUpdate = jest.fn();
  const txDelete = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (fn: (tx: { get: typeof txGet; set: typeof txSet; update: typeof txUpdate; delete: typeof txDelete }) => unknown) =>
      fn({ get: txGet, set: txSet, update: txUpdate, delete: txDelete })
  );
  return { txGet, txSet, txUpdate, txDelete };
}

function mockAdminRelationDeleteTransaction(
  existing: Record<string, unknown>,
  lockOwner?: string,
  legacyLockOwner?: string
) {
  const txGet = jest
    .fn()
    .mockResolvedValueOnce({ exists: true, data: () => existing })
    .mockResolvedValueOnce({ exists: lockOwner !== undefined, data: () => ({ relationId: lockOwner }) })
    .mockResolvedValueOnce({
      exists: legacyLockOwner !== undefined,
      data: () => ({ relationId: legacyLockOwner }),
    });
  const txDelete = jest.fn();
  const txUpdate = jest.fn();
  const txSet = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (fn: (tx: { get: typeof txGet; delete: typeof txDelete; update: typeof txUpdate; set: typeof txSet }) => unknown) =>
      fn({ get: txGet, delete: txDelete, update: txUpdate, set: txSet })
  );
  return { txGet, txDelete, txUpdate, txSet };
}

function mockFreshStateTransaction(existing: object) {
  const txGet = jest.fn().mockResolvedValueOnce({ exists: true, data: () => existing });
  const txUpdate = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (fn: (tx: { get: typeof txGet; update: typeof txUpdate }) => unknown) => fn({ get: txGet, update: txUpdate })
  );
  return { txGet, txUpdate };
}

const mockSnapshot = (id: string, name: string) => ({
  type: 'technology',
  id,
  name,
  description: `Description for ${name}`,
  snapshotAt: Date.now(),
});

const validRelationData = {
  relationType: 'uses',
  sourceSnapshot: mockSnapshot('tech-1', 'TensorFlow'),
  targetSnapshot: mockSnapshot('tech-2', 'Python'),
  notes: 'Uses Python',
  confidence: 90,
  aiSuggested: false,
};

describe('relations-admin reads', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adminGetRelationById returns the relation when it exists', async () => {
    mockDocGet.mockResolvedValue(docSnap({ id: 'rel-1', relationType: 'uses' }));
    await expect(adminGetRelationById('rel-1')).resolves.toMatchObject({ id: 'rel-1', relationType: 'uses' });
  });

  it('adminGetRelationById returns null when the relation is missing', async () => {
    mockDocGet.mockResolvedValue(docSnap(null));
    await expect(adminGetRelationById('nope')).resolves.toBeNull();
  });

  it('adminCheckDuplicateRelation returns the existing relation on a forward match', async () => {
    mockQueryGet.mockResolvedValue(querySnap([{ id: 'rel-x', relationType: 'uses' }]));
    await expect(adminCheckDuplicateRelation('s1', 't1', 'uses')).resolves.toMatchObject({ id: 'rel-x' });
  });

  it('adminCheckDuplicateRelation returns null when there is no match', async () => {
    mockQueryGet.mockResolvedValue(querySnap([]));
    await expect(adminCheckDuplicateRelation('s1', 't1', 'uses')).resolves.toBeNull();
  });

  it.each(['parallels', 'complements', 'conflicts_with'])(
    'adminCheckDuplicateRelation checks reverse %s rows',
    async (relationType) => {
      mockQueryGet
        .mockResolvedValueOnce(querySnap([]))
        .mockResolvedValueOnce(querySnap([{ id: `rel-${relationType}`, relationType }]));

      await expect(adminCheckDuplicateRelation('entity-a', 'entity-b', relationType)).resolves.toMatchObject({
        id: `rel-${relationType}`,
      });
      expect(mockQueryGet).toHaveBeenCalledTimes(2);
    }
  );
});

describe('adminCreateRelation — transactional triple lock (LIVE-2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects malformed correlation text before any create read or write', async () => {
    await expect(
      adminCreateRelation(validRelationData, { correlationId: 'private customer note' })
    ).rejects.toThrow('Invalid correlation ID');

    expect(mockQueryGet).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical type before any Firestore read or write', async () => {
    await expect(
      adminCreateRelation({ ...validRelationData, relationType: 'provides' } as never)
    ).rejects.toThrow('Invalid relationType');

    expect(mockQueryGet).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });

  it('creates a new relation via the transactional triple lock when no lock exists', async () => {
    mockQueryGet.mockResolvedValueOnce(querySnap([])); // fast-path duplicate check: no match
    const { txSet } = mockTripleLockTransaction({ lockExists: false });

    const result = await adminCreateRelation(validRelationData, {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(result.id).toMatch(/^rel-/);
    expect(result).toMatchObject({
      sourceCorrelationId: TEST_CORRELATION_ID,
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(txSet).toHaveBeenCalledTimes(2); // lock doc + relation doc
    expect(txSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: result.id,
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
    expect(mockDocSet).not.toHaveBeenCalled();
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
    expect(mockedInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({
          operation: 'create',
          relationId: result.id,
          correlationId: TEST_CORRELATION_ID,
          sourceFingerprint: result.sourceFingerprint,
        }),
      })
    );
  });

  it('overwrites caller-supplied source metadata with the system-owned version', async () => {
    mockQueryGet.mockResolvedValueOnce(querySnap([]));
    const { txSet } = mockTripleLockTransaction({ lockExists: false });

    const result = await adminCreateRelation(
      {
        ...validRelationData,
        sourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceFingerprint: 'b'.repeat(64),
      } as never,
      { correlationId: TEST_CORRELATION_ID }
    );

    expect(result.sourceCorrelationId).toBe(TEST_CORRELATION_ID);
    expect(result.sourceFingerprint).not.toBe('b'.repeat(64));
    expect(txSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
  });

  it('transactionally refreshes the source version before resyncing an idempotent create replay', async () => {
    const queriedExisting = {
      id: 'rel-existing',
      ...validRelationData,
      sourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceFingerprint: 'a'.repeat(64),
      createdAt: 1,
      updatedAt: 1,
    };
    const transactionCurrent = {
      ...queriedExisting,
      notes: 'concurrent committed note',
      confidence: 72,
      sourceCorrelationId: 'corr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceFingerprint: 'b'.repeat(64),
      updatedAt: 2,
    };
    mockQueryGet.mockResolvedValueOnce(querySnap([queriedExisting]));
    const { txUpdate } = mockFreshStateTransaction(transactionCurrent);

    const result = await adminCreateRelation(validRelationData, {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(result).toMatchObject({
      id: queriedExisting.id,
      notes: transactionCurrent.notes,
      confidence: transactionCurrent.confidence,
      sourceCorrelationId: TEST_CORRELATION_ID,
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.sourceFingerprint).not.toBe(transactionCurrent.sourceFingerprint);
    expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
    expect(mockDocSet).not.toHaveBeenCalled();
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
    expect(mockedInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({
          operation: 'update',
          relationId: 'rel-existing',
          correlationId: TEST_CORRELATION_ID,
          sourceFingerprint: result.sourceFingerprint,
          notes: transactionCurrent.notes,
          confidence: transactionCurrent.confidence,
        }),
      })
    );
  });

  it('surfaces an unacknowledged create after commit and converges on idempotent retry', async () => {
    mockQueryGet.mockResolvedValueOnce(querySnap([]));
    const { txSet } = mockTripleLockTransaction({ lockExists: false });
    mockedInngest.send.mockResolvedValueOnce({ ids: [] });

    await expect(adminCreateRelation(validRelationData)).rejects.toBeInstanceOf(RelationSyncDispatchError);
    expect(txSet).toHaveBeenCalledTimes(2);

    const committed = txSet.mock.calls
      .map(([, value]) => value as Relation)
      .find((value) => value.id?.startsWith('rel-'))!;
    mockQueryGet.mockResolvedValueOnce(querySnap([committed]));
    const { txUpdate } = mockFreshStateTransaction(committed);
    const result = await adminCreateRelation(validRelationData, {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(result).toMatchObject({
      id: committed.id,
      sourceCorrelationId: TEST_CORRELATION_ID,
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.sourceCorrelationId).not.toBe(committed.sourceCorrelationId);
    expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
    expect(mockedInngest.send).toHaveBeenCalledTimes(2);
    expect(mockedInngest.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operation: 'update',
          relationId: committed.id,
          correlationId: TEST_CORRELATION_ID,
          sourceFingerprint: result.sourceFingerprint,
        }),
      })
    );
  });

  it('rejects a concurrent reverse create held by a legacy lock for a newly symmetric type', async () => {
    const input = {
      ...validRelationData,
      relationType: 'parallels' as const,
      sourceSnapshot: mockSnapshot('signal-a', 'Signal A'),
      targetSnapshot: mockSnapshot('signal-b', 'Signal B'),
    };
    const existing = {
      id: 'rel-legacy-reverse',
      ...input,
      sourceSnapshot: input.targetSnapshot,
      targetSnapshot: input.sourceSnapshot,
      createdAt: 1,
      updatedAt: 1,
    };
    mockQueryGet
      .mockResolvedValueOnce(querySnap([]))
      .mockResolvedValueOnce(querySnap([]));
    const txGet = jest
      .fn()
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ relationId: existing.id }),
      })
      .mockResolvedValueOnce({ exists: true, data: () => existing });
    const txSet = jest.fn();
    mockRunTransaction.mockImplementationOnce(
      async (fn: (tx: { get: typeof txGet; set: typeof txSet }) => unknown) =>
        fn({ get: txGet, set: txSet })
    );

    await expect(adminCreateRelation(input)).rejects.toBeInstanceOf(DuplicateRelationError);
    expect(txSet).not.toHaveBeenCalled();
  });

  it('concurrent identical creates: second transaction sees the lock and throws DuplicateRelationError with the existing relation', async () => {
    const existing = {
      id: 'rel-race-winner',
      relationType: 'uses',
      sourceSnapshot: validRelationData.sourceSnapshot,
      targetSnapshot: validRelationData.targetSnapshot,
    };
    mockQueryGet.mockResolvedValueOnce(querySnap([])); // fast path missed the race
    mockTripleLockTransaction({
      lockExists: true,
      lockData: { relationId: 'rel-race-winner' },
      relationExists: true,
      relationData: existing,
    });

    await expect(adminCreateRelation(validRelationData)).rejects.toThrow(DuplicateRelationError);

    mockQueryGet.mockResolvedValueOnce(querySnap([]));
    mockTripleLockTransaction({
      lockExists: true,
      lockData: { relationId: 'rel-race-winner' },
      relationExists: true,
      relationData: existing,
    });
    try {
      await adminCreateRelation(validRelationData);
      throw new Error('expected adminCreateRelation to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateRelationError);
      expect((error as InstanceType<typeof DuplicateRelationError>).existingRelation).toEqual(existing);
    }
  });

  it('lock takeover: stale lock for a deleted relation does not block re-creation', async () => {
    mockQueryGet.mockResolvedValueOnce(querySnap([]));
    const { txSet } = mockTripleLockTransaction({
      lockExists: true,
      lockData: { relationId: 'rel-deleted-since' },
      relationExists: false,
    });

    const result = await adminCreateRelation(validRelationData);

    expect(result.id).toBeDefined();
    expect(result.id).not.toBe('rel-deleted-since');
    expect(txSet).toHaveBeenCalledTimes(2);
  });
});

describe('adminCreateRelationFromIds — runtime boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a noncanonical type before fetching either endpoint', async () => {
    await expect(
      adminCreateRelationFromIds({
        sourceId: 'company-1',
        sourceType: 'company',
        targetId: 'tech-1',
        targetType: 'technology',
        relationType: 'provides',
      } as never)
    ).rejects.toThrow('Invalid relationType');

    expect(mockDocGet).not.toHaveBeenCalled();
    expect(mockQueryGet).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });
});

describe('adminUpdateRelation — transactional triple migration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects malformed correlation text before reading the relation to update', async () => {
    await expect(
      adminUpdateRelation('rel-1', { confidence: 95 }, { correlationId: 'operator notes' })
    ).rejects.toThrow('Invalid correlation ID');

    expect(mockDocGet).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical type before reading the relation', async () => {
    await expect(adminUpdateRelation('rel-1', { relationType: 'built_by' } as never)).rejects.toThrow(
      'Invalid relationType'
    );

    expect(mockDocGet).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });

  it('moves the uniqueness lock in the same transaction as an endpoint edit', async () => {
    const existing = { id: 'rel-1', ...validRelationData, createdAt: 1, updatedAt: 1 };
    const nextTarget = mockSnapshot('tech-3', 'PyTorch');
    const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing);

    const result = await adminUpdateRelation(
      'rel-1',
      { targetSnapshot: nextTarget },
      { correlationId: TEST_CORRELATION_ID }
    );

    expect(result.targetSnapshot).toEqual(nextTarget);
    expect(result.sourceCorrelationId).toBe(TEST_CORRELATION_ID);
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
    expect(txSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ relationId: 'rel-1', targetId: 'tech-3', relationType: 'uses' })
    );
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect(mockDocUpdate).not.toHaveBeenCalled();
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
    expect(mockedInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({
          operation: 'update',
          relationId: 'rel-1',
          correlationId: TEST_CORRELATION_ID,
          sourceFingerprint: result.sourceFingerprint,
        }),
      })
    );
  });

  it('fingerprints the authoritative transaction state and overwrites caller source metadata', async () => {
    const existing = {
      id: 'rel-concurrent',
      ...validRelationData,
      notes: 'concurrent committed note',
      createdAt: 1,
      updatedAt: 2,
    };
    const { txUpdate } = mockFreshStateTransaction(existing);

    const result = await adminUpdateRelation(
      existing.id,
      {
        confidence: 72,
        sourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceFingerprint: 'a'.repeat(64),
      } as never,
      { correlationId: TEST_CORRELATION_ID }
    );

    expect(result.notes).toBe('concurrent committed note');
    expect(result.sourceCorrelationId).toBe(TEST_CORRELATION_ID);
    expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confidence: 72,
        sourceCorrelationId: TEST_CORRELATION_ID,
        sourceFingerprint: result.sourceFingerprint,
      })
    );
  });

  it('rejects a topology collision with an existing relation that has no lock', async () => {
    const existing = {
      id: 'rel-unlocked-move',
      ...validRelationData,
      createdAt: 1,
      updatedAt: 1,
    };
    const duplicate = {
      ...existing,
      id: 'rel-unlocked-existing',
      targetSnapshot: mockSnapshot('tech-3', 'PyTorch'),
    };
    const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing, {
      queryDuplicates: [duplicate],
      newLockExists: false,
    });

    await expect(
      adminUpdateRelation(existing.id, { targetSnapshot: duplicate.targetSnapshot })
    ).rejects.toBeInstanceOf(DuplicateRelationError);

    expect(txUpdate).not.toHaveBeenCalled();
    expect(txSet).not.toHaveBeenCalled();
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('leaves the relation and locks untouched when the destination triple is occupied', async () => {
    const existing = { id: 'rel-1', ...validRelationData, createdAt: 1, updatedAt: 1 };
    const duplicate = {
      ...existing,
      id: 'rel-winner',
      targetSnapshot: mockSnapshot('tech-3', 'PyTorch'),
    };
    const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing, {
      newLockExists: true,
      newLockOwner: 'rel-winner',
      duplicateRelation: duplicate,
    });

    await expect(
      adminUpdateRelation('rel-1', { targetSnapshot: duplicate.targetSnapshot })
    ).rejects.toBeInstanceOf(DuplicateRelationError);

    expect(txUpdate).not.toHaveBeenCalled();
    expect(txSet).not.toHaveBeenCalled();
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('surfaces an unacknowledged update after commit and converges on retry', async () => {
    const existing = { id: 'rel-update-retry', ...validRelationData, createdAt: 1, updatedAt: 1 };
    const firstTransaction = mockFreshStateTransaction(existing);
    mockedInngest.send.mockResolvedValueOnce({ ids: [] });

    await expect(adminUpdateRelation(existing.id, { notes: 'first write' })).rejects.toBeInstanceOf(
      RelationSyncDispatchError
    );
    expect(firstTransaction.txUpdate).toHaveBeenCalledTimes(1);

    const secondTransaction = mockFreshStateTransaction({ ...existing, notes: 'first write', updatedAt: 2 });
    await expect(adminUpdateRelation(existing.id, { notes: 'first write' })).resolves.toMatchObject({
      id: existing.id,
      notes: 'first write',
    });
    expect(secondTransaction.txUpdate).toHaveBeenCalledTimes(1);
    expect(mockedInngest.send).toHaveBeenCalledTimes(2);
  });
});

describe('adminUpdateRelationFromFreshState — transactional metadata merge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('derives and writes metadata from the relation read inside the transaction', async () => {
    const existing = {
      id: 'rel-1',
      ...validRelationData,
      evidenceRefs: [{ id: 'already-committed', type: 'signal', capturedAt: 1 }],
      claimStatus: 'curated',
      createdAt: 1,
      updatedAt: 1,
    };
    const { txUpdate } = mockFreshStateTransaction(existing);

    const result = await adminUpdateRelationFromFreshState('rel-1', (fresh: typeof existing) => ({
      evidenceRefs: [...fresh.evidenceRefs, { id: 'incoming', type: 'web_ref', capturedAt: 2 }],
      claimStatus: fresh.claimStatus,
    }));

    expect(result.evidenceRefs).toEqual([
      expect.objectContaining({ id: 'already-committed' }),
      expect.objectContaining({ id: 'incoming' }),
    ]);
    expect(result.claimStatus).toBe('curated');
    expect(result.sourceCorrelationId).toMatch(/^corr_/);
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(txUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ id: 'already-committed' }),
          expect.objectContaining({ id: 'incoming' }),
        ]),
        claimStatus: 'curated',
        sourceCorrelationId: result.sourceCorrelationId,
        sourceFingerprint: result.sourceFingerprint,
        updatedAt: expect.any(Number),
      })
    );
    expect(mockedInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({ operation: 'update', relationId: 'rel-1', claimStatus: 'curated' }),
      })
    );
  });

  it('does not write when the fresh-state callback returns an idempotent no-op', async () => {
    const existing = { id: 'rel-1', ...validRelationData, createdAt: 1, updatedAt: 1 };
    const { txUpdate } = mockFreshStateTransaction(existing);

    await expect(adminUpdateRelationFromFreshState('rel-1', () => null)).resolves.toEqual(existing);
    expect(txUpdate).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });
});

describe('adminDeleteRelation — transactional triple lock cleanup (LIVE-2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('atomically deletes the triple lock alongside the relation', async () => {
    const existing = {
      id: 'rel-lock-cleanup',
      relationType: 'uses',
      sourceSnapshot: validRelationData.sourceSnapshot,
      targetSnapshot: validRelationData.targetSnapshot,
    };
    const { txDelete, txSet } = mockAdminRelationDeleteTransaction(existing, 'rel-lock-cleanup');

    await adminDeleteRelation('rel-lock-cleanup', { correlationId: TEST_CORRELATION_ID });

    expect(txDelete).toHaveBeenCalledTimes(2);
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
    const deleteEvent = mockedInngest.send.mock.calls[0][0];
    expect(deleteEvent).toMatchObject({
      name: 'app/relation.sync.requested',
      data: {
        operation: 'delete',
        relationId: 'rel-lock-cleanup',
        deleteToken: expect.any(String),
        correlationId: TEST_CORRELATION_ID,
      },
    });
    expect(deleteEvent.id).toBe(`relation-delete:${deleteEvent.data.deleteToken}:0`);
    expect(txSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ correlationId: TEST_CORRELATION_ID })
    );
  });

  it('rejects malformed correlation text before the delete transaction', async () => {
    await expect(
      adminDeleteRelation('rel-invalid', { correlationId: 'private customer note' })
    ).rejects.toThrow('Invalid correlation ID');

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockedInngest.send).not.toHaveBeenCalled();
  });

  it('does not delete a lock that has since been taken over by a different relation', async () => {
    const existing = {
      id: 'rel-old-owner',
      relationType: 'uses',
      sourceSnapshot: validRelationData.sourceSnapshot,
      targetSnapshot: validRelationData.targetSnapshot,
    };
    const { txDelete } = mockAdminRelationDeleteTransaction(existing, 'rel-new-owner');

    await adminDeleteRelation('rel-old-owner');

    expect(txDelete).toHaveBeenCalledTimes(1);
  });

  it('atomically removes owned v2 and legacy locks during cutover', async () => {
    const existing = {
      id: 'rel-cutover-delete',
      relationType: 'uses',
      sourceSnapshot: validRelationData.sourceSnapshot,
      targetSnapshot: validRelationData.targetSnapshot,
    };
    const { txDelete } = mockAdminRelationDeleteTransaction(
      existing,
      existing.id,
      existing.id
    );

    await adminDeleteRelation(existing.id);

    expect(txDelete).toHaveBeenCalledTimes(3);
  });

  it('does not partially delete the relation when the transactional read fails', async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error('transient read failure'));

    await expect(adminDeleteRelation('rel-lookup-fails')).rejects.toThrow('transient read failure');
  });

  it('surfaces an unacknowledged delete while its durable marker owns graph retry', async () => {
    const existing = {
      id: 'rel-delete-retry',
      relationType: 'uses',
      sourceSnapshot: validRelationData.sourceSnapshot,
      targetSnapshot: validRelationData.targetSnapshot,
    };
    const { txDelete } = mockAdminRelationDeleteTransaction(existing, 'rel-delete-retry');
    mockedInngest.send.mockRejectedValueOnce(new Error('Inngest unavailable'));

    await expect(adminDeleteRelation(existing.id)).rejects.toBeInstanceOf(RelationSyncDispatchError);
    expect(txDelete).toHaveBeenCalledTimes(2);

    mockRunTransaction.mockResolvedValueOnce([]);
    await expect(adminDeleteRelation(existing.id)).resolves.toBeUndefined();
    expect(mockedInngest.send).toHaveBeenCalledTimes(1);
  });
});

describe('adminCleanupOrphanedRelations — graph cleanup after committed chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits one Neo4j delete sync for each orphan removed with its owned lock', async () => {
    const orphan = {
      id: 'rel-orphan',
      ...validRelationData,
      createdAt: 1,
      updatedAt: 1,
    };
    mockQueryGet.mockResolvedValueOnce(querySnap([orphan]));
    mockDocGet
      .mockResolvedValueOnce(docSnap(null))
      .mockResolvedValueOnce(docSnap({ id: orphan.targetSnapshot.id }));
    const { txDelete } = mockAdminRelationDeleteTransaction(orphan, orphan.id);

    await expect(adminCleanupOrphanedRelations()).resolves.toEqual({ checked: 1, orphaned: 1, deleted: 1 });

    expect(txDelete).toHaveBeenCalledTimes(2);
    expect(mockedInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({
          operation: 'delete',
          relationId: orphan.id,
          deleteToken: expect.any(String),
        }),
      })
    );
  });
});
