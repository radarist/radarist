/**
 * @file route.test.ts
 * @description Unit tests for POST /api/signals/bulk-delete
 *
 * Note: signals bulk-delete returns { deleted, failed } without relationsDeleted
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

jest.mock('@/lib/signals-admin', () => ({
  adminDeleteSignals: jest.fn(),
}));

const { adminDeleteSignals: deleteSignals } = jest.requireMock('@/lib/signals-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/signals/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/signals/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns exact failed IDs and marks a partial result unsuccessful', async () => {
    deleteSignals.mockResolvedValue({ deleted: 3, failed: ['sig4'], relationsDeleted: 2 });

    const res = await POST(createRequest({ ids: ['sig1', 'sig2', 'sig3', 'sig4'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.deleted).toBe(3);
    expect(json.failed).toEqual(['sig4']);
    expect(json).not.toHaveProperty('relationsDeleted');
    expect(deleteSignals).toHaveBeenCalledWith(['sig1', 'sig2', 'sig3', 'sig4']);
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
    expect(deleteSignals).not.toHaveBeenCalled();
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
    const res = await POST(createRequest({ ids: 123 }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when deleteSignals throws', async () => {
    deleteSignals.mockRejectedValue(new Error('Batch write failed'));

    const res = await POST(createRequest({ ids: ['sig1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete signals');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteSignals.mockRejectedValue(null);

    const res = await POST(createRequest({ ids: ['sig1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete signals');
  });

  it('handles single id deletion', async () => {
    deleteSignals.mockResolvedValue({ deleted: 1, failed: [], relationsDeleted: 0 });

    const res = await POST(createRequest({ ids: ['only-one'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(1);
  });
});
