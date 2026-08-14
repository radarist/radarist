/**
 * @file lib/auth-utils.ts
 * @description Shared authentication utilities for API routes
 *
 * Provides a unified auth verification pattern for all API routes.
 * Uses Firebase Admin SDK to verify ID tokens from the Authorization header.
 *
 * Usage in API routes:
 * ```typescript
 * import { getAuthenticatedUser } from '@/lib/auth-utils';
 *
 * export async function POST(request: NextRequest) {
 *   const auth = await getAuthenticatedUser(request);
 *   if (!auth.authenticated) {
 *     return NextResponse.json({ error: auth.error }, { status: 401 });
 *   }
 *   // auth.uid and auth.email are available
 * }
 * ```
 */

import { type NextRequest } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  authFailureMessage,
  classifyTokenVerificationFailure,
  type AuthFailureReason,
} from '@/lib/auth-failure';
const log = createLogger('auth-utils');

// ============================================================================
// Types
// ============================================================================

export interface AuthSuccess {
  authenticated: true;
  uid: string;
  email: string | undefined;
}

export interface AuthFailure {
  authenticated: false;
  /**
   * Operator-facing text. UX-056: always ours, never the provider's — every
   * route that echoes this into a 401 body inherits that guarantee without
   * needing to be edited.
   */
  error: string;
  /** UX-056 — bounded machine-readable cause; the client's only recovery input. */
  reason: AuthFailureReason;
}

export type AuthResult = AuthSuccess | AuthFailure;

// ============================================================================
// Public Routes (no auth required)
// ============================================================================

/**
 * Routes that do not require authentication.
 * The Inngest route has its own signing key verification.
 * Health check is intentionally public for monitoring.
 */
export const PUBLIC_API_ROUTES: string[] = ['/api/inngest', '/api/ai/health', '/api/health', '/api/mcp'];

/**
 * Check if a request path matches a public route.
 * Matches exact paths or path prefixes (e.g. /api/inngest matches /api/inngest/anything).
 */
export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
}

// ============================================================================
// Auth Verification
// ============================================================================

/**
 * Verify the Firebase ID token from the request's Authorization header.
 *
 * @param request - The incoming Next.js request
 * @returns AuthResult indicating success (with uid/email) or failure (with error message)
 */
export async function getAuthenticatedUser(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return authFailure('missing-credential');
  }

  if (!authHeader.startsWith('Bearer ')) {
    return authFailure('malformed-credential');
  }

  const idToken = authHeader.slice(7).trim();

  if (!idToken) {
    return authFailure('malformed-credential');
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    return {
      authenticated: true,
      uid: decodedToken.uid,
      email: decodedToken.email,
    };
  } catch (error) {
    // The provider's own text stays HERE, in the server log, where it is a
    // diagnostic. UX-056: what crosses back to the browser is the bounded
    // reason plus our own message — the screenshot that opened this row was the
    // raw provider string rendered as an Assistant chat message.
    const reason = classifyTokenVerificationFailure(error);
    log.error('Token verification failed', error instanceof Error ? error : new Error(String(error)), {
      reason,
    });
    return authFailure(reason);
  }
}

function authFailure(reason: AuthFailureReason): AuthFailure {
  return { authenticated: false, reason, error: authFailureMessage(reason) };
}

// UX-056 response shaping lives in `auth-failure-response.ts` (no server-only
// dependency, so route tests that stub this module still exercise the real
// header contract). Re-exported here for call sites that already import auth.
export { unauthenticatedResponse, withAuthFailureReason } from '@/lib/auth-failure-response';

/**
 * Require the user to have admin role.
 * For now, this checks a custom claim on the Firebase token.
 * Falls back to checking if the route is accessed in development mode.
 *
 * @param request - The incoming Next.js request
 * @returns AuthResult with additional admin verification
 */
export async function requireAdmin(request: NextRequest): Promise<AuthResult> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return auth;
  }

  // In development, all authenticated users are treated as admins
  if (process.env.NODE_ENV === 'development') {
    return auth;
  }

  // Check admin custom claim
  try {
    const user = await adminAuth.getUser(auth.uid);
    const isAdmin = user.customClaims?.admin === true;
    if (!isAdmin) {
      return authFailure('insufficient-permissions');
    }
    return auth;
  } catch (error) {
    log.error('Admin check failed', error instanceof Error ? error : new Error(String(error)));
    return authFailure('verification-unavailable');
  }
}
