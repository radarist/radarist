/**
 * @file route.test.ts
 * @description Unit tests for DELETE /api/radars/[radarId] — the server-owned,
 * authenticated, profile-bound radar deletion boundary (LOCAL-010).
 *
 * The route wraps adminDeleteRadar (relations → placements → required graph
 * handoff → radar doc). Contract under test:
 *   401 unauthenticated · 400 invalid id · 404 radar absent (already converged)
 *   200 { ok, radarId, placementsDeleted } · 502 { error, retryable: true }
 *
 * @jest-environment node
 */

import { DELETE } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/radars-admin', () => ({
  adminGetRadarById: jest.fn(),
  adminDeleteRadar: jest.fn(),
  // Real class so the route's `instanceof RadarAuthorizationError` 403 branch resolves.
  RadarAuthorizationError: class RadarAuthorizationError extends Error {
    radarId: string;
    constructor(radarId: string) {
      super(`Not authorized to mutate radar ${radarId}`);
      this.name = 'RadarAuthorizationError';
      this.radarId = radarId;
    }
  },
}));

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { adminGetRadarById, adminDeleteRadar, RadarAuthorizationError } = jest.requireMock('@/lib/radars-admin');

function createDelete(radarId: string) {
  const request = new NextRequest(`http://localhost/api/radars/${encodeURIComponent(radarId)}`, {
    method: 'DELETE',
  });
  return DELETE(request, { params: Promise.resolve({ radarId }) });
}

describe('DELETE /api/radars/[radarId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
    adminGetRadarById.mockResolvedValue({ id: 'radar-1', name: 'My Radar', quadrants: [] });
    adminDeleteRadar.mockResolvedValue({ placementsDeleted: 3 });
  });

  it('rejects unauthenticated requests with 401 and never touches the radar', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Missing token' });

    const res = await createDelete('radar-1');
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Missing token');
    expect(adminDeleteRadar).not.toHaveBeenCalled();
  });

  it('rejects a blank radar id with 400', async () => {
    const res = await createDelete('   ');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/radar id/i);
    expect(adminDeleteRadar).not.toHaveBeenCalled();
  });

  it('rejects malformed percent-encoding with 400 (caller error, not retryable)', async () => {
    const request = new NextRequest('http://localhost/api/radars/%ZZ', { method: 'DELETE' });
    const res = await DELETE(request, { params: Promise.resolve({ radarId: '%ZZ' }) });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/encoding/i);
    expect(json.retryable).toBeUndefined();
    expect(adminDeleteRadar).not.toHaveBeenCalled();
  });

  it('#2 denies an absent radar identically to a foreign one (no 404-vs-403 existence oracle)', async () => {
    // The route no longer pre-reads to 404 on absence. The primitive raises the
    // same RadarAuthorizationError for a missing/foreign/ownerless radar, so a
    // non-owner cannot use the status code to probe which radars exist.
    adminDeleteRadar.mockRejectedValue(new RadarAuthorizationError('radar-gone'));

    const res = await createDelete('radar-gone');
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('forbidden');
  });

  it('deletes through adminDeleteRadar with cascade and reports the truth', async () => {
    const res = await createDelete('radar-1');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, radarId: 'radar-1', placementsDeleted: 3 });
    // GRAPH-060 #2 — owner-only: the authenticated uid is the REQUIRED owner arg.
    expect(adminDeleteRadar).toHaveBeenCalledWith('radar-1', 'test-user-123', { cascade: true });
  });

  it('#2 maps an ownership refusal to 403 (a signed-in non-owner cannot delete)', async () => {
    adminDeleteRadar.mockRejectedValue(new RadarAuthorizationError('radar-1'));

    const res = await createDelete('radar-1');
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('forbidden');
  });

  it('fails closed with a retryable 502 when the cascade or graph handoff fails', async () => {
    adminDeleteRadar.mockRejectedValue(new Error('Failed to schedule radar graph cleanup: dev server unreachable'));

    const res = await createDelete('radar-1');
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.retryable).toBe(true);
    expect(json.error).toMatch(/graph cleanup/);
    expect(adminDeleteRadar).toHaveBeenCalledTimes(1);
  });

  it('allows deleting the final radar (no client-side minimum is enforced server-side)', async () => {
    adminDeleteRadar.mockResolvedValue({ placementsDeleted: 0 });

    const res = await createDelete('last-radar');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.placementsDeleted).toBe(0);
  });
});
