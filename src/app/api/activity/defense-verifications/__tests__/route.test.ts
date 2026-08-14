/**
 * @file src/app/api/activity/defense-verifications/__tests__/route.test.ts
 * @description Unit tests for the Defense Verifications activity route.
 *
 * Verifies the authorization contract: any authenticated user may read the
 * global system verification JobRun stream; unauthenticated requests are
 * rejected. Defense verification jobs are intentionally system-scoped
 * (`user:system`) because the Inngest producer functions record accounting
 * artifacts under that principal. The route hard-codes the accounting owner
 * so callers cannot substitute another tenant.
 *
 * @jest-environment node
 */

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
}));

jest.mock('@/lib/activity/defense-verification-join', () => ({
  listDefenseVerifications: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from '../route';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { listDefenseVerifications } from '@/lib/activity/defense-verification-join';

const mockedGetAuthenticatedUser = getAuthenticatedUser as jest.Mock;
const mockedListDefenseVerifications = listDefenseVerifications as jest.Mock;

function request(url: string): NextRequest {
  return new NextRequest(`http://localhost:9002${url}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/activity/defense-verifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetAuthenticatedUser.mockReset();
    mockedListDefenseVerifications.mockReset();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      authenticated: false,
      error: 'Unauthorized',
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(listDefenseVerifications).not.toHaveBeenCalled();
  });

  it('returns the global verification stream for any authenticated operator', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'operator-1',
      email: 'operator-1@test.local',
    });
    mockedListDefenseVerifications.mockResolvedValue({
      verifications: [{ id: 'global-run' }],
      nextCursor: null,
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications).toEqual([{ id: 'global-run' }]);
    expect(listDefenseVerifications).toHaveBeenCalledWith(
      expect.objectContaining({
        accountingOwner: 'user:system',
        kind: undefined,
        status: undefined,
      })
    );
  });

  it('exposes the same global stream to a foreign authenticated user', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'foreigner',
      email: 'foreigner@test.local',
    });
    mockedListDefenseVerifications.mockResolvedValue({
      verifications: [{ id: 'global-run' }],
      nextCursor: null,
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications.some((v: { id: string }) => v.id === 'global-run')).toBe(true);
  });

  it('rejects invalid query parameters with 400', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'operator-1',
      email: 'operator-1@test.local',
    });

    const res = await GET(request('/api/activity/defense-verifications?kind=invalid&limit=5'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid query parameters');
  });
});
