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

const mockGetTokenUsageSummary = jest.fn();
jest.mock('@/lib/agent-runs', () => ({
  getTokenUsageSummary: (...args: unknown[]) =>
    mockGetTokenUsageSummary(...args),
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
  url = 'http://localhost:3000/api/activity/tokens'
): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

const SAMPLE_SUMMARY = {
  today: { input: 5000, output: 3000, total: 8000, costUsd: 0.02 },
  thisWeek: [
    {
      date: '2026-02-17',
      input: 1000,
      output: 500,
      total: 1500,
      costUsd: 0.005,
    },
    {
      date: '2026-02-18',
      input: 2000,
      output: 1000,
      total: 3000,
      costUsd: 0.01,
    },
    {
      date: '2026-02-19',
      input: 0,
      output: 0,
      total: 0,
      costUsd: 0,
    },
    {
      date: '2026-02-20',
      input: 1500,
      output: 800,
      total: 2300,
      costUsd: 0.008,
    },
    {
      date: '2026-02-21',
      input: 3000,
      output: 1500,
      total: 4500,
      costUsd: 0.015,
    },
    {
      date: '2026-02-22',
      input: 500,
      output: 200,
      total: 700,
      costUsd: 0.002,
    },
    {
      date: '2026-02-23',
      input: 5000,
      output: 3000,
      total: 8000,
      costUsd: 0.02,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/activity/tokens', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with token usage summary', async () => {
    mockGetTokenUsageSummary.mockResolvedValue(SAMPLE_SUMMARY);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.today).toEqual(SAMPLE_SUMMARY.today);
    expect(json.thisWeek).toHaveLength(7);
    expect(json).not.toHaveProperty('dailyBudget');
  });

  it('passes authenticated uid to getTokenUsageSummary', async () => {
    mockGetTokenUsageSummary.mockResolvedValue(SAMPLE_SUMMARY);

    await GET(createMockRequest());

    expect(mockGetTokenUsageSummary).toHaveBeenCalledWith('test-user-123');
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
    expect(mockGetTokenUsageSummary).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    mockGetTokenUsageSummary.mockRejectedValue(
      new Error('Firestore unavailable')
    );

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to get token usage summary');
  });

  it('returns zero values when user has no usage', async () => {
    const emptySummary = {
      today: { input: 0, output: 0, total: 0, costUsd: 0 },
      thisWeek: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${17 + i}`,
        input: 0,
        output: 0,
        total: 0,
        costUsd: 0,
      })),
    };
    mockGetTokenUsageSummary.mockResolvedValue(emptySummary);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.today.total).toBe(0);
    expect(json.thisWeek.every((d: { total: number }) => d.total === 0)).toBe(
      true
    );
  });
});
