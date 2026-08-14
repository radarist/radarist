/**
 * @file useRunsFilters.test.tsx
 * @description ARUN-026 — multi-select Agent / Kind / Status facet state
 * for the Runs table.
 *
 * Contract:
 *   1. OR within a facet, AND across facets (and with the search box).
 *   2. URL state wins over the saved preference; the saved preference is
 *      the fallback when the URL carries no facet params.
 *   3. The saved preference is uid-scoped — account B never inherits A's.
 *   4. Reset clears BOTH the URL params and the stored preference.
 *   5. Unknown / retired values narrow (match nothing) — never broaden.
 *
 * @jest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';

// reset() clears the address bar directly through the router (see the hook's
// comment on stale useSearchParams), so the test drives the same store the
// useUrlParams mock reads.
const mockRouterReplace = jest.fn((url: string) => {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const next = new URLSearchParams(query);
  const store = (jest.requireMock('@/hooks/useUrlState') as { __store: Map<string, string> }).__store;
  store.clear();
  for (const [k, v] of next.entries()) store.set(k, v);
});
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (url: string) => mockRouterReplace(url), push: jest.fn() }),
  usePathname: () => '/agents/runs',
}));

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Reactive URL-params mock mirroring the production `useUrlParams`
// contract: arrays are stored comma-joined, empty values delete the key.
jest.mock('@/hooks/useUrlState', () => {
  const ReactMod = require('react');
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    useUrlParams: () => {
      const [, setVersion] = ReactMod.useState(0);
      const params = new URLSearchParams();
      for (const [k, v] of store.entries()) params.set(k, v);
      const setParams = (next: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === undefined || v === '') store.delete(k);
          else if (Array.isArray(v)) {
            if (v.length === 0) store.delete(k);
            else store.set(k, v.join(','));
          } else store.set(k, String(v));
        }
        setVersion((n: number) => n + 1);
      };
      return { params, setParams, setParam: (k: string, v: unknown) => setParams({ [k]: v }), clearAll: () => {} };
    },
  };
});

const urlMocks = jest.requireMock('@/hooks/useUrlState') as { __store: Map<string, string> };

import { useRunsFilters, runsFilterPreferenceKey, type RunsFilterState } from '../useRunsFilters';
import type { AgentRunRow } from '@/components/activity/RunsTable';

function makeRow(overrides: Partial<AgentRunRow> & { id: string }): AgentRunRow {
  return {
    agent: 'scout',
    mission: 'Research quantum sensing',
    kind: 'mission',
    status: 'success',
    tokens: 100,
    durationMs: 1000,
    startedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function signIn(uid: string): void {
  mockUseAuth.mockReturnValue({ user: { uid }, loading: false });
}

function readStored(uid: string): RunsFilterState | null {
  const raw = window.localStorage.getItem(runsFilterPreferenceKey(uid));
  return raw ? (JSON.parse(raw) as RunsFilterState) : null;
}

describe('useRunsFilters (ARUN-026)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    urlMocks.__store.clear();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/agents/runs');
    signIn('user-a');
  });

  describe('matching semantics', () => {
    it('matches everything when no facet is selected', () => {
      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.matches(makeRow({ id: 'r1' }))).toBe(true);
      expect(result.current.activeCount).toBe(0);
    });

    it('ORs values within a facet', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['chat', 'build']));

      expect(result.current.matches(makeRow({ id: 'r1', kind: 'chat' }))).toBe(true);
      expect(result.current.matches(makeRow({ id: 'r2', kind: 'build' }))).toBe(true);
      expect(result.current.matches(makeRow({ id: 'r3', kind: 'mission' }))).toBe(false);
    });

    it('ANDs across facets', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['mission']));
      act(() => result.current.setFacet('agents', ['scout']));

      expect(result.current.matches(makeRow({ id: 'r1', kind: 'mission', agent: 'scout' }))).toBe(true);
      // Right kind, wrong agent — AND across facets must reject it.
      expect(result.current.matches(makeRow({ id: 'r2', kind: 'mission', agent: 'linker' }))).toBe(false);
      // Right agent, wrong kind.
      expect(result.current.matches(makeRow({ id: 'r3', kind: 'chat', agent: 'scout' }))).toBe(false);
    });

    it('filters on status as its own facet', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('statuses', ['failure', 'blocked']));

      expect(result.current.matches(makeRow({ id: 'r1', status: 'failure' }))).toBe(true);
      expect(result.current.matches(makeRow({ id: 'r2', status: 'blocked' }))).toBe(true);
      expect(result.current.matches(makeRow({ id: 'r3', status: 'success' }))).toBe(false);
    });

    it('unknown or retired values narrow the result — they never broaden it', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['telepathy']));

      expect(result.current.matches(makeRow({ id: 'r1', kind: 'mission' }))).toBe(false);
      expect(result.current.matches(makeRow({ id: 'r2', kind: 'chat' }))).toBe(false);
      // The unknown value is retained (so the chip is removable) but matches nothing.
      expect(result.current.filters.kinds).toEqual(['telepathy']);
      expect(result.current.activeCount).toBe(1);
    });

    it('a retired value alongside a live one keeps the live one working', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['telepathy', 'chat']));

      expect(result.current.matches(makeRow({ id: 'r1', kind: 'chat' }))).toBe(true);
      expect(result.current.matches(makeRow({ id: 'r2', kind: 'mission' }))).toBe(false);
    });
  });

  describe('URL state', () => {
    it('reads facets from the URL on mount', () => {
      urlMocks.__store.set('kind', 'chat,build');
      urlMocks.__store.set('agent', 'scout');
      urlMocks.__store.set('status', 'failure');

      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters).toEqual({
        agents: ['scout'],
        kinds: ['chat', 'build'],
        statuses: ['failure'],
      });
    });

    it('writes the selection back to the URL so the view is shareable', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['sweep', 'build']));
      expect(urlMocks.__store.get('kind')).toBe('sweep,build');
    });

    it('clears the URL param when a facet is emptied', () => {
      urlMocks.__store.set('kind', 'chat');
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', []));
      expect(urlMocks.__store.has('kind')).toBe(false);
    });

    it('tolerates blank and duplicate entries in a URL list', () => {
      urlMocks.__store.set('kind', 'chat,,chat, build ');
      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters.kinds).toEqual(['chat', 'build']);
    });
  });

  describe('saved preference precedence', () => {
    it('falls back to the uid-scoped saved preference when the URL has no facet params', () => {
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-a'),
        JSON.stringify({ agents: [], kinds: ['sweep'], statuses: [] })
      );

      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters.kinds).toEqual(['sweep']);
      expect(result.current.source).toBe('preference');
    });

    it('URL state overrides the saved preference entirely — no merging', () => {
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-a'),
        JSON.stringify({ agents: ['linker'], kinds: ['sweep'], statuses: ['failure'] })
      );
      urlMocks.__store.set('kind', 'chat');

      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters).toEqual({ agents: [], kinds: ['chat'], statuses: [] });
      expect(result.current.source).toBe('url');
    });

    it('persists a new selection to the uid-scoped preference', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('agents', ['scout', 'linker']));
      expect(readStored('user-a')).toEqual({ agents: ['scout', 'linker'], kinds: [], statuses: [] });
    });

    it('account B never inherits account A saved filters', () => {
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-a'),
        JSON.stringify({ agents: ['scout'], kinds: ['sweep'], statuses: [] })
      );

      signIn('user-b');
      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters).toEqual({ agents: [], kinds: [], statuses: [] });
    });

    it('an account switch re-reads the new account preference without leaking the old one', () => {
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-a'),
        JSON.stringify({ agents: ['scout'], kinds: [], statuses: [] })
      );
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-b'),
        JSON.stringify({ agents: ['linker'], kinds: [], statuses: [] })
      );

      const { result, rerender } = renderHook(() => useRunsFilters());
      expect(result.current.filters.agents).toEqual(['scout']);

      signIn('user-b');
      rerender();
      expect(result.current.filters.agents).toEqual(['linker']);
    });

    it('survives a corrupt stored preference without throwing', () => {
      window.localStorage.setItem(runsFilterPreferenceKey('user-a'), '{not json');
      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters).toEqual({ agents: [], kinds: [], statuses: [] });
    });

    it('ignores a stored preference whose shape is wrong', () => {
      window.localStorage.setItem(runsFilterPreferenceKey('user-a'), JSON.stringify({ kinds: 'chat' }));
      const { result } = renderHook(() => useRunsFilters());
      expect(result.current.filters).toEqual({ agents: [], kinds: [], statuses: [] });
    });
  });

  describe('reset', () => {
    it('clears both the URL params and the stored preference', () => {
      urlMocks.__store.set('kind', 'chat');
      urlMocks.__store.set('agent', 'scout');
      urlMocks.__store.set('status', 'failure');
      window.localStorage.setItem(
        runsFilterPreferenceKey('user-a'),
        JSON.stringify({ agents: ['scout'], kinds: ['chat'], statuses: ['failure'] })
      );

      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.reset());

      expect(result.current.filters).toEqual({ agents: [], kinds: [], statuses: [] });
      expect(urlMocks.__store.has('kind')).toBe(false);
      expect(urlMocks.__store.has('agent')).toBe(false);
      expect(urlMocks.__store.has('status')).toBe(false);
      expect(readStored('user-a')).toBeNull();
    });

    it('leaves unrelated URL params untouched on reset', () => {
      urlMocks.__store.set('kind', 'chat');
      urlMocks.__store.set('build', 'mission-9');
      window.history.replaceState({}, '', '/agents/runs?kind=chat&build=mission-9');
      const replaceState = jest.spyOn(window.history, 'replaceState');

      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.reset());

      expect(urlMocks.__store.has('kind')).toBe(false);
      expect(urlMocks.__store.get('build')).toBe('mission-9');
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/agents/runs?build=mission-9');
      replaceState.mockRestore();
    });

    it('does not resurrect an unrelated param from a stale React snapshot', () => {
      urlMocks.__store.set('kind', 'chat');
      urlMocks.__store.set('build', 'stale-mission');
      window.history.replaceState({}, '', '/agents/runs?kind=chat');

      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.reset());

      expect(urlMocks.__store.has('kind')).toBe(false);
      expect(urlMocks.__store.has('build')).toBe(false);
    });
  });

  describe('toggle + remove helpers', () => {
    it('toggle adds then removes a value', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.toggleValue('kinds', 'chat'));
      expect(result.current.filters.kinds).toEqual(['chat']);
      act(() => result.current.toggleValue('kinds', 'chat'));
      expect(result.current.filters.kinds).toEqual([]);
    });

    it('activeCount sums selections across every facet', () => {
      const { result } = renderHook(() => useRunsFilters());
      act(() => result.current.setFacet('kinds', ['chat', 'build']));
      act(() => result.current.setFacet('statuses', ['failure']));
      expect(result.current.activeCount).toBe(3);
    });
  });
});

describe('useRunsFilters — Reset is immediate (ARUN-026)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    urlMocks.__store.clear();
    window.localStorage.clear();
    signIn('user-a');
  });

  it('clears the selection right away, without waiting for the URL to update', () => {
    urlMocks.__store.set('kind', 'mission');
    const { result } = renderHook(() => useRunsFilters());
    expect(result.current.filters.kinds).toEqual(['mission']);

    // Simulate the production router: `replace` lands asynchronously, so the
    // params the hook reads are momentarily stale after reset().
    const frozenStore = new Map(urlMocks.__store);
    act(() => {
      result.current.reset();
      urlMocks.__store.clear();
      for (const [k, v] of frozenStore) urlMocks.__store.set(k, v);
    });

    // Reset must win over the not-yet-updated URL.
    expect(result.current.filters).toEqual({ agents: [], kinds: [], statuses: [] });
    expect(result.current.activeCount).toBe(0);
  });

  it('a new selection made after a reset is honored, not swallowed by it', () => {
    const { result } = renderHook(() => useRunsFilters());
    act(() => result.current.reset());
    act(() => result.current.setFacet('kinds', ['sweep']));
    expect(result.current.filters.kinds).toEqual(['sweep']);
  });
});

describe('useRunsFilters — a deep link does not become a saved filter (ARUN-026)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    urlMocks.__store.clear();
    window.localStorage.clear();
    signIn('user-a');
  });

  it('applies a non-persisting facet to the view without saving it', () => {
    const { result } = renderHook(() => useRunsFilters());
    act(() => result.current.setFacet('kinds', ['build'], { persist: false }));

    expect(result.current.filters.kinds).toEqual(['build']);
    // The operator never chose this — a later visit must not inherit it.
    expect(readStored('user-a')).toBeNull();
  });

  it('an explicit selection is still saved', () => {
    const { result } = renderHook(() => useRunsFilters());
    act(() => result.current.setFacet('kinds', ['build']));
    expect(readStored('user-a')).toEqual({ agents: [], kinds: ['build'], statuses: [] });
  });
});
