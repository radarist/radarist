/**
 * @jest-environment node
 */

/**
 * @file capabilities route test
 * @description BUILD-027 — the capability probe reports the SAME
 * IMPULSE_BUILD_ENABLED state the dispatch route enforces, so the UI can show
 * the truth before dispatch.
 */

import { NextRequest } from 'next/server';

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockGetAuthenticatedUser(...a),
}));

import { GET } from '../route';

function req(): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/missions/capabilities'), {
    method: 'GET',
    headers: { Authorization: 'Bearer t' },
  });
}

const original = process.env.IMPULSE_BUILD_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
});
afterEach(() => {
  if (original === undefined) delete process.env.IMPULSE_BUILD_ENABLED;
  else process.env.IMPULSE_BUILD_ENABLED = original;
});

describe('GET /api/missions/capabilities (BUILD-027)', () => {
  it('reports buildEnabled: true when the flag is on', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buildEnabled: true });
  });

  it('reports buildEnabled: false when the flag is off', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'false';
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buildEnabled: false });
  });

  it('reports buildEnabled: false when the flag is unset', async () => {
    delete process.env.IMPULSE_BUILD_ENABLED;
    const res = await GET(req());
    expect(await res.json()).toEqual({ buildEnabled: false });
  });

  it('requires authentication', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'No token' });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});
