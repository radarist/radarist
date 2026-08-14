/**
 * @file with-timeout.ts
 * @description Generic promise timeout helper.
 *
 * Races a promise against a timer and rejects with a labeled Error when the
 * budget is exceeded. The timer is always cleared in `finally`, so a resolved
 * promise never leaves a dangling timeout keeping the event loop (or a Jest
 * worker) alive. Note the underlying promise is NOT cancelled — it keeps
 * running and its eventual result is discarded.
 *
 * Shared by the AI chat route (server-memory injection budget) and the
 * /api/health route (per-dependency probe budget). For Firestore-specific
 * deadline handling see `firestore-deadline.ts`, which is intentionally
 * separate (it wraps typed FirestoreDeadlineError semantics).
 */

/**
 * Resolves with the promise's value, or rejects with
 * `Error("<label> timed out after <ms>ms")` when the timeout elapses first.
 *
 * @param promise - The promise to bound.
 * @param ms - Timeout budget in milliseconds.
 * @param label - Human-readable operation name used in the timeout error.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
