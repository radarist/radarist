/**
 * Tests for reconcile-firestore-neo4j.ts
 * Automated reconciliation job that ensures Firestore and Neo4j stay in sync
 *
 * Tests cover:
 * - reconcileFirestoreNeo4jJob: Cron-based reconciliation (every 15 min)
 * - fullSyncJob: Full backfill / disaster recovery sync
 *
 * (triggerReconciliationJob was deleted 2026-06-10 — zero senders and a
 * no-op body.)
 */

// Admin-SDK fake. The reconciler calls both db.collection(name).get() and
// db.collection(name).select().get(); route both shapes into the same
// per-collection mock so each step's snapshot is controllable.
const mockCollectionGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => ({
      get: () => mockCollectionGet(name),
      select: () => ({
        get: () => mockCollectionGet(name),
      }),
    }),
  },
}));

jest.mock('@/lib/graph/signal-projection-policy-admin', () => ({
  loadEligibleSignalProjectionIds: jest.fn(async () => {
    const snapshot = await mockCollectionGet('signals');
    return snapshot.docs.map((document: { id: string }) => document.id);
  }),
}));

// Mock the graph module
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

// Step 16 (fix-orphan-edges) dynamically imports '@/lib/graph/neo4j-client' directly
// (bypassing the '@/lib/graph' barrel mocked above) to run its own orphan-fix Cypher.
// Left unmocked, this reaches the REAL neo4j-driver singleton, which retries a bolt
// connection for tens of seconds when Neo4j isn't running locally — well past Jest's
// 5s per-test timeout, hanging every `reconcileFirestoreNeo4jJob` test.
jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn().mockResolvedValue({ records: [{ fixed: 0 }] }),
}));

jest.mock('@/lib/graph/projection-reconciliation-runner', () => ({
  runProjectionReconciliationCycle: jest.fn(),
}));

// GRAPH-061: the cycle also sweeps verifier verdicts whose target is gone.
// Mocked so the sweep's own Cypher does not leak into the structural
// safety-net query assertions below — its contract is pinned by
// graph/__tests__/verification.test.ts and the trust-boundary integration.
jest.mock('@/lib/graph/verification', () => ({
  reconcileOrphanedVerificationResults: jest.fn(async () => ({
    entityResultsDeleted: 0,
    edgeResultsDeleted: 0,
  })),
}));

// Mock the inngest client
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      return {
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>, eventId = 'reconcile-run-1') {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
            sleep: jest.fn(),
          };
          const result = await handler({ event: { id: eventId, data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn(),
  },
}));

import { checkHealth, runReadTransaction } from '@/lib/graph';
import { runWriteTransaction as runStructuralRepair } from '@/lib/graph/neo4j-client';
import { runProjectionReconciliationCycle } from '@/lib/graph/projection-reconciliation-runner';
import { inngest } from '../client';
import { reconcileFirestoreNeo4jJob, fullSyncJob } from '../functions/reconcile-firestore-neo4j';
import { STRUCTURAL_EDGE_REPAIRS } from '../functions/structural-edge-repairs';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create a mock Firestore query snapshot
 */
type MockFirestoreRow = string | { id: string; data?: Record<string, unknown> };

function createMockFirestoreSnapshot(rows: MockFirestoreRow[]) {
  return {
    size: rows.length,
    docs: rows.map((row) => ({
      id: typeof row === 'string' ? row : row.id,
      data: () => (typeof row === 'string' ? {} : (row.data ?? {})),
    })),
  };
}

/**
 * Create a mock Neo4j read transaction result
 */
function createMockNeo4jResult<T>(records: T[]) {
  return {
    records,
    summary: {
      counters: { nodesCreated: 0, relationshipsCreated: 0 },
    },
  };
}

/**
 * Map of collection names to their Firestore IDs (defaults for tests).
 * Neo4j IDs can be separately controlled via runReadTransaction mocks.
 */
const DEFAULT_COLLECTION_IDS: Record<string, string[]> = {
  companies: ['comp-1', 'comp-2'],
  technologies: ['tech-1'],
  strategies: ['strat-1'],
  painPoints: ['pp-1'],
  'use-cases': ['uc-1'],
  documents: ['doc-1'],
  signals: ['sig-1', 'sig-2'],
  'org-units': ['ou-1'],
  initiatives: ['init-1'],
  prototypes: ['proto-1'],
  radarPlacements: ['rp-1'],
  concepts: ['concept-1'],
  relations: ['rel-1', 'rel-2'],
};

/**
 * Setup Firestore mock to return per-collection snapshots through the
 * admin-SDK shape `db.collection(name).get()`.
 */
