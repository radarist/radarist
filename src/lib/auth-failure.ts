/**
 * @file lib/auth-failure.ts
 * @description UX-056 — the one bounded vocabulary for "this request was not
 * authenticated", shared by the server classifier and the client recovery path.
 *
 * Deliberately dependency-free so BOTH sides can import it: `auth-utils.ts`
 * reaches `firebase-admin` and is server-only, while `fetch-with-auth.ts` runs
 * in the browser. A shared enum is the only way the client can act on a
 * server-confirmed reason without parsing prose.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **No provider text reaches the operator.** The row was opened by a
 *    screenshot of the raw string `The Firebase ID token has been revoked`
 *    rendered as an Assistant chat message. Provider prose is diagnostic, not
 *    operator-facing: it names an internal mechanism, suggests no action, and is
 *    outside our control. Classification collapses it to a closed set; the text
 *    the operator reads is ours.
 * 2. **Only a genuinely stale credential is recoverable.** A revoked or expired
 *    token means the ACCOUNT is fine and the cached credential is not — the one
 *    case where a force-refresh can legitimately recover. Every other reason
 *    must not trigger a refresh-and-retry, because retrying cannot help and a
 *    loop is indistinguishable from an attack on the token endpoint.
 */

/**
 * Closed set of authentication-failure reasons.
 *
 * `verification-unavailable` is kept distinct from `token-invalid` on purpose: a
 * provider internal error says nothing about the credential, so reporting it as
 * an invalid token would send the operator to re-authenticate for an outage.
 */
export const AUTH_FAILURE_REASONS = [
  'missing-credential',
  'malformed-credential',
  'token-expired',
  'token-revoked',
  'token-invalid',
  'account-unavailable',
  'insufficient-permissions',
  'verification-unavailable',
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

/**
 * Response header carrying the reason.
 *
 * A header rather than a body field because 401 bodies are shaped by each route
 * (some JSON, some bare text like the SSE stream's `Unauthorized`), and the
 * client recovery rule must not depend on which route it hit. Lowercase so
 * `Headers.get` reads are case-stable across runtimes.
 */
export const AUTH_FAILURE_REASON_HEADER = 'x-radarist-auth-reason';

/**
 * Query parameter carrying the reason to `/login`.
 *
 * Without it the operator is bounced to a bare sign-in form with no explanation
 * — which is what "raw provider text" was standing in for. The value is always
 * one of the closed set above, so the login screen renders our own copy and
 * never echoes the parameter.
 */
export const AUTH_SESSION_EXPIRED_QUERY = 'sessionEnded';

const REASON_SET = new Set<string>(AUTH_FAILURE_REASONS);

/**
 * Map a provider error onto the closed set, using ONLY its structured code.
 *
 * Prose is never pattern-matched. `firebase-admin` raises a `FirebaseAuthError`
 * whose `code` is `auth/<reason>` for every case that matters here (verified
 * against `firebase-admin/lib/utils/error.js`), so message text adds nothing —
 * and matching on it would make the classification drift with provider wording.
 * An uncoded failure is a token we could not verify: `token-invalid`.
 */
export function classifyTokenVerificationFailure(error: unknown): AuthFailureReason {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;

  switch (code) {
    case 'auth/id-token-expired':
    case 'auth/session-cookie-expired':
      return 'token-expired';
    case 'auth/id-token-revoked':
    case 'auth/session-cookie-revoked':
      return 'token-revoked';
    case 'auth/user-disabled':
    case 'auth/user-not-found':
      return 'account-unavailable';
    case 'auth/internal-error':
      return 'verification-unavailable';
    default:
      return 'token-invalid';
  }
}

/**
 * True when the account is intact and only the cached credential went stale.
 *
 * This is the ONLY predicate that may authorize a force-refresh and a single
 * retry. Keeping it here — rather than inline at each call site — is what stops
 * a second, looser copy of the rule from appearing later.
 */
export function isStaleSessionCredential(reason: AuthFailureReason): boolean {
  return reason === 'token-revoked' || reason === 'token-expired';
}

/**
 * Operator-facing text. Every string is ours, names an action where one exists,
 * and mentions no provider or internal mechanism.
 */
const AUTH_FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  'missing-credential': 'Not signed in. Sign in to continue.',
  'malformed-credential': 'This request carried an unusable credential.',
  'token-expired': 'Your session expired. Sign in again to continue.',
  'token-revoked': 'Your session is no longer valid. Sign in again to continue.',
  'token-invalid': 'Your session could not be verified. Sign in again to continue.',
  'account-unavailable': 'This account is not available. Contact the workspace owner.',
  // Authenticated, but not permitted. Shares this vocabulary because it shares
  // the `AuthResult` type and the same client rule: a refresh cannot help, so it
  // must never be retried.
  'insufficient-permissions': 'This action requires an administrator role.',
  'verification-unavailable': 'Sign-in verification is temporarily unavailable. Try again shortly.',
};

export function authFailureMessage(reason: AuthFailureReason): string {
  return AUTH_FAILURE_MESSAGES[reason];
}

/** Accept exactly the closed set — no trimming, no case folding. */
export function parseAuthFailureReason(value: unknown): AuthFailureReason | null {
  return typeof value === 'string' && REASON_SET.has(value) ? (value as AuthFailureReason) : null;
}

/**
 * True when the cached credential can no longer be trusted, so stale client
 * session state must be cleared and the operator sent to sign in.
 *
 * Distinct from {@link isStaleSessionCredential}: that predicate asks "can a
 * refresh fix this?", this one asks "must we stop pretending we have a session?"
 * — a revoked token answers yes to both, an unverifiable one only to this.
 *
 * Excluded on purpose:
 * - `missing-credential` — already signed out; nothing to clear.
 * - `insufficient-permissions` — the session is valid, the action is not.
 * - `verification-unavailable` — a provider outage says nothing about the
 *   credential; signing the operator out over one would destroy a good session.
 */
export function requiresSessionReset(reason: AuthFailureReason): boolean {
  return (
    reason === 'token-revoked' ||
    reason === 'token-expired' ||
    reason === 'token-invalid' ||
    reason === 'account-unavailable'
  );
}
