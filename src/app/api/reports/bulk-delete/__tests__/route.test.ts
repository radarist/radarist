/**
 * @file route.test.ts
 * @description Unit tests for POST /api/reports/bulk-delete
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
  deleteReports: jest.fn(),
  reportsBelongToOwner: jest.fn().mockResolvedValue(true),
}));

const { deleteReports, reportsBelongToOwner } = jest.requireMock('@/lib/reports');

import { POST } from '../route';

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/reports/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createRequest({ ids: ['report-1'] }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 for empty ids array', async () => {
    const res = await POST(createRequest({ ids: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
  });

  it('returns 400 for missing ids', async () => {
    const res = await POST(createRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
  });

  it('returns 400 for ids containing empty strings', async () => {
    const res = await POST(createRequest({ ids: [''] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
  });

  it('returns 200 with deleted count on success', async () => {
    deleteReports.mockResolvedValue(undefined);

    const res = await POST(createRequest({ ids: ['report-1', 'report-2', 'report-3'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(3);
    expect(reportsBelongToOwner).toHaveBeenCalledWith(
      ['report-1', 'report-2', 'report-3'],
      'test-user-123'
    );
    expect(deleteReports).toHaveBeenCalledWith(['report-1', 'report-2', 'report-3']);
  });

  it('authorizes the full batch before deleting and fails closed for a mixed-owner set', async () => {
    reportsBelongToOwner.mockResolvedValueOnce(false);
    const ids = ['owned-report', 'missing-or-other-user-report'];

    const res = await POST(createRequest({ ids }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('One or more reports not found');
    expect(reportsBelongToOwner).toHaveBeenCalledWith(ids, 'test-user-123');
    expect(deleteReports).not.toHaveBeenCalled();
  });

  it('handles single id deletion', async () => {
    deleteReports.mockResolvedValue(undefined);

    const res = await POST(createRequest({ ids: ['single-report'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(1);
    expect(deleteReports).toHaveBeenCalledWith(['single-report']);
  });

  it('deduplicates report ids before authorization and deletion', async () => {
    deleteReports.mockResolvedValue(undefined);

    const res = await POST(createRequest({ ids: ['report-1', 'report-1', 'report-2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deleted).toBe(2);
    expect(reportsBelongToOwner).toHaveBeenCalledWith(['report-1', 'report-2'], 'test-user-123');
    expect(deleteReports).toHaveBeenCalledWith(['report-1', 'report-2']);
  });

  it('returns 500 on Firestore error', async () => {
    deleteReports.mockRejectedValue(new Error('Firestore connection failed'));

    const res = await POST(createRequest({ ids: ['report-1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain('Failed to delete reports');
    expect(json.error).toContain('Firestore connection failed');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteReports.mockRejectedValue('string error');

    const res = await POST(createRequest({ ids: ['report-1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain('Unknown error');
  });
});
