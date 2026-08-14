/**
 * @jest-environment node
 */

/**
 * @file route.test.ts
 * @description Unit tests for POST /api/session/track
 *
 * Tests cover:
 * - Authentication enforcement (401)
 * - Body validation (400 for missing entityId / entityType)
 * - Successful tracking (200 with sessionId)
 * - Internal error handling (500)
 */

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
}));

jest.mock('@/lib/graph/session-memory', () => ({
  getOrCreateActiveSession: jest.fn(),
  trackEntityView: jest.fn(),
}));

jest.mock('@/lib/graph/runtime-mode', () => ({
  resolveGraphRuntime: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { NextRequest } from 'next/server';
import { POST } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { getOrCreateActiveSession, trackEntityView } = jest.requireMock('@/lib/graph/session-memory') as {
  getOrCreateActiveSession: jest.Mock;
  trackEntityView: jest.Mock;
};
const { resolveGraphRuntime } = jest.requireMock('@/lib/graph/runtime-mode') as {
  resolveGraphRuntime: jest.Mock;
};

// ============================================================================
// HELPERS
// ============================================================================

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/session/track', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
  });
}

// ============================================================================
// TESTS
// ============================================================================

describe('POST /api/session/track', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveGraphRuntime.mockReturnValue({ mode: 'neo4j', uri: 'bolt://127.0.0.1:17687' });
  });

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
    expect(getOrCreateActiveSession).not.toHaveBeenCalled();
  });

  it('returns 400 when entityId is missing', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    const res = await POST(createRequest({ entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('entityId');
  });

  it('returns 400 when entityId is empty string', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    const res = await POST(createRequest({ entityId: '', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('entityId');
  });

  it('returns 400 when entityType is missing', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    const res = await POST(createRequest({ entityId: 'tech-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('entityType');
  });

  it('returns 400 when entityType is empty string', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: '' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('entityType');
  });

  it('returns 200 with sessionId on success', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    getOrCreateActiveSession.mockResolvedValue({
      id: 'session-xyz',
      userId: 'user-abc',
      startedAt: '2026-02-23T10:00:00.000Z',
    });

    trackEntityView.mockResolvedValue({ tracked: true });

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, sessionId: 'session-xyz', tracked: true });

    expect(getOrCreateActiveSession).toHaveBeenCalledWith('user-abc');
    expect(trackEntityView).toHaveBeenCalledWith('session-xyz', 'tech-1', 'technology');
  });

  it('M16(b): surfaces an honest miss (tracked=false) without throwing when the entity is not in the graph', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    getOrCreateActiveSession.mockResolvedValue({
      id: 'session-xyz',
      userId: 'user-abc',
      startedAt: '2026-02-23T10:00:00.000Z',
    });

    // Entity not yet synced to Neo4j → the MERGE matched nothing. The route
    // must log the miss and report it honestly — NOT claim a tracked view.
    trackEntityView.mockResolvedValue({ tracked: false });

    const res = await POST(createRequest({ entityId: 'ghost-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, sessionId: 'session-xyz', tracked: false });
  });

  it.each([
    ['disabled', 'graph-disabled'],
    ['unconfigured', 'graph-unconfigured'],
  ] as const)('returns an honest no-op when the graph runtime is %s', async (mode, reason) => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });
    resolveGraphRuntime.mockReturnValue({ mode });

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, tracked: false, reason });
    expect(getOrCreateActiveSession).not.toHaveBeenCalled();
    expect(trackEntityView).not.toHaveBeenCalled();
  });

  it('keeps invalid graph runtime configuration fail-loud', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });
    resolveGraphRuntime.mockImplementation(() => {
      throw new Error('Invalid graph runtime configuration');
    });

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));

    expect(res.status).toBe(500);
    expect(getOrCreateActiveSession).not.toHaveBeenCalled();
  });

  it('returns 500 when session memory throws', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    getOrCreateActiveSession.mockRejectedValue(new Error('Neo4j connection failed'));

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });

  it('returns 500 when trackEntityView throws', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-abc',
      email: 'test@example.com',
    });

    getOrCreateActiveSession.mockResolvedValue({
      id: 'session-xyz',
      userId: 'user-abc',
      startedAt: '2026-02-23T10:00:00.000Z',
    });

    trackEntityView.mockRejectedValue(new Error('Entity not found in graph'));

    const res = await POST(createRequest({ entityId: 'tech-1', entityType: 'technology' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });
});
