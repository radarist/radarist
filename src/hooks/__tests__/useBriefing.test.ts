/**
 * Unit Tests for useBriefing Hook
 *
 * Pins two contracts:
 *   1. The query is gated on Firebase auth-state restoration via
 *      `useAuth()`. Until `loading` is false and a user is present, the
 *      query stays in `isPending` and the consumer keeps showing the
 *      skeleton instead of flashing the empty state. (Phase 0 step 0.10.)
 *   2. Once auth is ready, real API failures surface as a typed
 *      `BriefingRequestError` (UX-018) — an outage / rate-limit / auth
 *      failure is NOT swallowed into an empty inbox, so the page can render a
 *      distinct "unavailable / retry" state. `error.kind` classifies the
 *      failure from the HTTP status.
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// MOCKS
// ============================================================================

const mockUseAuth = jest.fn();

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

let mockStreamEvents: Array<{
  id: string;
  type: string;
  userId: string;
  agentType?: string;
  sequence: number;
  timestamp: string;
  data: Record<string, unknown>;
}> = [];
jest.mock('@/hooks/useAgentEventStream', () => ({
  useAgentEventStream: () => ({ events: mockStreamEvents, isConnected: true, connectionError: false }),
}));

// Import AFTER mocks
import { useBriefing, briefingKeys, BriefingRequestError, classifyBriefingStatus } from '../useBriefing';
import type { BriefingInsight, TokenUsageSummary, BriefingData } from '../useBriefing';

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

const MOCK_API_RESPONSE: BriefingData = {
  insights: [
    {
      id: 'insight-real-001',
      type: 'discovery',
      title: 'Real insight from API',
      summary: 'This came from the real API, not mock data',
      agentName: 'Scout',
      confidenceScore: 0.9,
      relatedEntities: [{ id: 'e1', name: 'Test', type: 'company' }],
      actionable: true,
      actionUrl: '/triage/signals',
      actionLabel: 'View',
      createdAt: '2026-02-25T00:00:00.000Z',
    },
  ],
  tokenUsage: { used: 5000, budget: 100000 },
};

const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useBriefing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockStreamEvents = [];
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  describe('briefingKeys', () => {
    it('should produce correct uid-scoped key shapes (UX-046)', () => {
      expect(briefingKeys.all).toEqual(['briefing']);
      expect(briefingKeys.forUser('u1')).toEqual(['briefing', 'u1']);
      expect(briefingKeys.insights('u1')).toEqual(['briefing', 'u1', 'insights']);
      expect(briefingKeys.detail('u1', 'pi-1')).toEqual(['briefing', 'u1', 'detail', 'pi-1']);
    });
  });

  describe('auth gating (Phase 0 step 0.10)', () => {
    it('does not fetch while Firebase auth is still restoring the session', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: true });

      const { result } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });

      // `isPending` stays true so the consumer keeps showing the skeleton.
      // `isFetching` is false because the query is disabled — we haven't
      // hit the network. This is the contract that fixes the empty-flash
      // regression where TanStack Query fired before auth was ready.
      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not fetch when auth has resolved but no user is signed in', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: false });

      const { result } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchBriefingInsights', () => {
    it('should call /api/impulse/briefing once auth is ready', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_API_RESPONSE,
      });

      const { result } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/impulse/briefing');
      expect(result.current.data).toEqual(MOCK_API_RESPONSE);
    });

    it.each([
      ['insight.created', 'interest-watch'],
      ['agent.completed', 'sweep-cycle'],
    ])('refetches without a page reload when external processing emits %s', async (type, agentType) => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ insights: [], tokenUsage: { used: 0, budget: 0 } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => MOCK_API_RESPONSE,
        });

      const { result, rerender } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.data?.insights).toEqual([]));

      mockStreamEvents = [
        {
          id: `evt-${type}`,
          type,
          userId: type === 'insight.created' ? SIGNED_IN_USER.uid : 'system-sweep',
          agentType,
          sequence: 1,
          timestamp: '2026-07-20T00:00:00.000Z',
          data: {},
        },
      ];
      rerender();

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.data?.insights).toEqual(MOCK_API_RESPONSE.insights));
    });

    it('does not refetch for unrelated external agent completions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ insights: [], tokenUsage: { used: 0, budget: 0 } }),
      });

      const { result, rerender } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      mockStreamEvents = [
        {
          id: 'evt-unrelated',
          type: 'agent.completed',
          userId: SIGNED_IN_USER.uid,
          agentType: 'creator',
          sequence: 1,
          timestamp: '2026-07-20T00:00:00.000Z',
          data: {},
        },
      ];
      rerender();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces a typed unavailable error on network rejection — never a fake empty inbox (UX-018)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeInstanceOf(BriefingRequestError);
      expect((result.current.error as BriefingRequestError).kind).toBe('unavailable');
    });

    it.each([
      [503, 'unavailable'],
      [500, 'unavailable'],
      [429, 'rate-limited'],
      [401, 'unauthorized'],
      [404, 'error'],
    ] as const)('classifies a %s response as kind "%s"', async (status, expectedKind) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status });

      const { result } = renderHook(() => useBriefing(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      const error = result.current.error as BriefingRequestError;
      expect(error).toBeInstanceOf(BriefingRequestError);
      expect(error.status).toBe(status);
      expect(error.kind).toBe(expectedKind);
    });
  });

  describe('classifyBriefingStatus', () => {
    it.each([
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'rate-limited'],
      [500, 'unavailable'],
      [502, 'unavailable'],
      [503, 'unavailable'],
      [400, 'error'],
      [404, 'error'],
    ] as const)('maps %s → %s', (status, kind) => {
      expect(classifyBriefingStatus(status)).toBe(kind);
    });
  });

  describe('type exports', () => {
    it('should export BriefingInsight type with required fields', () => {
      const insight: BriefingInsight = MOCK_API_RESPONSE.insights[0];
      expect(insight.id).toBeDefined();
      expect(insight.type).toBeDefined();
      expect(insight.title).toBeDefined();
      expect(insight.summary).toBeDefined();
      expect(insight.agentName).toBeDefined();
      expect(insight.confidenceScore).toBeDefined();
      expect(insight.relatedEntities).toBeDefined();
      expect(insight.actionable).toBeDefined();
      expect(insight.createdAt).toBeDefined();
    });

    it('should export TokenUsageSummary type', () => {
      const usage: TokenUsageSummary = { used: 100, budget: 1000 };
      expect(usage.used).toBe(100);
      expect(usage.budget).toBe(1000);
    });

    it('should export BriefingData type', () => {
      const data: BriefingData = MOCK_API_RESPONSE;
      expect(data.insights).toBeDefined();
      expect(data.tokenUsage).toBeDefined();
    });
  });

  describe('hook exports', () => {
    it('should export useBriefing as a function', () => {
      expect(typeof useBriefing).toBe('function');
    });

    it('should export briefingKeys factory', () => {
      expect(typeof briefingKeys).toBe('object');
      expect(typeof briefingKeys.insights).toBe('function');
    });
  });
});
