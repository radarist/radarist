/**
 * Unit Tests for useAgentActivity Hooks (useAgentLog, useTokenUsage)
 *
 * Tests the agent activity hooks wired to the Activity API:
 * - activityKeys key factory produces correct shapes (all, log, tokens, tokensByPeriod)
 * - useAgentLog calls /api/activity/log with auth header
 * - useAgentLog returns entries from API
 * - useAgentLog returns empty array when entries field is missing
 * - useAgentLog errors when not authenticated
 * - useAgentLog errors when response is not ok
 * - useTokenUsage calls /api/activity/tokens with auth header
 * - useTokenUsage returns token summary from API
 * - useTokenUsage errors when not authenticated
 * - useTokenUsage errors when response is not ok
 * - Auth gating (P-A4 pattern, Task 24 follow-up): useAgentLog / useTokenUsage /
 *   useTokensByAgent stay disabled (no fetch) until Firebase auth-state
 *   restoration completes with a signed-in user, and report isLoading (derived
 *   from isPending) while the gate holds — no 401 console noise, no
 *   flash-of-empty-state on /agents/runs
 * - Type exports (AgentLogEntry, TokenUsageSummary)
 * - Hook and key exports
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// MOCKS
// ============================================================================

const mockGetIdToken = jest.fn().mockResolvedValue('mock-token');

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    currentUser: {
      getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    },
  },
}));

// Mock global fetch
const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// Auth gate (P-A4 pattern) — the hooks read `useAuth()` and stay disabled
// until session restoration resolves with a user. Default: signed in, so the
// pre-existing fetch/response tests run against an open gate unchanged.
const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));
const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

// Import AFTER mocks
import { useAgentLog, useTokenUsage, useTokensByAgent, activityKeys } from '../useAgentActivity';
import type { AgentLogEntry, AgentLogEntryStatus, TokenUsageDay, TokenUsageSummary } from '../useAgentActivity';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const MOCK_LOG_ENTRY: AgentLogEntry = {
  id: 'log-001',
  agentName: 'Scout',
  action: 'signal-discovery',
  status: 'success',
  sweepId: 'sweep-abc',
  tokenUsage: { input: 1200, output: 800 },
  duration: 4500,
  createdAt: '2026-02-25T10:00:00.000Z',
};

const MOCK_LOG_ENTRY_FAILURE: AgentLogEntry = {
  id: 'log-002',
  agentName: 'Evaluator',
  action: 'signal-scoring',
  status: 'failure',
  tokenUsage: { input: 500, output: 0 },
  duration: 1200,
  errors: ['Gemini API timeout'],
  createdAt: '2026-02-25T09:30:00.000Z',
};

const MOCK_LOG_ENTRY_WITH_MISSION: AgentLogEntry = {
  id: 'log-003',
  agentName: 'Creator',
  action: 'report-generation',
  status: 'success',
  missionId: 'mission-123',
  tokenUsage: { input: 2000, output: 1500 },
  duration: 9000,
  createdAt: '2026-02-25T11:00:00.000Z',
};

const MOCK_LOG_ENTRY_CHAT: AgentLogEntry = {
  id: 'log-chat-001',
  agentName: 'chat',
  action: 'Research quantum sensing',
  kind: 'chat',
  provider: 'gemini',
  model: 'gemini-3.5-pro',
  status: 'success',
  tokenUsage: { input: 300, output: 120 },
  duration: 900,
  toolSummary: [
    { name: 'searchEntities', status: 'success', durationMs: 25 },
    { name: 'createRelation', status: 'failure' },
  ],
  toolSummaryTruncated: true,
  createdAt: '2026-02-25T11:30:00.000Z',
};

const MOCK_TOKEN_USAGE: TokenUsageSummary = {
  today: {
    date: '2026-02-25',
    input: 15000,
    output: 8000,
    total: 23000,
  },
  thisWeek: [
    { date: '2026-02-24', input: 12000, output: 6000, total: 18000 },
    { date: '2026-02-25', input: 15000, output: 8000, total: 23000 },
  ],
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useAgentActivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  // ==========================================================================
  // QUERY KEY FACTORY
  // ==========================================================================

  describe('activityKeys', () => {
    it('should produce correct key shape for all', () => {
      expect(activityKeys.all).toEqual(['activity']);
    });

    it('should produce correct uid-scoped key shape for log (UX-046)', () => {
      expect(activityKeys.log('u1')).toEqual(['activity', 'u1', 'log']);
    });

    it('should produce correct uid-scoped key shape for tokens (UX-046)', () => {
      expect(activityKeys.tokens('u1')).toEqual(['activity', 'u1', 'tokens']);
    });

    it('should produce correct uid-scoped key shape for tokensByPeriod (UX-046)', () => {
      expect(activityKeys.tokensByPeriod('u1', 'weekly')).toEqual(['activity', 'u1', 'tokens', 'weekly']);
      expect(activityKeys.tokensByPeriod('u1', 'daily')).toEqual(['activity', 'u1', 'tokens', 'daily']);
    });
  });

  // ==========================================================================
  // useAgentLog
  // ==========================================================================

  describe('useAgentLog', () => {
    it('should call /api/activity/log with Authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [MOCK_LOG_ENTRY] }),
      });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/activity/log');
    });

    it('should return entries from API response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [MOCK_LOG_ENTRY, MOCK_LOG_ENTRY_FAILURE] }),
      });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([MOCK_LOG_ENTRY, MOCK_LOG_ENTRY_FAILURE]);
      expect(result.current.data).toHaveLength(2);
      expect(result.current.degradedKinds).toEqual([]);
    });

    it('surfaces bounded per-kind history degradation without discarding available rows', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [MOCK_LOG_ENTRY], degradedKinds: ['mission', 'invalid', 'mission'] }),
      });

      const { result } = renderHook(() => useAgentLog(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([MOCK_LOG_ENTRY]);
      expect(result.current.degradedKinds).toEqual(['mission']);
    });

    it('should preserve missionId on entries returned from the API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [MOCK_LOG_ENTRY_WITH_MISSION, MOCK_LOG_ENTRY] }),
      });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.[0].missionId).toBe('mission-123');
      expect(result.current.data?.[1].missionId).toBeUndefined();
    });

    it('preserves the bounded chat classification, provider, model, and tool summary', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [MOCK_LOG_ENTRY_CHAT] }),
      });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.[0]).toEqual(MOCK_LOG_ENTRY_CHAT);
    });

    it('should return empty array when entries field is missing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([]);
    });

    it('should enter error state when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { result } = renderHook(() => useAgentLog(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Failed to fetch agent log: 500');
    });
  });

  // ==========================================================================
  // useTokenUsage
  // ==========================================================================

  describe('useTokenUsage', () => {
    it('should call /api/activity/tokens with Authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_TOKEN_USAGE,
      });

      const { result } = renderHook(() => useTokenUsage(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/activity/tokens');
    });

    it('should return token usage summary from API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_TOKEN_USAGE,
      });

      const { result } = renderHook(() => useTokenUsage(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(MOCK_TOKEN_USAGE);
      expect(result.current.data?.today.total).toBe(23000);
      expect(result.current.data).not.toHaveProperty('dailyBudget');
      expect(result.current.data?.thisWeek).toHaveLength(2);
    });

    it('should enter error state when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const { result } = renderHook(() => useTokenUsage(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Failed to fetch token usage: 503');
    });
  });

  // ==========================================================================
  // AUTH GATING (P-A4 pattern — Task 24 follow-up). Contract per
  // useProposedEntities.test.ts: no fetch while auth is restoring, no fetch
  // signed out, fetch once signed in. Plus the flash-of-empty-state guard:
  // the returned isLoading is derived from isPending, so consumers keep
  // their skeleton up while the gate holds (a disabled query's native
  // isLoading is false).
  // ==========================================================================

  describe('auth gating', () => {
    const hooks = [
      ['useAgentLog', useAgentLog],
      ['useTokenUsage', useTokenUsage],
      ['useTokensByAgent', useTokensByAgent],
    ] as const;

    describe.each(hooks)('%s', (_name, useHook) => {
      it('does not fetch while Firebase auth is still restoring the session', () => {
        mockUseAuth.mockReturnValue({ user: null, loading: true });

        const { result } = renderHook(() => useHook(), { wrapper: createWrapper() });

        expect(result.current.isPending).toBe(true);
        expect(result.current.isFetching).toBe(false);
        // isLoading must mirror isPending while the gate holds — the
        // /agents/runs skeleton (and the cost strip's null-render) key off it.
        expect(result.current.isLoading).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('does not fetch when auth has resolved but no user is signed in', () => {
        mockUseAuth.mockReturnValue({ user: null, loading: false });

        const { result } = renderHook(() => useHook(), { wrapper: createWrapper() });

        expect(result.current.isPending).toBe(true);
        expect(result.current.isFetching).toBe(false);
        expect(result.current.isLoading).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    it('fetches once auth has resolved with a signed-in user — the session the app actually sends', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [MOCK_LOG_ENTRY] }) });

      const { result } = renderHook(() => useAgentLog(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.isLoading).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith('/api/activity/log');
    });
  });

  // ==========================================================================
  // TYPE EXPORTS
  // ==========================================================================

  describe('type exports', () => {
    it('should export AgentLogEntry type with required fields', () => {
      const entry: AgentLogEntry = MOCK_LOG_ENTRY;
      expect(entry.id).toBeDefined();
      expect(entry.agentName).toBeDefined();
      expect(entry.action).toBeDefined();
      expect(entry.status).toBeDefined();
      // tokenUsage is optional at the type level (absent = not recorded,
      // ARUN-020) but always present on server-recorded runs like this one.
      expect(entry.tokenUsage).toBeDefined();
      expect(entry.tokenUsage?.input).toBeDefined();
      expect(entry.tokenUsage?.output).toBeDefined();
      expect(entry.duration).toBeDefined();
      expect(entry.createdAt).toBeDefined();
    });

    it('should export AgentLogEntryStatus type', () => {
      const statuses: AgentLogEntryStatus[] = ['success', 'failure', 'skipped'];
      expect(statuses).toHaveLength(3);
    });

    it('should export TokenUsageDay type', () => {
      const day: TokenUsageDay = MOCK_TOKEN_USAGE.today;
      expect(day.date).toBeDefined();
      expect(day.input).toBeDefined();
      expect(day.output).toBeDefined();
      expect(day.total).toBeDefined();
      expect(day).not.toHaveProperty('budget');
    });

    it('should export TokenUsageSummary type', () => {
      const summary: TokenUsageSummary = MOCK_TOKEN_USAGE;
      expect(summary.today).toBeDefined();
      expect(summary.thisWeek).toBeDefined();
      expect(summary).not.toHaveProperty('dailyBudget');
    });
  });

  // ==========================================================================
  // HOOK EXPORTS
  // ==========================================================================

  describe('hook exports', () => {
    it('should export useAgentLog as a function', () => {
      expect(typeof useAgentLog).toBe('function');
    });

    it('should export useTokenUsage as a function', () => {
      expect(typeof useTokenUsage).toBe('function');
    });

    it('should export activityKeys factory', () => {
      expect(typeof activityKeys).toBe('object');
      expect(typeof activityKeys.log).toBe('function');
      expect(typeof activityKeys.tokens).toBe('function');
      expect(typeof activityKeys.tokensByPeriod).toBe('function');
    });
  });
});
