/**
 * @file app/agents/runs/runs-table-rows.ts
 * @description Row-assembly helpers for `/agents/runs` — maps the existing
 * run-history / build-mission / event-stream hooks onto the `RunsTable`
 * interface contract. Presentation-layer only: no new backend, no new
 * Firestore/Neo4j reads. Extracted from `page.tsx` (Task 21 follow-up, Minor
 * finding) so each mapper gets direct unit coverage instead of only
 * indirect page-mount coverage.
 */

import type { AgentRunKind, AgentRunQuality, AgentRunRow, AgentRunStatus } from '@/components/activity/RunsTable';
import type { AgentLogEntry } from '@/hooks/useAgentActivity';
import { agentLogDurationMs } from '@/lib/agent-run-duration';
import { agentRunUsageSnapshot, reconcileRunTokens } from '@/lib/agent-run-usage';
import { missionDurationMs, missionUsageSnapshot } from '@/lib/mission-usage';
import { ARTIFACT_KIND_BADGE, artifactKindOf, hasArtifactOutput } from '@/lib/artifact-output-ui';
import { missionTitle } from '@/lib/build-mission-ui';
import type { AgentEvent } from '@/lib/schemas/agent-event';
import type { Mission } from '@/lib/schemas/mission';
import type { Report } from '@/lib/schemas/report';
import { selectCanonicalMissionReport } from '@/lib/reports/select-canonical-report';
import { inferAgentRunKind, inferAgentRunProvider } from '@/lib/schemas/agent-run';

export function qualityFromReport(report?: AgentLogEntry['qualityReport']): AgentRunRow['quality'] | undefined {
  if (!report) return undefined;
  return {
    passed: report.checks.filter((c) => c.pass).length,
    total: report.checks.length,
    score: Math.round(report.overallScore * 100),
    l1: report.verdict,
  };
}

function buildMissionCostDisplay(
  usage: ReturnType<typeof missionUsageSnapshot>
): Pick<AgentRunRow, 'costUsd' | 'costState' | 'costUnavailable' | 'costUnavailableReason'> {
  const reserved = usage.reservedCostUsd ?? 0;
  const unsettled = usage.unsettledMaximumUsd ?? 0;
  const tracked = usage.costUsd ?? 0;
  if (usage.maximumExposureUsd !== undefined && usage.maximumExposureUsd > 0 && (reserved > 0 || unsettled > 0)) {
    return {
      costUsd: usage.maximumExposureUsd,
      costState: tracked === 0 && reserved > 0 && unsettled === 0 ? 'reserved' : 'maximum-exposure',
      costUnavailable: false,
    };
  }

  // A partial tracked amount without a bounded maximum is not a complete
  // headline. Keep it out instead of presenting a lower bound as precise.
  if (usage.costUnavailable || usage.costUsd === undefined) {
    // ARUN-027: the reason comes from the ONE usage-read rule, which sets it
    // only when accounting EXISTS and is provably partial. A mission with no
    // accounting basis at all stays a plain "Unavailable" — claiming lost
    // receipts for every legacy row would cry wolf.
    return {
      costUnavailable: true,
      ...(usage.costUnavailableReason ? { costUnavailableReason: usage.costUnavailableReason } : {}),
    };
  }

  const settled = usage.settledCostUsd ?? 0;
  const estimated = usage.estimatedCostUsd ?? 0;
  const costState: NonNullable<AgentRunRow['costState']> =
    settled > 0 && estimated > 0 ? 'mixed' : estimated > 0 ? 'estimated' : 'settled';
  return {
    costUsd: usage.costUsd,
    costState,
    costUnavailable: false,
  };
}

/** Completed run source. New rows carry an explicit kind; legacy rows are
 * classified conservatively from their lifecycle identifiers/agent name. */
export function rowsFromAgentLog(entries: AgentLogEntry[]): AgentRunRow[] {
  return entries.map((entry) => {
    const kind = inferAgentRunKind(entry);
    // ARUN-020: the ONE AgentRun usage read rule, shared with the run detail,
    // the AgentLog fallback and the daily/by-agent aggregates.
    const usage = agentRunUsageSnapshot(entry);
    return {
      id: entry.id,
      agent: entry.agentName,
      provider: inferAgentRunProvider({ ...entry, kind }),
      model: entry.model,
      mission: entry.action,
      kind,
      status: entry.status,
      quality: qualityFromReport(entry.qualityReport),
      costUsd: entry.costUsd,
      // ARUN-027: an amount whose authority was never recorded is shown WITHOUT
      // a suffix. The previous `?? 'settled'` asserted a provider confirmation
      // that legacy rows never had.
      costState: entry.costUsd === undefined ? undefined : entry.costState,
      costUnavailable: entry.costUsd === undefined,
      // The persisted reason distinguishes an unpriceable model from a ledger
      // that provably lost receipts. It was recorded on every AgentRun and read
      // by nothing until now.
      ...(entry.costUnavailableReason ? { costUnavailableReason: entry.costUnavailableReason } : {}),
      // Guarded — a legacy doc can reach the client without tokenUsage
      // (normalizeAgentRunForRead does not schema-validate); unknown renders
      // "—", and the page must not crash on it. A provider that reported NO
      // usage is equally unknown, never a measured 0.
      tokens: usage.tokens,
      ...(usage.partiallyReported ? { tokensPartiallyReported: true } : {}),
      // ARUN-008/ARUN-010: fallback rows and legacy replay-collapsed mission
      // durations surface "—" (undefined) instead of a fabricated 0ms.
      durationMs: agentLogDurationMs(entry),
      startedAt: entry.createdAt,
    };
  });
}

