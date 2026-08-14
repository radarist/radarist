/** @jest-environment node */

const mockOrderBy = jest.fn();
const mockWhere = jest.fn();
const mockStatusWhere = jest.fn();
const mockLimit = jest.fn();
const mockGet = jest.fn();
const mockCollection = jest.fn();
const mockRunTransaction = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockSendEvent = jest.fn();

jest.mock('@/lib/logger', () => {
  const error = jest.fn();
  return {
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error, debug: jest.fn() }),
    mockLogError: error,
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (...args: unknown[]) => mockCollection(...args),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
  },
}));

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({ config, trigger, handler })),
  },
}));

import { replayRelationDeleteOutboxJob } from '../replay-relation-delete-outbox';
import { MAX_RELATION_DELETE_ATTEMPTS } from '@/lib/relation-sync-outbox';

const { mockLogError } = jest.requireMock('@/lib/logger') as { mockLogError: jest.Mock };
const NOW = 1_000_000;
const REPLAY_DELAY_MS = 5 * 60 * 1000;
const CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

type Marker = { id: string; data: Record<string, unknown> };
type MarkerRef = { collection: string; id: string };

const markerStore = new Map<string, Record<string, unknown>>();

function marker(id: string, overrides: Record<string, unknown> = {}): Marker {
  return {
    id,
    data: {
      relationId: id,
      deleteToken: `token-${id}`,
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 0,
      lastError: null,
      exhaustedAt: null,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
  };
}

function snapshot(markers: Marker[]) {
  return {
    docs: markers.map((item) => ({ id: item.id, data: () => ({ ...item.data }) })),
  };
}

function arrangeMarkers(markers: Marker[]) {
  markerStore.clear();
  for (const item of markers) markerStore.set(item.id, { ...item.data });
  mockGet.mockResolvedValueOnce(snapshot(markers));
}

async function execute() {
  return (replayRelationDeleteOutboxJob as any).handler({
    step: {
      run: async (_name: string, callback: () => unknown) => callback(),
      sendEvent: mockSendEvent,
    },
  });
}

describe('replayRelationDeleteOutboxJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    markerStore.clear();
    mockCollection.mockImplementation((collection: string) => ({
      where: mockStatusWhere,
      doc: (id: string): MarkerRef => ({ collection, id }),
    }));
    mockStatusWhere.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
    mockGet.mockResolvedValue(snapshot([]));
    mockTransactionGet.mockImplementation(async (ref: MarkerRef) => {
      const data = markerStore.get(ref.id);
      return { exists: data !== undefined, data: () => data };
    });
    mockTransactionUpdate.mockImplementation((ref: MarkerRef, updates: Record<string, unknown>) => {
      const current = markerStore.get(ref.id);
      if (current) markerStore.set(ref.id, { ...current, ...updates });
    });
    mockRunTransaction.mockImplementation(async (callback: (transaction: unknown) => unknown) =>
      callback({ get: mockTransactionGet, update: mockTransactionUpdate })
    );
    mockSendEvent.mockResolvedValue({ ids: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries only due markers in retry order with a bounded batch', async () => {
    await execute();

    expect((replayRelationDeleteOutboxJob as any).trigger).toEqual({ cron: '*/5 * * * *' });
    expect(mockCollection).toHaveBeenCalledWith('relationSyncOutbox');
    // GRAPH-059: exhausted markers are excluded by the query, not in memory,
    // so they can never consume the batch budget of markers that can progress.
    expect(mockStatusWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(mockWhere).toHaveBeenCalledWith('nextAttemptAt', '<=', NOW);
    expect(mockOrderBy).toHaveBeenCalledWith('nextAttemptAt', 'asc');
    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it('returns without dispatch when there are no markers', async () => {
    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('does not claim a marker before its replay window is due', async () => {
    arrangeMarkers([marker('rel-not-due', { nextAttemptAt: NOW + 1 })]);

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('dispatches an eligible tail even when 100 older markers are delayed', async () => {
    const eligible = marker('rel-eligible', { createdAt: 101, nextAttemptAt: NOW });
    arrangeMarkers([eligible]);
    for (let index = 0; index < 100; index += 1) {
      const delayed = marker(`rel-delayed-${index}`, {
        createdAt: index + 1,
        nextAttemptAt: NOW + REPLAY_DELAY_MS,
      });
      markerStore.set(delayed.id, delayed.data);
    }

    await expect(execute()).resolves.toEqual({ dispatched: 1, exhausted: 0 });

    expect(mockSendEvent).toHaveBeenCalledWith('dispatch-pending-relation-deletes', [
      expect.objectContaining({
        id: 'relation-delete:token-rel-eligible:1',
        data: expect.objectContaining({ relationId: 'rel-eligible' }),
      }),
    ]);
  });

  it('transactionally claims due markers and dispatches a unique attempt generation', async () => {
    arrangeMarkers([
      marker('rel-1', { correlationId: CORRELATION_ID }),
      marker('rel-2', { attempt: 2, nextAttemptAt: NOW }),
    ]);

    await expect(execute()).resolves.toEqual({ dispatched: 2, exhausted: 0 });

    expect(mockTransactionUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'rel-1' }), {
      attempt: 1,
      nextAttemptAt: NOW + REPLAY_DELAY_MS,
      updatedAt: NOW,
    });
    expect(mockTransactionUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'rel-2' }), {
      attempt: 3,
      nextAttemptAt: NOW + REPLAY_DELAY_MS,
      updatedAt: NOW,
    });
    expect(mockSendEvent).toHaveBeenCalledWith('dispatch-pending-relation-deletes', [
      {
        id: 'relation-delete:token-rel-1:1',
        name: 'app/relation.sync.requested',
        data: {
          operation: 'delete',
          relationId: 'rel-1',
          deleteToken: 'token-rel-1',
          correlationId: CORRELATION_ID,
        },
      },
      {
        id: 'relation-delete:token-rel-2:3',
        name: 'app/relation.sync.requested',
        data: { operation: 'delete', relationId: 'rel-2', deleteToken: 'token-rel-2' },
      },
    ]);
  });

  it('skips malformed markers while dispatching valid legacy siblings', async () => {
    arrangeMarkers([
      marker('bad', { relationId: 'different-id' }),
      marker('bad-correlation', { correlationId: 'private arbitrary text' }),
      marker('rel-good'),
    ]);

    await expect(execute()).resolves.toEqual({ dispatched: 1, exhausted: 0 });

    expect(mockLogError).toHaveBeenCalledWith('Malformed relation delete outbox marker', undefined, {
      markerId: 'bad',
    });
    expect(mockLogError).toHaveBeenCalledWith('Malformed relation delete outbox marker', undefined, {
      markerId: 'bad-correlation',
    });
    expect(mockSendEvent).toHaveBeenCalledWith('dispatch-pending-relation-deletes', [
      {
        id: 'relation-delete:token-rel-good:1',
        name: 'app/relation.sync.requested',
        data: { operation: 'delete', relationId: 'rel-good', deleteToken: 'token-rel-good' },
      },
    ]);
  });

  it('loses a concurrent claim cleanly when the marker is no longer due', async () => {
    arrangeMarkers([marker('rel-raced')]);
    markerStore.set('rel-raced', {
      ...marker('rel-raced').data,
      attempt: 1,
      nextAttemptAt: NOW + REPLAY_DELAY_MS,
      updatedAt: NOW,
    });

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('does not claim a replacement marker with a new delete token', async () => {
    arrangeMarkers([marker('rel-replaced')]);
    markerStore.set('rel-replaced', {
      ...marker('rel-replaced').data,
      deleteToken: 'replacement-token',
    });

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('retains the claimed generation when dispatch fails so a later generation can retry', async () => {
    arrangeMarkers([marker('rel-1')]);
    mockSendEvent.mockRejectedValueOnce(new Error('event transport unavailable'));

    await expect(execute()).rejects.toThrow('event transport unavailable');

    expect(markerStore.get('rel-1')).toMatchObject({
      attempt: 1,
      nextAttemptAt: NOW + REPLAY_DELAY_MS,
      updatedAt: NOW,
    });
  });

  // ==========================================================================
  // GRAPH-059 — bounded retries and a terminal, operator-visible state
  // ==========================================================================

  it('terminates a marker that has spent its budget instead of dispatching again', async () => {
    arrangeMarkers([marker('rel-doomed', { attempt: MAX_RELATION_DELETE_ATTEMPTS })]);

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 1 });

    expect(markerStore.get('rel-doomed')).toMatchObject({
      status: 'exhausted',
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      exhaustedAt: NOW,
      updatedAt: NOW,
    });
    expect(mockSendEvent).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      'Relation delete markers exhausted their replay budget — the Neo4j projection may still exist',
      undefined,
      expect.objectContaining({
        maxAttempts: MAX_RELATION_DELETE_ATTEMPTS,
        exhausted: [
          { relationId: 'rel-doomed', deleteToken: 'token-rel-doomed', attempt: MAX_RELATION_DELETE_ATTEMPTS },
        ],
      })
    );
  });

  it('exhausts exactly once — a second sweep neither re-reports nor re-dispatches', async () => {
    arrangeMarkers([marker('rel-doomed', { attempt: MAX_RELATION_DELETE_ATTEMPTS })]);
    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 1 });
    const afterFirst = { ...markerStore.get('rel-doomed') };
    jest.clearAllMocks();

    // The real query filters on status; reproduce that by re-listing only what
    // the collection would still return as pending.
    const stillPending = [...markerStore.entries()]
      .filter(([, data]) => data.status === 'pending')
      .map(([id, data]) => ({ id, data }));
    mockGet.mockResolvedValueOnce({
      docs: stillPending.map((item) => ({ id: item.id, data: () => ({ ...item.data }) })),
    });

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(stillPending).toHaveLength(0);
    expect(markerStore.get('rel-doomed')).toEqual(afterFirst);
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('never claims a marker that is already terminal', async () => {
    arrangeMarkers([marker('rel-terminal', { status: 'exhausted', exhaustedAt: 42, attempt: 3 })]);

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockTransactionUpdate).not.toHaveBeenCalled();
    expect(mockSendEvent).not.toHaveBeenCalled();
  });

  it('loses the claim when a concurrent sweep terminated the marker first', async () => {
    arrangeMarkers([marker('rel-raced', { attempt: MAX_RELATION_DELETE_ATTEMPTS })]);
    markerStore.set('rel-raced', {
      ...marker('rel-raced', { attempt: MAX_RELATION_DELETE_ATTEMPTS }).data,
      status: 'exhausted',
      exhaustedAt: NOW - 1,
    });

    await expect(execute()).resolves.toEqual({ dispatched: 0, exhausted: 0 });

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('still converges a transient failure inside the budget', async () => {
    // A marker one attempt short of the bound keeps retrying, not terminating.
    arrangeMarkers([marker('rel-transient', { attempt: MAX_RELATION_DELETE_ATTEMPTS - 1 })]);

    await expect(execute()).resolves.toEqual({ dispatched: 1, exhausted: 0 });

    expect(markerStore.get('rel-transient')).toMatchObject({
      status: 'pending',
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
    });
    expect(mockSendEvent).toHaveBeenCalledWith('dispatch-pending-relation-deletes', [
      expect.objectContaining({
        id: `relation-delete:token-rel-transient:${MAX_RELATION_DELETE_ATTEMPTS}`,
      }),
    ]);
  });

  it('terminates one marker while dispatching a healthy sibling in the same sweep', async () => {
    arrangeMarkers([marker('rel-doomed', { attempt: MAX_RELATION_DELETE_ATTEMPTS }), marker('rel-fresh')]);

    await expect(execute()).resolves.toEqual({ dispatched: 1, exhausted: 1 });

    expect(mockSendEvent).toHaveBeenCalledWith('dispatch-pending-relation-deletes', [
      expect.objectContaining({ id: 'relation-delete:token-rel-fresh:1' }),
    ]);
    expect(markerStore.get('rel-doomed')).toMatchObject({ status: 'exhausted' });
    expect(markerStore.get('rel-fresh')).toMatchObject({ status: 'pending', attempt: 1 });
  });
});
