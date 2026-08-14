/**
 * @file route.test.ts
 * @description Unit tests for POST /api/use-cases/bulk-delete
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

jest.mock('@/lib/use-cases-admin', () => ({
  adminDeleteUseCases: jest.fn(),
}));

const { adminDeleteUseCases: deleteUseCases } = jest.requireMock('@/lib/use-cases-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/use-cases/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/use-cases/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes use cases and returns success with result counts', async () => {
    deleteUseCases.mockResolvedValue({ deleted: 2, failed: [], relationsDeleted: 1 });

    const res = await POST(createRequest({ ids: ['uc1', 'uc2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(2);
    expect(json.failed).toEqual([]);
    expect(json.relationsDeleted).toBe(1);
    expect(deleteUseCases).toHaveBeenCalledWith(['uc1', 'uc2']);
  });

  it('returns exact failed IDs and marks a partial result unsuccessful', async () => {
    deleteUseCases.mockResolvedValue({ deleted: 1, failed: ['uc2'], relationsDeleted: 1 });

    const res = await POST(createRequest({ ids: ['uc1', 'uc2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: false, deleted: 1, failed: ['uc2'], relationsDeleted: 1 });
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
    expect(deleteUseCases).not.toHaveBeenCalled();
  });

  it('returns 400 for missing ids field', async () => {
    const res = await POST(createRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for ids containing empty strings', async () => {
    const res = await POST(createRequest({ ids: [''] }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-array ids', async () => {
    const res = await POST(createRequest({ ids: true }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when deleteUseCases throws', async () => {
    deleteUseCases.mockRejectedValue(new Error('Transaction aborted'));

    const res = await POST(createRequest({ ids: ['uc1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete use cases');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteUseCases.mockRejectedValue({ code: 'UNKNOWN' });

    const res = await POST(createRequest({ ids: ['uc1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete use cases');
  });

  it('handles single id deletion', async () => {
    deleteUseCases.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });

    const res = await POST(createRequest({ ids: ['only-one'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deleted).toBe(1);
  });
});
