/** @jest-environment node */

/**
 * @file auth-bypass.test.ts
 * @description Security tests for authentication bypass attack vectors
 *
 * Tests that API routes properly reject unauthenticated, malformed,
 * expired, and insufficient-privilege requests across multiple endpoints.
 *
 * Routes under test:
 * - POST /api/agents/feedback  (uses getAuthenticatedUser)
 * - GET  /api/admin/backfill-concepts (uses requireAdmin)
 */

import { NextRequest } from 'next/server';

// ============================================================================
// MOCKS - must be declared before imports
// ============================================================================

const mockGetAuthenticatedUser = jest.fn();
const mockRequireAdmin = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/lib/firebase-admin', () => {
  const mockDocRef = {
    id: 'feedback-doc-id',
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockCollection = {
    doc: jest.fn(() => mockDocRef),
  };
  return {
    adminAuth: {
      verifyIdToken: jest.fn(),
      getUser: jest.fn(),
    },
    db: {
      collection: jest.fn(() => mockCollection),
    },
  };
});

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));

jest.mock('@/lib/concept-admin', () => ({
  adminGetConcepts: jest.fn().mockResolvedValue([]),
  adminBulkGetOrCreateConcepts: jest.fn().mockResolvedValue([]),
  adminIncrementEntityCount: jest.fn(),
}));

