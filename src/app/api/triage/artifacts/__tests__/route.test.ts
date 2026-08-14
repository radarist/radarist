/**
 * @jest-environment node
 *
 * P-A4 — the GET list route the Assessments sidebar badge polls
 * (`/api/triage/artifacts?status=pending`). Pins the auth contract: 401 when
 * the request carries no/invalid Authorization (getAuthenticatedUser rejects),
 * 200 with the authenticated session the app actually sends via fetchWithAuth.
 */
export {};

const mockGetAuth = jest.fn();
const mockGetProposedArtifacts = jest.fn();

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: (...a: unknown[]) => mockGetAuth(...a) }));
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  getProposedArtifacts: (...a: unknown[]) => mockGetProposedArtifacts(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { NextRequest } from 'next/server';
const { GET } = require('../route');

describe('GET /api/triage/artifacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({ authenticated: true, uid: 'u1', email: 'test@test.com' });
    mockGetProposedArtifacts.mockResolvedValue([{ id: 'pr-1', status: 'pending' }]);
  });

  it('401s when the request carries no/invalid Authorization and does not touch the store', async () => {
    mockGetAuth.mockResolvedValue({ authenticated: false, error: 'No authorization header provided' });

    const request = new NextRequest('http://localhost/api/triage/artifacts?status=pending');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('No authorization header provided');
    expect(mockGetProposedArtifacts).not.toHaveBeenCalled();
  });

  it('200s with the authenticated session the app sends and lists pending recommendations', async () => {
    const request = new NextRequest('http://localhost/api/triage/artifacts?status=pending', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.artifacts).toEqual([{ id: 'pr-1', status: 'pending' }]);
    expect(mockGetAuth).toHaveBeenCalledWith(request);
    expect(mockGetProposedArtifacts).toHaveBeenCalledWith('u1', { status: 'pending' });
  });

  it('defaults the status filter to pending when the query param is absent', async () => {
    const request = new NextRequest('http://localhost/api/triage/artifacts', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockGetProposedArtifacts).toHaveBeenCalledWith('u1', { status: 'pending' });
  });

  it('500s when the store read fails', async () => {
    mockGetProposedArtifacts.mockRejectedValue(new Error('firestore down'));

    const request = new NextRequest('http://localhost/api/triage/artifacts?status=pending', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);

    expect(response.status).toBe(500);
  });
});
