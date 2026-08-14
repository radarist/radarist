/**
 * @jest-environment node
 */

// ============================================================================
// Mocks — must be declared before imports
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));

// Mock neo4j-client
const mockRunReadTransaction = jest.fn();
jest.mock('@/lib/graph/neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
}));

// Mock cypher-templates
jest.mock('@/lib/graph/cypher-templates', () => ({
  __esModule: true,
  GET_GRAPH_STATS: 'MOCK_GET_GRAPH_STATS',
  GET_RELATIONSHIP_STATS: 'MOCK_GET_RELATIONSHIP_STATS',
}));

// Mock graph/claims
const mockGetClaimStats = jest.fn();
jest.mock('@/lib/graph/assertions', () => ({
  __esModule: true,
  getAssertionStats: (...args: unknown[]) => mockGetClaimStats(...args),
}));

// Mock firebase-admin
const mockCollection = jest.fn();
const _mockSelect = jest.fn();
const mockLimit = jest.fn();
const mockGet = jest.fn();
const mockCount = jest.fn();
// 2.3 — per-status counts for `.where('status','==',value).count().get()`.
let statusCounts: Record<string, number> = {};
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: (...args: unknown[]) => mockCollection(...args),
  },
}));

// ============================================================================
// Imports
// ============================================================================

import neo4j from 'neo4j-driver';

import {
  ANALYTICS_TOOLS,
  executeGetGraphAnalytics,
  executeGetClaimHealth,
  executeFindDataGaps,
} from '../analytics-tools';

// ============================================================================
// Tests
// ============================================================================