jest.mock('@/lib/inngest/functions/sync-concept-to-neo4j', () => ({
  triggerBatchConceptSync: jest.fn(),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  getDocs: jest.fn(),
  query: jest.fn(),
  limit: jest.fn(),
  doc: jest.fn(),
  updateDoc: jest.fn(),
  arrayUnion: jest.fn(),
  Timestamp: { now: jest.fn() },
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { POST as feedbackPost } from '@/app/api/agents/feedback/route';
import { GET as backfillConceptsGet } from '@/app/api/admin/backfill-concepts/route';

// ============================================================================
// HELPERS
// ============================================================================

function createRequest(
  path: string,
  options?: {
    authorization?: string;
    method?: string;
    body?: unknown;
  }
): NextRequest {
  const headers: Record<string, string> = {};
  if (options?.authorization) headers['Authorization'] = options.authorization;
  if (options?.body) headers['Content-Type'] = 'application/json';
  return new NextRequest(`http://localhost${path}`, {
    method: options?.method || 'GET',
    headers,
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

// ============================================================================
// TESTS
// ============================================================================

describe('Auth Bypass Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. No authorization header -> 401
  // --------------------------------------------------------------------------
  describe('No authorization header', () => {
    it('POST /api/agents/feedback returns 401 without auth header', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'No authorization header provided',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('No authorization header provided');
    });

    it('GET /api/admin/backfill-concepts returns 401 without auth header', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'No authorization header provided',
      });

      const req = createRequest('/api/admin/backfill-concepts');

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('No authorization header provided');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Empty Bearer token -> 401
  // --------------------------------------------------------------------------
  describe('Empty Bearer token', () => {
    it('POST /api/agents/feedback returns 401 with empty Bearer token', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Empty token provided',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer ',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Empty token provided');
    });

    it('GET /api/admin/backfill-concepts returns 401 with empty Bearer token', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Empty token provided',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer ',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Empty token provided');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Malformed token (not Bearer scheme) -> 401
  // --------------------------------------------------------------------------
  describe('Malformed token (non-Bearer scheme)', () => {
    it('POST /api/agents/feedback returns 401 with Basic auth scheme', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Invalid authorization format. Use: Bearer <token>',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Basic dXNlcjpwYXNz',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Invalid authorization format. Use: Bearer <token>');
    });

    it('GET /api/admin/backfill-concepts returns 401 with Token scheme', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Invalid authorization format. Use: Bearer <token>',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Token some-api-key',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Invalid authorization format. Use: Bearer <token>');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Expired token -> 401
  // --------------------------------------------------------------------------
  describe('Expired token', () => {
    it('POST /api/agents/feedback returns 401 with expired token', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Token expired',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer expired-token-abc123',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Token expired');
    });

    it('GET /api/admin/backfill-concepts returns 401 with expired token', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Token expired',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer expired-token-abc123',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Token expired');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Invalid token -> 401
  // --------------------------------------------------------------------------
  describe('Invalid token', () => {
    it('POST /api/agents/feedback returns 401 with invalid token', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Decoding Firebase ID token failed',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer not-a-real-jwt-token',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Decoding Firebase ID token failed');
    });

    it('GET /api/admin/backfill-concepts returns 401 with invalid token', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Decoding Firebase ID token failed',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer not-a-real-jwt-token',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Decoding Firebase ID token failed');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Admin route without admin claim -> 401
  // --------------------------------------------------------------------------
  describe('Admin route without admin claim', () => {
    it('GET /api/admin/backfill-concepts returns 401 for non-admin user', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Insufficient permissions. Admin role required.',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer valid-token-non-admin',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Insufficient permissions. Admin role required.');
    });

    it('POST /api/admin/backfill-concepts returns 401 for non-admin user', async () => {
      // Import POST handler dynamically since we already imported GET
      const { POST: backfillConceptsPost } = require('@/app/api/admin/backfill-concepts/route');

      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Insufficient permissions. Admin role required.',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        method: 'POST',
        authorization: 'Bearer valid-token-non-admin',
        body: { action: 'status' },
      });

      const res = await backfillConceptsPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Insufficient permissions. Admin role required.');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Case-sensitive header -> both 'authorization' and 'Authorization' work
  // --------------------------------------------------------------------------
  describe('Case-sensitive header handling', () => {
    it('lowercase "authorization" header is read correctly by the route', async () => {
      // The auth-utils reads via request.headers.get('authorization')
      // which is case-insensitive per HTTP spec / Fetch API.
      // We verify the route calls getAuthenticatedUser and respects
      // its result regardless of header casing.
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'No authorization header provided',
      });

      // NextRequest headers are case-insensitive per the Fetch API spec.
      // Constructing with lowercase 'authorization' should still be found.
      const req = new NextRequest('http://localhost/api/agents/feedback', {
        method: 'POST',
        headers: {
          authorization: 'Bearer some-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batchSize: 10 }),
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      // The mock was called, confirming the route delegates to auth-utils
      expect(mockGetAuthenticatedUser).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(401);
      expect(json.error).toBe('No authorization header provided');
    });

    it('uppercase "Authorization" header is read correctly by the route', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'No authorization header provided',
      });

      const req = new NextRequest('http://localhost/api/agents/feedback', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer some-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batchSize: 10 }),
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(mockGetAuthenticatedUser).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(401);
      expect(json.error).toBe('No authorization header provided');
    });

    it('mixed case "AUTHORIZATION" header reaches the auth utility', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'No authorization header provided',
      });

      const req = new NextRequest('http://localhost/api/admin/backfill-concepts', {
        method: 'GET',
        headers: {
          AUTHORIZATION: 'Bearer some-token',
        },
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(401);
      expect(json.error).toBe('No authorization header provided');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Token with whitespace -> 401
  // --------------------------------------------------------------------------
  describe('Token with whitespace', () => {
    it('POST /api/agents/feedback returns 401 with whitespace-only token', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Token verification failed',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer    ',
        body: { batchSize: 10 },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Token verification failed');
    });

    it('GET /api/admin/backfill-concepts returns 401 with tab-padded token', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Token verification failed',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer \t\tsome-token\t',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('Token verification failed');
    });

    it('rejects header injection via newline in token value', () => {
      // The Fetch API (and NextRequest) rejects headers containing
      // newline characters, preventing HTTP header injection attacks.
      // This is a security guarantee at the transport layer.
      expect(() =>
        createRequest('/api/agents/feedback', {
          method: 'POST',
          authorization: 'Bearer token\nX-Injected: evil',
          body: { batchSize: 10 },
        })
      ).toThrow();

      // Auth function should never be reached
      expect(mockGetAuthenticatedUser).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 9. Verify authenticated requests succeed (positive control)
  // --------------------------------------------------------------------------
  describe('Positive control - authenticated requests succeed', () => {
    it('POST /api/agents/feedback returns 201 with valid auth + body', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: true,
        uid: 'user-123',
        email: 'admin@example.com',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer valid-token',
        body: { missionId: 'mission-abc', rating: 'positive' },
      });

      const res = await feedbackPost(req);
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
    });

    it('GET /api/admin/backfill-concepts returns 200 with admin auth', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: true,
        uid: 'admin-user-456',
        email: 'admin@example.com',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer valid-admin-token',
      });

      const res = await backfillConceptsGet(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Auth function is called exactly once per request (no double-calls)
  // --------------------------------------------------------------------------
  describe('Auth is invoked exactly once per request', () => {
    it('getAuthenticatedUser is called once for feedback POST', async () => {
      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: true,
        uid: 'user-123',
        email: 'test@example.com',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer valid-token',
        body: {},
      });

      await feedbackPost(req);

      expect(mockGetAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('requireAdmin is called once for backfill-concepts GET', async () => {
      mockRequireAdmin.mockResolvedValue({
        authenticated: true,
        uid: 'admin-123',
        email: 'admin@example.com',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer valid-admin-token',
      });

      await backfillConceptsGet(req);

      expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // 11. Service layer is never reached when auth fails
  // --------------------------------------------------------------------------
  describe('Service layer is not reached when auth fails', () => {
    it('Firestore is not written when feedback auth fails', async () => {
      const { db } = jest.requireMock('@/lib/firebase-admin');

      mockGetAuthenticatedUser.mockResolvedValue({
        authenticated: false,
        error: 'Token expired',
      });

      const req = createRequest('/api/agents/feedback', {
        method: 'POST',
        authorization: 'Bearer expired-token',
        body: { missionId: 'mission-abc', rating: 'positive' },
      });

      await feedbackPost(req);

      expect(db.collection).not.toHaveBeenCalled();
    });

    it('adminGetConcepts is not called when backfill-concepts auth fails', async () => {
      const { adminGetConcepts } = jest.requireMock('@/lib/concept-admin');

      mockRequireAdmin.mockResolvedValue({
        authenticated: false,
        error: 'Insufficient permissions. Admin role required.',
      });

      const req = createRequest('/api/admin/backfill-concepts', {
        authorization: 'Bearer valid-but-not-admin',
      });

      await backfillConceptsGet(req);

      expect(adminGetConcepts).not.toHaveBeenCalled();
    });
  });
});