/** Builds-tab source: kind 'build' missions, including in-flight ones (which
 * get the 'live' status pill so build visibility isn't lost mid-sprint). */
export function rowsFromBuildMissions(missions: Mission[]): AgentRunRow[] {
  return missions.map((mission) => {
    const inFlight = mission.status === 'running' || mission.status === 'pending';
    // AUDIT-006 — a build parked at a human gate is NOT healthily "Live". The
    // supervisor is blocked at `step.waitForEvent` and will auto-deny after
    // `gates.timeoutHours` (24h) if nobody acts, so a plain Live pill actively
    // misleads: it says "working" about a run that is waiting on the reader.
    // Surface it as `blocked` so the row drives the user into the detail page,
    // where the governance card can actually resolve the gate.
    const awaitingHuman =
      mission.buildState === 'awaiting-budget' ||
      mission.buildState === 'awaiting-stall' ||
      mission.buildState === 'awaiting-approval';
    // ARUN-007/ARUN-020: honesty over fabrication — the ONE authoritative
    // usage/duration derivation (shared with detail + daily aggregates). No
    // persisted tokenUsage → UNKNOWN tokens (renders "—"), not 0; a terminal
    // mission without completedAt has an unknowable duration, not 0ms.
    const usage = missionUsageSnapshot(mission);
    const durationMs = missionDurationMs(mission);
    return {
      id: mission.id,
      agent: mission.agent,
      mission: missionTitle(mission),
      kind: 'build' as AgentRunKind,
      status: (inFlight && awaitingHuman
        ? 'blocked'
        : inFlight
          ? 'live'
          : mission.status === 'completed'
            ? 'success'
            : 'failure') as AgentRunStatus,
      quality: qualityFromReport(mission.qualityReport),
      ...buildMissionCostDisplay(usage),
      // ARUN-020: the durable running total (persisted every five tool calls)
      // is now part of the snapshot, so the list no longer depends on an
      // ephemeral heartbeat the detail cannot reproduce.
      tokens: usage.tokens,
      ...(usage.tokensProvisional ? { tokensProvisional: true } : {}),
      durationMs,
      startedAt: mission.createdAt,
    };
  });
}

/**
 * Live-tab DURABLE source for research/report missions (ARUN-001). In-flight
 * (running/pending) non-build missions are persisted as `Mission` docs the
 * same way builds are, so — unlike the ephemeral SSE `liveRowsFromEvents` —
 * these rows survive a reload and render one row per concurrent run. Build
 * missions are intentionally excluded: they have the richer
 * `rowsFromBuildMissions` source, the caller's `getRunningMissions` read
 * already filters `kind === 'build'` out, and this mapper does not re-add them.
 *
 * `completedHistory` is passed so a mission that has JUST completed — its
 * `AgentRun` history doc already written while a ≤5 s running-missions poll
 * still returns the stale `running` doc — is dropped here (history wins),
 * preventing a transient duplicate during the running→completed handoff.
 * History entries carry `missionId`; a running row's id IS that missionId.
 *
 * Duration semantics (ARUN-009): live rows show EXECUTION-only age from the
 * persisted post-dequeue `executionStartedAt`, matching the terminal AgentRun
 * duration contract — so the visible value grows monotonically into the
 * persisted one instead of shrinking when queue wait was relabeled. A mission
 * still queued (or a legacy doc without the stamp) shows "—" (undefined):
 * nothing has executed yet, and inventing an elapsed time would repeat the
 * old lie.
 */
export function rowsFromRunningMissions(missions: Mission[], completedHistory: AgentLogEntry[] = []): AgentRunRow[] {
  const completedMissionIds = new Set(
    completedHistory.map((e) => e.missionId).filter((id): id is string => Boolean(id))
  );
  return missions
    .filter((mission) => mission.kind !== 'build' && !completedMissionIds.has(mission.id))
    .map((mission) => ({
      id: mission.id,
      agent: mission.agent,
      mission: missionTitle(mission),
      kind: 'mission' as AgentRunKind,
      status: 'live' as AgentRunStatus,
      // ARUN-020: the persisted running total when the worker has written one;
      // otherwise unknown stays unknown (renders "—") until the SSE heartbeat
      // lends a real count via mergeLive — a fabricated 0 here would also
      // block that lend (defined 0 wins over undefined in the merge).
      tokens: missionUsageSnapshot(mission).tokens,
      ...(missionUsageSnapshot(mission).tokensProvisional ? { tokensProvisional: true } : {}),
      durationMs: mission.executionStartedAt ? Date.now() - new Date(mission.executionStartedAt).getTime() : undefined,
      startedAt: mission.createdAt,
    }));
}

