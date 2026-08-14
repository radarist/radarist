/**
 * @file route.test.ts
 * @description Unit tests for POST /api/admin/briefing/purge-stale.
 *
 * @jest-environment node
 *
 * The endpoint is a thin wrapper over `purgeStaleConnectionInsights()` —
 * the Cypher selection contract is locked down in the lib unit tests.
 * Here we focus on route-level concerns: admin gate, success shape,
 * error mapping.
 *
 * Phase 0 step 0.2 of the briefing-pipeline cleanup plan (2026-05-13).
 */

import { NextRequest } from 'next/server';

const mockRequireAdmin = jest.fn();
const mockPurgeStale = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

jest.mock('@/lib/graph/proactive-insights', () => ({
  purgeStaleConnectionInsights: (...args: unknown[]) => mockPurgeStale(...args),
}));

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/admin/briefing/purge-stale', {
    method: 'POST',
  });
}

describe('POST /api/admin/briefing/purge-stale', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      authenticated: true,
      uid: 'admin-claudio',
      email: 'admin@test.com',
    });
  });

  it('returns 401 when the caller is not an admin', async () => {
    mockRequireAdmin.mockResolvedValue({
      authenticated: false,
      error: 'Admin access required',
    });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'Admin access required' });
    expect(mockPurgeStale).not.toHaveBeenCalled();
  });

  it('purges and returns the count on success', async () => {
    mockPurgeStale.mockResolvedValue(7);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, purgedCount: 7 });
    expect(mockPurgeStale).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 with purgedCount=0 when nothing matched', async () => {
    mockPurgeStale.mockResolvedValue(0);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, purgedCount: 0 });
  });

  it('returns 500 when the underlying purge throws', async () => {
    mockPurgeStale.mockRejectedValue(new Error('Neo4j unavailable'));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal error' });
  });
});
