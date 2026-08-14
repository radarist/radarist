/**
 * @file agents/runs/[id]/__tests__/page.test.tsx
 * @description Task 22 (P-F1 part 2) — Run detail page. Resolves a run by id
 * from the same three sources `/agents/runs` assembles rows from
 * (`useAgentLog`, `useBuildMissions`, `useAgentEventStream`, all mocked here)
 * via `buildRunDetail`, then renders metadata, quality checks, an errors
 * banner, and the event log (reusing `AgentLog` once a full record exists,
 * or a live SSE tail while the run is still in flight).
 *
 */

import React from 'react';
import { act, render, screen, within, fireEvent } from '@testing-library/react';
import { format } from 'date-fns';
import type { AgentLogEntry } from '@/hooks/useAgentActivity';
import type { AgentEvent } from '@/lib/schemas/agent-event';
import type { Mission } from '@/lib/schemas/mission';
import type { Report } from '@/lib/schemas/report';
import { SSE_FALLBACK_POLL_MS } from '../../runs-table-rows';

// ---------------------------------------------------------------------------
// framer-motion — ScrollToBottom (reused for the Event Log's P-F6 jump
// button) animates via motion.div/AnimatePresence; strip that down to plain
// passthrough markup so tests assert on `visible` synchronously.
// ---------------------------------------------------------------------------
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// next/navigation — `useParams` backs the dynamic [id] segment; mutable so
// individual tests can point at a different run id.
// ---------------------------------------------------------------------------
let mockRunId = 'run-1';
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: mockRunId }),
  // AgentLog's empty state (not exercised here) navigates via useRouter.
  useRouter: () => ({ push: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Layout chrome — SmartLayout pulls in firebase-admin via sidebar links;
// stub it down to a div (matches src/app/agents/runs/__tests__/page.test.tsx).
// PageShell/DetailPageShell are plain CSS-only components — rendered for real.
// ---------------------------------------------------------------------------
jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

// ---------------------------------------------------------------------------
// Firebase + fetch — quiet the import graph. useAgentEventStream's static
// imports reach @/lib/firebase even though the hook itself is mocked below.
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase', () => ({
  auth: { currentUser: { uid: 'test-user', getIdToken: jest.fn().mockResolvedValue('test-token') } },
  db: {},
}));
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'test-user' }, loading: false }),
}));

// ---------------------------------------------------------------------------
// AgentLog resolves missionId → report via useReports; also backs the P-F7
// Output card's report lookup on the page itself. Mutable per test (defaults
// empty) so Output-card tests can seed a matching report.
// ---------------------------------------------------------------------------
let mockReports: Report[] = [];
jest.mock('@/hooks/useReports', () => ({
  useReports: () => ({ data: mockReports }),
}));

// ---------------------------------------------------------------------------
// The four run-detail data sources — mutable per test. `useRunEvents` is the
// persisted step-history seed (Task 22 follow-up), now split into its own
// module (src/hooks/useRunEvents.ts); defaults to empty + not loading, so
// completed-run tests exercise the no-history fallback notes.
// ---------------------------------------------------------------------------
let mockLogEntries: AgentLogEntry[] = [];
let mockLogLoading = false;
// ARUN-012 — per-source error flags so tests can drive the "temporarily
// unavailable" (vs "Not Found") state and the Partial pill.
let mockLogIsError = false;
let mockHistoryEvents: AgentEvent[] = [];
let mockHistoryTruncated = false;
let mockHistoryLoading = false;
let mockHistoryIsError = false;
const mockUseRunEvents = jest.fn();
// ARUN-013 — shared (not fresh-per-render) so the fallback-poll test can assert
// the persisted-history refetch fires on the interval.
const mockRefetchEvents = jest.fn();
jest.mock('@/hooks/useAgentActivity', () => ({
  __esModule: true,
  useAgentLog: () => ({
    data: mockLogEntries,
    isLoading: mockLogLoading,
    isError: mockLogIsError,
    error: null,
    refetch: jest.fn(),
  }),
}));
jest.mock('@/hooks/useRunEvents', () => ({
  __esModule: true,
  useRunEvents: (runId: string | undefined) => {
    mockUseRunEvents(runId);
    return {
      data: { events: mockHistoryEvents, truncated: mockHistoryTruncated },
      isLoading: mockHistoryLoading,
      isError: mockHistoryIsError,
      error: null,
      refetch: mockRefetchEvents,
    };
  },
}));

// ARUN-029 — the Mission doc behind a Creator (kind 'mission') run. `undefined`
// means "not looked up"; `null` means "looked up, no such mission".
let mockMissionDetail: Mission | null | undefined = null;
let mockMissionDetailIsError = false;
const mockUseMissionDetail = jest.fn();
jest.mock('@/hooks/queries/useMissionDetail', () => ({
  __esModule: true,
  useMissionDetail: (missionId: string | undefined) => {
    mockUseMissionDetail(missionId);
    return { data: missionId ? mockMissionDetail : undefined, isError: mockMissionDetailIsError, isLoading: false };
  },
}));

let mockBuildMissions: Mission[] = [];
let mockBuildLoading = false;
let mockBuildIsError = false;
// AUDIT-006 — the page now mounts BuildMissionCard, which imports `useResolveGate`
// and `useCancelBuildMission` from this same module. A mock exporting only
// `useBuildMissions` would make those `undefined` and throw the moment a build
// mission renders, so the mock has to cover the module's real surface.
const mockResolveGate = jest.fn();
const mockCancelBuildMission = jest.fn();
const mockResumeBuildArtifact = jest.fn();
const mockResetBuildArtifactResume = jest.fn();
jest.mock('@/hooks/queries/useBuildMissions', () => ({
  __esModule: true,
  useBuildMissions: () => ({
    data: mockBuildMissions,
    isLoading: mockBuildLoading,
    isError: mockBuildIsError,
    error: null,
    refetch: jest.fn(),
  }),
  useResolveGate: () => ({ mutate: mockResolveGate, mutateAsync: mockResolveGate, isPending: false }),
  useCancelBuildMission: () => ({
    mutate: mockCancelBuildMission,
    mutateAsync: mockCancelBuildMission,
    isPending: false,
  }),
  useResumeBuildArtifact: () => ({
    mutate: mockResumeBuildArtifact,
    mutateAsync: mockResumeBuildArtifact,
    reset: mockResetBuildArtifactResume,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

let mockEvents: AgentEvent[] = [];
// ARUN-013 — mutable so tests can drive an SSE outage (degraded badge +
// fallback event-history poll).
let mockSseConnectionError = false;
// P-F9 — mutable jest.fn() (rather than a bare arrow) so tests can assert the
// `enabled` argument the page passes in, per completed-vs-live run.
const mockUseAgentEventStream = jest.fn((_enabled?: boolean) => ({
  events: mockEvents,
  isConnected: !mockSseConnectionError,
  connectionError: mockSseConnectionError,
  clearEvents: jest.fn(),
}));
jest.mock('@/hooks/useAgentEventStream', () => ({
  __esModule: true,
  useAgentEventStream: (enabled?: boolean) => mockUseAgentEventStream(enabled),
}));

// ---------------------------------------------------------------------------
// lucide-react ESM proxy stub (matches sibling page test).
// ---------------------------------------------------------------------------
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import RunDetailPage from '../page';

// ============================================================================
// FIXTURES
// ============================================================================

function agentLogEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    id: 'run-1',
    agentName: 'scout',
    action: 'Discovered 3 new technology signals',
    status: 'success',
    tokenUsage: { input: 1200, output: 800 },
    duration: 4500,
    createdAt: '2026-05-08T08:00:00.000Z',
    ...overrides,
  };
}

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

function agentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    type: 'agent.started',
    timestamp: '2026-05-09T09:00:00.000Z',
    userId: 'u1',
    sequence: 1,
    data: {},
    ...overrides,
  } as AgentEvent;
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    title: 'Q3 Technology Landscape',
    html: '<html></html>',
    createdAt: '2026-05-08T08:00:00.000Z',
    createdBy: 'agent',
    // Catalog reports are owner-scoped and carry the authenticated owner
    // (the mocked useAuth uid), so the canonical selector links them.
    ownerId: 'test-user',
    entityIds: [],
    metadata: { description: 'desc', dataSnapshotAt: '2026-05-08T08:00:00.000Z' },
    shared: false,
    ...overrides,
  };
}

