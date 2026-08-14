/**
 * @file app/agents/runs/__tests__/runs-table-rows.test.ts
 * @description Direct unit coverage for the /agents/runs row-assembly
 * helpers — each mapper's field mapping from realistic fixtures, plus the
 * ARUN-001 fixes: a durable running-mission source (`rowsFromRunningMissions`)
 * that survives reload, per-run SSE grouping (`liveRowsFromEvents`) so
 * concurrent runs render distinctly and a sibling's completion never
 * suppresses a live run, and a single cross-source dedup in `assembleRows`
 * (durable polled rows win over the synthetic SSE rows; a run seen in two
 * sources during a poll-timing handoff renders exactly once).
 */

import {
  assembleRows,
  buildRunDetail,
  collapseThinkingEvents,
  degradedRunSources,
  describeAgentEvent,
  latestCompletionSequence,
  liveRowsFromEvents,
  mergeRunEvents,
  missionToLogEntry,
  qualityFromReport,
  resolveRunOutputs,
  rowsFromAgentLog,
  rowsFromBuildMissions,
  rowsFromRunningMissions,
  runEventScopeId,
  settledRunScopeIds,
} from '../runs-table-rows';
import { missionUsageSnapshot } from '@/lib/mission-usage';
import type { AgentRunRow } from '@/components/activity/RunsTable';
import type { AgentLogEntry } from '@/hooks/useAgentActivity';
import type { AgentEvent } from '@/lib/schemas/agent-event';
import type { Mission } from '@/lib/schemas/mission';
import type { Report } from '@/lib/schemas/report';

// ============================================================================
// FIXTURE HELPERS
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

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'build-1',
    userId: 'u1',
    prompt: 'Prototype: internal knowledge search',
    agent: 'builder',
    kind: 'build',
    status: 'running',
    progress: 50,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-05-09T09:00:00.000Z',
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
    // Catalog reports (from the owner-scoped /api/reports) always carry an
    // ownerId — resolveRunOutputs refuses an ownerless report defensively.
    ownerId: 'owner-1',
    entityIds: [],
    metadata: { description: 'desc', dataSnapshotAt: '2026-05-08T08:00:00.000Z' },
    shared: false,
    ...overrides,
  };
}

