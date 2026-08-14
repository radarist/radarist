/**
 * REFLECT Step — Observations, Insights, and Curiosity Gaps
 *
 * The fourth and final phase of the sweep loop (SENSE -> DECIDE -> ACT -> REFLECT).
 * Processes the ACT step's results into structured records:
 *   1. AgentObservation records — what each agent did
 *   2. AgentRunRecord — overall sweep cycle resource consumption
 *   3. ProactiveInsight records — potential discoveries for users
 *   4. CuriosityGap records — failed tasks for retry/escalation
 *
 * Key design decisions:
 * - Pure data transformation — no graph writes, no MCP calls
 * - No LLM calls — deterministic processing only
 * - The sweep loop controller (Task 4.5) handles persistence
 */

import type { ActResult, TaskExecution } from './act.js';
import type { WorkItem } from './sense.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An observation about what an agent did */
export interface AgentObservation {
  agentName: string;
  entityId: string;
  entityType: string;
  entityName: string;
  action: string;
  resultSummary: string;
  success: boolean;
  timestamp: string;
}

/** Record of the sweep cycle's resource consumption */
export interface AgentRunRecord {
  sweepId: string;
  startedAt: string;
  completedAt: string;
  /** null when any mission's cost was unavailable (TEST-021). */
  totalCostUsd: number | null;
  totalTokens: { input: number; output: number };
  taskCount: number;
  successCount: number;
  failureCount: number;
  observations: AgentObservation[];
}

/** A potential proactive insight for users */
export interface ProactiveInsight {
  entityId: string;
  entityType: string;
  entityName: string;
  agentName: string;
  summary: string;
  confidence: 'low' | 'medium' | 'high';
  /** Numeric confidence score (0-1) for threshold comparison */
  confidenceScore: number;
  /** Related entity IDs (initially just the primary entity) */
  relatedEntities: string[];
  /** Whether this insight is actionable (triggers AUTO-ACT when enabled) */
  actionable: boolean;
  timestamp: string;
}

/** A curiosity gap — something the system couldn't resolve */
export interface CuriosityGap {
  entityId: string;
  entityType: string;
  entityName: string;
  type: WorkItem['type'];
  failureReason: string;
  retryCount: number;
  timestamp: string;
}

/** Full result of the REFLECT step */
export interface ReflectResult {
  agentRun: AgentRunRecord;
  insights: ProactiveInsight[];
  curiosityGaps: CuriosityGap[];
}

