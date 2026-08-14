/**
 * @file dot-connector.test.ts
 * @description Unit tests for the cross-session dot-connecting service.
 *
 * Tests cover:
 * - Finding graph paths between observation entities and explored entities
 * - Relevance score computation
 * - Main orchestration (connectDots)
 * - ProactiveInsight creation for high-relevance connections
 * - Recent dot connection retrieval
 */

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock crypto.randomUUID for deterministic IDs
let uuidCounter = 0;
const originalCrypto = global.crypto;
beforeAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: {
      ...originalCrypto,
      randomUUID: jest.fn(() => {
        uuidCounter++;
        return `mock-uuid-${uuidCounter}`;
      }),
    },
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: originalCrypto,
    writable: true,
    configurable: true,
  });
});

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import * as neo4jClient from '../neo4j-client';
import { findDotConnections, connectDots } from '../dot-connector';

const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// ============================================================================
// HELPERS
// ============================================================================

function createMockQueryResult<T>(records: T[]) {
  const groundedRecords = records.map((record, recordIndex) => {
    if (!record || typeof record !== 'object' || !('relationshipTypes' in record)) return record;
    const pathRecord = record as T & {
      observedEntityId?: string;
      observedEntityName?: string;
      observedEntityType?: string;
      exploredEntityId?: string;
      exploredEntityName?: string;
      exploredEntityType?: string;
      relationshipTypes?: string[];
    };
    if (!Array.isArray(pathRecord.relationshipTypes)) return record;

    const hopCount = pathRecord.relationshipTypes.length;
    const pathNodeIds = [
      pathRecord.observedEntityId ?? `observed-${recordIndex}`,
      ...Array.from({ length: Math.max(0, hopCount - 1) }, (_, index) => `mid-${recordIndex}-${index}`),
      pathRecord.exploredEntityId ?? `explored-${recordIndex}`,
    ];
    const pathNodeNames = [
      pathRecord.observedEntityName ?? 'Observed',
      ...Array.from({ length: Math.max(0, hopCount - 1) }, (_, index) => `Intermediate ${index + 1}`),
      pathRecord.exploredEntityName ?? 'Explored',
    ];
    const pathNodeTypes = [
      pathRecord.observedEntityType ?? 'technology',
      ...Array.from({ length: Math.max(0, hopCount - 1) }, () => 'technology'),
      pathRecord.exploredEntityType ?? 'technology',
    ];

    return {
      sourceRelationTypes: pathRecord.relationshipTypes.map((predicate) => predicate.toLowerCase()),
      relationIds: pathRecord.relationshipTypes.map((_, index) => `rel-${recordIndex}-${index}`),
      assertedBy: pathRecord.relationshipTypes.map(() => 'user:user-abc'),
      claimStatuses: pathRecord.relationshipTypes.map(() => 'curated'),
      edgeConfidences: pathRecord.relationshipTypes.map(() => 100),
      pathNodeIds,
      pathNodeNames,
      pathNodeTypes,
      relationshipStartIds: pathNodeIds.slice(0, -1),
      relationshipEndIds: pathNodeIds.slice(1),
      ...record,
    };
  });
  return {
    records: groundedRecords,
    summary: {
      counters: {
        nodesCreated: 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
      },
      queryType: 'rw',
      resultAvailableAfter: 1,
      resultConsumedAfter: 0,
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('dot-connector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    uuidCounter = 0;
  });

  // --------------------------------------------------------------------------
  // findDotConnections
  // --------------------------------------------------------------------------

  describe('findDotConnections', () => {
    it('returns paths between observation entity and explored entities', async () => {
      const mockPaths = [
        {
          observedEntityId: 'tech-quantum',
          observedEntityName: 'Quantum Computing',
          observedEntityType: 'technology',
          exploredEntityId: 'comp-ibm',
          exploredEntityName: 'IBM',
          exploredEntityType: 'company',
          pathLength: 1,
          relationshipTypes: ['VENDOR'],
          exploredAt: '2026-05-10T12:00:00.000Z',
        },
        {
          observedEntityId: 'tech-quantum',
          observedEntityName: 'Quantum Computing',
          observedEntityType: 'technology',
          exploredEntityId: 'tech-ml',
          exploredEntityName: 'Machine Learning',
          exploredEntityType: 'technology',
          pathLength: 2,
          relationshipTypes: ['ENABLES', 'USES'],
          exploredAt: null,
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(mockPaths));

      const connections = await findDotConnections('tech-quantum', 'user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      expect(connections).toHaveLength(2);

      // First connection (pathLength: 1) — exploredAt surfaces from query
      expect(connections[0].observedEntityId).toBe('tech-quantum');
      expect(connections[0].exploredEntityId).toBe('comp-ibm');
      expect(connections[0].pathLength).toBe(1);
      expect(connections[0].relationshipTypes).toEqual(['VENDOR']);
      expect(connections[0].exploredAt).toBe('2026-05-10T12:00:00.000Z');

      // Second connection (pathLength: 2) — exploredAt null normalises to null
      expect(connections[1].observedEntityId).toBe('tech-quantum');
      expect(connections[1].exploredEntityId).toBe('tech-ml');
      expect(connections[1].pathLength).toBe(2);
      expect(connections[1].relationshipTypes).toEqual(['ENABLES', 'USES']);
      expect(connections[1].exploredAt).toBeNull();
    });

    it('returns empty array when no paths found', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const connections = await findDotConnections('tech-isolated', 'user-abc');

      expect(connections).toEqual([]);
    });

    it('computes relevanceScore by hop count (1-hop=0.9, 2-hop=0.5, 3+ filtered)', async () => {
      // Updated 2026-05-12: scoring is no longer 1/(pathLength+1). After
      // restricting the path query to semantic edges only (USES, VENDOR,
      // ENABLES, ...), a 1-hop is a direct business connection — we score
      // it 0.9. A 2-hop is two hops through real semantic edges — 0.5.
      // 3+ hops are too indirect to claim as a meaningful connection.
      const mockPaths = [
        {
          observedEntityId: 'tech-a',
          observedEntityName: 'Tech A',
          observedEntityType: 'technology',
          exploredEntityId: 'tech-b',
          exploredEntityName: 'Tech B',
          exploredEntityType: 'technology',
          pathLength: 1,
          relationshipTypes: ['USES'],
        },
        {
          observedEntityId: 'tech-a',
          observedEntityName: 'Tech A',
          observedEntityType: 'technology',
          exploredEntityId: 'tech-c',
          exploredEntityName: 'Tech C',
          exploredEntityType: 'technology',
          pathLength: 2,
          relationshipTypes: ['USES', 'ENABLES'],
        },
        {
          observedEntityId: 'tech-a',
          observedEntityName: 'Tech A',
          observedEntityType: 'technology',
          exploredEntityId: 'tech-d',
          exploredEntityName: 'Tech D',
          exploredEntityType: 'technology',
          pathLength: 3,
          relationshipTypes: ['USES', 'ENABLES', 'COMPETES_WITH'],
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(mockPaths));

      const connections = await findDotConnections('tech-a', 'user-abc');

      expect(connections[0].relevanceScore).toBe(0.9);
      expect(connections[1].relevanceScore).toBe(0.5);
      // 3-hop evidence is rejected by the grounding contract entirely.
      expect(connections).toHaveLength(2);
    });

    it('uses default maxHops of 2', async () => {
      // Updated 2026-05-12: default reduced from 3 → 2 (3+ hops are too
      // indirect to claim as a real connection even through semantic edges).
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('*1..2');
    });

    it('restricts the path to semantic relationship types (allowlist)', async () => {
      // Regression guard for the 2026-05-12 "AI Agents <-ABOUT- Insight
      // -ABOUT-> Precision Fermentation" hallucinated-connection class.
      // The path query must constrain edges to the semantic allowlist —
      // bookkeeping edges (ABOUT, EXPLORED, CONTAINS, OBSERVES, etc.) must
      // not be traversable.
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      // Allowlist members must appear in the Cypher relationship filter.
      expect(cypher).toContain('USES');
      expect(cypher).toContain('VENDOR');
      expect(cypher).toContain('PARTNER');
      expect(cypher).toContain('ENABLES');
      expect(cypher).toContain('ADDRESSES');
      // Bookkeeping edges must NOT appear in the relationship filter, only
      // (defensively) as labels inside literal node patterns. We check that
      // they're absent from any `[r:...]` filter expression.
      // (A simple "not in string" is good enough — every cypher relationship
      // filter uses uppercase rel types and these names are unique.)
      expect(cypher).not.toMatch(/\[r?:?ABOUT[\]|]/);
      expect(cypher).not.toMatch(/\[r?:?CONTAINS[\]|]/);
      expect(cypher).not.toMatch(/\[r?:?OBSERVES[\]|]/);
      expect(cypher).not.toMatch(/\[r?:?BELONGS_TO[\]|]/);
    });

    it('uses custom maxHops', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc', 5);

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('*1..5');
    });

    it('passes correct parameters to Cypher query', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc');

      const [cypher, params] = mockedReadTransaction.mock.calls[0];

      // Verify Cypher structure
      expect(cypher).toContain('MATCH (s:Session { userId: $userId })-[xp:EXPLORED]->(explored)');
      expect(cypher).toContain('explored.id <> $entityId');
      expect(cypher).toContain('shortestPath');
      expect(cypher).toContain('ORDER BY pathLen ASC');
      expect(cypher).toContain('LIMIT 10');
      // A.0 — exploredAt is aggregated as the most recent EXPLORED-edge view
      // timestamp across all of the user's sessions for the explored entity.
      expect(cypher).toContain('max(coalesce(xp.lastViewedAt, xp.firstViewedAt)) AS exploredAt');
      expect(cypher).toContain('exploredAt AS exploredAt');

      // Verify parameters
      expect(params).toEqual({
        entityId: 'tech-quantum',
        userId: 'user-abc',
      });
    });

    it('throws and logs error when read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Neo4j read failed'));

      await expect(findDotConnections('tech-quantum', 'user-abc')).rejects.toThrow('Neo4j read failed');
    });

    it('excludes invalidated and rejected edges from the path', async () => {
      // Temporal-invalidation contract: edges with `t_invalidated` set are
      // historical, not current. The path query must skip them so a stale
      // VENDOR edge from a year ago doesn't fabricate a "current" insight.
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('currentRel.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(currentRel.claimStatus, 'curated') <> 'rejected'");
    });

    it('reads raw per-hop provenance, semantic type, node order, and edge direction', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await findDotConnections('tech-quantum', 'user-abc');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('[r IN relationships(path) | r.sourceRelationType] AS sourceRelationTypes');
      expect(cypher).toContain('[r IN relationships(path) | r.relationId] AS relationIds');
      expect(cypher).toContain('[r IN relationships(path) | r.assertedBy] AS assertedBy');
      expect(cypher).toContain('[r IN relationships(path) | r.claimStatus] AS claimStatuses');
      expect(cypher).toContain(
        '[r IN relationships(path) | coalesce(r.effectiveConfidence, r.assertedConfidence, r.confidence)] AS edgeConfidences'
      );
      expect(cypher).not.toContain("coalesce(r.claimStatus, 'curated')");
      expect(cypher).toContain('[n IN nodes(path) | n.id] AS pathNodeIds');
      expect(cypher).toContain('[r IN relationships(path) | startNode(r).id] AS relationshipStartIds');
      expect(cypher).toContain('[r IN relationships(path) | endNode(r).id] AS relationshipEndIds');
    });

    it.each([
      ['missing relation ID', { relationIds: [null] }],
      ['missing asserter', { assertedBy: [null] }],
      ['missing status', { claimStatuses: [null] }],
      ['proposed status', { claimStatuses: ['proposed'] }],
      ['derived status', { claimStatuses: ['derived'] }],
      ['predicate metadata mismatch', { sourceRelationTypes: ['uses'] }],
    ])('drops %s before the path can reach persistence', async (_label, override) => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            observedEntityId: 'tech-a',
            observedEntityName: 'Tech A',
            observedEntityType: 'technology',
            exploredEntityId: 'company-b',
            exploredEntityName: 'Company B',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['VENDOR'],
            ...override,
          },
        ])
      );

      await expect(findDotConnections('tech-a', 'user-abc')).resolves.toEqual([]);
    });

    it('drops a generic predicate when its source relation semantics are missing', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            observedEntityId: 'tech-a',
            observedEntityName: 'Tech A',
            observedEntityType: 'technology',
            exploredEntityId: 'company-b',
            exploredEntityName: 'Company B',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['RELATED_TO'],
            sourceRelationTypes: [null],
          },
        ])
      );

      await expect(findDotConnections('tech-a', 'user-abc')).resolves.toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // connectDots
  // --------------------------------------------------------------------------

  describe('connectDots', () => {
    it('reads observation and finds dot connections', async () => {
      // Mock observation lookup
      mockedReadTransaction
        .mockResolvedValueOnce(
          createMockQueryResult([
            {
              entityId: 'tech-quantum',
              title: 'Quantum breakthrough',
              summary: 'New quantum processor announced.',
              type: 'discovery',
              agentName: 'scout',
              confidence: 0.9,
            },
          ])
        )
        // Mock findDotConnections
        .mockResolvedValueOnce(createMockQueryResult([]));

      const result = await connectDots('obs-123', 'user-abc');

      // First read: observation lookup
      expect(mockedReadTransaction).toHaveBeenCalledTimes(2);
      const [obsCypher, obsParams] = mockedReadTransaction.mock.calls[0];
      expect(obsCypher).toContain('MATCH (obs:AgentObservation { id: $observationId })');
      expect(obsParams.observationId).toBe('obs-123');

      expect(result.userId).toBe('user-abc');
      expect(result.observationId).toBe('obs-123');
    });

    it('creates ProactiveInsight for connections with relevanceScore >= threshold', async () => {
      // Mock observation lookup
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Quantum breakthrough',
            summary: 'New processor.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );

      // Mock findDotConnections - pathLength 1 => score 0.9 (above threshold)
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'comp-ibm',
            exploredEntityName: 'IBM',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['VENDOR'],
          },
        ])
      );

      // Mock insight creation
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await connectDots('obs-123', 'user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      // Verify MERGE-based insight creation Cypher (dedupe on dedupeKey,
      // not CREATE) — re-running the same sweep should not double-create.
      expect(cypher).toContain('MERGE (pi:ProactiveInsight { dedupeKey: $dedupeKey })');
      expect(cypher).toContain("pi.type = 'connection'");
      expect(cypher).toContain('MERGE (pi)-[:ABOUT]->(observed)');
      expect(cypher).toContain('MERGE (pi)-[:ABOUT]->(explored)');
      expect(cypher).toContain('pi.epistemicKind = $epistemicKind');
      expect(cypher).toContain("pi.groundingVersion = 'predicate-path-v1'");
      expect(cypher).toContain('pi.evidenceRelationIds = $evidenceRelationIds');
      expect(cypher).toContain('pi.relationshipDirections = $relationshipDirections');

      // 2.1 label-integrity fix: `consumed = false` is set ONLY on create
      // (new insights start unconsumed); the ON MATCH branch must NOT reset it,
      // or a re-discovering sweep would resurface an insight the user dismissed.
      // Exactly one occurrence (ON CREATE) — two would mean the reset crept back.
      expect((cypher.match(/pi\.consumed = false/g) ?? []).length).toBe(1);
      expect(cypher).toContain('ON CREATE SET');
      expect(cypher.slice(cypher.indexOf('ON MATCH SET'))).not.toContain('pi.consumed = false');

      // Verify insight parameters
      expect(params.userId).toBe('user-abc');
      expect(params.agentName).toBe('scout');
      expect(params.observedEntityId).toBe('tech-quantum');
      expect(params.exploredEntityId).toBe('comp-ibm');
      // 2026-05-12: dedupeKey locks insights against re-creation on every sweep.
      expect(params.dedupeKey).toBe('user-abc::tech-quantum::comp-ibm');
      expect(params.epistemicKind).toBe('observation');
      expect(params.evidenceRelationIds).toEqual(['rel-0-0']);
      expect(params.evidenceAssertedBy).toEqual(['user:user-abc']);
      expect(params.evidenceEdgeConfidences).toEqual([100]);
      expect(params.sourceRelationTypes).toEqual(['vendor']);
      expect(params.relationshipDirections).toEqual(['forward']);
      // min(observation.confidence=0.9, relevanceScore=0.9 for 1-hop) = 0.9
      expect(params.confidenceScore).toBe(0.9);

      expect(result.insightsCreated).toBe(1);
      expect(result.connections).toHaveLength(1);
    });

    it('skips connections with relevanceScore < threshold (3+ hop paths)', async () => {
      // Mock observation lookup
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Quantum breakthrough',
            summary: 'New processor.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );

      // pathLength 3 — too indirect to be a real connection after the
      // 2026-05-12 tightening. Scores to 0 and is filtered out.
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'tech-distant',
            exploredEntityName: 'Distant Tech',
            exploredEntityType: 'technology',
            pathLength: 3,
            relationshipTypes: ['USES', 'ENABLES', 'COMPETES_WITH'],
          },
        ])
      );

      const result = await connectDots('obs-123', 'user-abc');

      // Should NOT create any insights
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
      expect(result.insightsCreated).toBe(0);
      expect(result.connections).toEqual([]);
    });

    it('returns empty result when observation not found', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const result = await connectDots('obs-nonexistent', 'user-abc');

      expect(result).toEqual({
        userId: 'user-abc',
        observationId: 'obs-nonexistent',
        connections: [],
        insightsCreated: 0,
      });

      // Should only make one read call (observation lookup) and no write calls
      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('generates correct title and summary for insights', async () => {
      // Mock observation lookup
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Quantum breakthrough',
            summary: 'New processor.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );

      // Mock findDotConnections
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'comp-ibm',
            exploredEntityName: 'IBM',
            exploredEntityType: 'company',
            pathLength: 2,
            relationshipTypes: ['VENDOR', 'USES'],
          },
        ])
      );

      // Mock insight creation
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await connectDots('obs-123', 'user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];

      expect(params.title).toBe('Possible connection: Quantum Computing and IBM');
      expect(params.summary).toBe(
        'Inference (graph-path hypothesis): Quantum Computing and IBM are connected by this reviewed two-hop path: technology "Quantum Computing" -[VENDOR]-> technology "Intermediate 1" -[USES]-> company "IBM". This establishes graph proximity only, not a direct relationship or business action.'
      );
    });

    it('persists direction and source semantics for a generic predicate in a two-hop inference', async () => {
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-a',
            title: 'Update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-a',
            observedEntityName: 'Quantum Platform',
            observedEntityType: 'technology',
            exploredEntityId: 'company-b',
            exploredEntityName: 'Supplier Labs',
            exploredEntityType: 'company',
            pathLength: 2,
            relationshipTypes: ['ALIGNS_WITH', 'RELATED_TO'],
            sourceRelationTypes: ['aligns_with', 'supplier_of'],
            relationIds: ['rel-align', 'rel-supplier'],
            assertedBy: ['user:user-abc', 'user:user-abc'],
            claimStatuses: ['curated', 'curated'],
            pathNodeIds: ['tech-a', 'strategy-mid', 'company-b'],
            pathNodeNames: ['Quantum Platform', 'Quantum Strategy', 'Supplier Labs'],
            pathNodeTypes: ['technology', 'strategy', 'company'],
            relationshipStartIds: ['tech-a', 'company-b'],
            relationshipEndIds: ['strategy-mid', 'strategy-mid'],
          },
        ])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await connectDots('obs-123', 'user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.epistemicKind).toBe('inference');
      expect(params.sourceRelationTypes).toEqual(['aligns_with', 'supplier_of']);
      expect(params.relationshipDirections).toEqual(['forward', 'reverse']);
      expect(params.evidenceNodeIds).toEqual(['tech-a', 'strategy-mid', 'company-b']);
      expect(params.evidenceSummary).toContain(
        'technology "Quantum Platform" -[ALIGNS_WITH]-> strategy "Quantum Strategy" <-[SUPPLIER_OF]- company "Supplier Labs"'
      );
      expect(params.summary).toContain('This establishes graph proximity only');
      expect(params.confidenceScore).toBe(0.5);
    });

    it('persists curated two-hop counter-evidence at its honest 0.35 ceiling', async () => {
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-a',
            title: 'Update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.95,
          },
        ])
      );
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-a',
            observedEntityName: 'Tech A',
            observedEntityType: 'technology',
            exploredEntityId: 'tech-c',
            exploredEntityName: 'Tech C',
            exploredEntityType: 'technology',
            pathLength: 2,
            relationshipTypes: ['USES', 'COMPETES_WITH'],
            sourceRelationTypes: ['uses', 'competes_with'],
          },
        ])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await connectDots('obs-123', 'user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      expect(params.epistemicKind).toBe('inference');
      expect(params.hasCounterEvidence).toBe(true);
      expect(params.confidenceScore).toBe(0.35);
      expect(params.summary).toContain('competition or conflict semantics');
    });

    it('computes confidenceScore as min of observation confidence and relevance', async () => {
      // Mock observation with low confidence
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Quantum update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.4,
          },
        ])
      );

      // Mock findDotConnections - pathLength 1 => relevance 0.5
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'comp-ibm',
            exploredEntityName: 'IBM',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['VENDOR'],
          },
        ])
      );

      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await connectDots('obs-123', 'user-abc');

      const [, params] = mockedWriteTransaction.mock.calls[0];
      // min(0.4, 0.5) = 0.4
      expect(params.confidenceScore).toBe(0.4);
    });

    it('does not persist a curated path whose weakest edge has confidence 10', async () => {
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-a',
            title: 'Update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-a',
            observedEntityName: 'Tech A',
            observedEntityType: 'technology',
            exploredEntityId: 'company-b',
            exploredEntityName: 'Company B',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['VENDOR'],
            edgeConfidences: [10],
          },
        ])
      );

      const result = await connectDots('obs-123', 'user-abc');

      expect(result.connections[0].relevanceScore).toBe(0.1);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
      expect(result.insightsCreated).toBe(0);
    });

    it('continues processing when individual insight creation fails', async () => {
      // Mock observation lookup
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Quantum update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );

      // Mock findDotConnections - two connections above threshold
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'comp-ibm',
            exploredEntityName: 'IBM',
            exploredEntityType: 'company',
            pathLength: 1,
            relationshipTypes: ['VENDOR'],
          },
          {
            observedEntityId: 'tech-quantum',
            observedEntityName: 'Quantum Computing',
            observedEntityType: 'technology',
            exploredEntityId: 'comp-google',
            exploredEntityName: 'Google',
            exploredEntityType: 'company',
            pathLength: 2,
            relationshipTypes: ['VENDOR', 'PARTNER'],
          },
        ])
      );

      // First insight fails, second succeeds
      mockedWriteTransaction
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce(createMockQueryResult([]));

      const result = await connectDots('obs-123', 'user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
      expect(result.insightsCreated).toBe(1);
      expect(result.connections).toHaveLength(2);
    });

    it('throws when observation read fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));

      await expect(connectDots('obs-123', 'user-abc')).rejects.toThrow('Read failed');
    });

    it('uses custom maxHops when provided', async () => {
      // Mock observation lookup
      mockedReadTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            entityId: 'tech-quantum',
            title: 'Update',
            summary: 'Update.',
            type: 'discovery',
            agentName: 'scout',
            confidence: 0.9,
          },
        ])
      );

      // Mock findDotConnections
      mockedReadTransaction.mockResolvedValueOnce(createMockQueryResult([]));

      await connectDots('obs-123', 'user-abc', 5);

      // Second read call is findDotConnections - verify maxHops in Cypher
      const [cypher] = mockedReadTransaction.mock.calls[1];
      expect(cypher).toContain('*1..5');
    });

    // -----------------------------------------------------------------------
    // Structured path data
    //
    // The MERGE must persist `relationshipTypes`, `pathLength`, `exploredAt`
    // on the :ProactiveInsight node so the detail-page "Why am I seeing
    // this?" breadcrumb can render without re-parsing the human-readable
    // summary string. All three live under SET (not ON CREATE) so refreshed
    // insights pick up the latest values.
    // -----------------------------------------------------------------------
    describe('A.0 structured path data', () => {
      it('persists relationshipTypes, pathLength, exploredAt on the insight node', async () => {
        mockedReadTransaction.mockResolvedValueOnce(
          createMockQueryResult([
            {
              entityId: 'tech-quantum',
              title: 'Quantum',
              summary: 'New processor.',
              type: 'discovery',
              agentName: 'scout',
              confidence: 0.9,
            },
          ])
        );
        mockedReadTransaction.mockResolvedValueOnce(
          createMockQueryResult([
            {
              observedEntityId: 'tech-quantum',
              observedEntityName: 'Quantum Computing',
              observedEntityType: 'technology',
              exploredEntityId: 'comp-ibm',
              exploredEntityName: 'IBM',
              exploredEntityType: 'company',
              pathLength: 2,
              relationshipTypes: ['VENDOR', 'USES'],
              exploredAt: '2026-05-10T12:00:00.000Z',
            },
          ])
        );
        mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

        await connectDots('obs-123', 'user-abc');

        const [cypher, params] = mockedWriteTransaction.mock.calls[0];

        // SET clauses for the three new properties — single source of truth
        // for the detail-page breadcrumb.
        expect(cypher).toContain('pi.relationshipTypes = $relationshipTypes');
        expect(cypher).toContain('pi.pathLength = $pathLength');
        expect(cypher).toContain('pi.exploredAt = $exploredAt');

        // Parameter values flow through unchanged from the path record.
        expect(params.relationshipTypes).toEqual(['VENDOR', 'USES']);
        expect(params.pathLength).toBe(2);
        expect(params.exploredAt).toBe('2026-05-10T12:00:00.000Z');
      });

      it('writes exploredAt as null when no EXPLORED edge carried a timestamp', async () => {
        mockedReadTransaction.mockResolvedValueOnce(
          createMockQueryResult([
            {
              entityId: 'tech-quantum',
              title: 'Quantum',
              summary: 'New processor.',
              type: 'discovery',
              agentName: 'scout',
              confidence: 0.9,
            },
          ])
        );
        mockedReadTransaction.mockResolvedValueOnce(
          createMockQueryResult([
            {
              observedEntityId: 'tech-quantum',
              observedEntityName: 'Quantum Computing',
              observedEntityType: 'technology',
              exploredEntityId: 'comp-ibm',
              exploredEntityName: 'IBM',
              exploredEntityType: 'company',
              pathLength: 1,
              relationshipTypes: ['VENDOR'],
              exploredAt: null,
            },
          ])
        );
        mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

        await connectDots('obs-123', 'user-abc');

        const [, params] = mockedWriteTransaction.mock.calls[0];
        // Null flows through verbatim — Neo4j stores it as a missing property.
        // The read-side mapping turns missing property back into `undefined`.
        expect(params.exploredAt).toBeNull();
      });
    });
  });
});