function row(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'r1',
    agent: 'scout',
    mission: 'A mission',
    kind: 'mission',
    status: 'success',
    tokens: 0,
    durationMs: 0,
    startedAt: '2026-05-08T08:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// qualityFromReport
// ============================================================================

describe('qualityFromReport', () => {
  it('maps a 0-1 overallScore + checks into the 0-100 quality shape', () => {
    const quality = qualityFromReport({
      evaluatedAt: '2026-05-08T08:00:00.000Z',
      overallScore: 0.71,
      verdict: 'PASS',
      checks: [
        { name: 'a', pass: true, critical: true, detail: '' },
        { name: 'b', pass: true, critical: false, detail: '' },
        { name: 'c', pass: false, critical: false, detail: '' },
      ],
    });
    expect(quality).toEqual({ passed: 2, total: 3, score: 71, l1: 'PASS' });
  });

  it('returns undefined when there is no report', () => {
    expect(qualityFromReport(undefined)).toBeUndefined();
  });
});

// ============================================================================
// rowsFromAgentLog
// ============================================================================

describe('rowsFromAgentLog', () => {
  it('maps a plain mission entry (no sweepId) to kind "mission"', () => {
    const [mapped] = rowsFromAgentLog([agentLogEntry()]);
    expect(mapped).toMatchObject({
      id: 'run-1',
      agent: 'scout',
      mission: 'Discovered 3 new technology signals',
      kind: 'mission',
      status: 'success',
      tokens: 2000,
      durationMs: 4500,
      startedAt: '2026-05-08T08:00:00.000Z',
    });
    expect(mapped.quality).toBeUndefined();
  });

  it('maps an entry carrying sweepId to kind "sweep"', () => {
    const [mapped] = rowsFromAgentLog([agentLogEntry({ id: 'run-2', sweepId: 'sweep-1' })]);
    expect(mapped.kind).toBe('sweep');
  });

  it('maps explicit Gemini chat metadata onto a distinct chat row', () => {
    const [mapped] = rowsFromAgentLog([
      agentLogEntry({
        id: 'run-chat-gemini',
        agentName: 'chat',
        kind: 'chat',
        provider: 'gemini',
        model: 'gemini-3.5-pro',
      }),
    ]);

    expect(mapped).toMatchObject({
      id: 'run-chat-gemini',
      kind: 'chat',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    });
  });

  it('carries receipt-derived estimate authority into the visible table row', () => {
    const [mapped] = rowsFromAgentLog([
      agentLogEntry({ id: 'run-chat-cost', costUsd: 0.125, costState: 'estimated' }),
    ]);

    expect(mapped).toMatchObject({
      id: 'run-chat-cost',
      costUsd: 0.125,
      costState: 'estimated',
      costUnavailable: false,
    });
  });

  it('safely infers legacy Claude chat rows without relabelling Claude-backed missions', () => {
    const [legacyChat, claudeMission] = rowsFromAgentLog([
      agentLogEntry({
        id: 'run-chat-legacy',
        agentName: 'chat',
        model: 'claude-opus-4-8',
      }),
      agentLogEntry({
        id: 'run-mission-claude',
        agentName: 'researcher',
        missionId: 'mission-claude',
        model: 'claude-opus-4-8',
      }),
    ]);

    expect(legacyChat).toMatchObject({ kind: 'chat', provider: 'claude', model: 'claude-opus-4-8' });
    expect(claudeMission).toMatchObject({ kind: 'mission', model: 'claude-opus-4-8' });
    expect(claudeMission.provider).toBeUndefined();
  });

  it('maps qualityReport (0-1 scale) onto the row quality field', () => {
    const [mapped] = rowsFromAgentLog([
      agentLogEntry({
        qualityReport: {
          evaluatedAt: '2026-05-08T08:00:00.000Z',
          overallScore: 0.83,
          verdict: 'PASS',
          checks: [
            { name: 'a', pass: true, critical: true, detail: '' },
            { name: 'b', pass: false, critical: false, detail: '' },
          ],
        },
      }),
    ]);
    expect(mapped.quality).toEqual({ passed: 1, total: 2, score: 83, l1: 'PASS' });
  });

  it('keeps the persisted execution duration unchanged across a history reload', () => {
    const persisted = agentLogEntry({
      id: 'run-demo-q2-briefing',
      missionId: 'mission-demo-q2-briefing',
      duration: 412_000,
      // AgentRun.createdAt is terminal persistence time, not an endpoint from
      // which the UI should re-derive duration.
      createdAt: '2026-07-12T10:06:52.000Z',
    });

    const [beforeReload] = rowsFromAgentLog([persisted]);
    const reloadedPayload = JSON.parse(JSON.stringify([persisted])) as AgentLogEntry[];
    const [afterReload] = rowsFromAgentLog(reloadedPayload);

    expect(beforeReload.durationMs).toBe(412_000);
    expect(afterReload.durationMs).toBe(412_000);
  });
});

// ============================================================================
// rowsFromBuildMissions
// ============================================================================

describe('rowsFromBuildMissions', () => {
  it('maps a completed build mission (tokenUsage summed, completedAt-derived duration)', () => {
    const [mapped] = rowsFromBuildMissions([
      mission({
        status: 'completed',
        tokenUsage: { input: 5000, output: 3000 },
        createdAt: '2026-05-09T09:00:00.000Z',
        completedAt: '2026-05-09T09:05:00.000Z',
      }),
    ]);
    expect(mapped).toMatchObject({
      id: 'build-1',
      agent: 'builder',
      mission: 'Prototype: internal knowledge search',
      kind: 'build',
      status: 'success',
      tokens: 8000,
      durationMs: 5 * 60 * 1000,
      startedAt: '2026-05-09T09:00:00.000Z',
    });
  });

  it('maps a running build mission to status "live" with an elapsed duration', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    const [mapped] = rowsFromBuildMissions([mission({ status: 'running', createdAt: '2026-05-09T09:00:00.000Z' })]);
    expect(mapped.status).toBe('live');
    expect(mapped.durationMs).toBe(30_000);
    jest.useRealTimers();
  });

  it('maps a failed build mission to status "failure"', () => {
    const [mapped] = rowsFromBuildMissions([mission({ status: 'failed' })]);
    expect(mapped.status).toBe('failure');
  });

  it('falls back to the id-derived title when the prompt is empty (P-F10 regression)', () => {
    const [mapped] = rowsFromBuildMissions([mission({ prompt: '', id: 'build-empty-prompt' })]);
    expect(mapped.mission).toBe('build-empty-prompt');
    expect(mapped.mission.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// ARUN-007: persisted telemetry honesty — missing values render unavailable,
// never a fabricated 0 (tokens) / 0ms (duration).
// ============================================================================

describe('ARUN-007 — telemetry honesty for build runs', () => {
  it('rowsFromBuildMissions: a failed build without completedAt has an unavailable duration, not 0ms', () => {
    const [mapped] = rowsFromBuildMissions([mission({ status: 'failed', completedAt: undefined })]);
    expect(mapped.durationMs).toBeUndefined();
  });

  it('rowsFromBuildMissions: a build with no persisted tokenUsage has unavailable tokens, not 0', () => {
    const [mapped] = rowsFromBuildMissions([mission({ status: 'failed', tokenUsage: undefined })]);
    expect(mapped.tokens).toBeUndefined();
  });

  it('buildRunDetail (build): failed-without-completedAt duration is unavailable, not 0ms', () => {
    const detail = buildRunDetail([], [mission({ status: 'failed', completedAt: undefined })], [], 'build-1');
    expect(detail?.durationMs).toBeUndefined();
  });

  it('buildRunDetail (build): tokens are unavailable when the mission has no tokenUsage', () => {
    const detail = buildRunDetail([], [mission({ status: 'running', tokenUsage: undefined })], [], 'build-1');
    expect(detail?.tokens).toBeUndefined();
  });

  it('buildRunDetail (build): surfaces the distinct persisted session models in first-seen order', () => {
    const detail = buildRunDetail(
      [],
      [
        mission({
          status: 'completed',
          completedAt: '2026-05-09T09:05:00.000Z',
          sessions: [
            { index: 0, objective: 'plan', model: 'claude-sonnet-5', startedAt: '2026-05-09T09:00:00.000Z' },
            { index: 1, objective: 'build', model: 'claude-sonnet-5', startedAt: '2026-05-09T09:01:00.000Z' },
            { index: 2, objective: 'qa', model: 'claude-opus-4-8', startedAt: '2026-05-09T09:03:00.000Z' },
          ],
        } as Partial<Mission>),
      ],
      [],
      'build-1'
    );
    expect(detail?.models).toEqual(['claude-sonnet-5', 'claude-opus-4-8']);
  });

  it('buildRunDetail (build): models is undefined when no session carries a model', () => {
    const detail = buildRunDetail(
      [],
      [mission({ status: 'running', sessions: [] } as Partial<Mission>)],
      [],
      'build-1'
    );
    expect(detail?.models).toBeUndefined();
  });

  it('missionToLogEntry: a failed build without completedAt is durationUnknown, never a fake 0ms', () => {
    const entry = missionToLogEntry(mission({ status: 'failed', completedAt: undefined }));
    expect(entry.durationUnknown).toBe(true);
  });
});

// ============================================================================
// ARUN-010: legacy replay-collapsed mission durations render as unavailable
// ============================================================================

describe('rowsFromAgentLog — legacy duration honesty (ARUN-010)', () => {
  it('renders a pre-ARUN-002 replay-collapsed mission duration (0–4ms) as unavailable', () => {
    const [row] = rowsFromAgentLog([agentLogEntry({ id: 'run-legacy', missionId: 'mission-old', duration: 3 })]);
    expect(row.durationMs).toBeUndefined(); // never present 3ms as real elapsed time
  });

  it('keeps a genuinely short NON-mission duration (skipped sweep cycles ARE fast)', () => {
    const [row] = rowsFromAgentLog([
      agentLogEntry({ id: 'run-sweep', missionId: undefined, sweepId: 'sweep-1', duration: 300 }),
    ]);
    expect(row.durationMs).toBe(300);
  });

  it('keeps normal mission durations untouched', () => {
    const [row] = rowsFromAgentLog([agentLogEntry({ id: 'run-ok', missionId: 'mission-new', duration: 45_000 })]);
    expect(row.durationMs).toBe(45_000);
  });

  it('never rewrites the underlying data — only the presented value changes', () => {
    const entry = agentLogEntry({ id: 'run-legacy', missionId: 'mission-old', duration: 3 });
    rowsFromAgentLog([entry]);
    expect(entry.duration).toBe(3); // stored value untouched
  });
});

// ============================================================================
// rowsFromRunningMissions (ARUN-001 durable running source)
// ============================================================================

describe('rowsFromRunningMissions', () => {
  it('ARUN-009: a queued mission (no executionStartedAt) shows "—" instead of relabeling queue wait as duration', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    const [mapped] = rowsFromRunningMissions([
      mission({
        id: 'mission-r1',
        kind: 'research',
        agent: 'scout',
        status: 'pending',
        prompt: 'Find emerging AI infra startups',
        createdAt: '2026-05-09T09:00:00.000Z',
        tokenUsage: { input: 300, output: 200 },
      }),
    ]);
    expect(mapped).toMatchObject({
      id: 'mission-r1',
      agent: 'scout',
      mission: 'Find emerging AI infra startups',
      kind: 'mission',
      status: 'live',
      tokens: 500,
      durationMs: undefined, // 30s of queue wait is NOT execution time
      startedAt: '2026-05-09T09:00:00.000Z',
    });
    jest.useRealTimers();
  });

  it('ARUN-009: a running mission shows execution-only age from executionStartedAt', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:05:00.000Z'));
    const [mapped] = rowsFromRunningMissions([
      mission({
        id: 'mission-r2',
        kind: 'research',
        status: 'running',
        createdAt: '2026-05-09T09:00:00.000Z', // 5 min ago (incl. 4 min queue)
        executionStartedAt: '2026-05-09T09:04:00.000Z', // dequeued 1 min ago
      }),
    ]);
    expect(mapped.durationMs).toBe(60_000); // execution-only, not 300 000
    jest.useRealTimers();
  });

  it('ARUN-009: live→terminal transition is monotonic — the terminal duration is ≥ the last live value', () => {
    // Live value just before completion (same post-dequeue clock)…
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:10:00.000Z'));
    const [live] = rowsFromRunningMissions([
      mission({
        id: 'mission-r3',
        kind: 'research',
        status: 'running',
        createdAt: '2026-05-09T08:00:00.000Z', // long queue wait before dequeue
        executionStartedAt: '2026-05-09T09:00:00.000Z',
      }),
    ]);
    jest.useRealTimers();
    expect(live.durationMs).toBe(600_000);

    // …and the terminal AgentRun captured 11 minutes of execution.
    const [terminal] = rowsFromAgentLog([agentLogEntry({ id: 'run-r3', missionId: 'mission-r3', duration: 660_000 })]);
    expect(terminal.durationMs).toBe(660_000);
    expect(terminal.durationMs!).toBeGreaterThanOrEqual(live.durationMs!);
  });

  it('excludes build-kind missions (they have their own richer source)', () => {
    const rows = rowsFromRunningMissions([mission({ id: 'build-x', kind: 'build', status: 'running' })]);
    expect(rows).toEqual([]);
  });

  it('drops a mission that has already completed into history (transition dedup)', () => {
    // The running-missions poll still returns the stale `running` doc for a
    // few seconds after the AgentRun history doc lands — history must win so
    // the run does not render twice during the handoff.
    const rows = rowsFromRunningMissions(
      [mission({ id: 'mission-done', kind: 'research', status: 'running' })],
      [agentLogEntry({ id: 'run-77', missionId: 'mission-done', status: 'success' })]
    );
    expect(rows).toEqual([]);
  });

  it('keeps a running mission whose id is not in completed history', () => {
    const rows = rowsFromRunningMissions(
      [mission({ id: 'mission-live', kind: 'research', status: 'pending' })],
      [agentLogEntry({ id: 'run-1', missionId: 'some-other-mission' })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('mission-live');
  });
});

// ============================================================================
// liveRowsFromEvents (ARUN-001 per-run SSE grouping)
// ============================================================================

describe('liveRowsFromEvents', () => {
  it('returns [] for an empty event list', () => {
    expect(liveRowsFromEvents([])).toEqual([]);
  });

  it('skips events that carry neither missionId nor sweepId (unattributable)', () => {
    expect(liveRowsFromEvents([agentEvent({ type: 'agent.started' })])).toEqual([]);
  });

  it('suppresses a run once ITS OWN completion has landed', () => {
    const rows = liveRowsFromEvents([
      agentEvent({ id: 'e1', type: 'agent.started', missionId: 'm1' }),
      agentEvent({ id: 'e2', type: 'agent.completed', missionId: 'm1' }),
    ]);
    expect(rows).toEqual([]);
  });

  it("a sibling run's completion does NOT suppress a still-running run", () => {
    const rows = liveRowsFromEvents([
      agentEvent({ id: 'a1', type: 'agent.started', missionId: 'm1', data: { prompt: 'Run A' } }),
      agentEvent({ id: 'b1', type: 'agent.started', missionId: 'm2', data: { prompt: 'Run B' } }),
      agentEvent({ id: 'b2', type: 'agent.completed', missionId: 'm2' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m1');
  });

  it('renders concurrent runs as one row per missionId', () => {
    const rows = liveRowsFromEvents([
      agentEvent({ id: 'a1', type: 'agent.started', missionId: 'm1', data: { prompt: 'Run A' } }),
      agentEvent({ id: 'b1', type: 'agent.started', missionId: 'm2', data: { prompt: 'Run B' } }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it("recovers the title from the run's own agent.started, not a later promptless heartbeat", () => {
    const rows = liveRowsFromEvents([
      agentEvent({
        id: 's',
        type: 'agent.started',
        missionId: 'm1',
        data: { prompt: 'Scout AI infra' },
        timestamp: '2026-05-09T09:00:00.000Z',
      }),
      agentEvent({ id: 't', type: 'agent.thinking', missionId: 'm1', data: {}, timestamp: '2026-05-09T09:00:05.000Z' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].mission).toBe('Scout AI infra');
  });

  it('falls back to "Live run in progress" when no event carries a prompt', () => {
    const rows = liveRowsFromEvents([agentEvent({ id: 'x', type: 'agent.thinking', missionId: 'm1', data: {} })]);
    expect(rows[0].mission).toBe('Live run in progress');
  });

  it('maps a missionId-carrying run to kind "mission"', () => {
    const [mapped] = liveRowsFromEvents([agentEvent({ missionId: 'mission-1', agentType: 'scout' })]);
    expect(mapped).toMatchObject({ id: 'mission-1', agent: 'scout', kind: 'mission', status: 'live' });
  });

  it('maps a sweepId-carrying run to kind "sweep"', () => {
    const [mapped] = liveRowsFromEvents([agentEvent({ sweepId: 'sweep-1', agentType: 'evaluator' })]);
    expect(mapped).toMatchObject({ id: 'sweep-1', kind: 'sweep' });
  });

  it('carries the latest tokensUsed value and the elapsed duration across the group', () => {
    const [mapped] = liveRowsFromEvents([
      agentEvent({ id: 'e1', missionId: 'm1', timestamp: '2026-05-09T09:00:00.000Z' }),
      agentEvent({ id: 'e2', missionId: 'm1', timestamp: '2026-05-09T09:00:10.000Z', data: { tokensUsed: 500 } }),
    ]);
    expect(mapped.tokens).toBe(500);
    expect(mapped.durationMs).toBe(10_000);
  });
});

// ============================================================================
// latestCompletionSequence (ARUN-001 completion-handoff trigger)
// ============================================================================

describe('latestCompletionSequence', () => {
  it('returns 0 when there are no completion events', () => {
    expect(latestCompletionSequence([])).toBe(0);
    expect(latestCompletionSequence([agentEvent({ type: 'agent.started', sequence: 5 })])).toBe(0);
  });

  it('returns the highest sequence among completed/error events, ignoring others', () => {
    const seq = latestCompletionSequence([
      agentEvent({ id: 'a', type: 'agent.started', sequence: 10 }),
      agentEvent({ id: 'b', type: 'agent.completed', missionId: 'm1', sequence: 20 }),
      agentEvent({ id: 'c', type: 'agent.thinking', missionId: 'm2', sequence: 30 }),
      agentEvent({ id: 'd', type: 'agent.error', missionId: 'm2', sequence: 25 }),
    ]);
    expect(seq).toBe(25); // max(20 completed, 25 error), the 30 thinking is ignored
  });
});

// ============================================================================
// assembleRows — dedup (Important finding #1) + ordering
// ============================================================================

describe('assembleRows', () => {
  it('dedups: same id present in builds AND live events → exactly ONE row, kind "build", Live status', () => {
    const buildRow = row({ id: 'build-1', agent: 'builder', kind: 'build', status: 'live' });
    const liveStreamRow = row({ id: 'build-1', agent: 'builder', kind: 'mission', status: 'live' });

    const rows = assembleRows([], [buildRow], [], [liveStreamRow]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'build-1', kind: 'build', status: 'live' });
  });

  it('promotes a matched build row to "live" even if it had not yet picked up the in-flight status', () => {
    const buildRow = row({ id: 'build-2', kind: 'build', status: 'success' });
    const liveStreamRow = row({ id: 'build-2', kind: 'mission', status: 'live' });

    const rows = assembleRows([], [buildRow], [], [liveStreamRow]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'build-2', kind: 'build', status: 'live' });
  });

  it('promotes a matched history row to "live" the same way builds do', () => {
    const historyRow = row({ id: 'mission-3', kind: 'mission', status: 'success' });
    const liveStreamRow = row({ id: 'mission-3', kind: 'mission', status: 'live' });

    const rows = assembleRows([historyRow], [], [], [liveStreamRow]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'mission-3', status: 'live' });
  });

  it('keeps the synthetic SSE row when its id has no matching durable row', () => {
    const liveStreamRow = row({ id: 'mission-only', kind: 'mission', status: 'live' });
    const rows = assembleRows([], [], [], [liveStreamRow]);
    expect(rows).toEqual([liveStreamRow]);
  });

  it('dedups a durable running-mission row against its own SSE row → one live row', () => {
    const runningRow = row({ id: 'mission-r1', kind: 'mission', status: 'live', agent: 'scout' });
    const sseRow = row({ id: 'mission-r1', kind: 'mission', status: 'live', agent: 'agent' });

    const rows = assembleRows([], [], [runningRow], [sseRow]);

    expect(rows).toHaveLength(1);
    // the durable row wins (keeps its agent), not the SSE augmentation
    expect(rows[0]).toMatchObject({ id: 'mission-r1', agent: 'scout', status: 'live' });
  });

  it('adopts the SSE row live token count when the durable running row is still 0 mid-run', () => {
    // A research/report mission doc only gets tokenUsage written at completion,
    // so its durable running row reads 0 mid-run. MISSION-001 puts the real
    // running count on the SSE heartbeat; assembleRows must surface it instead
    // of showing 0 until the mission finishes.
    const runningRow = row({ id: 'mission-r2', kind: 'mission', status: 'live', agent: 'creator', tokens: 0 });
    const sseRow = row({ id: 'mission-r2', kind: 'mission', status: 'live', agent: 'agent', tokens: 12000 });

    const rows = assembleRows([], [], [runningRow], [sseRow]);

    expect(rows).toHaveLength(1);
    // Durable row still wins on identity (agent, kind), but takes the live tokens.
    expect(rows[0]).toMatchObject({ id: 'mission-r2', agent: 'creator', status: 'live', tokens: 12000 });
  });

  it('never lowers a durable row token count from a staler SSE heartbeat', () => {
    // Near completion the mission doc may hold the final count while the last
    // heartbeat lags — take the max, never regress.
    const runningRow = row({ id: 'mission-r3', kind: 'mission', status: 'live', agent: 'creator', tokens: 40000 });
    const sseRow = row({ id: 'mission-r3', kind: 'mission', status: 'live', agent: 'agent', tokens: 38000 });

    const rows = assembleRows([], [], [runningRow], [sseRow]);

    expect(rows[0]).toMatchObject({ id: 'mission-r3', tokens: 40000 });
  });

  it('renders two concurrent running missions as two distinct live rows (newest first)', () => {
    const older = row({ id: 'm-old', kind: 'mission', status: 'live', startedAt: '2026-05-09T09:00:00.000Z' });
    const newer = row({ id: 'm-new', kind: 'mission', status: 'live', startedAt: '2026-05-09T09:05:00.000Z' });

    const rows = assembleRows([], [], [older, newer], []);

    expect(rows.map((r) => r.id)).toEqual(['m-new', 'm-old']);
  });

  it('pins live rows to the top, then sorts the rest newest-first', () => {
    const older = row({ id: 'h1', mission: 'older', startedAt: '2026-05-01T00:00:00.000Z' });
    const newer = row({ id: 'h2', mission: 'newer', startedAt: '2026-05-08T00:00:00.000Z' });
    const liveBuild = row({ id: 'b1', kind: 'build', status: 'live', startedAt: '2026-05-09T00:00:00.000Z' });

    const rows = assembleRows([older, newer], [liveBuild], [], []);

    expect(rows.map((r) => r.id)).toEqual(['b1', 'h2', 'h1']);
  });

  it('returns an empty array when there is nothing to assemble', () => {
    expect(assembleRows([], [], [], [])).toEqual([]);
  });
});

// ============================================================================
// missionToLogEntry (Task 22 / P-F1 part 2)
// ============================================================================

describe('missionToLogEntry', () => {
  it('maps a completed build mission field-for-field onto the AgentLogEntry shape', () => {
    const m = mission({
      status: 'completed',
      tokenUsage: { input: 5000, output: 3000 },
      createdAt: '2026-05-09T09:00:00.000Z',
      completedAt: '2026-05-09T09:05:00.000Z',
      errors: ['minor warning'],
    });
    expect(missionToLogEntry(m)).toMatchObject({
      id: 'build-1',
      agentName: 'builder',
      action: 'Prototype: internal knowledge search',
      status: 'success',
      missionId: 'build-1',
      tokenUsage: { input: 5000, output: 3000 },
      duration: 5 * 60 * 1000,
      errors: ['minor warning'],
      createdAt: '2026-05-09T09:00:00.000Z',
    });
  });

  it('maps a failed build mission to status "failure"', () => {
    expect(missionToLogEntry(mission({ status: 'failed' })).status).toBe('failure');
  });

  it('carries qualityReport, skillInvocations, and chain fields through unchanged', () => {
    const qualityReport = {
      evaluatedAt: '2026-05-09T09:05:00.000Z',
      overallScore: 0.9,
      verdict: 'PASS' as const,
      checks: [{ name: 'a', pass: true, critical: true, detail: 'ok' }],
    };
    const m = mission({
      status: 'completed',
      qualityReport,
      skillInvocations: [{ skill: 'design-pass', firedAt: '2026-05-09T09:01:00.000Z' }],
      chainId: 'chain-1',
      chainStep: 1,
      chainTotalSteps: 2,
    });
    const entry = missionToLogEntry(m);
    expect(entry.qualityReport).toEqual(qualityReport);
    expect(entry.skillInvocations).toEqual(m.skillInvocations);
    expect(entry.chainId).toBe('chain-1');
    expect(entry.chainStep).toBe(1);
    expect(entry.chainTotalSteps).toBe(2);
  });

  it('normalizes nullable partial/partialCheckpointTurn to undefined', () => {
    const m = mission({ status: 'completed', partial: null, partialCheckpointTurn: null });
    const entry = missionToLogEntry(m);
    expect(entry.partial).toBeUndefined();
    expect(entry.partialCheckpointTurn).toBeUndefined();
  });
});

// ============================================================================
// buildRunDetail (Task 22 / P-F1 part 2)
// ============================================================================

describe('buildRunDetail', () => {
  it('resolves a history entry (mission/sweep) with quality checks and errors', () => {
    const entry = agentLogEntry({
      id: 'run-9',
      status: 'failure',
      errors: ['Rate limit exceeded'],
      costUsd: 0.05,
      costState: 'estimated',
      qualityReport: {
        evaluatedAt: '2026-05-08T08:00:00.000Z',
        overallScore: 0.5,
        verdict: 'REVISE',
        checks: [{ name: 'has-summary', pass: false, critical: true, detail: 'missing summary' }],
      },
    });

    const detail = buildRunDetail([entry], [], [], 'run-9');

    expect(detail).toMatchObject({
      id: 'run-9',
      agent: 'scout',
      kind: 'mission',
      status: 'failure',
      costUsd: 0.05,
      costState: 'estimated',
      errors: ['Rate limit exceeded'],
      isLive: false,
    });
    expect(detail?.quality).toEqual({ passed: 0, total: 1, score: 50, l1: 'REVISE' });
    expect(detail?.qualityChecks).toEqual(entry.qualityReport?.checks);
    expect(detail?.logEntry).toBe(entry);
  });

  it('classifies a history entry carrying sweepId as kind "sweep"', () => {
    const entry = agentLogEntry({ id: 'run-10', sweepId: 'sweep-9' });
    expect(buildRunDetail([entry], [], [], 'run-10')?.kind).toBe('sweep');
  });

  it('preserves chat provider, model, and bounded tool history in detail data', () => {
    const entry = agentLogEntry({
      id: 'run-chat-detail',
      agentName: 'chat',
      kind: 'chat',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
      toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 18 }],
      toolSummaryTruncated: true,
    });

    const detail = buildRunDetail([entry], [], [], 'run-chat-detail');

    expect(detail).toMatchObject({
      id: 'run-chat-detail',
      kind: 'chat',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
      logEntry: {
        toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 18 }],
        toolSummaryTruncated: true,
      },
      isLive: false,
    });
  });

  it('resolves a completed build mission via missionToLogEntry (kind "build", not live)', () => {
    const m = mission({ id: 'build-9', status: 'completed', completedAt: '2026-05-09T09:05:00.000Z' });

    const detail = buildRunDetail([], [m], [], 'build-9');

    expect(detail).toMatchObject({ id: 'build-9', kind: 'build', status: 'success', isLive: false });
    expect(detail?.logEntry).toMatchObject({ id: 'build-9', agentName: 'builder' });
  });

  it('resolves a running build mission as live with no logEntry yet', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    const m = mission({ id: 'build-10', status: 'running', createdAt: '2026-05-09T09:00:00.000Z' });

    const detail = buildRunDetail([], [m], [], 'build-10');

    expect(detail).toMatchObject({ id: 'build-10', kind: 'build', status: 'live', isLive: true, durationMs: 30_000 });
    expect(detail?.logEntry).toBeUndefined();
    jest.useRealTimers();
  });

  it('resolves a run known only through the live SSE stream (no Firestore doc yet)', () => {
    const events: AgentEvent[] = [
      agentEvent({ id: 'e1', missionId: 'mission-live', agentType: 'scout', data: { prompt: 'Investigate X' } }),
      agentEvent({
        id: 'e2',
        missionId: 'mission-live',
        type: 'agent.thinking',
        timestamp: '2026-05-09T09:00:10.000Z',
      }),
    ];

    const detail = buildRunDetail([], [], events, 'mission-live');

    expect(detail).toMatchObject({
      id: 'mission-live',
      agent: 'scout',
      mission: 'Investigate X',
      kind: 'mission',
      status: 'live',
      isLive: true,
    });
    expect(detail?.events).toHaveLength(2);
    expect(detail?.logEntry).toBeUndefined();
  });

  it('marks an SSE-only run "failure" once an agent.error event lands, without going live→not-found', () => {
    const events: AgentEvent[] = [
      agentEvent({ id: 'e1', missionId: 'mission-err' }),
      agentEvent({ id: 'e2', missionId: 'mission-err', type: 'agent.error', data: { error: 'boom' } }),
    ];

    const detail = buildRunDetail([], [], events, 'mission-err');

    expect(detail).toMatchObject({ status: 'failure', isLive: false });
  });

  it('scopes events by sweepId when the run has no missionId', () => {
    const events: AgentEvent[] = [agentEvent({ id: 'e1', sweepId: 'sweep-live', agentType: 'evaluator' })];
    const detail = buildRunDetail([], [], events, 'sweep-live');
    expect(detail).toMatchObject({ id: 'sweep-live', kind: 'sweep' });
  });

  it('returns null when the id matches nothing in any source', () => {
    expect(
      buildRunDetail([agentLogEntry()], [mission()], [agentEvent({ missionId: 'other' })], 'unknown-id')
    ).toBeNull();
  });

  it("scopes a history run's events by the entry's missionId, not the AgentRun doc id", () => {
    const entry = agentLogEntry({ id: 'run-7', missionId: 'mission-7' });
    const events = [
      agentEvent({ id: 'e1', missionId: 'mission-7', sequence: 10 }),
      agentEvent({ id: 'e2', missionId: 'mission-other', sequence: 20 }),
    ];

    const detail = buildRunDetail([entry], [], events, 'run-7');

    expect(detail?.events.map((e) => e.id)).toEqual(['e1']);
  });

  it("scopes a sweep-spawned history run's events by the entry's sweepId", () => {
    const entry = agentLogEntry({ id: 'run-8', sweepId: 'sweep-8' });
    const events = [agentEvent({ id: 'e1', sweepId: 'sweep-8', sequence: 10 })];

    const detail = buildRunDetail([entry], [], events, 'run-8');

    expect(detail?.events.map((e) => e.id)).toEqual(['e1']);
  });
});

// ============================================================================
// runEventScopeId (Task 22 follow-up) — events are keyed by missionId/sweepId,
// not the AgentRun doc id.
// ============================================================================

describe('runEventScopeId', () => {
  it("returns the history entry's missionId when present", () => {
    expect(runEventScopeId([agentLogEntry({ id: 'run-7', missionId: 'mission-7' })], 'run-7')).toBe('mission-7');
  });

  it("falls back to the entry's sweepId when there is no missionId", () => {
    expect(runEventScopeId([agentLogEntry({ id: 'run-8', sweepId: 'sweep-8' })], 'run-8')).toBe('sweep-8');
  });

  it('prefers missionId over sweepId when the entry carries both', () => {
    expect(runEventScopeId([agentLogEntry({ id: 'run-9', missionId: 'mission-9', sweepId: 'sweep-9' })], 'run-9')).toBe(
      'mission-9'
    );
  });

  it('returns the run id itself for build missions and SSE-only runs (no matching entry)', () => {
    expect(runEventScopeId([agentLogEntry({ id: 'run-1' })], 'build-1')).toBe('build-1');
  });

  it('returns undefined when the matched entry carries neither missionId nor sweepId (chat run / sweep-cycle summary)', () => {
    expect(runEventScopeId([agentLogEntry({ id: 'run-11' })], 'run-11')).toBeUndefined();
  });
});

// ============================================================================
// describeAgentEvent (Task 22 / P-F1 part 2)
// ============================================================================

describe('describeAgentEvent', () => {
  it('describes each known event type with a human label', () => {
    expect(describeAgentEvent(agentEvent({ type: 'agent.started', data: { prompt: 'Do the thing' } }))).toBe(
      'Started — Do the thing'
    );
    expect(describeAgentEvent(agentEvent({ type: 'agent.started', data: {} }))).toBe('Started');
    expect(describeAgentEvent(agentEvent({ type: 'agent.thinking', data: {} }))).toBe('Thinking…');
    // AUDIT-021: a stray legacy status:'resuming' payload (no producer emits
    // it since MISSION-006) renders as plain thinking, not a fabricated label.
    expect(
      describeAgentEvent(agentEvent({ type: 'agent.thinking', data: { status: 'resuming', resumedFromTurn: 4 } }))
    ).toBe('Thinking…');
    expect(describeAgentEvent(agentEvent({ type: 'agent.tool_call', data: { toolName: 'searchPapers' } }))).toBe(
      'Called tool: searchPapers'
    );
    expect(describeAgentEvent(agentEvent({ type: 'agent.tool_call', data: { tool: 'writeFile' } }))).toBe(
      'Called tool: writeFile'
    );
    expect(
      describeAgentEvent(agentEvent({ type: 'agent.tool_call', data: { toolName: 'searchPapers', tool: 'writeFile' } }))
    ).toBe('Called tool: searchPapers');
    expect(
      describeAgentEvent(agentEvent({ type: 'agent.tool_call', data: { toolName: ' ', tool: ' writeFile ' } }))
    ).toBe('Called tool: writeFile');
    expect(describeAgentEvent(agentEvent({ type: 'agent.tool_call', data: { toolName: 42, tool: null } }))).toBe(
      'Tool call'
    );
    expect(describeAgentEvent(agentEvent({ type: 'agent.discovery', data: { discoveryType: 'signal' } }))).toBe(
      'Discovered a new signal'
    );
    expect(describeAgentEvent(agentEvent({ type: 'agent.completed', data: {} }))).toBe('Completed successfully');
    expect(describeAgentEvent(agentEvent({ type: 'agent.error', data: { error: 'boom' } }))).toBe('Error: boom');
    expect(describeAgentEvent(agentEvent({ type: 'sweep.phase', data: { phase: 'discovery' } }))).toBe(
      'Sweep phase: discovery'
    );
    expect(describeAgentEvent(agentEvent({ type: 'graph.updated', data: {} }))).toBe('Graph updated');
    expect(describeAgentEvent(agentEvent({ type: 'insight.created', data: {} }))).toBe('Insight created');
  });
});

// ============================================================================
// mergeRunEvents (Task 22 follow-up — history seed + live SSE tail)
// ============================================================================

describe('mergeRunEvents', () => {
  it('dedups by event id across the history seed and the live tail', () => {
    const shared = agentEvent({ id: 'evt-1', sequence: 10 });
    const merged = mergeRunEvents([shared], [shared, agentEvent({ id: 'evt-2', sequence: 20 })]);
    expect(merged.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
  });

  it('sorts the merged set by sequence ascending regardless of input order', () => {
    const merged = mergeRunEvents(
      [agentEvent({ id: 'evt-3', sequence: 30 }), agentEvent({ id: 'evt-1', sequence: 10 })],
      [agentEvent({ id: 'evt-2', sequence: 20 })]
    );
    expect(merged.map((e) => e.sequence)).toEqual([10, 20, 30]);
  });

  it('returns just the history when the live tail is empty (finished run)', () => {
    const history = [agentEvent({ id: 'evt-1', sequence: 10 }), agentEvent({ id: 'evt-2', sequence: 20 })];
    expect(mergeRunEvents(history, [])).toEqual(history);
  });

  it('returns just the live tail when history is empty (brand-new run, nothing persisted yet)', () => {
    const live = [agentEvent({ id: 'evt-1', sequence: 10 })];
    expect(mergeRunEvents([], live)).toEqual(live);
  });

  it('returns an empty array for two empty inputs', () => {
    expect(mergeRunEvents([], [])).toEqual([]);
  });
});

// ============================================================================
// resolveRunOutputs (P-F7) — "did this run produce something?" for the run
// detail page's aside Output card. Two independent sources: a published
// Report matched by missionId (mirrors AgentLog.tsx's reportsByMission
// lookup), and a build mission's own artifact (mission.id === run.id, same
// id /artifacts/[id] resolves against).
// ============================================================================

describe('resolveRunOutputs', () => {
  it('returns a report ref when a published report matches the run logEntry missionId', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: agentLogEntry({ missionId: 'mission-3' }) };
    const reports = [report({ id: 'report-9', title: 'Q3 Technology Landscape', missionId: 'mission-3' })];

    const outputs = resolveRunOutputs(run, reports, []);

    expect(outputs).toEqual([
      {
        key: 'report-report-9',
        title: 'Q3 Technology Landscape',
        href: '/reports/report-9',
        badge: expect.objectContaining({ label: 'Report' }),
      },
    ]);
  });

  it('returns nothing when no report matches the missionId', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: agentLogEntry({ missionId: 'mission-3' }) };
    const reports = [report({ id: 'report-9', missionId: 'some-other-mission' })];

    expect(resolveRunOutputs(run, reports, [])).toEqual([]);
  });

  it('returns nothing when the run has no logEntry (SSE-only, no missionId to match against)', () => {
    const run = { id: 'run-live', kind: 'mission' as const, logEntry: undefined };
    const reports = [report({ id: 'report-9', missionId: 'run-live' })];

    expect(resolveRunOutputs(run, reports, [])).toEqual([]);
  });

  it('returns an artifact ref for a build mission that produced a prototype, linking to /artifacts/[id]', () => {
    const run = { id: 'build-1', kind: 'build' as const, logEntry: undefined };
    const buildMissions = [
      mission({
        id: 'build-1',
        artifactKind: 'solution',
        artifact: { prototypeId: 'proto-9', publishedAt: '2026-05-09T09:05:00.000Z' },
      }),
    ];

    const outputs = resolveRunOutputs(run, [], buildMissions);

    expect(outputs).toEqual([
      {
        key: 'artifact-build-1',
        title: 'Prototype: internal knowledge search',
        href: '/artifacts/build-1',
        badge: expect.objectContaining({ label: 'App' }),
      },
    ]);
  });

  it('omits the artifact ref when the build mission has no artifact and no findings yet', () => {
    const run = { id: 'build-1', kind: 'build' as const, logEntry: undefined };
    const buildMissions = [mission({ id: 'build-1' })];

    expect(resolveRunOutputs(run, [], buildMissions)).toEqual([]);
  });

  it('omits the artifact ref for a non-build run even if an id-matching mission somehow exists', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: undefined };
    const buildMissions = [
      mission({ id: 'run-3', artifact: { prototypeId: 'proto-9', publishedAt: '2026-05-09T09:05:00.000Z' } }),
    ];

    expect(resolveRunOutputs(run, [], buildMissions)).toEqual([]);
  });

  it('lists both a report and an artifact when a run carries both', () => {
    const run = { id: 'build-1', kind: 'build' as const, logEntry: agentLogEntry({ missionId: 'build-1' }) };
    const reports = [report({ id: 'report-9', title: 'Q3 Technology Landscape', missionId: 'build-1' })];
    const buildMissions = [
      mission({
        id: 'build-1',
        artifactKind: 'solution',
        artifact: { prototypeId: 'proto-9', publishedAt: '2026-05-09T09:05:00.000Z' },
      }),
    ];

    const outputs = resolveRunOutputs(run, reports, buildMissions);

    expect(outputs.map((o) => o.key)).toEqual(['report-report-9', 'artifact-build-1']);
  });

  // REPORT-002 — run→report resolution must select ONE deterministic canonical
  // Report and never a foreign, ownerless, or arbitrary same-mission one.
  it('resolves a multi-report mission to the deterministic canonical report (newest, id tiebreaker)', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: agentLogEntry({ missionId: 'mission-3' }) };
    const older = report({ id: 'report-a', missionId: 'mission-3', createdAt: '2026-07-01T00:00:00.000Z' });
    const newer = report({ id: 'report-c', missionId: 'mission-3', createdAt: '2026-07-05T00:00:00.000Z' });
    // Same timestamp as `newer` — id decides deterministically (report-b < report-c).
    const tie = report({ id: 'report-b', missionId: 'mission-3', createdAt: '2026-07-05T00:00:00.000Z' });

    // Independent of input order, the canonical winner is always report-b.
    expect(resolveRunOutputs(run, [older, newer, tie], []).map((o) => o.key)).toEqual(['report-report-b']);
    expect(resolveRunOutputs(run, [tie, newer, older], []).map((o) => o.key)).toEqual(['report-report-b']);
  });

  it('never links an ownerless legacy report to a run (defense-in-depth)', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: agentLogEntry({ missionId: 'mission-3' }) };
    const reports = [report({ id: 'report-legacy', missionId: 'mission-3', ownerId: undefined })];
    expect(resolveRunOutputs(run, reports, [])).toEqual([]);
  });

  it('never links a foreign report to a run when the authenticated owner is supplied', () => {
    const run = { id: 'run-3', kind: 'mission' as const, logEntry: agentLogEntry({ missionId: 'mission-3' }) };
    const reports = [report({ id: 'report-foreign', missionId: 'mission-3', ownerId: 'owner-2' })];
    expect(resolveRunOutputs(run, reports, [], 'owner-1')).toEqual([]);
  });
});