/**
 * Live-tab SSE source, grouped per run (ARUN-001). The pre-fix single-row form
 * collapsed ALL concurrent runs into one row and — because it suppressed on
 * ANY completion event in the flat window — let one run finishing hide a
 * sibling that was still live. This groups events by their durable run id
 * (`missionId ?? sweepId`) and emits one live row per group that has NOT seen
 * its OWN completion, so concurrent runs render as distinct rows and a
 * sibling's completion never suppresses a still-running row.
 *
 * Title is recovered from the group's own `agent.started` event (which carries
 * the prompt) rather than the latest event, which may be a promptless
 * heartbeat. These rows are deduped against the durable sources in
 * `assembleRows` (the polled mission/build row wins; this only augments live
 * status), so a run known durably never double-renders.
 */
/**
 * The latest genuinely-numeric `tokensUsed` across a run's events, newest
 * first, or undefined when no heartbeat carried a usable count (ARUN-020 —
 * unknown stays unknown; `null`/garbage payloads must never become
 * `Number(null) === 0` or NaN). One helper for both extraction sites so the
 * list and detail can't drift.
 */
export function latestTokensUsed(eventsNewestFirst: AgentEvent[]): number | undefined {
  for (const event of eventsNewestFirst) {
    const raw = (event.data as Record<string, unknown>)?.tokensUsed;
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  }
  return undefined;
}

export function liveRowsFromEvents(events: AgentEvent[]): AgentRunRow[] {
  const groups = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const id = event.missionId ?? event.sweepId;
    if (!id) continue; // unattributable to a run — skip
    const bucket = groups.get(id);
    if (bucket) bucket.push(event);
    else groups.set(id, [event]);
  }

  const rows: AgentRunRow[] = [];
  for (const [id, group] of groups) {
    if (group.some((e) => e.type === 'agent.completed' || e.type === 'agent.error')) continue;

    const first = group[0];
    const latest = group[group.length - 1];
    const reversed = [...group].reverse();
    const started = group.find((e) => e.type === 'agent.started');
    const startedPrompt = (started?.data as Record<string, unknown> | undefined)?.prompt;
    const latestPrompt = (latest.data as Record<string, unknown>)?.prompt;
    const prompt =
      (typeof startedPrompt === 'string' && startedPrompt) || (typeof latestPrompt === 'string' && latestPrompt) || '';
    const tokens = latestTokensUsed(reversed);
    const agentType = reversed.find((e) => e.agentType)?.agentType ?? 'agent';

    rows.push({
      id,
      agent: agentType,
      mission: prompt.length > 0 ? prompt : 'Live run in progress',
      kind: group.some((e) => e.sweepId) ? 'sweep' : 'mission',
      status: 'live',
      tokens,
      durationMs: new Date(latest.timestamp).getTime() - new Date(first.timestamp).getTime(),
      startedAt: first.timestamp,
    });
  }
  return rows;
}

/**
 * The sequence number of the most recent completion event (`agent.completed`
 * or `agent.error`) in the stream, or 0 if none. The `/agents/runs` page uses
 * this as an effect trigger (ARUN-001): when it increases, a run just finished,
 * so the page refetches the AgentRun history feed — which `useAgentLog`
 * otherwise never refreshes (staleTime 30s, no interval) — to surface the
 * completed run and let `rowsFromRunningMissions` drop its now-stale running row
 * without a mid-session gap. Sequence is server-assigned and monotonic, so a
 * strictly higher value means a genuinely newer completion.
 */
export function latestCompletionSequence(events: AgentEvent[]): number {
  return events.reduce(
    (max, e) => (e.type === 'agent.completed' || e.type === 'agent.error' ? Math.max(max, e.sequence) : max),
    0
  );
}

/**
 * Live rows pinned to the top (newest-first), then everything else
 * newest-first, from FOUR sources with a single cross-source dedup (ARUN-001).
 *
 * Two durable, polled sources surface in-flight runs that survive a reload:
 * `buildRows` (kind 'build') and `runningMissionRows` (research/report). The
 * ephemeral `liveStreamRows` (grouped SSE, one per run) only ADD runs no
 * durable source already covers — the polled row is richer (kind, quality,
 * tokens), so it always wins on an id collision; a matched SSE id merely
 * promotes its durable row to 'live' so an in-flight run never renders stale
 * while a slower poll catches up.
 *
 * Durable sources are themselves deduped by id in precedence order
 * (history > build > runningMission) so a run seen in two of them during a
 * poll-timing handoff renders exactly once.
 *
 * `settledRunIds` (ARUN-020) closes the last gap in that dedup. Agent-events are
 * keyed by `missionId`/`sweepId`, but a completed run's history row is keyed by
 * its `AgentRun` doc id, so an id match can never suppress the SSE group — and
 * `liveRowsFromEvents` only self-suppresses once it has seen the run's OWN
 * completion event. A run whose history row has landed while its completion
 * event has not therefore rendered TWICE: the terminal row with its final
 * total, plus a phantom "live" row still advertising the last heartbeat count.
 * `rowsFromRunningMissions` already applies exactly this history-wins guard;
 * this extends it to the SSE source. Defaults to empty, i.e. prior behaviour.
 */
