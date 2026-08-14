/**
 * @file route.test.ts
 * @description Unit tests for POST /api/reports/[id]/restore
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
  restoreReportVersion: jest.fn(),
}));

const { restoreReportVersion } = jest.requireMock('@/lib/reports');

import { POST } from '../route';

const restoredReport = {
  id: 'report-1',
  title: 'Test Report',
  html: '<html><body>Original</body></html>',
  previousHtml: '<html><body>Edited</body></html>',
  createdAt: '2026-02-26T00:00:00.000Z',
  updatedAt: '2026-06-09T00:00:00.000Z',
  createdBy: 'agent',
  agentType: 'creator',
  entityIds: ['tech-1'],
  metadata: {
    description: 'Test description',
    dataSnapshotAt: '2026-02-26T00:00:00.000Z',
  },
  shared: false,
};

function createPostRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/report-1/restore', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('POST /api/reports/[id]/restore', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createPostRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
    expect(restoreReportVersion).not.toHaveBeenCalled();
  });

  it('returns 404 when report not found', async () => {
    restoreReportVersion.mockRejectedValue(new Error('Report not found'));

    const res = await POST(createPostRequest(), {
      params: Promise.resolve({ id: 'nonexistent' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Report not found');
  });

  it('returns 409 when there is no previous version to restore', async () => {
    restoreReportVersion.mockRejectedValue(new Error('No previous version available'));

    const res = await POST(createPostRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe('No previous version available');
  });

  it('returns 200 and restores the legacy previous version (no body) attributed to the user', async () => {
    restoreReportVersion.mockResolvedValue(restoredReport);

    const res = await POST(createPostRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(restoredReport);
    // DISC-014: no versionId → legacy swap; savedBy is the authenticated user.
    expect(restoreReportVersion).toHaveBeenCalledWith('report-1', {
      versionId: undefined,
      savedBy: 'user:test-user-123',
      requireOwnerId: 'test-user-123',
    });
  });

  // DISC-014: point-in-time restore threads the requested versionId.
  it('restores a specific version when a versionId body is provided', async () => {
    restoreReportVersion.mockResolvedValue(restoredReport);

    const res = await POST(createPostRequest({ versionId: 'ver-abc' }), {
      params: Promise.resolve({ id: 'report-1' }),
    });

    expect(res.status).toBe(200);
    expect(restoreReportVersion).toHaveBeenCalledWith('report-1', {
      versionId: 'ver-abc',
      savedBy: 'user:test-user-123',
      requireOwnerId: 'test-user-123',
    });
  });

  it('returns 404 when the requested version does not resolve', async () => {
    restoreReportVersion.mockRejectedValue(new Error('Version not found'));

    const res = await POST(createPostRequest({ versionId: 'missing' }), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Version not found');
  });

  it('returns 400 when the body is present but the wrong shape', async () => {
    const res = await POST(createPostRequest({ versionId: 42 as unknown as string }), {
      params: Promise.resolve({ id: 'report-1' }),
    });

    expect(res.status).toBe(400);
    expect(restoreReportVersion).not.toHaveBeenCalled();
  });

  // DISC-014 regression: a truncated/invalid-JSON body must NOT be swallowed into
  // the no-body legacy-swap path (which would silently mutate the report and mask
  // the client error with a 200). It must surface a 400 and touch nothing.
  it('returns 400 when the body is present but is syntactically invalid JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/reports/report-1/restore', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{"versionId":"ver-9"', // missing closing brace
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'report-1' }) });

    expect(res.status).toBe(400);
    expect(restoreReportVersion).not.toHaveBeenCalled();
  });

  it('returns 500 on server error', async () => {
    restoreReportVersion.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await POST(createPostRequest(), {
      params: Promise.resolve({ id: 'report-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to restore report');
  });
});
