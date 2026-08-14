/**
 * @file RunsTable.test.tsx
 * @description Task 21 (P-F1 part 1) — Agent Runs is a standard table.
 * Pins the `RunsTable` interface contract: one row per run (agent pill,
 * truncated mission text, tinted status pill, quality "x/y · z%" + L1 pill,
 * tokens, duration, absolute date), `onRowClick` firing with the run id,
 * and the search filter + CONV-PAGINATION footer.
 *
 * Updated Task 24 (P-F8 parity pass): the card header now carries the
 * relocated "Agent Runs" title + subtitle (CONV-HEADER, matching Signals),
 * the standalone kind + quality facet `Select`s are gone — the kind facet
 * survives only as hidden state (settable via `initialKindFacet`, the
 * `?tab=builds` deep link's wire) surfaced as a dismissible "Kind: …" chip —
 * and every column is sortable via the shared `SortableHeader`, reordered
 * Run-first.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// RunsTable's empty state deep-links to Settings → Agent Config; jsdom has no
// app router, so stub it (matches src/app/agents/runs/__tests__/page.test.tsx).
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/agents/runs',
  useSearchParams: () => new URLSearchParams(),
}));

// ARUN-026: the facet state hook is unit-tested in useRunsFilters.test.tsx.
// Here it runs for real against an in-memory store so the table's own
// wiring (chips, reset, AND/OR composition) is what's under test, without
// depending on a live router or localStorage.
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-runs-table' }, loading: false }),
}));

// lucide-react is ESM; stub icons as inert spans so class assertions on the
// Badge wrapper still work without pulling the real icon package through Jest's
// CJS transform.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => <span data-testid={`icon-${name}`} {...props} />;
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_t, prop: string) => makeIcon(prop) });
});

import { RunsTable, type AgentRunRow } from '../RunsTable';

// ============================================================================
// jsdom POLYFILLS (Radix Select) — DataPagination's "Rows per page" control
// still renders a Radix Select even though the kind/quality facet selects are
// gone. Same recipe as PrototypeSheet.business-units.test.tsx / infographics
// table-conventions test.
// ============================================================================

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// ARUN-026 persists the facet selection to localStorage per account, so a
// selection made in one test would otherwise be restored in the next.
beforeEach(() => {
  window.localStorage.clear();
});

// ============================================================================
// FIXTURES
// ============================================================================

const LONG_MISSION =
  'Evaluate the technology-radar placement for a distributed vector database used across three independent scouting pipelines';

const RUNS: AgentRunRow[] = [
  {
    id: 'run-mission-1',
    agent: 'scout',
    mission: LONG_MISSION,
    kind: 'mission',
    status: 'success',
    quality: { passed: 5, total: 7, score: 71, l1: 'PASS' },
    tokens: 12400,
    durationMs: 4500,
    startedAt: '2026-05-08T08:00:00.000Z',
  },
  {
    id: 'run-sweep-1',
    agent: 'evaluator',
    mission: 'Scored 5 inbound signals',
    kind: 'sweep',
    status: 'failure',
    tokens: 900,
    durationMs: 1200,
    startedAt: '2026-05-07T07:30:00.000Z',
  },
  {
    id: 'run-build-1',
    agent: 'builder',
    mission: 'Prototype: internal knowledge search',
    kind: 'build',
    status: 'live',
    tokens: 3000,
    durationMs: 30_000,
    startedAt: '2026-05-09T09:00:00.000Z',
  },
];

const CHAT_RUN: AgentRunRow = {
  id: 'run-chat-1',
  agent: 'chat',
  provider: 'claude',
  model: 'claude-opus-4-8',
  mission: 'Research quantum computing',
  kind: 'chat',
  status: 'success',
  tokens: 200_000,
  durationMs: 36_000,
  startedAt: '2026-05-10T09:00:00.000Z',
};

// Kind+search AND fixture (P-F8): exactly one row satisfies the hidden kind
// facet (set via `initialKindFacet`, never a UI select) AND the search term —
// the other two each fail exactly one of the two predicates, pinning that the
// hidden facet and the search box are ANDed together rather than each
// independently widening the result set. (The former three-way kind/quality/
// search combination no longer applies — the quality facet was removed
// entirely, not just hidden.)
const KIND_SEARCH_RUNS: AgentRunRow[] = [
  {
    id: 'combo-match',
    agent: 'scout',
    mission: 'Evaluate vector database options',
    kind: 'mission',
    status: 'success',
    tokens: 100,
    durationMs: 1000,
    startedAt: '2026-05-08T08:00:00.000Z',
  },
  {
    id: 'combo-wrong-kind',
    agent: 'scout',
    mission: 'Evaluate vector database options',
    kind: 'build',
    status: 'success',
    tokens: 100,
    durationMs: 1000,
    startedAt: '2026-05-08T08:00:00.000Z',
  },
  {
    id: 'combo-wrong-search',
    agent: 'scout',
    mission: 'Scored 5 inbound signals',
    kind: 'mission',
    status: 'success',
    tokens: 100,
    durationMs: 1000,
    startedAt: '2026-05-08T08:00:00.000Z',
  },
];

// Pagination-reset fixture: 12 rows (> the pageSize=10 default) so page 1
// and page 2 are both non-empty.
const PAGINATION_RUNS: AgentRunRow[] = Array.from({ length: 12 }, (_, i) => ({
  id: `page-run-${i + 1}`,
  agent: 'scout',
  mission: `Mission number ${i + 1}`,
  kind: 'mission' as const,
  status: 'success' as const,
  tokens: 100,
  durationMs: 1000,
  startedAt: '2026-05-08T08:00:00.000Z',
}));

// Sorting fixture: every field distinguishable in a different order so a
// click on any single column header produces a row order that couldn't be
// explained by coincidence with another field. `sort-c` intentionally omits
// `quality` to pin the "missing quality sorts lowest" rule.
const SORT_RUNS: AgentRunRow[] = [
  {
    id: 'sort-a',
    agent: 'zeta',
    mission: 'Alpha mission text',
    kind: 'mission',
    status: 'success',
    quality: { passed: 1, total: 2, score: 30, l1: 'REVISE' },
    tokens: 500,
    durationMs: 60_000,
    startedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'sort-b',
    agent: 'alpha',
    mission: 'Zulu mission text',
    kind: 'build',
    status: 'failure',
    quality: { passed: 4, total: 5, score: 80, l1: 'PASS' },
    tokens: 100,
    durationMs: 5_000,
    startedAt: '2026-05-03T00:00:00.000Z',
  },
  {
    id: 'sort-c',
    agent: 'mid',
    mission: 'Mid mission text',
    kind: 'sweep',
    status: 'live',
    tokens: 900,
    durationMs: 30_000,
    startedAt: '2026-05-02T00:00:00.000Z',
  },
];

function renderTable(props: Partial<React.ComponentProps<typeof RunsTable>> = {}) {
  const onRowClick = props.onRowClick ?? jest.fn();
  return {
    ...render(
      <RunsTable
        runs={props.runs ?? RUNS}
        onRowClick={onRowClick}
        clickable={props.clickable}
        initialKindFacet={props.initialKindFacet}
        highlightRunId={props.highlightRunId}
      />
    ),
    onRowClick,
  };
}

function rowOrder(): string[] {
  return screen.getAllByTestId(/^run-row-/).map((el) => el.getAttribute('data-testid') ?? '');
}

// ============================================================================
// TESTS
// ============================================================================

describe('RunsTable', () => {
  it('renders one row per run', () => {
    renderTable();
    expect(screen.getByTestId('run-row-run-mission-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-sweep-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-build-1')).toBeInTheDocument();
  });

  it('shows an agent pill per row', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    expect(within(row).getByText('scout')).toBeInTheDocument();
  });

  it('truncates long mission text with CSS truncate (no manual mid-word cut)', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    const missionEl = within(row).getByTestId('run-mission-run-mission-1');
    // CSS truncate (overflow-hidden + text-ellipsis + whitespace-nowrap) does
    // the clipping visually — the DOM text itself must stay the full string,
    // proving there's no `.slice(0, N)` cutting the word in half server-side.
    expect(missionEl).toHaveClass('truncate');
    expect(missionEl.textContent).toBe(LONG_MISSION);
  });

  it('orders row cells with Run first and Agent second (P-F8 column order)', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent(LONG_MISSION);
    expect(within(cells[1]).getByText('scout')).toBeInTheDocument();
  });

  it('renders a tinted status pill per CONV-BADGE for each state', () => {
    renderTable();
    expect(within(screen.getByTestId('run-row-run-mission-1')).getByText('Success')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-row-run-sweep-1')).getByText('Failed')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-row-run-build-1')).getByText('Live')).toBeInTheDocument();
  });

  it('renders quality as "passed/total · score%" plus an L1 verdict pill', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    expect(within(row).getByText('5/7 · 71%')).toBeInTheDocument();
    expect(within(row).getByText(/PASS/)).toBeInTheDocument();
  });

  it('shows an empty-cell marker for runs without a quality report', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-sweep-1');
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('—');
  });

  it('formats tokens with a K suffix', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    expect(within(row).getByText('12.4K')).toBeInTheDocument();
  });

  it('formats duration as a human string', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    expect(within(row).getByText('4.5s')).toBeInTheDocument();
  });

  it('labels estimated, settled, mixed, and unavailable costs in table rows', () => {
    renderTable({
      runs: [
        { ...RUNS[0], id: 'cost-estimated', costUsd: 0.125, costState: 'estimated' },
        { ...RUNS[0], id: 'cost-settled', costUsd: 0.25, costState: 'settled' },
        { ...RUNS[0], id: 'cost-mixed', costUsd: 0.375, costState: 'mixed' },
        { ...RUNS[0], id: 'cost-reserved', costUsd: 1.5, costState: 'reserved' },
        {
          ...RUNS[0],
          id: 'cost-maximum',
          costUsd: 2.5,
          costState: 'maximum-exposure',
        },
        { ...RUNS[0], id: 'cost-unavailable', costUnavailable: true },
      ],
    });

    expect(screen.getByTestId('run-cost-cost-estimated')).toHaveTextContent('$0.13 est.');
    expect(screen.getByTestId('run-cost-cost-settled')).toHaveTextContent('$0.25 settled');
    expect(screen.getByTestId('run-cost-cost-mixed')).toHaveTextContent(
      '$0.38 settled + est.'
    );
    expect(screen.getByTestId('run-cost-cost-reserved')).toHaveTextContent('$1.50 reserved');
    expect(screen.getByTestId('run-cost-cost-maximum')).toHaveTextContent(
      '$2.50 maximum exposure'
    );
    expect(screen.getByTestId('run-cost-cost-unavailable')).toHaveTextContent('Unavailable');
  });

  it('carries a rounded 60-second remainder into the next minute', () => {
    const nearBoundaryRun: AgentRunRow = {
      ...RUNS[0],
      id: 'run-near-minute-boundary',
      durationMs: 599_900,
    };

    renderTable({ runs: [nearBoundaryRun] });

    expect(within(screen.getByTestId('run-row-run-near-minute-boundary')).getByText('10m 0s')).toBeInTheDocument();
    expect(screen.queryByText('9m 60s')).not.toBeInTheDocument();
  });

  it('renders a persisted 412000ms history duration as 6m 52s', () => {
    const persistedRun: AgentRunRow = {
      id: 'run-demo-q2-briefing',
      agent: 'creator',
      mission: 'Q2 technology briefing',
      kind: 'mission',
      status: 'success',
      tokens: 25_000,
      durationMs: 412_000,
      startedAt: '2026-07-12T10:06:52.000Z',
    };
    const firstMount = renderTable({ runs: [persistedRun] });

    expect(within(screen.getByTestId('run-row-run-demo-q2-briefing')).getByText('6m 52s')).toBeInTheDocument();

    firstMount.unmount();
    const reloadedPayload = JSON.parse(JSON.stringify([persistedRun])) as AgentRunRow[];
    renderTable({ runs: reloadedPayload });
    expect(within(screen.getByTestId('run-row-run-demo-q2-briefing')).getByText('6m 52s')).toBeInTheDocument();
  });

  it('renders an absolute date, not a relative one', () => {
    renderTable();
    const row = screen.getByTestId('run-row-run-mission-1');
    expect(within(row).getByText('May 8, 2026')).toBeInTheDocument();
    expect(within(row).queryByText(/ago/)).not.toBeInTheDocument();
  });

  it('fires onRowClick with the run id when a row is clicked', async () => {
    const user = userEvent.setup();
    const onRowClick = jest.fn();
    renderTable({ onRowClick });

    await user.click(screen.getByTestId('run-row-run-mission-1'));

    expect(onRowClick).toHaveBeenCalledWith('run-mission-1');
  });

  it('does not fire onRowClick and renders cursor-default when clickable=false', async () => {
    const user = userEvent.setup();
    const onRowClick = jest.fn();
    renderTable({ onRowClick, clickable: false });

    const row = screen.getByTestId('run-row-run-mission-1');
    expect(row).toHaveClass('cursor-default');
    await user.click(row);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('filters rows via the mission-text search box', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.type(screen.getByTestId('runs-search-input'), 'inbound signals');

    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-sweep-1')).toBeInTheDocument();
  });

  it('renders the CONV-PAGINATION footer with rows-per-page and a range summary', () => {
    renderTable();
    expect(screen.getByText('Rows per page')).toBeInTheDocument();
    expect(screen.getByText(/1–3 of 3 runs/)).toBeInTheDocument();
  });

  it('renders an empty state when no runs match the current filters', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.type(screen.getByTestId('runs-search-input'), 'no-such-mission-text-anywhere');

    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-sweep-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-build-1')).not.toBeInTheDocument();
    expect(screen.getByText(/no matching runs/i)).toBeInTheDocument();
  });

  it('renders an empty state when there are no runs at all', () => {
    renderTable({ runs: [] });
    expect(screen.getByText(/no agent runs yet/i)).toBeInTheDocument();
  });
});

// ============================================================================
// CARD HEADER (Task 24 / P-F8, CONV-HEADER) — the floating page-level title
// block moved into the table card's own header row: title + muted subtitle
// left, search right, one row — matching Signals' in-card header exactly.
// The standalone kind + quality facet `Select`s are gone.
// ============================================================================

describe('RunsTable card header (CONV-HEADER)', () => {
  it('renders the "Agent Runs" title and subtitle inside the card header', () => {
    renderTable();
    expect(screen.getByRole('heading', { level: 1, name: 'Agent Runs' })).toBeInTheDocument();
    expect(screen.getByText('View chat, mission, sweep, and build execution history')).toBeInTheDocument();
  });

  it('no longer renders the kind or quality facet selects', () => {
    renderTable();
    expect(screen.queryByTestId('runs-kind-facet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runs-quality-facet')).not.toBeInTheDocument();
    expect(screen.queryByText('All Runs')).not.toBeInTheDocument();
  });
});

// ============================================================================
// HIDDEN KIND FACET + DISMISSIBLE CHIP (Task 24 / P-F8) — the kind facet
// dropped its permanent UI control but survives as internal state so the
// `?tab=builds` deep link (via `initialKindFacet`) still narrows the table;
// when active it surfaces as a small dismissible "Kind: Builds ×" chip.
// ============================================================================

describe('RunsTable hidden kind facet + chip', () => {
  it('filters rows via initialKindFacet with no UI select to click', () => {
    renderTable({ initialKindFacet: 'build' });

    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-sweep-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-build-1')).toBeInTheDocument();
  });

  it('filters chat rows and labels the facet as Chats', () => {
    renderTable({ runs: [...RUNS, CHAT_RUN], initialKindFacet: 'chat' });

    expect(screen.getByTestId('runs-filter-chip-kinds-chat')).toHaveTextContent('Kind: Chats');
    expect(screen.getByTestId('run-row-run-chat-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
  });

  it('renders no chip when initialKindFacet is unset (default all)', () => {
    renderTable();
    expect(screen.queryByTestId(/^runs-filter-chip-/)).not.toBeInTheDocument();
  });

  it('shows a dismissible "Kind: Builds" chip when initialKindFacet is set, narrowing the rows', () => {
    renderTable({ initialKindFacet: 'build' });

    expect(screen.getByTestId('runs-filter-chip-kinds-build')).toHaveTextContent('Kind: Builds');
    expect(screen.getByTestId('run-row-run-build-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
  });

  it('dismissing the chip clears the facet and shows all rows again', async () => {
    const user = userEvent.setup();
    renderTable({ initialKindFacet: 'build' });

    await user.click(screen.getByTestId('runs-filter-chip-kinds-build'));

    expect(screen.queryByTestId('runs-filter-chip-kinds-build')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-mission-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-sweep-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-build-1')).toBeInTheDocument();
  });

  it('ANDs the hidden kind facet (via initialKindFacet) with the search box', async () => {
    const user = userEvent.setup();
    renderTable({ runs: KIND_SEARCH_RUNS, initialKindFacet: 'mission' });

    await user.type(screen.getByTestId('runs-search-input'), 'vector database');

    expect(screen.getByTestId('run-row-combo-match')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-combo-wrong-kind')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-combo-wrong-search')).not.toBeInTheDocument();
  });

  it('clears both search and the hidden kind facet via the empty-state "Clear filters" action', async () => {
    const user = userEvent.setup();
    renderTable({ runs: RUNS, initialKindFacet: 'build' });

    await user.type(screen.getByTestId('runs-search-input'), 'no-such-mission-text-anywhere');
    expect(screen.getByText(/no matching runs/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    expect(screen.queryByTestId('runs-filter-chip-kinds-build')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-mission-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-sweep-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-build-1')).toBeInTheDocument();
  });
});

describe('RunsTable chat truth', () => {
  it('renders the provider and exact model on a chat row', () => {
    renderTable({ runs: [CHAT_RUN] });
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByTestId('run-model-run-chat-1')).toHaveTextContent('Claude · claude-opus-4-8');
  });

  it('searches provider and model in addition to the turn description', async () => {
    const user = userEvent.setup();
    renderTable({ runs: [...RUNS, CHAT_RUN] });

    await user.type(screen.getByTestId('runs-search-input'), 'opus-4-8');

    expect(screen.getByTestId('run-row-run-chat-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-mission-1')).not.toBeInTheDocument();
  });
});

// ============================================================================
// COLUMN ORDER + SORTING (Task 24 / P-F8) — Run first (flexible width,
// truncate), then Agent, Kind, Status, Quality, Tokens, Cost, Duration, Started.
// Every column is sortable via the shared SortableHeader; default sort is
// Started descending; sorting is client-side over the assembled rows.
// ============================================================================

describe('RunsTable column order', () => {
  it('renders headers in the order Run, Agent, Kind, Status, Quality, Tokens, Cost, Duration, Started', () => {
    renderTable();
    const headerRow = screen.getAllByRole('row')[0];
    const headers = within(headerRow)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim());

    expect(headers).toEqual(['Run', 'Agent', 'Kind', 'Status', 'Quality', 'Tokens', 'Cost', 'Duration', 'Started']);
  });
});

describe('RunsTable column sorting', () => {
  it('defaults to Started descending (most recent run first)', () => {
    renderTable({ runs: SORT_RUNS });
    expect(rowOrder()).toEqual(['run-row-sort-b', 'run-row-sort-c', 'run-row-sort-a']);
  });

  it('toggles Started ascending on a second click of the already-active header, changing row order', async () => {
    const user = userEvent.setup();
    renderTable({ runs: SORT_RUNS });

    const startedButton = within(screen.getByTestId('runs-sort-started')).getByRole('button');
    await user.click(startedButton);

    expect(screen.getByTestId('runs-sort-started')).toHaveAttribute('aria-sort', 'ascending');
    expect(rowOrder()).toEqual(['run-row-sort-a', 'run-row-sort-c', 'run-row-sort-b']);
  });

  it('sorts by Run text when the Run header is clicked (new field defaults descending)', async () => {
    const user = userEvent.setup();
    renderTable({ runs: SORT_RUNS });

    const missionButton = within(screen.getByTestId('runs-sort-mission')).getByRole('button');
    await user.click(missionButton);

    expect(screen.getByTestId('runs-sort-mission')).toHaveAttribute('aria-sort', 'descending');
    // Descending alpha: "Zulu…" > "Mid…" > "Alpha…"
    expect(rowOrder()).toEqual(['run-row-sort-b', 'run-row-sort-c', 'run-row-sort-a']);

    await user.click(missionButton);

    expect(screen.getByTestId('runs-sort-mission')).toHaveAttribute('aria-sort', 'ascending');
    expect(rowOrder()).toEqual(['run-row-sort-a', 'run-row-sort-c', 'run-row-sort-b']);
  });

  it('sorts by Tokens numerically when the Tokens header is clicked', async () => {
    const user = userEvent.setup();
    renderTable({ runs: SORT_RUNS });

    const tokensButton = within(screen.getByTestId('runs-sort-tokens')).getByRole('button');
    await user.click(tokensButton);

    // Descending tokens: 900 (sort-c) > 500 (sort-a) > 100 (sort-b)
    expect(rowOrder()).toEqual(['run-row-sort-c', 'run-row-sort-a', 'run-row-sort-b']);
  });

  it('sorts by Quality score, treating a missing quality report as the lowest value', async () => {
    const user = userEvent.setup();
    renderTable({ runs: SORT_RUNS });

    const qualityButton = within(screen.getByTestId('runs-sort-quality')).getByRole('button');
    await user.click(qualityButton);

    // Descending score: 80 (sort-b) > 30 (sort-a) > no report (sort-c)
    expect(rowOrder()).toEqual(['run-row-sort-b', 'run-row-sort-a', 'run-row-sort-c']);
  });

  it.each([
    ['agent', ['run-row-sort-a', 'run-row-sort-c', 'run-row-sort-b']],
    ['kind', ['run-row-sort-c', 'run-row-sort-a', 'run-row-sort-b']],
    ['status', ['run-row-sort-a', 'run-row-sort-c', 'run-row-sort-b']],
    ['duration', ['run-row-sort-a', 'run-row-sort-c', 'run-row-sort-b']],
  ] as const)(
    'wires the %s column header through SortableHeader (aria-sort updates on click, row order changes)',
    async (field, expectedOrder) => {
      const user = userEvent.setup();
      renderTable({ runs: SORT_RUNS });

      const header = screen.getByTestId(`runs-sort-${field}`);
      expect(header).toHaveAttribute('aria-sort', 'none');

      await user.click(within(header).getByRole('button'));

      expect(header).toHaveAttribute('aria-sort', 'descending');
      // Clicking a new field's header must clear the previously-active column's
      // aria-sort (only one column is ever active at a time).
      expect(screen.getByTestId('runs-sort-started')).toHaveAttribute('aria-sort', 'none');
      expect(rowOrder()).toEqual(expectedOrder);
    }
  );
});

// ============================================================================
// PAGINATION RESET ON FILTER CHANGE (Task 21 follow-up, Minor finding)
// ============================================================================

describe('RunsTable pagination reset', () => {
  it('resets to page 1 when a filter changes after navigating to a later page', async () => {
    const user = userEvent.setup();
    renderTable({ runs: PAGINATION_RUNS });

    // 12 rows, pageSize 10 (default) → page 1 shows runs 1-10, page 2 shows 11-12.
    expect(screen.getByTestId('run-row-page-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-page-run-11')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /next page/i }));

    expect(screen.getByTestId('run-row-page-run-11')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-page-run-1')).not.toBeInTheDocument();

    // Changing the search filter must snap pageIndex back to 0 — otherwise
    // a still-on-page-2 offset could paginate past a shrunk result set and
    // show an empty state despite matching rows existing on page 1.
    await user.type(screen.getByTestId('runs-search-input'), 'Mission number');

    expect(screen.getByTestId('run-row-page-run-1')).toBeInTheDocument();
  });
});

// ============================================================================
// ARUN-026 — multi-select Agent / Kind / Status facets
// ============================================================================

const FACET_RUNS: AgentRunRow[] = [
  {
    id: 'f-chat-scout',
    agent: 'scout',
    mission: 'Chat about quantum',
    kind: 'chat',
    status: 'success',
    tokens: 100,
    durationMs: 1000,
    startedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'f-mission-scout',
    agent: 'scout',
    mission: 'Mission on sensing',
    kind: 'mission',
    status: 'failure',
    tokens: 200,
    durationMs: 2000,
    startedAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'f-mission-linker',
    agent: 'linker',
    mission: 'Mission on relations',
    kind: 'mission',
    status: 'success',
    tokens: 300,
    durationMs: 3000,
    startedAt: '2026-05-03T00:00:00.000Z',
  },
  {
    id: 'f-build-creator',
    agent: 'creator',
    mission: 'Build a prototype',
    kind: 'build',
    status: 'live',
    tokens: 400,
    durationMs: 4000,
    startedAt: '2026-05-04T00:00:00.000Z',
  },
];

/**
 * Open a facet dropdown, tick every named option, then close it. The menu
 * deliberately stays open across picks (that's the point of a multi-select),
 * and Radix locks body pointer-events while it is — so each visit must end
 * with an explicit close before anything else can be clicked.
 */
