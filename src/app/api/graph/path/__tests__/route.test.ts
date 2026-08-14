/**
 * @file route.test.ts
 * @description Unit tests for GET /api/graph/path
 *
 * Server-side connection explanation for the browser graph panels (P5-D
 * graph panel revival). Covers:
 * - Authentication gate
 * - from/to validation
 * - Success shape (result = ConnectionExplanation)
 * - H10 honest degradation (503 + degraded flag on GraphUnavailableError)
 * - Error handling
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { GraphUnavailableError } from '@/lib/graph/errors';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/graph', () => ({
  explainGraphConnection: jest.fn(),
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

import { GET } from '../route';

const { explainGraphConnection } = jest.requireMock('@/lib/graph');
const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/graph/path');
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url.toString(), { method: 'GET' });
}

const EXPLANATION = {
  connected: true,
  explanation: '"React" is directly connected to "UI Performance" via SOLVES.',
  pathNodes: [
    { id: 'tech-1', name: 'React', type: 'technology' },
    { id: 'pp-1', name: 'UI Performance', type: 'painPoint' },
  ],
  pathRelations: [{ type: 'SOLVES', from: 'React', to: 'UI Performance' }],
  hops: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/graph/path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
    explainGraphConnection.mockResolvedValue(EXPLANATION);
  });

  it('returns 401 when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Missing token' });

    const res = await GET(createRequest({ from: 'a', to: 'b' }));

    expect(res.status).toBe(401);
    expect(explainGraphConnection).not.toHaveBeenCalled();
  });

  it('returns 400 when from is missing', async () => {
    const res = await GET(createRequest({ to: 'b' }));

    expect(res.status).toBe(400);
    expect(explainGraphConnection).not.toHaveBeenCalled();
  });

  it('returns 400 when to is missing', async () => {
    const res = await GET(createRequest({ from: 'a' }));

    expect(res.status).toBe(400);
    expect(explainGraphConnection).not.toHaveBeenCalled();
  });

  it('returns the connection explanation', async () => {
    const res = await GET(createRequest({ from: 'tech-1', to: 'pp-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.result).toEqual(EXPLANATION);
    expect(explainGraphConnection).toHaveBeenCalledWith('tech-1', 'pp-1');
  });

  it('returns 503 with degraded flag on GraphUnavailableError', async () => {
    explainGraphConnection.mockRejectedValue(new GraphUnavailableError('findPath'));

    const res = await GET(createRequest({ from: 'a', to: 'b' }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.degraded).toBe(true);
  });

  it('returns 500 on unexpected errors', async () => {
    explainGraphConnection.mockRejectedValue(new Error('boom'));

    const res = await GET(createRequest({ from: 'a', to: 'b' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
