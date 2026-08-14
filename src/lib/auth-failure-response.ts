/**
 * @file lib/auth-failure-response.ts
 * @description UX-056 — how an authentication failure is shaped on the wire.
 *
 * Separate from `auth-utils.ts` on purpose. That module statically imports
 * `firebase-admin`, so any route test that wants to stub token verification
 * mocks the whole module — and would take these pure helpers down with it,
 * leaving the header contract asserted against a test-authored duplicate instead
 * of the real thing. Here they carry no server-only dependency, so a route test
 * can stub the verifier and still exercise the genuine response shaping.
 */
import { NextResponse } from 'next/server';
import { AUTH_FAILURE_REASON_HEADER, type AuthFailureReason } from '@/lib/auth-failure';

/** Structural view of an `AuthFailure` — everything the wire shape needs. */
export interface AuthFailureLike {
  readonly error: string;
  readonly reason: AuthFailureReason;
}

/**
 * The canonical 401 for an unauthenticated request.
 *
 * The reason travels as a header as well as a body field, because 401 bodies are
 * shaped per route — `/api/events/stream` answers with bare `Unauthorized`
 * text — and the client's recovery decision must not depend on which route it
 * hit. The body keeps `error` so existing readers are unaffected.
 */
export function unauthenticatedResponse(failure: AuthFailureLike): NextResponse {
  return NextResponse.json(
    { error: failure.error, reason: failure.reason },
    { status: 401, headers: { [AUTH_FAILURE_REASON_HEADER]: failure.reason } }
  );
}

/** Stamp the reason onto a non-JSON 401 (SSE, streams) without reshaping it. */
export function withAuthFailureReason<T extends Response>(response: T, failure: AuthFailureLike): T {
  response.headers.set(AUTH_FAILURE_REASON_HEADER, failure.reason);
  return response;
}
