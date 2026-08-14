/**
 * @jest-environment node
 *
 * P-A4 — the GET list route the Assessments sidebar badge polls
 * (`/api/triage/assessments?status=pending`). Pins the auth contract: 401 when
 * the request carries no/invalid Authorization (getAuthenticatedUser rejects),
 * 200 with the authenticated session the app actually sends via fetchWithAuth.
 */
export {};

const mockGetAuth = jest.fn();
const mockGetProposedAssessments = jest.fn();

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: (...a: unknown[]) => mockGetAuth(...a) }));
jest.mock('@/lib/proposed-assessments-admin', () => ({
  getProposedAssessments: (...a: unknown[]) => mockGetProposedAssessments(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { NextRequest } from 'next/server';
const { GET } = require('../route');

describe('GET /api/triage/assessments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({ authenticated: true, uid: 'u1', email: 'test@test.com' });
    mockGetProposedAssessments.mockResolvedValue([{ id: 'pa-1', status: 'pending' }]);
  });

  it('401s when the request carries no/invalid Authorization and does not touch the store', async () => {
    mockGetAuth.mockResolvedValue({ authenticated: false, error: 'No authorization header provided' });

    const request = new NextRequest('http://localhost/api/triage/assessments?status=pending');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('No authorization header provided');
    expect(mockGetProposedAssessments).not.toHaveBeenCalled();
  });

  it('200s with the authenticated session the app sends and lists pending assessments', async () => {
    const request = new NextRequest('http://localhost/api/triage/assessments?status=pending', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.assessments).toEqual([{ id: 'pa-1', status: 'pending' }]);
    expect(mockGetAuth).toHaveBeenCalledWith(request);
    expect(mockGetProposedAssessments).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('omits the status filter when the query param is absent', async () => {
    const request = new NextRequest('http://localhost/api/triage/assessments', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockGetProposedAssessments).toHaveBeenCalledWith(undefined);
  });

  it('500s when the store read fails', async () => {
    mockGetProposedAssessments.mockRejectedValue(new Error('firestore down'));

    const request = new NextRequest('http://localhost/api/triage/assessments?status=pending', {
      headers: { Authorization: 'Bearer valid-firebase-id-token' },
    });
    const response = await GET(request);

    expect(response.status).toBe(500);
  });
});
