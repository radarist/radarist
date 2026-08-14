/**
 * @file route.test.ts
 * @description Unit tests for POST /api/companies/bulk-delete
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/companies-admin', () => ({
  adminDeleteCompaniesBulk: jest.fn(),
}));

const { adminDeleteCompaniesBulk: deleteCompanies } = jest.requireMock('@/lib/companies-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/companies/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/companies/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes companies and returns success with result counts', async () => {
    deleteCompanies.mockResolvedValue({ deleted: 2, failed: [], relationsDeleted: 3 });

    const res = await POST(createRequest({ ids: ['id1', 'id2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(2);
    expect(json.failed).toEqual([]);
    expect(json.relationsDeleted).toBe(3);
    expect(deleteCompanies).toHaveBeenCalledWith(['id1', 'id2']);
  });

  it('returns exact failed IDs and marks a partial result unsuccessful', async () => {
    deleteCompanies.mockResolvedValue({ deleted: 1, failed: ['id2'], relationsDeleted: 2 });

    const res = await POST(createRequest({ ids: ['id1', 'id2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: false, deleted: 1, failed: ['id2'], relationsDeleted: 2 });
  });

  it('returns 400 for empty ids array', async () => {
    const res = await POST(createRequest({ ids: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
  });

  it('returns 400 for duplicate ids', async () => {
    const res = await POST(createRequest({ ids: ['same', 'same'] }));
    expect(res.status).toBe(400);
    expect(deleteCompanies).not.toHaveBeenCalled();
  });

  it('returns 400 for missing ids field', async () => {
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

  it('returns 400 for non-array ids', async () => {
    const res = await POST(createRequest({ ids: 'not-an-array' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
  });

  it('returns 500 when deleteCompanies throws', async () => {
    deleteCompanies.mockRejectedValue(new Error('Firestore connection failed'));

    const res = await POST(createRequest({ ids: ['id1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete companies');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteCompanies.mockRejectedValue('string error');

    const res = await POST(createRequest({ ids: ['id1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete companies');
  });

  it('handles single id deletion', async () => {
    deleteCompanies.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });

    const res = await POST(createRequest({ ids: ['single-id'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deleted).toBe(1);
    expect(deleteCompanies).toHaveBeenCalledWith(['single-id']);
  });
});
