/**
 * @file TokenBudgetDashboard.tsx
 * @description Token usage overview with real data and honest cost controls.
 *
 * Fetches real token usage from /api/activity/tokens and per-agent breakdown
 * from /api/activity/tokens-by-agent. The cost-controls card surfaces the
 * enforced per-mission cost/tool-call caps and the observational token reference
 * from /api/agents/profiles. There is no daily budget in this build, so no
 * fictional "% of budget" gauge and no fake save button.
 *
 * @created 2026-02-23
 * @updated 2026-06-10
 */

'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins, TrendingUp, ShieldAlert, Users } from 'lucide-react';
import { useTokenUsage, useTokensByAgent } from '@/hooks/useAgentActivity';
import type { AgentTokenBreakdown } from '@/hooks/useAgentActivity';
import { useAgentProfiles } from '@/hooks/queries/useAgentProfiles';
import { AI_USAGE_ACCOUNTING_LIMITATION_URL } from '@/lib/public-documentation';

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return String(tokens);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/**
 * `$0.00` is only honest when zero is what was measured. When the only runs in
 * the window carried no cost data, the total is unknown and must say so;
 * rendering unknown as `$0.00` would invent a precise figure.
 */
function formatTrackedCost(costUsd: number, unavailableRuns: number): string {
  if (costUsd === 0 && unavailableRuns > 0) return '—';
  return formatCost(costUsd);
}

/**
 * The accounting contract shown beside every total on this page. Until a
 * full nested-provider ledger exists, these numbers are the app's own
 * tracking, not reconciled provider invoice spend.
 */