describe('Analytics Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default firebase-admin chain
    statusCounts = {};
    mockCollection.mockReturnValue({
      count: () => ({ get: mockCount }),
      select: (..._args: unknown[]) => ({ limit: mockLimit, get: mockGet }),
      where: (_field: string, _op: string, value: string) => ({
        count: () => ({ get: () => Promise.resolve({ data: () => ({ count: statusCounts[value] ?? 0 }) }) }),
      }),
    });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  // --------------------------------------------------------------------------
  // Tool Declarations
  // --------------------------------------------------------------------------

  describe('ANALYTICS_TOOLS declarations', () => {
    it('should export exactly 3 tools', () => {
      expect(ANALYTICS_TOOLS).toHaveLength(3);
    });

    it('should define getGraphAnalytics', () => {
      const tool = ANALYTICS_TOOLS.find((t) => t.name === 'getGraphAnalytics');
      expect(tool).toBeDefined();
      expect(tool!.description).toBeTruthy();
    });

    it('should define getClaimHealth', () => {
      const tool = ANALYTICS_TOOLS.find((t) => t.name === 'getClaimHealth');
      expect(tool).toBeDefined();
      expect(tool!.description).toBeTruthy();
    });

    it('should define findDataGaps', () => {
      const tool = ANALYTICS_TOOLS.find((t) => t.name === 'findDataGaps');
      expect(tool).toBeDefined();
      expect(tool!.description).toBeTruthy();
    });

    it('should have findDataGaps with optional limit parameter', () => {
      const tool = ANALYTICS_TOOLS.find((t) => t.name === 'findDataGaps');
      const props = tool!.parameters?.properties as Record<string, unknown>;
      expect(props).toHaveProperty('limit');
    });

    it('should not require any parameters for getGraphAnalytics and getClaimHealth', () => {
      for (const name of ['getGraphAnalytics', 'getClaimHealth']) {
        const tool = ANALYTICS_TOOLS.find((t) => t.name === name);
        // No required array, or empty
        expect(tool!.parameters?.required).toBeUndefined();
      }
    });
  });

  // --------------------------------------------------------------------------
  // executeGetGraphAnalytics
  // --------------------------------------------------------------------------

  describe('executeGetGraphAnalytics', () => {
    it('returns entity counts from Firestore (canonical) and relation breakdown from Neo4j', async () => {
      // Entity counts now come from Firestore — the canonical library source —
      // not Neo4j (which over-counts due to approve-then-link orphans). Each of
      // the 9 entity collections returns 5 here.
      mockCount.mockResolvedValue({ data: () => ({ count: 5 }) });
      // Neo4j is consulted only for the per-type relation breakdown.
      mockRunReadTransaction.mockResolvedValueOnce({
        records: [
          { relationType: 'USES', count: 12 },
          { relationType: 'SOLVES', count: 5 },
        ],
      });

      const result = await executeGetGraphAnalytics();

      expect(result.entityCounts.companies).toBe(5);
      expect(result.totalEntities).toBe(45); // 9 collections × 5
      expect(result.relationCounts).toEqual({ USES: 12, SOLVES: 5 });
      expect(result.totalRelations).toBe(17); // Neo4j overlay wins over Firestore baseline
    });

    it('returns companyStatusDistribution for "% in <status>" questions (2.3)', async () => {
      mockCount.mockResolvedValue({ data: () => ({ count: 100 }) });
      mockRunReadTransaction.mockResolvedValueOnce({ records: [] });
      // Exact per-status company counts (group-by aggregate).
      statusCounts = { Watching: 40, Contacted: 30, Partner: 20, Rejected: 10 };

      const result = await executeGetGraphAnalytics();

      expect(result.companyStatusDistribution).toEqual({
        Watching: 40,
        Contacted: 30,
        Partner: 20,
        Rejected: 10,
      });
      // The model can now compute % = Watching ÷ total companies.
      expect(result.entityCounts.companies).toBe(100);
    });

    it('should fall back to Firestore when Neo4j is unavailable', async () => {
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j connection refused'));

      // Mock Firestore count() calls
      mockCount.mockResolvedValue({ data: () => ({ count: 3 }) });

      const result = await executeGetGraphAnalytics();

      expect(result.totalEntities).toBeGreaterThanOrEqual(0);
      expect(result).toHaveProperty('entityCounts');
      expect(result).toHaveProperty('relationCounts');
      expect(result).toHaveProperty('totalRelations');
    });

    // H3 — the Firestore counts (the PRIMARY entity-count source) used to read
    // collections 'useCases'/'orgUnits' which DO NOT EXIST (real names:
    // 'use-cases'/'org-units') → silent zeros for those entity types.
    it('counts the REAL Firestore collections (use-cases/org-units), not the phantom camelCase names', async () => {
      mockCount.mockResolvedValue({ data: () => ({ count: 5 }) });
      mockRunReadTransaction.mockResolvedValueOnce({ records: [] });

      await executeGetGraphAnalytics();

      const queried = mockCollection.mock.calls.map((c) => c[0] as string);
      expect(queried).toContain('use-cases');
      expect(queried).toContain('org-units');
      expect(queried).toContain('painPoints'); // painPoints IS camelCase in Firestore
      expect(queried).not.toContain('useCases');
      expect(queried).not.toContain('orgUnits');
    });

    it('returns Firestore entity counts even when the Neo4j relation breakdown is empty', async () => {
      mockCount.mockResolvedValue({ data: () => ({ count: 0 }) });
      mockRunReadTransaction.mockResolvedValueOnce({ records: [] }); // empty Neo4j relations

      const result = await executeGetGraphAnalytics();

      expect(result.totalEntities).toBe(0);
      expect(result.relationCounts).toEqual({});
      expect(result.totalRelations).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // executeGetClaimHealth
  // --------------------------------------------------------------------------

  describe('executeGetClaimHealth', () => {
    it('should return claim stats from getAssertionStats()', async () => {
      mockGetClaimStats.mockResolvedValue({
        totalClaims: 42,
        byStatus: { proposed: 20, curated: 15, rejected: 5, derived: 2 },
        avgConfidence: 78.5,
        claimsWithEvidence: 30,
        totalEvidence: 65,
        byAsserterType: { agent: 35, user: 7 },
        topRelationTypes: [{ name: 'USES', count: 18 }],
      });

      const result = await executeGetClaimHealth();

      expect(result.totalClaims).toBe(42);
      expect(result.byStatus).toEqual({ proposed: 20, curated: 15, rejected: 5, derived: 2 });
      expect(result.avgConfidence).toBe(78.5);
      expect(result.claimsWithEvidence).toBe(30);
      expect(result.totalEvidence).toBe(65);
      expect(result.byAsserterType).toEqual({ agent: 35, user: 7 });
      expect(result.topRelationTypes).toEqual([{ name: 'USES', count: 18 }]);
    });

    it('signals unavailability (not zeroed-as-success) when Neo4j is down', async () => {
      mockGetClaimStats.mockRejectedValue(new Error('Neo4j unavailable'));

      const result = await executeGetClaimHealth();

      // A graph outage must be distinguishable from a genuinely empty graph —
      // otherwise "0 claims" reads as fact. Numbers stay zeroed for shape
      // compatibility, but `available:false` + `error` flag the outage.
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.totalClaims).toBe(0);
    });

    it('marks a successful read as available', async () => {
      mockGetClaimStats.mockResolvedValue({
        totalClaims: 3,
        byStatus: { proposed: 1, curated: 2, rejected: 0, derived: 0 },
        avgConfidence: 90,
        claimsWithEvidence: 2,
        totalEvidence: 4,
        byAsserterType: { agent: 2, user: 1 },
        topRelationTypes: [],
      });

      const result = await executeGetClaimHealth();

      expect(result.available).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // executeFindDataGaps
  // --------------------------------------------------------------------------

  describe('executeFindDataGaps', () => {
    it('should return gaps from Neo4j for disconnected entities', async () => {
      mockRunReadTransaction.mockResolvedValue({
        records: [
          { entityId: 'tech-1', entityName: 'Orphan Tech', entityType: 'technology' },
          { entityId: 'company-2', entityName: 'Lonely Corp', entityType: 'company' },
        ],
      });

      const result = await executeFindDataGaps({});

      expect(result.gaps).toHaveLength(2);
      expect(result.gaps[0]).toEqual({
        entityId: 'tech-1',
        entityName: 'Orphan Tech',
        entityType: 'technology',
        issues: ['No relations in knowledge graph'],
      });
      expect(result.totalGaps).toBe(2);
    });

    // H3 — the driver transmits a raw JS number as a FLOAT (20 → 20.0), and
    // Neo4j rejects floats for LIMIT on EVERY call. The limit must be wrapped
    // with neo4j.int().
    it('should respect the limit parameter, wrapped as a Neo4j Integer', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      await executeFindDataGaps({ limit: 5 });

      expect(mockRunReadTransaction).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        expect.objectContaining({ limit: neo4j.int(5) })
      );
    });

    it('should default limit to 20 as a Neo4j Integer', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      await executeFindDataGaps({});

      expect(mockRunReadTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: neo4j.int(20) })
      );
    });

    it('should clamp limit to max 100 as a Neo4j Integer', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      await executeFindDataGaps({ limit: 500 });

      expect(mockRunReadTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: neo4j.int(100) })
      );
    });

    it('should fall back to Firestore when Neo4j is unavailable', async () => {
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j offline'));

      // Mock Firestore responses - entities with missing descriptions
      mockGet.mockResolvedValue({
        docs: [
          {
            id: 'company-1',
            data: () => ({
              name: 'No Desc Inc',
              description: '',
              updatedAt: Date.now(),
            }),
          },
        ],
      });

      const result = await executeFindDataGaps({});

      expect(result.gaps.length).toBeGreaterThanOrEqual(0);
      expect(result).toHaveProperty('totalGaps');
    });

    it('should detect missing descriptions in Firestore fallback', async () => {
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j offline'));

      const freshTimestamp = Date.now();
      mockGet.mockResolvedValue({
        docs: [
          {
            id: 'company-1',
            data: () => ({
              name: 'No Desc Inc',
              description: '',
              updatedAt: freshTimestamp,
            }),
          },
        ],
      });

      const result = await executeFindDataGaps({ limit: 5 });

      const gapsWithMissingDesc = result.gaps.filter((g) => g.issues.includes('Missing description'));
      expect(gapsWithMissingDesc.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect stale entities in Firestore fallback', async () => {
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j offline'));

      const oldTimestamp = Date.now() - 91 * 24 * 60 * 60 * 1000; // 91 days ago
      mockGet.mockResolvedValue({
        docs: [
          {
            id: 'company-old',
            data: () => ({
              name: 'Stale Corp',
              description: 'Has description',
              updatedAt: oldTimestamp,
            }),
          },
        ],
      });

      const result = await executeFindDataGaps({ limit: 5 });

      const staleGaps = result.gaps.filter((g) => g.issues.some((i) => i.includes('Stale')));
      expect(staleGaps.length).toBeGreaterThanOrEqual(1);
    });

    it('scans the REAL use-cases collection in the Firestore fallback (H3)', async () => {
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j offline'));
      mockGet.mockResolvedValue({ docs: [] });

      await executeFindDataGaps({ limit: 20 });

      const queried = mockCollection.mock.calls.map((c) => c[0] as string);
      expect(queried).toContain('use-cases');
      expect(queried).not.toContain('useCases');
    });

    it('writes canonical singular entityType, not the plural collection name (Phase 0 step 0.5)', async () => {
      // Regression: findDataGapsFromFirestore used
      // to write `entityType: col.name` ('companies', 'technologies', …).
      // Those plural strings then failed to match the singular keys in
      // `getInsightAction`, persisting insights with a useless `/library`
      // action URL. The fix: each collection carries its canonical
      // singular entityType. Lock the contract here.
      mockRunReadTransaction.mockRejectedValue(new Error('Neo4j offline'));

      const oldTimestamp = Date.now() - 91 * 24 * 60 * 60 * 1000;
      mockGet.mockResolvedValue({
        docs: [
          {
            id: 'thing-1',
            data: () => ({
              name: 'Anything Stale',
              title: 'Anything Stale',
              description: 'Has description',
              updatedAt: oldTimestamp,
            }),
          },
        ],
      });

      const result = await executeFindDataGaps({ limit: 20 });

      // Each gap must carry a singular entityType, never the plural form.
      const PLURAL_FORMS = ['companies', 'technologies', 'useCases', 'prototypes', 'strategies'];
      const SINGULAR_FORMS = ['company', 'technology', 'useCase', 'prototype', 'strategy'];
      for (const gap of result.gaps) {
        expect(PLURAL_FORMS).not.toContain(gap.entityType);
        expect(SINGULAR_FORMS).toContain(gap.entityType);
      }
    });
  });
});
