/**
 * Sweep Loop Controller — SENSE -> DECIDE -> ACT -> REFLECT -> SLEEP
 *
 * Combines all four sweep steps into a controllable loop.
 * The main export is `runSweepCycle()` which runs one complete cycle.
 * `startSweepLoop()` is a thin wrapper that calls this repeatedly.
 *
 * Key design decisions:
 * - Dependency injection via `SweepDeps` — fully testable without mocking
 * - Single cycle function — easy to test and reason about
 * - AbortSignal — graceful shutdown support
 * - Never crashes — all errors are caught and logged
 */

import type { AgentConfig } from '../config.js';
import type { MissionRunner } from './act.js';
import type { ReflectResult } from './reflect.js';
import type { DetectionResult } from './sense.js';
import { generateDetectionQueries, buildWorkQueue } from './sense.js';
import { decide } from './decide.js';
import { act } from './act.js';
import { reflect } from './reflect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependency interface for the sweep loop */
export interface SweepDeps {
  /** Load agent config */
  loadConfig: (configPath?: string) => AgentConfig;
  /** Create an orchestrator instance (returns a MissionRunner) */
  createOrchestrator: (config: AgentConfig) => MissionRunner;
  /** Execute a Cypher query and return raw records */
  executeCypher: (query: string) => Promise<Array<Record<string, unknown>>>;
  /** Persist sweep results (observations, insights, gaps) */
  persistResults: (result: ReflectResult) => Promise<void>;
  /** Logger */
  log: (message: string) => void;
  /** Create an Episode node for temporal tracking (optional — non-blocking) */
  createEpisode?: (params: {
    agentName: string;
    missionId: string;
    userId: string;
    summary: string;
  }) => Promise<{ id: string }>;
  /** Complete an Episode (optional) */
  completeEpisode?: (episodeId: string, summary?: string) => Promise<void>;
  /** Fail an Episode (optional) */
  failEpisode?: (episodeId: string) => Promise<void>;
}

/** Result of a single sweep cycle */
export interface SweepCycleResult {
  sweepId: string;
  startedAt: string;
  completedAt: string;
  sensed: number;
  decided: number;
  acted: number;
  succeeded: number;
  failed: number;
  insights: number;
  curiosityGaps: number;
  /** null when any mission's cost was unavailable (TEST-021). */
  totalCostUsd: number | null;
  totalTokens: { input: number; output: number };
  skipped: boolean;
  skipReason?: string;
  /** Episode ID if temporal tracking was active */
  episodeId?: string;
}

