/**
 * @file route.test.ts
 * @description UX-062 — pins the owner-profile read endpoint contract.
 *
 * The endpoint is owner-scoped and read-only: it derives the uid solely from
 * the verified Firebase ID token, never accepts a client-supplied uid, returns
 * the canonical `users/{uid}` profile (or null when none exists for a fresh
 * signup), and surfaces a Firestore failure as a hard 500 rather than an
 * empty-looking profile.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/firebase', () => ({
  __esModule: true,
  db: {},
  auth: {},
}));

jest.mock('@/lib/user-profile', () => ({
  __esModule: true,
  getOwnerProfile: jest.fn(),
}));

const mockAuth = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockAuth(...args),
}));

import { GET } from '../route';
import { getOwnerProfile } from '@/lib/user-profile';

const mockGetOwnerProfile = getOwnerProfile as jest.MockedFunction<typeof getOwnerProfile>;

function authedRequest(): NextRequest {
  // The owner uid comes ONLY from the verified token. A client may append a
  // ?uid= param; the route must ignore it.
  return new NextRequest('http://localhost:3000/api/user/profile?uid=someone-else', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

describe('GET /api/user/profile (UX-062)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ authenticated: true, uid: 'auth-uid-123', email: 'real@example.com' });
  });

  it('rejects an unauthenticated request with 401', async () => {
    mockAuth.mockResolvedValue({ authenticated: false, error: 'No token' });

    const res = await GET(authedRequest());
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe('No token');
    expect(mockGetOwnerProfile).not.toHaveBeenCalled();
  });

  it('reads the profile for the verified uid — never a client-supplied uid', async () => {
    mockGetOwnerProfile.mockResolvedValue({
      uid: 'auth-uid-123',
      displayName: 'Real Name',
      email: 'real@example.com',
      photoURL: null,
    });

    const res = await GET(authedRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    // The owner uid comes from the token, NOT the ?uid= query param.
    expect(mockGetOwnerProfile).toHaveBeenCalledWith('auth-uid-123');
    expect(data.profile).toEqual({
      uid: 'auth-uid-123',
      displayName: 'Real Name',
      email: 'real@example.com',
      photoURL: null,
    });
  });

  it('returns profile: null when no owner doc exists (fresh signup)', async () => {
    mockGetOwnerProfile.mockResolvedValue(null);

    const res = await GET(authedRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.profile).toBeNull();
  });

  it('returns a 500 (not a silent null) when the Firestore read fails', async () => {
    mockGetOwnerProfile.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(authedRequest());
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toBe('Failed to read profile');
  });
});