/** Configuration for REFLECT */
export interface ReflectConfig {
  /** Max length for result summaries */
  maxSummaryLength: number;
  /** Keywords that suggest a proactive insight */
  insightKeywords: string[];
  /** Minimum confidence score (0-1) to include an insight. Default 0.0 (include all). */
  confidenceThreshold: number;
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

export const DEFAULT_REFLECT_CONFIG: ReflectConfig = {
  maxSummaryLength: 500,
  insightKeywords: [
    'discovered',
    'found',
    'new connection',
    'emerging',
    'trend',
    'unexpected',
    'significant',
    'breakthrough',
    'opportunity',
    'competitor',
    'acquisition',
    'partnership',
    'pivot',
  ],
  confidenceThreshold: 0.0,
};

// ---------------------------------------------------------------------------
// Action Descriptions
// ---------------------------------------------------------------------------

/** Map work item type to a human-readable action description */
const ACTION_DESCRIPTIONS: Record<WorkItem['type'], string> = {
  orphan_entity: 'linked orphan entity',
  stale_entity: 'refreshed stale data',
  incomplete_entity: 'filled missing fields',
  unscored_signal: 'scored signal',
  attention_hotspot: 'researched attention hotspot',
  external_monitoring: 'monitored external source',
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Truncate result text for summaries.
 * Returns empty string for undefined/empty input.
 * Appends '...' when truncation occurs.
 */
export function truncateResult(text: string | undefined, maxLength: number): string {
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + '...';
}

/**
 * Build AgentObservation records from ACT execution results.
 * Creates one observation per execution (both successes and failures).
 */
export function buildObservations(
  executions: TaskExecution[],
  config?: Partial<ReflectConfig>,
  timestamp?: string
): AgentObservation[] {
  const cfg: ReflectConfig = { ...DEFAULT_REFLECT_CONFIG, ...config };
  const now = timestamp ?? new Date().toISOString();

  return executions.map((execution) => {
    const { task, result } = execution;
    const { workItem, assignedAgent } = task;

    const action = result.success ? ACTION_DESCRIPTIONS[workItem.type] : `failed to handle ${workItem.type}`;

    const resultSummary = result.success
      ? truncateResult(result.result, cfg.maxSummaryLength)
      : truncateResult(result.errors?.join('; ') ?? 'Unknown error', cfg.maxSummaryLength);

    return {
      agentName: assignedAgent,
      entityId: workItem.entityId,
      entityType: workItem.entityType,
      entityName: workItem.entityName,
      action,
      resultSummary,
      success: result.success,
      timestamp: now,
    };
  });
}

/**
 * Detect proactive insights from successful execution results.
 *
 * Scans result text for insight keywords (case-insensitive).
 * Confidence is based on keyword match ratio:
 *   - 3+ matches: 'high' (score 0.9)
 *   - 2 matches: 'medium' (score 0.6)
 *   - 1 match: 'low' (score 0.3)
 *
 * Insights below confidenceThreshold are filtered out.
 */
export function detectInsights(
  executions: TaskExecution[],
  config?: Partial<ReflectConfig>,
  timestamp?: string
): ProactiveInsight[] {
  const cfg: ReflectConfig = { ...DEFAULT_REFLECT_CONFIG, ...config };
  const now = timestamp ?? new Date().toISOString();
  const insights: ProactiveInsight[] = [];

  for (const execution of executions) {
    const { task, result } = execution;

    // Only consider successful executions with result text
    if (!result.success || !result.result) {
      continue;
    }

    const resultLower = result.result.toLowerCase();
    const matchCount = cfg.insightKeywords.filter((keyword) => resultLower.includes(keyword.toLowerCase())).length;

    if (matchCount === 0) {
      continue;
    }

    const confidence: ProactiveInsight['confidence'] = matchCount >= 3 ? 'high' : matchCount === 2 ? 'medium' : 'low';

    const confidenceScore = matchCount >= 3 ? 0.9 : matchCount === 2 ? 0.6 : 0.3;

    // Apply confidence threshold filter
    if (confidenceScore < cfg.confidenceThreshold) {
      continue;
    }

    insights.push({
      entityId: task.workItem.entityId,
      entityType: task.workItem.entityType,
      entityName: task.workItem.entityName,
      agentName: task.assignedAgent,
      summary: truncateResult(result.result, 200),
      confidence,
      confidenceScore,
      relatedEntities: [task.workItem.entityId],
      actionable: false, // TODO: enable when AUTO-ACT is configured
      timestamp: now,
    });
  }

  return insights;
}

/**
 * Build CuriosityGap records from failed executions.
 * Each failed execution becomes a gap that can be retried or escalated.
 *
 * Note: Gap deduplication and retryCount incrementing is the responsibility
 * of the persistence layer (sweep loop controller), not REFLECT.
 */
export function buildCuriosityGaps(executions: TaskExecution[], timestamp?: string): CuriosityGap[] {
  const now = timestamp ?? new Date().toISOString();

  return executions
    .filter((execution) => !execution.result.success)
    .map((execution) => {
      const { task, result } = execution;
      const { workItem } = task;

      const failureReason = result.errors?.join('; ') ?? 'Unknown failure reason';

      return {
        entityId: workItem.entityId,
        entityType: workItem.entityType,
        entityName: workItem.entityName,
        type: workItem.type,
        failureReason,
        retryCount: 0,
        timestamp: now,
      };
    });
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * REFLECT — Process ACT results into observations, insights, and curiosity gaps.
 *
 * This is the main entry point for the REFLECT step. It:
 *   1. Builds AgentObservation records for all executions
 *   2. Detects proactive insights from successful results
 *   3. Builds CuriosityGap records from failed executions
 *   4. Assembles the AgentRunRecord with overall metrics
 *
 * Returns a ReflectResult that the sweep loop controller can persist.
 */
export function reflect(
  actResult: ActResult,
  sweepId: string,
  startedAt: string,
  config?: Partial<ReflectConfig>
): ReflectResult {
  const now = new Date().toISOString();
  const observations = buildObservations(actResult.executions, config, now);
  const insights = detectInsights(actResult.executions, config, now);
  const curiosityGaps = buildCuriosityGaps(actResult.executions, now);

  const agentRun: AgentRunRecord = {
    sweepId,
    startedAt,
    completedAt: now,
    totalCostUsd: actResult.totalCostUsd,
    totalTokens: actResult.totalTokens,
    taskCount: actResult.executions.length,
    successCount: actResult.successCount,
    failureCount: actResult.failureCount,
    observations,
  };

  return {
    agentRun,
    insights,
    curiosityGaps,
  };
}
