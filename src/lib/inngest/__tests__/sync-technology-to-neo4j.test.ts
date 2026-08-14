/**
 * Tests for sync-technology-to-neo4j.ts
 * Phase 1 Task 1.2.1: Technology Neo4j Sync Handler
 *
 * Tests the Inngest jobs that sync Technologies to Neo4j:
 * - syncTechnologyToNeo4jJob - Single technology sync
 * - batchSyncTechnologiesJob - Batch technology sync
 * - triggerTechnologySync - Helper function
 */

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Mock firebase to prevent fetch error from Firebase Auth
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

// Mock the admin SDK — the sync function now reads via firebase-admin
// directly (the previous client-SDK service module was hanging gRPC streams
// server-side). Chainable fake backed by per-id fixtures with a single-doc
// fallback for the focused worker cases.
const technologyFixture: { current: unknown } = { current: null };
const technologyFixtures = new Map<string, unknown>();
const mockStepSleep = jest.fn();
const mockTechnologyGet = jest.fn();
const mockReadEntityGraphSyncAnchor = jest.fn();
const mockClearConvergedEntityGraphSyncAnchor = jest.fn();
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  readEntityGraphSyncAnchor: (...args: unknown[]) => mockReadEntityGraphSyncAnchor(...args),
  clearConvergedEntityGraphSyncAnchor: (...args: unknown[]) =>
    mockClearConvergedEntityGraphSyncAnchor(...args),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn((id: string) => ({
        get: () => mockTechnologyGet(id),
      })),
    })),
  },
}));

// Mock the graph module
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  deleteEntityFromGraph: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  captureEntityTagConceptIdsFromNeo4j: jest.fn(),
  reconcileEntityTagConcepts: jest.fn(),
  reconcileConceptEntityCounts: jest.fn(),
  projectEntityTagConceptsToNeo4j: jest.fn(),
}));

