/** @jest-environment node */

/**
 * @file input-validation.test.ts
 * @description Security tests for input validation and injection attack vectors.
 *
 * Covers:
 * - XSS in entity names (script injection, event handler injection)
 * - Cypher injection in graph queries (DETACH DELETE, SQL-style OR 1=1)
 * - Body parsing attacks (non-JSON body, oversized payload)
 * - MCP keys validation (admin self-assignment, empty name)
 *
 * @author Radarist Team
 * @created 2026-02-22
 */

import { NextRequest } from 'next/server';

// ============================================================================
// MOCKS (must be declared before imports that use them)
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/lib/firebase-admin', () => ({
  adminAuth: {
    verifyIdToken: jest.fn().mockResolvedValue({ uid: 'test-user-123' }),
    getUser: jest.fn(),
  },
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/mcp/api-keys', () => ({
  createApiKey: jest.fn().mockResolvedValue({
    key: 'tp_live_test-key-abc123',
    apiKey: {
      id: 'key-1',
      name: 'Test Key',
      permissions: ['read'],
      createdAt: Date.now(),
      prefix: 'tp_live_****',
    },
  }),
  listApiKeys: jest.fn().mockResolvedValue([]),
  revokeApiKey: jest.fn(),
  deleteApiKey: jest.fn(),
  updateApiKeyPermissions: jest.fn(),
}));

jest.mock('@/lib/graph', () => ({
  runRawReadQuery: jest.fn().mockResolvedValue({ records: [] }),
  checkHealth: jest.fn().mockResolvedValue({ healthy: true }),
}));

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    isInt: jest.fn(() => false),
    isDate: jest.fn(() => false),
    isDateTime: jest.fn(() => false),
    isLocalDateTime: jest.fn(() => false),
    isNode: jest.fn(() => false),
    isRelationship: jest.fn(() => false),
    isPath: jest.fn(() => false),
  },
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { POST as mcpKeysPost } from '@/app/api/mcp/keys/route';
import { POST as graphQueryPost } from '@/app/api/graph/query/route';

const { createApiKey } = jest.requireMock('@/lib/mcp/api-keys');
const { runRawReadQuery, checkHealth } = jest.requireMock('@/lib/graph');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create an authenticated NextRequest for the MCP keys route.
 * The route uses its own verifyAuth() which reads the Authorization header
 * and calls adminAuth.verifyIdToken().
 */
function createMcpKeysRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/mcp/keys', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer valid-firebase-token',
    },
  });
}

/**
 * Unique IP counter to avoid the graph route's in-memory rate limiter.
 */
let graphIpCounter = 1000;
function createGraphQueryRequest(
  body: unknown,
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest('http://localhost/api/graph/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `security-test-${++graphIpCounter}`,
      ...headers,
    },
  });
}

/**
 * Create a raw (non-JSON) NextRequest for body-parsing attack tests.
 */
function createRawRequest(
  url: string,
  rawBody: string,
  contentType = 'text/plain'
): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: rawBody,
    headers: {
      'Content-Type': contentType,
      Authorization: 'Bearer valid-firebase-token',
      'x-forwarded-for': `security-test-${++graphIpCounter}`,
    },
  });
}

// ============================================================================
// TESTS
// ============================================================================