function setupFirestoreMock(overrides: Record<string, MockFirestoreRow[]> = {}) {
  const collectionData = { ...DEFAULT_COLLECTION_IDS, ...overrides };

  mockCollectionGet.mockImplementation((name: string) => {
    const ids = collectionData[name] || [];
    return Promise.resolve(createMockFirestoreSnapshot(ids));
  });
}

function setupOnlyRadarFirestore(radarId: string, updatedAt: number) {
  const emptyCollections = Object.fromEntries(
    Object.keys(DEFAULT_COLLECTION_IDS).map((collection) => [collection, []])
  ) as Record<string, MockFirestoreRow[]>;
  setupFirestoreMock({
    ...emptyCollections,
    radars: [{ id: radarId, data: { createdAt: updatedAt, updatedAt } }],
  });
}

/**
 * Setup Neo4j runReadTransaction mock to return IDs for label queries
 * and counts for count queries.
 *
 * @param neo4jIds - Maps Neo4j label to the IDs present in Neo4j
 */
function setupNeo4jMock(neo4jIds: Record<string, string[]> = {}, radarVersions: Record<string, number | null> = {}) {
  (runReadTransaction as jest.Mock).mockImplementation((cypher: string) => {
    // Count query: MATCH (n:Label) RETURN count(n) as count
    const countMatch = cypher.match(/MATCH \(n:(\w+)\) RETURN count\(n\) as count/);
    if (countMatch) {
      const label = countMatch[1];
      const ids = neo4jIds[label] || [];
      return Promise.resolve(createMockNeo4jResult([{ count: ids.length }]));
    }

    if (cypher.includes('MATCH (radar:Radar) RETURN radar.id AS id, radar.updatedAt AS updatedAt')) {
      const ids = neo4jIds.Radar || [];
      return Promise.resolve(createMockNeo4jResult(ids.map((id) => ({ id, updatedAt: radarVersions[id] ?? null }))));
    }

    if (cypher.includes('MATCH (placement:RadarPlacement)-[:ON_RADAR]->(:Radar)')) {
      const ids = neo4jIds.RadarPlacementComplete ?? neo4jIds.RadarPlacement ?? [];
      return Promise.resolve(createMockNeo4jResult(ids.map((id) => ({ id }))));
    }

    // IDs query: MATCH (n:Label) RETURN n.id as id
    const idsMatch = cypher.match(/MATCH \(n:(\w+)\) RETURN n\.id as id/);
    if (idsMatch) {
      const label = idsMatch[1];
      const ids = neo4jIds[label] || [];
      return Promise.resolve(createMockNeo4jResult(ids.map((id) => ({ id }))));
    }

    // Relations count query
    if (cypher.includes('RETURN count(r) as count')) {
      const relCount = neo4jIds['_relations'] || [];
      return Promise.resolve(createMockNeo4jResult([{ count: relCount.length }]));
    }

    // Relation IDs query (returns relationId)
    if (cypher.includes('RETURN r.relationId as relationId')) {
      const relIds = neo4jIds['_relationIds'] || [];
      return Promise.resolve(createMockNeo4jResult(relIds.map((id) => ({ relationId: id }))));
    }

    // Default empty result
    return Promise.resolve(createMockNeo4jResult([]));
  });
}

// ============================================================================
// TYPE FOR EXECUTE
// ============================================================================