export function assembleRows(
  historyRows: AgentRunRow[],
  buildRows: AgentRunRow[],
  runningMissionRows: AgentRunRow[],
  liveStreamRows: AgentRunRow[],
  settledRunIds: ReadonlySet<string> = new Set()
): AgentRunRow[] {
  const liveStreamById = new Map(liveStreamRows.map((r) => [r.id, r]));
  const mergeLive = (r: AgentRunRow): AgentRunRow => {
    const sse = liveStreamById.get(r.id);
    if (!sse) return r;
    // A matched SSE row promotes the durable row to 'live' AND lends its live
    // token count. A research/report mission doc only gets tokenUsage written at
    // completion, so its durable running row reads 0 mid-run; MISSION-001 puts
    // the real running count on the SSE heartbeat, and this is where it gets
    // read. max() never regresses a count the durable row already has (e.g. the
    // final total landing just before the last heartbeat); a durable row with
    // NO persisted count adopts the live one. When NEITHER side knows a count
    // (ARUN-020), the merged row stays unknown — never a fabricated 0.
    const tokens = reconcileRunTokens(r.tokens, sse.tokens);
    return { ...r, status: 'live' as AgentRunStatus, tokens };
  };

  const durable: AgentRunRow[] = [];
  const durableIds = new Set<string>();
  for (const r of [...historyRows, ...buildRows, ...runningMissionRows]) {
    if (durableIds.has(r.id)) continue;
    durableIds.add(r.id);
    durable.push(mergeLive(r));
  }

  // SSE-only runs: those no durable source already covers (a matched id has
  // already promoted its durable row above), minus any whose run has already
  // reached a durable terminal record under a different id (see above).
  const freshLive = liveStreamRows.filter((r) => !durableIds.has(r.id) && !settledRunIds.has(r.id));

  const byStartedDesc = (a: AgentRunRow, b: AgentRunRow) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();

  const live = [...durable.filter((r) => r.status === 'live'), ...freshLive].sort(byStartedDesc);
  const rest = durable.filter((r) => r.status !== 'live').sort(byStartedDesc);
  return [...live, ...rest];
}

// ============================================================================
// RUN DETAIL (Task 22 / P-F1 part 2) — resolves a single run by id from the
// same three sources the list page assembles rows from, plus the richer
// fields (quality checks, errors, cost, the scoped event window) the table
// row shape intentionally drops.
// ============================================================================

/** A one-item-shaped view of a Mission, matching `AgentLogEntry` field for
 * field, so the run detail page can reuse `<AgentLog entries={[...]} />`'s
 * rendering (skills fired, quality checks, judge dimensions, attachments,
 * errors) for a *completed* build run instead of re-implementing it. Callers
 * must only invoke this once `mission.status` has left running/pending —
 * `AgentLogEntryStatus` has no 'live' member to represent an in-flight run. */
export function missionToLogEntry(mission: Mission): AgentLogEntry {
  const cost = buildMissionCostDisplay(missionUsageSnapshot(mission));
  return {
    id: mission.id,
    agentName: mission.agent,
    action: mission.prompt,
    status: mission.status === 'completed' ? 'success' : 'failure',
    missionId: mission.id,
    // ARUN-020: unpersisted usage stays ABSENT — the AgentLog fallback must
    // not say "0 tokens" under a Details card saying Unavailable.
    tokenUsage: mission.tokenUsage ? { input: mission.tokenUsage.input, output: mission.tokenUsage.output } : undefined,
    // ARUN-007: one shared duration rule (missionDurationMs); a terminal
    // mission with no completedAt stamp is unknowable — flagged so renderers
    // show "—" instead of a fabricated 0ms.
    duration: missionDurationMs(mission) ?? 0,
    ...(mission.completedAt ? {} : { durationUnknown: true }),
    errors: mission.errors,
    ...(cost.costUsd !== undefined
      ? { costUsd: cost.costUsd, costState: cost.costState }
      : { ...(cost.costUnavailableReason ? { costUnavailableReason: cost.costUnavailableReason } : {}) }),
    createdAt: mission.createdAt,
    partial: mission.partial ?? undefined,
    partialCheckpointTurn: mission.partialCheckpointTurn ?? undefined,
    skillInvocations: mission.skillInvocations,
    qualityReport: mission.qualityReport,
    qualityJudgement: mission.qualityJudgement,
    // REPORT-018 — the composed verdict the activity log leads with.
    qualityVerdict: mission.qualityVerdict,
    attachments: mission.attachments,
    chainId: mission.chainId,
    chainStep: mission.chainStep,
    chainTotalSteps: mission.chainTotalSteps,
  };
}

