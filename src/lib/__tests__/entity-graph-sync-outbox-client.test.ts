/**
 * GRAPH-056 — the browser is the only writer positioned upstream of both
 * dispatch-outage shapes, so these cases pin that it records the debt, never
 * clears it on a mere queue acknowledgement, and never turns its own failure
 * into a false rejection of a committed mutation.
 */

const setDocMock = jest.fn();
const getDocMock = jest.fn();
const getDocsMock = jest.fn();
const runTransactionMock = jest.fn();

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  collection: jest.fn(() => ({})),
  doc: jest.fn((_db: unknown, _collection: string, id: string) => ({ id })),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  runTransaction: (...args: unknown[]) => runTransactionMock(...args),
  query: jest.fn((...args: unknown[]) => args),
  orderBy: jest.fn((...args: unknown[]) => ({ orderBy: args })),
  limit: jest.fn((value: number) => ({ limit: value })),
}));

import {
  MAX_ENTITY_GRAPH_SYNC_ATTEMPTS,
  buildEntityGraphSyncOutboxRecord,
  entityGraphSyncOutboxDocumentId,
} from '@/lib/entity-graph-sync-outbox';
import {
  MAX_REHYDRATED_ANCHORS,
  advanceEntityGraphSyncAnchor,
  listEntityGraphSyncAnchors,
  markEntityGraphSyncAnchorDispatched,
  recordEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-client';

const TIMESTAMP = 1_752_000_000_000;

function anchor(overrides: Record<string, unknown> = {}) {
  return {
    ...buildEntityGraphSyncOutboxRecord({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      timestamp: TIMESTAMP,
    }),
    ...overrides,
  };
}

function existingSnapshot(data: unknown) {
  return { exists: () => true, id: entityGraphSyncOutboxDocumentId('company', 'company-1'), data: () => data };
}

beforeEach(() => {
  jest.clearAllMocks();
  runTransactionMock.mockImplementation(
    async (
      _db: unknown,
      callback: (transaction: { get: typeof getDocMock; set: typeof setDocMock }) => Promise<unknown>
    ) => callback({ get: getDocMock, set: setDocMock })
  );
});

describe('recording an anchor', () => {
  it('persists the outstanding debt', async () => {
    setDocMock.mockResolvedValue(undefined);

    const record = await recordEntityGraphSyncAnchor({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      observedUpdatedAt: TIMESTAMP,
      error: new Error('handoff timed out'),
    });

    expect(record).toMatchObject({ entityId: 'company-1', status: 'pending', attempt: 0 });
    expect(setDocMock).toHaveBeenCalledWith(
      { id: 'company__company-1' },
      expect.objectContaining({
        entityType: 'company',
        lastError: 'handoff timed out',
      })
    );
  });

  it('replaces an exhausted anchor so new content is retryable again', async () => {
    // setDoc without merge: the previous attempt count and error describe a
    // superseded version of the document, not the debt that now stands.
    setDocMock.mockResolvedValue(undefined);

    await recordEntityGraphSyncAnchor({ entityType: 'company', entityId: 'company-1', operation: 'update' });

    const [, written] = setDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(written).toMatchObject({ attempt: 0, status: 'pending' });
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });

  it('never turns its own failure into a rejected mutation', async () => {
    // The entity already committed. Throwing here would misreport a saved
    // entity as failed — the precise defect this row exists to fix.
    setDocMock.mockRejectedValue(new Error('firestore unavailable'));

    await expect(
      recordEntityGraphSyncAnchor({ entityType: 'company', entityId: 'company-1', operation: 'create' })
    ).resolves.toBeNull();
  });
});

describe('marking a retry as dispatched', () => {
  it('stamps the dispatch without deleting the anchor', async () => {
    const existing = anchor();
    getDocMock.mockResolvedValue(existingSnapshot(existing));
    setDocMock.mockResolvedValue(undefined);

    const result = await markEntityGraphSyncAnchorDispatched(
      'company',
      'company-1',
      existing.generation
    );

    expect(result?.lastDispatchedAt).toEqual(expect.any(Number));
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no anchor exists', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    await expect(
      markEntityGraphSyncAnchorDispatched('company', 'company-1', '0'.repeat(32))
    ).resolves.toBeNull();
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('does not let an old retry overwrite a newer generation', async () => {
    const old = anchor();
    const newer = anchor();
    expect(newer.generation).not.toBe(old.generation);
    getDocMock.mockResolvedValue(existingSnapshot(newer));

    await expect(
      markEntityGraphSyncAnchorDispatched('company', 'company-1', old.generation)
    ).resolves.toBeNull();
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('advancing after a failed retry', () => {
  it('increments the attempt', async () => {
    const existing = anchor();
    getDocMock.mockResolvedValue(existingSnapshot(existing));
    setDocMock.mockResolvedValue(undefined);

    const result = await advanceEntityGraphSyncAnchor(
      'company',
      'company-1',
      existing.generation,
      new Error('still down')
    );

    expect(result).toMatchObject({ attempt: 1, status: 'pending', lastError: 'still down' });
  });

  it('terminates the retry loop at the bound', async () => {
    const existing = anchor({ attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS - 1 });
    getDocMock.mockResolvedValue(existingSnapshot(existing));
    setDocMock.mockResolvedValue(undefined);

    const result = await advanceEntityGraphSyncAnchor(
      'company',
      'company-1',
      existing.generation
    );

    expect(result).toMatchObject({ attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS, status: 'exhausted' });
  });

  it('does not let an old failed retry advance a newer generation', async () => {
    const old = anchor();
    const newer = anchor();
    getDocMock.mockResolvedValue(existingSnapshot(newer));

    await expect(
      advanceEntityGraphSyncAnchor('company', 'company-1', old.generation, new Error('old failure'))
    ).resolves.toBeNull();
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('reading anchors back on mount', () => {
  it('reconstructs pending operations', async () => {
    getDocsMock.mockResolvedValue({ docs: [existingSnapshot(anchor())] });

    await expect(listEntityGraphSyncAnchors()).resolves.toHaveLength(1);
  });

  it('skips malformed anchors instead of rendering them', async () => {
    getDocsMock.mockResolvedValue({
      docs: [existingSnapshot(anchor()), existingSnapshot({ entityType: 'company', attempt: -1 })],
    });

    await expect(listEntityGraphSyncAnchors()).resolves.toHaveLength(1);
  });

  it('filters to the requested entity type', async () => {
    getDocsMock.mockResolvedValue({ docs: [existingSnapshot(anchor())] });

    await expect(listEntityGraphSyncAnchors('technology')).resolves.toHaveLength(0);
    await expect(listEntityGraphSyncAnchors('company')).resolves.toHaveLength(1);
  });

  it('bounds the read so a pathological collection cannot flood the page', async () => {
    const { limit } = jest.requireMock('firebase/firestore') as { limit: jest.Mock };
    getDocsMock.mockResolvedValue({ docs: [] });

    await listEntityGraphSyncAnchors();

    expect(limit).toHaveBeenCalledWith(MAX_REHYDRATED_ANCHORS);
  });

  it('degrades to an empty list rather than breaking the page', async () => {
    getDocsMock.mockRejectedValue(new Error('offline'));
    await expect(listEntityGraphSyncAnchors()).resolves.toEqual([]);
  });
});
