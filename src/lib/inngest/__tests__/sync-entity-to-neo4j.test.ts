/**
 * Tests for sync-entity-to-neo4j.ts
 * Unified Inngest job for syncing ALL entity types to Neo4j
 *
 * Tests cover:
 * - syncUnifiedEntityToNeo4jJob: Main single-entity sync handler
 * - batchSyncUnifiedEntitiesToNeo4jJob: Batch sync handler
 * - triggerUnifiedEntitySync / triggerBatchUnifiedEntitySync: Helper functions
 * - Property extraction for all entity types
 * - Implicit relationship building (OrgUnit hierarchy, Initiative ownership, etc.)
 * - Signal relationship mapping (linkedEntities, alignedStrategies, expandedContent)
 */

// Mock firebase to prevent fetch error from Firebase Auth
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

// Mock the admin SDK — the sync function reads via firebase-admin directly
// (the previous per-entity client-SDK service modules hung gRPC streams
// server-side; collapsed into one collection lookup on 2026-05-12). Fixture
// map keyed by `${collectionName}/${id}` so tests can stage per-entity data
// without caring about the resolver internals.
//
// The `mock` prefix on `mockFirestoreFixtures` is required by Jest's
// babel-jest plugin so it can be referenced inside `jest.mock` factories.
const mockFirestoreFixtures = new Map<string, unknown>();
const mockFirestoreBeforeRead = jest.fn();
const mockStepSleep = jest.fn();
const mockReadEntityGraphSyncAnchor = jest.fn();
const mockClearConvergedEntityGraphSyncAnchor = jest.fn();
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  readEntityGraphSyncAnchor: (...args: unknown[]) => mockReadEntityGraphSyncAnchor(...args),
  clearConvergedEntityGraphSyncAnchor: (...args: unknown[]) =>
    mockClearConvergedEntityGraphSyncAnchor(...args),
}));
jest.mock('@/lib/graph/signal-projection-policy-admin', () => ({
  loadSignalProjectionDecision: jest.fn(async () => ({
    eligible: true,
    reason: 'approved-or-imported',
    references: [],
  })),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => ({
      doc: jest.fn((id: string) => ({
        get: jest.fn(async () => {
          const key = `${collectionName}/${id}`;
          await mockFirestoreBeforeRead(key);
          const fixture = mockFirestoreFixtures.get(key);
          return {
            exists: fixture !== undefined,
            data: () => fixture,
          };
        }),
      })),
    })),
  },
}));

// Mock the graph module
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  deleteEntityFromGraph: jest.fn().mockResolvedValue({
    assertionsDeleted: 0,
    evidenceDeleted: 0,
    projectionsDeleted: 0,
    chunksDeleted: 0,
    endpointsDeleted: 1,
  }),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  captureEntityTagConceptIdsFromNeo4j: jest.fn(),
  reconcileEntityTagConcepts: jest.fn(),
  reconcileConceptEntityCounts: jest.fn(),
  projectEntityTagConceptsToNeo4j: jest.fn(),
}));

jest.mock('../initiative-dependent-replay', () => ({
  loadDependentInitiativeIds: jest.fn(),
  buildInitiativeDependencyReplayEvent: jest.fn(
    (_parentEventId: string, _targetType: string, _targetId: string, initiativeId: string) => ({
      id: `initiative-dependency-replay:${initiativeId}`,
      name: 'app/unified-entity.sync.requested',
      data: { operation: 'update', entityType: 'initiative', entityId: initiativeId },
    })
  ),
}));

// Mock inngest client (same pattern as existing tests)
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      return {
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
            sleep: mockStepSleep,
            sendEvent: jest.fn(),
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn(),
  },
}));

import { checkHealth, deleteEntityFromGraph, runWriteTransaction } from '@/lib/graph';
import {
  captureEntityTagConceptIdsFromNeo4j,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
  reconcileEntityTagConcepts,
} from '@/lib/graph/entity-tag-concept-projection';
import { loadDependentInitiativeIds } from '../initiative-dependent-replay';
import { inngest } from '../client';
import {
  syncUnifiedEntityToNeo4jJob,
  batchSyncUnifiedEntitiesToNeo4jJob,
  triggerUnifiedEntitySync,
  triggerBatchUnifiedEntitySync,
} from '../functions/sync-entity-to-neo4j';

// ============================================================================
// HELPERS
// ============================================================================

function createMockNeo4jResult(records: unknown[] = [], relationshipsCreated = 0) {
  return {
    records,
    summary: {
      counters: {
        nodesCreated: records.length > 0 ? 1 : 0,
        nodesDeleted: 0,
        relationshipsCreated,
        propertiesSet: 0,
      },
    },
  };
}

