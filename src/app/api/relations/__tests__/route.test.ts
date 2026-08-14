/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';
import { CORRELATION_ID_HEADER, isCorrelationId } from '@/lib/observability/correlation';

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock relations admin service — the route now reads AND writes through the
// admin-SDK twin (`@/lib/relations-admin`). The GET path no longer touches the
// client-SDK `@/lib/relations` barrel (it would poison the in-process client
// SDK server-side), and `filterRelations` is now an inlined pure function in the
// route module, so it isn't mockable — the filter test asserts behavior instead.
jest.mock('@/lib/relations-admin', () => ({
  adminGetRelations: jest.fn(),
  adminGetRelationsForEntity: jest.fn(),
  adminGetAISuggestedRelations: jest.fn(),
  adminGetStaleRelations: jest.fn(),
  adminCreateRelation: jest.fn(),
}));
jest.mock('@/lib/relations-cascade-admin', () => ({ adminDeleteRelationsForEntity: jest.fn() }));

// Mock Inngest client for sync event
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue(undefined) },
}));

// Keep the GET-path mock-var names intact; they now point at the admin twins the
// route actually calls. (`getRelations` → adminGetRelations, etc.)
const {
  adminGetRelations: getRelations,
  adminGetRelationsForEntity: getRelationsForEntity,
  adminGetAISuggestedRelations: getAISuggestedRelations,
  adminGetStaleRelations: getStaleRelations,
} = jest.requireMock('@/lib/relations-admin');

// Keep the variable name `createRelation` so existing POST assertions stay intact;
// it now points at the admin twin the route actually calls.
const { adminCreateRelation: createRelation } = jest.requireMock('@/lib/relations-admin');
const { adminDeleteRelationsForEntity: deleteRelationsForEntity } = jest.requireMock(
  '@/lib/relations-cascade-admin'
);

import { DELETE, GET, POST } from '../route';

function createMockGetRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/relations');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createMockPostRequest(
  body: Record<string, unknown>,
  correlationId: string | null = TEST_CORRELATION_ID
): NextRequest {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  };
  if (correlationId !== null) headers[CORRELATION_ID_HEADER] = correlationId;

  return new NextRequest('http://localhost:3000/api/relations', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function createMockDeleteRequest(
  entityId?: string,
  correlationId = TEST_CORRELATION_ID
): NextRequest {
  const url = new URL('http://localhost:3000/api/relations');
  if (entityId) url.searchParams.set('entityId', entityId);
  return new NextRequest(url, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token', [CORRELATION_ID_HEADER]: correlationId },
  });
}

const mockRelation = {
  id: 'rel-1',
  relationType: 'uses',
  sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1700000000000 },
  targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1700000000000 },
  confidence: 90,
  aiSuggested: false,
  createdAt: 1700000000000,
};

// ============================================================================
// GET /api/relations
// ============================================================================