export interface RunDetailData {
  id: string;
  agent: string;
  provider?: AgentLogEntry['provider'];
  model?: string;
  /** ARUN-007: distinct persisted per-session models of a build run, in
   * first-seen order. Undefined for non-build runs and for builds whose
   * session summaries carry no model. */
  models?: string[];
  mission: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  /** ISO 8601 */
  startedAt: string;
  durationMs: number | undefined;
  /** Undefined when no token count was persisted for the run (ARUN-007). */
  tokens: number | undefined;
  /** ARUN-020 — the total is a proven lower bound (some response reported no usage). */
  tokensPartiallyReported?: boolean;
  /** ARUN-020 — a RUNNING total for an in-flight mission, not a terminal one. */
  tokensProvisional?: boolean;
  costUsd?: number;
  /** Receipt-derived estimates are visibly distinct from settled/legacy cost. */
  costState?: AgentLogEntry['costState'];
  /**
   * True when this run's cost WAS looked up and nothing provable came back —
   * distinct from an SSE-only live run that has simply not asserted a cost yet
   * (which leaves this undefined and renders an em dash).
   */
  costUnavailable?: boolean;
  /** ARUN-027 — why no amount is stated (unpriceable model vs lost receipts). */
  costUnavailableReason?: AgentLogEntry['costUnavailableReason'];
  quality?: AgentRunQuality;
  qualityChecks?: Array<{ name: string; pass: boolean; critical: boolean; detail: string }>;
  errors?: string[];
  /** The run's full log-entry-shaped record (a history entry, or a
   * completed build mission mapped via `missionToLogEntry`). Rendered via
   * `<AgentLog entries={[logEntry]} />` as the Event Log fallback when the
   * step history is empty (24h `_ttl` expired). Undefined while the run is
   * only known through the live SSE stream (no Firestore doc yet). */
  logEntry?: AgentLogEntry;
  /** True while no completion/error event has been observed for this run
   * and it isn't otherwise known (via history/build data) to have finished. */
  isLive: boolean;
  /** Events scoped to this run's id (by `missionId`/`sweepId`) — the
   * caller passes the merged persisted-history + live-SSE set (see
   * `mergeRunEvents`), so this is the run's full step list: complete
   * history for finished runs, history-seed + live tail for in-flight. */
  events: AgentEvent[];
}

/**
 * The id agent-events are actually keyed by for a given run. Events carry
 * `missionId`/`sweepId` — NOT the `AgentRun` doc id (`run-…`, generated in
 * `lib/agent-runs.ts`). So for a history run the event scope is the entry's
 * `missionId` (or `sweepId` for sweep-spawned runs); build missions and
 * SSE-only runs already use the mission/sweep id as the run id itself.
 * The page uses this to decide which id to fetch persisted history for.
 *
 * Returns `undefined` — a genuinely unresolvable scope — when the matched
 * history entry carries NEITHER `missionId` nor `sweepId` (e.g. a chat run
 * or a sweep-cycle summary entry): such runs never emitted scoped
 * agent-events at all, so there is no id worth fetching. The page must
 * treat this differently from a scope that resolved but came back with an
 * empty (or 24h-TTL-expired) history — see the two distinct notes rendered
 * in `src/app/agents/runs/[id]/page.tsx`.
 */
/**
 * The event-scope ids of runs that already have a DURABLE terminal record
 * (ARUN-020). `rowsFromAgentLog`'s source only ever holds finished runs, so any
 * `missionId`/`sweepId` it carries names a run whose live SSE group is stale.
 */
export function settledRunScopeIds(entries: AgentLogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.missionId) ids.add(entry.missionId);
    if (entry.sweepId) ids.add(entry.sweepId);
  }
  return ids;
}

export function runEventScopeId(entries: AgentLogEntry[], runId: string): string | undefined {
  const entry = entries.find((e) => e.id === runId);
  if (entry) {
    return entry.missionId ?? entry.sweepId ?? undefined;
  }
  // No matching history entry — a build mission or an SSE-only run, both of
  // which use the mission/sweep id as the run id itself.
  return runId;
}

/**
 * Resolves one run's full detail by id across the three sources the list
 * page reads (history entries, build missions, the live SSE stream) — no new
 * backend, mirrors `assembleRows`' source precedence: a completed/failed
 * history entry or build mission (richer, polled data) wins over the raw
 * event stream; a run known ONLY through events (still in flight — its
 * `AgentRun` doc lands on completion, see `lib/agent-runs.ts`) falls back to
 * a live view built from those events. Returns null when the id matches
 * nothing anywhere (genuinely unknown run).
 */
