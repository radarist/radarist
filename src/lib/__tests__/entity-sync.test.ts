/**
 * Delivery contract tests for best-effort and required entity graph sync.
 *
 * @jest-environment node
 */

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn() },
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  recordEntityGraphSyncAnchor: jest.fn().mockResolvedValue({}),
}));

import {
  createRequiredEntitySyncEvent,
  ENTITY_SYNC_HANDOFF_TIMEOUT_MS,
  EntitySyncDispatchError,
  LIBRARY_ENTITY_SYNC_TYPES,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
  requestEntityGraphSync,
  triggerEntitySync,
  type EntitySyncOperation,
} from '../entity-sync';
import {
  buildEntityGraphSyncAnchorRecordedResponse,
  ENTITY_GRAPH_SYNC_HANDOFF_ERROR,
} from '../entity-sync-contract';

const { inngest } = jest.requireMock('@/lib/inngest/send-client') as {
  inngest: { send: jest.Mock };
};
const mockSend = inngest.send;
const { fetchWithAuth: mockFetchWithAuth } = jest.requireMock('@/lib/fetch-with-auth') as {
  fetchWithAuth: jest.Mock;
};
const { recordEntityGraphSyncAnchor: mockRecordEntityGraphSyncAnchor } = jest.requireMock(
  '@/lib/entity-graph-sync-outbox-client'
) as { recordEntityGraphSyncAnchor: jest.Mock };

function failedBrowserResponse(options: {
  body: unknown;
  status?: number;
  url?: string;
}): Response {
  return {
    ok: false,
    status: options.status ?? 503,
    url: options.url ?? 'https://radarist.local/api/graph/entity-sync',
    json: jest.fn().mockResolvedValue(options.body),
  } as unknown as Response;
}