describe('GET /api/relations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns all relations when no filters provided', async () => {
    getRelations.mockResolvedValue([mockRelation]);

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.count).toBe(1);
    expect(getRelations).toHaveBeenCalledTimes(1);
  });

  it('filters by entityId', async () => {
    getRelationsForEntity.mockResolvedValue([mockRelation]);

    const res = await GET(createMockGetRequest({ entityId: 'tech-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(getRelationsForEntity).toHaveBeenCalledWith('tech-1');
    expect(json.data).toHaveLength(1);
  });

  it('filters by relationType via the inlined filter', async () => {
    // `filterRelations` is now an inlined pure function in the route module, so
    // it can't be spied — assert the route fetched all relations and returned
    // only those matching the requested relationType.
    const otherRelation = { ...mockRelation, id: 'rel-2', relationType: 'enables' };
    getRelations.mockResolvedValue([mockRelation, otherRelation]);

    const res = await GET(createMockGetRequest({ relationType: 'uses' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(getRelations).toHaveBeenCalledTimes(1);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].relationType).toBe('uses');
  });

  it('gets stale relations when stale=true', async () => {
    getStaleRelations.mockResolvedValue([mockRelation]);

    const res = await GET(createMockGetRequest({ stale: 'true' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(getStaleRelations).toHaveBeenCalledWith(7);
    expect(json.data).toHaveLength(1);
  });

  it('gets AI-suggested relations when aiSuggested=true', async () => {
    getAISuggestedRelations.mockResolvedValue([mockRelation]);

    const res = await GET(createMockGetRequest({ aiSuggested: 'true' }));
    const _json = await res.json();

    expect(res.status).toBe(200);
    expect(getAISuggestedRelations).toHaveBeenCalledTimes(1);
  });

  it('returns 500 on server error', async () => {
    getRelations.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to retrieve relations');
  });
});

// ============================================================================
// POST /api/relations
// ============================================================================

describe('POST /api/relations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('creates relation successfully and returns 201', async () => {
    createRelation.mockResolvedValue(mockRelation);

    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1700000000000 },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1700000000000 },
        confidence: 90,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('rel-1');
    expect(createRelation).toHaveBeenCalledTimes(1);
    expect(createRelation).toHaveBeenCalledWith(expect.any(Object), {
      correlationId: TEST_CORRELATION_ID,
    });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });

  it('generates, forwards, and echoes a correlation ID when the header is absent', async () => {
    createRelation.mockResolvedValue(mockRelation);

    const res = await POST(
      createMockPostRequest(
        {
          relationType: 'uses',
          sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1 },
          targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1 },
        },
        null
      )
    );

    const forwarded = createRelation.mock.calls[0][1].correlationId;
    expect(isCorrelationId(forwarded)).toBe(true);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(forwarded);
  });

  it('authenticates before validating a malformed correlation header', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const res = await POST(
      createMockPostRequest(
        {
          relationType: 'uses',
          sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
          targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
        },
        'private arbitrary text'
      )
    );

    expect(res.status).toBe(401);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('preserves allowed evidence and claim metadata across the API boundary', async () => {
    createRelation.mockResolvedValue(mockRelation);
    const evidenceRefs = [{ id: 'signal-1', type: 'signal', signalId: 'signal-1', capturedAt: 1 }];

    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1 },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1 },
        evidenceRefs,
        claimStatus: 'curated',
        reasoningSummary: 'Reviewed evidence',
        agentName: 'assistant',
      })
    );

    expect(res.status).toBe(201);
    expect(createRelation).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceRefs, claimStatus: 'curated', reasoningSummary: 'Reviewed evidence' }),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('rejects system-owned or unknown fields before writing', async () => {
    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1 },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1 },
        claimId: 'caller-controlled',
      })
    );

    expect(res.status).toBe(400);
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('delegates sync ownership to the admin service without a duplicate route event', async () => {
    createRelation.mockResolvedValue(mockRelation);
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1700000000000 },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1700000000000 },
      })
    );

    expect(createRelation).toHaveBeenCalledTimes(1);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('returns 400 when relationType is missing', async () => {
    const res = await POST(
      createMockPostRequest({
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('relationType is required');
  });

  it('rejects a malformed correlation ID before parsing or writing', async () => {
    const res = await POST(
      createMockPostRequest(
        {
          relationType: 'uses',
          sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
          targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
        },
        'customer@example.com'
      )
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Invalid correlation ID' });
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('returns 400 for a legacy or arbitrary relationType before writing', async () => {
    const res = await POST(
      createMockPostRequest({
        relationType: 'provides',
        sourceSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
        targetSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid relationType');
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('returns 400 when snapshots are missing', async () => {
    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('sourceSnapshot and targetSnapshot are required');
  });

  it('returns 400 when snapshot validation fails (missing fields)', async () => {
    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology' }, // missing id and name
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('returns 500 on server error during creation', async () => {
    createRelation.mockRejectedValue(new Error('Firestore write failed'));

    const res = await POST(
      createMockPostRequest({
        relationType: 'uses',
        sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React', snapshotAt: 1700000000000 },
        targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta', snapshotAt: 1700000000000 },
      })
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to create relation');
  });
});

describe('DELETE /api/relations?entityId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires an authenticated caller and entityId', async () => {
    const missing = await DELETE(createMockDeleteRequest());
    expect(missing.status).toBe(400);

    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });
    const unauthorized = await DELETE(createMockDeleteRequest('tech-1'));
    expect(unauthorized.status).toBe(401);
  });

  it('delegates cascade deletion to the admin service and returns the count', async () => {
    deleteRelationsForEntity.mockResolvedValueOnce(3);

    const res = await DELETE(createMockDeleteRequest('tech-1'));
    await expect(res.json()).resolves.toEqual({ success: true, data: { deleted: 3 } });
    expect(deleteRelationsForEntity).toHaveBeenCalledWith('tech-1', {
      correlationId: TEST_CORRELATION_ID,
    });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });

  it('surfaces a failed durable handoff', async () => {
    deleteRelationsForEntity.mockRejectedValueOnce(new Error('delete sync was not acknowledged'));

    const res = await DELETE(createMockDeleteRequest('tech-1'));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ message: 'delete sync was not acknowledged' });
  });
});
