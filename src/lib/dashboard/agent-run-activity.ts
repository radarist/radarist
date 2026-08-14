/**
 * @file lib/dashboard/agent-run-activity.ts
 * @description Pure projections from the live `AgentRun` shape onto the
 * dashboard's `AgentActivity` view model + aggregate stats.
 *
 * The dashboard's `AgentFeedPanel`, `NeedsAttentionPanel`, and portfolio
 * `agentMetrics` were all built against `AgentActivity` (the shape the dead
 * `agent-activities` collection used). Rather than rewrite three UI surfaces,
 * DISC-008 keeps that view model and maps the real, written data — agent runs
 * (`@/lib/schemas/agent-run`) — into it here. Kept as pure functions so they
 * are trivially unit-testable and reusable across dashboard code paths.
 */

import type { AgentRun } from '@/lib/schemas/agent-run';
import type { AgentActivity, AgentType, AgentActivityStatus } from '@/lib/types';

/**
 * Map a mission-runtime `agentName` (scout, evaluator, …) onto the dashboard's
 * `AgentType` enum so the existing icon / colour / `getAgentDestination`
 * lookups keep working unchanged. Unknown names fall back to the generic
 * `InnovationAgent` bucket.
 */
const AGENT_NAME_TO_TYPE: Record<string, AgentType> = {
  scout: 'ScoutAgent',
  evaluator: 'EvaluationAgent',
  linker: 'LinkerAgent',
  curator: 'MonitorAgent',
  strategist: 'PortfolioAgent',
  creator: 'PrototypeAgent',
  monitor: 'MonitorAgent',
  innovation: 'InnovationAgent',
};

export function agentNameToType(name: string | undefined): AgentType {
  if (!name) return 'InnovationAgent';
  return AGENT_NAME_TO_TYPE[name.toLowerCase()] ?? 'InnovationAgent';
}

const RUN_STATUS_TO_ACTIVITY: Record<AgentRun['status'], AgentActivityStatus> = {
  success: 'completed',
  failure: 'failed',
  skipped: 'completed',
};

/** Parse an ISO-8601 `createdAt` into epoch millis (the feed renders relative
 * time from a number). Returns 0 for a missing/invalid value rather than NaN. */
function toMillis(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Project a single agent run into the `AgentActivity` view model the dashboard
 * panels consume. A `partial` run (checkpoint-recovered) surfaces as
 * `needs_review`; a `failure` as a high-priority `failed`.
 */
export function agentRunToActivity(run: AgentRun): AgentActivity {
  const createdAt = toMillis(run.createdAt);
  const failed = run.status === 'failure';
  const status: AgentActivityStatus = run.partial
    ? 'needs_review'
    : (RUN_STATUS_TO_ACTIVITY[run.status] ?? 'completed');

  return {
    id: run.id,
    type: 'automation',
    title: run.action || `${run.agentName} run`,
    description: failed
      ? run.errors?.[0] || 'The agent run failed.'
      : `${run.agentName} · ${run.model ?? 'model n/a'} · ${run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : 'cost unavailable'}`,
    agent: agentNameToType(run.agentName),
    status,
    priority: failed ? 'high' : 'medium',
    relatedEntities: {},
    createdAt,
    updatedAt: createdAt,
  };
}

export interface AgentActivityStats {
  /** Total runs in the window. */
  total: number;
  /** Runs that need a human look (failures). Surfaced in the "pending review" card. */
  pendingReviewCount: number;
  /** Percent of processed (non-skipped) runs that succeeded, 0–100. */
  completionRate: number;
  /** Run count per dashboard `AgentType`. */
  byAgent: Record<string, number>;
}

/**
 * Aggregate a batch of runs into the dashboard `agentMetrics` shape. Skipped
 * runs count toward `total` but not toward the success/failure completion rate.
 */
export function deriveAgentActivityStats(runs: AgentRun[]): AgentActivityStats {
  const byAgent: Record<string, number> = {};
  let completed = 0;
  let failed = 0;

  for (const run of runs) {
    const agent = agentNameToType(run.agentName);
    byAgent[agent] = (byAgent[agent] ?? 0) + 1;
    if (run.status === 'success') completed++;
    else if (run.status === 'failure') failed++;
  }

  const processed = completed + failed;
  return {
    total: runs.length,
    pendingReviewCount: failed,
    completionRate: processed > 0 ? Math.round((completed / processed) * 100) : 0,
    byAgent,
  };
}