export function buildRunDetail(
  entries: AgentLogEntry[],
  buildMissions: Mission[],
  events: AgentEvent[],
  runId: string,
  /**
   * ARUN-020 — the LIVE SSE tail, for the in-flight token lend ONLY.
   *
   * `events` is the merged persisted-history + live set, which is strictly
   * richer than what the Runs list sees (the list has no per-run history
   * fetch). Lending from it would let the detail out-read the list and simply
   * invert the divergence, so the lend takes the same input the list's
   * `liveRowsFromEvents` takes. The merged set still drives the Event Log.
   */
  liveEvents: AgentEvent[] = []
): RunDetailData | null {
  // ARUN-020: a run addressed by its MISSION id (the id its agent-events and any
  // stale live row use) must still resolve to its durable terminal record rather
  // than falling through to the live-event view below. Only an unambiguous
  // single match counts — a sweep can own several history entries.
  const byMissionId = entries.filter((e) => e.missionId === runId);
  const historyEntry = entries.find((e) => e.id === runId) ?? (byMissionId.length === 1 ? byMissionId[0] : undefined);

  // Events are keyed by missionId/sweepId — for a history run those differ
  // from the AgentRun doc id, so scope-match on every id the run answers to.
  const scopeIds = new Set<string>([runId]);
  if (historyEntry?.missionId) scopeIds.add(historyEntry.missionId);
  if (historyEntry?.sweepId) scopeIds.add(historyEntry.sweepId);
  const runEvents = events.filter(
    (e) =>
      (e.missionId !== undefined && scopeIds.has(e.missionId)) || (e.sweepId !== undefined && scopeIds.has(e.sweepId))
  );
  // ARUN-020 — the SAME live lend `assembleRows` applies to the list row, from
  // the SAME input, so an in-flight run cannot show the heartbeat count in the
  // list and the (lower, or unknown) durable count in its detail.
  //
  // Scoped to exactly where the list lends. `assembleRows` matches an SSE row to
  // a durable row BY ID, and agent-events are keyed by `missionId`/`sweepId`: a
  // build/running mission row's id IS that key, but a history row's id is its
  // `AgentRun` doc id, which no SSE group can match. Lending to a history entry
  // here would therefore invent a divergence in the other direction — and a
  // history entry is terminal by construction, so its durable total is the
  // authority regardless. The `settled` gate mirrors `liveRowsFromEvents`,
  // which emits no live row once a group has seen its own completion.
  const liveRunEvents = liveEvents.filter(
    (e) =>
      (e.missionId !== undefined && scopeIds.has(e.missionId)) || (e.sweepId !== undefined && scopeIds.has(e.sweepId))
  );
  const runSettled = liveRunEvents.some((e) => e.type === 'agent.completed' || e.type === 'agent.error');
  const liveTokens = runSettled ? undefined : latestTokensUsed([...liveRunEvents].reverse());
  if (historyEntry) {
    // ARUN-020: the ONE AgentRun usage read rule, shared with the list rows.
    const usage = agentRunUsageSnapshot(historyEntry);
    const kind = inferAgentRunKind(historyEntry);
    return {
      id: historyEntry.id,
      agent: historyEntry.agentName,
      provider: inferAgentRunProvider({ ...historyEntry, kind }),
      model: historyEntry.model,
      mission: historyEntry.action,
      kind,
      status: historyEntry.status,
      startedAt: historyEntry.createdAt,
      // ARUN-008/010: same honesty rule as the list — fallback rows and legacy
      // replay-collapsed mission durations render "—", not a fabricated 0-4ms.
      durationMs: agentLogDurationMs(historyEntry),
      // Guarded like rowsFromAgentLog — a legacy doc without tokenUsage must
      // resolve (tokens unknown), not crash the detail page.
      tokens: usage.tokens,
      ...(usage.partiallyReported ? { tokensPartiallyReported: true } : {}),
      costUsd: historyEntry.costUsd,
      costState: historyEntry.costState,
      // A durable history entry HAS been checked, so an absent amount is a real
      // "Unavailable" — not the not-yet-asserted em dash an SSE-only row gets.
      costUnavailable: historyEntry.costUsd === undefined,
      ...(historyEntry.costUnavailableReason ? { costUnavailableReason: historyEntry.costUnavailableReason } : {}),
      quality: qualityFromReport(historyEntry.qualityReport),
      qualityChecks: historyEntry.qualityReport?.checks,
      errors: historyEntry.errors,
      logEntry: historyEntry,
      isLive: false,
      events: runEvents,
    };
  }

  const mission = buildMissions.find((m) => m.id === runId);
  if (mission) {
    const inFlight = mission.status === 'running' || mission.status === 'pending';
    // ARUN-007/ARUN-020: the SAME authoritative snapshot the list rows and
    // daily aggregates read — unknown values render "—"/"Unavailable",
    // never a fabricated 0 / 0ms.
    const usage = missionUsageSnapshot(mission);
    const cost = buildMissionCostDisplay(usage);
    // ARUN-020: same live lend as the list row (see `runSettled` above).
    const tokens = reconcileRunTokens(usage.tokens, liveTokens);
    const durationMs = missionDurationMs(mission);
    const tokensProvisional = usage.tokensProvisional || (inFlight && tokens !== undefined);
    // Distinct persisted per-session models, first-seen order — the builder
    // may hand off between models (plan/build/qa stages), so this is a list.
    const sessionModels = [...new Set((mission.sessions ?? []).map((s) => s.model).filter(Boolean))];
    return {
      id: mission.id,
      agent: mission.agent,
      mission: mission.prompt,
      kind: 'build',
      ...(sessionModels.length > 0 ? { models: sessionModels } : {}),
      status: inFlight ? 'live' : mission.status === 'completed' ? 'success' : 'failure',
      startedAt: mission.createdAt,
      durationMs,
      tokens,
      ...(tokensProvisional ? { tokensProvisional: true } : {}),
      ...(cost.costUsd !== undefined
        ? { costUsd: cost.costUsd, costState: cost.costState }
        : // ARUN-027: a build mission's cost HAS been derived, so flag it
          // unavailable and carry WHY, rather than rendering a bare word.
          {
            costUnavailable: true,
            ...(cost.costUnavailableReason ? { costUnavailableReason: cost.costUnavailableReason } : {}),
          }),
      quality: qualityFromReport(mission.qualityReport),
      qualityChecks: mission.qualityReport?.checks,
      errors: mission.errors,
      logEntry: inFlight ? undefined : missionToLogEntry(mission),
      isLive: inFlight,
      events: runEvents,
    };
  }

  // No Firestore-backed record anywhere — only the live SSE stream knows
  // about this id. If it doesn't either, the run genuinely doesn't exist.
  if (runEvents.length === 0) return null;

  const first = runEvents[0];
  const latest = runEvents[runEvents.length - 1];
  const reversed = [...runEvents].reverse();
  const latestCompletion = reversed.find((e) => e.type === 'agent.completed' || e.type === 'agent.error');
  const tokens = latestTokensUsed(reversed);
  const prompt = (first.data as Record<string, unknown>)?.prompt;
  // Not every event in the window carries agentType (e.g. a mid-run
  // agent.thinking heartbeat can omit it) — search back from the latest for
  // whichever event does, rather than assuming the very last one has it.
  const agentType = reversed.find((e) => e.agentType)?.agentType ?? 'agent';

  return {
    id: runId,
    agent: agentType,
    mission: typeof prompt === 'string' && prompt.length > 0 ? prompt : 'Live run in progress',
    kind: (latest.sweepId ?? first.sweepId) ? 'sweep' : 'mission',
    status: latestCompletion ? (latestCompletion.type === 'agent.error' ? 'failure' : 'success') : 'live',
    startedAt: first.timestamp,
    durationMs: new Date(latest.timestamp).getTime() - new Date(first.timestamp).getTime(),
    tokens,
    isLive: !latestCompletion,
    events: runEvents,
  };
}