// AUDIT-006 — a build parked at a human gate must not read as healthily "Live".
// The supervisor is stopped at `step.waitForEvent` and auto-denies after 24h if
// nobody acts, so a Live pill told the reader "working" about a run that was
// actually waiting on THEM — with no UI anywhere to resolve it.
describe('rowsFromBuildMissions — human-gate visibility (AUDIT-006)', () => {
  const gated = (buildState: string) =>
    ({
      id: 'b1',
      userId: 'u1',
      agent: 'builder',
      kind: 'build',
      status: 'running',
      prompt: '# Mission: Widget\n',
      buildState,
      createdAt: '2026-07-12T00:00:00.000Z',
    }) as unknown as Mission;

  it.each(['awaiting-budget', 'awaiting-stall', 'awaiting-approval'])(
    'marks a build parked at the %s gate as blocked, not live',
    (state) => {
      const [row] = rowsFromBuildMissions([gated(state)]);
      expect(row.status).toBe('blocked');
    }
  );

  it('still marks a genuinely working build as live', () => {
    const [row] = rowsFromBuildMissions([gated('session-running')]);
    expect(row.status).toBe('live');
  });

  it('leaves terminal builds untouched', () => {
    const done = { ...gated('paused'), status: 'completed', completedAt: '2026-07-12T01:00:00.000Z' } as Mission;
    expect(rowsFromBuildMissions([done])[0].status).toBe('success');
  });
});

