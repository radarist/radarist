/**
 * Wall-clock deadline wrapper for Firestore (and other) async operations.
 *
 * The Firestore client/admin SDKs do not enforce a per-call deadline by
 * default. When the underlying gRPC connection stalls (transient network
 * issue, large payload, regional brownout), `setDoc` / `update` calls can
 * hang for tens of minutes before the gRPC layer's own DEADLINE_EXCEEDED
 * fires. During that hang, agent missions block on the tool-result and
 * the watchdog can detect idle but cannot interrupt the in-flight
 * promise.
 *
 * A stalled write can outlive the orchestrator watchdog because the SDK stream
 * is still waiting on the tool result. The caller therefore needs its own
 * bounded deadline rather than relying on the transport's eventual timeout.
 *
 * `withDeadline` wraps any promise in a Promise.race against a
 * setTimeout, throwing a clear deadline error if the deadline elapses
 * first. The original promise is *not* aborted (we have no handle to
 * the Firestore call), but the throw frees the caller's stack to
 * propagate the error.
 */

const DEFAULT_DEADLINE_MS = 60_000; // 60s — generous for Firestore writes

export class FirestoreDeadlineError extends Error {
  constructor(
    public readonly opName: string,
    public readonly deadlineMs: number
  ) {
    super(`Firestore op "${opName}" exceeded ${deadlineMs}ms deadline`);
    this.name = 'FirestoreDeadlineError';
  }
}

/**
 * Wrap a Firestore (or any) async operation in a wall-clock deadline.
 *
 * @param op - The async operation to run.
 * @param opName - Human-readable name for diagnostics ("createReport.setDoc",
 *   "updateMission.update", etc.). Surfaces in the error message.
 * @param deadlineMs - Deadline in milliseconds. Defaults to 60_000.
 * @returns The op's resolved value, or throws FirestoreDeadlineError if
 *   the deadline elapses first.
 */
export async function withDeadline<T>(
  op: Promise<T>,
  opName: string,
  deadlineMs: number = DEFAULT_DEADLINE_MS
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const deadlinePromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new FirestoreDeadlineError(opName, deadlineMs));
    }, deadlineMs);
  });

  try {
    return await Promise.race([op, deadlinePromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
