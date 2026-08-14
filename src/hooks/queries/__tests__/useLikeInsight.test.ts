/**
 * @file useLikeInsight.test.ts
 * @description Tests for the like/unlike mutation hook (Chunk 1).
 *
 * Pins:
 *   1. POST/DELETE chosen by the `liked` boolean — endpoint idempotency
 *      lives server-side, the hook just picks the verb.
 *   2. Optimistic cache patch flips the row's `liked` immediately.
 *   3. Error rolls back to the pre-mutation snapshot.
 *   4. 429 surfaces a "Rate limit exceeded" Error so consumers can show
 *      a calm toast rather than treating it as a generic failure.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// `useBriefing.ts` exports the `briefingKeys` factory we depend on, but its
// module init also pulls AuthProvider → firebase/auth. Stub both so the
// hook's transitive imports don't try to initialise the Firebase SDK.
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useLikeInsight } from '../useLikeInsight';
import { briefingKeys, type BriefingData } from '@/hooks/useBriefing';

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeCached(): BriefingData {
  return {
    insights: [
      {
        id: 'pi-1',
        type: 'discovery',
        title: 'A',
        summary: '',
        agentName: 'scout',
        confidenceScore: 0.8,
        relatedEntities: [],
        actionable: true,
        actionUrl: '/library/companies?sheet=c1',
        actionLabel: 'View',
        createdAt: '2026-05-13T00:00:00.000Z',
        liked: false,
      },
      {
        id: 'pi-2',
        type: 'connection',
        title: 'B',
        summary: '',
        agentName: 'linker',
        confidenceScore: 0.7,
        relatedEntities: [],
        actionable: true,
        actionUrl: '/library/companies?sheet=c2',
        actionLabel: 'View',
        createdAt: '2026-05-13T00:01:00.000Z',
        liked: true,
      },
    ],
    tokenUsage: { used: 0, budget: 100_000 },
  };
}

describe('useLikeInsight', () => {
  let qc: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCached());
  });

  it('POSTs when liked=true and patches the cached row optimistically', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useLikeInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1', liked: true });
    });

    // Optimistic patch landed before the fetch resolves.
    const patched = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(patched?.insights.find((i) => i.id === 'pi-1')?.liked).toBe(true);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/like',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ insightId: 'pi-1' }) })
    );
  });

  it('DELETEs when liked=false and patches the cached row', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useLikeInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-2', liked: false });
    });

    expect(
      qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'))?.insights.find((i) => i.id === 'pi-2')?.liked
    ).toBe(false);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('rolls back to the prior cache when the request fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useLikeInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1', liked: true });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Rollback restored the original `liked: false` value.
    const rolledBack = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(rolledBack?.insights.find((i) => i.id === 'pi-1')?.liked).toBe(false);
  });

  it('surfaces a "Rate limit" message on 429', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => '', statusText: 'Too Many Requests' });

    const { result } = renderHook(() => useLikeInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1', liked: true });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/Rate limit/i);
  });
});
