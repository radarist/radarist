/**
 * DECIDE Step — Rule-Based Task Assignment and Budget Filtering
 *
 * The second phase of the sweep loop (SENSE -> DECIDE -> ACT -> REFLECT).
 * Takes the prioritized work queue from SENSE and:
 *   1. Checks budget constraints (bail early if exhausted)
 *   2. Selects top-N items respecting maxActionsPerSweep
 *   3. Assigns each item to the appropriate subagent
 *
 * Pure function — no LLM calls, no side effects.
 */

import type { WorkItem } from './sense.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A decided task — a work item assigned to a specific agent */
export interface DecidedTask {
  workItem: WorkItem;
  assignedAgent: string;
  reason: string;
}

/** Result of the DECIDE step */
export interface DecideResult {
  tasks: DecidedTask[];
  skipped: Array<{ workItem: WorkItem; reason: string }>;
  budgetExhausted: boolean;
}

/** Configuration for the DECIDE step */
export interface DecideConfig {
  maxActionsPerSweep: number;
  budgetExhausted: boolean;
}

// ---------------------------------------------------------------------------
// Agent Assignment Rules
// ---------------------------------------------------------------------------

/** Maps work item type to the responsible subagent */
export const AGENT_ASSIGNMENT: Record<WorkItem['type'], { agent: string; reason: string }> = {
  orphan_entity: { agent: 'linker', reason: 'Connect orphan entities to the graph' },
  stale_entity: { agent: 'curator', reason: 'Refresh stale entity data' },
  incomplete_entity: { agent: 'curator', reason: 'Fill missing entity fields' },
  unscored_signal: { agent: 'evaluator', reason: 'Score unscored signals' },
  attention_hotspot: { agent: 'scout', reason: 'Research high-attention entities deeper' },
  external_monitoring: { agent: 'scout', reason: 'Monitor external sources for new intelligence' },
};

// ---------------------------------------------------------------------------
// DECIDE Function
// ---------------------------------------------------------------------------

/**
 * Filter and assign work items from the SENSE step.
 *
 * Rules:
 * 1. If budget is exhausted, skip all items
 * 2. Take top N items by priority (N = maxActionsPerSweep)
 * 3. Assign each item to the appropriate agent
 *
 * The work queue is expected to already be sorted by priority (descending)
 * from the SENSE step's `buildWorkQueue()`.
 */
export function decide(workQueue: WorkItem[], config: DecideConfig): DecideResult {
  // Budget check — bail early if exhausted
  if (config.budgetExhausted) {
    return {
      tasks: [],
      skipped: workQueue.map((item) => ({
        workItem: item,
        reason: 'Budget exhausted',
      })),
      budgetExhausted: true,
    };
  }

  // Select top-N items; remainder goes to skipped
  const selected = workQueue.slice(0, config.maxActionsPerSweep);
  const remainder = workQueue.slice(config.maxActionsPerSweep);

  const tasks: DecidedTask[] = selected.map((item) => {
    const assignment = AGENT_ASSIGNMENT[item.type];
    return {
      workItem: item,
      assignedAgent: assignment.agent,
      reason: assignment.reason,
    };
  });

  const skipped = remainder.map((item) => ({
    workItem: item,
    reason: `Exceeded max actions per sweep (${config.maxActionsPerSweep})`,
  }));

  return {
    tasks,
    skipped,
    budgetExhausted: false,
  };
}