type ExecutableJob = {
  config: Record<string, unknown>;
  trigger: Record<string, unknown>;
  execute: (
    data: Record<string, unknown>,
    eventId?: string
  ) => Promise<{
    result: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>;
};

// ============================================================================
// TESTS
// ============================================================================

describe('reconcile-firestore-neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['accepted-event'] });
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    setupFirestoreMock();
    setupNeo4jMock();
    (runProjectionReconciliationCycle as jest.Mock).mockResolvedValue({
      syncsTriggered: 0,
      repairsApplied: 0,
      errors: [],
      repairPlan: { planHash: 'a'.repeat(64) },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GRAPH_RECONCILIATION_LEGACY_MODE;
  });

  // ==========================================================================
  // reconcileFirestoreNeo4jJob
  // ==========================================================================

  describe('reconcileFirestoreNeo4jJob', () => {
    const job = reconcileFirestoreNeo4jJob as unknown as ExecutableJob;

    it('should be configured correctly', () => {
      expect(job.config).toMatchObject({
        id: 'reconcile-firestore-neo4j',
        retries: 2,
        concurrency: { limit: 1 },
      });
      expect(job.trigger).toMatchObject({ cron: '*/15 * * * *' });
    });

    it('uses the fair cursor runner by default and preserves the structural repair phase', async () => {
      const { result, steps } = await job.execute({});

      expect(result.success).toBe(true);
      expect(runProjectionReconciliationCycle).toHaveBeenCalledTimes(1);
      expect(steps).toHaveProperty('check-neo4j-health-v1');
      expect(steps).toHaveProperty('reconcile-projections-v1');
      expect(steps).toHaveProperty('fix-orphan-edges-v1');
      expect((result.report as { repairsApplied: number }).repairsApplied).toBe(0);
    });

    it('stamps required temporal and confidence metadata on every structural safety-net edge', async () => {
      await job.execute({});

      const queries = (runStructuralRepair as jest.Mock).mock.calls.map(([cypher]) => cypher as string);
      expect(queries).toEqual(STRUCTURAL_EDGE_REPAIRS.map(({ cypher }) => cypher));
    });

    it('replays the structural safety net without changing its query contract', async () => {
      let invocation = 0;
      (runStructuralRepair as jest.Mock).mockImplementation(async () => ({
        records: [{ fixed: invocation++ < STRUCTURAL_EDGE_REPAIRS.length ? 1 : 0 }],
      }));

      const first = await job.execute({});
      const replay = await job.execute({});

      expect(first.steps['fix-orphan-edges-v1']).toEqual({ orphanEdgesFixed: 6 });
      expect(replay.steps['fix-orphan-edges-v1']).toEqual({ orphanEdgesFixed: 0 });
      const queries = (runStructuralRepair as jest.Mock).mock.calls.map(([cypher]) => cypher as string);
      expect(queries.slice(0, 6)).toEqual(queries.slice(6));
    });
  });

  // ==========================================================================
  // fullSyncJob
  // ==========================================================================

  describe('fullSyncJob', () => {
    const job = fullSyncJob as unknown as ExecutableJob;

    it('should be configured correctly', () => {
      expect(job.config).toMatchObject({
        id: 'full-sync-firestore-neo4j',
        retries: 1,
      });
      expect(job.trigger).toMatchObject({ event: 'app/full-sync.requested' });
    });

    it('should throw error when Neo4j is not healthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue({
        healthy: false,
        error: 'Unreachable',
      });

      await expect(job.execute({ phase: 'all' })).rejects.toThrow('Neo4j not healthy: Unreachable');
    });

    it('should sync all entity types in entities phase', async () => {
      // All entities missing from Neo4j
      setupNeo4jMock({
        Company: [],
        Technology: [],
        Strategy: [],
        PainPoint: [],
        UseCase: [],
        Signal: [],
        OrgUnit: [],
        Initiative: [],
        Prototype: [],
        Document: [],
        RadarPlacement: [],
        Concept: [],
      });

      const { result } = await job.execute({ phase: 'entities' });

      expect(result.success).toBe(true);
      // Total: 2 companies + 1 tech + 1 strat + 1 pp + 1 uc + 2 signals + 1 ou + 1 init + 1 proto + 1 doc + 1 rp + 1 concept = 14
      expect(result.entitiesSynced).toBe(14);
    });

    it('should include standalone Radars in the full entity sync', async () => {
      setupOnlyRadarFirestore('radar-full-sync', 500);
      setupNeo4jMock({ Radar: [] });

      const { result } = await job.execute({ phase: 'entities' });

      expect(result.success).toBe(true);
      expect(result.entitiesSynced).toBe(1);
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/radar.sync.requested',
          data: {
            radarId: 'radar-full-sync',
            sourceUpdatedAt: 500,
            dispatchKey: 'full-sync:reconcile-run-1',
          },
        })
      );
    });

    it('should sync only relations in relations phase', async () => {
      setupNeo4jMock({
        _relationIds: ['rel-1'], // rel-2 is missing
      });

      const { result } = await job.execute({ phase: 'relations' });

      expect(result.success).toBe(true);
      expect(result.relationsSynced).toBe(1);
      expect(result.entitiesSynced).toBe(0);

      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/relation.sync.requested',
          data: expect.objectContaining({
            operation: 'create',
            relationId: 'rel-2',
          }),
        })
      );
    });

    it('should sync both entities and relations in all phase', async () => {
      // Some entities missing
      setupNeo4jMock({
        Company: ['comp-1'], // comp-2 missing
        Technology: ['tech-1'],
        Strategy: ['strat-1'],
        PainPoint: ['pp-1'],
        UseCase: ['uc-1'],
        Signal: ['sig-1', 'sig-2'],
        OrgUnit: ['ou-1'],
        Initiative: ['init-1'],
        Prototype: ['proto-1'],
        Document: ['doc-1'],
        RadarPlacement: ['rp-1'],
        Concept: ['concept-1'],
        _relationIds: ['rel-1'], // rel-2 missing
      });

      const { result } = await job.execute({ phase: 'all' });

      // 1 entity + 1 relation
      expect(result.entitiesSynced).toBe(1);
      expect(result.relationsSynced).toBe(1);
    });

    it('should default to phase all when no phase specified', async () => {
      setupNeo4jMock({
        Company: ['comp-1', 'comp-2'],
        Technology: ['tech-1'],
        Strategy: ['strat-1'],
        PainPoint: ['pp-1'],
        UseCase: ['uc-1'],
        Signal: ['sig-1', 'sig-2'],
        OrgUnit: ['ou-1'],
        Initiative: ['init-1'],
        Prototype: ['proto-1'],
        Document: ['doc-1'],
        RadarPlacement: ['rp-1'],
        Concept: ['concept-1'],
        _relations: ['rel-1', 'rel-2'],
        _relationIds: ['rel-1', 'rel-2'],
      });

      const { result } = await job.execute({});

      expect(result.success).toBe(true);
    });

    it('should handle sync errors without failing the entire job', async () => {
      setupNeo4jMock({
        Company: [], // both missing
        Technology: ['tech-1'],
        Strategy: ['strat-1'],
        PainPoint: ['pp-1'],
        UseCase: ['uc-1'],
        Signal: ['sig-1', 'sig-2'],
        OrgUnit: ['ou-1'],
        Initiative: ['init-1'],
        Prototype: ['proto-1'],
        Document: ['doc-1'],
        RadarPlacement: ['rp-1'],
        Concept: ['concept-1'],
      });

      // First call succeeds, second fails
      (inngest.send as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Queue full'));

      const { result } = await job.execute({ phase: 'entities' });

      // Should not throw but success = false due to errors
      expect(result.success).toBe(false);
      expect(result.entitiesSynced).toBe(1);
      expect((result.errors as string[]).length).toBe(1);
      expect((result.errors as string[])[0]).toContain('company');
    });

    it('should use custom batch sizes', async () => {
      setupNeo4jMock({
        Company: ['comp-1', 'comp-2'],
        Technology: ['tech-1'],
        Strategy: ['strat-1'],
        PainPoint: ['pp-1'],
        UseCase: ['uc-1'],
        Signal: ['sig-1', 'sig-2'],
        OrgUnit: ['ou-1'],
        Initiative: ['init-1'],
        Prototype: ['proto-1'],
        Document: ['doc-1'],
        RadarPlacement: ['rp-1'],
        Concept: ['concept-1'],
        _relations: ['rel-1', 'rel-2'],
        _relationIds: ['rel-1', 'rel-2'],
      });

      const { result } = await job.execute({
        phase: 'all',
        entityBatchSize: 10,
        relationBatchSize: 100,
      });

      expect(result.success).toBe(true);
    });

    it('should trigger dedicated sync events for special entity types', async () => {
      // Technology uses app/technology.sync.requested
      // Document uses app/document.sync.requested
      // RadarPlacement uses app/radar-placement.sync.requested
      // Concept uses app/concept.sync.requested
      setupNeo4jMock({
        Company: ['comp-1', 'comp-2'],
        Technology: [], // missing
        Strategy: ['strat-1'],
        PainPoint: ['pp-1'],
        UseCase: ['uc-1'],
        Signal: ['sig-1', 'sig-2'],
        OrgUnit: ['ou-1'],
        Initiative: ['init-1'],
        Prototype: ['proto-1'],
        Document: [], // missing
        RadarPlacement: [], // missing
        Concept: [], // missing
        _relations: ['rel-1', 'rel-2'],
        _relationIds: ['rel-1', 'rel-2'],
      });

      const { result } = await job.execute({ phase: 'entities' });

      expect(result.success).toBe(true);
      expect(result.entitiesSynced).toBe(4);

      const sendCalls = (inngest.send as jest.Mock).mock.calls.map((c) => c[0]);

      // Technology uses dedicated sync event
      expect(sendCalls).toContainEqual(
        expect.objectContaining({
          name: 'app/technology.sync.requested',
          data: expect.objectContaining({ technologyId: 'tech-1' }),
        })
      );

      // Documents use dedicated document sync
      expect(sendCalls).toContainEqual(
        expect.objectContaining({
          name: 'app/document.sync.requested',
          data: expect.objectContaining({ documentId: 'doc-1' }),
        })
      );

      // RadarPlacements use dedicated placement sync
      expect(sendCalls).toContainEqual(
        expect.objectContaining({
          name: 'app/radar-placement.sync.requested',
          data: expect.objectContaining({ placementId: 'rp-1' }),
        })
      );

      // Concepts use dedicated concept sync
      expect(sendCalls).toContainEqual(
        expect.objectContaining({
          name: 'app/concept.sync.requested',
          data: expect.objectContaining({ conceptId: 'concept-1' }),
        })
      );
    });
  });
});
