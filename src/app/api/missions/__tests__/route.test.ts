/**
 * @jest-environment node
 */

/**
 * @file route.test.ts
 * @description Tests for POST /api/missions and GET /api/missions
 *
 * Covers:
 * - POST: fires Inngest for single mission on non-gated dispatch
 * - POST: fires Inngest ONLY for step 1 of a gated chain
 * - POST: includes chainId and missions[] in response when gated
 * - POST: returns 400 for invalid body
 * - POST: returns 401 for unauthenticated
 * - POST: returns 500 when service throws
 * - GET: returns missions list
 * - GET: returns 401 for unauthenticated
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
    uid: 'user-a',
    email: 'test@example.com',
  }),
}));

// Mock research gate — replaces createMission as the POST handler's entry point
jest.mock('@/lib/mission-research-gate', () => ({
  dispatchMissionWithGate: jest.fn(),
}));

// Mock mission intent classifier — POST calls it before dispatch
jest.mock('@/lib/ai/mission-intent-classifier', () => ({
  classifyMissionIntent: jest.fn().mockResolvedValue({
    slots: [],
    metadata: { latencyMs: 0, costUsd: 0, fallback: true, model: 'gemini-3-flash-preview' },
  }),
}));

// OPS-004: POST runs an MCP preflight BEFORE the paid classifier. Default to
// reachable so existing dispatch tests are unaffected.
jest.mock('@/lib/mission-mcp-preflight', () => ({
  preflightMissionMcp: jest.fn().mockResolvedValue({
    ok: true,
    baseUrl: 'http://127.0.0.1:9002/api/mcp',
    checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
    unreachable: [],
    reason: undefined,
  }),
  mcpPreflightRemediation: (reason?: string) => `remediation for ${reason ?? 'mcp-preflight-failed'}`,
}));

// Mock missions service (only listMissions is used by the route now)
const mockListMissions = jest.fn();
jest.mock('@/lib/missions', () => ({
  listMissions: (...args: unknown[]) => mockListMissions(...args),
}));

// Mock Inngest
const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['evt-1'] });
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
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

import { POST, GET } from '../route';
import { dispatchMissionWithGate } from '@/lib/mission-research-gate';

const dispatchMock = dispatchMissionWithGate as jest.Mock;

// ============================================================================
// HELPERS
// ============================================================================

function buildRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/missions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function createGetRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/missions');
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ============================================================================
// TESTS: POST /api/missions
// ============================================================================

describe('POST /api/missions', () => {
  beforeEach(() => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-a',
      email: 'test@example.com',
    });
    const { classifyMissionIntent } = jest.requireMock('@/lib/ai/mission-intent-classifier');
    classifyMissionIntent.mockReset();
    classifyMissionIntent.mockResolvedValue({
      slots: [],
      metadata: { latencyMs: 0, costUsd: 0, fallback: true, model: 'gemini-3-flash-preview' },
    });
    const { preflightMissionMcp } = jest.requireMock('@/lib/mission-mcp-preflight');
    preflightMissionMcp.mockReset();
    preflightMissionMcp.mockResolvedValue({
      ok: true,
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
      unreachable: [],
      reason: undefined,
    });
    dispatchMock.mockReset();
    mockInngestSend.mockClear();
  });

  it('OPS-004: returns 503 mcp-preflight-failed and never calls the paid classifier or dispatch when MCP is unreachable', async () => {
    const { preflightMissionMcp } = jest.requireMock('@/lib/mission-mcp-preflight');
    preflightMissionMcp.mockResolvedValue({
      ok: false,
      reason: 'mcp-preflight-failed',
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
      unreachable: ['reports'],
    });
    const { classifyMissionIntent } = jest.requireMock('@/lib/ai/mission-intent-classifier');

    const res = await POST(buildRequest({ agent: 'scout', prompt: 'research X' }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe('mcp-preflight-failed');
    expect(body.remediation).toEqual(expect.any(String));
    // The internal base URL / server list must never reach the client.
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
    expect(body.baseUrl).toBeUndefined();
    expect(body.unreachable).toBeUndefined();
    // The paid classifier and dispatch must never run.
    expect(classifyMissionIntent).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('fires Inngest for the single mission on a non-gated dispatch', async () => {
    dispatchMock.mockResolvedValue({
      dispatched: [{ id: 'mission-1', agent: 'scout', prompt: 'research X' }],
      gated: false,
    });

    const res = await POST(buildRequest({ agent: 'scout', prompt: 'research X' }));
    expect(res.status).toBe(201);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const call = mockInngestSend.mock.calls[0][0];
    expect(call.data.missionId).toBe('mission-1');
    expect(call.data.agent).toBe('scout');
  });

  it('fires Inngest ONLY for step 1 of a gated chain', async () => {
    dispatchMock.mockResolvedValue({
      dispatched: [
        { id: 'mission-scout-1', agent: 'scout', prompt: 'research X', chainStep: 1 },
        { id: 'mission-creator-2', agent: 'creator', prompt: 'write X', chainStep: 2 },
      ],
      gated: true,
      chainId: 'chain-abc',
    });

    const res = await POST(buildRequest({ agent: 'creator', prompt: 'Analyze the open-weight AI market' }));
    expect(res.status).toBe(201);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const call = mockInngestSend.mock.calls[0][0];
    expect(call.data.missionId).toBe('mission-scout-1');
    expect(call.data.agent).toBe('scout');
  });

  it('includes chainId and missions[] in the response when gated', async () => {
    dispatchMock.mockResolvedValue({
      dispatched: [
        { id: 'mission-scout-1', agent: 'scout', prompt: 'research X', chainStep: 1 },
        { id: 'mission-creator-2', agent: 'creator', prompt: 'write X', chainStep: 2 },
      ],
      gated: true,
      chainId: 'chain-abc',
    });

    const res = await POST(buildRequest({ agent: 'creator', prompt: 'Analyze the open-weight AI market' }));
    const body = await res.json();
    expect(body.chainId).toBe('chain-abc');
    expect(body.gated).toBe(true);
    expect(body.missions).toHaveLength(2);
    expect(body.id).toBe('mission-scout-1'); // backwards-compat: top-level is first mission
  });

  it('threads classifier output into dispatchMissionWithGate extras', async () => {
    const { classifyMissionIntent } = jest.requireMock('@/lib/ai/mission-intent-classifier');
    classifyMissionIntent.mockResolvedValueOnce({
      slots: [{ name: 'main', intent: 'test report' }],
      metadata: { latencyMs: 100, costUsd: 0, fallback: false, model: 'gemini-3-flash-preview' },
    });
    dispatchMock.mockResolvedValue({
      dispatched: [{ id: 'mission-1', agent: 'creator', prompt: 'create a vendor report' }],
      gated: false,
    });

    await POST(buildRequest({ prompt: 'create a vendor report', agent: 'creator' }));

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prompt: 'create a vendor report' }),
      expect.objectContaining({
        slots: [{ name: 'main', intent: 'test report' }],
        classifierMetadata: expect.objectContaining({ fallback: false }),
      }),
      // OPS-004: the route already preflighted, so it tells the gate not to re-probe.
      { preflightVerified: true }
    );
  });

  it('returns 400 for invalid body (missing prompt)', async () => {
    const res = await POST(buildRequest({ agent: 'scout' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid body (empty prompt)', async () => {
    const res = await POST(buildRequest({ prompt: '', agent: 'scout' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 401 for unauthenticated request', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await POST(buildRequest({ prompt: 'Find startups', agent: 'scout' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    dispatchMock.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await POST(buildRequest({ prompt: 'Find startups', agent: 'scout' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to create mission');
  });
});

// ============================================================================
// TESTS: GET /api/missions
// ============================================================================

describe('GET /api/missions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns missions list with 200', async () => {
    const mockMissions = [
      {
        id: 'mission-1',
        userId: 'test-user-123',
        prompt: 'First mission',
        agent: 'scout',
        status: 'completed',
        progress: 100,
        entities: [],
        sources: [],
        createdAt: '2026-02-23T12:00:00.000Z',
      },
      {
        id: 'mission-2',
        userId: 'test-user-123',
        prompt: 'Second mission',
        agent: 'scout',
        status: 'pending',
        progress: 0,
        entities: [],
        sources: [],
        createdAt: '2026-02-23T11:00:00.000Z',
      },
    ];
    mockListMissions.mockResolvedValue(mockMissions);

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.missions).toEqual(mockMissions);
    expect(json.missions).toHaveLength(2);
    expect(mockListMissions).toHaveBeenCalledWith('user-a');
  });

  it('returns empty missions array', async () => {
    mockListMissions.mockResolvedValue([]);

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.missions).toEqual([]);
  });

  it('returns 401 for unauthenticated request', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
    expect(mockListMissions).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockListMissions.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to list missions');
  });
});
