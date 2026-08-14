/**
 * @file disposable-firestore-target.ts
 * @description Fail-closed guard for destructive full-collection Firestore
 * writes and resets (seed-demo, seed-emulator).
 *
 * A reset batch-deletes entire collections — including `relations`, the
 * relation-triple locks (`relationTriples`), and the durable
 * `relationSyncOutbox` — with no per-relation outbox marker and no
 * lock-ownership check. That is only ever safe against a disposable local
 * emulator, never a real project (GRAPH-038). This guard is the single
 * canonical predicate every such reset must pass BEFORE it deletes anything.
 *
 * Fail-closed contract — the guard throws unless BOTH hold:
 *   1. The Firebase project id is a disposable `demo-*` id. This is the
 *      load-bearing production reject: a real project id (e.g. `radarist-glyyr`)
 *      is refused outright.
 *   2. If `FIRESTORE_EMULATOR_HOST` is explicitly set, it points at a loopback
 *      emulator (127.0.0.1 / localhost / ::1). An unset host is tolerated
 *      because the seeds fall back to the loopback default and
 *      `connectFirestoreEmulator` pins routing to that local emulator — a
 *      developer who started the emulator in a separate shell (host unset) is a
 *      supported flow; a host pointed at a remote/shared emulator is not.
 *
 * Mirrors the disposable-target guards in graph-ci-fixture.ts / graph-canary.ts
 * / repair-relation-integrity.ts so the whole scripts surface shares one notion
 * of "disposable Firestore target".
 */

/** True when `value` (a `host`, `host:port`, or `[ipv6]:port`) resolves to a loopback host. */
export function isLoopbackHost(value: string): boolean {
  let host = value.replace(/^https?:\/\//, '');
  if (host.startsWith('[')) {
    // Bracketed IPv6, e.g. `[::1]:8080` or `[::1]` — take the address inside the brackets.
    const close = host.indexOf(']');
    host = close === -1 ? host.slice(1) : host.slice(1, close);
  } else if (host.includes(':') && host.indexOf(':') === host.lastIndexOf(':')) {
    // A single colon means `host:port`; strip the port.
    host = host.slice(0, host.indexOf(':'));
  }
  // Otherwise (no colon, or multiple colons without brackets → a bare IPv6 like `::1`), keep as-is.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export interface DisposableFirestoreTarget {
  projectId: string;
  /** The explicit `FIRESTORE_EMULATOR_HOST`, or null when relying on the loopback default. */
  emulatorHost: string | null;
}

/**
 * Throws unless the resolved Firestore target is a disposable local emulator.
 * Callers MUST invoke this before any destructive batch delete / full-collection
 * clear. Returns the validated target for logging.
 */
export function assertDisposableFirestoreResetTarget(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env
): DisposableFirestoreTarget {
  const rawHost = env.FIRESTORE_EMULATOR_HOST?.trim() || undefined;

  if (rawHost && !isLoopbackHost(rawHost)) {
    throw new Error(
      `Refusing destructive Firestore reset: FIRESTORE_EMULATOR_HOST must be a loopback emulator ` +
        `(127.0.0.1 / localhost / ::1), received "${rawHost}"`
    );
  }

  if (!projectId || !projectId.startsWith('demo-')) {
    throw new Error(
      `Refusing destructive Firestore reset: requires a disposable demo-* Firebase project, ` +
        `received "${projectId || '<unset>'}"`
    );
  }

  return { projectId, emulatorHost: rawHost ?? null };
}
