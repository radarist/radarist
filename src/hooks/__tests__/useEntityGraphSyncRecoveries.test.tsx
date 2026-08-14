/**
 * @jest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { EntitySyncDispatchError } from '@/lib/entity-sync';

jest.mock('@/lib/entity-sync', () => {
  const actual = jest.requireActual('@/lib/entity-sync');
  return { ...actual, requestEntityGraphSync: jest.fn() };
});

jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  listEntityGraphSyncAnchors: jest.fn(async () => []),
  recordEntityGraphSyncAnchor: jest.fn(async () => null),
  readEntityGraphSyncAnchor: jest.fn(async () => ({ generation: 'a'.repeat(32) })),
  markEntityGraphSyncAnchorDispatched: jest.fn(async () => null),
  advanceEntityGraphSyncAnchor: jest.fn(async () => null),
}));

import { requestEntityGraphSync } from '@/lib/entity-sync';
import { useEntityGraphSyncRecoveries } from '@/hooks/useEntityGraphSyncRecoveries';

const mockedRequestEntityGraphSync = jest.mocked(requestEntityGraphSync);

function savedLocally(id: string) {
  return {
    status: 'saved-locally' as const,
    entityType: 'company' as const,
    entityId: id,
    operation: 'update' as const,
    entity: { id, name: id },
    graphSyncError: new EntitySyncDispatchError('company', id, 'update', new Error('queue unavailable')),
  };
}

describe('useEntityGraphSyncRecoveries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retains independent entities and replaces only a repeat for the same entity', () => {
    const { result } = renderHook(() => useEntityGraphSyncRecoveries<{ id: string; name: string }, string>());

    act(() => {
      result.current.recordRecovery(savedLocally('one'), 'documents');
      result.current.recordRecovery(savedLocally('two'), 'swot');
      result.current.recordRecovery(savedLocally('one'), 'save');
    });

    expect(result.current.recoveries.map(({ entityId }) => entityId)).toEqual(['one', 'two']);
    expect(result.current.recoveries[0].context).toBe('save');
  });

  it('retries only the targeted entity and keeps it pending until the graph confirms', async () => {
    // GRAPH-056: an acknowledged dispatch is not a completed graph write, so
    // the recovery must NOT be discarded here. Clearing on acknowledgement is
    // exactly how a stale Neo4j projection became invisible. The durable anchor
    // is retired server-side once the projection provably matches the source.
    mockedRequestEntityGraphSync.mockResolvedValue(undefined);
    const { result } = renderHook(() => useEntityGraphSyncRecoveries<{ id: string; name: string }, undefined>());
    act(() => {
      result.current.recordRecovery(savedLocally('one'), undefined);
      result.current.recordRecovery(savedLocally('two'), undefined);
    });

    await act(async () => {
      await result.current.retryGraphSync('one');
    });

    expect(mockedRequestEntityGraphSync).toHaveBeenCalledWith('company', 'one', 'update');
    const { markEntityGraphSyncAnchorDispatched } = jest.requireMock(
      '@/lib/entity-graph-sync-outbox-client'
    );
    expect(markEntityGraphSyncAnchorDispatched).toHaveBeenCalledWith(
      'company',
      'one',
      'a'.repeat(32)
    );
    expect(result.current.recoveries.map(({ entityId }) => entityId).sort()).toEqual(['one', 'two']);
    expect(result.current.recoveries.find((recovery) => recovery.entityId === 'one')).toMatchObject({
      awaitingConfirmation: true,
      isRetrying: false,
    });
    // The untouched recovery is unaffected.
    expect(result.current.recoveries.find((recovery) => recovery.entityId === 'two')).toMatchObject({
      awaitingConfirmation: false,
    });
  });

  it('reconstructs outstanding operations from the durable anchor on mount', async () => {
    // The reload path: React state is gone, but the debt is not.
    const { listEntityGraphSyncAnchors } = jest.requireMock('@/lib/entity-graph-sync-outbox-client');
    listEntityGraphSyncAnchors.mockResolvedValueOnce([
      {
        entityType: 'company',
        entityId: 'restored-1',
        generation: 'a'.repeat(32),
        operation: 'update',
        observedUpdatedAt: 1,
        lastDispatchedAt: null,
        attempt: 1,
        status: 'pending',
        lastError: 'handoff timed out',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { result } = renderHook(() => useEntityGraphSyncRecoveries<{ id: string; name: string }, undefined>());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.recoveries).toHaveLength(1);
    expect(result.current.recoveries[0]).toMatchObject({
      entityId: 'restored-1',
      operation: 'update',
      retryAttempts: 1,
      rehydrated: true,
      lastError: 'handoff timed out',
    });
    // A rehydrated record has no in-memory entity; the UI falls back to the id.
    expect(result.current.recoveries[0].entity).toBeUndefined();
  });

  it('does not let a rehydrated anchor displace a live in-session recovery', async () => {
    // The in-session record carries the live entity and the original error,
    // which the durable anchor cannot reconstruct.
    const { listEntityGraphSyncAnchors } = jest.requireMock('@/lib/entity-graph-sync-outbox-client');
    listEntityGraphSyncAnchors.mockResolvedValueOnce([
      {
        entityType: 'company',
        entityId: 'one',
        generation: 'b'.repeat(32),
        operation: 'update',
        observedUpdatedAt: 1,
        lastDispatchedAt: null,
        attempt: 2,
        status: 'pending',
        lastError: 'stale',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { result } = renderHook(() => useEntityGraphSyncRecoveries<{ id: string; name: string }, undefined>());
    act(() => {
      result.current.recordRecovery(savedLocally('one'), undefined);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.recoveries).toHaveLength(1);
    expect(result.current.recoveries[0]).toMatchObject({ entityId: 'one', rehydrated: false, retryAttempts: 0 });
    expect(result.current.recoveries[0].entity).toBeDefined();
  });

  it('caps retries per entity without blocking another recovery', async () => {
    mockedRequestEntityGraphSync.mockRejectedValue(new Error('still unavailable'));
    const { result } = renderHook(() => useEntityGraphSyncRecoveries<{ id: string; name: string }, undefined>());
    act(() => {
      result.current.recordRecovery(savedLocally('one'), undefined);
      result.current.recordRecovery(savedLocally('two'), undefined);
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await act(async () => {
        await result.current.retryGraphSync('one');
      });
    }
    await act(async () => {
      await result.current.retryGraphSync('two');
    });

    expect(mockedRequestEntityGraphSync).toHaveBeenCalledTimes(4);
    expect(result.current.recoveries.find(({ entityId }) => entityId === 'one')?.retryAttempts).toBe(3);
    expect(result.current.recoveries.find(({ entityId }) => entityId === 'two')?.retryAttempts).toBe(1);
  });

  it('hides a deleted entity locally without deleting its durable anchor from the browser', () => {
    const { result } = renderHook(() =>
      useEntityGraphSyncRecoveries<{ id: string; name: string }, undefined>()
    );
    act(() => {
      result.current.recordRecovery(savedLocally('one'), undefined);
      result.current.clearRecovery('one');
    });

    expect(result.current.recoveries).toEqual([]);
    expect(jest.requireMock('@/lib/entity-graph-sync-outbox-client')).not.toHaveProperty(
      'discardEntityGraphSyncAnchor'
    );
  });
});
