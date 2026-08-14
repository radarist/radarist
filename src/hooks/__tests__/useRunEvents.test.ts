/**
 * Unit Tests for useRunEvents
 *
 * Split out of useAgentActivity.test.ts (Task 22 fix — CRITICAL finding):
 * useRunEvents' `useAuth` import statically pulls in `firebase/auth`, which
 * broke useAgentActivity.test.ts (that suite mocks `@/lib/firebase` but not
 * `@/components/providers/AuthProvider`). Living in its own hook file/test
 * file keeps the two import graphs — and their mocks — independent.
 *
 * Covers:
 * - runEventsKeys key factory shape (all, detail)
 * - fetches from the scoped run-events endpoint with Authorization header
 * - returns { events, truncated } from the API response
 * - defaults truncated to false and events to [] when the fields are missing
 * - disabled (no fetch) while auth is loading, unauthenticated, or runId is undefined
 * - enters error state when the response is not ok
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// MOCKS
// ============================================================================

let mockUser: { uid: string } | null = { uid: 'test-user' };
let mockAuthLoading = false;
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, loading: mockAuthLoading }),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// Import AFTER mocks
import { useRunEvents, runEventsKeys } from '../useRunEvents';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const MOCK_EVENT = {
  id: 'evt-1',
  type: 'agent.started',
  userId: 'test-user',
  missionId: 'mission-1',
  sequence: 10,
  timestamp: '2026-07-06T00:00:00.000Z',
  data: {},
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useRunEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { uid: 'test-user' };
    mockAuthLoading = false;
  });

  describe('runEventsKeys', () => {
    it('produces the correct key shape for all', () => {
      expect(runEventsKeys.all).toEqual(['activity', 'run-events']);
    });

    it('produces the correct key shape for detail(runId)', () => {
      expect(runEventsKeys.detail('mission-1')).toEqual(['activity', 'run-events', 'mission-1']);
    });
  });

  it('fetches the scoped run-events endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events: [MOCK_EVENT], truncated: false }),
    });

    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledWith('/api/agents/runs/mission-1/events');
  });

  it('returns { events, truncated } from the API response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ events: [MOCK_EVENT], truncated: true }),
    });

    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ events: [MOCK_EVENT], truncated: true });
  });

  it('defaults events to [] and truncated to false when the API response omits them', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ events: [], truncated: false });
  });

  it('enters error state when the response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Failed to fetch run events: 500');
  });

  it('does not fetch when runId is undefined (unresolvable scope), and does NOT pin isLoading true (permanent, not transient)', () => {
    const { result } = renderHook(() => useRunEvents(undefined), { wrapper: createWrapper() });
    expect(mockFetch).not.toHaveBeenCalled();
    // Auth has already resolved here — an undefined runId means the scope is
    // permanently unresolvable (a chat/sweep-cycle run with no scoped
    // agent-events at all), not a transient auth-restore gap. isLoading must
    // stay false so the run detail page falls through to its "scope
    // unresolvable" note instead of spinning the Event Log skeleton forever.
    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch while auth is still loading, and pins isLoading true so the Event Log does not flash empty', () => {
    mockAuthLoading = true;
    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    // isLoading must mirror the auth-restore gate specifically — this is the
    // transient case the fix targets (matches the sibling hooks in
    // useAgentActivity.ts).
    expect(result.current.isLoading).toBe(true);
  });

  it('does not fetch when there is no authenticated user, and does NOT pin isLoading true (permanent, not transient)', () => {
    mockUser = null;
    const { result } = renderHook(() => useRunEvents('mission-1'), { wrapper: createWrapper() });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });
});