describe('entity-sync delivery contracts', () => {
  let originalWindowDescriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  });

  afterEach(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ ids: ['event-1'] });
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue({ success: true }),
    });
  });

  it('pins all eight library entity mappings and the dedicated technology contract', () => {
    expect(LIBRARY_ENTITY_SYNC_TYPES).toEqual([
      'company',
      'technology',
      'strategy',
      'useCase',
      'prototype',
      'orgUnit',
      'initiative',
      'painPoint',
    ]);

    for (const entityType of LIBRARY_ENTITY_SYNC_TYPES) {
      const event = createRequiredEntitySyncEvent(entityType, `${entityType}-1`, 'delete');
      if (entityType === 'technology') {
        expect(event).toMatchObject({
          name: 'app/technology.sync.requested',
          data: { technologyId: 'technology-1', entityType, operation: 'delete' },
        });
      } else {
        expect(event).toMatchObject({
          name: 'app/unified-entity.sync.requested',
          data: { entityId: `${entityType}-1`, entityType, operation: 'delete' },
        });
      }
    }
  });

  it.each(['create', 'update', 'delete'] as const)(
    'omits an explicit %s identity so every committed mutation gets a fresh worker attempt',
    (operation) => {
      const event = createRequiredEntitySyncEvent('useCase', 'use/case:1', operation);
      expect(event).not.toHaveProperty('id');
    }
  );

  it('does not collapse two same-millisecond update attempts into one supplied event ID', () => {
    const first = createRequiredEntitySyncEvent('company', 'company-1', 'update');
    const second = createRequiredEntitySyncEvent('company', 'company-1', 'update');

    expect(first).not.toHaveProperty('id');
    expect(second).not.toHaveProperty('id');
  });

  it('rejects non-canonical entity IDs instead of trimming to a different graph identity', () => {
    expect(() => createRequiredEntitySyncEvent('company', ' company-1 ', 'delete')).toThrow('must already be trimmed');
  });

  it('uses the authenticated browser handoff with the exact committed mutation', async () => {
    await requestEntityGraphSync('technology', 'tech-1', 'update');

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/graph/entity-sync',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: 'technology',
          entityId: 'tech-1',
          operation: 'update',
        }),
      })
    );
  });

  it('routes best-effort browser library writes through the authenticated server boundary', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });

    await expect(triggerEntitySync('strategy', 'strategy-1', 'create')).resolves.toBe(true);

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/graph/entity-sync',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: 'strategy', entityId: 'strategy-1', operation: 'create' }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not overwrite a server anchor attested by the exact same-origin 503 receipt', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://radarist.local' } },
    });
    mockFetchWithAuth.mockResolvedValueOnce(
      failedBrowserResponse({
        body: buildEntityGraphSyncAnchorRecordedResponse({
          entityType: 'company',
          entityId: 'company-1',
          operation: 'update',
        }),
      })
    );

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);

    expect(mockRecordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'extra receipt field',
      body: {
        ...buildEntityGraphSyncAnchorRecordedResponse({
          entityType: 'company' as const,
          entityId: 'company-1',
          operation: 'update' as const,
        }),
        untrusted: true,
      },
    },
    {
      name: 'different entity identity',
      body: buildEntityGraphSyncAnchorRecordedResponse({
        entityType: 'company' as const,
        entityId: 'company-2',
        operation: 'update' as const,
      }),
    },
    {
      name: 'generic failure body',
      body: { error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR },
    },
  ])('records the browser fallback anchor for an untrusted $name', async ({ body }) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://radarist.local' } },
    });
    mockFetchWithAuth.mockResolvedValueOnce(failedBrowserResponse({ body }));

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);

    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'company', entityId: 'company-1', operation: 'update' })
    );
  });

  it.each([
    'https://attacker.example/api/graph/entity-sync',
    'https://radarist.local/api/graph/entity-sync/redirected',
    'https://radarist.local/api/graph/entity-sync?forged=true',
  ])('records the browser fallback anchor for a receipt from %s', async (url) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://radarist.local' } },
    });
    mockFetchWithAuth.mockResolvedValueOnce(
      failedBrowserResponse({
        url,
        body: buildEntityGraphSyncAnchorRecordedResponse({
          entityType: 'company',
          entityId: 'company-1',
          operation: 'update',
        }),
      })
    );

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);

    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledTimes(1);
  });

  it('does not trust an otherwise exact receipt on any status except 503', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://radarist.local' } },
    });
    mockFetchWithAuth.mockResolvedValueOnce(
      failedBrowserResponse({
        status: 500,
        body: buildEntityGraphSyncAnchorRecordedResponse({
          entityType: 'company',
          entityId: 'company-1',
          operation: 'update',
        }),
      })
    );

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);

    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledTimes(1);
  });

  it('records the browser fallback anchor when the route is unreachable', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://radarist.local' } },
    });
    mockFetchWithAuth.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);

    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled best-effort browser handoff after the entity is committed', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    jest.useFakeTimers();
    try {
      mockFetchWithAuth.mockImplementationOnce((_url: string, options?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        });
      });

      const dispatch = triggerEntitySync('strategy', 'strategy-1', 'update');
      await jest.advanceTimersByTimeAsync(ENTITY_SYNC_HANDOFF_TIMEOUT_MS);

      await expect(dispatch).resolves.toBe(false);
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/graph/entity-sync',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the same minimal browser contract for delete handoffs', async () => {
    await requestEntityGraphDeletion('company', 'company-1');

    const options = mockFetchWithAuth.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'delete',
    });
  });

  it('surfaces an unacknowledged browser handoff as a retryable dispatch error', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: jest.fn().mockResolvedValue({
        error: 'Graph synchronization handoff was not acknowledged',
      }),
    });

    await expect(requestEntityGraphDeletion('strategy', 'strategy-1')).rejects.toBeInstanceOf(EntitySyncDispatchError);
    await expect(requestEntityGraphDeletion('strategy', 'strategy-1')).resolves.toBeUndefined();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('partitions bulk handoffs so callers can retain only failed documents', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue({ acknowledged: ['p-1', 'p-3'], failed: ['p-2'] }),
    });

    const result = await requestEntityGraphDeletions('prototype', ['p-1', 'p-2', 'p-3']);

    expect(result.acknowledged).toEqual(['p-1', 'p-3']);
    expect(result.failed).toEqual([{ id: 'p-2', error: expect.any(EntitySyncDispatchError) }]);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetchWithAuth.mock.calls[0][1].body)).toEqual({
      entityType: 'prototype',
      entityIds: ['p-1', 'p-2', 'p-3'],
      operation: 'delete',
    });
  });

  it('retains every bulk document when the server acknowledgement is incomplete', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue({ acknowledged: ['c-1'], failed: [] }),
    });

    const result = await requestEntityGraphDeletions('company', ['c-1', 'c-2']);

    expect(result.acknowledged).toEqual([]);
    expect(result.failed.map(({ id }) => id)).toEqual(['c-1', 'c-2']);
  });

  it('surfaces required create/update failure after the committed Firestore mutation', async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error('route unavailable'));

    await expect(requestEntityGraphSync('technology', 'tech-1', 'create')).rejects.toThrow(
      'do not recreate the entity'
    );
  });

  it.each([
    { operation: 'update' as const, retainedTruth: 'do not recreate the entity' },
    { operation: 'delete' as const, retainedTruth: 'remains in Firestore' },
  ])(
    'bounds a stalled $operation handoff while preserving its mutation-boundary truth',
    async ({ operation, retainedTruth }) => {
      jest.useFakeTimers();
      try {
        mockFetchWithAuth.mockImplementationOnce((_url: string, options?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
              once: true,
            });
          });
        });

        const dispatch = requestEntityGraphSync('company', 'company-1', operation);
        const rejection = expect(dispatch).rejects.toThrow(
          expect.objectContaining({
            message: expect.stringContaining(retainedTruth),
          })
        );

        await jest.advanceTimersByTimeAsync(ENTITY_SYNC_HANDOFF_TIMEOUT_MS);
        await rejection;

        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          '/api/graph/entity-sync',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('keeps the legacy trigger best-effort while reporting the failure (GRAPH-056)', async () => {
    // The contract that matters is unchanged: a failed handoff never throws,
    // so no committed mutation is reported as rejected. Resolving to `false`
    // is what proves both halves at once — it did not reject, and it did not
    // pretend the handoff succeeded. The flag is what lets server callers
    // record a durable recovery anchor for a failure that must not surface as
    // an exception.
    mockSend.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);
  });

  it('reports a delivered handoff', async () => {
    mockSend.mockResolvedValueOnce({ ids: ['evt-1'] });

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(true);
  });

  it.each([{ ids: [] }, {}])('reports a resolved but empty acknowledgement as failed (%j)', async (response) => {
    mockSend.mockResolvedValueOnce(response);

    await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(false);
  });

  it('reports a kill-switched handoff as delivered rather than outstanding', async () => {
    // Suppression is deliberate operator policy, not a debt: anchoring every
    // write while sync is disabled would fill the collection with records no
    // retry could ever settle.
    const previous = process.env.GRAPH_SYNC_ENABLED;
    process.env.GRAPH_SYNC_ENABLED = 'false';
    try {
      await expect(triggerEntitySync('company', 'company-1', 'update')).resolves.toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GRAPH_SYNC_ENABLED;
      else process.env.GRAPH_SYNC_ENABLED = previous;
    }
  });

  it('exports all operation types', () => {
    const operations: EntitySyncOperation[] = ['create', 'update', 'delete'];
    expect(operations).toHaveLength(3);
  });
});