// Mock the inngest client
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
          };
          const result = await handler({ event: { id: 'test-event-id', data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

import { checkHealth, deleteEntityFromGraph, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import {
  captureEntityTagConceptIdsFromNeo4j,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
  reconcileEntityTagConcepts,
} from '@/lib/graph/entity-tag-concept-projection';
import { inngest } from '../client';
import {
  syncTechnologyToNeo4jJob,
  batchSyncTechnologiesJob,
  triggerTechnologySync,
} from '../functions/sync-technology-to-neo4j';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// Helper to create mock QueryExecutionResult
function createMockResult<T>(records: T[], relationshipsCreated = 0) {
  return {
    records,
    summary: {
      counters: {
        relationshipsCreated,
        nodesCreated: records.length > 0 ? 1 : 0,
        nodesDeleted: 0,
        propertiesSet: 0,
      },
    },
  };
}

// Type helper for job execution
type ExecutableJob = {
  config: {
    id: string;
    retries: number;
    concurrency?: { key: string; limit: number };
    onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
  };
  trigger: { event?: string; cron?: string };
  execute: (data: Record<string, unknown>) => Promise<{
    result: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>;
};

describe('sync-technology-to-neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    technologyFixture.current = null;
    technologyFixtures.clear();
    mockTechnologyGet.mockImplementation(async (id: string) => {
      const fixture = technologyFixtures.has(id) ? technologyFixtures.get(id) : technologyFixture.current;
      return {
        exists: fixture !== null && fixture !== undefined,
        data: () => fixture,
      };
    });
    mockStepSleep.mockResolvedValue(undefined);
    mockReadEntityGraphSyncAnchor.mockResolvedValue(null);
    mockClearConvergedEntityGraphSyncAnchor.mockResolvedValue('cleared');
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (inngest.send as jest.Mock).mockImplementation(async (events: unknown) => ({
      ids: Array.isArray(events) ? events.map((_, index) => `event-${index}`) : ['event-0'],
    }));
    (runWriteTransaction as jest.Mock).mockResolvedValue(createMockResult([{ id: 'mock-id' }], 1));
    (runReadTransaction as jest.Mock).mockResolvedValue(createMockResult([]));
    (reconcileEntityTagConcepts as jest.Mock).mockImplementation(async (id: string) => {
      const fixture = technologyFixtures.has(id) ? technologyFixtures.get(id) : technologyFixture.current;
      if (!fixture) return null;
      const data = fixture as { tags?: string[]; conceptIds?: string[] };
      const conceptIds = data.conceptIds ?? [];
      return {
        tags: data.tags ?? [],
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
    (projectEntityTagConceptsToNeo4j as jest.Mock).mockImplementation(async (_id, projection) => ({
      relationshipsCreated: projection.conceptIds.length,
    }));
    (captureEntityTagConceptIdsFromNeo4j as jest.Mock).mockResolvedValue([]);
    (reconcileConceptEntityCounts as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // syncTechnologyToNeo4jJob
  // ==========================================================================

  describe('syncTechnologyToNeo4jJob', () => {
    it('should be configured correctly', () => {
      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      expect(job.config.id).toBe('sync-technology-to-neo4j');
      expect(job.config.retries).toBe(3);
      expect(job.config.concurrency).toEqual({ key: 'event.data.technologyId', limit: 1 });
      expect(job.trigger.event).toBe('app/technology.sync.requested');
    });

    it('should create a technology successfully from the Firestore doc', async () => {
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        description: 'A JavaScript library for building user interfaces',
        category: 'frontend',
        tags: ['javascript', 'ui'],
        websiteUrl: 'https://react.dev',
        githubUrl: 'https://github.com/facebook/react',
        documentationUrl: 'https://react.dev/learn',
        linkedCompanies: ['company-1'],
        linkedUseCases: ['uc-1'],
        conceptIds: ['concept-1'],
        approvalStatus: 'approved',
        createdBy: 'user-001',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.technologyId).toBe('tech-123');
      expect(result.operation).toBe('created');
      expect(result.relationshipsCreated).toBe(3); // 1 company + 1 usecase + 1 concept
      expect(runWriteTransaction).toHaveBeenCalled();
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/technology.sync.completed',
        data: expect.objectContaining({
          technologyId: 'tech-123',
          operation: 'created',
        }),
      });
    });

    it('should update a technology successfully', async () => {
      technologyFixture.current = {
        name: 'React Updated',
        slug: 'react-updated',
        createdBy: 'user-001',
      };
      const eventData = {
        operation: 'update',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('updated');
    });

    it('ALWAYS loads the full doc from Firestore — an inline event payload must not demote an approved technology (M1/D2)', async () => {
      // Firestore holds the authoritative doc: approved, with concepts.
      technologyFixture.current = {
        id: 'tech-123',
        name: 'React',
        slug: 'react',
        description: 'A JS library',
        category: 'frontend',
        tags: ['javascript'],
        approvalStatus: 'approved',
        conceptIds: ['concept-1'],
        createdBy: 'user-001',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };

      // A stale/partial inline payload (the dead fast path) lacks
      // approvalStatus — if the handler consumed it, the upsert would write
      // approvalStatus 'pending' over 'approved'.
      const { result } = await (syncTechnologyToNeo4jJob as unknown as ExecutableJob).execute({
        operation: 'update',
        technologyId: 'tech-123',
        technologyData: { name: 'React (patched)', slug: 'react' },
      });

      expect(result.success).toBe(true);
      // The Firestore doc was loaded despite the inline payload.
      expect(mockTechnologyGet).toHaveBeenCalled();
      const upsertCall = (runWriteTransaction as jest.Mock).mock.calls.find(
        ([, params]) => params?.technologyId === 'tech-123' && 'approvalStatus' in (params ?? {})
      );
      expect(upsertCall).toBeDefined();
      expect(upsertCall![1].approvalStatus).toBe('approved');
      expect(upsertCall![1].name).toBe('React');
    });

    it('should load technology from Firestore when data is not provided', async () => {
      technologyFixture.current = {
        id: 'tech-123',
        name: 'React',
        slug: 'react',
        description: 'A JS library',
        category: 'frontend',
        tags: ['javascript'],
        websiteUrl: 'https://react.dev',
        githubUrl: null,
        documentationUrl: null,
        linkedCompanies: [],
        linkedUseCases: [],
        approvalStatus: 'approved',
        createdBy: 'user-001',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };

      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
        // No technologyData provided
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(mockTechnologyGet).toHaveBeenCalled();
    });

    it('should skip gracefully when technology not found in Firestore', async () => {
      technologyFixture.current = null;

      const eventData = {
        operation: 'create',
        technologyId: 'tech-missing',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      const result = await job.execute(eventData);
      expect(result.result).toEqual({
        success: true,
        skipped: true,
        reason: 'Technology not found in Firestore',
      });
    });

    it('should delete a technology successfully', async () => {
      (runReadTransaction as jest.Mock).mockResolvedValueOnce(createMockResult([])); // no related placements
      (captureEntityTagConceptIdsFromNeo4j as jest.Mock).mockResolvedValue([
        'concept-ai',
        'concept-quantum',
      ]);

      const eventData = {
        operation: 'delete',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result, steps } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      expect(result.placementsDeleted).toBe(0);
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('tech-123', 'technology');
      expect(captureEntityTagConceptIdsFromNeo4j).toHaveBeenCalledWith('tech-123');
      expect(reconcileConceptEntityCounts).toHaveBeenCalledWith(['concept-ai', 'concept-quantum']);
      expect(Object.keys(steps).indexOf('capture-tag-concepts-before-delete')).toBeLessThan(
        Object.keys(steps).indexOf('sync-technology')
      );
    });

    it('waits for delayed source removal before deleting a technology graph node', async () => {
      technologyFixture.current = { name: 'Deleting', slug: 'deleting', createdBy: 'user-1' };
      mockStepSleep.mockImplementationOnce(async () => {
        technologyFixture.current = null;
      });

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute({ operation: 'delete', technologyId: 'tech-delayed' });

      expect(mockStepSleep).toHaveBeenCalledWith('wait-for-source-delete-0', '1s');
      expect(result.operation).toBe('deleted');
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('tech-delayed', 'technology');
    });

    it('retains a technology graph node while its Firestore source still exists', async () => {
      technologyFixture.current = { name: 'Retained', slug: 'retained', createdBy: 'user-1' };
      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      await expect(job.execute({ operation: 'delete', technologyId: 'tech-retained' })).rejects.toThrow(
        'while its Firestore source still exists'
      );

      expect(mockStepSleep).toHaveBeenCalledTimes(4);
      expect(deleteEntityFromGraph).not.toHaveBeenCalled();
    });

    it('does not resurrect a technology deleted after the memoizable load step', async () => {
      technologyFixture.current = { name: 'Raced', slug: 'raced', createdBy: 'user-1' };
      let reads = 0;
      mockTechnologyGet.mockImplementation(async () => {
        reads += 1;
        if (reads === 2) technologyFixture.current = null;
        return {
          exists: technologyFixture.current !== null,
          data: () => technologyFixture.current,
        };
      });
      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      const { result } = await job.execute({ operation: 'update', technologyId: 'tech-raced' });

      expect(result).toMatchObject({ success: true, skipped: 'source-missing' });
      expect(runWriteTransaction).not.toHaveBeenCalled();
      expect(inngest.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app/technology.sync.completed' })
      );
    });

    it('should handle delete of non-existent technology gracefully', async () => {
      (runReadTransaction as jest.Mock).mockResolvedValue(createMockResult([]));

      const eventData = {
        operation: 'delete',
        technologyId: 'tech-nonexistent',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('tech-nonexistent', 'technology');
    });

    it('deletes every related graph placement before deleting the technology', async () => {
      (runReadTransaction as jest.Mock).mockResolvedValueOnce(
        createMockResult([{ placementId: 'placement-1' }, { placementId: 'placement-2' }])
      );

      const eventData = {
        operation: 'delete',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.placementsDeleted).toBe(2);
      expect(deleteEntityFromGraph).toHaveBeenNthCalledWith(1, 'placement-1', 'radarPlacement');
      expect(deleteEntityFromGraph).toHaveBeenNthCalledWith(2, 'placement-2', 'radarPlacement');
      expect(deleteEntityFromGraph).toHaveBeenNthCalledWith(3, 'tech-123', 'technology');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cascade deleting graph placements with technology',
        expect.objectContaining({ technologyId: 'tech-123', relatedPlacementsCount: 2 })
      );
    });

    it('does not delete the technology when one placement graph cascade fails', async () => {
      (runReadTransaction as jest.Mock).mockResolvedValueOnce(
        createMockResult([{ placementId: 'placement-1' }, { placementId: 'placement-2' }])
      );
      (deleteEntityFromGraph as jest.Mock)
        .mockResolvedValueOnce({ endpointsDeleted: 1 })
        .mockRejectedValueOnce(new Error('placement graph delete failed'));

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      await expect(job.execute({ operation: 'delete', technologyId: 'tech-123' })).rejects.toThrow(
        'placement graph delete failed'
      );
      expect(deleteEntityFromGraph).not.toHaveBeenCalledWith('tech-123', 'technology');
    });

    it('should throw error for unknown operation', async () => {
      technologyFixture.current = {
        name: 'Test',
        slug: 'test',
        createdBy: 'user-001',
      };
      const eventData = {
        operation: 'invalid',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      await expect(job.execute(eventData)).rejects.toThrow('Unknown operation: invalid');
    });

    it('should throw error when Neo4j is not healthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue({
        healthy: false,
        error: 'Connection refused',
      });

      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;

      await expect(job.execute(eventData)).rejects.toThrow('Neo4j not healthy: Connection refused');
    });

    it('does not clear a recovery anchor when a missing Technology is recreated before settlement', async () => {
      let reads = 0;
      mockReadEntityGraphSyncAnchor.mockResolvedValue({ generation: 'b'.repeat(32) });
      mockTechnologyGet.mockImplementation(async () => {
        reads += 1;
        const fixture = reads === 1 ? null : { name: 'Recreated Technology', slug: 'recreated' };
        return { exists: fixture !== null, data: () => fixture };
      });

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute({ operation: 'update', technologyId: 'tech-recreated' });

      expect(result).toMatchObject({ success: true, skipped: true });
      expect(mockReadEntityGraphSyncAnchor).toHaveBeenCalledWith('technology', 'tech-recreated');
      expect(mockClearConvergedEntityGraphSyncAnchor).not.toHaveBeenCalled();
    });

    it('should handle company relationship creation failure gracefully', async () => {
      let callCount = 0;
      (runWriteTransaction as jest.Mock).mockImplementation(async () => {
        callCount++;
        // Fail on company relationship creation (call 3: after upsert + delete company rels)
        if (callCount === 3) {
          throw new Error('Company not found in Neo4j');
        }
        return createMockResult([{ id: 'result' }], 1);
      });

      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        linkedCompanies: ['company-missing'],
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      // P3-B (H7 model): the run completes without throwing, but a link
      // failure must not report blanket success — it is counted instead.
      expect(result.success).toBe(false);
      expect(result.linkFailures).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to link company',
        expect.objectContaining({ technologyId: 'tech-123', companyId: 'company-missing' })
      );
    });

    it('does not stamp a complete projection when a company MATCH returns no relationship', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (query: string) => {
        if (query.includes('MERGE (t)-[r:DEVELOPED_BY]')) return createMockResult([], 0);
        return createMockResult([{ id: 'result' }], 1);
      });
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        linkedCompanies: ['company-missing'],
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute({ operation: 'create', technologyId: 'tech-123' });

      expect(result).toMatchObject({ success: false, linkFailures: 1 });
      expect(runWriteTransaction).not.toHaveBeenCalledWith(
        expect.stringContaining('SET t.sourceFingerprint = $sourceFingerprint'),
        expect.anything()
      );
    });

    it('should handle use case relationship creation failure gracefully', async () => {
      // Fail only for use case relationship calls
      let callCount = 0;
      (runWriteTransaction as jest.Mock).mockImplementation(async () => {
        callCount++;
        // Calls: 1=upsert, 2=delete company rels, 3=delete usecase rels, 4=enables rel (fail)
        if (callCount === 4) {
          throw new Error('UseCase not found');
        }
        return createMockResult([{ id: 'result' }], 1);
      });

      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        linkedUseCases: ['uc-missing'],
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      // P3-B (H7 model): completes, but the failure is counted — not masked.
      expect(result.success).toBe(false);
      expect(result.linkFailures).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to link use case',
        expect.objectContaining({ technologyId: 'tech-123', useCaseId: 'uc-missing' })
      );
    });

    it('does not stamp a complete projection when a use-case MATCH returns no relationship', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (query: string) => {
        if (query.includes('MERGE (t)-[r:ENABLES]')) return createMockResult([], 0);
        return createMockResult([{ id: 'result' }], 1);
      });
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        linkedUseCases: ['use-case-missing'],
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute({ operation: 'create', technologyId: 'tech-123' });

      expect(result).toMatchObject({ success: false, linkFailures: 1 });
      expect(runWriteTransaction).not.toHaveBeenCalledWith(
        expect.stringContaining('SET t.sourceFingerprint = $sourceFingerprint'),
        expect.anything()
      );
    });

    it('fails the durable attempt when canonical tag projection is not acknowledged', async () => {
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        conceptIds: ['concept-missing'],
      };
      (projectEntityTagConceptsToNeo4j as jest.Mock).mockRejectedValueOnce(new Error('Concept projection failed'));

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      await expect(job.execute({ operation: 'create', technologyId: 'tech-123' })).rejects.toThrow(
        'Concept projection failed'
      );
    });

    it('uses the canonical mapper for Technology tags instead of trusting event conceptIds', async () => {
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: 'user-001',
        tags: ['UI', 'Frontend'],
        conceptIds: ['concept-ui', 'concept-frontend'],
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute({
        operation: 'update',
        technologyId: 'tech-react',
        conceptIds: ['concept-event-must-be-ignored'],
      });

      expect(result.success).toBe(true);
      expect(reconcileEntityTagConcepts).toHaveBeenCalledWith('tech-react', 'technology');
      expect(projectEntityTagConceptsToNeo4j).toHaveBeenCalledWith(
        'tech-react',
        expect.objectContaining({ conceptIds: ['concept-ui', 'concept-frontend'] })
      );
    });

    it('should use default createdBy when not provided', async () => {
      technologyFixture.current = {
        name: 'React',
        slug: 'react',
        createdBy: '', // empty string, should fall back
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      // Verify the upsert call used 'system-auto-sync' as createdBy
      const upsertCall = (runWriteTransaction as jest.Mock).mock.calls[0];
      expect(upsertCall[1].createdBy).toBe('system-auto-sync');
    });

    it('should handle technology with no linked entities', async () => {
      technologyFixture.current = {
        name: 'Solo Tech',
        slug: 'solo-tech',
        createdBy: 'user-001',
        // No linkedCompanies, linkedUseCases, or conceptIds
      };
      const eventData = {
        operation: 'create',
        technologyId: 'tech-123',
      };

      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.relationshipsCreated).toBe(0);
    });

    it('should handle onFailure callback', async () => {
      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        await onFailure({
          error: new Error('Sync failed'),
          // Inngest v3 onFailure payload: original event nested at event.data.event
          event: { data: { event: { data: { technologyId: 'tech-123' } } } },
        });

        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/technology.sync.failed',
          data: expect.objectContaining({
            technologyId: 'tech-123',
            error: 'Sync failed',
          }),
        });
      }
    });

    it('should handle onFailure with missing technologyId', async () => {
      const job = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;

      if (onFailure) {
        await onFailure({
          error: new Error('Unknown failure'),
          event: { data: {} },
        });

        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/technology.sync.failed',
          data: expect.objectContaining({
            technologyId: 'unknown',
          }),
        });
      }
    });
  });

  // ==========================================================================
  // batchSyncTechnologiesJob
  // ==========================================================================

  describe('batchSyncTechnologiesJob', () => {
    function stageBatchSources(eventData: { technologies?: Array<{ id: string } & Record<string, unknown>> }) {
      for (const technology of eventData.technologies ?? []) {
        technologyFixtures.set(technology.id, technology);
      }
    }

    it('should be configured correctly', () => {
      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;

      expect(job.config.id).toBe('batch-sync-technologies-to-neo4j');
      expect(job.config.retries).toBe(2);
      expect(job.trigger.event).toBe('app/technology.batch-sync.requested');
    });

    it('should sync multiple technologies successfully', async () => {
      const eventData = {
        technologies: [
          {
            id: 'tech-1',
            name: 'React',
            slug: 'react',
            createdBy: 'user-001',
          },
          {
            id: 'tech-2',
            name: 'Vue',
            slug: 'vue',
            createdBy: 'user-001',
          },
        ],
        options: { batchSize: 50 },
      };
      stageBatchSources(eventData);

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
      expect(inngest.send).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'technology-batch:test-event-id:tech-1',
          name: 'app/technology.sync.requested',
          data: { technologyId: 'tech-1', operation: 'update' },
        }),
        expect.objectContaining({
          id: 'technology-batch:test-event-id:tech-2',
          name: 'app/technology.sync.requested',
          data: { technologyId: 'tech-2', operation: 'update' },
        }),
      ]);
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/technology.batch-sync.completed',
        data: expect.objectContaining({
          totalTechnologies: 2,
          created: 2,
          failed: 0,
        }),
      });
    });

    it('should fail the durable step when child dispatch is not fully acknowledged', async () => {
      const eventData = {
        technologies: [
          {
            id: 'tech-1',
            name: 'React',
            slug: 'react',
            createdBy: 'user-001',
          },
          {
            id: 'tech-2',
            name: 'Vue',
            slug: 'vue',
            createdBy: 'user-001',
          },
        ],
      };
      stageBatchSources(eventData);

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      (inngest.send as jest.Mock).mockResolvedValueOnce({ ids: ['only-one'] });
      await expect(job.execute(eventData)).rejects.toThrow('acknowledged 1/2 Technology sync events');
    });

    it('should sync technologies with linked entities in batch', async () => {
      const eventData = {
        technologies: [
          {
            id: 'tech-1',
            name: 'React',
            slug: 'react',
            createdBy: 'user-001',
            linkedCompanies: ['company-1'],
            linkedUseCases: ['uc-1'],
            conceptIds: ['concept-1'],
          },
        ],
      };
      stageBatchSources(eventData);

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.created).toBe(1);
    });

    it('should handle empty technologies array', async () => {
      const eventData = {
        technologies: [],
      };

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('delegates health and graph writes to the canonical single-item worker', async () => {
      (checkHealth as jest.Mock).mockResolvedValue({
        healthy: false,
        error: 'Connection refused',
      });

      const eventData = {
        technologies: [{ id: 'tech-1', name: 'React', slug: 'react', createdBy: 'user' }],
      };

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;

      const { result } = await job.execute(eventData);
      expect(result.success).toBe(true);
      expect(checkHealth).not.toHaveBeenCalled();
      expect(runWriteTransaction).not.toHaveBeenCalled();
    });

    it('should handle onFailure callback', async () => {
      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        await onFailure({
          error: new Error('Batch failed'),
          event: { data: {} },
        });

        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/technology.batch-sync.failed',
          data: expect.objectContaining({
            error: 'Batch failed',
          }),
        });

        errorSpy.mockRestore();
      }
    });

    it('should use default batch size when not specified', async () => {
      const eventData = {
        technologies: [{ id: 'tech-1', name: 'React', slug: 'react', createdBy: 'user-001' }],
        // No options.batchSize - should default to 50
      };
      stageBatchSources(eventData);

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
    });

    it('does not become a second topology writer for linked technologies', async () => {
      const eventData = {
        technologies: [
          {
            id: 'tech-1',
            name: 'React',
            slug: 'react',
            createdBy: 'user-001',
            linkedCompanies: ['company-missing'],
          },
        ],
      };
      stageBatchSources(eventData);

      const job = batchSyncTechnologiesJob as unknown as ExecutableJob;
      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.created).toBe(1);
      expect(runWriteTransaction).not.toHaveBeenCalled();
      expect(inngest.send).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'app/technology.sync.requested',
          data: { technologyId: 'tech-1', operation: 'update' },
        }),
      ]);
    });
  });

  // ==========================================================================
  // triggerTechnologySync helper
  // ==========================================================================

  describe('triggerTechnologySync', () => {
    it('should send an identifier-only create event (M1/D2 — no inline data field)', async () => {
      await triggerTechnologySync('tech-123', 'create');

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/technology.sync.requested',
        data: {
          technologyId: 'tech-123',
          operation: 'create',
        },
      });
    });

    it('should send an identifier-only delete event', async () => {
      await triggerTechnologySync('tech-123', 'delete');

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/technology.sync.requested',
        data: {
          technologyId: 'tech-123',
          operation: 'delete',
        },
      });
    });

    it('should send update event', async () => {
      await triggerTechnologySync('tech-123', 'update');

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/technology.sync.requested',
        data: expect.objectContaining({
          technologyId: 'tech-123',
          operation: 'update',
        }),
      });
    });
  });
});