// jsdom does not implement scrollIntoView; the P-F6 Event Log auto-follow
// effect calls it for any LIVE run, so every test in this file (not just the
// scroll-bounding describe block below) needs it stubbed or a live-run
// render throws.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  mockRunId = 'run-1';
  mockLogEntries = [];
  mockLogLoading = false;
  mockLogIsError = false;
  mockBuildMissions = [];
  mockBuildLoading = false;
  mockBuildIsError = false;
  mockReports = [];
  mockEvents = [];
  mockHistoryEvents = [];
  mockHistoryTruncated = false;
  mockHistoryLoading = false;
  mockHistoryIsError = false;
  mockSseConnectionError = false;
  mockMissionDetail = null;
  mockMissionDetailIsError = false;
  mockUseMissionDetail.mockClear();
  mockUseRunEvents.mockClear();
  mockRefetchEvents.mockClear();
  mockUseAgentEventStream.mockClear();
  mockResumeBuildArtifact.mockClear();
  mockResetBuildArtifactResume.mockClear();
});

// ============================================================================
// TESTS
// ============================================================================

describe('RunDetailPage — history run (mission/sweep)', () => {
  it('renders the shell title, status/kind chips, and Details card fields', () => {
    mockLogEntries = [agentLogEntry({ costUsd: 0.05 })];

    render(<RunDetailPage />);

    expect(screen.getByTestId('layout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Scout — Discovered 3 new technology signals');
    const chips = within(screen.getByTestId('detail-chips'));
    expect(chips.getByText('Success')).toBeInTheDocument();
    expect(chips.getByText('Mission')).toBeInTheDocument();

    // Details card — scoped since AgentLog's own embedded card (Event Log
    // section, below) independently renders the same agent name/duration.
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Agent')).toBeInTheDocument();
    expect(details.getByText('scout')).toBeInTheDocument();
    expect(details.getByText('Kind')).toBeInTheDocument();
    expect(details.getByText('Started')).toBeInTheDocument();
    expect(
      details.getByText(format(new Date('2026-05-08T08:00:00.000Z'), "MMM d, yyyy 'at' h:mm a"))
    ).toBeInTheDocument();
    expect(details.getByText('Duration')).toBeInTheDocument();
    expect(details.getByText('4.5s')).toBeInTheDocument();
    expect(details.getByText('Tokens')).toBeInTheDocument();
    expect(details.getByText('2.0K')).toBeInTheDocument();
    // The fixture entry records an amount but no cost authority, so the row is
    // headed plainly "Cost" — see the ARUN-027 case below.
    expect(details.getByText('Cost')).toBeInTheDocument();
    expect(details.getByText('$0.05')).toBeInTheDocument();
  });

  it('ARUN-007: renders the Cost row as Unavailable (never hidden, never estimated) when the run carries no costUsd', () => {
    mockLogEntries = [agentLogEntry({ costUsd: undefined })];
    render(<RunDetailPage />);
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Cost')).toBeInTheDocument();
    expect(details.getByTestId('run-detail-cost')).toHaveTextContent('Unavailable');
  });

  it('labels receipt-derived chat cost as a rate-card estimate, never generic settled cost', () => {
    mockLogEntries = [agentLogEntry({ costUsd: 0.05, costState: 'estimated' })];
    render(<RunDetailPage />);
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Estimated cost')).toBeInTheDocument();
    const cost = details.getByTestId('run-detail-cost');
    expect(cost).toHaveTextContent('$0.05 est.');
    expect(cost).not.toHaveTextContent('settled');
    // The rate-card provenance moved to the tooltip when the three run surfaces
    // adopted one shared wording rule; it is still stated, not dropped.
    expect(cost).toHaveAttribute('title', expect.stringContaining('rate card'));
    expect(details.queryByText(/^Cost$/)).not.toBeInTheDocument();
  });

  it('ARUN-027: an amount with no recorded authority is not labelled settled', () => {
    // A pre-AI-029 AgentRun persisted `costUsd` with no `costState`. The old
    // per-surface ladder rendered it under a "Settled cost" heading.
    mockLogEntries = [agentLogEntry({ costUsd: 0.05, costState: undefined })];
    render(<RunDetailPage />);
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Cost')).toBeInTheDocument();
    expect(details.queryByText('Settled cost')).not.toBeInTheDocument();
    const cost = details.getByTestId('run-detail-cost');
    expect(cost).toHaveTextContent('$0.05');
    expect(cost).not.toHaveTextContent('settled');
  });

  it('ARUN-027: a lost-receipt run reads differently from an unpriceable one', () => {
    mockLogEntries = [agentLogEntry({ costUsd: undefined, costUnavailableReason: 'accounting-incomplete' })];
    const { unmount } = render(<RunDetailPage />);
    expect(within(screen.getByTestId('run-details-card')).getByTestId('run-detail-cost')).toHaveTextContent(
      'Incomplete'
    );
    unmount();

    mockLogEntries = [agentLogEntry({ costUsd: undefined, costUnavailableReason: 'unknown-pricing' })];
    render(<RunDetailPage />);
    expect(within(screen.getByTestId('run-details-card')).getByTestId('run-detail-cost')).toHaveTextContent('Unpriced');
  });

  it('renders the Quality Checks card with the passed/total/score summary and per-check icons', () => {
    mockLogEntries = [
      agentLogEntry({
        qualityReport: {
          evaluatedAt: '2026-05-08T08:00:00.000Z',
          overallScore: 0.5,
          verdict: 'REVISE',
          checks: [
            { name: 'has-summary', pass: true, critical: true, detail: 'summary present' },
            { name: 'has-citations', pass: false, critical: false, detail: 'needs work' },
          ],
        },
      }),
    ];

    render(<RunDetailPage />);

    expect(screen.getByText('Quality Checks')).toBeInTheDocument();
    expect(screen.getByText('1/2 passed · 50%')).toBeInTheDocument();
    expect(screen.getByText('has-summary')).toBeInTheDocument();
    expect(screen.getByText('has-citations')).toBeInTheDocument();
    expect(screen.getByText('needs work')).toBeInTheDocument();
    expect(screen.getByText('L1 REVISE')).toBeInTheDocument();
  });

  it('omits the Quality Checks card when the run has no quality report', () => {
    mockLogEntries = [agentLogEntry()];
    render(<RunDetailPage />);
    expect(screen.queryByText('Quality Checks')).not.toBeInTheDocument();
  });

  it('renders the destructive Errors banner for a failed run, and falls back to the AgentLog summary + a truthful "not recorded" note (no missionId/sweepId → unresolvable scope)', () => {
    mockLogEntries = [
      agentLogEntry({
        id: 'run-2',
        agentName: 'evaluator',
        action: 'Scored 5 inbound signals',
        status: 'failure',
        errors: ['Rate limit exceeded'],
      }),
    ];
    mockRunId = 'run-2';

    render(<RunDetailPage />);

    expect(within(screen.getByTestId('detail-chips')).getByText('Failed')).toBeInTheDocument();
    // Dedicated destructive-tint Errors banner (main content, above the log).
    const banner = within(screen.getByTestId('run-errors-banner'));
    expect(banner.getByText('Errors')).toBeInTheDocument();
    expect(banner.getByText('Rate limit exceeded')).toBeInTheDocument();
    // This entry carries neither missionId nor sweepId — it never had a
    // scope to fetch step history for at all (not "expired"). The Event Log
    // card falls back to AgentLog's summary entry with a note that says so
    // truthfully, and must NOT fetch with a bogus scope.
    expect(screen.getByTestId('agent-log-entry-run-2')).toBeInTheDocument();
    expect(screen.getByTestId('run-history-no-scope-note')).toHaveTextContent(
      "Step-level history isn't recorded for this run type."
    );
    expect(screen.queryByTestId('run-history-expired-note')).not.toBeInTheDocument();
    expect(mockUseRunEvents).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to the AgentLog summary + a "may have expired" note when the scope resolves but no history comes back', () => {
    mockLogEntries = [
      agentLogEntry({
        id: 'run-3',
        agentName: 'evaluator',
        action: 'Scored 5 inbound signals',
        status: 'success',
        missionId: 'mission-3',
      }),
    ];
    mockRunId = 'run-3';
    // mockHistoryEvents stays empty (default) — a resolvable scope with no
    // matching (or TTL-expired) history.

    render(<RunDetailPage />);

    expect(screen.getByTestId('agent-log-entry-run-3')).toBeInTheDocument();
    expect(screen.getByTestId('run-history-expired-note')).toHaveTextContent(
      'No step history found — it may have expired.'
    );
    expect(screen.queryByTestId('run-history-no-scope-note')).not.toBeInTheDocument();
    expect(mockUseRunEvents).toHaveBeenLastCalledWith('mission-3');
  });

  it('omits the Errors banner when the run has no errors', () => {
    mockLogEntries = [agentLogEntry()];
    render(<RunDetailPage />);
    expect(screen.queryByText('Errors')).not.toBeInTheDocument();
  });

  it('classifies an entry carrying sweepId as kind "Sweep"', () => {
    mockLogEntries = [agentLogEntry({ sweepId: 'sweep-9' })];
    render(<RunDetailPage />);
    expect(within(screen.getByTestId('detail-chips')).getByText('Sweep')).toBeInTheDocument();
  });

  it('renders explicit chat provider/model metadata and only the bounded tool summary', () => {
    mockRunId = 'run-chat-gemini';
    mockLogEntries = [
      agentLogEntry({
        id: 'run-chat-gemini',
        agentName: 'chat',
        action: 'Research quantum sensing',
        kind: 'chat',
        provider: 'gemini',
        model: 'gemini-3.5-pro',
        toolSummary: [
          { name: 'searchEntities', status: 'success', durationMs: 25 },
          { name: 'createRelation', status: 'failure' },
        ],
        toolSummaryTruncated: true,
      }),
    ];

    render(<RunDetailPage />);

    expect(within(screen.getByTestId('detail-chips')).getByText('Chat')).toBeInTheDocument();
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Provider')).toBeInTheDocument();
    expect(details.getByText('Gemini')).toBeInTheDocument();
    expect(details.getByText('Model')).toBeInTheDocument();
    expect(details.getByText('gemini-3.5-pro')).toBeInTheDocument();

    const summary = within(screen.getByTestId('chat-tool-summary'));
    expect(summary.getByText('searchEntities')).toBeInTheDocument();
    expect(summary.getByText('createRelation')).toBeInTheDocument();
    expect(summary.getByTestId('icon-CheckCircle2')).toBeInTheDocument();
    expect(summary.getByTestId('icon-XCircle')).toBeInTheDocument();
    expect(summary.getByText('25ms')).toBeInTheDocument();
    expect(screen.getByTestId('chat-tool-summary-truncated')).toBeInTheDocument();
    expect(screen.queryByText(/CONFIRM SPEND/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-log-entry-run-chat-gemini')).not.toBeInTheDocument();
    expect(mockUseRunEvents).toHaveBeenLastCalledWith(undefined);
  });

  it('infers a legacy Claude chat and truthfully reports that no bounded summary exists', () => {
    mockRunId = 'run-chat-legacy';
    mockLogEntries = [
      agentLogEntry({
        id: 'run-chat-legacy',
        agentName: 'chat',
        action: 'Legacy chat turn',
        model: 'claude-opus-4-8',
      }),
    ];

    render(<RunDetailPage />);

    expect(within(screen.getByTestId('detail-chips')).getByText('Chat')).toBeInTheDocument();
    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Claude')).toBeInTheDocument();
    expect(details.getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(screen.getByTestId('chat-tool-summary-empty')).toHaveTextContent(
      'No bounded tool summary was recorded for this chat turn.'
    );
    expect(screen.queryByTestId('run-history-no-scope-note')).not.toBeInTheDocument();
  });
});

// ============================================================================
// ARUN-007 — one coherent provider/model/token/cost/duration panel for EVERY
// run kind. Persisted values render; missing values say "Unavailable" — the
// panel never hides a row and never estimates.
// ============================================================================

describe('RunDetailPage — ARUN-007 telemetry panel truth', () => {
  it('shows the persisted model for a research mission run, with Provider honestly Unavailable', () => {
    mockLogEntries = [
      agentLogEntry({
        missionId: 'mission-7',
        model: 'claude-sonnet-5',
        costUsd: 1.25,
      }),
    ];

    render(<RunDetailPage />);

    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByText('Model')).toBeInTheDocument();
    expect(details.getByText('claude-sonnet-5')).toBeInTheDocument();
    expect(details.getByText('Provider')).toBeInTheDocument();
    expect(details.getByTestId('run-detail-provider')).toHaveTextContent('Unavailable');
    expect(details.getByTestId('run-detail-cost')).toHaveTextContent('$1.25');
  });

  it('shows Model as Unavailable for a mission run that persisted no model', () => {
    mockLogEntries = [agentLogEntry({ missionId: 'mission-8', model: undefined })];

    render(<RunDetailPage />);

    expect(within(screen.getByTestId('run-details-card')).getByTestId('run-detail-model')).toHaveTextContent(
      'Unavailable'
    );
  });

  it('shows the distinct persisted session models for a build run', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [
      buildMission({
        tokenUsage: { input: 5000, output: 3000 },
        buildCostAccounting: {
          settledActualUsd: 3,
          estimatedUsd: 1.2,
          activeReservedUsd: 0,
          unsettledMaximumUsd: 0,
          trackedSpendUsd: 4.2,
          maximumExposureUsd: 4.2,
          unavailableSessionCount: 0,
          invalidSessionIndexes: [],
          observedAt: '2026-07-23T10:00:00.000Z',
        },
        sessions: [
          { index: 0, objective: 'plan', model: 'claude-sonnet-5', startedAt: '2026-05-09T09:00:00.000Z' },
          { index: 1, objective: 'build', model: 'claude-sonnet-5', startedAt: '2026-05-09T09:01:00.000Z' },
          { index: 2, objective: 'qa', model: 'claude-opus-4-8', startedAt: '2026-05-09T09:03:00.000Z' },
        ],
      } as Partial<Mission>),
    ];

    render(<RunDetailPage />);

    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByTestId('run-detail-model')).toHaveTextContent('claude-sonnet-5, claude-opus-4-8');
    expect(details.getByText('8.0K')).toBeInTheDocument();
    expect(details.getByText('Settled + estimated cost')).toBeInTheDocument();
    const buildCost = details.getByTestId('run-detail-cost');
    expect(buildCost).toHaveTextContent('$4.20 settled + est.');
    expect(buildCost).toHaveAttribute('title', expect.stringContaining('part estimated'));
  });

  it('renders Tokens and Duration as Unavailable for a failed build with no persisted usage or completedAt', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [
      buildMission({ status: 'failed', completedAt: undefined, tokenUsage: undefined, costUsd: undefined }),
    ];

    render(<RunDetailPage />);

    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByTestId('run-detail-tokens')).toHaveTextContent('Unavailable');
    expect(details.getByTestId('run-detail-duration')).toHaveTextContent('Unavailable');
    expect(details.getByTestId('run-detail-cost')).toHaveTextContent('Unavailable');
    expect(details.getByTestId('run-detail-model')).toHaveTextContent('Unavailable');
  });

  it('says Unavailable (not "Not recorded") for a chat run missing provider/model', () => {
    mockRunId = 'run-chat-bare';
    mockLogEntries = [
      agentLogEntry({
        id: 'run-chat-bare',
        agentName: 'chat',
        action: 'Bare chat turn',
      }),
    ];

    render(<RunDetailPage />);

    const details = within(screen.getByTestId('run-details-card'));
    expect(details.getByTestId('run-detail-provider')).toHaveTextContent('Unavailable');
    expect(details.getByTestId('run-detail-model')).toHaveTextContent('Unavailable');
    expect(details.queryByText('Not recorded')).not.toBeInTheDocument();
  });
});

