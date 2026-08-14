/**
 * @jest-environment node
 */

/**
 * @file route.test.ts
 * @description Tests for GET /api/impulse/briefing
 *
 * Covers: authentication, Neo4j insight retrieval, mapping,
 * fallback on Neo4j failure, limit parameter, and token usage.
 */

import { NextRequest } from 'next/server';
import type { ProactiveInsightNode } from '@/lib/graph/proactive-insights';
import { GraphUnavailableError } from '@/lib/graph/errors';

// ============================================================================
// MOCKS
// ============================================================================

// Mock auth — default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock Neo4j proactive insights
const mockGetInsightsForUser = jest.fn();
const mockGetInsightStats = jest.fn();
jest.mock('@/lib/graph/proactive-insights', () => ({
  getInsightsForUser: (...args: unknown[]) => mockGetInsightsForUser(...args),
  getInsightStats: (...args: unknown[]) => mockGetInsightStats(...args),
}));

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { GET } from '../route';

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(url = 'http://localhost:3000/api/impulse/briefing'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createMockInsightNode(overrides: Partial<ProactiveInsightNode> = {}): ProactiveInsightNode {
  return {
    id: 'insight-001',
    userId: 'test-user-123',
    type: 'discovery',
    title: 'Scout discovered 3 quantum companies',
    summary: 'IonQ, Rigetti, and PsiQuantum have new funding rounds.',
    agentName: 'Scout',
    confidenceScore: 0.87,
    relatedEntities: [
      { id: 'comp-ionq', name: 'IonQ', type: 'company' },
      { id: 'comp-rigetti', name: 'Rigetti Computing', type: 'company' },
    ],
    actionable: true,
    actionUrl: '/triage/signals',
    actionLabel: 'View discoveries',
    createdAt: '2026-02-23T10:00:00.000Z',
    consumed: false,
    liked: false,
    ...overrides,
  };
}

function createMockStats(total = 5, unconsumed = 3) {
  return {
    total,
    unconsumed,
    lastDetectedAt: '2026-02-23T14:00:00.000Z',
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('GET /api/impulse/briefing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: return some insights and stats
    mockGetInsightsForUser.mockResolvedValue([createMockInsightNode()]);
    mockGetInsightStats.mockResolvedValue(createMockStats());
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
  });

  // --------------------------------------------------------------------------
  // Insight Retrieval
  // --------------------------------------------------------------------------

  it('returns insights from Neo4j for authenticated user', async () => {
    const insight = createMockInsightNode();
    mockGetInsightsForUser.mockResolvedValue([insight]);
    mockGetInsightStats.mockResolvedValue(createMockStats(10));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.insights).toHaveLength(1);
    expect(json.insights[0].id).toBe('insight-001');
    expect(json.insights[0].title).toBe('Scout discovered 3 quantum companies');
    expect(json.tokenUsage).toBeDefined();
  });

  it('returns empty insights array when no insights exist', async () => {
    mockGetInsightsForUser.mockResolvedValue([]);
    mockGetInsightStats.mockResolvedValue(createMockStats(0, 0));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.insights).toEqual([]);
    expect(json.tokenUsage.used).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Mapping
  // --------------------------------------------------------------------------

  it('maps ProactiveInsightNode to BriefingInsight correctly', async () => {
    const node = createMockInsightNode({
      id: 'insight-map-test',
      type: 'connection',
      title: 'Linker found connections',
      summary: 'Seven new entity connections discovered.',
      agentName: 'Linker',
      confidenceScore: 0.92,
      relatedEntities: [{ id: 'strat-edge', name: 'Edge Computing Strategy', type: 'strategy' }],
      actionable: true,
      actionUrl: '/agents/linker',
      actionLabel: 'Review connections',
      createdAt: '2026-02-23T08:00:00.000Z',
      relationshipTypes: ['ALIGNS_WITH', 'RELATED_TO'],
      sourceRelationTypes: ['aligns_with', 'supplier_of'],
      relationshipDirections: ['forward', 'reverse'],
      evidenceSummary: 'Technology A -[ALIGNS_WITH]-> Strategy B <-[SUPPLIER_OF]- Company C',
      groundingVersion: 'predicate-path-v1',
      epistemicKind: 'inference',
    });
    mockGetInsightsForUser.mockResolvedValue([node]);

    const res = await GET(createMockRequest());
    const json = await res.json();

    const mapped = json.insights[0];
    expect(mapped).toEqual({
      id: 'insight-map-test',
      type: 'connection',
      title: 'Linker found connections',
      summary: 'Seven new entity connections discovered.',
      agentName: 'Linker',
      confidenceScore: 0.92,
      relatedEntities: [{ id: 'strat-edge', name: 'Edge Computing Strategy', type: 'strategy' }],
      actionable: true,
      actionUrl: '/agents/linker',
      actionLabel: 'Review connections',
      createdAt: '2026-02-23T08:00:00.000Z',
      liked: false,
      relationshipTypes: ['ALIGNS_WITH', 'RELATED_TO'],
      sourceRelationTypes: ['aligns_with', 'supplier_of'],
      relationshipDirections: ['forward', 'reverse'],
      evidenceSummary: 'Technology A -[ALIGNS_WITH]-> Strategy B <-[SUPPLIER_OF]- Company C',
      groundingVersion: 'predicate-path-v1',
      epistemicKind: 'inference',
    });

    // Should NOT include userId or consumed from ProactiveInsightNode
    expect(mapped.userId).toBeUndefined();
    expect(mapped.consumed).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Liked field passthrough (Phase 0 step 0.11)
  // --------------------------------------------------------------------------

  it('passes the liked flag through to the BriefingInsight response', async () => {
    mockGetInsightsForUser.mockResolvedValue([
      createMockInsightNode({ id: 'liked-1', liked: true }),
      createMockInsightNode({ id: 'liked-2', liked: false }),
    ]);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.insights[0].liked).toBe(true);
    expect(json.insights[1].liked).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Honest degradation (UX-018): an outage is a 503, NOT a 200-empty inbox.
  // --------------------------------------------------------------------------

  it('returns 503 degraded (not 200-empty) when the graph backend is unavailable', async () => {
    mockGetInsightsForUser.mockRejectedValue(new GraphUnavailableError('read', 'neo4j', 'Neo4j is unavailable.'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get('X-Impulse-Fallback')).toBe('true');
    expect(json.degraded).toBe(true);
    expect(json.error).toBe('Graph backend unavailable');
    expect(json.backend).toBe('neo4j');
    // The old contract fabricated an empty list — the new one must not.
    expect(json.insights).toBeUndefined();
  });

  it('surfaces a 503 when the stats read (not the insights read) is the unavailable one', async () => {
    mockGetInsightStats.mockRejectedValue(new GraphUnavailableError('read', 'neo4j', 'Neo4j is unavailable.'));

    const res = await GET(createMockRequest());

    expect(res.status).toBe(503);
  });

  it('returns 500 (not a masked 503) for a non-availability error — a real bug is not hidden', async () => {
    mockGetInsightsForUser.mockRejectedValue(new Error('Cypher syntax error'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });

  // --------------------------------------------------------------------------
  // Limit Parameter
  // --------------------------------------------------------------------------

  it('respects limit query parameter', async () => {
    mockGetInsightsForUser.mockResolvedValue([]);
    mockGetInsightStats.mockResolvedValue(createMockStats(0, 0));

    await GET(createMockRequest('http://localhost:3000/api/impulse/briefing?limit=5'));

    expect(mockGetInsightsForUser).toHaveBeenCalledWith('test-user-123', 5);
  });

  it('uses default limit of 20 when not specified', async () => {
    mockGetInsightsForUser.mockResolvedValue([]);
    mockGetInsightStats.mockResolvedValue(createMockStats(0, 0));

    await GET(createMockRequest());

    expect(mockGetInsightsForUser).toHaveBeenCalledWith('test-user-123', 20);
  });

  // --------------------------------------------------------------------------
  // Token Usage
  // --------------------------------------------------------------------------

  it('returns tokenUsage based on insight stats', async () => {
    mockGetInsightsForUser.mockResolvedValue([]);
    mockGetInsightStats.mockResolvedValue(createMockStats(25, 10));

    const res = await GET(createMockRequest());
    const json = await res.json();

    // 25 total insights * 500 tokens per insight = 12,500 used
    expect(json.tokenUsage).toEqual({
      used: 12_500,
      budget: 100_000,
    });
  });
});
