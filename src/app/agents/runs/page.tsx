'use client';

import React, { Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { CardGridSkeleton } from '@/components/skeletons';
import { RunsTable } from '@/components/activity/RunsTable';
import { RunsDegradedBanner } from '@/components/activity/RunsDegradedBanner';
import { activityKeys, useAgentLog, useTokenUsage } from '@/hooks/useAgentActivity';
import { useAuth } from '@/components/providers/AuthProvider';
import { useAgentEventStream } from '@/hooks/useAgentEventStream';
import { useBuildMissions } from '@/hooks/queries/useBuildMissions';
import { useRunningMissions } from '@/hooks/queries/useRunningMissions';
// MissionChat removed — missions are created via AI Assistant (Cmd+/)
import { Card, CardContent } from '@/components/ui/card';
import { DollarSign, Zap, Gauge } from 'lucide-react';
import {
  assembleRows,
  settledRunScopeIds,
  degradedRunSources,
  latestCompletionSequence,
  liveRowsFromEvents,
  rowsFromAgentLog,
  rowsFromBuildMissions,
  rowsFromRunningMissions,
  SSE_FALLBACK_POLL_MS,
} from './runs-table-rows';

// ============================================================================
// COST SUMMARY CARD
// ============================================================================

function CostSummary() {
  const { data: usage, isLoading } = useTokenUsage();
  const { data: entries } = useAgentLog();

  if (isLoading || !usage) {
    return null;
  }

  // Cost and finalized tokens are independent ledgers while a build is live:
  // reservation spend can be persisted before token usage exists.
  // ARUN-027: an unknown total renders as "—" — never a fabricated $0.00 —
  // and reserved spend is called out separately from settled spend.
  const trackedCost = usage.today.costUsd ?? 0;
  const hasCostAuthoritySplit = usage.today.settledCostUsd !== undefined || usage.today.estimatedCostUsd !== undefined;
  const settledCost = hasCostAuthoritySplit ? (usage.today.settledCostUsd ?? 0) : trackedCost;
  const estimatedCost = usage.today.estimatedCostUsd ?? 0;
  const unavailableRuns = usage.today.unavailableCostRuns ?? 0;
  const reservedCost = usage.today.reservedCostUsd ?? 0;
  const todayCost = trackedCost === 0 && unavailableRuns > 0 ? '—' : `$${trackedCost.toFixed(2)}`;
  const todayTokens = usage.today.total;

  // Rolling quality average over today's runs that carry a qualityReport.
  // Today-filter: AgentRun.createdAt on the same UTC date as now.
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayScores = (entries ?? [])
    .filter((e) => e.createdAt?.slice(0, 10) === todayIso && e.qualityReport)
    .map((e) => e.qualityReport!.overallScore);
  const hasQuality = todayScores.length > 0;
  const qualityAvgPct = hasQuality
    ? Math.round((todayScores.reduce((a, b) => a + b, 0) / todayScores.length) * 100)
    : 0;
  const qualityColor =
    qualityAvgPct >= 83
      ? 'text-emerald-600 dark:text-emerald-400'
      : qualityAvgPct >= 50
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-destructive';

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-6 p-4">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Today</span>
          <span className="text-lg font-semibold" data-testid="runs-today-cost">
            {todayCost}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="runs-cost-scope">
            {hasCostAuthoritySplit ? 'observed and estimated app cost' : 'settled (legacy)'}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="runs-cost-settled">
            · ${settledCost.toFixed(2)} settled
          </span>
          {estimatedCost > 0 && (
            <span className="text-xs text-muted-foreground" data-testid="runs-cost-estimated">
              · ${estimatedCost.toFixed(2)} estimated (rate card)
            </span>
          )}
          {reservedCost > 0 && (
            <span className="text-xs text-muted-foreground" data-testid="runs-cost-reserved">
              (incl. ${reservedCost.toFixed(2)} reserved)
            </span>
          )}
          {unavailableRuns > 0 && (
            <span className="text-xs text-muted-foreground" data-testid="runs-cost-unavailable">
              · {unavailableRuns} without cost data
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {todayTokens >= 1000 ? `${(todayTokens / 1000).toFixed(1)}K` : todayTokens} tokens
          </span>
        </div>
        {hasQuality && (
          <div className="flex items-center gap-2" title={`${todayScores.length} mission(s) evaluated`}>
            <Gauge className={`h-4 w-4 ${qualityColor}`} />
            <span className="text-sm text-muted-foreground">Quality avg:</span>
            <span className={`text-sm font-medium ${qualityColor}`}>{qualityAvgPct}%</span>
            <span className="text-xs text-muted-foreground">
              ({todayScores.length} mission{todayScores.length === 1 ? '' : 's'})
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// RUNS TABLE SECTION
// ============================================================================

/** Deep-link support (Important finding #2, Task 21 follow-up): three live
 * call sites — artifacts/[id], triage/assessment/[id],
 * artifact-output-ui.ts's `sourceRunHref` — still emit the old tabbed page's
 * `/agents/runs?tab=builds&build=<id>` link shape. `tab=builds` preselects
 * the Builds kind facet; `build=<id>` additionally highlights + scrolls to
 * that row if it's present in the assembled rows. */
function AgentRunsSection() {
  const router = useRouter();
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';
  const { data: entries, degradedKinds, isLoading, error, refetch: refetchLog } = useAgentLog();
  const { data: buildMissions, isError: buildsError, refetch: refetchBuilds } = useBuildMissions();
  const { data: runningMissions, isError: runningError, refetch: refetchRunning } = useRunningMissions();
  const { events, connectionError } = useAgentEventStream();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const requestedTab = searchParams.get('tab');
  const initialKindFacet = requestedTab === 'builds' ? 'build' : requestedTab === 'chats' ? 'chat' : undefined;
  const highlightRunId = searchParams.get('build') ?? undefined;

  // ARUN-001 completion handoff: a run's durable running row (getRunningMissions)
  // and its SSE live row both drop the instant it completes. The AgentRun
  // history doc is written BEFORE the agent.completed/agent.error event is
  // emitted (run-agent-mission.ts), so refetching history the moment that event
  // arrives surfaces the completed run — and rowsFromRunningMissions then drops
  // the stale running row by missionId — with no gap. Without this, useAgentLog
  // never refetches (staleTime 30s, no interval, refetchOnWindowFocus:false), so
  // a just-completed run would vanish mid-session until a manual reload.
  const latestCompletionSeq = latestCompletionSequence(events);
  React.useEffect(() => {
    if (latestCompletionSeq > 0) {
      void queryClient.invalidateQueries({ queryKey: activityKeys.log(uid) });
    }
  }, [latestCompletionSeq, queryClient, uid]);

  // ARUN-013 — the completion handoff above is driven by SSE completion events.
  // While the stream is DOWN those never arrive, so a run that finishes drops
  // from the running-missions poll but never surfaces in history — it vanishes.
  // Bridge the gap with a bounded fallback poll of the history query, and STOP
  // it the moment the stream reconnects (`connectionError` clears), handing the
  // job back to the event-driven invalidation. Not a permanent second channel.
  React.useEffect(() => {
    if (!connectionError) return;
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: activityKeys.log(uid) });
    }, SSE_FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [connectionError, queryClient, uid]);

  if (isLoading) {
    return <CardGridSkeleton cards={4} columns={1} cardSize="md" />;
  }

  const rows = assembleRows(
    rowsFromAgentLog(entries ?? []),
    rowsFromBuildMissions(buildMissions ?? []),
    rowsFromRunningMissions(runningMissions ?? [], entries ?? []),
    liveRowsFromEvents(events),
    // ARUN-020 — a run whose durable terminal row has landed must not also
    // render as a phantom live row still advertising its last heartbeat count.
    settledRunScopeIds(entries ?? [])
  );

  // ARUN-012/013 — the table draws from four independent sources, each of which
  // can fail on its own. Read every source's error, not just the history
  // query's: swallowing the build/running failures would turn an outage into a
  // silently shorter list, and a dead SSE stream (ARUN-013) means live runs
  // stop updating with no visible cue. Only the three Firestore-backed query
  // sources count toward `hardFailure` — a dead SSE stream never blanks the
  // table (the durable rows still poll), so it degrades but never triggers the
  // full "unavailable" panel.
  const hardFailure = Boolean(error) || buildsError || runningError;
  const degraded = degradedRunSources({
    history: Boolean(error),
    builds: buildsError,
    running: runningError,
    live: connectionError,
  });
  if (degradedKinds.length > 0) degraded.push('older run history');
  const retryDegraded = () => {
    void refetchLog();
    void refetchBuilds();
    void refetchRunning();
  };

  // Nothing to show AND a source failed → this is an outage, not a clean inbox.
  // Only when every source succeeds does an empty result reach RunsTable's own
  // "No agent runs yet" empty state.
  if (rows.length === 0 && hardFailure) {
    return (
      <ErrorFallback
        error={error instanceof Error ? error : new Error('Agent run sources are unavailable.')}
        reset={retryDegraded}
        title="Agent runs unavailable"
        description="Could not load agent activity right now. Please retry."
      />
    );
  }

  // Some rows loaded but a source failed → show what we have, flagged honestly.
  return (
    <>
      <RunsDegradedBanner sources={degraded} onRetry={retryDegraded} />
      <RunsTable
        runs={rows}
        onRowClick={(id) => router.push(`/agents/runs/${id}`)}
        initialKindFacet={initialKindFacet}
        highlightRunId={highlightRunId}
      />
    </>
  );
}

// ============================================================================
// PAGE
// ============================================================================

// The page-level title block (formerly a floating `PageHeader` above the
// card) now lives INSIDE the table card's own header row, matching the
// Signals page pattern (CONV-HEADER) — see RunsTable's own "Agent Runs"
// h1 + subtitle. The budget/cost strip stays its own card, directly above
// the table card (both direct children of PageShell, so its `space-y-*`
// rhythm spaces them without a nested card-in-card).
//
// UX-068: Background Verifications used to render as a second stacked table
// below this one. It now has its own page — Activity → Jobs (`/agents/jobs`) —
// so this page contains only the Agent Runs experience.
function AgentRunsPageContent() {
  return (
    <SmartLayout>
      <PageShell>
        <ErrorBoundary
          fallbackRender={({ error, reset }) => (
            <ErrorFallback
              error={error}
              reset={reset}
              title="Something went wrong"
              description="The agent runs page encountered an error."
            />
          )}
        >
          <CostSummary />
          <PageContent noPadding>
            <AgentRunsSection />
          </PageContent>
        </ErrorBoundary>
      </PageShell>
    </SmartLayout>
  );
}

// `useSearchParams` (read inside AgentRunsSection for the tab=builds /
// build=<id> deep links) requires a Suspense boundary — matches the
// established pattern in app/radar/page.tsx and app/settings/page.tsx.
export default function AgentRunsPage() {
  return (
    <Suspense fallback={<CardGridSkeleton cards={4} columns={1} cardSize="md" />}>
      <AgentRunsPageContent />
    </Suspense>
  );
}
