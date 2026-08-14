/**
 * @file versions/[versionId]/__tests__/route.test.ts
 * @description Unit tests for GET /api/reports/[id]/versions/[versionId] (DISC-014)
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest
    .fn()
    .mockResolvedValue({ authenticated: true, uid: 'test-user-123', email: 'test@example.com' }),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/reports/report-versions', () => ({
  getReportVersionOwnedBy: jest.fn(),
}));

const { getReportVersionOwnedBy } = jest.requireMock('@/lib/reports/report-versions');
import { GET } from '../route';

const version = {
  versionId: 'v-3',
  versionNumber: 3,
  html: '<h1>v3</h1>',
  htmlLength: 11,
  createdAt: '2026-07-14T03:00:00Z',
  savedBy: 'agent:creator',
  reason: 'edit',
};

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1/versions/v-3', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

const params = Promise.resolve({ id: 'report-1', versionId: 'v-3' });

describe('GET /api/reports/[id]/versions/[versionId]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
    expect(getReportVersionOwnedBy).not.toHaveBeenCalled();
  });

  it('returns 200 with the full version (including html) for preview', async () => {
    getReportVersionOwnedBy.mockResolvedValue(version);

    const res = await GET(req(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(version);
    expect(getReportVersionOwnedBy).toHaveBeenCalledWith('report-1', 'v-3', 'test-user-123');
  });

  it('returns 404 when the version does not exist', async () => {
    getReportVersionOwnedBy.mockResolvedValue(null);

    const res = await GET(req(), { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Version not found');
  });

  it('returns 500 on read failure', async () => {
    getReportVersionOwnedBy.mockRejectedValue(new Error('firestore down'));

    const res = await GET(req(), { params });
    expect(res.status).toBe(500);
  });
});
