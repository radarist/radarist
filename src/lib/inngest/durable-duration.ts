/**
 * @file lib/inngest/durable-duration.ts
 * @description OBS-006 — measure how long a checkpointed Inngest run actually
 * took, across retries, sleeps, resumes and process restarts.
 *
 * ## The measurement bug this closes
 *
 * Inngest v3 executes one run as a SERIES of HTTP requests, replaying memoized
 * step state on each. A bare `const startTime = Date.now()` in the handler body
 * is therefore re-initialised on **every** request, so `Date.now() - startTime`
 * at the end measures only the final invocation slice.
 *
 * On a replayed run, the final invocation slice can be tiny even when the
 * persisted `startedAt`→`completedAt` span covers the whole long-running job.
 * Operators need the durable span, not the last HTTP request's duration.
 *
 * ARUN-002 already fixed this for `run-agent-mission` by memoizing both
 * endpoints in `step.run`. This module makes that the shared, reusable
 * contract instead of a pattern one function happens to follow.
 *
 * ## Why memoizing is sufficient — and why it must be a step
 *
 * A `step.run` result is persisted by Inngest and handed back verbatim on every
 * later request of the same run. So a timestamp captured inside a step is a
 * DURABLE instant: it survives replay, retry, sleep and restart. The same value
 * read outside a step is not — which is the whole bug. (The related trap, from
 * the PERF-007 reconciler: a step that records work by mutating handler-closure
 * state instead of RETURNING it loses that work on replay, because Inngest
 * memoizes a step by its return value.)
 *
 * ## Units are named, not implied
 *
 * Every field this module produces ends in `Ms`. The pre-fix field was called
 * `duration`, which a reader had to guess the unit of — and `9` was a plausible
 * number of seconds for a fast job, which is part of why the lie survived.
 */

/**
 * Minimal `step` surface needed here — keeps this module free of SDK types (and
 * therefore unit-testable with a two-line fake).
 *
 * Deliberately NON-generic: the SDK's `step.run` returns `Jsonify<T>`, which a
 * generic `<T>(…) => Promise<T>` signature is not assignable to. Pinning the
 * return type to `number` — the only thing this module ever captures — makes the
 * real `step` object satisfy it directly.
 */
export interface DurableInstantStep {
  run(id: string, handler: () => number): Promise<number>;
}

/**
 * Capture a durable wall-clock instant, memoized under `stepId`.
 *
 * Use for both the start and the terminal endpoint of anything whose elapsed
 * time gets reported. Reading `Date.now()` outside a step for this purpose is
 * the OBS-006 bug.
 */
export async function captureDurableInstantMs(step: DurableInstantStep, stepId: string): Promise<number> {
  return step.run(stepId, () => Date.now());
}

/**
 * A durable timestamp that came from somewhere other than a step.
 *
 * The only safe sources are values that cannot change across replay: a field on
 * the triggering EVENT (e.g. deep research's `triggeredAt` attempt token, which
 * doubles as the instant the work was accepted), or a timestamp already
 * persisted in Firestore. Anything computed in the handler body is not durable.
 */
export function parseDurableInstantMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Elapsed-time report for one checkpointed run.
 *
 * The phases are kept SEPARATE rather than summed into one number, because they
 * answer different questions and have different owners:
 * - `queueWaitMs` — accepted → execution start. Scheduler/backpressure.
 * - `executionMs` — execution start → terminal. The run's own wall time.
 * - `totalMs` — accepted → terminal. What the user experienced.
 * - `providerMs` — time inside the paid provider call(s), when measurable.
 *
 * A phase whose endpoints are not both known is ABSENT, never zero. Zero is a
 * measurement, and reporting an unmeasured phase as zero is how `duration: 9`
 * came to sit next to a 561-second span without contradiction.
 */
export interface DurableTimingMs {
  totalMs?: number;
  queueWaitMs?: number;
  executionMs?: number;
  providerMs?: number;
  /**
   * Which endpoints were actually available, so a consumer can tell a genuinely
   * instant job from one whose timing could not be established.
   */
  basis: 'accepted-to-terminal' | 'started-to-terminal' | 'incomplete';
}

function nonNegativeSpan(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  // Clamped at zero rather than allowed negative: clocks can skew across a
  // restart, and a negative elapsed time is never a useful report.
  return Math.max(0, to - from);
}

/**
 * Derive the elapsed-time report from durable endpoints.
 *
 * `acceptedAtMs` is optional because not every trigger carries one; when it is
 * present the report distinguishes queue wait from execution, which is the
 * difference between "the system was slow" and "the job was slow".
 */
export function deriveDurableTimingMs(input: {
  acceptedAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  providerMs?: number;
}): DurableTimingMs {
  const { acceptedAtMs, startedAtMs, completedAtMs } = input;
  const executionMs = nonNegativeSpan(startedAtMs, completedAtMs);
  const queueWaitMs = nonNegativeSpan(acceptedAtMs, startedAtMs);
  const totalMs = nonNegativeSpan(acceptedAtMs ?? startedAtMs, completedAtMs);

  const basis: DurableTimingMs['basis'] =
    completedAtMs === undefined
      ? 'incomplete'
      : acceptedAtMs !== undefined
        ? 'accepted-to-terminal'
        : startedAtMs !== undefined
          ? 'started-to-terminal'
          : 'incomplete';

  return {
    ...(totalMs !== undefined ? { totalMs } : {}),
    ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
    ...(executionMs !== undefined ? { executionMs } : {}),
    ...(input.providerMs !== undefined && Number.isFinite(input.providerMs)
      ? { providerMs: Math.max(0, input.providerMs) }
      : {}),
    basis,
  };
}
