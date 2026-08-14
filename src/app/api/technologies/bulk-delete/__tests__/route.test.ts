/**
 * @file route.test.ts
 * @description Unit tests for POST /api/technologies/bulk-delete
 *
 * Accepts decoupled-format IDs only ("tech-xxx"); legacy "radarId:techId"
 * was removed in D4.2.
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

jest.mock('@/lib/technology-admin', () => ({
  adminDeleteTechnologiesCompletely: jest.fn(),
}));

const { adminDeleteTechnologiesCompletely: deleteTechnologiesCompletely } = jest.requireMock('@/lib/technology-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/technologies/bulk-delete', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/technologies/bulk-delete', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes new-format technologies via deleteTechnologiesCompletely', async () => {
    deleteTechnologiesCompletely.mockResolvedValue({
      succeeded: 2,
      failed: [],
      errors: [],
      totalRelationsDeleted: 3,
      totalPlacementsDeleted: 1,
    });

    const res = await POST(createRequest({ ids: ['tech-abc', 'tech-def'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(2);
    expect(json.failed).toEqual([]);
    expect(json.relationsDeleted).toBe(3);
    expect(json.placementsDeleted).toBe(1);
    expect(deleteTechnologiesCompletely).toHaveBeenCalledWith(['tech-abc', 'tech-def']);
  });

  it('rejects legacy composite IDs with 400', async () => {
    const res = await POST(createRequest({ ids: ['company-wide:42'] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(deleteTechnologiesCompletely).not.toHaveBeenCalled();
  });

  it('rejects mixed format IDs with 400 (any non-tech-xxx ID fails validation)', async () => {
    const res = await POST(createRequest({ ids: ['tech-new-one', 'legacy:old-one'] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(deleteTechnologiesCompletely).not.toHaveBeenCalled();
  });

  it('reports failures from the deletion service', async () => {
    deleteTechnologiesCompletely.mockResolvedValue({
      succeeded: 0,
      failed: ['tech-broken'],
      errors: ['tech-broken: reference cleanup failed'],
      totalRelationsDeleted: 0,
      totalPlacementsDeleted: 0,
    });

    const res = await POST(createRequest({ ids: ['tech-broken'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.failed).toEqual(['tech-broken']);
    expect(json.error).toBe('Some technologies could not be deleted');
    expect(json).not.toHaveProperty('errors');
  });

  it('returns 400 for empty ids array', async () => {
    const res = await POST(createRequest({ ids: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
  });

  it('returns 400 for missing ids field', async () => {
    const res = await POST(createRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for ids containing empty strings', async () => {
    const res = await POST(createRequest({ ids: [''] }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when service throws', async () => {
    deleteTechnologiesCompletely.mockRejectedValue(new Error('DB error'));

    const res = await POST(createRequest({ ids: ['tech-fail'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete technologies');
    expect(json.error).not.toContain('DB error');
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    deleteTechnologiesCompletely.mockRejectedValue('kaboom');

    const res = await POST(createRequest({ ids: ['tech-fail'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to delete technologies');
  });
});
