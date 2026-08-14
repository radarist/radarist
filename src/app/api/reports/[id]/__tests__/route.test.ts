/**
 * @file route.test.ts
 * @description Unit tests for GET/PUT/DELETE /api/reports/[id]
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/reports', () => ({
  getReportOwnedBy: jest.fn(),
  updateReport: jest.fn(),
  deleteReport: jest.fn(),
  reportsBelongToOwner: jest.fn().mockResolvedValue(true),
}));

const { getReportOwnedBy, updateReport, deleteReport, reportsBelongToOwner } = jest.requireMock('@/lib/reports');

import { GET, PUT, DELETE } from '../route';

const mockReport = {
  id: 'report-1',
  title: 'Test Report',
  html: '<html><body>Content</body></html>',
  createdAt: '2026-02-26T00:00:00.000Z',
  createdBy: 'agent',
  agentType: 'creator',
  entityIds: ['tech-1'],
  metadata: {
    description: 'Test description',
    dataSnapshotAt: '2026-02-26T00:00:00.000Z',
  },
  shared: false,
};

function createGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createPutRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
  });
}

function createDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ============================================================================
// GET /api/reports/[id]
// ============================================================================

describe('GET /api/reports/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createGetRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns the same 404 for an absent, foreign, or ownerless report (service returns null)', async () => {
    getReportOwnedBy.mockResolvedValue(null);

    const res = await GET(createGetRequest(), {
      params: Promise.resolve({ id: 'nonexistent' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Report not found');
  });

  it('returns 200 with the report for its owner (scoped read)', async () => {
    getReportOwnedBy.mockResolvedValue(mockReport);

    const res = await GET(createGetRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(mockReport);
    // SEC-009: the read is owner-scoped with the authenticated uid.
    expect(getReportOwnedBy).toHaveBeenCalledWith('report-1', 'test-user-123');
  });

  it('returns 500 on server error', async () => {
    getReportOwnedBy.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createGetRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to get report');
  });
});

// ============================================================================
// PUT /api/reports/[id]
// ============================================================================

describe('PUT /api/reports/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await PUT(createPutRequest({ title: 'Updated' }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 for invalid input (empty title)', async () => {
    const res = await PUT(createPutRequest({ title: '' }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid input');
    expect(json.details).toBeDefined();
  });

  it('returns the same 404 when the report is absent, foreign, or ownerless', async () => {
    // The service throws one indistinguishable error for all three cases.
    updateReport.mockRejectedValue(new Error('Report not found'));

    const res = await PUT(createPutRequest({ title: 'Updated Title' }), {
      params: Promise.resolve({ id: 'nonexistent' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Report not found');
  });

  it('returns 200 with updated report on success', async () => {
    const updatedReport = { ...mockReport, title: 'Updated Title', updatedAt: '2026-02-26T12:00:00.000Z' };
    updateReport.mockResolvedValue(updatedReport);

    const res = await PUT(createPutRequest({ title: 'Updated Title' }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.title).toBe('Updated Title');
    // DISC-014: the edit is attributed to the authenticated user for version
    // history. SEC-009: ownership is enforced inside the update transaction.
    expect(updateReport).toHaveBeenCalledWith(
      'report-1',
      { title: 'Updated Title' },
      { savedBy: 'user:test-user-123', requireOwnerId: 'test-user-123' }
    );
  });

  it('returns 500 on server error', async () => {
    updateReport.mockRejectedValue(new Error('Firestore write failed'));

    const res = await PUT(createPutRequest({ shared: true }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to update report');
  });
});

// ============================================================================
// DELETE /api/reports/[id]
// ============================================================================

describe('DELETE /api/reports/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await DELETE(createDeleteRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 204 on successful delete', async () => {
    deleteReport.mockResolvedValue(undefined);

    const res = await DELETE(createDeleteRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });

    expect(res.status).toBe(204);
    expect(reportsBelongToOwner).toHaveBeenCalledWith(['report-1'], 'test-user-123');
    expect(deleteReport).toHaveBeenCalledWith('report-1');
  });

  it('returns the same 404 for a missing or non-owned report without deleting', async () => {
    reportsBelongToOwner.mockResolvedValueOnce(false);

    const res = await DELETE(createDeleteRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Report not found');
    expect(reportsBelongToOwner).toHaveBeenCalledWith(['report-1'], 'test-user-123');
    expect(deleteReport).not.toHaveBeenCalled();
  });

  it('returns 500 on Firestore error', async () => {
    deleteReport.mockRejectedValue(new Error('Firestore delete failed'));

    const res = await DELETE(createDeleteRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete report');
  });
});

// ============================================================================
// REPORT-002 — share gate mapping
// ============================================================================

describe('PUT /api/reports/[id] — share gate (REPORT-002)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 409 when sharing is refused for a needs-review draft', async () => {
    updateReport.mockRejectedValue(new Error('Report is pending review and cannot be shared'));

    const res = await PUT(createPutRequest({ shared: true }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe('Report is pending review and cannot be shared');
  });
});
