/**
 * @jest-environment node
 */

/**
 * @file route.test.ts
 * @description Tests for GET /api/missions/[id]
 *
 * Covers:
 * - Returns mission for valid ID (200)
 * - Returns 404 for nonexistent ID
 * - Returns 403 when userId doesn't match (authorization)
 * - Returns 401 for unauthenticated request
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest } from 'next/server';

// ============================================================================
// MOCKS
// ============================================================================

// Mock auth — default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock missions service
const mockGetMissionById = jest.fn();
const mockDeleteMission = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/missions', () => ({
  getMissionById: (...args: unknown[]) => mockGetMissionById(...args),
  deleteMission: (...args: unknown[]) => mockDeleteMission(...args),
}));

// DELETE's cascade reaches for these lazily; harmless stubs
const mockAdminCollection = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({ db: { collection: mockAdminCollection } }));
jest.mock('@/lib/agent-import', () => ({ importSandbox: jest.fn() }));
const mockAdminDeletePrototype = jest.fn();
jest.mock('@/lib/prototypes-admin', () => ({
  adminDeletePrototype: (...args: unknown[]) => mockAdminDeletePrototype(...args),
}));
const mockAdminDeleteDocument = jest.fn();
jest.mock('@/lib/document-admin', () => ({
  adminDeleteDocument: (...args: unknown[]) => mockAdminDeleteDocument(...args),
}));

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { GET, DELETE } from '../route';

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/missions/mission-1');
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

const mockMission = {
  id: 'mission-1',
  userId: 'test-user-123',
  prompt: 'Find emerging AI startups in healthcare',
  agent: 'scout',
  status: 'completed',
  progress: 100,
  entities: [
    {
      id: 'tech-1',
      name: 'BioAI Corp',
      type: 'company',
      confidence: 0.85,
      agentName: 'scout',
    },
  ],
  sources: [
    {
      url: 'https://example.com/article',
      title: 'AI in Healthcare 2026',
    },
  ],
  result: '# Summary\nFound 3 emerging startups...',
  createdAt: '2026-02-23T10:00:00.000Z',
  completedAt: '2026-02-23T10:05:00.000Z',
};

// ============================================================================
// TESTS: GET /api/missions/[id]
// ============================================================================

describe('GET /api/missions/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteMission.mockResolvedValue(undefined);
    mockAdminDeletePrototype.mockResolvedValue(undefined);
  });

  it('returns mission for valid ID', async () => {
    mockGetMissionById.mockResolvedValue(mockMission);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(mockMission);
    expect(mockGetMissionById).toHaveBeenCalledWith('mission-1');
  });

  it('returns 404 for nonexistent ID', async () => {
    mockGetMissionById.mockResolvedValue(null);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'nonexistent-mission' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Mission not found');
  });

  it('returns 403 when userId does not match (authorization)', async () => {
    const otherUserMission = {
      ...mockMission,
      userId: 'other-user-456',
    };
    mockGetMissionById.mockResolvedValue(otherUserMission);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Forbidden');
  });

  // ARUN-005: system-dispatched missions are readable by the signed-in user
  // in local single-user mode; only foreign HUMAN owners stay forbidden.
  it.each(['system', 'system-sweep', 'system-discovery'])(
    'returns 200 for a %s-owned mission (system-principal read union)',
    async (principal) => {
      mockGetMissionById.mockResolvedValue({ ...mockMission, userId: principal });

      const res = await GET(createMockRequest(), {
        params: Promise.resolve({ id: 'mission-1' }),
      });

      expect(res.status).toBe(200);
    }
  );

  // ARUN-005: mutations too — a visible system artifact must never carry a
  // dead 403 Delete button (bulk delete would silently skip it).
  it('DELETE proceeds past ownership for a system-owned build artifact', async () => {
    mockGetMissionById.mockResolvedValue({
      ...mockMission,
      userId: 'system-discovery',
      kind: 'build',
      sandbox: undefined,
      artifact: undefined,
    });

    const res = await DELETE(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockDeleteMission).toHaveBeenCalledWith('mission-1');
  });

  it('DELETE retains the mission and reports partial cleanup (409) when Prototype fails', async () => {
    mockGetMissionById.mockResolvedValue({
      ...mockMission,
      kind: 'build',
      sandbox: undefined,
      artifact: { prototypeId: 'prototype-1' },
    });
    mockAdminDeletePrototype.mockRejectedValueOnce(new Error('graph handoff failed'));

    const res = await DELETE(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });
    const json = await res.json();

    // BUILD-025: honest partial report, anchor retained (not an opaque 500).
    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.failedResources).toContain('prototype');
    expect(json.retryable).toBe(true);
    expect(mockAdminDeletePrototype).toHaveBeenCalledWith('prototype-1');
    expect(mockDeleteMission).not.toHaveBeenCalled();
  });

  it('DELETE returns 200 with per-resource outcomes when the full cascade succeeds', async () => {
    mockAdminCollection.mockReturnValue({ doc: () => ({ delete: jest.fn().mockResolvedValue(undefined) }) });
    mockAdminDeletePrototype.mockResolvedValue(undefined);
    mockAdminDeleteDocument.mockResolvedValue(undefined);
    mockGetMissionById.mockResolvedValue({
      ...mockMission,
      kind: 'build',
      sandbox: undefined,
      artifact: { documentId: 'doc-1', assessmentId: 'assess-1' },
    });

    const res = await DELETE(createMockRequest(), { params: Promise.resolve({ id: 'mission-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.outcomes.find((o: { resource: string }) => o.resource === 'document').status).toBe('deleted');
    expect(json.outcomes.find((o: { resource: string }) => o.resource === 'assessment').status).toBe('deleted');
    expect(mockDeleteMission).toHaveBeenCalledWith('mission-1');
  });

  it('DELETE retains the mission (409) when Document cleanup fails', async () => {
    mockAdminDeleteDocument.mockRejectedValueOnce(new Error('doc delete failed'));
    mockGetMissionById.mockResolvedValue({
      ...mockMission,
      kind: 'build',
      sandbox: undefined,
      artifact: { documentId: 'doc-1' },
    });

    const res = await DELETE(createMockRequest(), { params: Promise.resolve({ id: 'mission-1' }) });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.failedResources).toContain('document');
    expect(mockDeleteMission).not.toHaveBeenCalled();
  });

  it('returns 401 for unauthenticated request', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
    expect(mockGetMissionById).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockGetMissionById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'mission-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to get mission');
  });
});
