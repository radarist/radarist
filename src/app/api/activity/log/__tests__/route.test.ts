/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports)
// ---------------------------------------------------------------------------

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

const mockListAgentRunsWithDiagnostics = jest.fn();
jest.mock('@/lib/agent-runs', () => ({
  listAgentRunsWithDiagnostics: (...args: unknown[]) => mockListAgentRunsWithDiagnostics(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { GET } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(
  url = 'http://localhost:3000/api/activity/log'
): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

const SAMPLE_RUNS = [
  {
    id: 'run-1',
    userId: 'test-user-123',
    agentName: 'Scout',
    action: 'Discovered 3 new signals',
    status: 'success',
    tokenUsage: { input: 1200, output: 800 },
    costUsd: 0.004,
    duration: 3200,
    createdAt: '2026-02-23T10:00:00.000Z',
  },
  {
    id: 'run-2',
    userId: 'test-user-123',
    agentName: 'Linker',
    action: 'Linked 5 entities',
    status: 'success',
    tokenUsage: { input: 800, output: 400 },
    costUsd: 0.002,
    duration: 1500,
    createdAt: '2026-02-23T09:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/activity/log', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with agent run entries', async () => {
    mockListAgentRunsWithDiagnostics.mockResolvedValue({ runs: SAMPLE_RUNS, degradedKinds: [] });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.entries).toHaveLength(2);
    expect(json.entries[0].agentName).toBe('Scout');
    expect(json.entries[1].agentName).toBe('Linker');
    expect(json.degradedKinds).toEqual([]);
  });

  it('passes authenticated uid to listAgentRunsWithDiagnostics', async () => {
    mockListAgentRunsWithDiagnostics.mockResolvedValue({ runs: [], degradedKinds: [] });

    await GET(createMockRequest());

    expect(mockListAgentRunsWithDiagnostics).toHaveBeenCalledWith('test-user-123');
  });

  it('returns bounded history-degradation diagnostics with partial entries', async () => {
    mockListAgentRunsWithDiagnostics.mockResolvedValue({ runs: SAMPLE_RUNS, degradedKinds: ['mission'] });

    const res = await GET(createMockRequest());

    await expect(res.json()).resolves.toMatchObject({ entries: SAMPLE_RUNS, degradedKinds: ['mission'] });
  });

  // ARUN-005 security contract: the principal union is server-authorized —
  // a client-supplied principal in the query string must never reach the
  // service layer.
  it('ignores a client-supplied userId query param', async () => {
    mockListAgentRunsWithDiagnostics.mockResolvedValue({ runs: [], degradedKinds: [] });

    await GET(createMockRequest('http://localhost:3000/api/activity/log?userId=system-sweep'));

    expect(mockListAgentRunsWithDiagnostics).toHaveBeenCalledWith('test-user-123');
    expect(mockListAgentRunsWithDiagnostics).not.toHaveBeenCalledWith('system-sweep');
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
    expect(mockListAgentRunsWithDiagnostics).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockListAgentRunsWithDiagnostics.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to list agent runs');
  });

  it('returns empty entries array when user has no runs', async () => {
    mockListAgentRunsWithDiagnostics.mockResolvedValue({ runs: [], degradedKinds: [] });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.entries).toEqual([]);
  });
});