// ============================================================================
// ARUN-016 — the Event Log collapses runs of adjacent Thinking heartbeats into
// one row (count + time range) with an expand path to the raw immutable events.
// ============================================================================

describe('RunDetailPage — ARUN-016 thinking-event collapse', () => {
  const historyEntryWithScope = () =>
    agentLogEntry({ id: 'run-16', agentName: 'creator', action: 'Long research mission', missionId: 'mission-16' });

  const thinkingEvent = (i: number): AgentEvent =>
    agentEvent({
      id: `think-${i}`,
      type: 'agent.thinking',
      timestamp: new Date(Date.UTC(2026, 4, 9, 9, 0, i * 30)).toISOString(),
      sequence: 10 + i,
      missionId: 'mission-16',
    });

  const toolEvent = (id: string, sequence: number): AgentEvent =>
    agentEvent({
      id,
      type: 'agent.tool_call',
      timestamp: '2026-05-09T09:10:00.000Z',
      sequence,
      missionId: 'mission-16',
      data: { toolName: 'searchPapers' },
    });

  beforeEach(() => {
    mockRunId = 'run-16';
    mockLogEntries = [historyEntryWithScope()];
  });

  it('collapses adjacent Thinking heartbeats into one row with count and time range, keeping decisive events visible', () => {
    mockHistoryEvents = [
      agentEvent({ id: 'start', type: 'agent.started', sequence: 1, missionId: 'mission-16', data: { prompt: 'Go' } }),
      ...Array.from({ length: 5 }, (_, i) => thinkingEvent(i)),
      toolEvent('call-1', 40),
    ];

    render(<RunDetailPage />);

    const group = screen.getByTestId('run-thinking-group');
    expect(group).toHaveTextContent('Thinking… ×5');
    // Time range: first and last heartbeat timestamps, not a single instant.
    expect(group).toHaveTextContent(format(new Date(Date.UTC(2026, 4, 9, 9, 0, 0)), 'h:mm:ss a'));
    expect(group).toHaveTextContent(format(new Date(Date.UTC(2026, 4, 9, 9, 0, 120)), 'h:mm:ss a'));
    // The five raw rows are NOT rendered while collapsed…
    expect(screen.queryAllByText('Thinking…')).toHaveLength(0);
    // …and the decisive events still render as plain rows.
    expect(screen.getByText('Called tool: searchPapers')).toBeInTheDocument();
  });

  it('expands a collapsed group to the raw immutable events and collapses it back', () => {
    mockHistoryEvents = Array.from({ length: 4 }, (_, i) => thinkingEvent(i));

    render(<RunDetailPage />);

    fireEvent.click(screen.getByTestId('run-thinking-group-toggle'));
    expect(screen.getAllByText('Thinking…')).toHaveLength(4);

    fireEvent.click(screen.getByTestId('run-thinking-group-toggle'));
    expect(screen.queryAllByText('Thinking…')).toHaveLength(0);
  });

  it('keeps a lone Thinking event as a plain row (no group chrome)', () => {
    mockHistoryEvents = [thinkingEvent(0), toolEvent('call-1', 40)];

    render(<RunDetailPage />);

    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    expect(screen.queryByTestId('run-thinking-group')).not.toBeInTheDocument();
  });

  it('bounds rendering on a large real-shaped run: 300 heartbeats render as one group row, not 300 rows', () => {
    mockHistoryEvents = [
      agentEvent({ id: 'start', type: 'agent.started', sequence: 1, missionId: 'mission-16', data: { prompt: 'Go' } }),
      ...Array.from({ length: 300 }, (_, i) => thinkingEvent(i)),
      toolEvent('call-1', 900),
    ];

    render(<RunDetailPage />);

    const tail = screen.getByTestId('run-event-tail');
    // 1 started + 1 collapsed group + 1 tool call — bounded, not 302 rows.
    expect(tail.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('run-thinking-group')).toHaveTextContent('Thinking… ×300');
  });
});

