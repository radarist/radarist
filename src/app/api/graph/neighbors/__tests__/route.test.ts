/**
 * @file route.test.ts
 * @description Unit tests for GET /api/graph/neighbors
 *
 * Server-side neighbor lookup for the browser graph panels (P5-D graph
 * panel revival — the in-browser graph service is permanently
 * uninitialized, so panels fetch through this route instead).
 * Covers:
 * - Authentication gate
 * - nodeId validation
 * - depth/limit clamping (<=2 / <=50)
 * - Success shape
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
  getNeighbors: jest.fn(),
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

import { GET } from '../route';

const { getNeighbors } = jest.requireMock('@/lib/graph');
const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/graph/neighbors');
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url.toString(), { method: 'GET' });
}

const NEIGHBOR = {
  id: 'tech-2',
  labels: ['Entity', 'Technology'],
  properties: { name: 'PyTorch', entityType: 'technology' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/graph/neighbors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
    getNeighbors.mockResolvedValue([NEIGHBOR]);
  });

  it('returns 401 when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Missing token' });

    const res = await GET(createRequest({ nodeId: 'tech-1' }));

    expect(res.status).toBe(401);
    expect(getNeighbors).not.toHaveBeenCalled();
  });

  it('returns 400 when nodeId is missing', async () => {
    const res = await GET(createRequest());

    expect(res.status).toBe(400);
    expect(getNeighbors).not.toHaveBeenCalled();
  });

  it('returns neighbors with defaults (depth 1, limit 50)', async () => {
    const res = await GET(createRequest({ nodeId: 'tech-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.neighbors).toEqual([NEIGHBOR]);
    expect(getNeighbors).toHaveBeenCalledWith('tech-1', { depth: 1, limit: 50 });
  });

  it('passes depth and limit through', async () => {
    const res = await GET(createRequest({ nodeId: 'tech-1', depth: '2', limit: '10' }));

    expect(res.status).toBe(200);
    expect(getNeighbors).toHaveBeenCalledWith('tech-1', { depth: 2, limit: 10 });
  });

  it('rejects depth above 2', async () => {
    const res = await GET(createRequest({ nodeId: 'tech-1', depth: '3' }));

    expect(res.status).toBe(400);
    expect(getNeighbors).not.toHaveBeenCalled();
  });

  it('rejects limit above 50', async () => {
    const res = await GET(createRequest({ nodeId: 'tech-1', limit: '100' }));

    expect(res.status).toBe(400);
    expect(getNeighbors).not.toHaveBeenCalled();
  });

  it('rejects non-numeric depth', async () => {
    const res = await GET(createRequest({ nodeId: 'tech-1', depth: 'abc' }));

    expect(res.status).toBe(400);
  });

  it('returns 503 with degraded flag on GraphUnavailableError', async () => {
    getNeighbors.mockRejectedValue(new GraphUnavailableError('getNeighbors'));

    const res = await GET(createRequest({ nodeId: 'tech-1' }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.degraded).toBe(true);
  });

  it('returns 500 on unexpected errors', async () => {
    getNeighbors.mockRejectedValue(new Error('boom'));

    const res = await GET(createRequest({ nodeId: 'tech-1' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