// ============================================================================
// degradedRunSources (ARUN-012)
// ============================================================================

describe('degradedRunSources', () => {
  it('returns an empty list when every source is healthy', () => {
    expect(degradedRunSources({ history: false, builds: false, running: false, live: false })).toEqual([]);
  });

  it('names a single failing source', () => {
    expect(degradedRunSources({ history: true, builds: false, running: false, live: false })).toEqual(['run history']);
  });

  it('names multiple failing sources in a stable order', () => {
    expect(degradedRunSources({ history: true, builds: true, running: false, live: true })).toEqual([
      'run history',
      'build missions',
      'the live event stream',
    ]);
  });

  it('names all four sources when everything is down', () => {
    expect(degradedRunSources({ history: true, builds: true, running: true, live: true })).toEqual([
      'run history',
      'build missions',
      'in-flight missions',
      'the live event stream',
    ]);
  });
});

// ============================================================================
// ARUN-016 — collapse adjacent equivalent Thinking events into one timeline
// item (count + time range) while preserving the raw immutable events for the
// expand path. Non-thinking events and non-adjacent thinking events never
// group.
// ============================================================================

describe('collapseThinkingEvents (ARUN-016)', () => {
  const thinking = (id: string, ts: string, sequence: number): AgentEvent =>
    agentEvent({ id, type: 'agent.thinking', timestamp: ts, sequence, missionId: 'm1' });
  const tool = (id: string, ts: string, sequence: number): AgentEvent =>
    agentEvent({ id, type: 'agent.tool_call', timestamp: ts, sequence, missionId: 'm1', data: { toolName: 'x' } });

  it('returns plain event items untouched when nothing is collapsible', () => {
    const events = [
      agentEvent({ id: 'e1', type: 'agent.started', sequence: 1 }),
      tool('e2', '2026-05-09T09:00:01.000Z', 2),
    ];
    expect(collapseThinkingEvents(events)).toEqual([
      { type: 'event', event: events[0] },
      { type: 'event', event: events[1] },
    ]);
  });

  it('collapses adjacent thinking events into one group with count, time range, and the raw events in order', () => {
    const t1 = thinking('t1', '2026-05-09T09:00:00.000Z', 1);
    const t2 = thinking('t2', '2026-05-09T09:00:30.000Z', 2);
    const t3 = thinking('t3', '2026-05-09T09:01:00.000Z', 3);
    const items = collapseThinkingEvents([t1, t2, t3]);
    expect(items).toEqual([
      {
        type: 'thinking-group',
        count: 3,
        startTimestamp: '2026-05-09T09:00:00.000Z',
        endTimestamp: '2026-05-09T09:01:00.000Z',
        events: [t1, t2, t3],
      },
    ]);
    // Immutable raw events: the very same objects, not copies.
    expect((items[0] as { events: AgentEvent[] }).events[0]).toBe(t1);
  });

  it('keeps a single thinking event as a plain item (no group of one)', () => {
    const t1 = thinking('t1', '2026-05-09T09:00:00.000Z', 1);
    expect(collapseThinkingEvents([t1])).toEqual([{ type: 'event', event: t1 }]);
  });

  it('does not group thinking events separated by another event type', () => {
    const t1 = thinking('t1', '2026-05-09T09:00:00.000Z', 1);
    const call = tool('e2', '2026-05-09T09:00:10.000Z', 2);
    const t2 = thinking('t2', '2026-05-09T09:00:20.000Z', 3);
    expect(collapseThinkingEvents([t1, call, t2])).toEqual([
      { type: 'event', event: t1 },
      { type: 'event', event: call },
      { type: 'event', event: t2 },
    ]);
  });

  it('forms independent groups on each side of an interrupting event', () => {
    const t1 = thinking('t1', '2026-05-09T09:00:00.000Z', 1);
    const t2 = thinking('t2', '2026-05-09T09:00:10.000Z', 2);
    const call = tool('e3', '2026-05-09T09:00:20.000Z', 3);
    const t3 = thinking('t3', '2026-05-09T09:00:30.000Z', 4);
    const t4 = thinking('t4', '2026-05-09T09:00:40.000Z', 5);
    const items = collapseThinkingEvents([t1, t2, call, t3, t4]);
    expect(items.map((i) => i.type)).toEqual(['thinking-group', 'event', 'thinking-group']);
    expect((items[0] as { count: number }).count).toBe(2);
    expect((items[2] as { count: number }).count).toBe(2);
  });

  it('bounds a large real-shaped run: 2000 heartbeats around 20 tool calls collapse to ~41 items', () => {
    // 21 bursts of ~95 thinking heartbeats separated by 20 tool calls — the
    // shape of a long real mission (30s heartbeat cadence for ~16h of work).
    const events: AgentEvent[] = [];
    let seq = 0;
    for (let burst = 0; burst < 21; burst++) {
      for (let i = 0; i < 95; i++) {
        events.push(thinking(`t-${burst}-${i}`, new Date(1746777600000 + seq * 1000).toISOString(), seq++));
      }
      if (burst < 20) {
        events.push(tool(`c-${burst}`, new Date(1746777600000 + seq * 1000).toISOString(), seq++));
      }
    }
    const items = collapseThinkingEvents(events);
    expect(items).toHaveLength(41); // 21 groups + 20 tool calls
    const groups = items.filter((i) => i.type === 'thinking-group');
    expect(groups).toHaveLength(21);
    // Raw events are all preserved across the groups — nothing is dropped.
    const preserved = groups.reduce((n, g) => n + (g as { events: AgentEvent[] }).events.length, 0);
    expect(preserved).toBe(21 * 95);
  });
});