describe('RunDetailPage — build missions', () => {
  it('resolves a completed build mission via missionToLogEntry, reusing AgentLog when its history is empty', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission()];

    render(<RunDetailPage />);

    const chips = within(screen.getByTestId('detail-chips'));
    expect(chips.getByText('Success')).toBeInTheDocument();
    expect(chips.getByText('Build')).toBeInTheDocument();
    expect(screen.getByTestId('agent-log-entry-build-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-history-expired-note')).toBeInTheDocument();
    // Scoped to the log entry: since AUDIT-006 mounted BuildMissionCard, the
    // mission title legitimately appears in the governance card's header too, so
    // a page-wide getByText is now ambiguous. This test is about AgentLog reuse.
    expect(
      within(screen.getByTestId('agent-log-entry-build-1')).getByText('Prototype: internal knowledge search')
    ).toBeInTheDocument();
  });

  it('renders a running build mission as live, with the Event Log Live badge and no Quality Checks card', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    mockRunId = 'build-2';
    mockBuildMissions = [
      buildMission({ id: 'build-2', status: 'running', createdAt: '2026-05-09T09:00:00.000Z', completedAt: undefined }),
    ];

    render(<RunDetailPage />);

    // Both the top status chip and the Event Log header render a "Live" pill.
    expect(screen.getAllByText('Live').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('run-live-badge')).toBeInTheDocument();
    expect(screen.queryByText('Quality Checks')).not.toBeInTheDocument();
    // No SSE events buffered yet for this run — the tail renders its empty state.
    expect(screen.getByTestId('run-event-tail-empty')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('live-tails buffered SSE events for an in-flight run scoped to its id', () => {
    mockRunId = 'build-3';
    mockBuildMissions = [buildMission({ id: 'build-3', status: 'running', completedAt: undefined })];
    mockEvents = [
      agentEvent({ id: 'e1', missionId: 'build-3', type: 'agent.started', data: { prompt: 'Build it' } }),
      agentEvent({
        id: 'e2',
        missionId: 'build-3',
        type: 'agent.tool_call',
        timestamp: '2026-05-09T09:00:05.000Z',
        data: { toolName: 'writeFile' },
      }),
      // A different run's event must not leak into this run's tail.
      agentEvent({ id: 'e3', missionId: 'unrelated', type: 'agent.started' }),
    ];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-tail')).toBeInTheDocument();
    expect(screen.getByText('Started — Build it')).toBeInTheDocument();
    expect(screen.getByText('Called tool: writeFile')).toBeInTheDocument();
  });
});

