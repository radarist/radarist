/**
 * @file versions/__tests__/route.test.ts
 * @description Unit tests for GET /api/reports/[id]/versions (DISC-014)
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
  listReportVersionsOwnedBy: jest.fn(),
}));

const { listReportVersionsOwnedBy } = jest.requireMock('@/lib/reports/report-versions');
import { GET } from '../route';

const versions = [
  { versionId: 'v-2', versionNumber: 2, createdAt: '2026-07-14T02:00:00Z', savedBy: 'user:u1', htmlLength: 1200, reason: 'edit' },
  { versionId: 'v-1', versionNumber: 1, createdAt: '2026-07-14T01:00:00Z', savedBy: 'unknown', htmlLength: 900 },
];

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1/versions', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/reports/[id]/versions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const res = await GET(req(), { params: Promise.resolve({ id: 'report-1' }) });
    expect(res.status).toBe(401);
    expect(listReportVersionsOwnedBy).not.toHaveBeenCalled();
  });

  it('returns 200 with the newest-first version summaries (no html bodies)', async () => {
    listReportVersionsOwnedBy.mockResolvedValue(versions);

    const res = await GET(req(), { params: Promise.resolve({ id: 'report-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.versions).toEqual(versions);
    expect(listReportVersionsOwnedBy).toHaveBeenCalledWith('report-1', 'test-user-123');
    // The list payload must never carry html bodies.
    for (const v of json.versions) expect(v).not.toHaveProperty('html');
  });

  it('returns 500 when the history read fails (never a falsely-empty list)', async () => {
    listReportVersionsOwnedBy.mockRejectedValue(new Error('firestore down'));

    const res = await GET(req(), { params: Promise.resolve({ id: 'report-1' }) });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to list report versions');
  });
});

// ============================================================================
// SEC-009 — owner denial maps to 404, not 500
// ============================================================================

describe('GET /api/reports/[id]/versions — owner denial (SEC-009)', () => {
  it('returns 404 when the parent report is absent, foreign, or ownerless', async () => {
    // The boundary throws one indistinguishable error for all three cases.
    listReportVersionsOwnedBy.mockRejectedValue(new Error('Report not found'));

    const res = await GET(req(), { params: Promise.resolve({ id: 'report-1' }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Report not found');
  });
});
