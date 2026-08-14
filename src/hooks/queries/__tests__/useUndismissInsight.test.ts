/**
 * @file useUndismissInsight.test.ts
 * @description Tests for the dismiss undo mutation (Chunk 1).
 *
 * Pins:
 *   1. DELETE verb hits the dismiss endpoint with `insightId`.
 *   2. The carried insight is prepended into the cache before the
 *      request lands (optimistic restore).
 *   3. Duplicates are filtered out — re-running undo when the row has
 *      already been re-fetched by a background invalidate does not
 *      double-insert.
 *   4. Server error rolls back to the pre-undo cache.
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

// `useBriefing.ts` re-exports `briefingKeys` and types we depend on, but
// its module init pulls AuthProvider → firebase/auth. Stub both.
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useUndismissInsight } from '../useUndismissInsight';
import { briefingKeys, type BriefingData, type BriefingInsight } from '@/hooks/useBriefing';

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const RESTORED_INSIGHT: BriefingInsight = {
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
};

function makeCachedWithout(): BriefingData {
  return {
    insights: [
      {
        ...RESTORED_INSIGHT,
        id: 'pi-2',
        title: 'B',
        createdAt: '2026-05-13T00:01:00.000Z',
      },
    ],
    tokenUsage: { used: 0, budget: 100_000 },
  };
}

describe('useUndismissInsight', () => {
  let qc: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it('prepends the restored insight optimistically and DELETEs the endpoint', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCachedWithout());
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useUndismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insight: RESTORED_INSIGHT });
    });

    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.map((i) => i.id)).toEqual(['pi-1', 'pi-2']);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/dismiss',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ insightId: 'pi-1' }) })
    );
  });

  it('de-duplicates when the insight is already present in the cache (background refetch race)', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), {
      insights: [RESTORED_INSIGHT, { ...RESTORED_INSIGHT, id: 'pi-2', title: 'B' }],
      tokenUsage: { used: 0, budget: 100_000 },
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useUndismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insight: RESTORED_INSIGHT });
    });

    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.filter((i) => i.id === 'pi-1')).toHaveLength(1);
  });

  it('rolls back to the prior cache when the server rejects', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCachedWithout());
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useUndismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insight: RESTORED_INSIGHT });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.map((i) => i.id)).toEqual(['pi-2']);
  });
});