type ExecutableJob = {
  config: Record<string, unknown>;
  trigger: Record<string, unknown>;
  execute: (data: Record<string, unknown>) => Promise<{
    result: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>;
};

// ============================================================================
// TESTS
// ============================================================================

describe('sync-entity-to-neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFirestoreFixtures.clear();
    mockFirestoreBeforeRead.mockResolvedValue(undefined);
    mockStepSleep.mockResolvedValue(undefined);
    mockReadEntityGraphSyncAnchor.mockResolvedValue(null);
    mockClearConvergedEntityGraphSyncAnchor.mockResolvedValue('cleared');
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (runWriteTransaction as jest.Mock).mockResolvedValue(createMockNeo4jResult([{ id: 'mock-id' }], 1));
    (reconcileEntityTagConcepts as jest.Mock).mockImplementation(async (entityId: string, entityType: string) => {
      const collections: Record<string, string> = {
        company: 'companies',
        strategy: 'strategies',
        prototype: 'prototypes',
        signal: 'signals',
        orgUnit: 'org-units',
        initiative: 'initiatives',
        painPoint: 'painPoints',
        useCase: 'use-cases',
      };
      const fixture = mockFirestoreFixtures.get(`${collections[entityType]}/${entityId}`) as
        | { tags?: string[]; conceptIds?: string[] }
        | undefined;
      if (!fixture) return null;
      const conceptIds = fixture.conceptIds ?? [];
      return {
        tags: fixture.tags ?? [],
        conceptIds,
        concepts: conceptIds.map((id) => ({
          id,
          slug: id.replace(/^concept-/, ''),
          canonicalName: id,
          type: 'tag',
          aliases: [],
          createdAt: 1,
          updatedAt: 1,
        })),
        addedConceptIds: [],
        removedConceptIds: [],
        conceptIdsChanged: false,
      };
    });
    (projectEntityTagConceptsToNeo4j as jest.Mock).mockResolvedValue({ relationshipsCreated: 0 });
    (captureEntityTagConceptIdsFromNeo4j as jest.Mock).mockResolvedValue([]);
    (reconcileConceptEntityCounts as jest.Mock).mockResolvedValue([]);
    (loadDependentInitiativeIds as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // syncUnifiedEntityToNeo4jJob configuration
  // ==========================================================================

  describe('syncUnifiedEntityToNeo4jJob', () => {
    const job = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;

    const ENTITY_COLLECTIONS: Record<string, string> = {
      company: 'companies',
      strategy: 'strategies',
      prototype: 'prototypes',
      signal: 'signals',
      orgUnit: 'org-units',
      initiative: 'initiatives',
      painPoint: 'painPoints',
      useCase: 'use-cases',
      radarPlacement: 'radarPlacements',
    };

    /**
     * M1/D2: the handler no longer reads inline event data — it always loads
     * the doc from Firestore admin. Tests stage their entity doc as a
     * Firestore fixture and send an identifier-only event.
     */
    function executeWithDoc(eventData: Record<string, unknown>) {
      const { data, ...rest } = eventData as { data?: Record<string, unknown> } & Record<string, unknown>;
      if (data && typeof rest.entityType === 'string' && typeof rest.entityId === 'string') {
        const collection = ENTITY_COLLECTIONS[rest.entityType];
        if (collection) mockFirestoreFixtures.set(`${collection}/${rest.entityId}`, data);
      }
      return job.execute(rest);
    }

    it('should be configured correctly', () => {
      expect(job.config).toMatchObject({
        id: 'sync-unified-entity-to-neo4j',
        retries: 3,
        concurrency: {
          key: 'event.data.entityType + ":" + event.data.entityId',
          limit: 1,
        },
      });
      expect(job.trigger).toMatchObject({
        event: 'app/unified-entity.sync.requested',
      });
    });

    // ========================================================================
    // M1/D2: single load path — inline event data must be ignored
    // ========================================================================

    it('ALWAYS loads the entity from Firestore — an inline event data field must not shadow the real doc (M1/D2)', async () => {
      // Firestore holds the authoritative doc.
      mockFirestoreFixtures.set('companies/comp-1', {
        id: 'comp-1',
        name: 'Authoritative Company',
        status: 'active',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      // A stale/partial inline `data` field (the dead shortcut — producers
      // send `payload`, so this key was never populated in production).
      const { result } = await job.execute({
        operation: 'update',
        entityType: 'company',
        entityId: 'comp-1',
        data: { name: 'Stale Partial Patch' },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE'),
        expect.objectContaining({ name: 'Authoritative Company' })
      );
    });

    // ========================================================================
    // Skip entity types with dedicated sync
    // ========================================================================

    it('should skip technology entity type (has dedicated sync function)', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'technology',
        entityId: 'tech-1',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('dedicated sync');
      expect(runWriteTransaction).not.toHaveBeenCalled();
    });

    it('should skip document entity type (has dedicated sync function)', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'document',
        entityId: 'doc-1',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('dedicated sync');
      expect(runWriteTransaction).not.toHaveBeenCalled();
    });

    // ========================================================================
    // Unknown entity type
    // ========================================================================

    it('should return error for unknown entity type', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'unknownType',
        entityId: 'x-1',
      });

      expect(result.error).toContain('Unknown entity type: unknownType');
    });

    // ========================================================================
    // Neo4j health check
    // ========================================================================

    it('should throw error when Neo4j is not healthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue({
        healthy: false,
        error: 'Connection timeout',
      });

      await expect(
        job.execute({
          operation: 'create',
          entityType: 'company',
          entityId: 'comp-1',
        })
      ).rejects.toThrow('Neo4j not healthy: Connection timeout');
    });

    // ========================================================================
    // Create operations
    // ========================================================================

    it('should create a company entity with provided data', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'Acme Corp',
          description: 'A tech company',
          status: 'active',
          tags: ['tech', 'startup'],
          type: 'vendor',
          industry: 'Software',
          size: 'medium',
          location: { city: 'Berlin', country: 'Germany' },
          website: 'https://acme.com',
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.entityId).toBe('comp-1');
      expect(result.entityType).toBe('company');
      expect(result.operation).toBe('created');

      // Verify runWriteTransaction was called with upsert query
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Company {id: $entityId})'),
        expect.objectContaining({
          entityId: 'comp-1',
          entityType: 'company',
          name: 'Acme Corp',
          description: 'A tech company',
          status: 'active',
          companyType: 'vendor',
          industry: 'Software',
          companySize: 'medium',
          locationCity: 'Berlin',
          locationCountry: 'Germany',
          headquarters: 'Berlin, Germany',
          website: 'https://acme.com',
        })
      );

      // Verify completion event was sent
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/entity.sync.completed',
          data: expect.objectContaining({
            entityId: 'comp-1',
            entityType: 'company',
            operation: 'created',
          }),
        })
      );
    });

    it('should create a strategy entity', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'strategy',
        entityId: 'strat-1',
        data: {
          name: 'AI First',
          description: 'AI-first strategy',
          category: 'technology',
          priority: 'high',
          horizon: 'medium',
          alignmentScore: 85,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('created');

      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Strategy {id: $entityId})'),
        expect.objectContaining({
          entityId: 'strat-1',
          name: 'AI First',
          category: 'technology',
          priority: 'high',
          horizon: 'medium',
          alignmentScore: 85,
        })
      );
    });

    it('should create an orgUnit entity with parent hierarchy', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'orgUnit',
        entityId: 'ou-1',
        data: {
          name: 'Engineering',
          type: 'department',
          level: 2,
          annualBudget: 500000,
          parentId: 'ou-root',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Four write calls: 1) upsert entity, 2) implicit-edge drift prune,
      // 3) CHILD_OF relationship, 4) final complete-projection fingerprint.
      expect(runWriteTransaction).toHaveBeenCalledTimes(4);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('CHILD_OF'),
        expect.objectContaining({
          childId: 'ou-1',
          parentId: 'ou-root',
        })
      );
    });

    it('should create an initiative entity with orgUnit ownership', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'initiative',
        entityId: 'init-1',
        data: {
          name: 'Cloud Migration',
          priority: 'high',
          budget: 1000000,
          ownerOrgUnitId: 'ou-1',
          technologyIds: ['tech-1'],
          painPointIds: ['pp-1'],
          startDate: 1700000000000,
          endDate: 1710000000000,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Should have write calls: 1) upsert entity, 2) OWNED_BY relationship
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('OWNED_BY'),
        expect.objectContaining({
          initiativeId: 'init-1',
          orgUnitId: 'ou-1',
        })
      );
    });

    it('reconciles Initiative linkedStrategyIds and linkedPainPointIds and reports missing targets', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('projectionOwner: $projectionOwner')) {
          return createMockNeo4jResult([
            {
              missingStrategyIds: ['strategy-missing'],
              missingPainPointIds: ['pain-missing'],
              strategiesProjected: 1,
              painPointsProjected: 1,
              strategyEdgesRemoved: 0,
              painPointEdgesRemoved: 0,
            },
          ]);
        }
        return createMockNeo4jResult([{ id: 'mock' }], 1);
      });

      await expect(
        executeWithDoc({
          operation: 'update',
          entityType: 'initiative',
          entityId: 'init-links',
          data: {
            name: 'Authoritative links',
            linkedStrategyIds: ['strategy-1', 'strategy-missing'],
            linkedPainPointIds: ['pain-1', 'pain-missing'],
            createdAt: 1700000000000,
            updatedAt: 1700000000001,
          },
        })
      ).rejects.toThrow('graph targets are not ready');

      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (initiative)-[edge:IMPLEMENTS'),
        expect.objectContaining({
          initiativeId: 'init-links',
          strategyIds: ['strategy-1', 'strategy-missing'],
          painPointIds: ['pain-1', 'pain-missing'],
        })
      );
      expect(inngest.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app/entity.sync.completed' })
      );
    });

    it('should create a painPoint entity with AFFECTS relationships', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'painPoint',
        entityId: 'pp-1',
        data: {
          name: 'Slow deployments',
          severity: 'high',
          category: 'operations',
          estimatedImpact: 75,
          affectedOrgUnitIds: ['ou-1', 'ou-2'],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Should create AFFECTS relationships for each affected org unit
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('AFFECTS'),
        expect.objectContaining({ painPointId: 'pp-1', orgUnitId: 'ou-1' })
      );
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('AFFECTS'),
        expect.objectContaining({ painPointId: 'pp-1', orgUnitId: 'ou-2' })
      );
    });

    it('should create a useCase entity with LINKED_TO relationships', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'useCase',
        entityId: 'uc-1',
        data: {
          name: 'Automated Testing',
          category: 'engineering',
          radarTechnologyIds: ['tech-1'],
          companyIds: ['comp-1'],
          problemDomain: 'quality assurance',
          solutionCategory: 'automation',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Should create LINKED_TO for both related entity IDs
      const writeCalls = (runWriteTransaction as jest.Mock).mock.calls;
      // Filter to the MERGE calls only — the drift-prune query also names
      // LINKED_TO in its type alternation but is a DELETE, not an edge write.
      const linkedToCalls = writeCalls.filter((call) => call[0].includes('MERGE') && call[0].includes('LINKED_TO'));
      expect(linkedToCalls.length).toBe(2);
    });

    it('should create a prototype entity', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'prototype',
        entityId: 'proto-1',
        data: {
          name: 'AI Chatbot',
          type: 'poc',
          category: 'ai',
          technologyIds: ['tech-1'],
          phase: 'pilot',
          successCriteria: '95% user satisfaction',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('created');

      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Prototype {id: $entityId})'),
        expect.objectContaining({
          entityId: 'proto-1',
          name: 'AI Chatbot',
          phase: 'pilot',
          successCriteria: '95% user satisfaction',
        })
      );
    });

    // ========================================================================
    // Signal entity with complex relationships
    // ========================================================================

    it('should create a signal entity and extract core properties', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-1',
        data: {
          name: 'AI funding surge',
          type: 'funding',
          source: 'TechCrunch',
          sentiment: 'positive',
          sourceUrl: 'https://example.com/article',
          trustScore: { overall: 80 },
          alignmentScore: 73,
          linkedEntities: {
            technologies: ['tech-1'],
            companies: ['comp-1'],
            useCases: ['uc-1'],
          },
          alignedStrategies: ['strat-1'],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Signal entity should be upserted in Neo4j
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Signal {id: $entityId})'),
        expect.objectContaining({
          entityId: 'sig-1',
          name: 'AI funding surge',
          sourceType: 'funding',
          sourceUrl: 'https://example.com/article',
          sentiment: 'positive',
          confidence: 80,
          alignmentScore: 73,
        })
      );

      const writeCalls = (runWriteTransaction as jest.Mock).mock.calls as Array<
        [string, Record<string, unknown>]
      >;
      const upsert = writeCalls.find(([query]) => query.includes('MERGE (e:Entity:Signal'));
      expect(upsert).toBeDefined();
      const serialized = JSON.parse(upsert?.[1].properties as string) as Record<string, unknown>;
      expect(serialized.alignmentScore).toBe(73);
      expect(serialized.linkedEntities).toEqual({
        technologies: ['tech-1'],
        companies: ['comp-1'],
        useCases: ['uc-1'],
      });
      expect(serialized.alignedStrategies).toEqual(['strat-1']);

      const alignsWith = writeCalls.find(
        ([query]) => query.includes('MERGE (signal)-[r:ALIGNS_WITH]')
      );
      expect(alignsWith?.[1]).toMatchObject({
        signalId: 'sig-1',
        strategyId: 'strat-1',
        alignmentScore: 73,
      });

      // Completion event should be sent
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/entity.sync.completed',
          data: expect.objectContaining({
            entityId: 'sig-1',
            entityType: 'signal',
            operation: 'created',
          }),
        })
      );
    });

    it('should preserve a zero signal alignment score on the node, serialized properties, and edge', async () => {
      const { result } = await executeWithDoc({
        operation: 'update',
        entityType: 'signal',
        entityId: 'sig-zero',
        data: {
          title: 'Neutral strategic fit',
          type: 'news',
          alignmentScore: 0,
          alignedStrategies: ['strat-zero'],
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        },
      });

      expect(result.success).toBe(true);

      const writeCalls = (runWriteTransaction as jest.Mock).mock.calls as Array<
        [string, Record<string, unknown>]
      >;
      const upsert = writeCalls.find(([query]) => query.includes('MERGE (e:Entity:Signal'));
      expect(upsert?.[1]).toEqual(expect.objectContaining({ alignmentScore: 0 }));
      expect(JSON.parse(upsert?.[1].properties as string)).toEqual(
        expect.objectContaining({ alignmentScore: 0, alignedStrategies: ['strat-zero'] })
      );

      const alignsWith = writeCalls.find(
        ([query]) => query.includes('MERGE (signal)-[r:ALIGNS_WITH]')
      );
      expect(alignsWith?.[1]).toMatchObject({
        signalId: 'sig-zero',
        strategyId: 'strat-zero',
        alignmentScore: 0,
      });
    });

    it('should handle signal with importedAs in properties', async () => {
      // After the 0.2 Part B fix, nested objects in props.properties survive the
      // round-trip as live objects, so importedAs → BECAME materializes.
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-2',
        data: {
          name: 'New framework release',
          type: 'news',
          importedAs: { id: 'tech-2', type: 'technology' },
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('created');

      // The upsert should succeed
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Signal {id: $entityId})'),
        expect.objectContaining({
          entityId: 'sig-2',
        })
      );

      // 0.2 Part B regression lock: importedAs (a nested object) now produces the
      // BECAME edge — it did not before the double-serialization fix.
      const writeCalls = (runWriteTransaction as jest.Mock).mock.calls;
      expect(
        writeCalls.some(
          (c: [string, Record<string, unknown>]) => c[0].includes('BECAME') && c[1]?.targetId === 'tech-2'
        )
      ).toBe(true);
    });

    it('should handle signal with expandedContent and linkedEntities', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-3',
        data: {
          name: 'Patent filing',
          type: 'patent',
          expandedContent: {
            relatedItems: {
              signals: [{ id: 'sig-4', relevance: 'high' }],
              technologies: [{ id: 'tech-3', relevance: 'medium' }],
            },
          },
          linkedEntities: { technologies: [], companies: [] },
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('created');

      // The signal entity upsert should succeed
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Signal {id: $entityId})'),
        expect.objectContaining({
          entityId: 'sig-3',
          name: 'Patent filing',
          sourceType: 'patent',
        })
      );

      // 0.2 Part B regression lock: the expandedContent.relatedItems edges MUST
      // materialize. Before the double-serialization fix in extractCommonProperties,
      // signalData.expandedContent was a string, relatedItems resolved to [], and
      // these assertions FAILED (silent no-op). They pass only after the fix.
      const writeCalls = (runWriteTransaction as jest.Mock).mock.calls;
      expect(
        writeCalls.some(
          (c: [string, Record<string, unknown>]) => c[0].includes('RELATED_SIGNAL') && c[1]?.relatedSignalId === 'sig-4'
        )
      ).toBe(true);
      expect(
        writeCalls.some(
          (c: [string, Record<string, unknown>]) => c[0].includes('DISCOVERED') && c[1]?.techId === 'tech-3'
        )
      ).toBe(true);
    });

    it('should handle signal with no linkedEntities or expandedContent', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-5',
        data: {
          name: 'Simple signal',
          type: 'news',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // Three write calls: upsert + implicit-edge prune + final fingerprint.
      expect(runWriteTransaction).toHaveBeenCalledTimes(3);
    });

    // ========================================================================
    // HAS_CONCEPT relationships
    // ========================================================================

    it('projects canonical tag Concepts through the shared server-owned boundary', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'Acme Corp',
          tags: ['AI', 'Quantum'],
          conceptIds: ['concept-1', 'concept-2'],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(reconcileEntityTagConcepts).toHaveBeenCalledWith('comp-1', 'company');
      expect(projectEntityTagConceptsToNeo4j).toHaveBeenCalledWith(
        'comp-1',
        expect.objectContaining({
          tags: ['AI', 'Quantum'],
          conceptIds: ['concept-1', 'concept-2'],
        })
      );
    });

    // ========================================================================
    // Update operations
    // ========================================================================

    it('should update an existing entity', async () => {
      const { result } = await executeWithDoc({
        operation: 'update',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'Acme Corp Updated',
          description: 'Updated description',
          createdAt: 1700000000000,
          updatedAt: 1700000002000,
        },
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('updated');

      // Should use MERGE (upsert) for updates too
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity:Company {id: $entityId})'),
        expect.objectContaining({
          entityId: 'comp-1',
          name: 'Acme Corp Updated',
        })
      );
    });

    // ========================================================================
    // Delete operations
    // ========================================================================

    it('should delete an entity', async () => {
      (captureEntityTagConceptIdsFromNeo4j as jest.Mock).mockResolvedValue([
        'concept-ai',
        'concept-quantum',
      ]);
      const { result, steps } = await executeWithDoc({
        operation: 'delete',
        entityType: 'company',
        entityId: 'comp-1',
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');

      expect(deleteEntityFromGraph).toHaveBeenCalledWith('comp-1', 'company');
      expect(captureEntityTagConceptIdsFromNeo4j).toHaveBeenCalledWith('comp-1');
      expect(reconcileConceptEntityCounts).toHaveBeenCalledWith(['concept-ai', 'concept-quantum']);
      expect(Object.keys(steps).indexOf('capture-tag-concepts-before-delete')).toBeLessThan(
        Object.keys(steps).indexOf('sync-entity')
      );
    });

    it('waits for delayed source removal before deleting the graph node', async () => {
      mockFirestoreFixtures.set('companies/comp-delayed', { name: 'Still deleting' });
      mockStepSleep.mockImplementationOnce(async () => {
        mockFirestoreFixtures.delete('companies/comp-delayed');
      });

      const { result } = await executeWithDoc({
        operation: 'delete',
        entityType: 'company',
        entityId: 'comp-delayed',
      });

      expect(mockStepSleep).toHaveBeenCalledWith('wait-for-source-delete-0', '1s');
      expect(result.operation).toBe('deleted');
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('comp-delayed', 'company');
    });

    it('retains the graph node while the authoritative source still exists', async () => {
      mockFirestoreFixtures.set('companies/comp-retained', { name: 'Retained source' });

      await expect(
        executeWithDoc({
          operation: 'delete',
          entityType: 'company',
          entityId: 'comp-retained',
        })
      ).rejects.toThrow('while its Firestore source still exists');

      expect(mockStepSleep).toHaveBeenCalledTimes(4);
      expect(deleteEntityFromGraph).not.toHaveBeenCalled();
    });

    it('does not resurrect an entity deleted after the memoizable load step', async () => {
      let reads = 0;
      mockFirestoreBeforeRead.mockImplementation(async (key: string) => {
        reads += 1;
        if (reads === 2) mockFirestoreFixtures.delete(key);
      });

      const { result } = await executeWithDoc({
        operation: 'update',
        entityType: 'company',
        entityId: 'comp-raced',
        data: { name: 'Deleted during delivery' },
      });

      expect(result).toMatchObject({ success: true, skipped: 'source-missing' });
      expect(runWriteTransaction).not.toHaveBeenCalled();
      expect(inngest.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app/entity.sync.completed' })
      );
    });

    it('does not clear a recovery anchor when a missing source is recreated before settlement', async () => {
      let reads = 0;
      mockReadEntityGraphSyncAnchor.mockResolvedValue({ generation: 'a'.repeat(32) });
      mockFirestoreBeforeRead.mockImplementation(async (key: string) => {
        reads += 1;
        if (reads === 2) {
          mockFirestoreFixtures.set(key, { name: 'Recreated company', updatedAt: 2 });
        }
      });

      const { result } = await executeWithDoc({
        operation: 'update',
        entityType: 'company',
        entityId: 'comp-recreated',
      });

      expect(result).toMatchObject({ success: true, skipped: true });
      expect(mockReadEntityGraphSyncAnchor).toHaveBeenCalledWith('company', 'comp-recreated');
      expect(mockClearConvergedEntityGraphSyncAnchor).not.toHaveBeenCalled();
    });

    // ========================================================================
    // Unknown operation
    // ========================================================================

    it('should throw error for unknown operation', async () => {
      await expect(
        executeWithDoc({
          operation: 'archive', // not valid
          entityType: 'company',
          entityId: 'comp-1',
          data: { name: 'Test' },
        })
      ).rejects.toThrow('Unknown operation: archive');
    });

    // ========================================================================
    // Load from Firestore fallback
    // ========================================================================

    it('should load entity from Firestore when data not provided (company)', async () => {
      mockFirestoreFixtures.set('companies/comp-1', {
        id: 'comp-1',
        name: 'Loaded Company',
        description: 'From Firestore',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE'),
        expect.objectContaining({ name: 'Loaded Company' })
      );
    });

    it('should load entity from Firestore when data not provided (strategy)', async () => {
      mockFirestoreFixtures.set('strategies/strat-1', {
        id: 'strat-1',
        name: 'Growth Strategy',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'update',
        entityType: 'strategy',
        entityId: 'strat-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (prototype)', async () => {
      mockFirestoreFixtures.set('prototypes/proto-1', {
        id: 'proto-1',
        name: 'Chat Bot',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'prototype',
        entityId: 'proto-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (signal)', async () => {
      mockFirestoreFixtures.set('signals/sig-1', {
        id: 'sig-1',
        name: 'AI Signal',
        type: 'news',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (orgUnit)', async () => {
      mockFirestoreFixtures.set('org-units/ou-1', {
        id: 'ou-1',
        name: 'Engineering',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'orgUnit',
        entityId: 'ou-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (initiative)', async () => {
      mockFirestoreFixtures.set('initiatives/init-1', {
        id: 'init-1',
        name: 'Digital Transform',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'initiative',
        entityId: 'init-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (painPoint)', async () => {
      mockFirestoreFixtures.set('painPoints/pp-1', {
        id: 'pp-1',
        name: 'Slow CI',
        severity: 'high',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'painPoint',
        entityId: 'pp-1',
      });

      expect(result.success).toBe(true);
    });

    it('should load entity from Firestore when data not provided (useCase)', async () => {
      mockFirestoreFixtures.set('use-cases/uc-1', {
        id: 'uc-1',
        name: 'Automated Deploy',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'useCase',
        entityId: 'uc-1',
      });

      expect(result.success).toBe(true);
    });

    it('should skip radarPlacement (has dedicated sync function)', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'radarPlacement',
        entityId: 'rp-1',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('dedicated sync function');
    });

    // ========================================================================
    // Entity not found in Firestore
    // ========================================================================

    it('should skip sync when entity not found in Firestore (create)', async () => {
      // No fixture set for `companies/comp-missing` → admin SDK returns exists:false
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-missing',
      });

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('not found in Firestore');
      expect(runWriteTransaction).not.toHaveBeenCalled();
    });

    it('should still delete even without entity data', async () => {
      const { result } = await executeWithDoc({
        operation: 'delete',
        entityType: 'company',
        entityId: 'comp-1',
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('comp-1', 'company');
    });

    // ========================================================================
    // Implicit relationship failures should not fail the sync
    // ========================================================================

    it('should continue when implicit relationship creation fails', async () => {
      // Fail specifically on the CHILD_OF edge MERGE (query-content based, so
      // it's robust to the added drift-prune call in the sequence).
      (runWriteTransaction as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('MERGE') && query.includes('CHILD_OF')) {
          throw new Error('Target node not found');
        }
        return createMockNeo4jResult([{ id: 'mock' }], 1);
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'orgUnit',
        entityId: 'ou-1',
        data: {
          name: 'Engineering',
          type: 'department',
          parentId: 'ou-missing',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      // P3-B (H7 model): the run completes (implicit-edge errors don't throw),
      // but a failed edge write must be counted and flip success to false —
      // previously it was warn-and-continue masked under success:true.
      expect(result.success).toBe(false);
      expect(result.implicitRelationshipFailures).toBe(1);
      expect(result.operation).toBe('created');
    });

    it('counts a silent missing implicit target and withholds the final fingerprint', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('MERGE') && query.includes('CHILD_OF')) {
          return createMockNeo4jResult([], 0);
        }
        return createMockNeo4jResult([{ id: 'mock' }], 1);
      });

      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'orgUnit',
        entityId: 'ou-1',
        data: {
          name: 'Engineering',
          type: 'department',
          parentId: 'ou-missing',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result).toMatchObject({
        success: false,
        operation: 'created',
        implicitRelationshipFailures: 1,
      });
      expect(runWriteTransaction).not.toHaveBeenCalledWith(
        expect.stringContaining('SET e.sourceFingerprint = $sourceFingerprint'),
        expect.anything()
      );
    });

    // ========================================================================
    // onFailure handler
    // ========================================================================

    it('should handle onFailure callback', async () => {
      const jobConfig = (
        syncUnifiedEntityToNeo4jJob as unknown as {
          config: {
            onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
          };
        }
      ).config;

      const onFailure = jobConfig.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        await onFailure({
          error: new Error('Neo4j unreachable'),
          // Inngest v3 onFailure payload: original event nested at event.data.event
          event: {
            data: {
              event: {
                data: {
                  entityType: 'company',
                  entityId: 'comp-1',
                  operation: 'create',
                },
              },
            },
          },
        });

        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'app/unified-entity.sync.failed',
            data: expect.objectContaining({
              entityType: 'company',
              entityId: 'comp-1',
              error: 'Neo4j unreachable',
            }),
          })
        );
      }
    });

    it('should handle onFailure with missing event data gracefully', async () => {
      const jobConfig = (
        syncUnifiedEntityToNeo4jJob as unknown as {
          config: {
            onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
          };
        }
      ).config;

      if (jobConfig.onFailure) {
        await jobConfig.onFailure({
          error: new Error('Something broke'),
          event: { data: {} }, // empty data
        });

        expect(inngest.send).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'app/unified-entity.sync.failed',
            data: expect.objectContaining({
              entityType: 'unknown',
              entityId: 'unknown',
            }),
          })
        );
      }
    });

    // ========================================================================
    // Company location handling variations
    // ========================================================================

    it('should handle company with string location', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'String Location Corp',
          location: 'San Francisco, CA',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headquarters: 'San Francisco, CA',
        })
      );
    });

    it('should handle company with headquarters fallback', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'HQ Corp',
          headquarters: 'London, UK',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headquarters: 'London, UK',
        })
      );
    });

    it('should handle company with partial location object (city only)', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'City Corp',
          location: { city: 'Tokyo' },
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          locationCity: 'Tokyo',
          locationCountry: null,
          headquarters: 'Tokyo',
        })
      );
    });

    // ========================================================================
    // Property extraction edge cases
    // ========================================================================

    it('should serialize additional properties as JSON', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
        data: {
          name: 'Props Corp',
          customField: 'custom value',
          nestedObj: { key: 'value' },
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);

      // The 'properties' field should contain serialized additional properties
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          properties: expect.stringContaining('customField'),
        })
      );
    });

    it('should handle signal with trustScore object', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-ts',
        data: {
          name: 'Trusted Signal',
          type: 'news',
          trustScore: { overall: 92 },
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          confidence: 92,
        })
      );
    });

    it('should handle signal with relevanceScore fallback for confidence', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-rs',
        data: {
          name: 'Relevant Signal',
          type: 'academic',
          relevanceScore: 78,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          confidence: 78,
        })
      );
    });

    it('should use publishedDate for signal, with discoveredAt fallback', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'signal',
        entityId: 'sig-pd',
        data: {
          name: 'Dated Signal',
          type: 'patent',
          discoveredAt: 1699000000000,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          publishedDate: 1699000000000,
        })
      );
    });

    it('should handle strategy with timeHorizon fallback', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'strategy',
        entityId: 'strat-th',
        data: {
          name: 'Long Term Plan',
          timeHorizon: 'long',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          horizon: 'long',
        })
      );
    });

    it('should handle initiative with targetDate fallback for endDate', async () => {
      const { result } = await executeWithDoc({
        operation: 'create',
        entityType: 'initiative',
        entityId: 'init-td',
        data: {
          name: 'Target Initiative',
          targetDate: 1720000000000,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      });

      expect(result.success).toBe(true);
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          endDate: 1720000000000,
        })
      );
    });
  });

  // ==========================================================================
  // batchSyncUnifiedEntitiesToNeo4jJob
  // ==========================================================================

  describe('batchSyncUnifiedEntitiesToNeo4jJob', () => {
    const job = batchSyncUnifiedEntitiesToNeo4jJob as unknown as ExecutableJob;

    it('should be configured correctly', () => {
      expect(job.config).toMatchObject({
        id: 'batch-sync-unified-entities-to-neo4j',
        retries: 2,
      });
      expect(job.trigger).toMatchObject({
        event: 'app/unified-entities.batch-sync.requested',
      });
    });

    it('should send individual sync events for each entity', async () => {
      const { result } = await job.execute({
        entityType: 'company',
        entityIds: ['comp-1', 'comp-2', 'comp-3'],
      });

      expect(result.success).toBe(true);
      expect(result.entityType).toBe('company');
      expect(result.entitiesQueued).toBe(3);

      // All 3 entities should be queued (sent in a batch of 25)
      expect(inngest.send).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'app/unified-entity.sync.requested',
            data: expect.objectContaining({
              operation: 'update',
              entityType: 'company',
              entityId: 'comp-1',
            }),
          }),
        ])
      );
    });

    it('should batch events in groups of 25', async () => {
      const entityIds = Array.from({ length: 60 }, (_, i) => `comp-${i}`);

      const { result } = await job.execute({
        entityType: 'company',
        entityIds,
      });

      expect(result.success).toBe(true);
      expect(result.entitiesQueued).toBe(60);

      // Should have 3 batches: 25 + 25 + 10
      expect(inngest.send).toHaveBeenCalledTimes(3);

      // First batch should have 25 items
      const firstBatch = (inngest.send as jest.Mock).mock.calls[0][0] as unknown[];
      expect(firstBatch.length).toBe(25);

      // Last batch should have 10 items
      const lastBatch = (inngest.send as jest.Mock).mock.calls[2][0] as unknown[];
      expect(lastBatch.length).toBe(10);
    });
  });

  // ==========================================================================
  // Helper functions
  // ==========================================================================

  describe('triggerUnifiedEntitySync', () => {
    it('should send the correct event', async () => {
      await triggerUnifiedEntitySync('company', 'comp-1', 'create');

      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/unified-entity.sync.requested',
          data: {
            operation: 'create',
            entityType: 'company',
            entityId: 'comp-1',
          },
        })
      );
    });

    it('sends identifiers only — no inline data side-channel (M1 / decision D2)', async () => {
      await triggerUnifiedEntitySync('company', 'comp-1', 'update');

      const event = (inngest.send as jest.Mock).mock.calls[0][0];
      expect(Object.keys(event.data).sort()).toEqual(['entityId', 'entityType', 'operation']);
    });
  });

  describe('triggerBatchUnifiedEntitySync', () => {
    it('should send the correct batch event', async () => {
      await triggerBatchUnifiedEntitySync('strategy', ['s-1', 's-2']);

      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/unified-entities.batch-sync.requested',
          data: {
            entityType: 'strategy',
            entityIds: ['s-1', 's-2'],
          },
        })
      );
    });
  });
});
