/**
 * @file route.test.ts
 * @description Unit tests for POST /api/prototypes/bulk-delete
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

jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

jest.mock('@/lib/prototypes-admin', () => ({
  adminDeletePrototypes: jest.fn(),
}));

const { adminDeletePrototypes: deletePrototypes } = jest.requireMock('@/lib/prototypes-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prototypes/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/prototypes/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes prototypes and returns success with result counts', async () => {
    deletePrototypes.mockResolvedValue({ deleted: 2, failed: [], relationsDeleted: 4 });

    const res = await POST(createRequest({ ids: ['p1', 'p2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(2);
    expect(json.failed).toEqual([]);
    expect(json.relationsDeleted).toBe(4);
    expect(deletePrototypes).toHaveBeenCalledWith(['p1', 'p2']);
  });

  it('returns exact failed IDs and marks a partial result unsuccessful', async () => {
    deletePrototypes.mockResolvedValue({ deleted: 1, failed: ['p2'], relationsDeleted: 1 });

    const res = await POST(createRequest({ ids: ['p1', 'p2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: false, deleted: 1, failed: ['p2'], relationsDeleted: 1 });
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
    expect(deletePrototypes).not.toHaveBeenCalled();
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
    const res = await POST(createRequest({ ids: { id: '1' } }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when deletePrototypes throws', async () => {
    deletePrototypes.mockRejectedValue(new Error('Cascade cleanup failed'));

    const res = await POST(createRequest({ ids: ['p1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete prototypes');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deletePrototypes.mockRejectedValue(undefined);

    const res = await POST(createRequest({ ids: ['p1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete prototypes');
  });

  it('handles single id deletion', async () => {
    deletePrototypes.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });

    const res = await POST(createRequest({ ids: ['single'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deleted).toBe(1);
  });
});
