/**
 * @file route.test.ts
 * @description Unit tests for POST /api/signals/archive (DISC-010).
 *
 * Locks the auth gate, the archive/restore dispatch, the `{ changed, failed }`
 * response shape, and the Zod validation for the two-directional body.
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/signals-admin', () => ({
  adminArchiveSignals: jest.fn(),
  adminRestoreSignals: jest.fn(),
}));

const { adminArchiveSignals, adminRestoreSignals } = jest.requireMock('@/lib/signals-admin');
const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/signals/archive', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/signals/archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
  });

  it('archives via adminArchiveSignals and returns { changed, failed }', async () => {
    adminArchiveSignals.mockResolvedValue({ archived: 2, failed: ['bad'] });

    const res = await POST(createRequest({ ids: ['s1', 's2', 'bad'], action: 'archive', reason: 'cleanup' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, changed: 2, failed: ['bad'] });
    expect(adminArchiveSignals).toHaveBeenCalledWith(['s1', 's2', 'bad'], 'cleanup');
    expect(adminRestoreSignals).not.toHaveBeenCalled();
  });

  it('restores via adminRestoreSignals when action is restore', async () => {
    adminRestoreSignals.mockResolvedValue({ restored: 1, failed: [] });

    const res = await POST(createRequest({ ids: ['s1'], action: 'restore' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, changed: 1, failed: [] });
    expect(adminRestoreSignals).toHaveBeenCalledWith(['s1']);
    expect(adminArchiveSignals).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });

    const res = await POST(createRequest({ ids: ['s1'], action: 'archive' }));
    expect(res.status).toBe(401);
    expect(adminArchiveSignals).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown action', async () => {
    const res = await POST(createRequest({ ids: ['s1'], action: 'nuke' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty ids array', async () => {
    const res = await POST(createRequest({ ids: [], action: 'archive' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing action', async () => {
    const res = await POST(createRequest({ ids: ['s1'] }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when the admin helper throws', async () => {
    adminArchiveSignals.mockRejectedValue(new Error('firestore down'));

    const res = await POST(createRequest({ ids: ['s1'], action: 'archive' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain('firestore down');
  });
});
