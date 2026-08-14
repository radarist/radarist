/**
 * @file route.test.ts
 * @description Unit tests for GET /api/entities/[id]/claims
 *
 * The claims API is the read surface for the Reified Assertion Model
 * (P5-D): it returns an entity's :Assertion nodes with their :Evidence.
 * Covers:
 * - Authentication gate
 * - Missing entity ID validation
 * - Claim shape mapping (subject/object nesting, status, confidence)
 * - Evidence enrichment via getAssertionWithEvidence
 * - Evidence fallback via getAssertionWithEvidenceByRelationId (D9 null-tolerant read)
 * - Deduplication of self-loop assertions
 * - Evidence enrichment failure does not kill the claim list
 * - H10 honest degradation (503 + degraded flag on GraphUnavailableError)
 * - Error handling
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { GraphUnavailableError } from '@/lib/graph/errors';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/graph', () => ({
  getAssertionsForEntity: jest.fn(),
  getAssertionWithEvidence: jest.fn(),
  getAssertionWithEvidenceByRelationId: jest.fn(),
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

import { GET } from '../route';

const { getAssertionsForEntity, getAssertionWithEvidence, getAssertionWithEvidenceByRelationId } =
  jest.requireMock('@/lib/graph');
const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(id = 'ent-1'): NextRequest {
  return new NextRequest(`http://localhost/api/entities/${id}/claims`, { method: 'GET' });
}

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeAssertion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    statement: 'TensorFlow addresses ML complexity',
    confidence: 85,
    status: 'proposed',
    createdAt: 1000,
    updatedAt: 2000,
    subjectId: 'ent-1',
    subjectType: 'technology',
    subjectName: 'TensorFlow',
    objectId: 'ent-2',
    objectType: 'useCase',
    objectName: 'ML complexity',
    predicate: 'ADDRESSES',
    assertedBy: 'agent:scout',
    asserterType: 'agent',
    ...overrides,
  };
}

function makeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    sourceType: 'web_ref',
    snippet: 'TensorFlow simplifies machine learning workflows.',
    sourceUrl: 'https://example.com/tf',
    capturedAt: 1500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/entities/[id]/claims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
    getAssertionsForEntity.mockResolvedValue({ asSubject: [], asObject: [], totalCount: 0 });
    getAssertionWithEvidence.mockResolvedValue(null);
    getAssertionWithEvidenceByRelationId.mockResolvedValue(null);
  });

  // ---- Auth ----

  it('returns 401 when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Missing token' });

    const res = await GET(createRequest(), makeCtx('ent-1'));

    expect(res.status).toBe(401);
    expect(getAssertionsForEntity).not.toHaveBeenCalled();
  });

  // ---- Validation ----

  it('returns 400 when entity ID is empty', async () => {
    const res = await GET(createRequest(''), makeCtx(''));

    expect(res.status).toBe(400);
    expect(getAssertionsForEntity).not.toHaveBeenCalled();
  });

  // ---- Success shapes ----

  it('returns empty claims list when the entity has no assertions', async () => {
    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.claims).toEqual([]);
    expect(json.totalCount).toBe(0);
  });

  it('maps assertions into the claims shape with nested subject/object', async () => {
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [makeAssertion()],
      asObject: [
        makeAssertion({
          id: 'claim-2',
          subjectId: 'ent-3',
          subjectName: 'PyTorch',
          objectId: 'ent-1',
          objectName: 'TensorFlow',
          predicate: 'COMPETES_WITH',
          status: 'curated',
          confidence: 95,
        }),
      ],
      totalCount: 2,
    });

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.claims).toHaveLength(2);
    expect(json.totalCount).toBe(2);

    const first = json.claims[0];
    expect(first.id).toBe('claim-1');
    expect(first.predicate).toBe('ADDRESSES');
    expect(first.subject).toEqual({ id: 'ent-1', type: 'technology', name: 'TensorFlow' });
    expect(first.object).toEqual({ id: 'ent-2', type: 'useCase', name: 'ML complexity' });
    expect(first.status).toBe('proposed');
    expect(first.confidence).toBe(85);
    expect(first.statement).toBe('TensorFlow addresses ML complexity');
    expect(first.assertedBy).toBe('agent:scout');
    expect(first.asserterType).toBe('agent');
    expect(first.evidence).toEqual([]);

    const second = json.claims[1];
    expect(second.id).toBe('claim-2');
    expect(second.status).toBe('curated');
    expect(second.subject.id).toBe('ent-3');
    expect(second.object.id).toBe('ent-1');
  });

  it('attaches evidence from getAssertionWithEvidence', async () => {
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [makeAssertion()],
      asObject: [],
      totalCount: 1,
    });
    getAssertionWithEvidence.mockResolvedValue({
      claim: makeAssertion(),
      evidence: [makeEvidence()],
    });

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(getAssertionWithEvidence).toHaveBeenCalledWith('claim-1');
    expect(json.claims[0].evidence).toHaveLength(1);
    expect(json.claims[0].evidence[0].snippet).toBe('TensorFlow simplifies machine learning workflows.');
  });

  it('falls back to getAssertionWithEvidenceByRelationId when the id lookup misses', async () => {
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [makeAssertion({ relationId: 'rel-77' })],
      asObject: [],
      totalCount: 1,
    });
    getAssertionWithEvidence.mockResolvedValue(null);
    getAssertionWithEvidenceByRelationId.mockResolvedValue({
      claim: makeAssertion({ relationId: 'rel-77' }),
      evidence: [makeEvidence({ id: 'ev-2' })],
    });

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(getAssertionWithEvidenceByRelationId).toHaveBeenCalledWith('rel-77');
    expect(json.claims[0].evidence).toHaveLength(1);
    expect(json.claims[0].evidence[0].id).toBe('ev-2');
  });

  it('does not call the relationId fallback when the assertion has no relationId', async () => {
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [makeAssertion()],
      asObject: [],
      totalCount: 1,
    });

    await GET(createRequest(), makeCtx('ent-1'));

    expect(getAssertionWithEvidenceByRelationId).not.toHaveBeenCalled();
  });

  it('dedupes self-loop assertions that appear as both subject and object', async () => {
    const selfLoop = makeAssertion({ id: 'claim-self', objectId: 'ent-1', objectName: 'TensorFlow' });
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [selfLoop],
      asObject: [selfLoop],
      totalCount: 2,
    });

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(json.claims).toHaveLength(1);
    expect(json.totalCount).toBe(1);
  });

  it('keeps the claim with empty evidence when evidence enrichment throws', async () => {
    getAssertionsForEntity.mockResolvedValue({
      asSubject: [makeAssertion()],
      asObject: [],
      totalCount: 1,
    });
    getAssertionWithEvidence.mockRejectedValue(new Error('evidence query failed'));

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.claims).toHaveLength(1);
    expect(json.claims[0].evidence).toEqual([]);
  });

  // ---- Honest degradation (H10) ----

  it('returns 503 with degraded flag on GraphUnavailableError', async () => {
    getAssertionsForEntity.mockRejectedValue(new GraphUnavailableError('getAssertionsForEntity'));

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.degraded).toBe(true);
  });

  // ---- Error handling ----

  it('returns 500 on unexpected errors', async () => {
    getAssertionsForEntity.mockRejectedValue(new Error('boom'));

    const res = await GET(createRequest(), makeCtx('ent-1'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to fetch entity claims');
  });
});