// ============================================================================
// STEP HISTORY (Task 22 follow-up) — persisted events seed the Event Log:
// finished runs render the full step history; in-flight runs seed + live-tail.
// ============================================================================

describe('RunDetailPage — persisted step history', () => {
  it('renders the full step history for a completed failed run instead of the summary entry', () => {
    // Events are keyed by the MISSION id, not the AgentRun doc id — this
    // fixture keeps them distinct to pin the runEventScopeId mapping.
    mockRunId = 'run-2';
    mockLogEntries = [
      agentLogEntry({
        id: 'run-2',
        agentName: 'evaluator',
        action: 'Scored 5 inbound signals',
        status: 'failure',
        missionId: 'mission-9',
        errors: ['Rate limit exceeded'],
      }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-9', sequence: 10, type: 'agent.started', data: { prompt: 'Score' } }),
      agentEvent({
        id: 'h2',
        missionId: 'mission-9',
        sequence: 20,
        type: 'agent.tool_call',
        data: { toolName: 'scoreSignal' },
      }),
      agentEvent({ id: 'h3', missionId: 'mission-9', sequence: 30, type: 'agent.error', data: { error: 'boom' } }),
    ];

    render(<RunDetailPage />);

    // History fetched by the MISSION id the events are keyed by, not the
    // AgentRun doc id.
    expect(mockUseRunEvents).toHaveBeenLastCalledWith('mission-9');
    // Full step list renders...
    const tail = within(screen.getByTestId('run-event-tail'));
    expect(tail.getByText('Started — Score')).toBeInTheDocument();
    expect(tail.getByText('Called tool: scoreSignal')).toBeInTheDocument();
    expect(tail.getByText('Error: boom')).toBeInTheDocument();
    // ...REPLACING the single mission-summary entry and its expired note.
    expect(screen.queryByTestId('agent-log-entry-run-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-history-expired-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-history-no-scope-note')).not.toBeInTheDocument();
  });

  it('renders a "partial step history" note alongside the event list when the server-side query was truncated', () => {
    mockRunId = 'run-4';
    mockLogEntries = [
      agentLogEntry({
        id: 'run-4',
        agentName: 'evaluator',
        action: 'Scored many inbound signals',
        status: 'success',
        missionId: 'mission-4',
      }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-4', sequence: 10, type: 'agent.started', data: { prompt: 'Score' } }),
    ];
    mockHistoryTruncated = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-tail')).toBeInTheDocument();
    expect(screen.getByTestId('run-history-truncated-note')).toHaveTextContent(
      'Showing a partial step history (run exceeded the 500-event window)'
    );
  });

  it('omits the "partial step history" note when the server-side query was not truncated', () => {
    mockRunId = 'run-2';
    mockLogEntries = [
      agentLogEntry({ id: 'run-2', agentName: 'evaluator', action: 'Scored signals', missionId: 'mission-9' }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-9', sequence: 10, type: 'agent.started', data: {} }),
    ];
    mockHistoryTruncated = false;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-tail')).toBeInTheDocument();
    expect(screen.queryByTestId('run-history-truncated-note')).not.toBeInTheDocument();
  });

  it('seeds an in-flight run with history and appends live SSE events, deduped by event id', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    mockRunId = 'build-live';
    mockBuildMissions = [
      buildMission({
        id: 'build-live',
        status: 'running',
        createdAt: '2026-05-09T09:00:00.000Z',
        completedAt: undefined,
      }),
    ];
    const sharedEvent = agentEvent({
      id: 'h2',
      missionId: 'build-live',
      sequence: 20,
      type: 'agent.thinking',
      data: {},
    });
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'build-live', sequence: 10, type: 'agent.started', data: { prompt: 'Go' } }),
      sharedEvent,
    ];
    mockEvents = [
      // Same event delivered by BOTH the history fetch and the SSE tail —
      // must render exactly once.
      sharedEvent,
      agentEvent({
        id: 'l1',
        missionId: 'build-live',
        sequence: 30,
        type: 'agent.tool_call',
        data: { toolName: 'writeFile' },
      }),
    ];

    render(<RunDetailPage />);

    const tail = within(screen.getByTestId('run-event-tail'));
    expect(tail.getByText('Started — Go')).toBeInTheDocument();
    expect(tail.getAllByText('Thinking…')).toHaveLength(1);
    expect(tail.getByText('Called tool: writeFile')).toBeInTheDocument();
    expect(screen.getByTestId('run-live-badge')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('shows a loading skeleton — not the expired note — while the history query is in flight', () => {
    mockLogEntries = [agentLogEntry()];
    mockHistoryLoading = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-log-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('run-history-expired-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-log-entry-run-1')).not.toBeInTheDocument();
  });

  it('resolves a run known ONLY through persisted history events (no listing, no build doc)', () => {
    mockRunId = 'mission-history-only';
    mockHistoryEvents = [
      agentEvent({
        id: 'h1',
        missionId: 'mission-history-only',
        agentType: 'scout',
        sequence: 10,
        type: 'agent.started',
        data: { prompt: 'Investigate X' },
      }),
      agentEvent({
        id: 'h2',
        missionId: 'mission-history-only',
        sequence: 20,
        type: 'agent.completed',
        timestamp: '2026-05-09T09:01:00.000Z',
        data: {},
      }),
    ];

    render(<RunDetailPage />);

    expect(within(screen.getByTestId('detail-chips')).getByText('Success')).toBeInTheDocument();
    const tail = within(screen.getByTestId('run-event-tail'));
    expect(tail.getByText('Started — Investigate X')).toBeInTheDocument();
    expect(tail.getByText('Completed successfully')).toBeInTheDocument();
  });
});

// ============================================================================
// EVENT LOG SCROLL BOUNDING (P-F6) — the log list gets a fixed viewport
// height with an internal scrollbar (a long run's 100+ events must not push
// the page forever); live runs auto-follow new events unless the user has
// scrolled up, completed runs never auto-scroll (start at the top).
// ============================================================================

describe('RunDetailPage — Event Log scroll bounding (P-F6)', () => {
  let scrollIntoViewMock: jest.Mock;

  beforeEach(() => {
    scrollIntoViewMock = jest.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it('bounds the event log to a fixed max height with an internal scrollbar', () => {
    mockLogEntries = [
      agentLogEntry({ id: 'run-2', status: 'failure', missionId: 'mission-9', errors: ['Rate limit exceeded'] }),
    ];
    mockRunId = 'run-2';
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-9', sequence: 10, type: 'agent.started', data: { prompt: 'Score' } }),
    ];

    render(<RunDetailPage />);

    const scroller = screen.getByTestId('run-event-log-scroll');
    expect(scroller.className).toContain('max-h-[65vh]');
    expect(scroller.className).toContain('overflow-y-auto');
  });

  it('does not auto-scroll a completed run — it starts at the top, in reading order', () => {
    mockLogEntries = [
      agentLogEntry({ id: 'run-2', status: 'failure', missionId: 'mission-9', errors: ['Rate limit exceeded'] }),
    ];
    mockRunId = 'run-2';
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-9', sequence: 10, type: 'agent.started', data: { prompt: 'Score' } }),
      agentEvent({ id: 'h2', missionId: 'mission-9', sequence: 20, type: 'agent.error', data: { error: 'boom' } }),
    ];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-tail')).toBeInTheDocument();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('auto-follows a live run — settles the first render instantly, then animates on a genuinely new appended event', () => {
    mockRunId = 'build-live';
    mockBuildMissions = [
      buildMission({
        id: 'build-live',
        status: 'running',
        createdAt: '2026-05-09T09:00:00.000Z',
        completedAt: undefined,
      }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'build-live', sequence: 10, type: 'agent.started', data: { prompt: 'Go' } }),
    ];
    mockEvents = [];

    const { rerender } = render(<RunDetailPage />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'auto' });

    // A new SSE event lands while the page stays mounted.
    mockEvents = [
      agentEvent({
        id: 'l1',
        missionId: 'build-live',
        sequence: 20,
        type: 'agent.tool_call',
        data: { toolName: 'writeFile' },
      }),
    ];
    rerender(<RunDetailPage />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'smooth' });
  });

  // --------------------------------------------------------------------------
  // Anti-yank guard — `isNearBottomRef` (page.tsx ~line 197). A user who has
  // scrolled up to read earlier steps must not be yanked back to the bottom
  // by a newly appended live event; a user who stayed near the bottom keeps
  // auto-following. Stubs scroll geometry directly on the scroller element
  // (jsdom doesn't lay out real scroll metrics) and drives `handleScroll` via
  // a real `scroll` event before appending a new SSE event through rerender.
  // --------------------------------------------------------------------------

  function stubScrollGeometry(scroller: HTMLElement, scrollTop: number) {
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    let scrollTopValue = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = v;
      },
      configurable: true,
    });
    scroller.scrollTop = scrollTop;
  }

  it('does not yank a scrolled-up user back to the bottom when a new live event appends', () => {
    mockRunId = 'build-live';
    mockBuildMissions = [
      buildMission({
        id: 'build-live',
        status: 'running',
        createdAt: '2026-05-09T09:00:00.000Z',
        completedAt: undefined,
      }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'build-live', sequence: 10, type: 'agent.started', data: { prompt: 'Go' } }),
    ];
    mockEvents = [];

    const { rerender } = render(<RunDetailPage />);

    // Mount-time instant settle.
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    const scroller = screen.getByTestId('run-event-log-scroll');
    // Far from bottom: 5000 - 1000 - 600 = 3400px, well past the 100px threshold.
    stubScrollGeometry(scroller, 1000);
    fireEvent.scroll(scroller);

    // A new SSE event lands while the user is scrolled up reading history.
    mockEvents = [
      agentEvent({
        id: 'l1',
        missionId: 'build-live',
        sequence: 20,
        type: 'agent.tool_call',
        data: { toolName: 'writeFile' },
      }),
    ];
    rerender(<RunDetailPage />);

    // Still just the one mount-time call — the guard blocked the re-scroll.
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it('keeps following to the bottom when a new live event appends and the user is already near the bottom', () => {
    mockRunId = 'build-live';
    mockBuildMissions = [
      buildMission({
        id: 'build-live',
        status: 'running',
        createdAt: '2026-05-09T09:00:00.000Z',
        completedAt: undefined,
      }),
    ];
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'build-live', sequence: 10, type: 'agent.started', data: { prompt: 'Go' } }),
    ];
    mockEvents = [];

    const { rerender } = render(<RunDetailPage />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    const scroller = screen.getByTestId('run-event-log-scroll');
    // Near bottom: 5000 - 4350 - 600 = 50px, inside the 100px threshold.
    stubScrollGeometry(scroller, 4350);
    fireEvent.scroll(scroller);

    mockEvents = [
      agentEvent({
        id: 'l1',
        missionId: 'build-live',
        sequence: 20,
        type: 'agent.tool_call',
        data: { toolName: 'writeFile' },
      }),
    ];
    rerender(<RunDetailPage />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'smooth' });
  });
});

