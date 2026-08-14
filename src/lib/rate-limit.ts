/**
 * @file rate-limit.ts
 * @description Per-key in-process token bucket for API rate limiting.
 *
 * Used by Option A's engagement endpoints (like/unlike, view tracker,
 * bulk-dismiss) to cap a single user's request rate at 60 req/min by
 * default. This is the only client-spam
 * defence — the underlying writes are idempotent, so a bot retrying
 * forever can't corrupt state, but it can still chew Neo4j and Firebase
 * quota.
 *
 * Limitations:
 *   - In-process only: each Node worker has its own bucket. Suitable for
 *     the single-process OSS-prototype dev server. Production multi-worker
 *     deployments need redis or a sticky-session router; tracked as a
 *     follow-up if/when this leaves prototype scope.
 *   - No persistence: a server restart resets every bucket.
 *   - No clock-drift handling: uses `Date.now()` directly.
 *
 * Choice of token bucket over fixed-window: smooths bursts (a user who
 * sat idle for 5 minutes can spend their saved tokens immediately, then
 * is throttled back to refill rate). Matches "human clicks the like
 * button" behaviour better than a fixed window.
 */

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

interface Bucket {
  /** Tokens remaining (fractional during refill). */
  tokens: number;
  /** Last refill timestamp (ms since epoch). */
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Periodically prune buckets that haven't been touched in 10 windows.
 * Prevents unbounded growth if many one-off users hit the endpoint.
 * The interval is `unref`'d so it never holds the process open.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_STALE_MS = 10 * DEFAULT_WINDOW_MS;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
function startPruner(): void {
  if (pruneTimer || typeof setInterval !== 'function') return;
  pruneTimer = setInterval(() => {
    const cutoff = Date.now() - PRUNE_STALE_MS;
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < cutoff) buckets.delete(key);
    }
  }, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
}

/**
 * Try to consume one token from the bucket identified by `key`.
 *
 * Returns `{ allowed: true, remaining }` when a token was available, or
 * `{ allowed: false, retryAfterMs }` when the bucket is empty. The token
 * refill rate is `limit / windowMs` tokens per millisecond, bucket
 * capacity is `limit`.
 *
 * The key shape is up to the caller — typically `"<route>:<userId>"`.
 */
export function consumeRateLimitToken(
  key: string,
  options: { limit?: number; windowMs?: number } = {}
): { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number } {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (limit <= 0 || windowMs <= 0) {
    // Misconfigured limiter shouldn't break the route — treat as unlimited.
    return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  }
  startPruner();
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const refill = (elapsed / windowMs) * limit;
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }
  const deficit = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil((deficit / limit) * windowMs);
  return { allowed: false, retryAfterMs };
}

/** Test-only helper to reset state between cases. Not exported in routes. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
