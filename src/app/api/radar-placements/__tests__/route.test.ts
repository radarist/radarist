/**
 * @jest-environment node
 *
 * GRAPH-060 — POST /api/radar-placements (authenticated placement create with an
 * acknowledged graph handoff). Auth is enforced BEFORE parsing/validation, the
 * body is Zod-validated, and the response carries an explicit `graphHandoff`
 * that distinguishes Firestore-committed-and-acknowledged from
 * committed-but-reconciliation-required — never a rollback.
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
    adminCreateRadarPlacementWithHandoff: jest.fn(),
    PlacementValidationError,
    PlacementAuthorizationError,
    MalformedPlacementLockError,
    PlacementPairConflictError,
    AmbiguousLegacyPlacementError,
    PlacementParentDeletingError,
  };
});

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { adminCreateRadarPlacementWithHandoff, PlacementAuthorizationError } =
  jest.requireMock('@/lib/radar-placement-admin');

import { POST } from '../route';

const VALID_BODY = {
  technologyId: 'tech-1',
  radarId: 'radar-1',
  quadrantId: 'techniques',
  ring: 'Trial',
};

function postRequest(body: unknown, authed = true): NextRequest {
  return new NextRequest('http://localhost:32002/api/radar-placements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authed ? { Authorization: 'Bearer test-token' } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'user@example.com' });
});

describe('POST /api/radar-placements', () => {
  it('rejects an unauthenticated request with 401 before touching the body', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'No authorization header provided' });

    const res = await POST(postRequest(VALID_BODY, false));

    expect(res.status).toBe(401);
    expect(adminCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload (missing technologyId) with 400 and never mutates', async () => {
    const { technologyId: _omit, ...invalid } = VALID_BODY;

    const res = await POST(postRequest(invalid));

    expect(res.status).toBe(400);
    expect(adminCreateRadarPlacementWithHandoff).not.toHaveBeenCalled();
  });

  it('returns 201 with the committed placement and an acknowledged handoff', async () => {
    adminCreateRadarPlacementWithHandoff.mockResolvedValueOnce({
      placement: { id: 'placement-1', ...VALID_BODY },
      graphHandoff: { committed: true, acknowledged: true, reconciliationRequired: false },
    });

    const res = await POST(postRequest(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('placement-1');
    expect(json.graphHandoff).toEqual({ committed: true, acknowledged: true, reconciliationRequired: false });
    // #3 — placedBy is stamped from auth.uid (not the client), and the mutation
    // is authorized against the radar (requireOwnerId = auth.uid).
    expect(adminCreateRadarPlacementWithHandoff).toHaveBeenCalledWith(expect.objectContaining({ placedBy: 'user-1' }), {
      requireOwnerId: 'user-1',
    });
  });

  it('#3 stamps placedBy from auth.uid even when the client tries to spoof another user', async () => {
    adminCreateRadarPlacementWithHandoff.mockResolvedValueOnce({
      placement: { id: 'placement-3' },
      graphHandoff: { committed: true, acknowledged: true, reconciliationRequired: false },
    });

    await POST(postRequest({ ...VALID_BODY, placedBy: 'victim-uid' }));

    expect(adminCreateRadarPlacementWithHandoff).toHaveBeenCalledWith(expect.objectContaining({ placedBy: 'user-1' }), {
      requireOwnerId: 'user-1',
    });
    // the spoofed value never reaches the admin primitive
    expect(adminCreateRadarPlacementWithHandoff.mock.calls[0][0].placedBy).not.toBe('victim-uid');
  });

  it('#3 maps an authorization failure to 403', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(new PlacementAuthorizationError('radar-1'));
    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('#4 returns a generic public message (never raw exception text) on an internal 500', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.5:9099 internal stack'));
    const res = await POST(postRequest(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.message).not.toContain('ECONNREFUSED');
    expect(json.message).toBe('Internal error while processing the placement');
  });

  it('surfaces committed-but-unacknowledged as success with reconciliationRequired, not a rollback', async () => {
    adminCreateRadarPlacementWithHandoff.mockResolvedValueOnce({
      placement: { id: 'placement-2', ...VALID_BODY },
      graphHandoff: { committed: true, acknowledged: false, reconciliationRequired: true },
    });

    const res = await POST(postRequest(VALID_BODY));
    const json = await res.json();

    // The Firestore write committed — the API must not claim failure/rollback.
    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('placement-2');
    expect(json.graphHandoff.committed).toBe(true);
    expect(json.graphHandoff.reconciliationRequired).toBe(true);
  });

  it('maps a pair-conflict commit error to 409 (GRAPH-066 occupied pair)', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Radar radar-1 already holds a different placement for technology tech-1 (pair conflict)')
    );

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(409);
  });

  it('maps an ambiguous-legacy migration halt to 409', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Radar radar-1 has multiple legacy placements for technology tech-1 (a, b); migration halted')
    );

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(409);
  });

  it('maps a missing-technology commit error to 400', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Cannot create placement: technology tech-1 does not exist')
    );

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(400);
  });

  it('maps an invalid-quadrant validation error to 400', async () => {
    adminCreateRadarPlacementWithHandoff.mockRejectedValueOnce(
      new Error('Quadrant not-a-quadrant is not configured on radar radar-1')
    );

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(400);
  });
});