// ============================================================================
// LIVE STREAM GATING (P-F9) — a completed run has no more events to stream;
// `useAgentEventStream` must only be left enabled while the run is in-flight
// or not yet determinable from the already-fetched history/build sources.
// ============================================================================

describe('RunDetailPage — live stream gating (P-F9)', () => {
  it('disables the SSE stream for a run found in the history-tab entries (history only ever holds completed runs)', () => {
    mockLogEntries = [agentLogEntry()];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(false);
  });

  it('disables the SSE stream for a completed build mission', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission({ status: 'completed' })];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(false);
  });

  it('disables the SSE stream for a failed build mission', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission({ status: 'failed', completedAt: undefined })];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(false);
  });

  it('keeps the SSE stream enabled for an in-flight (running) build mission', () => {
    mockRunId = 'build-2';
    mockBuildMissions = [buildMission({ id: 'build-2', status: 'running', completedAt: undefined })];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(true);
  });

  it('keeps the SSE stream enabled for a pending build mission', () => {
    mockRunId = 'build-2';
    mockBuildMissions = [buildMission({ id: 'build-2', status: 'pending', completedAt: undefined })];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(true);
  });

  it('keeps the SSE stream enabled while the run is not yet found anywhere (not yet determinable — e.g. an SSE-only run, or data still loading)', () => {
    mockRunId = 'mission-history-only';
    mockHistoryEvents = [
      agentEvent({ id: 'h1', missionId: 'mission-history-only', sequence: 10, type: 'agent.started', data: {} }),
    ];
    render(<RunDetailPage />);
    expect(mockUseAgentEventStream).toHaveBeenLastCalledWith(true);
  });
});

// ============================================================================
// OUTPUT CARD (P-F7) — "did this run produce something?" A published Report
// (matched by missionId, mirroring AgentLog.tsx's lookup) and/or a build
// artifact (the run's own /artifacts/[id] page, mission.id === run.id) each
// render as a linked row; the card is entirely absent when neither exists.
// ============================================================================

describe('RunDetailPage — Output card (P-F7)', () => {
  it('renders a linked report row when the run has a published report matching its missionId', () => {
    mockLogEntries = [agentLogEntry({ id: 'run-3', status: 'success', missionId: 'mission-3' })];
    mockRunId = 'run-3';
    mockReports = [report({ id: 'report-9', title: 'Q3 Technology Landscape', missionId: 'mission-3' })];

    render(<RunDetailPage />);

    const card = within(screen.getByTestId('run-output-card'));
    expect(card.getByText('Q3 Technology Landscape')).toBeInTheDocument();
    const link = card.getByTestId('run-output-link-report-report-9');
    expect(link).toHaveAttribute('href', '/reports/report-9');
    expect(card.getByText('Report')).toBeInTheDocument();
  });

  it('renders a linked artifact row for a build mission that produced an output, pointing at /artifacts/[id]', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [
      buildMission({
        id: 'build-1',
        artifactKind: 'solution',
        artifact: { prototypeId: 'proto-9', publishedAt: '2026-05-09T09:05:00.000Z' },
      }),
    ];

    render(<RunDetailPage />);

    const card = within(screen.getByTestId('run-output-card'));
    expect(card.getByText('Prototype: internal knowledge search')).toBeInTheDocument();
    const link = card.getByTestId('run-output-link-artifact-build-1');
    expect(link).toHaveAttribute('href', '/artifacts/build-1');
    expect(card.getByText('App')).toBeInTheDocument();
  });

  it('lists both a report and an artifact when a run somehow carries both', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [
      buildMission({
        id: 'build-1',
        artifactKind: 'solution',
        artifact: { prototypeId: 'proto-9', publishedAt: '2026-05-09T09:05:00.000Z' },
      }),
    ];
    mockReports = [report({ id: 'report-9', title: 'Q3 Technology Landscape', missionId: 'build-1' })];

    render(<RunDetailPage />);

    const card = within(screen.getByTestId('run-output-card'));
    expect(card.getByTestId('run-output-link-report-report-9')).toHaveAttribute('href', '/reports/report-9');
    expect(card.getByTestId('run-output-link-artifact-build-1')).toHaveAttribute('href', '/artifacts/build-1');
  });

  it('omits the Output card entirely when the run produced neither a report nor an artifact', () => {
    mockLogEntries = [agentLogEntry()];

    render(<RunDetailPage />);

    expect(screen.queryByTestId('run-output-card')).not.toBeInTheDocument();
  });

  it('omits the Output card for a build mission with no artifact and no findings', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission({ id: 'build-1' })];

    render(<RunDetailPage />);

    expect(screen.queryByTestId('run-output-card')).not.toBeInTheDocument();
  });
});

