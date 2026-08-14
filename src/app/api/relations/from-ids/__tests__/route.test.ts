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

// Mock relations-admin service (route migrated from client @/lib/relations to
// the admin twin @/lib/relations-admin: adminCreateRelationFromIds + re-exported
// SelfReferenceError / DuplicateRelationError). Inline error classes avoid
// hoisting issues.
jest.mock('@/lib/relations-admin', () => {
  class SelfReferenceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SelfReferenceError';
    }
  }

  class DuplicateRelationError extends Error {
    existingRelation: Record<string, unknown>;
    constructor(message: string, existingRelation?: Record<string, unknown>) {
      super(message);
      this.name = 'DuplicateRelationError';
      this.existingRelation = existingRelation || {};
    }
  }

  return {
    adminCreateRelationFromIds: jest.fn(),
    SelfReferenceError,
    DuplicateRelationError,
  };
});

// Mock Inngest client for sync event
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue(undefined) },
}));

const {
  adminCreateRelationFromIds: createRelationFromIds,
  SelfReferenceError,
  DuplicateRelationError,
} = jest.requireMock('@/lib/relations-admin');

import { POST } from '../route';

function createMockRequest(body: unknown, correlationId = TEST_CORRELATION_ID): NextRequest {
  return new NextRequest('http://localhost:3000/api/relations/from-ids', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      [CORRELATION_ID_HEADER]: correlationId,
    },
    body: JSON.stringify(body),
  });
}

function createDecodedBodyRequest(body: unknown): NextRequest {
  return {
    headers: new Headers({ [CORRELATION_ID_HEADER]: TEST_CORRELATION_ID }),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function createMalformedJsonRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/relations/from-ids', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      [CORRELATION_ID_HEADER]: TEST_CORRELATION_ID,
    },
    body: '{"sourceId":',
  });
}

const validBody = {
  sourceId: 'tech-1',
  sourceType: 'technology',
  targetId: 'company-1',
  targetType: 'company',
  relationType: 'uses',
  confidence: 85,
  aiSuggested: true,
};

const mockCreatedRelation = {
  id: 'rel-new-1',
  relationType: 'uses',
  sourceSnapshot: { type: 'technology', id: 'tech-1', name: 'React' },
  targetSnapshot: { type: 'company', id: 'company-1', name: 'Meta' },
  confidence: 85,
  aiSuggested: true,
  createdAt: 1700000000000,
};

