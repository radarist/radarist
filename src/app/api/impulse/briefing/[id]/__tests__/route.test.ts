/**
 * @file [id]/__tests__/route.test.ts
 * @description Tests for the insight detail GET endpoint.
 *
 * Pins:
 *   1. Returns insight payload with A.0 structured-path fields exposed.
 *   2. Strips writer's userId + consumed flag (server-only).
 *   3. 404 when the insight doesn't exist, 401 unauth.
 *
 * @jest-environment node
 */

const mockGetInsightById = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  getInsightById: (...args: unknown[]) => mockGetInsightById(...args),
}));

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { GraphUnavailableError } from '@/lib/graph/errors';
const { GET } = require('../route');

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/impulse/briefing/pi-1', { method: 'GET' });
}

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/impulse/briefing/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
  });

  it('returns the insight payload with A.0 structured-path fields', async () => {
    mockGetInsightById.mockResolvedValue({
      id: 'pi-1',
      userId: 'sweep-system',
      type: 'connection',
      title: 'Quantum-IBM link',
      summary: 'IBM is 2 hops from Quantum via VENDOR → USES.',
      agentName: 'scout',
      confidenceScore: 0.7,
      relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
      observedEntityId: 'comp-ibm',
      exploredEntityId: 'tech-quantum',
      actionable: true,
      actionUrl: '/library/companies?sheet=comp-ibm',
      actionLabel: 'View company',
      createdAt: '2026-05-13T00:00:00.000Z',
      consumed: false,
      liked: false,
      relationshipTypes: ['VENDOR', 'USES'],
      sourceRelationTypes: ['vendor', 'uses'],
      relationshipDirections: ['forward', 'reverse'],
      evidenceSummary: 'IBM -[VENDOR]-> Platform <-[USES]- Quantum',
      groundingVersion: 'predicate-path-v1',
      epistemicKind: 'inference',
      pathLength: 2,
      exploredAt: '2026-05-10T12:00:00.000Z',
    });

    const res = await GET(makeRequest(), makeCtx('pi-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe('pi-1');
    expect(body.relationshipTypes).toEqual(['VENDOR', 'USES']);
    expect(body.sourceRelationTypes).toEqual(['vendor', 'uses']);
    expect(body.relationshipDirections).toEqual(['forward', 'reverse']);
    expect(body.evidenceSummary).toContain('<-[USES]-');
    expect(body.groundingVersion).toBe('predicate-path-v1');
    expect(body.epistemicKind).toBe('inference');
    expect(body.pathLength).toBe(2);
    expect(body.exploredAt).toBe('2026-05-10T12:00:00.000Z');
    // Server-only fields stripped from the payload.
    expect(body.userId).toBeUndefined();
    expect(body.consumed).toBeUndefined();
  });

  it('returns 404 when the insight does not exist', async () => {
    mockGetInsightById.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeCtx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 503 degraded (NOT 404 / 500) when the graph backend is unavailable (UX-018)', async () => {
    // A 404 means "gone / stale link"; an outage must be distinguishable so the
    // detail page shows "unavailable / retry" instead of "the link is stale".
    mockGetInsightById.mockRejectedValue(new GraphUnavailableError('read', 'neo4j', 'Neo4j is unavailable.'));

    const res = await GET(makeRequest(), makeCtx('pi-1'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.degraded).toBe(true);
    expect(body.backend).toBe('neo4j');
  });

  it('returns 500 for a non-availability error — a real bug is not dressed up as 503', async () => {
    mockGetInsightById.mockRejectedValue(new Error('unexpected boom'));
    const res = await GET(makeRequest(), makeCtx('pi-1'));
    expect(res.status).toBe(500);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
    const res = await GET(makeRequest(), makeCtx('pi-1'));
    expect(res.status).toBe(401);
    expect(mockGetInsightById).not.toHaveBeenCalled();
  });
});