// ============================================================================
// ARUN-020 — one authoritative mission usage snapshot across list, detail,
// and the SSE live bridge. A running build must never show fabricated zero
// tokens on one surface while another shows real spend.
// ============================================================================

describe('ARUN-020 — in-flight usage reconciliation', () => {
  it('list row and detail read IDENTICAL tokens/cost from the same mission doc — running (nothing finalized)', () => {
    const running = mission({ status: 'running', costUsd: 6.5, tokenUsage: undefined });
    const [row] = rowsFromBuildMissions([running]);
    const detail = buildRunDetail([], [running], [], 'build-1');
    expect(row.tokens).toBeUndefined();
    expect(detail?.tokens).toBeUndefined();
    expect(row).toMatchObject({
      costUsd: 6.5,
      costState: 'maximum-exposure',
      costUnavailable: false,
    });
    expect(detail).toMatchObject({ costUsd: 6.5, costState: 'maximum-exposure' });
  });

  it('list row and detail read IDENTICAL tokens/cost from the same mission doc — after a session finalizes', () => {
    const midRun = mission({ status: 'running', costUsd: 9.1, tokenUsage: { input: 5000, output: 3000 } });
    const [row] = rowsFromBuildMissions([midRun]);
    const detail = buildRunDetail([], [midRun], [], 'build-1');
    expect(row.tokens).toBe(8000);
    expect(detail?.tokens).toBe(8000);
    expect(row).toMatchObject({
      costUsd: 9.1,
      costState: 'maximum-exposure',
      costUnavailable: false,
    });
    expect(detail).toMatchObject({ costUsd: 9.1, costState: 'maximum-exposure' });
  });

  it('completion handoff keeps the same snapshot: completed build renders once with its final usage', () => {
    const done = mission({
      status: 'completed',
      completedAt: '2026-05-09T09:05:00.000Z',
      costUsd: 12.75,
      tokenUsage: { input: 90_000, output: 30_000 },
    });
    const rows = assembleRows([], rowsFromBuildMissions([done]), [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBe(120_000);
    const detail = buildRunDetail([], [done], [], 'build-1');
    expect(detail?.tokens).toBe(120_000);
    expect(rows[0]).toMatchObject({
      costUsd: 12.75,
      costState: 'maximum-exposure',
      costUnavailable: false,
    });
    expect(detail).toMatchObject({ costUsd: 12.75, costState: 'maximum-exposure' });
  });

  it('shows active BUILD-035 reservation as authority, never as settled zero', () => {
    const reserved = mission({
      status: 'running',
      buildCostAccounting: {
        settledActualUsd: 0,
        estimatedUsd: 0,
        activeReservedUsd: 6.5,
        unsettledMaximumUsd: 0,
        trackedSpendUsd: 0,
        maximumExposureUsd: 6.5,
        unavailableSessionCount: 0,
        invalidSessionIndexes: [],
        observedAt: '2026-07-23T10:00:00.000Z',
      },
    } as Partial<Mission>);

    const [row] = rowsFromBuildMissions([reserved]);
    const detail = buildRunDetail([], [reserved], [], reserved.id);
    const logEntry = missionToLogEntry(reserved);

    expect(row).toMatchObject({
      costUsd: 6.5,
      costState: 'reserved',
      costUnavailable: false,
    });
    expect(detail).toMatchObject({ costUsd: 6.5, costState: 'reserved' });
    expect(logEntry).toMatchObject({ costUsd: 6.5, costState: 'reserved' });
  });

  it('preserves BUILD-035 mixed settled + estimated authority without relabelling it settled', () => {
    const mixed = mission({
      status: 'completed',
      completedAt: '2026-05-09T09:05:00.000Z',
      tokenUsage: { input: 5000, output: 3000 },
      buildCostAccounting: {
        settledActualUsd: 4,
        estimatedUsd: 2,
        activeReservedUsd: 0,
        unsettledMaximumUsd: 0,
        trackedSpendUsd: 6,
        maximumExposureUsd: 6,
        unavailableSessionCount: 0,
        invalidSessionIndexes: [],
        observedAt: '2026-07-23T10:00:00.000Z',
      },
    } as Partial<Mission>);

    const [row] = rowsFromBuildMissions([mixed]);
    const detail = buildRunDetail([], [mixed], [], mixed.id);
    const logEntry = missionToLogEntry(mixed);

    expect(row).toMatchObject({
      costUsd: 6,
      costState: 'mixed',
      costUnavailable: false,
    });
    expect(detail).toMatchObject({ costUsd: 6, costState: 'mixed' });
    expect(logEntry).toMatchObject({ costUsd: 6, costState: 'mixed' });
  });

  it('liveRowsFromEvents reports unknown tokens (not 0) when no heartbeat carried tokensUsed', () => {
    const [row] = liveRowsFromEvents([
      agentEvent({ id: 'e1', missionId: 'm1', type: 'agent.started', sequence: 1, data: { prompt: 'Go' } }),
      agentEvent({ id: 'e2', missionId: 'm1', type: 'agent.thinking', sequence: 2, data: {} }),
    ]);
    expect(row.tokens).toBeUndefined();
  });

  it('mergeLive never fabricates 0: an SSE match with no token data promotes to live but leaves tokens unknown', () => {
    const durable = rowsFromBuildMissions([mission({ status: 'running', tokenUsage: undefined })]);
    const sse: AgentRunRow[] = [
      {
        id: 'build-1',
        agent: 'agent',
        mission: 'Live run in progress',
        kind: 'mission',
        status: 'live',
        tokens: undefined,
        durationMs: 0,
        startedAt: '2026-05-09T09:00:00.000Z',
      },
    ];
    const rows = assembleRows([], durable, [], sse);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('live');
    expect(rows[0].tokens).toBeUndefined();
  });

  it('mergeLive still lends a REAL live token count to a durable row with none', () => {
    const durable = rowsFromBuildMissions([mission({ status: 'running', tokenUsage: undefined })]);
    const sse: AgentRunRow[] = [
      {
        id: 'build-1',
        agent: 'agent',
        mission: 'Live run in progress',
        kind: 'mission',
        status: 'live',
        tokens: 4200,
        durationMs: 0,
        startedAt: '2026-05-09T09:00:00.000Z',
      },
    ];
    const rows = assembleRows([], durable, [], sse);
    expect(rows[0].tokens).toBe(4200);
  });

  it('buildRunDetail (SSE-only run) reports unknown tokens when no event carried tokensUsed', () => {
    const detail = buildRunDetail(
      [],
      [],
      [agentEvent({ id: 'e1', missionId: 'sse-run', type: 'agent.started', sequence: 1, data: { prompt: 'Go' } })],
      'sse-run'
    );
    expect(detail?.tokens).toBeUndefined();
  });
});

// ============================================================================
// Review fixes — fabricated-zero stragglers and hostile event payloads found
// by the adversarial pass: every mission-doc surface reads the ONE snapshot,
// and SSE token extraction never turns null/garbage into a number.
// ============================================================================

describe('review pass — remaining fabricated values', () => {
  it('rowsFromRunningMissions: a running research mission with no persisted tokenUsage has unknown tokens, not 0', () => {
    const [mapped] = rowsFromRunningMissions([
      mission({ kind: 'research', status: 'running', tokenUsage: undefined, executionStartedAt: undefined }),
    ]);
    expect(mapped.tokens).toBeUndefined();
  });

  it('liveRowsFromEvents: a null tokensUsed payload is unknown, never Number(null)=0', () => {
    const [row] = liveRowsFromEvents([
      agentEvent({ id: 'e1', missionId: 'm1', type: 'agent.thinking', sequence: 1, data: { tokensUsed: null } }),
    ]);
    expect(row.tokens).toBeUndefined();
  });

  it('liveRowsFromEvents: a non-numeric tokensUsed payload is unknown, never NaN', () => {
    const [row] = liveRowsFromEvents([
      agentEvent({ id: 'e1', missionId: 'm1', type: 'agent.thinking', sequence: 1, data: { tokensUsed: 'lots' } }),
    ]);
    expect(row.tokens).toBeUndefined();
  });

  it.each([-1, 1.5])('liveRowsFromEvents: invalid token count %p remains unknown', (tokensUsed) => {
    const [row] = liveRowsFromEvents([
      agentEvent({ id: 'e1', missionId: 'm1', type: 'agent.thinking', sequence: 1, data: { tokensUsed } }),
    ]);
    expect(row.tokens).toBeUndefined();
  });

  it('rowsFromAgentLog: a legacy history doc with no tokenUsage renders unknown tokens instead of crashing', () => {
    const legacy = agentLogEntry();
    delete (legacy as Partial<AgentLogEntry>).tokenUsage;
    const [mapped] = rowsFromAgentLog([legacy]);
    expect(mapped.tokens).toBeUndefined();
  });

  it('buildRunDetail (history): a legacy doc with no tokenUsage resolves with unknown tokens instead of crashing', () => {
    const legacy = agentLogEntry();
    delete (legacy as Partial<AgentLogEntry>).tokenUsage;
    const detail = buildRunDetail([legacy], [], [], 'run-1');
    expect(detail?.tokens).toBeUndefined();
  });

  it('missionToLogEntry: no persisted tokenUsage stays absent — the AgentLog fallback must not show "0 tokens" under a Details card saying Unavailable', () => {
    const entry = missionToLogEntry(mission({ status: 'failed', tokenUsage: undefined }));
    expect(entry.tokenUsage).toBeUndefined();
  });

  it('missionToLogEntry: persisted usage passes through unchanged', () => {
    const entry = missionToLogEntry(
      mission({ status: 'completed', completedAt: '2026-05-09T09:05:00.000Z', tokenUsage: { input: 10, output: 5 } })
    );
    expect(entry.tokenUsage).toEqual({ input: 10, output: 5 });
  });
});

// ============================================================================
// ARUN-020 — list/detail token agreement across the live→terminal handoff.
//
// Two independent divergences were reachable before this lane:
//   1. `assembleRows` lends a live SSE `tokensUsed` into the LIST row, while the
//      run DETAIL read only the durable mission doc. An in-flight build showed
//      the heartbeat count in the list and the lower/unknown persisted count in
//      its detail.
//   2. A chat AgentRun's usage is published twice (create, then the
//      receipt-derived patch). Those writes used different bases, so a run could
//      state 115 tokens and then silently restate 109. Fixed at the source in
//      `lib/ai/chat-accounting.ts`; here we pin that the READ rule is shared and
//      that an unreported/partial provenance reaches both surfaces identically.
// ============================================================================

describe('ARUN-020 — list and detail agree across the live→terminal handoff', () => {
  const heartbeat = (tokens: number, sequence: number): AgentEvent =>
    agentEvent({
      id: `evt-hb-${sequence}`,
      type: 'agent.thinking',
      missionId: 'build-1',
      sequence,
      data: { tokensUsed: tokens },
    });

  it('lends the SAME live heartbeat count to the list row and the detail', () => {
    const inFlight = mission({ status: 'running', tokenUsage: { input: 60, output: 40 } });
    const events = [heartbeat(115, 2)];

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [inFlight], events, 'build-1', events);

    expect(listRows).toHaveLength(1);
    expect(listRows[0].tokens).toBe(115);
    expect(detail?.tokens).toBe(115);
    expect(detail?.tokens).toBe(listRows[0].tokens);
  });

  it('adopts the live count on both surfaces when the mission doc has none yet', () => {
    const inFlight = mission({ status: 'running', tokenUsage: undefined });
    const events = [heartbeat(42, 2)];

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [inFlight], events, 'build-1', events);

    expect(listRows[0].tokens).toBe(42);
    expect(detail?.tokens).toBe(42);
  });

  it('never regresses a durable total that already exceeds the last heartbeat', () => {
    const inFlight = mission({ status: 'running', tokenUsage: { input: 200, output: 100 } });
    const events = [heartbeat(115, 2)];

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [inFlight], events, 'build-1', events);

    expect(listRows[0].tokens).toBe(300);
    expect(detail?.tokens).toBe(300);
  });

  it('stops lending once the run is terminal — both surfaces show the durable total', () => {
    const done = mission({
      status: 'completed',
      completedAt: '2026-05-09T09:05:00.000Z',
      tokenUsage: { input: 60, output: 49 },
    });
    const events = [
      heartbeat(115, 2),
      agentEvent({ id: 'evt-done', type: 'agent.completed', missionId: 'build-1', sequence: 3, data: {} }),
    ];

    const listRows = assembleRows([], rowsFromBuildMissions([done]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [done], events, 'build-1', events);

    // `liveRowsFromEvents` emits nothing for a group that has seen its own
    // completion, so the list stops lending too — both read the durable 109.
    expect(listRows).toHaveLength(1);
    expect(listRows[0].tokens).toBe(109);
    expect(detail?.tokens).toBe(109);
  });

  it('is stable on replay — re-resolving the same inputs never accumulates the lend', () => {
    const inFlight = mission({ status: 'running', tokenUsage: { input: 60, output: 40 } });
    const events = [heartbeat(115, 2)];

    const first = buildRunDetail([], [inFlight], events, 'build-1', events);
    const second = buildRunDetail([], [inFlight], events, 'build-1', events);
    const listOnce = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const listTwice = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));

    expect(second?.tokens).toBe(first?.tokens);
    expect(listTwice[0].tokens).toBe(listOnce[0].tokens);
    expect(first?.tokens).toBe(115);
  });

  it('ignores a malformed heartbeat payload on both surfaces rather than reading it as 0', () => {
    const inFlight = mission({ status: 'running', tokenUsage: { input: 60, output: 40 } });
    const events = [
      agentEvent({
        id: 'evt-hb-bad',
        type: 'agent.thinking',
        missionId: 'build-1',
        sequence: 2,
        data: { tokensUsed: null },
      }),
    ];

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [inFlight], events, 'build-1', events);

    expect(listRows[0].tokens).toBe(100);
    expect(detail?.tokens).toBe(100);
  });

  it('renders an unreported chat total as unknown on BOTH surfaces, never as 0 tokens', () => {
    const chat = agentLogEntry({
      id: 'run-chat-1',
      kind: 'chat',
      agentName: 'chat',
      tokenUsage: { input: 0, output: 0 },
      tokenUsageProvenance: 'unreported',
    });

    const [listRow] = rowsFromAgentLog([chat]);
    const detail = buildRunDetail([chat], [], [], 'run-chat-1');

    expect(listRow.tokens).toBeUndefined();
    expect(detail?.tokens).toBeUndefined();
  });

  it('marks a partially-reported chat total as a lower bound on BOTH surfaces', () => {
    const chat = agentLogEntry({
      id: 'run-chat-2',
      kind: 'chat',
      agentName: 'chat',
      tokenUsage: { input: 100, output: 9 },
      tokenUsageProvenance: 'partially-reported',
    });

    const [listRow] = rowsFromAgentLog([chat]);
    const detail = buildRunDetail([chat], [], [], 'run-chat-2');

    expect(listRow.tokens).toBe(109);
    expect(detail?.tokens).toBe(109);
    expect(listRow.tokensPartiallyReported).toBe(true);
    expect(detail?.tokensPartiallyReported).toBe(true);
  });

  it('does not lend a heartbeat to a terminal history run (the list cannot, so the detail must not)', () => {
    // Agent-events are keyed by missionId; a history row's id is its AgentRun
    // doc id, so `assembleRows` can never match an SSE row to it. The detail
    // must apply the same rule or it invents the divergence in reverse.
    const entry = agentLogEntry({
      id: 'run-mission-1',
      missionId: 'mission-1',
      tokenUsage: { input: 60, output: 49 },
      tokenUsageProvenance: 'provider-reported',
    });
    const events = [
      agentEvent({
        id: 'evt-hb-stale',
        type: 'agent.thinking',
        missionId: 'mission-1',
        sequence: 2,
        data: { tokensUsed: 999 },
      }),
    ];

    const listRows = assembleRows(
      rowsFromAgentLog([entry]),
      [],
      [],
      liveRowsFromEvents(events),
      settledRunScopeIds([entry])
    );
    const detail = buildRunDetail([entry], [], events, 'run-mission-1', events);

    // Exactly one row: the stale SSE group is suppressed by the durable
    // terminal record, so no phantom "live" row advertises 999 tokens.
    expect(listRows).toHaveLength(1);
    expect(listRows[0].tokens).toBe(109);
    expect(listRows[0].status).toBe('success');
    expect(detail?.tokens).toBe(109);
  });

  it('resolves the mission id of a settled run to its terminal record, not a live view', () => {
    const entry = agentLogEntry({
      id: 'run-mission-1',
      missionId: 'mission-1',
      tokenUsage: { input: 60, output: 49 },
      tokenUsageProvenance: 'provider-reported',
    });
    const events = [
      agentEvent({
        id: 'evt-hb-stale',
        type: 'agent.thinking',
        missionId: 'mission-1',
        sequence: 2,
        data: { tokensUsed: 999 },
      }),
    ];

    const detail = buildRunDetail([entry], [], events, 'mission-1', events);
    expect(detail?.id).toBe('run-mission-1');
    expect(detail?.isLive).toBe(false);
    expect(detail?.tokens).toBe(109);
  });

  it('leaves a genuinely unknown SSE-only run addressable while nothing durable exists', () => {
    const events = [
      agentEvent({ id: 'evt-a', type: 'agent.started', missionId: 'mission-9', sequence: 1, data: { prompt: 'go' } }),
      agentEvent({
        id: 'evt-b',
        type: 'agent.thinking',
        missionId: 'mission-9',
        sequence: 2,
        data: { tokensUsed: 77 },
      }),
    ];
    const listRows = assembleRows([], [], [], liveRowsFromEvents(events), settledRunScopeIds([]));
    const detail = buildRunDetail([], [], events, 'mission-9', events);

    expect(listRows).toHaveLength(1);
    expect(listRows[0].tokens).toBe(77);
    expect(detail?.tokens).toBe(77);
    expect(detail?.isLive).toBe(true);
  });
});

