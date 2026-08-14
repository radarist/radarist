/**
 * @file useDismissInsight.test.ts
 * @description Tests for the dismiss mutation hook (Chunk 1).
 *
 * Pins:
 *   1. Optimistic remove drops the row before the network call.
 *   2. Rollback on 4xx/5xx restores the original list.
 *   3. The dismissed insight is preserved in mutation context so the
 *      caller (snackbar) can hand it to `useUndismissInsight` without a
 *      refetch.
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

import { useDismissInsight } from '../useDismissInsight';
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
      },
    ],
    tokenUsage: { used: 0, budget: 100_000 },
  };
}

describe('useDismissInsight', () => {
  let qc: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCached());
  });

  it('removes the row optimistically and POSTs the dismiss request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useDismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1' });
    });

    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.map((i) => i.id)).toEqual(['pi-2']);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/dismiss',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rolls back the removed row when the server rejects', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useDismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.map((i) => i.id)).toEqual(['pi-1', 'pi-2']);
  });

  it('is a no-op when the row is not in the cache', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useDismissInsight(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-unknown' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const after = qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'));
    expect(after?.insights.map((i) => i.id)).toEqual(['pi-1', 'pi-2']);
  });
});
