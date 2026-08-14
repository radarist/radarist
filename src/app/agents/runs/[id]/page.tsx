/**
 * @file page.tsx (Agents > Runs > [id])
 * @description Run detail page (Task 22 / P-F1 part 2) — one chat, mission,
 * sweep, or build execution: metadata, quality checks, errors, and the full
 * Event Log. Finished/failed runs render the persisted step history
 * (`useRunEvents` → GET /api/agents/runs/[id]/events); in-flight runs seed
 * with that history and live-tail SSE events on top (dedup by event id via
 * `mergeRunEvents`). A run whose step history exceeded the server's
 * 500-event query cap (`agent-events.ts` `getEventsForRun`) renders a
 * "partial step history" note alongside the (possibly incomplete) list.
 *
 * When there's no step history to show, the mission-summary `AgentLog`
 * entry renders instead, with one of two honest notes depending on WHY:
 * a run type that never emits scoped agent-events at all (chat runs,
 * sweep-cycle summaries — `runEventScopeId` returns no scope) gets "isn't
 * recorded for this run type"; a run with a resolvable scope but no
 * matching events (agent-events carry a 24h TTL) gets "may have expired".
 *
 * Read-only: no actions. Run identity/metadata resolve from the same three
 * sources `/agents/runs` assembles rows from (`useAgentLog`,
 * `useBuildMissions`, `useAgentEventStream`) via `buildRunDetail`.
 */

'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Brain,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  FileText,
  Layers,
  Lightbulb,
  PlayCircle,
  Radio,
  Share2,
  Sparkles,
  Waves,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { DetailPageShell } from '@/components/layout/DetailPageShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentLog } from '@/components/activity/AgentLog';
import { ChatToolSummary } from '@/components/activity/ChatToolSummary';
import { ScrollToBottom } from '@/components/ai/ScrollToBottom';
import { KIND_LABEL, KindPill, L1Pill, PartialPill, StatusPill } from '@/components/activity/RunsTable';
import { formatDuration, formatTokens } from '@/components/activity/run-formatters';
import { ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { useAgentLog } from '@/hooks/useAgentActivity';
import { useRunEvents } from '@/hooks/useRunEvents';
import { useBuildMissions } from '@/hooks/queries/useBuildMissions';
import { useMissionDetail } from '@/hooks/queries/useMissionDetail';
import { BuildMissionCard } from '@/components/missions/BuildMissionCard';
import { useAgentEventStream } from '@/hooks/useAgentEventStream';
import { useReports } from '@/hooks/useReports';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  buildRunDetail,
  collapseThinkingEvents,
  describeAgentEvent,
  mergeRunEvents,
  resolveRunOutputs,
  runEventScopeId,
  SSE_FALLBACK_POLL_MS,
  type EventTimelineItem,
} from '../runs-table-rows';
import type { AgentEvent, AgentEventTypeEnum } from '@/lib/schemas/agent-event';
import { cn } from '@/lib/utils';
import { formatRunCost } from '@/lib/run-cost-display';
import { resolveRunTerminalTruth, RUN_DISPOSITION_LABEL } from '@/lib/run-terminal-truth';

// ============================================================================
// HELPERS
// ============================================================================

const EVENT_ICON: Record<AgentEventTypeEnum, React.ElementType> = {
  'agent.started': PlayCircle,
  'agent.thinking': Brain,
  'agent.tool_call': Wrench,
  'agent.discovery': Sparkles,
  'agent.completed': CheckCircle2,
  'agent.error': XCircle,
  'graph.updated': Share2,
  'insight.created': Lightbulb,
  'sweep.phase': Waves,
};

/** CONV-DATE-adjacent: absolute date + time (a detail page can afford the
 * extra precision a table cell can't). */
function formatStartedAt(iso: string): string {
  try {
    return format(new Date(iso), "MMM d, yyyy 'at' h:mm a");
  } catch {
    return '—';
  }
}

/** Caps the mission text folded into the page h1 — RunsTable truncates via
 * CSS in a table cell; a heading needs the string itself capped so a
 * multi-hundred-char mission prompt doesn't blow up the header. */
function formatRunTitle(agent: string, mission: string): string {
  const label = agent.length > 0 ? agent.charAt(0).toUpperCase() + agent.slice(1) : 'Agent';
  const summary = mission.length > 100 ? `${mission.slice(0, 100).trimEnd()}…` : mission;
  return `${label} — ${summary}`;
}