/**
 * Merge the fetched step history with the live SSE tail for one run:
 * dedup by event id (the SSE stream re-delivers events that are already
 * persisted — the seed and the tail overlap by design), then sort by
 * sequence ascending so the step list reads top-to-bottom in execution
 * order. History wins on id collision (same payload, earlier reference).
 */
export function mergeRunEvents(history: AgentEvent[], live: AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of [...history, ...live]) {
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

// ============================================================================
// RUN OUTPUT (P-F7) — "did this run produce something?" for the aside's
// Output card. Two independent sources, checked separately — a run can
// (rarely) surface both a linked report and a build artifact at once, so
// this returns an array rather than a single-or-null ref.
// ============================================================================

export interface RunOutputRef {
  key: string;
  title: string;
  href: string;
  badge: { label: string; className: string; tint: string };
}

/**
 * Resolves the output(s) a run produced, for the run-detail aside's Output
 * card. Mirrors two established lookups rather than inventing a new one:
 *
 * - **Report**: `AgentLog.tsx`'s `reportsByMission` pattern — a published
 *   Report's `missionId` matched against the run's own `logEntry.missionId`
 *   (set from the persisted history entry, or via `missionToLogEntry` for a
 *   completed build mission — see above). No match while the run is only
 *   known through the live SSE stream (`logEntry` undefined).
 * - **Artifact**: `/artifacts/[id]/page.tsx` resolves a build artifact by
 *   `mission.id === params.id` — the run id for a `kind: 'build'` run IS the
 *   mission id (see `buildRunDetail`), so the inverse (run → its own artifact
 *   page) is the same id, gated on `hasArtifactOutput` actually having
 *   something to show (a running build with no artifact yet renders nothing).
 */
export function resolveRunOutputs(
  run: Pick<RunDetailData, 'id' | 'kind' | 'logEntry'>,
  reports: Report[],
  buildMissions: Mission[],
  ownerId?: string
): RunOutputRef[] {
  const outputs: RunOutputRef[] = [];

  const missionId = run.logEntry?.missionId;
  if (missionId) {
    // REPORT-002: resolve the mission's ONE canonical Report through the shared
    // selector (same deterministic newest-first + id-tiebreaker rule AgentLog
    // and the server's getReportsByMissionIdOwnedBy use), so a multi-report
    // mission never links to an arbitrary Report and this surface always agrees
    // with Activity. `ownerId` is a defensive owner scope over the already
    // owner-scoped /api/reports list.
    const report = selectCanonicalMissionReport(reports, missionId, ownerId);
    if (report) {
      outputs.push({
        key: `report-${report.id}`,
        title: report.title,
        href: `/reports/${report.id}`,
        badge: ARTIFACT_KIND_BADGE.report,
      });
    }
  }

  if (run.kind === 'build') {
    const mission = buildMissions.find((m) => m.id === run.id);
    if (mission && hasArtifactOutput(mission)) {
      outputs.push({
        key: `artifact-${mission.id}`,
        title: missionTitle(mission),
        href: `/artifacts/${mission.id}`,
        badge: ARTIFACT_KIND_BADGE[artifactKindOf(mission)],
      });
    }
  }

  return outputs;
}

/** Human label for one SSE event, used by the run detail page's event list
 * (main content Event Log card). Pure string derivation — icon selection
 * stays in the page component, which owns the lucide-react/JSX dependency. */
export function describeAgentEvent(event: AgentEvent): string {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'agent.started':
      return typeof data.prompt === 'string' && data.prompt.length > 0 ? `Started — ${data.prompt}` : 'Started';
    case 'agent.thinking':
      // MISSION-006 deleted the resume path; no producer emits status:'resuming'
      // anymore (AUDIT-021 removed the dead renderer that pinned that ghost).
      return 'Thinking…';
    case 'agent.tool_call': {
      const toolName = [data.toolName, data.tool].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
      );
      return toolName ? `Called tool: ${toolName.trim()}` : 'Tool call';
    }
    case 'agent.discovery':
      return typeof data.discoveryType === 'string' ? `Discovered a new ${data.discoveryType}` : 'Discovery';
    case 'agent.completed':
      return 'Completed successfully';
    case 'agent.error':
      return typeof data.error === 'string' ? `Error: ${data.error}` : 'Failed';
    case 'sweep.phase':
      return typeof data.phase === 'string' ? `Sweep phase: ${data.phase}` : 'Sweep phase';
    case 'graph.updated':
      return 'Graph updated';
    case 'insight.created':
      return 'Insight created';
    default:
      return event.type;
  }
}

