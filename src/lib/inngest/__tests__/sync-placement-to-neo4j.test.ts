/**
 * Tests for sync-placement-to-neo4j.ts
 * Phase 0 Task 0.1.3: RadarPlacement Neo4j Sync Handler
 *
 * Tests the Inngest job that syncs RadarPlacements to Neo4j.
 */

// Mock firebase to prevent fetch error from Firebase Auth
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

// Mock the admin SDK — the sync function reads via firebase-admin directly
// (the previous client-SDK service module hung gRPC streams server-side).
// `placementFixture.current = null` simulates a missing Firestore doc; the
// beforeEach below restores the default.
const DEFAULT_PLACEMENT_FIXTURE = {
  id: 'placement-123',
  technologyId: 'tech-456',
  radarId: 'radar-789',
  quadrantId: 'q_tools',
  ring: 'adopt',
  rationale: 'Test rationale',
  placedBy: 'user-001',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const placementFixture: { current: unknown } = {
  current: DEFAULT_PLACEMENT_FIXTURE,
};
const mockPlacementGet = jest.fn(async () => ({
  exists: placementFixture.current !== null,
  data: () => placementFixture.current,
}));
const technologyFixture: { current: unknown } = {
  current: { id: 'tech-456', name: 'Technology' },
};
const mockTechnologyGet = jest.fn(async () => ({
  exists: technologyFixture.current !== null,
  data: () => technologyFixture.current,
}));
const mockRadarGet = jest.fn(async () => ({
  exists: true,
  id: 'radar-789',
  data: () => ({ id: 'radar-789', name: 'Radar', quadrants: [], entries: [], updatedAt: 100 }),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((name: string) => ({
      doc: jest.fn(() => ({
        get: name === 'radars' ? mockRadarGet : name === 'technologies' ? mockTechnologyGet : mockPlacementGet,
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

// Mock the inngest client
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      // Return a testable function wrapper
      return {
        config,
        trigger,
        handler,
        // Helper for testing
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
          };
          const result = await handler({ event: { id: 'placement-event-1', data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn(),
  },
}));

import { checkHealth, deleteEntityFromGraph, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import { inngest } from '../client';
import { syncPlacementToNeo4jJob, batchSyncPlacementsJob } from '../functions/sync-placement-to-neo4j';

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

describe('sync-placement-to-neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore the Firestore doc fixture (tests simulating a missing doc set it to null)
    placementFixture.current = DEFAULT_PLACEMENT_FIXTURE;
    technologyFixture.current = { id: 'tech-456', name: 'Technology' };
    // Default healthy response
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    // Default successful write transactions - returns QueryExecutionResult
    (runWriteTransaction as jest.Mock).mockResolvedValue(createMockResult([{ id: 'mock-id' }], 1));
    // Default successful read transactions - returns QueryExecutionResult
    (runReadTransaction as jest.Mock).mockResolvedValue(createMockResult([]));
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['accepted-event'] });
    (deleteEntityFromGraph as jest.Mock).mockResolvedValue({
      assertionsDeleted: 0,
      evidenceDeleted: 0,
      projectionsDeleted: 0,
      chunksDeleted: 0,
      endpointsDeleted: 1,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('syncPlacementToNeo4jJob', () => {
    it('should be configured correctly', () => {
      // Access the mock implementation
      const job = syncPlacementToNeo4jJob as unknown as {
        config: { id: string; retries: number; concurrency: { key: string; limit: number } };
        trigger: { event: string };
      };

      expect(job.config.id).toBe('sync-placement-to-neo4j');
      expect(job.config.retries).toBe(3);
      expect(job.config.concurrency).toEqual({ key: 'event.data.placementId', limit: 1 });
      expect(job.trigger.event).toBe('app/radar-placement.sync.requested');
    });

    it('should create a placement successfully', async () => {
      const eventData = {
        operation: 'create',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'adopt',
          rationale: 'Great tool for our needs',
          placedBy: 'user-001',
        },
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; placementId: string; operation: string };
          steps: Record<string, unknown>;
        }>;
      };

      const { result, steps } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.placementId).toBe('placement-123');
      expect(result.operation).toBe('created');
      expect(steps['check-neo4j-health']).toEqual({ healthy: true });
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/radar-placement.sync.completed',
        data: expect.objectContaining({
          placementId: 'placement-123',
          operation: 'created',
        }),
      });
      // Verify runWriteTransaction was called with cypher and params
      expect(runWriteTransaction).toHaveBeenCalled();
    });

    it('prunes structural edges that point at a superseded endpoint (GRAPH-066)', async () => {
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await job.execute({
        operation: 'update',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'adopt',
          placedBy: 'user-001',
        },
      });

      // Every projection query MERGEs, so nothing removes wiring that no longer
      // matches the placement's endpoints. Exactly one PLACES and one ON_RADAR
      // is only an invariant if a prune runs — and it must run AFTER the correct
      // edges exist, never leaving the node transiently unwired.
      const calls = (runWriteTransaction as jest.Mock).mock.calls as Array<[string, Record<string, unknown>]>;
      const pruneIndex = calls.findIndex(([cypher]) => cypher.includes('DELETE r') && cypher.includes('ON_RADAR'));
      expect(pruneIndex).toBeGreaterThan(-1);
      expect(pruneIndex).toBeGreaterThan(calls.findIndex(([cypher]) => cypher.includes('MERGE (p)-[r:PLACES]')));
      expect(pruneIndex).toBeGreaterThan(calls.findIndex(([cypher]) => cypher.includes('MERGE (p)-[rel:ON_RADAR]')));
      expect(calls[pruneIndex][1]).toEqual({
        placementId: 'placement-123',
        technologyId: 'tech-456',
        radarId: 'radar-789',
      });
      // The prune is scoped to THIS placement's own outgoing wiring.
      expect(calls[pruneIndex][0]).toContain('MATCH (p:RadarPlacement {id: $placementId})-[r]->(other)');
    });

    it('waits for Radar projection instead of racing to create a Radar skeleton', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('ON_RADAR')) {
          return createMockResult([]);
        }
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'create',
          placementId: 'placement-123',
          placementData: {
            technologyId: 'tech-456',
            radarId: 'radar-789',
            quadrantId: 'q_tools',
            ring: 'adopt',
            placedBy: 'user-001',
          },
        })
      ).rejects.toThrow(/Radar radar-789 is not projected yet; retry placement placement-123/);

      const onRadarQuery = (runWriteTransaction as jest.Mock).mock.calls
        .map(([cypher]) => cypher as string)
        .find((cypher) => cypher.includes('ON_RADAR'));
      expect(onRadarQuery).toContain('MATCH (r:Radar {id: $radarId})');
      expect(onRadarQuery).not.toContain('MERGE (r:Radar {id: $radarId})');
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/radar.sync.requested',
          data: expect.objectContaining({
            radarId: 'radar-789',
            dispatchKey: 'placement:placement-event-1',
          }),
        })
      );
    });

    it('requeues an existing Technology and fails instead of accepting a zero-row PLACES projection', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES')) {
          return createMockResult([]);
        }
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'create',
          placementId: 'placement-123',
          placementData: {
            technologyId: 'tech-456',
            radarId: 'radar-789',
            quadrantId: 'q_tools',
            ring: 'adopt',
            placedBy: 'user-001',
          },
        })
      ).rejects.toThrow(/Technology tech-456 is not projected yet; retry placement placement-123/);

      expect(mockTechnologyGet).toHaveBeenCalledTimes(1);
      expect(inngest.send).toHaveBeenCalledTimes(1);
      expect(inngest.send).toHaveBeenCalledWith({
        id: expect.stringMatching(/^placement-dependency-v1-technology-[a-f0-9]{64}$/),
        name: 'app/technology.sync.requested',
        data: { operation: 'update', technologyId: 'tech-456' },
      });
      expect(inngest.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app/radar-placement.sync.completed' })
      );
    });

    it('does not dispatch a Technology projection when the Firestore source no longer exists', async () => {
      technologyFixture.current = null;
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES')) return createMockResult([]);
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'update',
          placementId: 'placement-123',
          placementData: DEFAULT_PLACEMENT_FIXTURE,
        })
      ).rejects.toThrow(/Technology tech-456 no longer exists in Firestore/);

      expect(inngest.send).not.toHaveBeenCalled();
    });

    it('converges on retry after the Technology endpoint becomes available', async () => {
      let technologyProjected = false;
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES') && !technologyProjected) {
          return createMockResult([]);
        }
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; relationshipsCreated: number };
        }>;
      };
      const event = {
        operation: 'create',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'adopt',
          placedBy: 'user-001',
        },
      };

      await expect(job.execute(event)).rejects.toThrow(/Technology tech-456 is not projected yet/);
      technologyProjected = true;
      const { result } = await job.execute(event);

      expect(result).toMatchObject({ success: true, relationshipsCreated: 2 });
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/radar-placement.sync.completed',
        data: expect.objectContaining({ placementId: 'placement-123', operation: 'created' }),
      });
    });

    it('uses one deterministic Technology dependency event id across retries of the same placement event', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES')) return createMockResult([]);
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };
      const event = {
        operation: 'update',
        placementId: 'placement-123',
        placementData: DEFAULT_PLACEMENT_FIXTURE,
      };

      await expect(job.execute(event)).rejects.toThrow(/Technology tech-456 is not projected yet/);
      await expect(job.execute(event)).rejects.toThrow(/Technology tech-456 is not projected yet/);

      const technologyEvents = (inngest.send as jest.Mock).mock.calls
        .map(([sent]) => sent as { id?: string; name?: string })
        .filter((sent) => sent.name === 'app/technology.sync.requested');
      expect(technologyEvents).toHaveLength(2);
      expect(technologyEvents[0].id).toMatch(/^placement-dependency-v1-technology-[a-f0-9]{64}$/);
      expect(technologyEvents[1].id).toBe(technologyEvents[0].id);
    });

    it('fails closed when the Technology projection handoff is not acknowledged', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES')) return createMockResult([]);
        return createMockResult([{ id: 'mock-id' }], 1);
      });
      (inngest.send as jest.Mock).mockResolvedValue({ ids: [] });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'update',
          placementId: 'placement-123',
          placementData: DEFAULT_PLACEMENT_FIXTURE,
        })
      ).rejects.toThrow(/Inngest accepted no projection event for Technology tech-456/);

      expect(inngest.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app/radar-placement.sync.completed' })
      );
    });

    it('stamps assertedConfidence and effectiveConfidence = 100 on the PLACES and ON_RADAR wiring edges (B0)', async () => {
      const eventData = {
        operation: 'create',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'adopt',
          rationale: 'Great tool for our needs',
          placedBy: 'user-001',
        },
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };
      await job.execute(eventData);

      const calls = (runWriteTransaction as jest.Mock).mock.calls as Array<[string, unknown]>;
      const placesCall = calls.find(([cypher]) => cypher.includes('PLACES'));
      const onRadarCall = calls.find(([cypher]) => cypher.includes('ON_RADAR'));

      expect(placesCall?.[0]).toContain('r.assertedConfidence = 100');
      expect(placesCall?.[0]).toContain('r.effectiveConfidence = 100');
      expect(placesCall?.[0]).toContain('MATCH (t:Entity:Technology {id: $technologyId})');
      expect(onRadarCall?.[0]).toContain('rel.assertedConfidence = 100');
      expect(onRadarCall?.[0]).toContain('rel.effectiveConfidence = 100');
    });

    it('should update a placement successfully', async () => {
      const eventData = {
        operation: 'update',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'trial', // Changed from adopt to trial
          rationale: 'Updated rationale',
          placedBy: 'user-001',
        },
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; operation: string };
        }>;
      };

      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('updated');
    });

    it('uses the canonical Firestore placement at the graph-write boundary instead of a memoized preflight value', async () => {
      const preflight = { ...DEFAULT_PLACEMENT_FIXTURE, ring: 'Assess', updatedAt: 100 };
      const current = {
        ...DEFAULT_PLACEMENT_FIXTURE,
        quadrantId: 'q_platforms',
        ring: 'Adopt',
        rationale: 'Current source value',
        updatedAt: 200,
      };
      mockPlacementGet
        .mockResolvedValueOnce({ exists: true, data: () => preflight })
        .mockResolvedValueOnce({ exists: true, data: () => current });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await job.execute({ operation: 'update', placementId: 'placement-123' });

      const upsertCall = (runWriteTransaction as jest.Mock).mock.calls.find(([cypher]) =>
        (cypher as string).includes('MERGE (p:RadarPlacement')
      );
      expect(upsertCall?.[1]).toEqual(
        expect.objectContaining({
          quadrantId: 'q_platforms',
          ring: 'Adopt',
          rationale: 'Current source value',
          updatedAt: 200,
        })
      );
      expect(mockPlacementGet).toHaveBeenCalledTimes(2);
    });

    it('removes a partial graph placement when its Firestore source disappears before the write retry', async () => {
      mockPlacementGet
        .mockResolvedValueOnce({ exists: true, data: () => DEFAULT_PLACEMENT_FIXTURE })
        .mockResolvedValueOnce({ exists: false, data: () => null });
      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; operation: string };
        }>;
      };

      const { result } = await job.execute({ operation: 'update', placementId: 'placement-123' });

      expect(deleteEntityFromGraph).toHaveBeenCalledWith('placement-123', 'radarPlacement');
      expect(runWriteTransaction).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, operation: 'deleted' });
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/radar-placement.sync.completed',
        data: expect.objectContaining({ placementId: 'placement-123', operation: 'deleted' }),
      });
    });

    it('should delete a placement successfully', async () => {
      const eventData = {
        operation: 'delete',
        placementId: 'placement-123',
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; operation: string };
        }>;
      };

      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      expect(deleteEntityFromGraph).toHaveBeenCalledWith('placement-123', 'radarPlacement');
    });

    it('should return success when deleting non-existent placement', async () => {
      // Mock that placement does not exist
      (runReadTransaction as jest.Mock).mockResolvedValue(createMockResult([]));

      const eventData = {
        operation: 'delete',
        placementId: 'non-existent',
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; operation: string };
        }>;
      };

      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
    });

    it('runs the atomic endpoint delete even when the Firestore doc is gone', async () => {
      // The doc being absent from Firestore is the EXPECTED state for a
      // delete (it was just removed). The pre-fix code early-exited on the
      // missing doc for ALL operations, leaving the Neo4j RadarPlacement
      // node orphaned forever.
      placementFixture.current = null;

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; placementId: string; operation: string };
        }>;
      };

      const { result } = await job.execute({
        operation: 'delete',
        placementId: 'placement-123',
      });

      expect(deleteEntityFromGraph).toHaveBeenCalledWith('placement-123', 'radarPlacement');
      expect(result).toMatchObject({ success: true, placementId: 'placement-123', operation: 'deleted' });
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/radar-placement.sync.completed',
        data: expect.objectContaining({ placementId: 'placement-123', operation: 'deleted' }),
      });
    });

    it.each(['create', 'update'] as const)(
      'should clean a partial graph node when the source is already missing for %s',
      async (operation) => {
        placementFixture.current = null;

        const job = syncPlacementToNeo4jJob as unknown as {
          execute: (data: Record<string, unknown>) => Promise<{
            result: { placementId: string; operation: string };
          }>;
        };

        const { result } = await job.execute({ operation, placementId: 'placement-raced' });

        expect(runWriteTransaction).not.toHaveBeenCalled();
        expect(runReadTransaction).not.toHaveBeenCalled();
        expect(deleteEntityFromGraph).toHaveBeenCalledWith('placement-raced', 'radarPlacement');
        expect(result).toMatchObject({ placementId: 'placement-raced', operation: 'deleted' });
        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/radar-placement.sync.completed',
          data: expect.objectContaining({ placementId: 'placement-raced', operation: 'deleted' }),
        });
      }
    );

    it('should throw error when Neo4j is not healthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue({
        healthy: false,
        error: 'Connection refused',
      });

      const eventData = {
        operation: 'create',
        placementId: 'placement-123',
        placementData: {
          technologyId: 'tech-456',
          radarId: 'radar-789',
          quadrantId: 'q_tools',
          ring: 'adopt',
          placedBy: 'user-001',
        },
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(job.execute(eventData)).rejects.toThrow('Neo4j not healthy: Connection refused');
    });

    it('should load placement from Firestore when placementData is missing', async () => {
      const eventData = {
        operation: 'create',
        placementId: 'placement-123',
        // Missing placementData - should fallback to Firestore
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; placementId: string; operation: string };
          steps: Record<string, unknown>;
        }>;
      };

      const { result } = await job.execute(eventData);

      // Should succeed by loading from Firestore
      expect(result.success).toBe(true);
      expect(result.placementId).toBe('placement-123');
    });

    it('should throw error for unknown operation', async () => {
      const eventData = {
        operation: 'invalid',
        placementId: 'placement-123',
      };

      const job = syncPlacementToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(job.execute(eventData)).rejects.toThrow('Unknown operation: invalid');
    });

    it('should handle onFailure callback', async () => {
      const job = syncPlacementToNeo4jJob as unknown as {
        config: {
          onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
        };
      };

      const onFailure = job.config.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        await onFailure({
          error: new Error('Test failure'),
          // Inngest v3 onFailure payload: original event nested at event.data.event
          event: { data: { event: { data: { placementId: 'placement-123' } } } },
        });

        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/radar-placement.sync.failed',
          data: expect.objectContaining({
            placementId: 'placement-123',
            error: 'Test failure',
          }),
        });
      }
    });
  });

  describe('batchSyncPlacementsJob', () => {
    it('should be configured correctly', () => {
      const job = batchSyncPlacementsJob as unknown as {
        config: { id: string; retries: number };
        trigger: { event: string };
      };

      expect(job.config.id).toBe('batch-sync-placements-to-neo4j');
      expect(job.config.retries).toBe(2);
      expect(job.trigger.event).toBe('app/radar-placement.batch-sync.requested');
    });

    it('should sync multiple placements successfully', async () => {
      const eventData = {
        placements: [
          {
            id: 'placement-1',
            technologyId: 'tech-1',
            radarId: 'radar-1',
            quadrantId: 'q_tools',
            ring: 'adopt',
            placedBy: 'user-1',
          },
          {
            id: 'placement-2',
            technologyId: 'tech-2',
            radarId: 'radar-1',
            quadrantId: 'q_platforms',
            ring: 'trial',
            placedBy: 'user-1',
          },
        ],
        options: { batchSize: 50 },
      };

      const job = batchSyncPlacementsJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; created: number; failed: number };
        }>;
      };

      const { result } = await job.execute(eventData);

      expect(result.success).toBe(true);
      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/radar-placement.batch-sync.completed',
        data: expect.objectContaining({
          totalPlacements: 2,
          created: 2,
          failed: 0,
        }),
      });
    });

    it('should handle partial failures in batch', async () => {
      // Fail every write for the SECOND placement, keyed on its id rather than a
      // positional call count. The per-placement write sequence is an
      // implementation detail (it gained the GRAPH-066 stale-edge prune), and a
      // positional mock silently retargets the failure when that sequence changes.
      (runWriteTransaction as jest.Mock).mockImplementation(
        async (_cypher: string, params: { placementId?: string }) => {
          if (params?.placementId === 'placement-2') {
            throw new Error('Database error');
          }
          return createMockResult([{ id: 'result' }], 1);
        }
      );

      const eventData = {
        placements: [
          {
            id: 'placement-1',
            technologyId: 'tech-1',
            radarId: 'radar-1',
            quadrantId: 'q_tools',
            ring: 'adopt',
            placedBy: 'user-1',
          },
          {
            id: 'placement-2',
            technologyId: 'tech-2',
            radarId: 'radar-1',
            quadrantId: 'q_platforms',
            ring: 'trial',
            placedBy: 'user-1',
          },
        ],
      };

      const job = batchSyncPlacementsJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; created: number; failed: number; errors: string[] };
        }>;
      };

      const { result } = await job.execute(eventData);

      expect(result.success).toBe(false);
      expect(result.created).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('placement-2');
    });

    it('fails the batch item and hands a zero-row PLACES projection to deterministic dependency retries', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('PLACES')) return createMockResult([]);
        return createMockResult([{ id: 'result' }], 1);
      });
      const job = batchSyncPlacementsJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; created: number; failed: number; errors: string[] };
        }>;
      };

      const { result } = await job.execute({
        placements: [
          {
            id: 'placement-batch-race',
            technologyId: 'tech-456',
            radarId: 'radar-789',
            quadrantId: 'q_tools',
            ring: 'Assess',
            placedBy: 'user-1',
          },
        ],
      });

      expect(result).toMatchObject({ success: false, created: 0, failed: 1 });
      expect(result.errors[0]).toContain('queued retry for placement placement-batch-race');
      expect(inngest.send).toHaveBeenCalledWith({
        id: expect.stringMatching(/^placement-dependency-v1-technology-[a-f0-9]{64}$/),
        name: 'app/technology.sync.requested',
        data: { operation: 'update', technologyId: 'tech-456' },
      });
      expect(inngest.send).toHaveBeenCalledWith({
        id: expect.stringMatching(/^placement-dependency-v1-placement-retry-[a-f0-9]{64}$/),
        name: 'app/radar-placement.sync.requested',
        data: { operation: 'update', placementId: 'placement-batch-race' },
      });
      expect(
        (runWriteTransaction as jest.Mock).mock.calls.some(([cypher]) => (cypher as string).includes('ON_RADAR'))
      ).toBe(false);
    });

    it('hands a zero-row ON_RADAR batch projection to the Radar dependency and exact placement retry', async () => {
      (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string) => {
        if (cypher.includes('ON_RADAR')) return createMockResult([]);
        return createMockResult([{ id: 'result' }], 1);
      });
      const job = batchSyncPlacementsJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; created: number; failed: number; errors: string[] };
        }>;
      };

      const { result } = await job.execute({
        placements: [
          {
            id: 'placement-batch-radar-race',
            technologyId: 'tech-456',
            radarId: 'radar-789',
            quadrantId: 'q_tools',
            ring: 'Assess',
            placedBy: 'user-1',
          },
        ],
      });

      expect(result).toMatchObject({ success: false, created: 0, failed: 1 });
      expect(result.errors[0]).toContain('queued retry for placement placement-batch-radar-race');
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^radar-sync-v1-[a-f0-9]{64}$/),
          name: 'app/radar.sync.requested',
          data: expect.objectContaining({ radarId: 'radar-789' }),
        })
      );
      expect(inngest.send).toHaveBeenCalledWith({
        id: expect.stringMatching(/^placement-dependency-v1-placement-retry-[a-f0-9]{64}$/),
        name: 'app/radar-placement.sync.requested',
        data: { operation: 'update', placementId: 'placement-batch-radar-race' },
      });
    });
  });
});

describe('InngestEvents type definitions', () => {
  it('should have correct event type for placement sync request', () => {
    // Type check - this is a compile-time test
    const event: {
      name: 'app/radar-placement.sync.requested';
      data: {
        operation: 'create' | 'update' | 'delete';
        placementId: string;
        placementData?: {
          technologyId: string;
          radarId: string;
          quadrantId: string;
          ring: string;
          rationale?: string;
          placedBy: string;
        };
      };
    } = {
      name: 'app/radar-placement.sync.requested',
      data: {
        operation: 'create',
        placementId: 'test-123',
        placementData: {
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrantId: 'q_tools',
          ring: 'adopt',
          placedBy: 'user-1',
        },
      },
    };

    expect(event.name).toBe('app/radar-placement.sync.requested');
    expect(event.data.operation).toBe('create');
  });
});
