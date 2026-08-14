/**
 * ACT Step — Sequential Task Execution via Orchestrator
 *
 * The third phase of the sweep loop (SENSE -> DECIDE -> ACT -> REFLECT).
 * Takes decided tasks from DECIDE and executes them by calling the
 * orchestrator's runMission() with a formatted prompt that references
 * the assigned agent.
 *
 * Key design decisions:
 * - Sequential execution (not parallel) to bound concurrent spend and preserve ordering
 * - MissionRunner dependency injection for testability
 * - Never crashes — catches runner errors and records them as failures
 * - All tasks are attempted even if some fail
 */

import type { DecidedTask } from './decide.js';
import type { MissionResult } from '../orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of executing a single task */
export interface TaskExecution {
  task: DecidedTask;
  result: MissionResult;
}

/** Result of the ACT step */
export interface ActResult {
  executions: TaskExecution[];
  /** null when any executed mission's cost was unavailable — the aggregate
   * total cannot omit an unpriceable mission (TEST-021). */
  totalCostUsd: number | null;
  totalTokens: { input: number; output: number };
  successCount: number;
  failureCount: number;
}

/** Dependency: something that can run a mission */
export interface MissionRunner {
  runMission(prompt: string): Promise<MissionResult>;
}

// ---------------------------------------------------------------------------
// Prompt Formatting
// ---------------------------------------------------------------------------

/**
 * Format a decided task into a mission prompt.
 *
 * The prompt instructs the orchestrator to use the assigned agent
 * and provides context about what needs to be done.
 */
export function formatTaskPrompt(task: DecidedTask): string {
  const { workItem, assignedAgent, reason } = task;
  return [
    `Use the ${assignedAgent} agent to handle the following task.`,
    ``,
    `Task: ${reason}`,
    `Entity: ${workItem.entityName} (${workItem.entityType}, ID: ${workItem.entityId})`,
    `Detection: ${workItem.type} (priority: ${workItem.priority})`,
    workItem.metadata ? `Context: ${JSON.stringify(workItem.metadata)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// ACT Function
// ---------------------------------------------------------------------------

/**
 * Execute all decided tasks sequentially.
 *
 * Tasks are executed one at a time so sweep actions do not create concurrent
 * spend spikes and their recorded outcomes retain decision order.
 *
 * If the runner throws an error, the error is caught and recorded as a
 * failure result — execution continues with the remaining tasks.
 */
export async function act(tasks: DecidedTask[], runner: MissionRunner): Promise<ActResult> {
  const executions: TaskExecution[] = [];
  let totalCostUsd: number | null = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let successCount = 0;
  let failureCount = 0;

  for (const task of tasks) {
    const prompt = formatTaskPrompt(task);

    try {
      const result = await runner.runMission(prompt);
      executions.push({ task, result });

      // Once any mission's cost is unavailable, the aggregate total is too —
      // never a partial sum that omits an unpriceable mission (TEST-021).
      if (result.costUsd === null) {
        totalCostUsd = null;
      } else if (totalCostUsd !== null) {
        totalCostUsd += result.costUsd;
      }
      totalInput += result.tokenUsage.input;
      totalOutput += result.tokenUsage.output;

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    } catch (error) {
      const errorResult: MissionResult = {
        success: false,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        errors: [error instanceof Error ? error.message : String(error)],
      };
      executions.push({ task, result: errorResult });
      failureCount++;
    }
  }

  return {
    executions,
    totalCostUsd,
    totalTokens: { input: totalInput, output: totalOutput },
    successCount,
    failureCount,
  };
}
