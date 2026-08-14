/**
 * @jest-environment node
 *
 * GRAPH-060 — PATCH / DELETE /api/radar-placements/[id] (authenticated update,
 * ring-move, and delete through the acknowledged graph handoff).
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'user-1',
    email: 'user@example.com',
  }),
}));

jest.mock('@/lib/radar-placement-admin', () => {
  class PlacementValidationError extends Error {}
  class PlacementAuthorizationError extends Error {}
  class MalformedPlacementLockError extends Error {}
  class PlacementPairConflictError extends Error {}
  class AmbiguousLegacyPlacementError extends Error {}
  class PlacementParentDeletingError extends Error {}
  return {
    adminUpdateRadarPlacementWithHandoff: jest.fn(),
    adminDeleteRadarPlacementWithHandoff: jest.fn(),
    PlacementValidationError,
    PlacementAuthorizationError,
    MalformedPlacementLockError,
    PlacementPairConflictError,
    AmbiguousLegacyPlacementError,
    PlacementParentDeletingError,
  };
});

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { adminUpdateRadarPlacementWithHandoff, adminDeleteRadarPlacementWithHandoff, PlacementAuthorizationError } =
  jest.requireMock('@/lib/radar-placement-admin');

import { PATCH, DELETE } from '../route';

function req(method: string, body?: unknown, authed = true): NextRequest {
  return new NextRequest('http://localhost:32002/api/radar-placements/placement-1', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authed ? { Authorization: 'Bearer test-token' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = Promise.resolve({ id: 'placement-1' });

beforeEach(() => {
  jest.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'user@example.com' });
});

describe('PATCH /api/radar-placements/[id]', () => {
  it('rejects an unauthenticated request with 401 before touching the body', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });

    const res = await PATCH(req('PATCH', { ring: 'Adopt' }, false), { params });

    expect(res.status).toBe(401);
    expect(adminUpdateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('rejects an empty update body with 400', async () => {
    const res = await PATCH(req('PATCH', {}), { params });
    expect(res.status).toBe(400);
    expect(adminUpdateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('applies a ring move and returns 200 with the handoff', async () => {
    adminUpdateRadarPlacementWithHandoff.mockResolvedValueOnce({
      placement: { id: 'placement-1', ring: 'Adopt' },
      graphHandoff: { committed: true, acknowledged: true, reconciliationRequired: false },
    });

    const res = await PATCH(req('PATCH', { ring: 'Adopt', rationale: 'Proven' }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.ring).toBe('Adopt');
    expect(json.graphHandoff.acknowledged).toBe(true);
    // #3 — the update is authorized against the radar (requireOwnerId = auth.uid).
    expect(adminUpdateRadarPlacementWithHandoff).toHaveBeenCalledWith(
      'placement-1',
      expect.objectContaining({ ring: 'Adopt', rationale: 'Proven' }),
      { requireOwnerId: 'user-1' }
    );
  });

  it('#1 hard-rejects a client-supplied placedBy on PATCH (strict schema, 400, never mutates)', async () => {
    const res = await PATCH(req('PATCH', { ring: 'Adopt', placedBy: 'victim-uid' }), { params });

    expect(res.status).toBe(400);
    expect(adminUpdateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('#1 hard-rejects an attempted identity change (radarId/technologyId) on PATCH', async () => {
    const resRadar = await PATCH(req('PATCH', { ring: 'Adopt', radarId: 'radar-other' }), { params });
    const resTech = await PATCH(req('PATCH', { ring: 'Adopt', technologyId: 'tech-other' }), { params });

    expect(resRadar.status).toBe(400);
    expect(resTech.status).toBe(400);
    expect(adminUpdateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('#3 maps an authorization failure to 403', async () => {
    adminUpdateRadarPlacementWithHandoff.mockRejectedValueOnce(new PlacementAuthorizationError('radar-1'));
    const res = await PATCH(req('PATCH', { ring: 'Adopt' }), { params });
    expect(res.status).toBe(403);
  });

  it('maps a not-found commit error to 404', async () => {
    adminUpdateRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Failed to update placement: Placement placement-1 not found')
    );

    const res = await PATCH(req('PATCH', { ring: 'Adopt' }), { params });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/radar-placements/[id]', () => {
  it('rejects an unauthenticated request with 401', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });

    const res = await DELETE(req('DELETE', undefined, false), { params });

    expect(res.status).toBe(401);
    expect(adminDeleteRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('deletes and returns 200 with a reconciliation-required handoff surfaced honestly', async () => {
    adminDeleteRadarPlacementWithHandoff.mockResolvedValueOnce({
      graphHandoff: { committed: true, acknowledged: false, reconciliationRequired: true },
    });

    const res = await DELETE(req('DELETE'), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(json.graphHandoff.reconciliationRequired).toBe(true);
  });

  it('maps a not-found delete error to 404', async () => {
    adminDeleteRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Failed to delete placement: Placement placement-1 not found')
    );

    const res = await DELETE(req('DELETE'), { params });

    expect(res.status).toBe(404);
  });
});