describe('POST /api/relations/from-ids', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('creates relation from IDs successfully and returns 201', async () => {
    createRelationFromIds.mockResolvedValue(mockCreatedRelation);

    const res = await POST(createMockRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('rel-new-1');
    expect(createRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetId: 'company-1',
        targetType: 'company',
        relationType: 'uses',
        confidence: 85,
        aiSuggested: true,
      }),
      { correlationId: TEST_CORRELATION_ID }
    );
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });

  it('delegates sync ownership to the admin service without a duplicate route event', async () => {
    createRelationFromIds.mockResolvedValue(mockCreatedRelation);
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    await POST(createMockRequest(validBody));

    expect(createRelationFromIds).toHaveBeenCalledTimes(1);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('rejects a malformed correlation ID before parsing or writing', async () => {
    const request = createMockRequest(validBody, 'user-controlled search text');
    const jsonSpy = jest.spyOn(request, 'json');

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createRelationFromIds).not.toHaveBeenCalled();
  });

  it('returns 400 when sourceId is missing', async () => {
    const res = await POST(
      createMockRequest({
        sourceType: 'technology',
        targetId: 'company-1',
        targetType: 'company',
        relationType: 'uses',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('sourceId and sourceType are required');
  });

  it('returns 400 when targetId is missing', async () => {
    const res = await POST(
      createMockRequest({
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetType: 'company',
        relationType: 'uses',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('targetId and targetType are required');
  });

  it('returns 400 when relationType is missing', async () => {
    const res = await POST(
      createMockRequest({
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetId: 'company-1',
        targetType: 'company',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('relationType is required');
  });

  it('returns 400 for a noncanonical relationType before writing', async () => {
    const res = await POST(createMockRequest({ ...validBody, relationType: 'provides' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid relationType');
    expect(createRelationFromIds).not.toHaveBeenCalled();
  });

  it('returns 400 on self-reference error', async () => {
    createRelationFromIds.mockRejectedValue(
      new SelfReferenceError('Cannot create a relation from an entity to itself')
    );

    const res = await POST(
      createMockRequest({
        sourceId: 'tech-1',
        sourceType: 'technology',
        targetId: 'tech-1',
        targetType: 'technology',
        relationType: 'uses',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Self-reference not allowed');
    expect(json.code).toBe('SELF_REFERENCE');
  });

  it('returns 409 on duplicate relation error', async () => {
    const existingRelation = { id: 'rel-existing', relationType: 'uses' };
    const dupError = new DuplicateRelationError('Relation already exists', existingRelation);
    createRelationFromIds.mockRejectedValue(dupError);

    const res = await POST(createMockRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe('Duplicate relation');
    expect(json.code).toBe('DUPLICATE_RELATION');
    expect(json.existingRelation).toEqual(existingRelation);
  });

  it('returns 500 on generic server error', async () => {
    createRelationFromIds.mockRejectedValue(new Error('Firestore write failed'));

    const res = await POST(createMockRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to create relation');
  });

  it('passes agentName through to adminCreateRelationFromIds', async () => {
    createRelationFromIds.mockResolvedValue(mockCreatedRelation);

    const res = await POST(createMockRequest({ ...validBody, agentName: 'auto-linker' }));

    expect(res.status).toBe(201);
    expect(createRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'auto-linker' }),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('returns 400 for an agentName that fails the format regex', async () => {
    const res = await POST(createMockRequest({ ...validBody, agentName: 'Not Valid!' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid agentName');
    expect(createRelationFromIds).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid claimStatus', async () => {
    const res = await POST(
      createMockRequest({
        ...validBody,
        claimStatus: 'invalid-status',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid claimStatus');
  });

  it.each([
    ['an unknown top-level field', { ...validBody, unexpected: true }],
    ['a non-string source ID', { ...validBody, sourceId: 42 }],
    ['a non-string target ID', { ...validBody, targetId: true }],
    ['an invalid source entity type', { ...validBody, sourceType: 'org_unit' }],
    ['an invalid target entity type', { ...validBody, targetType: 'vendor' }],
    ['confidence below zero', { ...validBody, confidence: -1 }],
    ['confidence above 100', { ...validBody, confidence: 101 }],
    ['confidence as a string', { ...validBody, confidence: '85' }],
    ['aiSuggested as a string', { ...validBody, aiSuggested: 'true' }],
    ['notes as a non-string', { ...validBody, notes: 42 }],
    ['reasoningSummary as a non-string', { ...validBody, reasoningSummary: false }],
    ['agentName as a non-string', { ...validBody, agentName: true }],
    ['evidenceRefs as a non-array', { ...validBody, evidenceRefs: 'ev-1' }],
    [
      'structured evidence without capturedAt',
      { ...validBody, evidenceRefs: [{ id: 'ev-1', type: 'signal' }] },
    ],
    [
      'structured evidence with an unknown field',
      {
        ...validBody,
        evidenceRefs: [{ id: 'ev-1', type: 'signal', capturedAt: 1, extra: 'not allowed' }],
      },
    ],
    [
      'structured evidence with a wrong field type',
      { ...validBody, evidenceRefs: [{ id: 'ev-1', type: 'signal', capturedAt: 'now' }] },
    ],
    [
      'structured evidence with confidence above 100',
      { ...validBody, evidenceRefs: [{ id: 'ev-1', type: 'signal', capturedAt: 1, confidence: 101 }] },
    ],
    [
      'legacy evidence with an unknown source type',
      { ...validBody, evidenceRefs: [{ sourceType: 'database', sourceId: 'db-1' }] },
    ],
    [
      'legacy evidence with an unknown field',
      { ...validBody, evidenceRefs: [{ sourceType: 'signal', sourceId: 'sig-1', extra: true }] },
    ],
    [
      'legacy evidence with a non-string snippet',
      { ...validBody, evidenceRefs: [{ sourceType: 'signal', sourceId: 'sig-1', snippet: true }] },
    ],
  ])('returns 400 and does not write or emit for %s', async (_label, body) => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    const res = await POST(createMockRequest(body));

    expect(res.status).toBe(400);
    expect(createRelationFromIds).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns 400 for non-finite confidence %s before writing',
    async (confidence) => {
      const { inngest } = jest.requireMock('@/lib/inngest/client');

      const res = await POST(createDecodedBodyRequest({ ...validBody, confidence }));

      expect(res.status).toBe(400);
      expect(createRelationFromIds).not.toHaveBeenCalled();
      expect(inngest.send).not.toHaveBeenCalled();
    }
  );

  it('returns 400 for malformed JSON before writing', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    const res = await POST(createMalformedJsonRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request body');
    expect(createRelationFromIds).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('strictly validates and normalizes the documented legacy evidence shape', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1700000000100);
    createRelationFromIds.mockResolvedValue(mockCreatedRelation);

    const res = await POST(
      createMockRequest({
        ...validBody,
        evidenceRefs: [
          {
            sourceType: 'document',
            sourceId: 'doc-7',
            snippet: 'Primary-source excerpt',
          },
        ],
      })
    );

    expect(res.status).toBe(201);
    expect(createRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceRefs: [
          {
            id: 'legacy-document-doc-7-0',
            type: 'document_chunk',
            documentId: 'doc-7',
            snippet: 'Primary-source excerpt',
            capturedAt: 1700000000100,
          },
        ],
      }),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('passes evidenceRefs and reasoningSummary through correctly', async () => {
    createRelationFromIds.mockResolvedValue(mockCreatedRelation);

    const bodyWithEvidence = {
      ...validBody,
      evidenceRefs: [{ id: 'ev-1', type: 'signal', capturedAt: 1700000000000, snippet: 'Found in signal' }],
      reasoningSummary: 'AI determined this relation based on signal analysis',
      claimStatus: 'proposed',
    };

    const res = await POST(createMockRequest(bodyWithEvidence));

    expect(res.status).toBe(201);
    expect(createRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceRefs: expect.arrayContaining([expect.objectContaining({ id: 'ev-1', type: 'signal' })]),
        reasoningSummary: 'AI determined this relation based on signal analysis',
        claimStatus: 'proposed',
      }),
      { correlationId: TEST_CORRELATION_ID }
    );
  });
});