function UsageAccountingNote({
  settledCostUsd,
  estimatedCostUsd,
  reservedCostUsd,
  unavailableCostRuns,
  unavailableTokenRuns,
}: {
  settledCostUsd: number;
  estimatedCostUsd: number;
  reservedCostUsd: number;
  unavailableCostRuns: number;
  unavailableTokenRuns: number;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" data-testid="usage-accounting-label" className="text-xs font-normal">
          Tracked app estimate
        </Badge>
        <span data-testid="usage-settled" className="text-xs text-muted-foreground">
          {formatCost(settledCostUsd)} settled
        </span>
        {estimatedCostUsd > 0 && (
          <span data-testid="usage-estimated" className="text-xs text-muted-foreground">
            · {formatCost(estimatedCostUsd)} estimated (rate card, not settled)
          </span>
        )}
        {reservedCostUsd > 0 && (
          <span data-testid="usage-reserved" className="text-xs text-muted-foreground">
            · {formatCost(reservedCostUsd)} reserved (in flight, not final)
          </span>
        )}
        {unavailableCostRuns > 0 && (
          <span data-testid="usage-unavailable" className="text-xs text-muted-foreground">
            · {unavailableCostRuns} {unavailableCostRuns === 1 ? 'run' : 'runs'} without cost data (excluded)
          </span>
        )}
        {/* A run whose provider reported no usage is counted here rather than
            summed as 0, so the token total never looks complete when it is not. */}
        {unavailableTokenRuns > 0 && (
          <span data-testid="usage-tokens-unavailable" className="text-xs text-muted-foreground">
            · {unavailableTokenRuns} {unavailableTokenRuns === 1 ? 'run' : 'runs'} without token data (excluded)
          </span>
        )}
      </div>
      <p data-testid="usage-accounting-scope" className="text-xs text-muted-foreground">
        Token counts are what this app recorded per turn — including repeated prompt, cached, and tool context — priced
        from a static rate table. This is not a provider invoice and does not include spend from nested provider calls
        the app never observed.{' '}
        <a
          href={AI_USAGE_ACCOUNTING_LIMITATION_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="usage-limitation-link"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Read the accounting limitation
        </a>
        .
      </p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-3 w-full" />
          <div className="flex justify-between">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function AgentBreakdownCard({ agents, isLoading }: { agents: AgentTokenBreakdown[] | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Per-Agent Breakdown</CardTitle>
              <CardDescription>Loading agent data...</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Per-Agent Breakdown</CardTitle>
              <CardDescription>No agent runs in the past 7 days</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    );
  }

  const totalTokens = agents.reduce((sum, a) => sum + a.totalTokens, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Per-Agent Breakdown</CardTitle>
            <CardDescription>Token usage by agent over the past 7 days</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {agents.map((agent) => {
            const pct = totalTokens > 0 ? Math.round((agent.totalTokens / totalTokens) * 100) : 0;
            return (
              <div key={agent.agentName} className="flex items-center gap-4 rounded-lg border p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{agent.agentName}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {agent.model}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <div className="flex-1">
                      <Progress value={pct} className="h-1.5" />
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{pct}%</span>
                  </div>
                </div>
                <div
                  className="text-right shrink-0"
                  data-testid={`agent-cost-${agent.agentName}`}
                >
                  <p className="text-sm font-semibold">{formatTokens(agent.totalTokens)}</p>
                  {agent.settledCost !== undefined ||
                  agent.estimatedCost !== undefined ||
                  agent.unavailableCostRuns !== undefined ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Settled {formatCost(agent.settledCost ?? 0)} · Estimated{' '}
                        {formatCost(agent.estimatedCost ?? 0)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {agent.unavailableCostRuns ?? 0} unavailable / {agent.runCount} runs
                        {(agent.unavailableTokenRuns ?? 0) > 0
                          ? ` · ${agent.unavailableTokenRuns} without token data`
                          : ''}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {formatCost(agent.totalCost)} / {agent.runCount} runs
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live mission controls and observational token reference, display-only. */
function CostControlsCard() {
  const { data, isLoading } = useAgentProfiles();
  const missionBudget = data?.missionBudget;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Cost Controls</CardTitle>
            <CardDescription>
              Cost and tool-call caps are enforced per mission. Token usage is shown against a configured reference.
              Display-only — change these values via environment variables.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : missionBudget ? (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold">{formatCost(missionBudget.maxCostUsd)}</p>
                {missionBudget.maxCostSource === 'env' && (
                  <Badge variant="outline" className="text-[10px]">
                    env override
                  </Badge>
                )}
              </div>
              <p className="text-xs font-medium mt-0.5">Per-mission cost cap</p>
              <p className="text-xs text-muted-foreground mt-1">
                Hard cap — the agent SDK aborts a mission when its reported spend exceeds this. Env:{' '}
                <code>MISSION_MAX_COST_USD</code>
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-lg font-semibold">{formatTokens(missionBudget.tokenBudget)} tokens</p>
              <p className="text-xs font-medium mt-0.5">Configured token reference</p>
              <p className="text-xs text-muted-foreground mt-1">
                Observed for telemetry only; this does not stop a mission. Env: <code>MISSION_TOKEN_BUDGET</code>
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-lg font-semibold">{missionBudget.maxToolCalls} tool calls</p>
              <p className="text-xs font-medium mt-0.5">Per-mission tool-call cap</p>
              <p className="text-xs text-muted-foreground mt-1">
                Enforced by the mission budget hooks. Env: <code>MISSION_MAX_TOOL_CALLS</code>
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Could not load the live mission controls. The defaults are a $15.00 per-mission cost cap, a configured
            50k-token reference, and 100 tool calls.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Token usage dashboard with real data and honest cost controls.
 *
 * Displays:
 * - Today's usage as absolute numbers (tokens, cost, input/output split) —
 *   no "% of budget" gauge because no daily budget is enforced in this build
 * - Per-agent cost breakdown from real API data
 * - Weekly trend bar chart, bars scaled to the week's own highest day
 * - Enforced per-mission cost/tool-call caps plus the token telemetry reference
 */
export function TokenBudgetDashboard() {
  const { data: tokenUsage, isLoading: isLoadingTokens } = useTokenUsage();
  const { data: agents, isLoading: isLoadingAgents } = useTokensByAgent();

  if (isLoadingTokens) {
    return <DashboardSkeleton />;
  }

  const today = tokenUsage?.today;
  const todayTotal = today?.total ?? 0;
  const todayCost = today?.costUsd ?? 0;
  // A legacy payload predating the split still renders: its whole tracked
  // total is treated as settled, with nothing estimated/reserved/missing.
  const todaySettled = today?.settledCostUsd ?? todayCost;
  const todayEstimated = today?.estimatedCostUsd ?? 0;
  const todayReserved = today?.reservedCostUsd ?? 0;
  const todayUnavailable = today?.unavailableCostRuns ?? 0;
  const todayTokensUnavailable = today?.unavailableTokenRuns ?? 0;
  const todayCostLabel = formatTrackedCost(todayCost, todayUnavailable);

  const thisWeek = tokenUsage?.thisWeek ?? [];
  const maxWeeklyTokens = Math.max(...thisWeek.map((d) => d.total), 1);
  const weeklyTotal = thisWeek.reduce((sum, d) => sum + d.total, 0);
  const weeklyCostTotal = thisWeek.reduce((sum, d) => sum + (d.costUsd ?? 0), 0);
  const weeklyUnavailable = thisWeek.reduce((sum, d) => sum + (d.unavailableCostRuns ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Today's Usage */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Coins className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Today&apos;s Usage</CardTitle>
                <CardDescription>Token consumption for the current day</CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="text-sm" data-testid="usage-today-cost">
              {todayCostLabel} today
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-baseline justify-between">
            <p className="text-2xl font-semibold">{formatTokens(todayTotal)} tokens</p>
            <span className="text-sm text-muted-foreground">{todayCostLabel} tracked today</span>
          </div>
          <UsageAccountingNote
            settledCostUsd={todaySettled}
            estimatedCostUsd={todayEstimated}
            reservedCostUsd={todayReserved}
            unavailableCostRuns={todayUnavailable}
            unavailableTokenRuns={todayTokensUnavailable}
          />
          {today && (
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-xs text-muted-foreground">Input Tokens</p>
                <p className="text-sm font-semibold">{formatTokens(today.input)}</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-xs text-muted-foreground">Output Tokens</p>
                <p className="text-sm font-semibold">{formatTokens(today.output)}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-Agent Breakdown */}
      <AgentBreakdownCard agents={agents} isLoading={isLoadingAgents} />

      {/* Weekly Trend */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Weekly Trend</CardTitle>
                <CardDescription>Token usage over the past 7 days</CardDescription>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold">{formatTokens(weeklyTotal)}</p>
              <p className="text-xs text-muted-foreground">
                {formatTrackedCost(weeklyCostTotal, weeklyUnavailable)} tracked
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {thisWeek.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No usage data available</p>
          ) : (
            <>
              {/* CSS Bar Chart */}
              <div className="flex items-end gap-2 h-32">
                {thisWeek.map((day) => {
                  const heightPercent = maxWeeklyTokens > 0 ? (day.total / maxWeeklyTokens) * 100 : 0;
                  const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
                    weekday: 'short',
                  });
                  return (
                    <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">{formatTokens(day.total)}</span>
                      <div
                        className="w-full rounded-t-sm transition-all bg-primary/60"
                        style={{
                          height: `${Math.max(heightPercent, 4)}%`,
                        }}
                      />
                      <span className="text-xs text-muted-foreground">{dayLabel}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Bars are scaled relative to the week&apos;s highest day — there is no daily budget in this build.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Real Cost Controls (per-mission caps) */}
      <CostControlsCard />
    </div>
  );
}
