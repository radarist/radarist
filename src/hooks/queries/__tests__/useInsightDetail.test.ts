/**
 * @file useInsightDetail.test.ts
 * @description Tests for the insight detail-page query (Chunk 1).
 *
 * Pins:
 *   1. Auth gating — query is `isPending` while auth still loading, no
 *      fetch fires (matches the Phase 0 step 0.10 contract).
 *   2. 404 resolves to `data: null` (deep-link to a deleted insight).
 *   3. 200 returns the parsed JSON including A.0 fields.
 *   4. retry=false — terminal 4xx don't hammer the server.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// This unit targets the detail hook, not the list hook's SSE/Firebase import
// graph. Keep the shared query/error contract real-shaped without loading a
// browser SDK that requires `fetch` during module initialization.
jest.mock('@/hooks/useBriefing', () => {
  class BriefingRequestError extends Error {
    constructor(
      readonly status: number,
      readonly kind: string,
      message: string
    ) {
      super(message);
      this.name = 'BriefingRequestError';
    }
  }

  return {
    briefingKeys: {
      detail: (uid: string, insightId: string) => ['briefing', uid, 'detail', insightId],
    },
    BriefingRequestError,
    classifyBriefingStatus: (status: number) => (status === 401 ? 'unauthorized' : 'unavailable'),
  };
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useInsightDetail } from '../useInsightDetail';

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useInsightDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-claudio' }, loading: false });
  });

  it('does not fetch while auth is still restoring', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    const { result } = renderHook(() => useInsightDetail('pi-1'), { wrapper: createWrapper() });
    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when insightId is undefined', () => {
    const { result } = renderHook(() => useInsightDetail(undefined), { wrapper: createWrapper() });
    expect(result.current.isPending).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the parsed payload including A.0 structured-path fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'pi-1',
        type: 'connection',
        title: 'Quantum-IBM link',
        summary: 'VENDOR → USES',
        agentName: 'scout',
        confidenceScore: 0.7,
        relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
        actionable: true,
        actionUrl: '/library/companies?sheet=comp-ibm',
        actionLabel: 'View company',
        createdAt: '2026-05-13T00:00:00.000Z',
        liked: true,
        relationshipTypes: ['VENDOR', 'USES'],
        pathLength: 2,
        exploredAt: '2026-05-10T12:00:00.000Z',
      }),
    });

    const { result } = renderHook(() => useInsightDetail('pi-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledWith('/api/impulse/briefing/pi-1');
    expect(result.current.data?.relationshipTypes).toEqual(['VENDOR', 'USES']);
    expect(result.current.data?.exploredAt).toBe('2026-05-10T12:00:00.000Z');
  });

  it('resolves to null on 404 — deep-link to a deleted insight', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const { result } = renderHook(() => useInsightDetail('missing'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });

  it('URL-encodes the insightId path segment', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const { result } = renderHook(() => useInsightDetail('pi/with slash'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledWith('/api/impulse/briefing/pi%2Fwith%20slash');
  });
});
