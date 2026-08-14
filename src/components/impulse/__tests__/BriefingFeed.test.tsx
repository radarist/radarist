/**
 * @file BriefingFeed.test.tsx
 * @description Tests the feed-container behaviour after the Chunk 4
 * refactor:
 *
 *   1. `applyBriefingFilters` is the pure filter function — exhaustive
 *      cases on it without needing to mount the feed.
 *   2. The feed renders `InsightTable` by default and `InsightCard`s
 *      when viewMode is `card`.
 *   3. The "no insights at all" empty state vs the
 *      "filters exclude everything" empty state behave correctly.
 *
 * Component-level interaction (click-through, like, dismiss) is covered
 * by InsightTableRow.test.tsx and InsightCard.test.tsx — we stub both
 * out here so the focus stays on filter + view-mode plumbing.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockUseBriefing = jest.fn();
jest.mock('@/hooks/useBriefing', () => {
  // Defined inside the factory (not out-of-scope) so the component's
  // `instanceof BriefingRequestError` check in the unavailable-state branch
  // matches the class these tests construct via jest.requireMock.
  class BriefingRequestError extends Error {
    constructor(
      public status: number,
      public kind: string,
      message: string
    ) {
      super(message);
      this.name = 'BriefingRequestError';
    }
  }
  return {
    __esModule: true,
    useBriefing: () => mockUseBriefing(),
    briefingKeys: { all: ['briefing'], insights: () => ['briefing', 'insights'] },
    BriefingRequestError,
    classifyBriefingStatus: (status: number) =>
      status === 429 ? 'rate-limited' : status === 401 ? 'unauthorized' : status >= 500 ? 'unavailable' : 'error',
  };
});
const { BriefingRequestError: MockBriefingRequestError } = jest.requireMock('@/hooks/useBriefing') as {
  BriefingRequestError: new (status: number, kind: string, message: string) => Error;
};

// Stub the table + card + bulk bar so we just verify the right body
// renders. Each component is covered by its own test file.
jest.mock('../InsightTable', () => ({
  __esModule: true,
  InsightTable: ({ insights }: { insights: Array<{ id: string }> }) => (
    <div data-testid="stub-insight-table">{insights.length} rows</div>
  ),
}));
jest.mock('../InsightCard', () => ({
  __esModule: true,
  InsightCard: ({ insight }: { insight: { id: string; title: string } }) => (
    <div data-testid={`stub-card-${insight.id}`}>{insight.title}</div>
  ),
}));
jest.mock('../BulkActionBar', () => ({
  __esModule: true,
  BulkActionBar: ({ selectedInsights }: { selectedInsights: Array<{ id: string }> }) =>
    selectedInsights.length > 0 ? <div data-testid="stub-bulk-bar">{selectedInsights.length} selected</div> : null,
}));
// UX-051: the five truthful pipeline states (no-exploration / paused /
// pending / quiet / outage) are covered by BriefingEmptyState.test.tsx.
// Here we only verify the feed hands off to it when the list is empty.
jest.mock('../BriefingEmptyState', () => ({
  __esModule: true,
  BriefingEmptyState: () => <div data-testid="stub-empty-state" />,
}));

// Reactive URL state mock — needed by the toolbar (and the table)
// nested in the feed. Mirrors the production `useUrlParams` contract:
// one shared `Map<string,string>` written/read against a single
// `URLSearchParams` snapshot. Arrays are stored comma-joined, matching
// `setParams({ type: ['a','b'] })` → `?type=a,b`.
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
      const setParam = (key: string, value: unknown) => setParams({ [key]: value });
      const clearAll = () => {
        store.clear();
        setVersion((n: number) => n + 1);
      };
      return { params, setParams, setParam, clearAll };
    },
    useUrlState: () => ({ value: undefined, setValue: () => {}, clear: () => {} }),
    useUrlArrayState: () => ({
      values: [],
      setValues: () => {},
      add: () => {},
      remove: () => {},
      toggle: () => {},
      has: () => false,
      clear: () => {},
    }),
  };
});
const urlMocks = jest.requireMock('@/hooks/useUrlState') as {
  __store: Map<string, string>;
};

// View-mode selector mock — return a getter-style function-mock so each
// test can override `viewMode` via `mockViewMode`.
let mockViewMode: 'table' | 'card' = 'table';
jest.mock('@/stores/briefing-ui-store', () => ({
  __esModule: true,
  useBriefingUIStore: (selector: (s: { viewMode: 'table' | 'card' }) => unknown) =>
    selector({ viewMode: mockViewMode }),
}));

// Dismiss + companions are wired into the feed but their behaviour is
// covered by their own test files; we just need passive stubs here so
// the feed renders without throwing.
jest.mock('@/hooks/queries/useDismissInsight', () => ({
  __esModule: true,
  useDismissInsight: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/hooks/queries/useUndismissInsight', () => ({
  __esModule: true,
  useUndismissInsight: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/hooks/queries/useLikeInsight', () => ({
  __esModule: true,
  useLikeInsight: () => ({ mutate: jest.fn() }),
}));

// Keyboard shortcut hook: bypass entirely — its own test file pins the
// binding contract. Here we just need a stable, no-op return value.
jest.mock('@/hooks/useBriefingKeyboardShortcuts', () => ({
  __esModule: true,
  useBriefingKeyboardShortcuts: () => ({ focusedId: null, setFocusedId: () => {} }),
}));

// `next/navigation`: the feed calls `useRouter` for the keyboard
// `Enter`-to-open handler. Stub it so the test environment has a router.
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/triage/insights',
  useSearchParams: () => new URLSearchParams(),
}));

// `sonner` is reached via the keyboard-dismiss callback. Inert stubs.
jest.mock('sonner', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

import { BriefingFeed, applyBriefingFilters } from '../BriefingFeed';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(over: Partial<BriefingInsight> & { id: string }): BriefingInsight {
  return {
    type: 'discovery',
    title: over.id.toUpperCase(),
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.7,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    ...over,
  };
}

const THREE: BriefingInsight[] = [
  makeInsight({ id: 'a', type: 'discovery', agentName: 'scout', confidenceScore: 0.4, liked: false }),
  makeInsight({ id: 'b', type: 'connection', agentName: 'linker', confidenceScore: 0.85, liked: true }),
  makeInsight({ id: 'c', type: 'pattern', agentName: 'scout', confidenceScore: 0.6, liked: false }),
];

describe('applyBriefingFilters', () => {
  it('filters by type (multi-select OR)', () => {
    expect(
      applyBriefingFilters(THREE, { types: ['connection'], agents: [], minConfidence: 0, likedOnly: false }).map(
        (i) => i.id
      )
    ).toEqual(['b']);
    expect(
      applyBriefingFilters(THREE, {
        types: ['connection', 'pattern'],
        agents: [],
        minConfidence: 0,
        likedOnly: false,
      }).map((i) => i.id)
    ).toEqual(['b', 'c']);
  });

  it('filters by agent (multi-select OR)', () => {
    expect(
      applyBriefingFilters(THREE, { types: [], agents: ['linker'], minConfidence: 0, likedOnly: false }).map(
        (i) => i.id
      )
    ).toEqual(['b']);
  });

  it('filters by minConfidence (inclusive)', () => {
    expect(
      applyBriefingFilters(THREE, { types: [], agents: [], minConfidence: 0.6, likedOnly: false }).map((i) => i.id)
    ).toEqual(['b', 'c']);
  });

  it('filters by likedOnly', () => {
    expect(
      applyBriefingFilters(THREE, { types: [], agents: [], minConfidence: 0, likedOnly: true }).map((i) => i.id)
    ).toEqual(['b']);
  });

  it('combines filters (AND across categories)', () => {
    expect(
      applyBriefingFilters(THREE, {
        types: ['discovery', 'pattern'],
        agents: ['scout'],
        minConfidence: 0.5,
        likedOnly: false,
      }).map((i) => i.id)
    ).toEqual(['c']);
  });

  it('returns the original list when no filters are set', () => {
    expect(applyBriefingFilters(THREE, { types: [], agents: [], minConfidence: 0, likedOnly: false })).toHaveLength(3);
  });

  it('filters by search — title match, case-insensitive', () => {
    const insights = [
      makeInsight({ id: 'x', title: 'Quantum leap detected' }),
      makeInsight({ id: 'y', title: 'Steady state pattern' }),
    ];
    expect(
      applyBriefingFilters(insights, {
        types: [],
        agents: [],
        minConfidence: 0,
        likedOnly: false,
        search: 'QUANTUM',
      }).map((i) => i.id)
    ).toEqual(['x']);
  });

  it('filters by search — summary match when the title does not match', () => {
    const insights = [
      makeInsight({ id: 'x', title: 'Alpha', summary: 'Mentions the widget factory' }),
      makeInsight({ id: 'y', title: 'Beta', summary: 'Unrelated summary' }),
    ];
    expect(
      applyBriefingFilters(insights, {
        types: [],
        agents: [],
        minConfidence: 0,
        likedOnly: false,
        search: 'widget',
      }).map((i) => i.id)
    ).toEqual(['x']);
  });

  it('treats a missing or blank search as a no-op (back-compat with pre-search callers)', () => {
    expect(applyBriefingFilters(THREE, { types: [], agents: [], minConfidence: 0, likedOnly: false })).toHaveLength(3);
    expect(
      applyBriefingFilters(THREE, { types: [], agents: [], minConfidence: 0, likedOnly: false, search: '   ' })
    ).toHaveLength(3);
  });
});

describe('BriefingFeed', () => {
  beforeEach(() => {
    mockUseBriefing.mockReset();
    urlMocks.__store.clear();
    mockViewMode = 'table';
  });

  it('renders the loading skeleton while the briefing query is pending', () => {
    mockUseBriefing.mockReturnValue({ data: undefined, isPending: true });
    render(<BriefingFeed />);
    // Skeleton has no testid we can rely on; assert the feed-empty + table
    // are both absent (the skeleton is rendered).
    expect(screen.queryByTestId('briefing-empty')).toBeNull();
    expect(screen.queryByTestId('stub-insight-table')).toBeNull();
  });

  it('hands off to the truthful pipeline-state empty view when no insights returned (UX-051)', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: [], tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('briefing-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stub-empty-state')).toBeInTheDocument();
  });

  it('renders the UNAVAILABLE state (not the empty inbox) on a graph outage — UX-018', () => {
    const refetch = jest.fn();
    mockUseBriefing.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new MockBriefingRequestError(503, 'unavailable', 'Graph backend unavailable'),
      refetch,
    });
    render(<BriefingFeed />);

    // Distinct testid + copy — must NOT be the "No new insights" empty inbox.
    expect(screen.getByTestId('briefing-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('briefing-empty')).toBeNull();
    expect(screen.getByText('Insights are temporarily unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No new insights')).toBeNull();

    // Retry re-runs the query.
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('uses rate-limit copy when the failure kind is rate-limited', () => {
    mockUseBriefing.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new MockBriefingRequestError(429, 'rate-limited', 'Too many requests'),
      refetch: jest.fn(),
    });
    render(<BriefingFeed />);
    expect(screen.getByText('Too many requests')).toBeInTheDocument();
  });

  it('renders InsightTable as the default body when insights are present', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('stub-insight-table')).toHaveTextContent('3 rows');
    expect(screen.queryByTestId('briefing-card-list')).toBeNull();
  });

  it('renders the card list when viewMode is `card`', () => {
    mockViewMode = 'card';
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('briefing-card-list')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-insight-table')).toBeNull();
  });

  it('renders the toolbar above the body when insights exist', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('briefing-toolbar')).toBeInTheDocument();
  });

  it('renders the search input with the "Search insights..." placeholder', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('briefing-filter-search')).toHaveAttribute('placeholder', 'Search insights...');
  });

  it('typing into the search box narrows the rendered rows (client-side title/summary filter)', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('stub-insight-table')).toHaveTextContent('3 rows');

    // THREE's titles default to the id upper-cased ('A' / 'B' / 'C') — only
    // insight "b" (title "B") contains "B".
    fireEvent.change(screen.getByTestId('briefing-filter-search'), { target: { value: 'B' } });
    expect(screen.getByTestId('stub-insight-table')).toHaveTextContent('1 rows');
  });

  it('renders the "no insights match filters" empty state when filters exclude everything', () => {
    urlMocks.__store.set('type', 'scoring_change'); // none of THREE match
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('briefing-empty-filtered')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-insight-table')).toBeNull();
  });

  it('passes the FILTERED list (not the full list) into InsightTable', () => {
    urlMocks.__store.set('agent', 'linker');
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    expect(screen.getByTestId('stub-insight-table')).toHaveTextContent('1 rows');
  });

  it('does not render the token usage bar (removed in the 2026-05-13 design align)', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: THREE, tokenUsage: { used: 1500, budget: 100_000 } },
      isPending: false,
    });
    render(<BriefingFeed />);
    // The bar was replaced by the table's pagination footer (per the
    // visual alignment with signals). Pin the absence so a re-introduction
    // shows up as a regression rather than a silent stylistic drift.
    expect(screen.queryByTestId('token-usage-bar')).toBeNull();
    expect(screen.queryByTestId('token-usage-text')).toBeNull();
  });

  describe('UX-046 — outage with cached data keeps last-good rows', () => {
    it('renders the cached list plus a stale-data note instead of the outage panel', () => {
      mockUseBriefing.mockReturnValue({
        data: {
          insights: [makeInsight({ id: 'pi-kept', title: 'Kept row' })],
          tokenUsage: { used: 0, budget: 100_000 },
        },
        isPending: false,
        isError: true,
        error: new MockBriefingRequestError(503, 'unavailable', 'Service Unavailable'),
        refetch: jest.fn(),
      });
      render(<BriefingFeed />);

      // Last-good data stays on screen — an outage must never look like an
      // empty inbox or replace rows the user already had.
      expect(screen.getByTestId('briefing-feed')).toBeInTheDocument();
      expect(screen.getByTestId('stub-insight-table')).toHaveTextContent('1 rows');
      expect(screen.getByTestId('stale-data-note')).toBeInTheDocument();
      expect(screen.queryByTestId('briefing-unavailable')).toBeNull();
      expect(screen.queryByTestId('briefing-empty')).toBeNull();
    });

    it('still shows the outage panel when there is no cached data at all', () => {
      mockUseBriefing.mockReturnValue({
        data: undefined,
        isPending: false,
        isError: true,
        error: new MockBriefingRequestError(503, 'unavailable', 'Service Unavailable'),
        refetch: jest.fn(),
      });
      render(<BriefingFeed />);
      expect(screen.getByTestId('briefing-unavailable')).toBeInTheDocument();
      expect(screen.queryByTestId('stale-data-note')).toBeNull();
    });
  });
});
