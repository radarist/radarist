/**
 * @file useBulkDismissInsights.test.ts
 * @description Tests for the bulk dismiss / undismiss mutation (Chunk 1).
 *
 * Pins:
 *   1. dismiss=true → POST with `insightIds`, batch removed optimistically.
 *   2. dismiss=false → DELETE with the same ids extracted from carried
 *      insights, batch prepended optimistically.
 *   3. Rollback on error.
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

import { useBulkDismissInsights } from '../useBulkDismissInsights';
import { briefingKeys, type BriefingData, type BriefingInsight } from '@/hooks/useBriefing';

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeInsight(id: string): BriefingInsight {
  return {
    id,
    type: 'discovery',
    title: id,
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.8,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
  };
}

function makeCached(ids: string[]): BriefingData {
  return {
    insights: ids.map(makeInsight),
    tokenUsage: { used: 0, budget: 100_000 },
  };
}

describe('useBulkDismissInsights', () => {
  let qc: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it('POSTs and removes the batch optimistically when dismiss=true', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCached(['pi-1', 'pi-2', 'pi-3']));
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const { result } = renderHook(() => useBulkDismissInsights(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ dismiss: true, insightIds: ['pi-1', 'pi-3'] });
    });

    expect(qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'))?.insights.map((i) => i.id)).toEqual([
      'pi-2',
    ]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/bulk-dismiss',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ insightIds: ['pi-1', 'pi-3'] }),
      })
    );
  });

  it('DELETEs and prepends the batch optimistically when dismiss=false', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCached(['pi-2']));
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const insights = [makeInsight('pi-1'), makeInsight('pi-3')];
    const { result } = renderHook(() => useBulkDismissInsights(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ dismiss: false, insights });
    });

    expect(qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'))?.insights.map((i) => i.id)).toEqual([
      'pi-1',
      'pi-3',
      'pi-2',
    ]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/bulk-dismiss',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ insightIds: ['pi-1', 'pi-3'] }),
      })
    );
  });

  it('rolls back the cache when the server rejects', async () => {
    qc.setQueryData(briefingKeys.insights('user-claudio'), makeCached(['pi-1', 'pi-2', 'pi-3']));
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useBulkDismissInsights(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ dismiss: true, insightIds: ['pi-1', 'pi-3'] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<BriefingData>(briefingKeys.insights('user-claudio'))?.insights.map((i) => i.id)).toEqual([
      'pi-1',
      'pi-2',
      'pi-3',
    ]);
  });
});
