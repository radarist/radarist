/**
 * @file proxy.ts
 * @description Next.js network Proxy for API authentication
 *
 * Enforces authentication on all /api/* routes except designated public endpoints.
 * This proxy performs a fast header-presence check at the network boundary. The
 * actual token verification remains in each route handler and is done by
 * `getAuthenticatedUser()` in each route handler via `@/lib/auth-utils`.
 *
 * This proxy ensures that:
 * 1. All non-public API routes require an Authorization: Bearer <token> header
 * 2. Missing or malformed headers are rejected before the route handler
 * 3. Public routes (Inngest webhook, health check) are allowed through
 *
 * Token verification (signature, expiry) happens in the route handler, not here,
 * so authorization remains explicit and testable at the sensitive operation.
 */

import { NextResponse, type NextRequest } from 'next/server';

// ============================================================================
// Public Route Allowlist
// ============================================================================

/**
 * API routes that do not require authentication.
 * Keep in sync with PUBLIC_API_ROUTES in auth-utils.ts.
 */
const PUBLIC_ROUTES = [
  '/api/inngest',   // Inngest webhook (has its own signing key verification)
  '/api/ai/health', // AI subsystem health check endpoint
  '/api/health',    // Unified health check for Docker container probes
  '/api/mcp',       // MCP servers (own x-api-key auth; ping/initialize are unauthenticated)
];

function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  );
}

// ============================================================================
// Proxy
// ============================================================================

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only apply to API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Allow public routes through without auth
  if (isPublicApiRoute(pathname)) {
    return NextResponse.next();
  }

  // Check for Authorization header presence
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return NextResponse.json(
      { error: 'Authentication required. Provide Authorization: Bearer <token> header.' },
      { status: 401 }
    );
  }

  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Invalid authorization format. Use: Bearer <token>' },
      { status: 401 }
    );
  }

  const token = authHeader.slice(7);
  if (!token || token.length < 10) {
    return NextResponse.json(
      { error: 'Invalid or empty token provided' },
      { status: 401 }
    );
  }

  // Token format looks valid — pass through to route handler for full verification
  // The route handler calls getAuthenticatedUser() for Firebase Admin token verification
  return NextResponse.next();
}

// ============================================================================
// Matcher Configuration
// ============================================================================

export const config = {
  matcher: '/api/:path*',
};