describe('Security: Input Validation & Injection Attacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkHealth.mockResolvedValue({ healthy: true });
    runRawReadQuery.mockResolvedValue({ records: [] });
  });

  // --------------------------------------------------------------------------
  // 1. XSS in entity names
  // --------------------------------------------------------------------------

  describe('XSS in entity names', () => {
    it('handles <script> tag injection in MCP key name without crashing', async () => {
      const xssName = '<script>alert("xss")</script>';
      const req = createMcpKeysRequest({ name: xssName, permissions: ['read'] });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      // The route should either accept the string (treating it as data, not code)
      // or sanitize it. It must NOT crash or return 500.
      expect(res.status).toBeLessThan(500);

      // If it succeeds (201), verify the script tag is stored as a plain string,
      // not reflected in a way that could execute.
      if (res.status === 201) {
        expect(createApiKey).toHaveBeenCalledWith(
          expect.objectContaining({
            name: xssName,
            userId: 'test-user-123',
          })
        );
        // The response body must not contain unescaped script tags in a
        // context that would execute (JSON responses are safe by default).
        const responseText = JSON.stringify(json);
        expect(responseText).not.toContain('<script>');
      }
    });

    it('handles event handler injection in MCP key name without crashing', async () => {
      const xssName = '"><img src=x onerror=alert(1)>';
      const req = createMcpKeysRequest({ name: xssName, permissions: ['read'] });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      // Must not crash with 500
      expect(res.status).toBeLessThan(500);

      if (res.status === 201) {
        expect(createApiKey).toHaveBeenCalledWith(
          expect.objectContaining({
            name: xssName,
            userId: 'test-user-123',
          })
        );
        // JSON.stringify escapes quotes, so the raw injection string is neutralized
        const responseText = JSON.stringify(json);
        expect(responseText).not.toContain('onerror=alert');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Cypher injection in graph queries
  // --------------------------------------------------------------------------

  describe('Cypher injection in graph queries', () => {
    it('blocks DETACH DELETE injection attempt', async () => {
      const req = createGraphQueryRequest({
        query: 'MATCH (n) DETACH DELETE n',
      });

      const res = await graphQueryPost(req);
      const json = await res.json();

      // The route must block this mutation query
      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Write operation blocked');

      // Verify the query was never executed against Neo4j
      expect(runRawReadQuery).not.toHaveBeenCalled();
    });

    it('handles SQL-style OR injection attempt safely', async () => {
      // Classic SQL injection pattern adapted for Cypher.
      // The route does NOT strip SQL-style "--" comments (only Cypher "//" comments).
      // The query "' OR 1=1 --" contains no mutation keywords, so it will
      // pass the read-only check and be sent to Neo4j. This is acceptable
      // because:
      // 1. Neo4j will reject it as syntactically invalid Cypher
      // 2. It cannot mutate data (no CREATE/DELETE/SET/etc.)
      // 3. The route runs in read-only mode via runRawReadQuery
      const maliciousQuery = "' OR 1=1 --";

      // Simulate Neo4j rejecting the invalid syntax
      runRawReadQuery.mockRejectedValueOnce(
        new Error('Invalid input: expected identifier')
      );

      const req = createGraphQueryRequest({ query: maliciousQuery });
      const res = await graphQueryPost(req);
      const json = await res.json();

      // The key security properties:
      // 1. No mutation was performed (read-only mode)
      // 2. The error is handled gracefully (no crash)
      // 3. No sensitive data is leaked in the response
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(json.success).toBe(false);
      expect(json.message).not.toContain('bolt://');
      expect(json.message).not.toContain('password');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Body parsing attacks
  // --------------------------------------------------------------------------

  describe('Body parsing attacks', () => {
    it('returns error for non-JSON body sent to graph query endpoint', async () => {
      const req = createRawRequest(
        'http://localhost/api/graph/query',
        'this is not json at all <xml>garbage</xml>'
      );

      const res = await graphQueryPost(req);
      const json = await res.json();

      // The route calls request.json() which will throw on invalid JSON.
      // The catch block should handle this gracefully.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
      expect(json.success).toBe(false);
    });

    it('handles extremely large body gracefully', async () => {
      // Generate a string > 1MB to test payload size handling
      const largeString = 'A'.repeat(1_100_000);
      const req = createGraphQueryRequest({
        query: `MATCH (n) WHERE n.name = "${largeString}" RETURN n`,
      });

      const res = await graphQueryPost(req);

      // The route should either:
      // 1. Process it (if no size limit) - status 200
      // 2. Reject it with a 4xx error - acceptable
      // 3. The read-only check will pass since it's a MATCH query
      // Key property: it must NOT crash with an unhandled exception
      expect(res.status).toBeLessThan(600);

      const json = await res.json();
      expect(json).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 4. MCP keys validation
  // --------------------------------------------------------------------------

  describe('MCP keys validation', () => {
    it('rejects admin permission self-assignment with 403', async () => {
      const req = createMcpKeysRequest({
        name: 'My Admin Key',
        permissions: ['admin'],
      });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.error).toContain('admin permission cannot be self-assigned');

      // Verify the key was never created
      expect(createApiKey).not.toHaveBeenCalled();
    });

    it('rejects empty name with 400', async () => {
      const req = createMcpKeysRequest({
        name: '',
        permissions: ['read'],
      });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toContain('name is required');

      // Verify the key was never created
      expect(createApiKey).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Additional injection vectors (bonus coverage)
  // --------------------------------------------------------------------------

  describe('Additional injection vectors', () => {
    it('blocks Cypher CALL injection hidden after a comment', async () => {
      // Attacker attempts to hide a CALL db.labels() behind a comment
      const req = createGraphQueryRequest({
        query: 'MATCH (n) RETURN n /* harmless */ CALL db.labels()',
      });

      const res = await graphQueryPost(req);
      const json = await res.json();

      // After comment stripping, the query becomes:
      // "MATCH (n) RETURN n  CALL db.labels()"
      // The CALL keyword should be blocked
      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Write operation blocked');
      expect(runRawReadQuery).not.toHaveBeenCalled();
    });

    it('rejects admin permission hidden among valid permissions', async () => {
      const req = createMcpKeysRequest({
        name: 'Sneaky Key',
        permissions: ['read', 'write', 'admin', 'signals'],
      });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.error).toContain('admin permission cannot be self-assigned');
      expect(createApiKey).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only name with 400', async () => {
      const req = createMcpKeysRequest({
        name: '   ',
        permissions: ['read'],
      });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      // The route checks name.trim().length === 0
      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toContain('name is required');
      expect(createApiKey).not.toHaveBeenCalled();
    });

    it('rejects name exceeding maximum length with 400', async () => {
      const longName = 'X'.repeat(101);
      const req = createMcpKeysRequest({
        name: longName,
        permissions: ['read'],
      });

      const res = await mcpKeysPost(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.error).toContain('100 characters or less');
      expect(createApiKey).not.toHaveBeenCalled();
    });
  });
});
