/**
 * @file hooks/__tests__/useDefenseVerifications.test.tsx
 * @description UX-068 regressions for the Activity → Jobs data hook.
 *
 * The Jobs table sorts, searches and paginates on the client, so it needs a
 * window it actually holds. This locks in how that window is obtained: the
 * server's own bound is respected (`limit` = the route maximum), the cursor is
 * followed only on demand, `hasMore` reports the server's `nextCursor` truthfully,
 * a filter change restarts pagination, and a run that reappears across two
 * cursor pages is counted once.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

let mockAuth = { user: { uid: 'user-1' } as { uid: string } | null, loading: false };
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}));

import { DEFENSE_VERIFICATION_WINDOW, useDefenseVerificationJobs } from '../useDefenseVerifications';
import type { DefenseVerificationRow } from '@/lib/activity/defense-verification-types';

function row(id: string): DefenseVerificationRow {
  return {
    id,
    kind: 'entity',
    status: 'completed',
    attempts: 1,
    startedAt: 1_700_000_000_000,
    providers: [],
    models: [],
    cost: { state: 'unavailable', display: '—' },
  };
}

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

/** The URL the hook asked for on its `n`-th call. */
function requestedUrl(callIndex: number): URL {
  return new URL(String(mockFetchWithAuth.mock.calls[callIndex][0]), 'http://localhost');
}

describe('useDefenseVerificationJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth = { user: { uid: 'user-1' }, loading: false };
  });

  it('requests the route maximum in one round trip and reports no more when the cursor is null', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ verifications: [row('a')], nextCursor: null }));

    const { result } = renderHook(() => useDefenseVerificationJobs(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(requestedUrl(0).searchParams.get('limit')).toBe(String(DEFENSE_VERIFICATION_WINDOW));
    expect(requestedUrl(0).searchParams.get('cursor')).toBeNull();
    expect(result.current.jobs.map((j) => j.id)).toEqual(['a']);
    expect(result.current.hasMore).toBe(false);
  });

  it('reports more rows beyond the window and follows the cursor only on demand', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonOk({ verifications: [row('a')], nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(jsonOk({ verifications: [row('b')], nextCursor: null }));

    const { result } = renderHook(() => useDefenseVerificationJobs(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasMore).toBe(true);
    // Nothing beyond the first window is fetched until the operator asks.
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.jobs).toHaveLength(2));

    expect(requestedUrl(1).searchParams.get('cursor')).toBe('cursor-1');
    expect(result.current.jobs.map((j) => j.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
  });

  it('counts a run once when it reappears across two cursor pages', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonOk({ verifications: [row('a'), row('b')], nextCursor: 'cursor-1' }))
      // A concurrent write shifted the page boundary, so 'b' comes back again.
      .mockResolvedValueOnce(jsonOk({ verifications: [row('b'), row('c')], nextCursor: null }));

    const { result } = renderHook(() => useDefenseVerificationJobs(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));

    expect(result.current.jobs.map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });

  it('sends the server-side kind and status filters and restarts pagination when they change', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonOk({ verifications: [row('a')], nextCursor: null }));

    const { result, rerender } = renderHook(
      ({ kind }: { kind: 'entity' | 'edge' }) => useDefenseVerificationJobs({ kind, status: 'failed' }),
      { wrapper: wrapper(), initialProps: { kind: 'entity' } as { kind: 'entity' | 'edge' } }
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(requestedUrl(0).searchParams.get('kind')).toBe('entity');
    expect(requestedUrl(0).searchParams.get('status')).toBe('failed');

    rerender({ kind: 'edge' });
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));

    // A new filter is a new query: it starts from the first page, not the
    // cursor the previous filter left behind.
    expect(requestedUrl(1).searchParams.get('kind')).toBe('edge');
    expect(requestedUrl(1).searchParams.get('cursor')).toBeNull();
  });

  it('surfaces a non-2xx response as an error rather than an empty list', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useDefenseVerificationJobs(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    expect(result.current.error?.message).toContain('500');
    expect(result.current.jobs).toEqual([]);
  });

  it('stays disabled until auth-state restoration completes', () => {
    mockAuth = { user: null, loading: true };

    const { result } = renderHook(() => useDefenseVerificationJobs(), { wrapper: wrapper() });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.jobs).toEqual([]);
  });
});