// ============================================================================
// THINKING-EVENT COLLAPSE (ARUN-016)
// ============================================================================

/** One renderable item of the run detail Event Log: either a single event, or
 * a run of adjacent equivalent Thinking heartbeats collapsed into one row. */
export type EventTimelineItem =
  | { type: 'event'; event: AgentEvent }
  | {
      type: 'thinking-group';
      /** Number of collapsed heartbeats (always ≥ 2). */
      count: number;
      startTimestamp: string;
      endTimestamp: string;
      /** The raw immutable events, in original order — the expand path. */
      events: AgentEvent[];
    };

/**
 * Collapses runs of ADJACENT equivalent Thinking events into one item carrying
 * the count, the first/last timestamps, and the untouched raw events (ARUN-016).
 * Long missions emit a low-information `agent.thinking` heartbeat every 15-30s,
 * which buried the decisive tool/gate/error/result events under hundreds of
 * identical "Thinking…" rows. Only adjacency collapses — any other event type
 * breaks the run, so ordering is preserved exactly. Equivalence is "renders the
 * same" (`describeAgentEvent`), so if heartbeat descriptions ever diverge they
 * stop grouping automatically. A run of one stays a plain event.
 */
export function collapseThinkingEvents(events: AgentEvent[]): EventTimelineItem[] {
  const items: EventTimelineItem[] = [];
  let pending: AgentEvent[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      items.push({ type: 'event', event: pending[0] });
    } else {
      items.push({
        type: 'thinking-group',
        count: pending.length,
        startTimestamp: pending[0].timestamp,
        endTimestamp: pending[pending.length - 1].timestamp,
        events: pending,
      });
    }
    pending = [];
  };

  // Description of the pending run's events, computed once per event (not
  // re-derived from the previous event on every iteration).
  let pendingDescription = '';
  for (const event of events) {
    if (event.type !== 'agent.thinking') {
      flush();
      items.push({ type: 'event', event });
      continue;
    }
    const description = describeAgentEvent(event);
    if (pending.length > 0 && description !== pendingDescription) flush();
    pending.push(event);
    pendingDescription = description;
  }
  flush();
  return items;
}

// ============================================================================
// SOURCE HEALTH (ARUN-012 / ARUN-013)
// ============================================================================

/**
 * ARUN-013 — cadence for the fallback poll that bridges the terminal handoff
 * while the live SSE stream is degraded. The stream normally drives the list's
 * history invalidation (a run's completion event refetches history so the
 * finished run surfaces) and the detail page's step log; when the stream is
 * down, neither happens, so an in-flight run freezes and a just-completed one
 * can vanish between its running row dropping and its history row appearing.
 * A 10s poll bridges that gap; both pages STOP polling the moment the stream
 * reconnects (never a permanent second channel).
 */
export const SSE_FALLBACK_POLL_MS = 10_000;

/**
 * Which of the run page's four data sources are currently failing.
 *
 * The `/agents/runs` list assembles its rows from four independent sources
 * (`assembleRows`): completed run history, build missions, in-flight
 * missions, and the live SSE event stream. Before ARUN-012 the page read the
 * error state of only the first — so an outage in build/running/live data was
 * silently swallowed into "fewer rows", making a partial failure
 * indistinguishable from a genuinely quiet inbox. This captures the health of
 * each source so the page can tell the truth: render what loaded, and flag
 * exactly what didn't.
 */
export interface RunSourceHealth {
  /** `useAgentLog` — completed missions/sweeps. */
  history: boolean;
  /** `useBuildMissions` — build (kind 'build') missions. */
  builds: boolean;
  /** `useRunningMissions` — durable in-flight research/report missions. */
  running: boolean;
  /** `useAgentEventStream` — the live SSE tail (ARUN-013). */
  live: boolean;
}

const RUN_SOURCE_LABEL: Record<keyof RunSourceHealth, string> = {
  history: 'run history',
  builds: 'build missions',
  running: 'in-flight missions',
  live: 'the live event stream',
};

/**
 * Human-readable labels for the run sources that are currently degraded, in a
 * stable order. Empty when every source is healthy. Drives the list page's
 * "some runs may be missing" banner (ARUN-012) — a pure derivation so it gets
 * direct unit coverage instead of only page-mount coverage.
 */
export function degradedRunSources(health: RunSourceHealth): string[] {
  return (Object.keys(RUN_SOURCE_LABEL) as Array<keyof RunSourceHealth>)
    .filter((key) => health[key])
    .map((key) => RUN_SOURCE_LABEL[key]);
}