/** Options for the continuous loop */
export interface SweepLoopOptions {
  configPath?: string;
  signal?: AbortSignal;
  /** Override interval for testing */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique sweep ID.
 *
 * Format: `sweep-<ISO timestamp>-<zero-padded counter>`
 * Example: `sweep-2026-02-23T10:00:00.000Z-001`
 */
export function generateSweepId(counter: number): string {
  const timestamp = new Date().toISOString();
  const paddedCounter = String(counter).padStart(3, '0');
  return `sweep-${timestamp}-${paddedCounter}`;
}

/**
 * Sleep for the given duration, respecting an AbortSignal.
 *
 * Resolves (never rejects) when either:
 * 1. The timeout elapses
 * 2. The signal is aborted
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// ---------------------------------------------------------------------------
// Single Sweep Cycle
// ---------------------------------------------------------------------------

/**
 * Run one complete SENSE -> DECIDE -> ACT -> REFLECT cycle.
 *
 * Returns a summary of the cycle. Never throws — all errors are caught
 * and reflected in the result.
 */
export async function runSweepCycle(
  config: AgentConfig,
  deps: SweepDeps,
  counter: number,
  budgetExhausted = false
): Promise<SweepCycleResult> {
  const sweepId = generateSweepId(counter);
  const startedAt = new Date().toISOString();

  // Base result for early returns
  const baseResult: SweepCycleResult = {
    sweepId,
    startedAt,
    completedAt: '',
    sensed: 0,
    decided: 0,
    acted: 0,
    succeeded: 0,
    failed: 0,
    insights: 0,
    curiosityGaps: 0,
    totalCostUsd: 0,
    totalTokens: { input: 0, output: 0 },
    skipped: false,
  };

  // Check if sweep is enabled
  if (!config.sweep.enabled) {
    return {
      ...baseResult,
      completedAt: new Date().toISOString(),
      skipped: true,
      skipReason: 'Sweep is disabled in config',
    };
  }

  // Episode tracking (created early, completed/failed at end)
  let episodeId: string | undefined;

  try {
    // Create Episode for temporal tracking (non-blocking)
    if (deps.createEpisode) {
      try {
        const episode = await deps.createEpisode({
          agentName: 'sweep',
          missionId: `sweep-${sweepId}`,
          userId: 'system',
          summary: `Sweep cycle ${counter}`,
        });
        episodeId = episode.id;
      } catch {
        // Episode creation is non-blocking
      }
    }

    // ----- SENSE -----
    const queries = generateDetectionQueries({
      priorities: config.sweep.priorities,
    });

    const detectionResults: DetectionResult[] = [];
    for (const query of queries) {
      try {
        const records = await deps.executeCypher(query.cypher);
        detectionResults.push({
          type: query.type,
          records: records.map((r) => ({
            entityId: String(r['entityId'] ?? ''),
            entityType: String(r['entityType'] ?? ''),
            entityName: String(r['entityName'] ?? ''),
            metadata: r,
          })),
        });
      } catch (error) {
        deps.log(
          `[sweep:${sweepId}] SENSE query failed (${query.type}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const workQueue = buildWorkQueue(detectionResults, {
      priorities: config.sweep.priorities,
    });

    // ----- DECIDE -----
    const decideResult = decide(workQueue, {
      maxActionsPerSweep: config.sweep.max_actions_per_sweep,
      budgetExhausted,
    });

    // ----- ACT -----
    const runner = deps.createOrchestrator(config);
    const actResult = await act(decideResult.tasks, runner);

    // ----- REFLECT -----
    const reflectResult = reflect(actResult, sweepId, startedAt);

    // ----- PERSIST -----
    try {
      await deps.persistResults(reflectResult);
    } catch (error) {
      deps.log(
        `[sweep:${sweepId}] PERSIST failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Complete Episode
    if (episodeId && deps.completeEpisode) {
      try {
        const summary = `Sweep ${sweepId}: sensed=${workQueue.length} decided=${decideResult.tasks.length} acted=${actResult.executions.length} insights=${reflectResult.insights.length}`;
        await deps.completeEpisode(episodeId, summary);
      } catch {
        // Episode completion is non-blocking
      }
    }

    return {
      sweepId,
      startedAt,
      completedAt: new Date().toISOString(),
      sensed: workQueue.length,
      decided: decideResult.tasks.length,
      acted: actResult.executions.length,
      succeeded: actResult.successCount,
      failed: actResult.failureCount,
      insights: reflectResult.insights.length,
      curiosityGaps: reflectResult.curiosityGaps.length,
      totalCostUsd: actResult.totalCostUsd,
      totalTokens: actResult.totalTokens,
      skipped: false,
      episodeId,
    };
  } catch (error) {
    // Catch-all: the loop never crashes
    deps.log(`[sweep:${sweepId}] Cycle failed: ${error instanceof Error ? error.message : String(error)}`);

    // Fail Episode if it was created
    if (episodeId && deps.failEpisode) {
      try {
        await deps.failEpisode(episodeId);
      } catch {
        // Non-blocking
      }
    }

    return {
      ...baseResult,
      completedAt: new Date().toISOString(),
      failed: 1,
      skipped: true,
      skipReason: `Cycle error: ${error instanceof Error ? error.message : String(error)}`,
      episodeId,
    };
  }
}

// ---------------------------------------------------------------------------
// Continuous Loop
// ---------------------------------------------------------------------------

/**
 * Start the continuous sweep loop.
 *
 * Loads config once at startup, then runs cycles repeatedly with a sleep interval.
 * Tracks cumulative daily token spend across cycles and sets budgetExhausted
 * when daily_limit is reached.
 *
 * Respects `options.signal` for graceful shutdown.
 * Logs cycle summaries via `deps.log`.
 */
export async function startSweepLoop(options: SweepLoopOptions, deps: SweepDeps): Promise<void> {
  const config = deps.loadConfig(options.configPath);
  const intervalMs = options.intervalMs ?? config.sweep.interval_minutes * 60 * 1000;

  let counter = 0;
  let dailyTokensUsed = 0;

  while (!options.signal?.aborted) {
    counter++;

    const budgetExhausted = dailyTokensUsed >= config.budget.daily_limit;
    const result = await runSweepCycle(config, deps, counter, budgetExhausted);

    // Accumulate daily token spend
    dailyTokensUsed += result.totalTokens.input + result.totalTokens.output;

    deps.log(
      `[sweep] Cycle ${result.sweepId} complete — sensed=${result.sensed} decided=${result.decided} acted=${result.acted} succeeded=${result.succeeded} failed=${result.failed} insights=${result.insights} cost=${result.totalCostUsd === null ? 'unavailable' : '$' + result.totalCostUsd.toFixed(4)} tokens=${dailyTokensUsed}/${config.budget.daily_limit}`
    );

    if (options.signal?.aborted) {
      break;
    }

    await sleep(intervalMs, options.signal);
  }
}
