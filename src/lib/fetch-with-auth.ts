/**
 * @file lib/fetch-with-auth.ts
 * @description Client-safe fetch wrapper that automatically injects Firebase auth tokens.
 *
 * All frontend code calling /api/* routes MUST use this wrapper instead of bare fetch().
 * The network proxy (`src/proxy.ts`) requires an Authorization: Bearer <token> header
 * on all non-public API routes. This wrapper handles token injection transparently.
 *
 * Usage:
 * ```typescript
 * import { fetchWithAuth } from '@/lib/fetch-with-auth';
 *
 * // GET request
 * const response = await fetchWithAuth('/api/trends?keyword=AI');
 *
 * // POST request
 * const response = await fetchWithAuth('/api/signals/import', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(data),
 * });
 * ```
 */

import { createLogger } from '@/lib/logger';
import {
  AUTH_FAILURE_REASON_HEADER,
  isStaleSessionCredential,
  parseAuthFailureReason,
  requiresSessionReset,
  type AuthFailureReason,
} from '@/lib/auth-failure';
import { requestAuthSessionRecovery } from '@/lib/auth-session-recovery';
const log = createLogger('fetch-with-auth');

/**
 * UX-056 — HTTP methods whose replay is safe by definition.
 *
 * The retry after a force-refresh re-sends the request. That is only defensible
 * when re-sending cannot cause a second effect, so the allow-list is the two
 * methods HTTP itself defines as having no side effects. Everything else — a
 * relation write, a triage approval, a mission dispatch — must fail visibly and
 * let the operator re-issue it, because a 401 cannot prove whether the server
 * rejected the token BEFORE or AFTER performing the work.
 */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD']);

/** GRAPH-055 diagnostic: auth-token acquisition slower than this is logged. */
const SLOW_AUTH_WARN_MS = 2_000;

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Race a promise against an AbortSignal so a caller-supplied `options.signal`
 * can interrupt the PRE-fetch auth waits (`authStateReady`, `getIdToken`) —
 * without a signal those waits are unbounded and a hang here sticks callers'
 * loading states forever (GRAPH-055). No-op when no signal is provided.
 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch wrapper that injects the Firebase ID token into the Authorization header.
 *
 * - If the user is logged in, automatically adds `Authorization: Bearer <token>`
 * - If the user is not logged in, the request proceeds without auth (the API will return 401)
 * - Merges auth headers with any existing headers passed via options
 * - Drop-in replacement for `fetch()` — same signature, same return type
 */
