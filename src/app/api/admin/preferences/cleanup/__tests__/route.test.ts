/**
 * @file route.test.ts
 * @description Unit tests for POST /api/admin/preferences/cleanup.
 *
 * @jest-environment node
 *
 * Thin wrapper over `cleanupZombiePreferences()` — the Cypher contract is
 * pinned in the lib test. Here we cover route-level concerns: admin gate,
 * success shape, error mapping.
 *
 * Phase 0 step 0.9 of the briefing-pipeline cleanup plan (2026-05-13).
 */

import { NextRequest } from 'next/server';

const mockRequireAdmin = jest.fn();
const mockCleanup = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

jest.mock('@/lib/graph/preferences', () => ({
  cleanupZombiePreferences: (...args: unknown[]) => mockCleanup(...args),
}));

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/admin/preferences/cleanup', {
    method: 'POST',
  });
}

describe('POST /api/admin/preferences/cleanup', () => {
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
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it('cleans up and returns the count on success', async () => {
    mockCleanup.mockResolvedValue(2);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, deletedCount: 2 });
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with deletedCount=0 when nothing matched', async () => {
    mockCleanup.mockResolvedValue(0);

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, deletedCount: 0 });
  });

  it('returns 500 when the underlying cleanup throws', async () => {
    mockCleanup.mockRejectedValue(new Error('Neo4j unavailable'));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal error' });
  });
});
