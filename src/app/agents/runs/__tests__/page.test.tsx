/**
 * @file agents/runs/__tests__/page.test.tsx
 * @description Task 21 (P-F1 part 1) regression — verifies the /agents/runs
 * page mounts, keeps the cost strip on top, and renders the run history as
 * a standard `RunsTable` (one row per chat/mission/sweep/build) instead of the
 * old Live Log / History / Builds tabbed feed.
 *
 * Updated Task 24 (P-F8 parity pass): the page-level `PageHeader` ("Agent
 * Runs" title) is gone — the title now lives inside RunsTable's own card
 * header (CONV-HEADER) — and the `?tab=builds` deep link no longer preselects
 * a permanent kind facet `Select` (removed). It sets hidden state surfaced as
 * a dismissible "Kind: Builds ×" chip instead.
 *
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentLogEntry, TokenUsageSummary } from '@/hooks/useAgentActivity';
import type { Mission } from '@/lib/schemas/mission';
import { SSE_FALLBACK_POLL_MS } from '../runs-table-rows';

// jsdom has no app router, so stub next/navigation. `useSearchParams` backs
// the page's tab=builds / build=<id> deep-link support (Important finding
// #2) — mutable so individual tests can set the URL under test. `mockRouterPush`
// is shared (not a fresh jest.fn() per render) so the row-click navigation
// test below (Task 22 / P-F1 part 2 — the run detail route now exists) can
// assert on it.
let mockSearchParams = new URLSearchParams();
const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
  useSearchParams: () => mockSearchParams,
  // ARUN-026: the table's facet state writes shareable URL params through
  // `useUrlParams`, which reads the pathname alongside the search params.
  usePathname: () => '/agents/runs',
}));

// ---------------------------------------------------------------------------
// Layout chrome — passthrough mocks. SmartLayout pulls in firebase-admin via
// sidebar links, so we stub it down to a div for unit-scope mounting.
// ---------------------------------------------------------------------------
jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  __esModule: true,
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  __esModule: true,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ErrorFallback: ({ title }: { title?: string }) => <div role="alert">{title ?? 'error'}</div>,
}));

// ---------------------------------------------------------------------------
// Firebase + fetch — quiet the import graph. The page itself doesn't call
// these, but useAgentEventStream's static imports reach @/lib/firebase.
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase', () => ({
  auth: {
    currentUser: {
      uid: 'test-user',
      getIdToken: jest.fn().mockResolvedValue('test-token'),
    },
  },
  db: {},
}));
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));
// Build missions need an authenticated user to enable their query.
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'test-user' }, loading: false }),
}));

// ---------------------------------------------------------------------------
// SSE stream — must be mocked or the test pulls the network and the live-log
// connection badge races. Return a deterministic disconnected state.
// ---------------------------------------------------------------------------
// ARUN-013 — mutable so tests can drive an SSE outage (degraded banner +
// fallback history poll).
let mockSseConnectionError = false;
jest.mock('@/hooks/useAgentEventStream', () => ({
  __esModule: true,
  useAgentEventStream: () => ({
    events: [],
    isConnected: !mockSseConnectionError,
    connectionError: mockSseConnectionError,
    clearEvents: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Build missions — no in-flight builds by default; individual deep-link
// tests below reassign this to a fixture carrying a build mission.
// ---------------------------------------------------------------------------
let mockBuildMissionsData: Mission[] = [];
// ARUN-012 — per-source error flags so tests can drive the partial-degradation
// banner and the "all sources down" unavailable panel.
let mockBuildIsError = false;
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  __esModule: true,
  useBuildMissions: () => ({
    data: mockBuildMissionsData,
    isLoading: false,
    isError: mockBuildIsError,
    error: null,
    refetch: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Activity hooks — seed at least one realistic AgentLogEntry so the table
// actually mounts. An empty array would render the "no runs yet" empty state
// and miss the row-level assertions.
// ---------------------------------------------------------------------------
const SEEDED_ENTRIES: AgentLogEntry[] = [
  {
    id: 'run-1',
    agentName: 'scout',
    action: 'Discovered 3 new technology signals',
    status: 'success',
    tokenUsage: { input: 1200, output: 800 },
    duration: 4500,
    createdAt: '2026-05-08T08:00:00.000Z',
  },
  {
    id: 'run-2',
    agentName: 'evaluator',
    action: 'Scored 5 inbound signals',
    status: 'failure',
    tokenUsage: { input: 900, output: 0 },
    duration: 1200,
    errors: ['Rate limit exceeded'],
    createdAt: '2026-05-08T07:30:00.000Z',
  },
];

const SEEDED_CHAT_ENTRY: AgentLogEntry = {
  id: 'run-chat-1',
  agentName: 'chat',
  action: 'Research quantum sensing',
  kind: 'chat',
  provider: 'gemini',
  model: 'gemini-3.5-pro',
  status: 'success',
  tokenUsage: { input: 300, output: 120 },
  duration: 900,
  toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 25 }],
  toolSummaryTruncated: false,
  createdAt: '2026-05-08T09:00:00.000Z',
};

const SEEDED_TOKEN_USAGE: TokenUsageSummary = {
  today: { date: '2026-05-08', input: 2100, output: 800, total: 2900, costUsd: 0.12 },
  thisWeek: [],
};

// ARUN-012 — mutable so tests can drive the history source's error / emptiness.
let mockLogEntriesData: AgentLogEntry[] = SEEDED_ENTRIES;
let mockLogError: Error | null = null;
let mockTokenUsageData: TokenUsageSummary = SEEDED_TOKEN_USAGE;
let mockDegradedKinds: Array<'chat' | 'mission' | 'sweep'> = [];
jest.mock('@/hooks/useAgentActivity', () => ({
  __esModule: true,
  useAgentLog: () => ({
    data: mockLogEntriesData,
    isLoading: false,
    error: mockLogError,
    isError: Boolean(mockLogError),
    degradedKinds: mockDegradedKinds,
    refetch: jest.fn(),
  }),
  useTokenUsage: () => ({ data: mockTokenUsageData, isLoading: false, error: null }),
  activityKeys: { all: ['agentActivity'], log: () => ['agentActivity', 'log'] },
}));

// ARUN-001 durable running source — mocked so the page doesn't reach the real
// Firebase client read (which useBuildMissions is mocked for the same reason).
let mockRunningData: Mission[] = [];
let mockRunningIsError = false;
jest.mock('@/hooks/queries/useRunningMissions', () => ({
  __esModule: true,
  useRunningMissions: () => ({
    data: mockRunningData,
    isLoading: false,
    isError: mockRunningIsError,
    error: null,
    refetch: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// lucide-react ESM proxy stub — Jest's CJS transform can't load lucide
// directly. Render every icon as a tagged span.
// ---------------------------------------------------------------------------
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => makeIcon(prop),
    }
  );
});

// Skeleton barrel can transitively pull lucide; stub the one used here.
jest.mock('@/components/skeletons', () => ({
  __esModule: true,
  CardGridSkeleton: () => <div data-testid="card-grid-skeleton" />,
}));

import AgentRunsPage from '../page';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// A highlighted row (?build=<id> deep link) scrolls itself into view on
// mount; jsdom doesn't implement scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  // ARUN-026 persists the facet selection per account, so a selection made
  // in one test would otherwise be restored in the next.
  window.localStorage.clear();
  mockSearchParams = new URLSearchParams();
  mockBuildMissionsData = [];
  mockBuildIsError = false;
  mockLogEntriesData = SEEDED_ENTRIES;
  mockLogError = null;
  mockTokenUsageData = SEEDED_TOKEN_USAGE;
  mockDegradedKinds = [];
  mockRunningData = [];
  mockRunningIsError = false;
  mockSseConnectionError = false;
  mockRouterPush.mockClear();
});

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'build-1',
    userId: 'u1',
    prompt: 'Prototype: internal knowledge search',
    agent: 'builder',
    kind: 'build',
    status: 'completed',
    progress: 100,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-05-09T09:00:00.000Z',
    completedAt: '2026-05-09T09:05:00.000Z',
    ...overrides,
  } as Mission;
}

describe('AgentRunsPage', () => {
  it('renders without throwing when run data is provided', () => {
    expect(() => renderWithQuery(<AgentRunsPage />)).not.toThrow();
    // Layout passthrough mounted, proving the import graph resolved.
    expect(screen.getByTestId('layout')).toBeInTheDocument();
  });

  it('renders the page header "Agent Runs"', () => {
    renderWithQuery(<AgentRunsPage />);
    expect(screen.getByRole('heading', { name: /agent runs/i, level: 1 })).toBeInTheDocument();
  });

  // UX-068 — Background Verifications moved to Activity → Jobs (/agents/jobs).
  // This page must hold exactly one table; a second stacked table here is the
  // regression the move exists to prevent.
  it('no longer stacks Background Verifications under the runs table', () => {
    renderWithQuery(<AgentRunsPage />);

    expect(screen.queryByTestId('jobs-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('defense-verifications-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/background verifications/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^jobs$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders the cost strip on top of the table', () => {
    renderWithQuery(<AgentRunsPage />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('$0.12')).toBeInTheDocument();
    expect(screen.getByText('2.9K tokens')).toBeInTheDocument();
    expect(screen.queryByText(/^Budget:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens\/day/i)).not.toBeInTheDocument();
  });

  it('renders in-flight reservation spend even before any tokens finalize', () => {
    mockTokenUsageData = {
      today: { date: '2026-05-08', input: 0, output: 0, total: 0, costUsd: 6.5 },
      thisWeek: [],
    };

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByText('$6.50')).toBeInTheDocument();
    expect(screen.getByText('0 tokens')).toBeInTheDocument();
  });

  it('warns when a kind-floor query returns only partial history', () => {
    mockDegradedKinds = ['mission'];

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-degraded-banner')).toHaveTextContent('older run history');
  });

  it('renders one row per agent run as a standard table (no tabs)', () => {
    renderWithQuery(<AgentRunsPage />);

    // The tabbed Live Log / History / Builds feed is gone.
    expect(screen.queryByRole('tab', { name: /live log/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /builds/i })).not.toBeInTheDocument();

    // One row per seeded run, identified by RunsTable's row testid contract.
    expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-2')).toBeInTheDocument();
    expect(screen.getByText('Discovered 3 new technology signals')).toBeInTheDocument();
    expect(screen.getByText('Scored 5 inbound signals')).toBeInTheDocument();
  });

  it('displays run status pills', () => {
    renderWithQuery(<AgentRunsPage />);
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  // The run detail route (P-F1 pt2, src/app/agents/runs/[id]/page.tsx) now
  // exists — row clicks navigate there instead of the former no-op
  // (`onRowClick={() => {}}` + `clickable={false}`).
  it('navigates to the run detail route when a row is clicked', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentRunsPage />);

    await user.click(screen.getByTestId('run-row-run-1'));

    expect(mockRouterPush).toHaveBeenCalledWith('/agents/runs/run-1');
  });
});

// ============================================================================
// DEEP LINKS (Important finding #2) — three live call sites (artifacts/[id],
// triage/assessment/[id], artifact-output-ui.ts) still emit
// the old tabbed page's /agents/runs?tab=builds&build=<id> link shape.
// ============================================================================

describe('AgentRunsPage deep links (?tab=builds & ?build=<id>)', () => {
  it('shows the dismissible "Kind: Builds" chip and narrows rows when the URL carries ?tab=builds', () => {
    mockBuildMissionsData = [buildMission()];
    mockSearchParams = new URLSearchParams('tab=builds');

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-filter-chip-kinds-build')).toHaveTextContent('Kind: Builds');
    // The seeded history rows (mission/sweep kind) drop out of the Builds facet.
    expect(screen.queryByTestId('run-row-run-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-build-1')).toBeInTheDocument();
  });

  it('highlights the row matching ?build=<id> when present', () => {
    mockBuildMissionsData = [buildMission()];
    mockSearchParams = new URLSearchParams('tab=builds&build=build-1');

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('run-row-build-1')).toHaveClass('bg-muted/50');
  });

  it('does not show the kind chip or highlight anything without the query params', () => {
    mockBuildMissionsData = [buildMission()];

    renderWithQuery(<AgentRunsPage />);

    expect(screen.queryByTestId('runs-filter-chip-kinds-build')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-1')).not.toHaveClass('bg-muted/50');
  });

  it('dismissing the "Kind: Builds" chip (deep-linked via ?tab=builds) reveals all rows again', async () => {
    const user = userEvent.setup();
    mockBuildMissionsData = [buildMission()];
    mockSearchParams = new URLSearchParams('tab=builds');

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-filter-chip-kinds-build')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('runs-filter-chip-kinds-build'));

    expect(screen.queryByTestId('runs-filter-chip-kinds-build')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-2')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-build-1')).toBeInTheDocument();
  });

  it('supports the chat facet deep link and keeps chat detail navigation intact', async () => {
    const user = userEvent.setup();
    mockLogEntriesData = [...SEEDED_ENTRIES, SEEDED_CHAT_ENTRY];
    mockSearchParams = new URLSearchParams('tab=chats');

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-filter-chip-kinds-chat')).toHaveTextContent('Kind: Chats');
    expect(screen.getByTestId('run-row-run-chat-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-model-run-chat-1')).toHaveTextContent('Gemini · gemini-3.5-pro');

    await user.click(screen.getByTestId('run-row-run-chat-1'));

    expect(mockRouterPush).toHaveBeenCalledWith('/agents/runs/run-chat-1');
  });
});

// ============================================================================
// PARTIAL / UNAVAILABLE STATES (ARUN-012) — the table draws from four
// independent sources; a failure in any of them must be told truthfully.
// Some rows + a failed source → show the rows and a degraded banner. Nothing
// loaded + a failed source → an "unavailable" panel, never a fake empty inbox.
// Everything empty AND healthy → the genuine "no runs yet" empty state.
// ============================================================================

describe('AgentRunsPage partial / unavailable states (ARUN-012)', () => {
  it('shows a degraded banner above the still-rendered rows when one source fails but others return data', () => {
    // History errors and returns nothing, but a build mission still loads.
    mockLogEntriesData = [];
    mockLogError = new Error('history down');
    mockBuildMissionsData = [buildMission()];

    renderWithQuery(<AgentRunsPage />);

    // The build row we DO have is shown — not swallowed into a full error page.
    expect(screen.getByTestId('run-row-build-1')).toBeInTheDocument();
    // ...with an honest banner naming the degraded source.
    const banner = screen.getByTestId('runs-degraded-banner');
    expect(banner).toHaveTextContent(/some runs may be missing/i);
    expect(banner).toHaveTextContent(/run history/i);
    expect(screen.getByTestId('runs-degraded-retry')).toBeInTheDocument();
  });

  it('shows the "unavailable" panel — NOT an empty inbox — when a source fails and nothing loaded', () => {
    mockLogEntriesData = [];
    mockLogError = new Error('history down');
    mockBuildMissionsData = [];
    mockRunningData = [];

    renderWithQuery(<AgentRunsPage />);

    // ErrorFallback (mocked to role=alert with its title) — an outage, not empty.
    expect(screen.getByRole('alert')).toHaveTextContent('Agent runs unavailable');
    expect(screen.queryByText('No agent runs yet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runs-degraded-banner')).not.toBeInTheDocument();
  });

  it('shows the genuine empty state (no banner) when every source succeeds but there are no runs', () => {
    mockLogEntriesData = [];
    mockBuildMissionsData = [];
    mockRunningData = [];
    // no error flags — all sources healthy.

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByText('No agent runs yet')).toBeInTheDocument();
    expect(screen.queryByTestId('runs-degraded-banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not render the degraded banner when every source is healthy and rows exist', () => {
    renderWithQuery(<AgentRunsPage />);
    expect(screen.queryByTestId('runs-degraded-banner')).not.toBeInTheDocument();
  });
});

// ============================================================================
// SSE DEGRADATION + FALLBACK POLL (ARUN-013) — a dead live stream must be
// visible (it feeds the same banner), and while it's down a bounded history
// poll bridges the terminal handoff (a completed run still surfaces) — then
// STOPS the moment the stream reconnects.
// ============================================================================

describe('AgentRunsPage SSE degradation (ARUN-013)', () => {
  it('surfaces an SSE outage in the degraded banner without blanking the table', () => {
    mockSseConnectionError = true;

    renderWithQuery(<AgentRunsPage />);

    // Rows still render (durable sources are healthy)...
    expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument();
    // ...and the outage is named honestly.
    const banner = screen.getByTestId('runs-degraded-banner');
    expect(banner).toHaveTextContent(/live event stream/i);
    // A dead stream alone never escalates to the full "unavailable" panel.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('polls history on an interval while the stream is degraded, and stops once it recovers', () => {
    jest.useFakeTimers();
    try {
      mockSseConnectionError = true;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined as never);

      const { rerender } = render(
        <QueryClientProvider client={client}>
          <AgentRunsPage />
        </QueryClientProvider>
      );

      // Mount alone doesn't invalidate (no SSE completion event to hand off).
      invalidateSpy.mockClear();

      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS);
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agentActivity', 'log'] });

      // Recovery — the stream reconnects; the fallback poll must stop entirely.
      invalidateSpy.mockClear();
      mockSseConnectionError = false;
      rerender(
        <QueryClientProvider client={client}>
          <AgentRunsPage />
        </QueryClientProvider>
      );
      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 3);
      });
      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not run the fallback poll while the stream is healthy', () => {
    jest.useFakeTimers();
    try {
      mockSseConnectionError = false;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined as never);

      render(
        <QueryClientProvider client={client}>
          <AgentRunsPage />
        </QueryClientProvider>
      );
      invalidateSpy.mockClear();

      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 3);
      });
      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================================
// ARUN-027 — cost strip accounting scope
// ============================================================================

describe('AgentRunsPage cost strip accounting scope (ARUN-027)', () => {
  it('labels a legacy daily figure as settled rather than a generic app estimate', () => {
    renderWithQuery(<AgentRunsPage />);
    expect(screen.getByTestId('runs-cost-scope')).toHaveTextContent(/settled/i);
  });

  it('shows settled and rate-card-estimated costs as distinct amounts', () => {
    mockTokenUsageData = {
      today: {
        date: '2026-05-08',
        input: 100,
        output: 50,
        total: 150,
        costUsd: 3,
        settledCostUsd: 1.25,
        estimatedCostUsd: 1.75,
        reservedCostUsd: 0,
        unavailableCostRuns: 0,
      },
      thisWeek: [],
    };

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-cost-settled')).toHaveTextContent('$1.25 settled');
    expect(screen.getByTestId('runs-cost-estimated')).toHaveTextContent('$1.75 estimated (rate card)');
    expect(screen.getByTestId('runs-cost-scope')).toHaveTextContent(/observed and estimated/i);
  });

  it('renders an unknown total as "—" rather than a fabricated $0.00', () => {
    mockTokenUsageData = {
      today: { date: '2026-05-08', input: 0, output: 0, total: 0, costUsd: 0, unavailableCostRuns: 4 },
      thisWeek: [],
    };

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-today-cost')).toHaveTextContent('—');
    expect(screen.getByTestId('runs-today-cost')).not.toHaveTextContent('$0.00');
    expect(screen.getByTestId('runs-cost-unavailable')).toHaveTextContent('4');
  });

  it('calls out in-flight reserved spend separately from the tracked total', () => {
    mockTokenUsageData = {
      today: {
        date: '2026-05-08',
        input: 100,
        output: 50,
        total: 150,
        costUsd: 6.5,
        settledCostUsd: 2.5,
        reservedCostUsd: 4.0,
        unavailableCostRuns: 0,
      },
      thisWeek: [],
    };

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-today-cost')).toHaveTextContent('$6.50');
    expect(screen.getByTestId('runs-cost-reserved')).toHaveTextContent('$4.00');
  });

  it('renders a genuine zero as $0.00 when nothing is missing', () => {
    mockTokenUsageData = {
      today: { date: '2026-05-08', input: 0, output: 0, total: 0, costUsd: 0, unavailableCostRuns: 0 },
      thisWeek: [],
    };

    renderWithQuery(<AgentRunsPage />);

    expect(screen.getByTestId('runs-today-cost')).toHaveTextContent('$0.00');
  });
});
