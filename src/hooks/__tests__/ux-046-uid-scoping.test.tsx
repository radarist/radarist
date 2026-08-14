/**
 * @file ux-046-uid-scoping.test.tsx
 * @description UX-046 — account-scoped query caches and visible-tab freshness.
 *
 * Contract:
 *   1. `briefingKeys` and `activityKeys` are uid-scoped: every key embeds the
 *      account, so a user switch can never serve another account's cache.
 *   2. A→B switch behavior: the second account triggers its own fetch and
 *      renders its own data — never the first account's rows.
 *   3. Visible-tab freshness: runs / insights / token queries refetch on a
 *      bounded interval while the tab is visible, pause while hidden, and
 *      refetch on focus return once stale.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { activityKeys, useAgentLog, useTokenUsage } from '../useAgentActivity';
import { briefingKeys, useBriefing } from '../useBriefing';

function jsonResponse(payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => payload };
}

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('UX-046 — uid-scoped query keys', () => {
  it('activityKeys embed the account uid', () => {
    expect(activityKeys.log('u1')).toEqual(['activity', 'u1', 'log']);
    expect(activityKeys.tokens('u1')).toEqual(['activity', 'u1', 'tokens']);
    expect(activityKeys.tokensByAgent('u1')).toEqual(['activity', 'u1', 'tokens-by-agent']);
    expect(activityKeys.tokensByPeriod('u1', '7d')).toEqual(['activity', 'u1', 'tokens', '7d']);
  });

  it('briefingKeys embed the account uid', () => {
    expect(briefingKeys.insights('u1')).toEqual(['briefing', 'u1', 'insights']);
    expect(briefingKeys.detail('u1', 'pi-9')).toEqual(['briefing', 'u1', 'detail', 'pi-9']);
  });

  it('two accounts never share a key', () => {
    expect(activityKeys.log('user-a')).not.toEqual(activityKeys.log('user-b'));
    expect(briefingKeys.insights('user-a')).not.toEqual(briefingKeys.insights('user-b'));
  });
});

describe('UX-046 — A→B account switch serves the new account, never the old cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('useAgentLog refetches for the new uid and renders its data', async () => {
    const { Wrapper } = createHarness();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        entries: [
          {
            id: 'run-a',
            agentName: 'scout',
            action: 'Run for A',
            status: 'success',
            duration: 1,
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ],
        degradedKinds: [],
      })
    );

    const { result, rerender } = renderHook(() => useAgentLog(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    mockUseAuth.mockReturnValue({ user: { uid: 'user-b' }, loading: false });
    mockFetch.mockResolvedValueOnce(jsonResponse({ entries: [], degradedKinds: [] }));
    rerender();

    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('useBriefing refetches for the new uid and renders its data', async () => {
    const { Wrapper } = createHarness();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        insights: [
          {
            id: 'pi-a',
            type: 'discovery',
            title: 'Insight for A',
            summary: '',
            agentName: 'scout',
            confidenceScore: 0.9,
            relatedEntities: [],
            actionable: false,
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ],
        tokenUsage: { used: 0, budget: 0 },
      })
    );

    const { result, rerender } = renderHook(() => useBriefing(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.insights).toHaveLength(1));

    mockUseAuth.mockReturnValue({ user: { uid: 'user-b' }, loading: false });
    mockFetch.mockResolvedValueOnce(jsonResponse({ insights: [], tokenUsage: { used: 0, budget: 0 } }));
    rerender();

    await waitFor(() => expect(result.current.data?.insights).toEqual([]));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('UX-046 — visible-tab freshness (interval, hidden pause, focus refetch)', () => {
  let visibilityState: DocumentVisibilityState = 'visible';

  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    visibilityState = 'visible';
    focusManager.setFocused(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setVisibility(next: DocumentVisibilityState): void {
    visibilityState = next;
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('useAgentLog: 60s interval while visible, paused hidden, focus refetch once stale', async () => {
    jest.useFakeTimers();
    const { Wrapper } = createHarness();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    mockFetch.mockImplementation(async () => jsonResponse({ entries: [], degradedKinds: [] }));

    renderHook(() => useAgentLog(), { wrapper: Wrapper });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Bounded interval fires while the tab is visible.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Hidden tab: the interval must pause — no background polling.
    setVisibility('hidden');
    await act(async () => {
      jest.advanceTimersByTime(180_000);
    });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Returning to the tab refetches immediately (data is long stale).
    setVisibility('visible');
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('useTokenUsage: bounded 120s interval while visible', async () => {
    jest.useFakeTimers();
    const { Wrapper } = createHarness();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    mockFetch.mockImplementation(async () =>
      jsonResponse({ today: { date: '2026-07-18', input: 0, output: 0, total: 0 }, thisWeek: [] })
    );

    renderHook(() => useTokenUsage(), { wrapper: Wrapper });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('useBriefing: bounded 60s interval while visible', async () => {
    jest.useFakeTimers();
    const { Wrapper } = createHarness();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    mockFetch.mockImplementation(async () => jsonResponse({ insights: [], tokenUsage: { used: 0, budget: 0 } }));

    renderHook(() => useBriefing(), { wrapper: Wrapper });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flushMicrotasks();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
