/**
 * @file route.test.ts
 * @description Unit tests for POST /api/strategies/bulk-delete
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

jest.mock('@/lib/strategies-admin', () => ({
  adminDeleteStrategies: jest.fn(),
}));

const { adminDeleteStrategies: deleteStrategies } = jest.requireMock('@/lib/strategies-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/strategies/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/strategies/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes strategies and returns success with result counts', async () => {
    deleteStrategies.mockResolvedValue({ deleted: 3, failed: [], relationsDeleted: 5 });

    const res = await POST(createRequest({ ids: ['s1', 's2', 's3'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(3);
    expect(json.failed).toEqual([]);
    expect(json.relationsDeleted).toBe(5);
    expect(deleteStrategies).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });

  it('returns exact failed IDs and marks a partial result unsuccessful', async () => {
    deleteStrategies.mockResolvedValue({ deleted: 1, failed: ['s2'], relationsDeleted: 2 });

    const res = await POST(createRequest({ ids: ['s1', 's2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: false, deleted: 1, failed: ['s2'], relationsDeleted: 2 });
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
    expect(deleteStrategies).not.toHaveBeenCalled();
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
    const res = await POST(createRequest({ ids: 'not-an-array' }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when deleteStrategies throws', async () => {
    deleteStrategies.mockRejectedValue(new Error('Permission denied'));

    const res = await POST(createRequest({ ids: ['s1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete strategies');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteStrategies.mockRejectedValue(42);

    const res = await POST(createRequest({ ids: ['s1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete strategies');
  });

  it('handles single id deletion', async () => {
    deleteStrategies.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });

    const res = await POST(createRequest({ ids: ['only-one'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deleted).toBe(1);
  });
});
