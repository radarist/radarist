/**
 * @file lib/__tests__/auth-utils.test.ts
 * @description Security tests for authentication utilities
 *
 * Tests cover:
 * - Token extraction and validation
 * - Public route matching
 * - Auth failure scenarios
 * - Admin role verification
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

// Mock firebase-admin before imports - use jest.fn() inline to avoid hoisting issues
jest.mock('@/lib/firebase-admin', () => ({
  adminAuth: {
    verifyIdToken: jest.fn(),
    getUser: jest.fn(),
  },
}));

import { getAuthenticatedUser, requireAdmin, isPublicRoute, PUBLIC_API_ROUTES } from '../auth-utils';
import { AUTH_FAILURE_REASON_HEADER } from '../auth-failure';
import { unauthenticatedResponse } from '../auth-failure-response';

// Get mock references after imports
const { adminAuth } = jest.requireMock('@/lib/firebase-admin');
const mockVerifyIdToken = adminAuth.verifyIdToken as jest.Mock;
const mockGetUser = adminAuth.getUser as jest.Mock;

// ============================================================================
// Helper
// ============================================================================

function createRequest(url: string, options: { authorization?: string } = {}): NextRequest {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set('authorization', options.authorization);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), { headers });
}

// ============================================================================
// isPublicRoute
// ============================================================================

describe('isPublicRoute', () => {
  it('should match exact public routes', () => {
    expect(isPublicRoute('/api/inngest')).toBe(true);
    expect(isPublicRoute('/api/ai/health')).toBe(true);
    expect(isPublicRoute('/api/mcp')).toBe(true);
  });

  it('should match public route prefixes', () => {
    expect(isPublicRoute('/api/inngest/some-path')).toBe(true);
    expect(isPublicRoute('/api/ai/health/detailed')).toBe(true);
    expect(isPublicRoute('/api/mcp/entities')).toBe(true);
    expect(isPublicRoute('/api/mcp/reports')).toBe(true);
  });

  it('should not match non-public routes', () => {
    expect(isPublicRoute('/api/ai/chat')).toBe(false);
    expect(isPublicRoute('/api/search')).toBe(false);
    expect(isPublicRoute('/api/admin/backfill-concepts')).toBe(false);
  });

  it('should not match partial prefix matches', () => {
    expect(isPublicRoute('/api/inngest-other')).toBe(false);
    expect(isPublicRoute('/api/ai/healthcheck')).toBe(false);
  });

  it('should have at least 2 public routes defined', () => {
    expect(PUBLIC_API_ROUTES.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// getAuthenticatedUser
// ============================================================================

describe('getAuthenticatedUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return failure when no authorization header', async () => {
    const request = createRequest('/api/test');
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('missing-credential');
    }
  });

  it('should return failure for non-Bearer format', async () => {
    const request = createRequest('/api/test', {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('malformed-credential');
    }
  });

  it('should return failure for empty token', async () => {
    const request = createRequest('/api/test', {
      authorization: 'Bearer ',
    });
    const result = await getAuthenticatedUser(request);

    // Should fail - either as invalid format or empty token depending on header normalization
    expect(result.authenticated).toBe(false);
  });

  it('should return success for valid token', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'user-123',
      email: 'test@example.com',
    });

    const request = createRequest('/api/test', {
      authorization: 'Bearer valid-firebase-token-123',
    });
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.uid).toBe('user-123');
      expect(result.email).toBe('test@example.com');
    }
    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-firebase-token-123');
  });

  it('should return failure for expired token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired'));

    const request = createRequest('/api/test', {
      authorization: 'Bearer expired-token-xyz',
    });
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('token-invalid');
    }
  });

  it('should return failure for invalid token', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Decoding Firebase ID token failed'));

    const request = createRequest('/api/test', {
      authorization: 'Bearer invalid-token',
    });
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('token-invalid');
    }
  });

  it('should handle non-Error exceptions', async () => {
    mockVerifyIdToken.mockRejectedValue('unexpected string error');

    const request = createRequest('/api/test', {
      authorization: 'Bearer some-token-value',
    });
    const result = await getAuthenticatedUser(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('token-invalid');
    }
  });
});

// ============================================================================
// requireAdmin
// ============================================================================

describe('requireAdmin', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: originalEnv });
  });

  it('should return failure when not authenticated', async () => {
    const request = createRequest('/api/admin/test');
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(false);
  });

  it('should allow any authenticated user in development', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development' });

    mockVerifyIdToken.mockResolvedValue({
      uid: 'user-456',
      email: 'dev@example.com',
    });

    const request = createRequest('/api/admin/test', {
      authorization: 'Bearer valid-dev-token',
    });
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(true);
    // Should NOT call getUser in development mode
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('should check admin claim in production', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production' });

    mockVerifyIdToken.mockResolvedValue({
      uid: 'admin-789',
      email: 'admin@example.com',
    });
    mockGetUser.mockResolvedValue({
      customClaims: { admin: true },
    });

    const request = createRequest('/api/admin/test', {
      authorization: 'Bearer valid-admin-token',
    });
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(true);
    expect(mockGetUser).toHaveBeenCalledWith('admin-789');
  });

  it('should reject non-admin users in production', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production' });

    mockVerifyIdToken.mockResolvedValue({
      uid: 'regular-user',
      email: 'user@example.com',
    });
    mockGetUser.mockResolvedValue({
      customClaims: {},
    });

    const request = createRequest('/api/admin/test', {
      authorization: 'Bearer valid-regular-token',
    });
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('insufficient-permissions');
      expect(result.error).toContain('administrator role');
    }
  });

  it('should reject when custom claims are null', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production' });

    mockVerifyIdToken.mockResolvedValue({
      uid: 'no-claims-user',
      email: 'user@example.com',
    });
    mockGetUser.mockResolvedValue({
      customClaims: null,
    });

    const request = createRequest('/api/admin/test', {
      authorization: 'Bearer valid-no-claims-token',
    });
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(false);
  });

  it('should handle getUser failure gracefully', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production' });

    mockVerifyIdToken.mockResolvedValue({
      uid: 'user-error',
      email: 'user@example.com',
    });
    mockGetUser.mockRejectedValue(new Error('Firebase Admin error'));

    const request = createRequest('/api/admin/test', {
      authorization: 'Bearer valid-token-error',
    });
    const result = await requireAdmin(request);

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('verification-unavailable');
    }
  });
});

// ============================================================================
// UX-056 — bounded reason + provider-free operator text
// ============================================================================

/** Shape of a real `FirebaseAuthError`: a prefixed `code` plus provider prose. */
function authError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('getAuthenticatedUser failure reasons (UX-056)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports a revoked token as token-revoked without leaking provider text', async () => {
    mockVerifyIdToken.mockRejectedValue(authError('auth/id-token-revoked', 'The Firebase ID token has been revoked.'));

    const result = await getAuthenticatedUser(
      createRequest('/api/test', { authorization: 'Bearer stale-retained-token' })
    );

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('token-revoked');
      // The exact string from the operator screenshot must never come back.
      expect(result.error).not.toContain('Firebase');
      expect(result.error).not.toContain('revoked');
      expect(result.error).toMatch(/sign in again/i);
    }
  });

  it('reports an expired token as token-expired', async () => {
    mockVerifyIdToken.mockRejectedValue(
      authError('auth/id-token-expired', 'The provided Firebase ID token is expired.')
    );

    const result = await getAuthenticatedUser(createRequest('/api/test', { authorization: 'Bearer expired-token' }));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe('token-expired');
  });

  it('separates a provider outage from an invalid credential', async () => {
    mockVerifyIdToken.mockRejectedValue(authError('auth/internal-error', 'An internal error has occurred.'));

    const result = await getAuthenticatedUser(createRequest('/api/test', { authorization: 'Bearer any-token' }));

    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe('verification-unavailable');
  });

  it('distinguishes a missing credential from a malformed one', async () => {
    const missing = await getAuthenticatedUser(createRequest('/api/test'));
    expect(missing.authenticated).toBe(false);
    if (!missing.authenticated) expect(missing.reason).toBe('missing-credential');

    const wrongScheme = await getAuthenticatedUser(createRequest('/api/test', { authorization: 'Basic dXNlcjpwYXNz' }));
    expect(wrongScheme.authenticated).toBe(false);
    if (!wrongScheme.authenticated) expect(wrongScheme.reason).toBe('malformed-credential');

    const empty = await getAuthenticatedUser(createRequest('/api/test', { authorization: 'Bearer ' }));
    expect(empty.authenticated).toBe(false);
    if (!empty.authenticated) expect(empty.reason).toBe('malformed-credential');
  });

  it('never calls the provider when the credential is structurally unusable', async () => {
    await getAuthenticatedUser(createRequest('/api/test'));
    await getAuthenticatedUser(createRequest('/api/test', { authorization: 'Basic x' }));

    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

describe('unauthenticatedResponse (UX-056)', () => {
  it('carries the reason in a header so any body shape stays readable', async () => {
    const response = unauthenticatedResponse({
      reason: 'token-revoked',
      error: 'Your session is no longer valid. Sign in again to continue.',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get(AUTH_FAILURE_REASON_HEADER)).toBe('token-revoked');
    await expect(response.json()).resolves.toEqual({
      error: 'Your session is no longer valid. Sign in again to continue.',
      reason: 'token-revoked',
    });
  });
});