export async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  const signal = options?.signal ?? null;
  if (signal?.aborted) throw abortError();
  const headers = new Headers(options?.headers);
  // A caller that brought its own credential owns it end-to-end: we neither
  // refresh it nor sign the user out because it was rejected (UX-056).
  const callerSuppliedCredential = headers.has('Authorization');

  // Only inject if no Authorization header is already set
  if (!callerSuppliedCredential) {
    const acquisitionStartedAt = Date.now();
    try {
      // Resolve the default app's Auth singleton at request time. Importing the
      // full Firebase bootstrap here pulls its Firestore service graph into
      // every API client and creates a relations -> auth-fetch import cycle.
      // Keep the Auth SDK lazy as well: server-only tool catalogs import some
      // client relation modules for schemas in Jest environments without a
      // global fetch, which the Auth Node bundle reads during initialization.
      const { getAuth } = await import('firebase/auth');
      const auth = getAuth();
      // A persisted Firebase session is restored asynchronously. API calls can
      // otherwise race the first auth callback, leave without a token, and
      // surface a transient 401 before a retry succeeds. Firebase resolves this
      // immediately after the initial auth state is known, including the
      // genuinely signed-out case.
      await raceWithAbort(auth.authStateReady(), signal);
      const currentUser = auth.currentUser;
      if (currentUser) {
        const token = await raceWithAbort(currentUser.getIdToken(), signal);
        headers.set('Authorization', `Bearer ${token}`);
      }
      const acquisitionMs = Date.now() - acquisitionStartedAt;
      if (acquisitionMs > SLOW_AUTH_WARN_MS) {
        // GRAPH-055: a slow pre-fetch auth wait is indistinguishable from a slow
        // server without this line — make the phase attributable.
        log.warn('slow auth token acquisition before fetch', { durationMs: acquisitionMs, url });
      }
    } catch (error) {
      // An abort is a caller decision (operation superseded/unmounted) — it must
      // propagate as a rejection, never degrade into an un-authenticated fetch.
      if (isAbortError(error)) throw error;
      log.warn('Failed to get auth token', { error: String(error) });
      // Proceed without token — the API will return 401 if auth is required
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return recoverFromStaleCredential(url, options, response, callerSuppliedCredential, signal);
}

/**
 * UX-056 — the whole allowed repair for a server-confirmed stale credential.
 *
 * Exactly one force-refreshed retry, and only when every one of these holds:
 * the server classified the 401 itself, the reason says a refresh can help, the
 * credential is ours, and the request's replay is safe. Any other shape returns
 * the original 401 untouched — a caller must be able to see the real failure.
 */
async function recoverFromStaleCredential(
  url: string,
  options: RequestInit | undefined,
  response: Response,
  callerSuppliedCredential: boolean,
  signal: AbortSignal | null
): Promise<Response> {
  if (response.status !== 401) return response;

  // Only a reason the SERVER stamped is actionable. An unclassified 401 (a
  // proxy, a route we have not wired) is left exactly as it arrived rather than
  // guessed at from body prose.
  const reason = parseAuthFailureReason(response.headers.get(AUTH_FAILURE_REASON_HEADER));
  if (!reason) return response;

  // Not our credential, not our session to repair or discard.
  if (callerSuppliedCredential) return response;

  if (!isStaleSessionCredential(reason)) {
    if (requiresSessionReset(reason)) requestAuthSessionRecovery(reason);
    return response;
  }

  if (!isReplaySafe(options)) {
    // A mutation that came back 401 may or may not have been applied. Replaying
    // it could duplicate the effect, so the operator gets an explicit sign-in
    // transition and re-issues the action deliberately.
    log.warn('refusing to replay a non-idempotent request after a stale credential', { url, reason });
    requestAuthSessionRecovery(reason);
    return response;
  }

  const refreshed = await forceRefreshedToken(reason, signal);
  if (!refreshed) {
    requestAuthSessionRecovery(reason);
    return response;
  }

  // The first 401's body is never read; releasing it keeps the stream from
  // being held open for the life of the page.
  void response.body?.cancel().catch(() => undefined);

  const retryHeaders = new Headers(options?.headers);
  retryHeaders.set('Authorization', `Bearer ${refreshed}`);
  const retried = await fetch(url, { ...options, headers: retryHeaders });

  // One retry, and one only. Still stale means the account really cannot serve
  // this session — hand it to the sign-in transition instead of looping.
  if (retried.status === 401) {
    const retriedReason = parseAuthFailureReason(retried.headers.get(AUTH_FAILURE_REASON_HEADER)) ?? reason;
    if (requiresSessionReset(retriedReason)) requestAuthSessionRecovery(retriedReason);
  }
  return retried;
}

/** GET/HEAD, no body, so re-sending cannot produce a second effect. */
function isReplaySafe(options: RequestInit | undefined): boolean {
  const method = (options?.method ?? 'GET').toUpperCase();
  return REPLAY_SAFE_METHODS.has(method) && options?.body == null;
}

/**
 * Mint a genuinely new token, bypassing the SDK's cache.
 *
 * Returns null when there is nothing to refresh (already signed out) or the
 * refresh itself fails — in both cases the caller keeps the original 401 rather
 * than retrying with the same stale credential.
 */
async function forceRefreshedToken(reason: AuthFailureReason, signal: AbortSignal | null): Promise<string | null> {
  try {
    const { getAuth } = await import('firebase/auth');
    const currentUser = getAuth().currentUser;
    if (!currentUser) return null;
    log.info('force-refreshing a server-rejected credential', { reason });
    return await raceWithAbort(currentUser.getIdToken(true), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn('forced token refresh failed', { reason, error: String(error) });
    return null;
  }
}