async function pickFacetOptions(user: ReturnType<typeof userEvent.setup>, facet: string, ...options: RegExp[]) {
  await user.click(screen.getByTestId(`runs-${facet}-filter`));
  for (const option of options) {
    await user.click(await screen.findByRole('menuitemcheckbox', { name: option }));
  }
  await user.keyboard('{Escape}');
}

describe('RunsTable facets (ARUN-026)', () => {
  // The saved filter preference is real localStorage — clear it so one
  // test's selection can't leak into the next.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('exposes accessible Agent, Kind and Status facet triggers', () => {
    renderTable({ runs: FACET_RUNS });
    expect(screen.getByRole('button', { name: /filter by agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by kind/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by status/i })).toBeInTheDocument();
  });

  it('offers only the values actually present in the runs', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await user.click(screen.getByTestId('runs-agents-filter'));
    expect(await screen.findByRole('menuitemcheckbox', { name: /scout/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /linker/i })).toBeInTheDocument();
    // 'evaluator' never ran — offering it would imply history that isn't there.
    expect(screen.queryByRole('menuitemcheckbox', { name: /evaluator/i })).toBeNull();
  });

  it('ORs selections within the Kind facet', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /chats/i, /builds/i);

    expect(screen.getByTestId('run-row-f-chat-scout')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-f-build-creator')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-f-mission-scout')).toBeNull();
  });

  it('ANDs across the Agent and Kind facets', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /missions/i);
    await pickFacetOptions(user, 'agents', /scout/i);

    expect(screen.getByTestId('run-row-f-mission-scout')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-f-mission-linker')).toBeNull();
    expect(screen.queryByTestId('run-row-f-chat-scout')).toBeNull();
  });

  it('ANDs the facets with the search box', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /missions/i);
    await user.type(screen.getByTestId('runs-search-input'), 'relations');

    expect(screen.getByTestId('run-row-f-mission-linker')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-f-mission-scout')).toBeNull();
  });

  it('filters on Status as its own facet', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'statuses', /failed/i);

    expect(screen.getByTestId('run-row-f-mission-scout')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-f-mission-linker')).toBeNull();
  });

  it('renders a removable chip per selected value', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /chats/i);
    const chip = screen.getByTestId('runs-filter-chip-kinds-chat');
    expect(chip).toBeInTheDocument();

    await user.click(chip);
    expect(screen.getByTestId('run-row-f-mission-scout')).toBeInTheDocument();
    expect(screen.queryByTestId('runs-filter-chip-kinds-chat')).toBeNull();
  });

  it('Reset clears every facet at once', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /chats/i);
    await pickFacetOptions(user, 'agents', /scout/i);
    await user.click(screen.getByTestId('runs-filter-reset'));

    expect(screen.queryByTestId('runs-filter-chip-kinds-chat')).toBeNull();
    expect(screen.queryByTestId('runs-filter-chip-agents-scout')).toBeNull();
    expect(screen.getAllByTestId(/^run-row-/)).toHaveLength(FACET_RUNS.length);
  });

  it('reports the visible count against the unfiltered total — filters never restate the total', async () => {
    const user = userEvent.setup();
    renderTable({ runs: FACET_RUNS });

    await pickFacetOptions(user, 'kinds', /chats/i);
    const summary = screen.getByTestId('runs-filter-summary');
    expect(summary).toHaveTextContent('1');
    expect(summary).toHaveTextContent(String(FACET_RUNS.length));
  });

  it('the ?tab=builds deep link preselects the Builds kind facet', () => {
    renderTable({ runs: FACET_RUNS, initialKindFacet: 'build' });
    expect(screen.getByTestId('run-row-f-build-creator')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-f-chat-scout')).toBeNull();
    expect(screen.getByTestId('runs-filter-chip-kinds-build')).toBeInTheDocument();
  });

  it('a selected facet resets pagination to page 1', async () => {
    const user = userEvent.setup();
    renderTable({ runs: PAGINATION_RUNS });

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByTestId('run-row-page-run-11')).toBeInTheDocument();

    await pickFacetOptions(user, 'statuses', /success/i);
    expect(screen.getByTestId('run-row-page-run-1')).toBeInTheDocument();
  });
});
