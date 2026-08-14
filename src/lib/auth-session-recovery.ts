/**
 * @file lib/auth-session-recovery.ts
 * @description UX-056 — the single latch that turns "this credential is
 * unusable" into exactly one operator-visible sign-in transition.
 *
 * Why a latch and not a plain callback: a retained browser fires many
 * authenticated requests at once (dashboard queries, the SSE stream, a chat
 * turn). When the cached credential goes stale they ALL come back 401 within
 * milliseconds. Without a latch that is N sign-outs and N redirects — the UI
 * thrash the row calls a retry storm, expressed in navigations instead of
 * requests.
 *
 * Deliberately dependency-free: `fetch-with-auth.ts` (transport) raises the
 * signal and `AuthProvider` (UI) consumes it, so neither has to import the
 * other. The transport must never navigate, and the provider must never wrap
 * fetch.
 */
import type { AuthFailureReason } from '@/lib/auth-failure';

export type AuthSessionRecoveryListener = (reason: AuthFailureReason) => void;

const listeners = new Set<AuthSessionRecoveryListener>();
let pending: AuthFailureReason | null = null;

/** Subscribe to the transition. Returns its own unsubscribe. */
export function onAuthSessionRecovery(listener: AuthSessionRecoveryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Raise the transition once per stale-credential event.
 *
 * Repeat calls while one is already pending are dropped — that is the whole
 * point. A listener that throws must not prevent the others from running, and
 * must not leave the latch half-set, so the latch is closed BEFORE notifying.
 */
export function requestAuthSessionRecovery(reason: AuthFailureReason): void {
  if (pending !== null) return;
  pending = reason;
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // A failed UI transition must not break the transport that reported it.
    }
  }
}

/** Reason currently awaiting a transition, or null when the session is healthy. */
export function pendingAuthSessionRecovery(): AuthFailureReason | null {
  return pending;
}

/**
 * Re-arm the latch. Called once a real session exists again (fresh sign-in), so
 * a later expiry can raise its own transition.
 */
export function clearAuthSessionRecovery(): void {
  pending = null;
}