// ============================================================================
// ARUN-020 — the DURABLE in-flight token count.
//
// The mission worker persists its running COST every five tool calls so a
// mid-run reader is not shown $0. The equivalent token count lived only on the
// ephemeral `agent.thinking` heartbeat, so the list (which subscribes to that
// stream) could lend a number the run detail had no way to reproduce after a
// reload or a navigation. `runningTokensUsed` makes it durable.
// ============================================================================

describe('ARUN-020 — durable running token total', () => {
  it('shows the persisted running total on both surfaces with NO live stream at all', () => {
    const inFlight = mission({ status: 'running', tokenUsage: undefined, runningTokensUsed: 115 } as Partial<Mission>);

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], [], settledRunScopeIds([]));
    const detail = buildRunDetail([], [inFlight], [], 'build-1', []);

    expect(listRows[0].tokens).toBe(115);
    expect(detail?.tokens).toBe(115);
    // Real and durable, but still moving — marked, never presented as terminal.
    expect(listRows[0].tokensProvisional).toBe(true);
    expect(detail?.tokensProvisional).toBe(true);
  });

  it('lets a finalized tokenUsage supersede the running total', () => {
    const done = mission({
      status: 'completed',
      completedAt: '2026-05-09T09:05:00.000Z',
      runningTokensUsed: 115,
      tokenUsage: { input: 100, output: 9 },
    } as Partial<Mission>);

    const [row] = rowsFromBuildMissions([done]);
    expect(row.tokens).toBe(109);
    expect(row.tokensProvisional).toBeUndefined();
  });

  it('keeps an unknown count unknown when neither a running nor a final total exists', () => {
    const inFlight = mission({ status: 'running', tokenUsage: undefined });
    const [row] = rowsFromBuildMissions([inFlight]);
    const detail = buildRunDetail([], [inFlight], [], 'build-1', []);
    expect(row.tokens).toBeUndefined();
    expect(detail?.tokens).toBeUndefined();
  });

  it('never lets the durable running total contribute to the additive input/output buckets', () => {
    // Those buckets feed the daily aggregates, which must not count an
    // in-flight figure that the terminal write will restate.
    const snapshot = missionUsageSnapshot({
      kind: 'report',
      tokenUsage: undefined,
      costUsd: undefined,
      runningTokensUsed: 115,
    } as never);
    expect(snapshot.tokens).toBe(115);
    expect(snapshot.tokensProvisional).toBe(true);
    expect(snapshot.input).toBe(0);
    expect(snapshot.output).toBe(0);
  });

  it('never regresses the durable running total below an even newer heartbeat', () => {
    const inFlight = mission({ status: 'running', tokenUsage: undefined, runningTokensUsed: 115 } as Partial<Mission>);
    const events = [
      agentEvent({
        id: 'evt-hb-newer',
        type: 'agent.thinking',
        missionId: 'build-1',
        sequence: 9,
        data: { tokensUsed: 140 },
      }),
    ];

    const listRows = assembleRows([], rowsFromBuildMissions([inFlight]), [], liveRowsFromEvents(events));
    const detail = buildRunDetail([], [inFlight], events, 'build-1', events);

    expect(listRows[0].tokens).toBe(140);
    expect(detail?.tokens).toBe(140);
  });
});
