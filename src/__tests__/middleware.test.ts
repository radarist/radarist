/**
 * @file __tests__/middleware.test.ts
 * @description Security tests for the Next.js API authentication proxy
 *
 * Tests the API authentication proxy that runs at the network boundary.
 * Verifies header presence checks, public route bypass, and 401 responses.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { proxy as middleware } from '../proxy';

// ============================================================================
// Helper
// ============================================================================

function createRequest(
  path: string,
  options: { authorization?: string; method?: string } = {}
): NextRequest {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set('authorization', options.authorization);
  }
  return new NextRequest(
    new URL(path, 'http://localhost:3000'),
    {
      method: options.method || 'GET',
      headers,
    }
  );
}

// ============================================================================
// Non-API Routes
// ============================================================================

describe('middleware - non-API routes', () => {
  it('should pass through non-API routes', () => {
    const request = createRequest('/dashboard');
    const response = middleware(request);

    // NextResponse.next() returns a response with no body
    expect(response.status).toBe(200);
  });

  it('should pass through root path', () => {
    const request = createRequest('/');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });

  it('should pass through static assets', () => {
    const request = createRequest('/favicon.ico');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });
});

// ============================================================================
// Public API Routes
// ============================================================================

describe('middleware - public routes', () => {
  it('should allow /api/inngest without auth', () => {
    const request = createRequest('/api/inngest');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });

  it('should allow /api/inngest sub-paths without auth', () => {
    const request = createRequest('/api/inngest/some-webhook');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });

  it('should allow /api/ai/health without auth', () => {
    const request = createRequest('/api/ai/health');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });

  it('should allow /api/mcp without auth (MCP has own x-api-key auth)', () => {
    const request = createRequest('/api/mcp/entities');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });

  it('should allow all /api/mcp sub-paths without auth', () => {
    const request = createRequest('/api/mcp/reports');
    const response = middleware(request);
    expect(response.status).toBe(200);
  });
});

// ============================================================================
// Missing Auth Header
// ============================================================================

describe('middleware - missing auth', () => {
  it('should return 401 for API route without auth header', async () => {
    const request = createRequest('/api/ai/chat');
    const response = middleware(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('Authentication required');
  });

  it('should return 401 for search API without auth', async () => {
    const request = createRequest('/api/search');
    const response = middleware(request);

    expect(response.status).toBe(401);
  });

  it('should return 401 for admin API without auth', async () => {
    const request = createRequest('/api/admin/backfill-concepts');
    const response = middleware(request);

    expect(response.status).toBe(401);
  });

  it('should return 401 for debug API without auth', async () => {
    const request = createRequest('/api/debug/neo4j');
    const response = middleware(request);

    expect(response.status).toBe(401);
  });
});

// ============================================================================
// Invalid Auth Format
// ============================================================================

describe('middleware - invalid auth format', () => {
  it('should reject Basic auth', async () => {
    const request = createRequest('/api/ai/chat', {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    const response = middleware(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('Invalid authorization format');
  });

  it('should reject auth without Bearer prefix', async () => {
    const request = createRequest('/api/search', {
      authorization: 'Token abc123',
    });
    const response = middleware(request);

    expect(response.status).toBe(401);
  });

  it('should reject empty token after Bearer', async () => {
    const request = createRequest('/api/search', {
      authorization: 'Bearer ',
    });
    const response = middleware(request);

    expect(response.status).toBe(401);
  });

  it('should reject very short tokens', async () => {
    const request = createRequest('/api/search', {
      authorization: 'Bearer abc',
    });
    const response = middleware(request);

    expect(response.status).toBe(401);
  });
});

// ============================================================================
// Valid Auth Header (passes through)
// ============================================================================

describe('middleware - valid auth header', () => {
  it('should pass through with valid Bearer token format', () => {
    const request = createRequest('/api/ai/chat', {
      authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.valid-token-body',
    });
    const response = middleware(request);

    // Should pass through (200 = NextResponse.next())
    expect(response.status).toBe(200);
  });

  it('should pass through POST requests with valid auth', () => {
    const request = createRequest('/api/search', {
      authorization: 'Bearer a-sufficiently-long-token-value',
      method: 'POST',
    });
    const response = middleware(request);

    expect(response.status).toBe(200);
  });

  it('should pass through for all API methods with valid auth', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    for (const method of methods) {
      const request = createRequest('/api/relations/123', {
        authorization: 'Bearer valid-long-token-value-here',
        method,
      });
      const response = middleware(request);
      expect(response.status).toBe(200);
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('middleware - edge cases', () => {
  it('should not match /api-like paths', () => {
    const request = createRequest('/api-docs');
    const response = middleware(request);
    // Non-API path should pass through
    expect(response.status).toBe(200);
  });

  it('should not bypass auth with path traversal', async () => {
    const request = createRequest('/api/inngest-fake');
    const response = middleware(request);
    // Should NOT match public route (inngest-fake is not inngest)
    expect(response.status).toBe(401);
  });

  it('should handle /api/ root path', async () => {
    const request = createRequest('/api/');
    const response = middleware(request);
    expect(response.status).toBe(401);
  });
});