describe('RunDetailPage — not found', () => {
  it('renders the not-found state for an unknown id once loading has settled', () => {
    mockRunId = 'does-not-exist';

    render(<RunDetailPage />);

    expect(screen.getByRole('heading', { name: 'Run Not Found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to runs/i })).toHaveAttribute('href', '/agents/runs');
  });

  it('does not flash the not-found state while the log/build queries are still loading', () => {
    mockRunId = 'does-not-exist';
    mockLogLoading = true;

    render(<RunDetailPage />);

    expect(screen.queryByRole('heading', { name: 'Run Not Found' })).not.toBeInTheDocument();
  });

  it('does not flash the not-found state while the step-history query is still loading', () => {
    mockRunId = 'does-not-exist';
    mockHistoryLoading = true;

    render(<RunDetailPage />);

    expect(screen.queryByRole('heading', { name: 'Run Not Found' })).not.toBeInTheDocument();
  });
});

// ============================================================================
// SOURCE OUTAGE vs MISSING RUN (ARUN-012) — an unresolved run when a source
// FAILED is a temporary outage, not a deleted/absent run. It must offer a
// retry, never the dead-end "Run Not Found". A run that DOES resolve while a
// source failed is shown, flagged Partial (its data may be incomplete).
// ============================================================================

describe('RunDetailPage — source outage vs missing run (ARUN-012)', () => {
  it('renders "temporarily unavailable" with a retry — NOT "Run Not Found" — when a source errors and no run resolves', () => {
    mockRunId = 'does-not-exist';
    mockLogIsError = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-detail-unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /temporarily unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

    // A source outage must NOT masquerade as a deleted/absent run.
    expect(screen.queryByTestId('run-detail-not-found')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Run Not Found' })).not.toBeInTheDocument();
  });

  it('treats a failed build-source lookup as unavailable too (not not-found)', () => {
    mockRunId = 'does-not-exist';
    mockBuildIsError = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-detail-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Run Not Found' })).not.toBeInTheDocument();
  });

  it('still renders genuine "Run Not Found" when every source succeeded and none knew the id', () => {
    mockRunId = 'does-not-exist';
    // no error flags set — all sources healthy, just empty.

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-detail-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-unavailable')).not.toBeInTheDocument();
  });

  it('flags a resolved run Partial when its event-history source errored (data may be incomplete)', () => {
    mockLogEntries = [agentLogEntry()];
    mockHistoryIsError = true;

    render(<RunDetailPage />);

    // The run still resolves from the history entry...
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Scout — Discovered 3 new technology signals');
    // ...but a failed source means the view is incomplete — say so.
    expect(within(screen.getByTestId('detail-chips')).getByTestId('run-partial-pill')).toBeInTheDocument();
  });

  it('does not flag Partial when every source succeeded', () => {
    mockLogEntries = [agentLogEntry()];

    render(<RunDetailPage />);

    expect(screen.queryByTestId('run-partial-pill')).not.toBeInTheDocument();
  });
});

// ============================================================================
// SSE DEGRADATION + FALLBACK POLL (ARUN-013) — a live run whose update stream
// is down must SAY so (not silently freeze), and a bounded poll of the
// persisted step history must keep the log advancing until the stream
// reconnects.
// ============================================================================

describe('RunDetailPage — SSE degradation (ARUN-013)', () => {
  function runningBuild() {
    return buildMission({ id: 'build-2', status: 'running', completedAt: undefined });
  }

  it('shows a "reconnecting" badge alongside Live when the stream is degraded for an in-flight run', () => {
    mockRunId = 'build-2';
    mockBuildMissions = [runningBuild()];
    mockSseConnectionError = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-live-badge')).toBeInTheDocument();
    expect(screen.getByTestId('run-live-degraded-badge')).toBeInTheDocument();
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('shows Live but NO reconnecting badge while the stream is healthy', () => {
    mockRunId = 'build-2';
    mockBuildMissions = [runningBuild()];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-live-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('run-live-degraded-badge')).not.toBeInTheDocument();
  });

  it('does not show the reconnecting badge for a completed run even if the stream is degraded', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission()]; // completed
    mockSseConnectionError = true;

    render(<RunDetailPage />);

    expect(screen.queryByTestId('run-live-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-live-degraded-badge')).not.toBeInTheDocument();
  });

  it('polls the persisted step history while the stream is degraded, and stops once it recovers', () => {
    jest.useFakeTimers();
    try {
      mockRunId = 'build-2';
      mockBuildMissions = [runningBuild()];
      mockSseConnectionError = true;

      const { rerender } = render(<RunDetailPage />);
      mockRefetchEvents.mockClear();

      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS);
      });
      expect(mockRefetchEvents).toHaveBeenCalled();

      // Recovery — the stream reconnects; the fallback poll must stop.
      mockRefetchEvents.mockClear();
      mockSseConnectionError = false;
      rerender(<RunDetailPage />);
      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 3);
      });
      expect(mockRefetchEvents).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not poll the step history while the stream is healthy', () => {
    jest.useFakeTimers();
    try {
      mockRunId = 'build-2';
      mockBuildMissions = [runningBuild()];

      render(<RunDetailPage />);
      mockRefetchEvents.mockClear();

      act(() => {
        jest.advanceTimersByTime(SSE_FALLBACK_POLL_MS * 3);
      });
      expect(mockRefetchEvents).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// AUDIT-006 — the build-mission governance card is MOUNTED here.
//
// BuildMissionCard had zero production importers, yet the supervisor genuinely
// parks at `step.waitForEvent` on a budget or stall gate, and `useResolveGate`
// (imported only by that card) is the ONLY caller of the endpoint that emits
// `app/build-mission.gate.resolved`. So a gated build had no human resolver in
// the app: it sat for `gates.timeoutHours` (24h), auto-denied, and failed the
// run. These tests pin that the hole is closed.
describe('build mission governance card (AUDIT-006)', () => {
  it('renders the governance card for a build mission run', () => {
    mockRunId = 'build-1';
    mockBuildMissions = [buildMission({ buildState: 'session-running', status: 'running', completedAt: undefined })];
    render(<RunDetailPage />);
    expect(screen.getByText(/Building/i)).toBeInTheDocument();
  });

  it('surfaces a budget gate so a human can actually resolve it', async () => {
    mockRunId = 'build-1';
    mockBuildMissions = [
      buildMission({
        status: 'running',
        completedAt: undefined,
        buildState: 'awaiting-budget',
        costUsd: 25,
        budget: { capUsd: 25, warnThreshold: 0.8, topUps: [] },
        gates: [{ gate: 'budget', requestedAt: '2026-07-12T10:00:00.000Z' }],
      } as Partial<Mission>),
    ];
    render(<RunDetailPage />);

    // The state the supervisor is parked in is now visible...
    expect(screen.getByText(/Needs budget approval/i)).toBeInTheDocument();

    // ...and there is a control that resolves the gate. Before this mount, the
    // ONLY way to unblock the run was a hand-crafted POST.
    const approve = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approve);
    expect(mockResolveGate).toHaveBeenCalled();
  });

  it('does not render the governance card for a non-build run', () => {
    mockRunId = 'run-1';
    mockBuildMissions = [];
    render(<RunDetailPage />);
    expect(screen.queryByText(/Needs budget approval/i)).not.toBeInTheDocument();
  });
});

// ============================================================================
// ARUN-029 — Creator terminal truth on the run detail page.
//
// A Creator (kind 'mission') run resolves from its AgentRun row alone. Its
// Mission doc holds the durable failure reason, the canonical Report pointer
// and the mission-side accounting; none of it reached this page, so a failed
// Creator showed a red pill and nothing else, and a draft Creator that DID
// publish a report offered no way to reach it.
// ============================================================================

describe('ARUN-029 — Creator terminal outcome', () => {
  function creatorMission(overrides: Partial<Mission> = {}): Mission {
    return {
      id: 'mission-29',
      userId: 'test-user',
      prompt: 'Landscape report on agentic retrieval',
      agent: 'creator',
      kind: 'report',
      status: 'completed',
      progress: 100,
      entities: [],
      sources: [],
      slots: [],
      createdAt: '2026-07-29T09:00:00.000Z',
      completedAt: '2026-07-29T09:10:00.000Z',
      tokenUsage: { input: 700, output: 300 },
      costUsd: 0.5,
      ...overrides,
    } as Mission;
  }

  function creatorRun(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
    return agentLogEntry({
      id: 'run-29',
      agentName: 'creator',
      action: 'Mission: Landscape report on agentic retrieval',
      missionId: 'mission-29',
      status: 'success',
      tokenUsage: { input: 700, output: 300 },
      tokenUsageProvenance: 'provider-reported',
      costUsd: 0.5,
      costState: 'settled',
      ...overrides,
    });
  }

  beforeEach(() => {
    mockRunId = 'run-29';
  });

  it('shows a failed Creator’s durable reason and states that no report exists', () => {
    mockLogEntries = [creatorRun({ status: 'failure', costUsd: undefined, errors: ['run-side copy'] })];
    mockMissionDetail = creatorMission({
      status: 'failed',
      outcome: 'no-deliverable',
      failureCode: 'mcp-preflight-failed',
      errors: ['mcp-preflight-failed: internal MCP unreachable'],
      reportIds: [],
      costUsd: undefined,
    });

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-disposition')).toHaveTextContent('No deliverable');
    expect(screen.getByTestId('run-terminal-reason')).toHaveTextContent('preflight failed');
    expect(screen.getByTestId('run-terminal-report-none')).toBeInTheDocument();
    expect(screen.queryByTestId('run-terminal-report-link')).not.toBeInTheDocument();
  });

  it('says plainly that no reason was recorded rather than leaving the slot empty', () => {
    mockLogEntries = [creatorRun({ status: 'failure', costUsd: undefined })];
    mockMissionDetail = creatorMission({
      status: 'failed',
      outcome: 'no-deliverable',
      progressMessage: undefined,
      errors: [],
      reportIds: [],
      costUsd: undefined,
    });

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-terminal-reason-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('run-terminal-reason')).not.toBeInTheDocument();
  });

  it('exposes the canonical Report of a partial draft that failed after publishing', () => {
    mockLogEntries = [creatorRun({ status: 'failure', partial: true })];
    mockMissionDetail = creatorMission({
      status: 'failed',
      outcome: 'needs-review',
      partial: true,
      reportId: 'report-1',
      reportIds: ['report-1'],
      errors: ['SDK run failed after publishing'],
    });
    mockReports = [report({ missionId: 'mission-29' })];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-disposition')).toHaveTextContent('Needs review');
    expect(screen.getByTestId('run-disposition')).toHaveTextContent('mid-run checkpoint');
    expect(screen.getByTestId('run-terminal-report-link')).toHaveAttribute('href', '/reports/report-1');
    expect(screen.getByTestId('run-terminal-reason')).toHaveTextContent('SDK run failed after publishing');
  });

  it('does not claim "no report" when the recorded pointer cannot be resolved', () => {
    mockLogEntries = [creatorRun()];
    mockMissionDetail = creatorMission({ outcome: 'delivered', reportIds: ['report-missing'] });
    mockReports = [];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-terminal-report-unresolved')).toHaveTextContent('report-missing');
    expect(screen.queryByTestId('run-terminal-report-none')).not.toBeInTheDocument();
  });

  it('agrees on usage, cost, status and report identity for a delivered Creator run', () => {
    mockLogEntries = [creatorRun()];
    mockMissionDetail = creatorMission({ outcome: 'delivered', reportId: 'report-1', reportIds: ['report-1'] });
    mockReports = [report({ missionId: 'mission-29' })];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-disposition')).toHaveTextContent('Delivered');
    expect(screen.getByTestId('run-detail-tokens')).toHaveTextContent('1.0K');
    expect(screen.getByTestId('run-terminal-report-link')).toHaveAttribute('href', '/reports/report-1');
    expect(screen.queryByTestId('run-accounting-disagreement')).not.toBeInTheDocument();
  });

  it('surfaces a split between the run row and the mission record instead of picking one', () => {
    mockLogEntries = [creatorRun({ tokenUsage: { input: 106, output: 9 } })];
    mockMissionDetail = creatorMission({
      outcome: 'delivered',
      tokenUsage: { input: 100, output: 9 },
      reportId: 'report-1',
      reportIds: ['report-1'],
    });
    mockReports = [report({ missionId: 'mission-29' })];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-accounting-disagreement-tokens')).toHaveTextContent('run 115');
    expect(screen.getByTestId('run-accounting-disagreement-tokens')).toHaveTextContent('mission 109');
  });

  it('refuses to call a completed run "delivered" when the mission recorded no outcome', () => {
    mockLogEntries = [creatorRun()];
    mockMissionDetail = creatorMission({ outcome: undefined, reportIds: [] });

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-disposition')).toHaveTextContent('Ended without a recorded outcome');
  });

  it('says the report is unknown when the mission record could not be read', () => {
    mockLogEntries = [creatorRun()];
    mockMissionDetail = null;
    mockMissionDetailIsError = true;

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-terminal-report-unknown')).toHaveTextContent('could not be read');
    expect(screen.getByTestId('run-disposition')).toHaveTextContent('Outcome not recorded');
  });

  it('says so when the step log contradicts the recorded status', () => {
    mockLogEntries = [creatorRun()];
    mockMissionDetail = creatorMission({ outcome: 'delivered', reportIds: [] });
    mockHistoryEvents = [
      agentEvent({ id: 'evt-err', type: 'agent.error', missionId: 'mission-29', sequence: 2, data: {} }),
    ];

    render(<RunDetailPage />);

    expect(screen.getByTestId('run-event-trail-contradiction')).toHaveTextContent('records an error');
  });

  it('does not look up a mission for a chat run', () => {
    mockRunId = 'run-chat-29';
    mockLogEntries = [
      agentLogEntry({ id: 'run-chat-29', kind: 'chat', agentName: 'chat', action: 'Assistant chat turn' }),
    ];

    render(<RunDetailPage />);

    expect(mockUseMissionDetail).toHaveBeenCalledWith(undefined);
    expect(screen.queryByTestId('run-terminal-truth-card')).not.toBeInTheDocument();
  });
});
