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

const mockGetTokenUsageByAgent = jest.fn();
jest.mock('@/lib/agent-runs', () => ({
  getTokenUsageByAgent: (...args: unknown[]) => mockGetTokenUsageByAgent(...args),
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

function createMockRequest(url = 'http://localhost:3000/api/activity/tokens-by-agent'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

const SAMPLE_AGENTS = [
  {
    agentName: 'Scout',
    model: 'claude-sonnet-4-6',
    totalInput: 5000,
    totalOutput: 3000,
    totalTokens: 8000,
    totalCost: 0.02,
    runCount: 3,
  },
  {
    agentName: 'Linker',
    model: 'claude-sonnet-4-6',
    totalInput: 2000,
    totalOutput: 1000,
    totalTokens: 3000,
    totalCost: 0.008,
    runCount: 2,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/activity/tokens-by-agent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with per-agent breakdown', async () => {
    mockGetTokenUsageByAgent.mockResolvedValue(SAMPLE_AGENTS);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.agents).toHaveLength(2);
    expect(json.agents[0].agentName).toBe('Scout');
    expect(json.agents[0].totalTokens).toBe(8000);
    expect(json.agents[1].agentName).toBe('Linker');
  });

  it('passes authenticated uid to getTokenUsageByAgent', async () => {
    mockGetTokenUsageByAgent.mockResolvedValue([]);

    await GET(createMockRequest());

    expect(mockGetTokenUsageByAgent).toHaveBeenCalledWith('test-user-123');
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
    expect(mockGetTokenUsageByAgent).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockGetTokenUsageByAgent.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to get token usage by agent');
  });

  it('returns empty agents array when no runs exist', async () => {
    mockGetTokenUsageByAgent.mockResolvedValue([]);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.agents).toEqual([]);
  });

  it('includes model info in agent breakdown', async () => {
    mockGetTokenUsageByAgent.mockResolvedValue([
      {
        agentName: 'Strategist',
        model: 'claude-opus-4-6',
        totalInput: 10000,
        totalOutput: 8000,
        totalTokens: 18000,
        totalCost: 0.15,
        runCount: 1,
      },
    ]);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.agents[0].model).toBe('claude-opus-4-6');
    expect(json.agents[0].totalCost).toBe(0.15);
  });
});
