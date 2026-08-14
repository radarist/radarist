/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';
import { CORRELATION_ID_HEADER } from '@/lib/observability/correlation';

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock relations admin service (route migrated to admin SDK helpers)
jest.mock('@/lib/relations-admin', () => ({
  adminGetRelationById: jest.fn(),
  adminUpdateRelation: jest.fn(),
  adminDeleteRelation: jest.fn(),
}));

// Mock Inngest client for sync event
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue(undefined) },
}));

const {
  adminGetRelationById: getRelationById,
  adminUpdateRelation: updateRelation,
  adminDeleteRelation: deleteRelation,
} = jest.requireMock('@/lib/relations-admin');

import { GET, PUT, DELETE } from '../route';

const mockRelation = {
  id: 'rel-123',
  relationType: 'uses',
  sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
  targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
  confidence: 90,
  createdAt: 1700000000000,
};

function createMockGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/relations/rel-123', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createMockPutRequest(
  body: Record<string, unknown>,
  correlationId = TEST_CORRELATION_ID
): NextRequest {
  return new NextRequest('http://localhost:3000/api/relations/rel-123', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      [CORRELATION_ID_HEADER]: correlationId,
    },
    body: JSON.stringify(body),
  });
}

function createMockDeleteRequest(correlationId = TEST_CORRELATION_ID): NextRequest {
  return new NextRequest('http://localhost:3000/api/relations/rel-123', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token', [CORRELATION_ID_HEADER]: correlationId },
  });
}

function mockParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ============================================================================
// GET /api/relations/[id]
// ============================================================================

describe('GET /api/relations/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockGetRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns relation by ID', async () => {
    getRelationById.mockResolvedValue(mockRelation);

    const res = await GET(createMockGetRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('rel-123');
    expect(getRelationById).toHaveBeenCalledWith('rel-123');
  });

  it('returns 404 when relation is not found', async () => {
    getRelationById.mockResolvedValue(null);

    const res = await GET(createMockGetRequest(), mockParams('nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Relation not found');
  });

  it('returns 500 on server error', async () => {
    getRelationById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockGetRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to retrieve relation');
  });
});

// ============================================================================
// PUT /api/relations/[id]
// ============================================================================

describe('PUT /api/relations/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await PUT(createMockPutRequest({ confidence: 95 }), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('updates relation successfully', async () => {
    const updatedRelation = { ...mockRelation, confidence: 95 };
    updateRelation.mockResolvedValue(updatedRelation);

    const res = await PUT(createMockPutRequest({ confidence: 95 }), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.confidence).toBe(95);
    expect(updateRelation).toHaveBeenCalledWith(
      'rel-123',
      { confidence: 95 },
      { correlationId: TEST_CORRELATION_ID }
    );
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });

  it('delegates update sync ownership to the admin service without a duplicate route event', async () => {
    const updatedRelation = { ...mockRelation, confidence: 95 };
    updateRelation.mockResolvedValue(updatedRelation);
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    await PUT(createMockPutRequest({ confidence: 95 }), mockParams('rel-123'));

    expect(updateRelation).toHaveBeenCalledTimes(1);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('returns 400 when no updates provided', async () => {
    const res = await PUT(createMockPutRequest({}), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('No updates provided');
  });

  it('rejects a malformed update correlation ID before reading the body', async () => {
    const request = createMockPutRequest({ confidence: 95 }, 'notes from a customer');
    const jsonSpy = jest.spyOn(request, 'json');

    const res = await PUT(request, mockParams('rel-123'));

    expect(res.status).toBe(400);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(updateRelation).not.toHaveBeenCalled();
  });

  it('returns 400 for a noncanonical relationType before writing', async () => {
    const res = await PUT(createMockPutRequest({ relationType: 'built_by' }), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid relationType');
    expect(updateRelation).not.toHaveBeenCalled();
  });

  it.each([
    ['id', { id: 'overwritten' }],
    ['createdAt', { createdAt: 0 }],
    ['claimId', { claimId: 'caller-controlled' }],
    ['confidence', { confidence: 101 }],
    ['sourceSnapshot', { sourceSnapshot: { type: 'made-up', id: 'x', name: 'X', snapshotAt: 1 } }],
  ])('returns 400 for invalid or system-owned %s updates', async (_field, updates) => {
    const res = await PUT(createMockPutRequest(updates), mockParams('rel-123'));

    expect(res.status).toBe(400);
    expect(updateRelation).not.toHaveBeenCalled();
  });

  it('returns 404 when relation not found', async () => {
    updateRelation.mockResolvedValue(null);

    const res = await PUT(createMockPutRequest({ confidence: 95 }), mockParams('nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Relation not found');
  });

  it('returns 500 on server error', async () => {
    updateRelation.mockRejectedValue(new Error('Firestore write failed'));

    const res = await PUT(createMockPutRequest({ confidence: 95 }), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to update relation');
  });
});

// ============================================================================
// DELETE /api/relations/[id]
// ============================================================================

describe('DELETE /api/relations/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await DELETE(createMockDeleteRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('deletes relation successfully', async () => {
    deleteRelation.mockResolvedValue(undefined);

    const res = await DELETE(createMockDeleteRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toBe('Relation deleted successfully');
    expect(deleteRelation).toHaveBeenCalledWith('rel-123', {
      correlationId: TEST_CORRELATION_ID,
    });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });

  it('delegates delete sync ownership to the admin service without a duplicate route event', async () => {
    deleteRelation.mockResolvedValue(undefined);
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    await DELETE(createMockDeleteRequest(), mockParams('rel-123'));

    expect(deleteRelation).toHaveBeenCalledTimes(1);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('rejects a malformed delete correlation ID before deleting', async () => {
    const res = await DELETE(createMockDeleteRequest('corr_not-a-uuid'), mockParams('rel-123'));

    expect(res.status).toBe(400);
    expect(deleteRelation).not.toHaveBeenCalled();
  });

  it('returns 404 when relation not found on delete', async () => {
    deleteRelation.mockRejectedValue(new Error('Relation not found'));

    const res = await DELETE(createMockDeleteRequest(), mockParams('nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Relation not found');
  });

  it('returns 500 on generic server error', async () => {
    deleteRelation.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await DELETE(createMockDeleteRequest(), mockParams('rel-123'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to delete relation');
  });
});