// ============================================================================
// EVENT TAIL — the run's step list: full persisted history for finished
// runs, history-seed + live SSE tail for in-flight ones (see mergeRunEvents)
// ============================================================================

function EventRowBody({ event }: { event: AgentEvent }) {
  const Icon = EVENT_ICON[event.type] ?? Bot;
  return (
    <>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-foreground">{describeAgentEvent(event)}</p>
        <p className="text-xs text-muted-foreground">{format(new Date(event.timestamp), 'h:mm:ss a')}</p>
      </div>
    </>
  );
}

/**
 * ARUN-016 — one collapsed row for a run of adjacent Thinking heartbeats:
 * count + time range, with a toggle that expands the raw immutable events
 * (rendered exactly like plain rows). Collapsed by default so a long
 * mission's decisive tool/gate/error/result events stay scannable.
 */
function ThinkingGroupRow({ group }: { group: Extract<EventTimelineItem, { type: 'thinking-group' }> }) {
  const [expanded, setExpanded] = React.useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li className="text-sm" data-testid="run-thinking-group">
      <button
        type="button"
        data-testid="run-thinking-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2.5 rounded-sm text-left transition-colors hover:bg-accent/30"
      >
        <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">Thinking… ×{group.count}</p>
          <p className="text-xs text-muted-foreground">
            {format(new Date(group.startTimestamp), 'h:mm:ss a')} – {format(new Date(group.endTimestamp), 'h:mm:ss a')}
          </p>
        </div>
        <Chevron className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {expanded && (
        <ul className="ml-6 mt-3 space-y-3" data-testid="run-thinking-group-events">
          {group.events.map((event) => (
            <li key={event.id} className="flex items-start gap-2.5 text-sm">
              <EventRowBody event={event} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function EventTail({ events, isLive }: { events: AgentEvent[]; isLive: boolean }) {
  // ARUN-016: adjacent equivalent Thinking heartbeats render as one
  // expandable group row; the underlying event list stays untouched.
  const items = React.useMemo(() => collapseThinkingEvents(events), [events]);

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="run-event-tail-empty">
        {isLive
          ? 'No events captured yet for this run — steps will appear here as the agent works.'
          : 'No event log captured for this run.'}
      </p>
    );
  }

  return (
    <ul className="space-y-3" data-testid="run-event-tail">
      {items.map((item) =>
        item.type === 'thinking-group' ? (
          <ThinkingGroupRow key={item.events[0].id} group={item} />
        ) : (
          <li key={item.event.id} className="flex items-start gap-2.5 text-sm">
            <EventRowBody event={item.event} />
          </li>
        )
      )}
    </ul>
  );
}

// ============================================================================
// EVENT LOG SCROLLER (P-F6) — bounds the Event Log to a fixed viewport height
// so a long run (100+ events) can't push the page forever; the card title
// stays fixed above this scroll area (see the CardHeader in the caller).
//
// Auto-follow mirrors AIChat's instant-first-settle / smooth-new-message
// contract (src/components/ai/AIChat.tsx, pinned by
// AIChat.scroll-behavior.test.tsx): the FIRST scrollIntoView after mount
// settles instantly ({ behavior: 'auto' }); every later append while the
// user hasn't scrolled away animates ({ behavior: 'smooth' }). Unlike AIChat
// (which always snaps to bottom), this ALSO gates on `isNearBottomRef` — a
// user who has scrolled up to read earlier steps must never be yanked back
// down by a new event; the floating `ScrollToBottom` button (same component
// AIChat uses) offers a way back. A completed run never auto-scrolls at all —
// it starts at the top, in natural reading order.
// ============================================================================

const EVENT_LOG_NEAR_BOTTOM_PX = 100;

function EventLogScroller({ events, isLive }: { events: AgentEvent[]; isLive: boolean }) {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const isNearBottomRef = React.useRef(true);
  const hasSettledRef = React.useRef(false);
  const [showJumpButton, setShowJumpButton] = React.useState(false);

  const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < EVENT_LOG_NEAR_BOTTOM_PX;
    isNearBottomRef.current = nearBottom;
    setShowJumpButton(!nearBottom);
  }, []);

  const scrollToBottom = React.useCallback(() => {
    isNearBottomRef.current = true;
    setShowJumpButton(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  React.useEffect(() => {
    // Completed runs read top-to-bottom in natural order — never auto-scroll.
    if (!isLive) return;
    if (!bottomRef.current) return;
    // The user scrolled up to read history — a new event must not yank them
    // back down. They stay in control until they scroll back near the
    // bottom themselves, or use the jump button.
    if (!isNearBottomRef.current) return;
    const behavior = hasSettledRef.current ? 'smooth' : 'auto';
    hasSettledRef.current = true;
    bottomRef.current.scrollIntoView({ behavior });
  }, [events, isLive]);

  return (
    <div className="relative">
      <div onScroll={handleScroll} className="max-h-[65vh] overflow-y-auto pr-1" data-testid="run-event-log-scroll">
        <EventTail events={events} isLive={isLive} />
        <div ref={bottomRef} />
      </div>
      {isLive && <ScrollToBottom visible={showJumpButton} onClick={scrollToBottom} />}
    </div>
  );
}

// ============================================================================
// NOT FOUND
// ============================================================================

function RunNotFound() {
  return (
    <SmartLayout>
      <PageShell>
        <div className="max-w-4xl mx-auto p-6 text-center" data-testid="run-detail-not-found">
          <h1 className="text-2xl font-semibold mb-4">Run Not Found</h1>
          <p className="text-muted-foreground mb-6">
            The agent run you&apos;re looking for doesn&apos;t exist or hasn&apos;t started yet.
          </p>
          <Button asChild>
            <Link href="/agents/runs">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Runs
            </Link>
          </Button>
        </div>
      </PageShell>
    </SmartLayout>
  );
}

/**
 * ARUN-012 — shown when the run couldn't be resolved because a data source
 * FAILED (history / build / event-history fetch errored), as opposed to
 * `RunNotFound` which means every source succeeded and none knew this id. An
 * outage must never masquerade as a deleted/absent run, and it must stay
 * retryable.
 */
function RunUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <SmartLayout>
      <PageShell>
        <div className="max-w-4xl mx-auto p-6" data-testid="run-detail-unavailable">
          <ErrorFallback
            error={new Error('One or more run data sources are unavailable.')}
            reset={onRetry}
            title="Run temporarily unavailable"
            description="We couldn't load this run right now — the run history or build service is unreachable. This is not a missing run; please retry."
          />
          <div className="mt-6 text-center">
            <Button variant="ghost" asChild>
              <Link href="/agents/runs">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Runs
              </Link>
            </Button>
          </div>
        </div>
      </PageShell>
    </SmartLayout>
  );
}

// ============================================================================
// PAGE
// ============================================================================

export default function RunDetailPage() {
  const params = useParams();
  const runId = params.id as string;

  const { data: entries, isLoading: logLoading, isError: logError, refetch: refetchLog } = useAgentLog();
  const {
    data: buildMissions,
    isLoading: buildLoading,
    isError: buildError,
    refetch: refetchBuilds,
  } = useBuildMissions();
  const { data: reports } = useReports();
  const { user } = useAuth();
  // P-F9 — a completed run has no more events to stream; leaving the SSE
  // hook enabled unconditionally kept a pointless live connection open (and
  // the dev "Rendering…" indicator spinning) for every finished run. Decide
  // liveness from the already-fetched history/build sources BEFORE opening
  // the stream: a run present in the history-tab entries is, by
  // construction, completed (`rowsFromAgentLog`'s doc comment — that source
  // only ever holds finished missions/sweeps); a matched build mission is
  // completed once it's left running/pending. A run not yet found in either
  // (still loading, or an SSE-only in-flight run with no Firestore doc yet)
  // is treated as not-yet-determinable and keeps the stream enabled so a
  // genuinely live run is never starved of events.
  // AUDIT-006 — the build mission behind this run, if it is one. Also the
  // governance card's data source (see the render below).
  const buildMission = React.useMemo(() => (buildMissions ?? []).find((m) => m.id === runId), [buildMissions, runId]);
  const isRunKnownCompleted = React.useMemo(() => {
    const historyEntry = (entries ?? []).find((e) => e.id === runId);
    if (historyEntry) return true;
    if (buildMission) return buildMission.status !== 'running' && buildMission.status !== 'pending';
    return false;
  }, [entries, buildMission, runId]);
  const { events: liveEvents, connectionError: liveConnectionError } = useAgentEventStream(!isRunKnownCompleted);
  // Persisted step history for THIS run — the seed the live SSE tail
  // appends onto. The SSE hook's cursor starts at page-mount "now", so
  // without this fetch a completed run would show no steps at all and a
  // deep-linked in-flight run would miss everything before mount.
  // Events are keyed by missionId/sweepId, not the AgentRun doc id — for a
  // history run, fetch by the entry's mission/sweep id (see runEventScopeId).
  const eventScopeId = React.useMemo(() => runEventScopeId(entries ?? [], runId), [entries, runId]);
  const {
    data: historyData,
    isLoading: eventsLoading,
    isError: eventsError,
    refetch: refetchEvents,
  } = useRunEvents(eventScopeId);
  const historyEvents = historyData?.events;
  const historyTruncated = historyData?.truncated ?? false;
  // `eventScopeId` is undefined only when the run is known (a history entry
  // matched) but carries neither missionId nor sweepId — a chat run or
  // sweep-cycle summary that never emitted scoped agent-events at all.
  const scopeUnresolvable = eventScopeId === undefined;

  const mergedEvents = React.useMemo(
    () => mergeRunEvents(historyEvents ?? [], liveEvents),
    [historyEvents, liveEvents]
  );

  const run = React.useMemo(
    // ARUN-020: `mergedEvents` drives the Event Log; `liveEvents` is the lend
    // input, matching exactly what the Runs list sees.
    () => buildRunDetail(entries ?? [], buildMissions ?? [], mergedEvents, runId, liveEvents),
    [entries, buildMissions, mergedEvents, runId, liveEvents]
  );

  // P-F7 — "did this run produce something?" (a linked report and/or a
  // build artifact). Resolved even when `run` is null so hook order stays
  // stable; the aside below only renders it once `run` is known.
  const outputs = React.useMemo(
    () => (run ? resolveRunOutputs(run, reports ?? [], buildMissions ?? [], user?.uid) : []),
    [run, reports, buildMissions, user?.uid]
  );

  // ARUN-029 — a Creator (kind 'mission') run resolves from its AgentRun row
  // alone; its Mission doc holds the durable terminal reason, the canonical
  // Report pointer, and the mission-side accounting. Build missions are already
  // loaded in full by `useBuildMissions`, so only the mission kind needs this
  // extra read. Hook order stays stable — the id is simply undefined otherwise.
  const missionIdForTruth = run?.kind === 'mission' ? (run.logEntry?.missionId ?? undefined) : undefined;
  const { data: missionDoc, isError: missionError } = useMissionDetail(missionIdForTruth);
  const terminalTruth = React.useMemo(
    () =>
      run
        ? resolveRunTerminalTruth({
            run: {
              kind: run.kind,
              status: run.status,
              isLive: run.isLive,
              tokens: run.tokens,
              costUsd: run.costUsd,
              errors: run.errors,
              failureCode: run.logEntry?.failureCode,
            },
            mission: run.kind === 'build' ? buildMission : (missionDoc ?? undefined),
            missionId: run.kind === 'build' ? run.id : missionIdForTruth,
            reports: reports ?? [],
            ownerId: user?.uid,
            // ARUN-029: the step log is the third view of this run; a trail that
            // contradicts the record must be said out loud, not silently lost.
            events: run.events,
          })
        : undefined,
    [run, buildMission, missionDoc, missionIdForTruth, reports, user?.uid]
  );

  // ARUN-013 — an in-flight run's step log + completion depend on the live SSE
  // stream. While the stream is DOWN, poll the persisted event history so the
  // log keeps advancing and the run still reaches its terminal state; STOP the
  // moment the stream reconnects or the run is no longer live. `refetch` is a
  // stable TanStack callback, so this effect only re-subscribes when liveness
  // or connectivity actually changes.
  const runIsLive = run?.isLive ?? false;
  React.useEffect(() => {
    if (!runIsLive || !liveConnectionError) return;
    const interval = setInterval(() => {
      void refetchEvents();
    }, SSE_FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [runIsLive, liveConnectionError, refetchEvents]);

  // ARUN-012 — at least one id-resolving source failed to load. Whether or not
  // `run` resolved, that means the view is built on incomplete data (a source
  // outage), never trustworthy silence.
  const sourceError = logError || buildError || eventsError;

  if (!run) {
    // Wait for ALL three id-resolving sources — a run known only through
    // its persisted events (e.g. a sweep with an expired AgentRun listing)
    // must not flash "Not Found" while the history query is in flight.
    if (logLoading || buildLoading || eventsLoading) {
      return (
        <SmartLayout>
          <PageShell>
            <div className="max-w-6xl mx-auto space-y-6 p-6">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </PageShell>
        </SmartLayout>
      );
    }
    // ARUN-012 — a source outage is NOT a missing run. If any source failed we
    // can't prove the run doesn't exist, so offer a retry instead of the
    // dead-end "Run Not Found". Only when every source succeeded and none knew
    // this id do we render the genuine not-found state.
    if (sourceError) {
      return (
        <RunUnavailable
          onRetry={() => {
            void refetchLog();
            void refetchBuilds();
            void refetchEvents();
          }}
        />
      );
    }
    return <RunNotFound />;
  }

  const title = formatRunTitle(run.agent, run.mission);

  return (
    <SmartLayout entityName={title}>
      <PageShell>
        <DetailPageShell
          backHref="/agents/runs"
          backLabel="Back to Runs"
          title={title}
          chips={
            <>
              <StatusPill status={run.status} />
              {run.quality && <L1Pill verdict={run.quality.l1} />}
              <KindPill kind={run.kind} />
              {/* ARUN-012 — the run resolved, but a source (history / build /
                  event history) failed, so what's shown may be incomplete. */}
              {sourceError && <PartialPill />}
            </>
          }
          aside={
            <>
              <Card data-testid="run-details-card">
                <CardHeader>
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-3 text-sm">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Agent</div>
                      <div className="font-medium capitalize">{run.agent}</div>
                    </div>
                  </div>
                  {/* ARUN-007 — one coherent telemetry panel for EVERY kind:
                      provider/model/duration/tokens/cost rows always render.
                      Persisted values show; missing ones say "Unavailable" —
                      never hidden, never estimated. */}
                  <div className="flex items-center gap-3 text-sm">
                    <Radio className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Provider</div>
                      <div className="font-medium" data-testid="run-detail-provider">
                        {run.provider ? (run.provider === 'claude' ? 'Claude' : 'Gemini') : 'Unavailable'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Brain className="h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-muted-foreground">Model</div>
                      <div className="break-all font-medium" data-testid="run-detail-model">
                        {run.models?.join(', ') ?? run.model ?? 'Unavailable'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Kind</div>
                      <div className="font-medium">{KIND_LABEL[run.kind]}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Started</div>
                      <div className="font-medium">{formatStartedAt(run.startedAt)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Duration</div>
                      <div className="font-medium" data-testid="run-detail-duration">
                        {run.durationMs === undefined ? 'Unavailable' : formatDuration(run.durationMs)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">Tokens</div>
                      <div className="font-medium" data-testid="run-detail-tokens">
                        {run.tokens === undefined ? 'Unavailable' : formatTokens(run.tokens)}
                        {/* ARUN-020: a partially-reported total is a proven lower
                            bound, not an exact figure — say so rather than let
                            the reader treat it as the whole turn. */}
                        {run.tokensPartiallyReported && run.tokens !== undefined ? (
                          <span className="ml-1 text-xs font-normal" data-testid="run-detail-tokens-partial">
                            (partial — a provider response reported no usage)
                          </span>
                        ) : run.tokensProvisional && run.tokens !== undefined ? (
                          <span className="ml-1 text-xs font-normal" data-testid="run-detail-tokens-running">
                            (running — this mission is still in flight)
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground">
                        {run.costState === 'estimated'
                          ? 'Estimated cost'
                          : run.costState === 'mixed'
                            ? 'Settled + estimated cost'
                            : run.costState === 'reserved'
                              ? 'Reserved authority'
                              : run.costState === 'maximum-exposure'
                                ? 'Maximum exposure'
                                : run.costState === 'settled'
                                  ? 'Settled cost'
                                  : 'Cost'}
                      </div>
                      {/* ARUN-027: one shared wording rule, so `Unpriced` (no
                          rate-card entry) never reads the same as `Incomplete`
                          (the ledger lost receipts for real spend), and an
                          amount with no recorded authority is not labelled
                          settled. */}
                      <div className="font-medium" data-testid="run-detail-cost" title={formatRunCost(run).title}>
                        {formatRunCost(run).label}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* ARUN-029 — the run's durable terminal truth. One reason, one
                  canonical Report pointer, and an explicit statement when the
                  AgentRun row and the Mission doc disagree. Missing authority is
                  never rounded up to success: an unrecorded outcome, an
                  unresolvable pointer, and an unrecorded reason are each their
                  own visible state. */}
              {terminalTruth && (run.kind === 'mission' || run.kind === 'build') && (
                <Card data-testid="run-terminal-truth-card">
                  <CardHeader>
                    <CardTitle className="text-base">Terminal outcome</CardTitle>
                    <CardDescription data-testid="run-disposition">
                      {RUN_DISPOSITION_LABEL[terminalTruth.disposition]}
                      {terminalTruth.partial ? ' · recovered from a mid-run checkpoint' : ''}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {terminalTruth.reason ? (
                      <div data-testid="run-terminal-reason">
                        <div className="text-muted-foreground">Reason</div>
                        <p className="font-medium text-foreground">{terminalTruth.reason.text}</p>
                        <p className="text-xs text-muted-foreground">Recorded by: {terminalTruth.reason.source}</p>
                      </div>
                    ) : terminalTruth.reasonUnavailable ? (
                      <p data-testid="run-terminal-reason-unavailable" className="text-muted-foreground">
                        This run did not end successfully and no durable reason was recorded for it.
                      </p>
                    ) : null}

                    {terminalTruth.reportState === 'canonical' && terminalTruth.report ? (
                      <div>
                        <div className="text-muted-foreground">Report</div>
                        <Link
                          href={terminalTruth.report.href}
                          className="font-medium text-foreground underline underline-offset-2"
                          data-testid="run-terminal-report-link"
                        >
                          {terminalTruth.report.title}
                        </Link>
                      </div>
                    ) : terminalTruth.reportState === 'referenced-unresolved' ? (
                      <p data-testid="run-terminal-report-unresolved" className="text-muted-foreground">
                        This run recorded {terminalTruth.referencedReportIds.length === 1 ? 'a report' : 'reports'} (
                        {terminalTruth.referencedReportIds.join(', ')}) that could not be read from your report list.
                      </p>
                    ) : terminalTruth.reportState === 'none' ? (
                      <p data-testid="run-terminal-report-none" className="text-muted-foreground">
                        No report was recorded for this run.
                      </p>
                    ) : (
                      <p data-testid="run-terminal-report-unknown" className="text-muted-foreground">
                        {missionError
                          ? 'The mission record could not be read, so this run’s report is unknown.'
                          : 'No mission record was found for this run, so its report is unknown.'}
                      </p>
                    )}

                    {terminalTruth.eventTrailContradiction && (
                      <p
                        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
                        data-testid="run-event-trail-contradiction"
                      >
                        {terminalTruth.eventTrailContradiction}
                      </p>
                    )}

                    {terminalTruth.accountingDisagreements.length > 0 && (
                      <div
                        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
                        data-testid="run-accounting-disagreement"
                      >
                        <p className="font-medium text-foreground">
                          This run&apos;s row and its mission record state different accounting.
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {terminalTruth.accountingDisagreements.map((item) => (
                            <li key={item.field} data-testid={`run-accounting-disagreement-${item.field}`}>
                              {item.field}: run {item.runValue} · mission {item.missionValue}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {outputs.length > 0 && (
                <Card data-testid="run-output-card">
                  <CardHeader>
                    <CardTitle className="text-base">Output</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {outputs.map((output) => (
                      <Link
                        key={output.key}
                        href={output.href}
                        className="flex items-start gap-2.5 rounded-md border border-border p-3 text-sm transition-colors hover:bg-accent/30"
                        data-testid={`run-output-link-${output.key}`}
                      >
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-foreground" title={output.title}>
                            {output.title}
                          </p>
                          <Badge
                            variant="outline"
                            className={cn(
                              'mt-1 gap-1 px-2 py-0.5 text-xs font-normal',
                              output.badge.className,
                              output.badge.tint
                            )}
                          >
                            {output.badge.label}
                          </Badge>
                        </div>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              )}

              {run.quality && run.qualityChecks && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Quality Checks</CardTitle>
                    <CardDescription>
                      {run.quality.passed}/{run.quality.total} passed · {run.quality.score}%
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {run.qualityChecks.map((check, idx) => (
                        <li key={`${check.name}-${idx}`} className="flex items-start gap-2 text-sm">
                          {check.pass ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                          ) : check.critical ? (
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                          ) : (
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                          )}
                          <div className="min-w-0">
                            <div
                              className={cn('font-medium', check.pass ? 'text-foreground' : 'text-muted-foreground')}
                            >
                              {check.name}
                            </div>
                            {check.detail && <div className="text-xs text-muted-foreground">{check.detail}</div>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </>
          }
        >
          {/*
           * AUDIT-006 — run governance for a build mission: phase stepper, budget
           * meter, the human gates (budget top-up / stall), QA verdict, cancel.
           *
           * This card was built, tested, and NEVER MOUNTED — it had zero
           * production importers. Meanwhile the supervisor genuinely parks at
           * `step.waitForEvent` on a budget or stall gate, and `useResolveGate`
           * (imported only by this card) is the ONLY caller of the endpoint that
           * emits `app/build-mission.gate.resolved`. So a gated build had no
           * human resolver in the app at all: it sat until `gates.timeoutHours`
           * (24h), then auto-denied and failed the run. Mounting it here — above
           * the errors banner, so a gate is the first thing you see — is what
           * makes the gates reachable.
           */}
          {buildMission && <BuildMissionCard mission={buildMission} />}

          {run.errors && run.errors.length > 0 && (
            <Card className="border-destructive/30 bg-destructive/5" data-testid="run-errors-banner">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  Errors
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {run.errors.map((error, idx) => (
                    <li key={idx} className="text-sm text-destructive">
                      {error}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card data-testid="run-event-log">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Event Log
                {run.isLive && (
                  <Badge
                    variant="outline"
                    className="gap-1 text-xs font-normal bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400"
                    data-testid="run-live-badge"
                  >
                    <Radio className="h-3 w-3" />
                    Live
                  </Badge>
                )}
                {/* ARUN-013 — the run is live but the live-update stream is
                    down. Say so, so a frozen log doesn't read as "nothing is
                    happening"; the fallback poll above keeps it advancing. */}
                {run.isLive && liveConnectionError && (
                  <Badge
                    variant="outline"
                    className="gap-1 text-xs font-normal bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400"
                    data-testid="run-live-degraded-badge"
                    title="The live update stream is unavailable. Reconnecting — the log is refreshing on a fallback poll in the meantime."
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Live updates paused — reconnecting…
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {run.events.length > 0 ? (
                // The run's step list — full persisted history, plus the
                // live SSE tail appended (deduped) while in flight.
                <>
                  <EventLogScroller events={run.events} isLive={run.isLive} />
                  {historyTruncated && (
                    <p className="mt-3 text-xs text-muted-foreground" data-testid="run-history-truncated-note">
                      Showing a partial step history (run exceeded the 500-event window)
                    </p>
                  )}
                </>
              ) : eventsLoading ? (
                // History still fetching — don't flash either fallback note.
                <div className="space-y-2" data-testid="run-event-log-loading">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : run.kind === 'chat' && run.logEntry ? (
                <ChatToolSummary
                  entries={run.logEntry.toolSummary ?? []}
                  truncated={run.logEntry.toolSummaryTruncated}
                />
              ) : run.logEntry ? (
                // No step history to show — fall back to the mission-summary
                // entry, with an honest note about WHY it's missing:
                // - scope unresolvable: this run type (chat, sweep-cycle
                //   summary, …) never emits scoped agent-events at all.
                // - scope resolved but empty: agent-events carry a 24h TTL,
                //   so an older run's history may simply be gone.
                <>
                  <AgentLog entries={[run.logEntry]} />
                  {scopeUnresolvable ? (
                    <p className="mt-3 text-xs text-muted-foreground" data-testid="run-history-no-scope-note">
                      Step-level history isn&apos;t recorded for this run type.
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground" data-testid="run-history-expired-note">
                      No step history found — it may have expired.
                    </p>
                  )}
                </>
              ) : (
                <EventLogScroller events={run.events} isLive={run.isLive} />
              )}
            </CardContent>
          </Card>
        </DetailPageShell>
      </PageShell>
    </SmartLayout>
  );
}
