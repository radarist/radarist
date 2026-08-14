/**
 * @file interactive-read.ts
 * @description Caller-latency budget for user-facing (interactive) Neo4j reads.
 *
 * PERF-008 — when Neo4j is unreachable, a plain `runReadTransaction` can take
 * 33–60s to surface a failure: the driver's connection-acquisition budget
 * (`connectionAcquisitionTimeout`, 30s) and the transaction-function retry
 * budget (`maxTransactionRetryTime`, 30s) stack. That is the right behaviour
 * for BACKGROUND writers (the Inngest sync / reconcile workers legitimately
 * want to ride out a transient blip), but a user staring at the Claims panel
 * or the Insights feed should get an honest "unavailable" within a bounded,
 * measured time — not a minute-long hang.
 *
 * Those budgets live on the shared driver and cannot be lowered without
 * weakening the workers, and the interactive read functions
 * (`getAssertionsForEntity`, `getInsightsForUser`, …) are shared with
 * worker-reachable callers (e.g. `confidence-calibration`), so they cannot be
 * bounded in place either. The correct seam is therefore the interactive
 * ENTRY point — the API route — which wraps its graph work in a wall-clock
 * deadline here.
 *
 * This bounds the CALLER-observed latency; it does not close the driver
 * session (the shared read function owns that), so a genuine outage still
 * costs the driver its background retry before it gives up — but the user is
 * unblocked at the budget and the response is a sanitized 503. A full
 * driver-level fix (a dedicated interactive connection pool with short
 * budgets) is deliberately deferred to avoid touching worker-shared reads.
 *
 * Transient resilience is preserved: `executeRead` still retries inside the
 * budget window, so a blip that clears within the budget succeeds normally —
 * only a sustained outage trips the deadline.
 */

import { GraphUnavailableError } from './errors';

/**
 * Wall-clock budget, in milliseconds, for a single interactive graph read.
 * Overridable via `NEO4J_INTERACTIVE_READ_BUDGET_MS` (clamped to a sane floor
 * so a mis-set env can't make interactive reads fail instantly). Chosen to sit
 * comfortably above a healthy read (single-digit ms) and a couple of transient
 * retries, but far below the driver's stacked 60s worst case.
 */
export const INTERACTIVE_GRAPH_READ_BUDGET_MS = (() => {
  const raw = process.env.NEO4J_INTERACTIVE_READ_BUDGET_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 8000;
})();

/**
 * Run an interactive graph read under a wall-clock deadline.
 *
 * Resolves with the read's result when it completes in time. If the budget
 * elapses first, rejects with a {@link GraphUnavailableError} (which the API
 * routes already translate into a sanitized 503 `degraded` response), and
 * detaches the still-running read so its eventual rejection does not surface
 * as an unhandled promise rejection.
 *
 * @param operation - short label for the read (e.g. 'claims', 'briefing'),
 *   surfaced on the error for logging/telemetry.
 * @param work - starts the graph read; called exactly once.
 * @param budgetMs - override the default budget (mainly for tests).
 */
export async function withGraphReadDeadline<T>(
  operation: string,
  work: () => Promise<T>,
  budgetMs: number = INTERACTIVE_GRAPH_READ_BUDGET_MS
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const workPromise = work();
  // If the deadline wins the race, the underlying read keeps running and may
  // reject later (the driver finally giving up). Register a no-op handler so
  // that late rejection is considered handled — the caller already has the
  // GraphUnavailableError. This does not affect the raced `workPromise`.
  workPromise.catch(() => undefined);

  try {
    return await Promise.race([
      workPromise,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => {
          reject(
            new GraphUnavailableError(operation, 'neo4j', `Graph read exceeded the ${budgetMs}ms interactive budget.`)
          );
        }, budgetMs);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}
