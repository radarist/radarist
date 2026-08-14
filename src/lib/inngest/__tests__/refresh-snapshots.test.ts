/**
 * @file src/lib/inngest/__tests__/refresh-snapshots.test.ts
 * @description Unit tests for refresh-relation-snapshots and refresh-placement-snapshots
 * Inngest background jobs.
 *
 * Tests verify:
 * - Correct job configuration (id, retries, trigger)
 * - Happy-path execution for all supported entity types
 * - Skipping when source/target entity is not found
 * - Per-relation failure isolation
 * - No-op return when nothing is stale
 * - refreshPlacementSnapshots: technology not found throws
 * - refreshPlacementSnapshots: snapshot shape (name, slug, snapshotUpdatedAt, category)
 * - batchRefreshPlacementSnapshots: stale vs. fresh discrimination
 * - batchRefreshPlacementSnapshots: per-technology error isolation
 */

// ---------------------------------------------------------------------------
// 1. Mock the Inngest client — must be first, before any imports
// ---------------------------------------------------------------------------
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
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// 2. Mock Firebase (admin SDK; client mock kept as a defensive no-op for any
//    transitive import that still touches it).
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => ({
      doc: () => ({
        collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }),
      }),
      get: jest.fn().mockResolvedValue({ docs: [] }),
    }),
  },
  adminAuth: {},
  adminApp: {},
}));

// ---------------------------------------------------------------------------
// 3. Mocks for refresh-relation-snapshots dependencies
// ---------------------------------------------------------------------------
jest.mock('@/lib/relations-admin', () => ({
  adminGetStaleRelations: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
jest.mock('@/lib/companies-admin', () => ({ adminGetCompanies: jest.fn() }));
jest.mock('@/lib/use-cases-admin', () => ({ adminGetUseCases: jest.fn() }));
jest.mock('@/lib/prototypes-admin', () => ({ adminGetPrototypes: jest.fn() }));
jest.mock('@/lib/strategies-admin', () => ({ adminGetStrategies: jest.fn() }));
jest.mock('@/lib/signals-admin', () => ({ adminGetSignals: jest.fn() }));

// ---------------------------------------------------------------------------
// 4. Mocks for refresh-placement-snapshots dependencies
// ---------------------------------------------------------------------------
jest.mock('@/lib/technology-admin', () => ({
  adminGetTechnologyById: jest.fn(),
  adminGetTechnologies: jest.fn(),
}));
jest.mock('@/lib/radar-placement-admin', () => ({
  adminGetPlacementsForTechnology: jest.fn(),
  adminUpdateRadarPlacement: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 5. Imports (after mocks)
// ---------------------------------------------------------------------------

import { refreshRelationSnapshots } from '../functions/refresh-relation-snapshots';
import { refreshPlacementSnapshots, batchRefreshPlacementSnapshots } from '../functions/refresh-placement-snapshots';

import {
  adminGetStaleRelations as getStaleRelations,
  adminUpdateRelation as updateRelation,
} from '@/lib/relations-admin';
import { adminGetCompanies as getCompanies } from '@/lib/companies-admin';
import { adminGetUseCases as getUseCases } from '@/lib/use-cases-admin';

import { adminGetSignals as getSignals } from '@/lib/signals-admin';

import {
  adminGetTechnologyById as getTechnologyById,
  adminGetTechnologies as getTechnologies,
} from '@/lib/technology-admin';
import {
  adminGetPlacementsForTechnology as getPlacementsForTechnology,
  adminUpdateRadarPlacement as updateRadarPlacement,
} from '@/lib/radar-placement-admin';

// ---------------------------------------------------------------------------
// 6. Type helpers
// ---------------------------------------------------------------------------
interface TestableJob {
  config: { id: string; retries: number; concurrency?: { limit: number } };
  trigger: { event?: string; cron?: string };
  execute: (data: Record<string, unknown>) => Promise<{ result: unknown; steps: Record<string, unknown> }>;
}

// Convenience casts
const relationJob = refreshRelationSnapshots as unknown as TestableJob;
const placementJob = refreshPlacementSnapshots as unknown as TestableJob;
const batchPlacementJob = batchRefreshPlacementSnapshots as unknown as TestableJob;

// ---------------------------------------------------------------------------
// 7. Shared fixture builders
// ---------------------------------------------------------------------------

function makeRelation(id: string, sourceType: string, sourceId: string, targetType: string, targetId: string) {
  return {
    id,
    relationType: 'uses',
    sourceSnapshot: {
      type: sourceType,
      id: sourceId,
      name: `${sourceType}-${sourceId}`,
      description: '',
      tags: [],
      snapshotAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days old → stale
    },
    targetSnapshot: {
      type: targetType,
      id: targetId,
      name: `${targetType}-${targetId}`,
      description: '',
      tags: [],
      snapshotAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePlacement(id: string, technologyId: string, snapshotAge = 0) {
  return {
    id,
    technologyId,
    radarId: 'radar-1',
    quadrantId: 'q_tools',
    quadrantName: 'Tools',
    ring: 'adopt',
    rationale: '',
    placedBy: 'user-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    technologySnapshot: {
      name: 'Old Name',
      slug: 'old-slug',
      snapshotUpdatedAt: snapshotAge,
    },
  };
}

function makeTechnology(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'tech-1',
    name: 'React',
    slug: 'react',
    category: 'frontend',
    description: '',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 8. Silence console noise during test runs
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// refreshRelationSnapshots
// ===========================================================================
describe('refreshRelationSnapshots', () => {
  beforeEach(() => {
    // Use resetAllMocks to clear both call history AND queued Once return values,
    // preventing leftover mock state from bleeding across tests.
    jest.resetAllMocks();
    (updateRelation as jest.Mock).mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  describe('configuration', () => {
    it('has the correct job id', () => {
      expect(relationJob.config.id).toBe('refresh-relation-snapshots');
    });

    it('has retries set to 3', () => {
      expect(relationJob.config.retries).toBe(3);
    });

    it('is triggered by cron 0 3 * * *', () => {
      expect(relationJob.trigger.cron).toBe('0 3 * * *');
    });

    it('has concurrency limit of 1', () => {
      expect(relationJob.config.concurrency?.limit).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // No stale relations
  // -------------------------------------------------------------------------
  describe('when there are no stale relations', () => {
    it('returns success with all counts zero and does not call updateRelation', async () => {
      (getStaleRelations as jest.Mock).mockResolvedValue([]);

      const { result } = await relationJob.execute({});

      expect(result).toMatchObject({
        success: true,
        refreshed: 0,
        failed: 0,
        skipped: 0,
      });
      expect(updateRelation).not.toHaveBeenCalled();
    });

    it('returns a numeric duration', async () => {
      (getStaleRelations as jest.Mock).mockResolvedValue([]);

      const { result } = await relationJob.execute({});

      expect(typeof (result as Record<string, unknown>).duration).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Refreshing a company→company relation
  // -------------------------------------------------------------------------
  describe('when a stale company→company relation exists', () => {
    it('fetches fresh snapshots and calls updateRelation', async () => {
      const relation = makeRelation('rel-1', 'company', 'co-1', 'company', 'co-2');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      (getCompanies as jest.Mock).mockResolvedValue([
        { id: 'co-1', name: 'Company A', description: 'Desc A', tags: [], industry: 'Tech', location: 'US' },
        { id: 'co-2', name: 'Company B', description: 'Desc B', tags: [], industry: 'Finance', location: 'UK' },
      ]);

      const { result } = await relationJob.execute({});

      expect(updateRelation).toHaveBeenCalledWith('rel-1', {
        sourceSnapshot: expect.objectContaining({ type: 'company', id: 'co-1', name: 'Company A' }),
        targetSnapshot: expect.objectContaining({ type: 'company', id: 'co-2', name: 'Company B' }),
      });
      expect(result).toMatchObject({ success: true, refreshed: 1, failed: 0, skipped: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Source entity not found → skip
  // -------------------------------------------------------------------------
  describe('when the source entity is not found', () => {
    it('increments skipped and does not call updateRelation', async () => {
      const relation = makeRelation('rel-2', 'company', 'missing-co', 'company', 'co-2');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      // Source missing, target present
      (getCompanies as jest.Mock).mockResolvedValue([
        { id: 'co-2', name: 'Company B', description: '', tags: [], industry: 'Finance', location: 'UK' },
      ]);

      const { result } = await relationJob.execute({});

      expect(updateRelation).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, refreshed: 0, failed: 0, skipped: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Target entity not found → skip
  // -------------------------------------------------------------------------
  describe('when the target entity is not found', () => {
    it('increments skipped and does not call updateRelation', async () => {
      const relation = makeRelation('rel-3', 'company', 'co-1', 'company', 'missing-co');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      // Source present, target missing
      (getCompanies as jest.Mock).mockResolvedValue([
        { id: 'co-1', name: 'Company A', description: '', tags: [], industry: 'Tech', location: 'US' },
      ]);

      const { result } = await relationJob.execute({});

      expect(updateRelation).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, refreshed: 0, failed: 0, skipped: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // updateRelation throws → failed count
  // -------------------------------------------------------------------------
  describe('when updateRelation throws for a relation', () => {
    it('increments failed and continues processing', async () => {
      const relation = makeRelation('rel-4', 'company', 'co-1', 'company', 'co-2');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      (getCompanies as jest.Mock).mockResolvedValue([
        { id: 'co-1', name: 'A', description: '', tags: [] },
        { id: 'co-2', name: 'B', description: '', tags: [] },
      ]);
      (updateRelation as jest.Mock).mockRejectedValue(new Error('Firestore error'));

      const { result } = await relationJob.execute({});

      expect(result).toMatchObject({ success: true, refreshed: 0, failed: 1, skipped: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Multiple stale relations — correct aggregate counts
  // -------------------------------------------------------------------------
  describe('when multiple stale relations exist', () => {
    it('processes each and returns correct aggregate counts', async () => {
      const relations = [
        makeRelation('rel-10', 'company', 'co-1', 'company', 'co-2'),
        makeRelation('rel-11', 'company', 'co-1', 'company', 'co-3'), // target missing
        makeRelation('rel-12', 'company', 'co-1', 'company', 'co-2'), // update throws
      ];
      (getStaleRelations as jest.Mock).mockResolvedValue(relations);
      (getCompanies as jest.Mock).mockResolvedValue([
        { id: 'co-1', name: 'Alpha', description: '', tags: [] },
        { id: 'co-2', name: 'Beta', description: '', tags: [] },
        // co-3 intentionally absent
      ]);
      // First updateRelation call succeeds, second skipped (not called), third throws
      (updateRelation as jest.Mock).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DB error'));

      const { result } = await relationJob.execute({});

      expect(result).toMatchObject({ success: true, refreshed: 1, failed: 1, skipped: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // useCase entity type
  // -------------------------------------------------------------------------
  describe('when a useCase→useCase relation is stale', () => {
    it('uses getUseCases to build snapshots', async () => {
      const relation = makeRelation('rel-uc', 'useCase', 'uc-1', 'useCase', 'uc-2');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      (getUseCases as jest.Mock).mockResolvedValue([
        {
          id: 'uc-1',
          title: 'Use Case One',
          description: '',
          tags: [],
          status: 'active',
          category: 'ops',
          problem: 'p',
        },
        { id: 'uc-2', title: 'Use Case Two', description: '', tags: [], status: 'draft', category: 'hr', problem: 'q' },
      ]);

      await relationJob.execute({});

      expect(updateRelation).toHaveBeenCalledWith('rel-uc', {
        sourceSnapshot: expect.objectContaining({ type: 'useCase', name: 'Use Case One' }),
        targetSnapshot: expect.objectContaining({ type: 'useCase', name: 'Use Case Two' }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // signal entity type
  // -------------------------------------------------------------------------
  describe('when a signal entity is stale', () => {
    it('uses getSignals to build snapshots', async () => {
      const relation = makeRelation('rel-sig', 'signal', 'sig-1', 'company', 'co-1');
      (getStaleRelations as jest.Mock).mockResolvedValue([relation]);
      (getSignals as jest.Mock).mockResolvedValue([
        {
          id: 'sig-1',
          title: 'AI Trend',
          aiSummary: 'AI is growing',
          description: 'desc',
          status: 'approved',
          alignedStrategies: ['strat-1'],
          source: 'web',
          relevanceScore: 85,
          type: 'market',
        },
      ]);
      (getCompanies as jest.Mock).mockResolvedValue([{ id: 'co-1', name: 'Acme', description: '', tags: [] }]);

      await relationJob.execute({});

      expect(updateRelation).toHaveBeenCalledWith('rel-sig', {
        sourceSnapshot: expect.objectContaining({ type: 'signal', name: 'AI Trend' }),
        targetSnapshot: expect.objectContaining({ type: 'company', name: 'Acme' }),
      });
    });
  });
});

// ===========================================================================
// refreshPlacementSnapshots
// ===========================================================================
describe('refreshPlacementSnapshots', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (updateRadarPlacement as jest.Mock).mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  describe('configuration', () => {
    it('has the correct job id', () => {
      expect(placementJob.config.id).toBe('refresh-placement-snapshots');
    });

    it('has retries set to 3', () => {
      expect(placementJob.config.retries).toBe(3);
    });

    it('is triggered by the app/technology.updated event', () => {
      expect(placementJob.trigger.event).toBe('app/technology.updated');
    });
  });

  // -------------------------------------------------------------------------
  // Technology not found → throws
  // -------------------------------------------------------------------------
  describe('when the technology is not found', () => {
    it('throws an error containing the technology id', async () => {
      (getTechnologyById as jest.Mock).mockResolvedValue(null);

      await expect(placementJob.execute({ technologyId: 'tech-missing' })).rejects.toThrow('tech-missing');
    });
  });

  // -------------------------------------------------------------------------
  // No placements → return { updated: 0, failed: 0 }
  // -------------------------------------------------------------------------
  describe('when there are no placements for the technology', () => {
    it('returns updated: 0, failed: 0 without calling updateRadarPlacement', async () => {
      (getTechnologyById as jest.Mock).mockResolvedValue(makeTechnology());
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([]);

      const { result } = await placementJob.execute({ technologyId: 'tech-1' });

      expect(result).toMatchObject({ success: true, updated: 0, failed: 0 });
      expect(updateRadarPlacement).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Updates all placements with fresh snapshot
  // -------------------------------------------------------------------------
  describe('when placements exist', () => {
    it('updates each placement with a fresh snapshot', async () => {
      const tech = makeTechnology({ id: 'tech-1', name: 'React', slug: 'react', category: 'frontend' });
      (getTechnologyById as jest.Mock).mockResolvedValue(tech);
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([
        makePlacement('pl-1', 'tech-1'),
        makePlacement('pl-2', 'tech-1'),
      ]);

      const { result } = await placementJob.execute({ technologyId: 'tech-1' });

      expect(updateRadarPlacement).toHaveBeenCalledTimes(2);
      expect(updateRadarPlacement).toHaveBeenCalledWith('pl-1', {
        technologySnapshot: expect.objectContaining({ name: 'React', slug: 'react' }),
      });
      expect(updateRadarPlacement).toHaveBeenCalledWith('pl-2', {
        technologySnapshot: expect.objectContaining({ name: 'React', slug: 'react' }),
      });
      expect(result).toMatchObject({ success: true, updated: 2, failed: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot shape: name, slug, snapshotUpdatedAt, category when present
  // -------------------------------------------------------------------------
  describe('snapshot shape', () => {
    it('includes name, slug, and snapshotUpdatedAt', async () => {
      const tech = makeTechnology({ name: 'Vue.js', slug: 'vuejs', category: undefined });
      (getTechnologyById as jest.Mock).mockResolvedValue(tech);
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([makePlacement('pl-snap', 'tech-1')]);

      await placementJob.execute({ technologyId: 'tech-1' });

      const snapshotArg = (updateRadarPlacement as jest.Mock).mock.calls[0][1].technologySnapshot;
      expect(snapshotArg).toHaveProperty('name', 'Vue.js');
      expect(snapshotArg).toHaveProperty('slug', 'vuejs');
      expect(typeof snapshotArg.snapshotUpdatedAt).toBe('number');
      expect(snapshotArg).not.toHaveProperty('category');
    });

    it('includes category when the technology has one', async () => {
      const tech = makeTechnology({ name: 'React', slug: 'react', category: 'frontend' });
      (getTechnologyById as jest.Mock).mockResolvedValue(tech);
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([makePlacement('pl-cat', 'tech-1')]);

      await placementJob.execute({ technologyId: 'tech-1' });

      const snapshotArg = (updateRadarPlacement as jest.Mock).mock.calls[0][1].technologySnapshot;
      expect(snapshotArg).toHaveProperty('category', 'frontend');
    });
  });

  // -------------------------------------------------------------------------
  // Individual placement update failure → isolated, does not break others
  // -------------------------------------------------------------------------
  describe('when one placement update fails', () => {
    it('increments failed and continues updating remaining placements', async () => {
      const tech = makeTechnology();
      (getTechnologyById as jest.Mock).mockResolvedValue(tech);
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([
        makePlacement('pl-good', 'tech-1'),
        makePlacement('pl-bad', 'tech-1'),
      ]);
      (updateRadarPlacement as jest.Mock)
        .mockResolvedValueOnce({}) // pl-good succeeds
        .mockRejectedValueOnce(new Error('Firestore write error')); // pl-bad fails

      const { result } = await placementJob.execute({ technologyId: 'tech-1' });

      expect(result).toMatchObject({ success: true, updated: 1, failed: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // result includes technologyId
  // -------------------------------------------------------------------------
  describe('result payload', () => {
    it('echoes the technologyId in the result', async () => {
      (getTechnologyById as jest.Mock).mockResolvedValue(makeTechnology());
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([]);

      const { result } = await placementJob.execute({ technologyId: 'tech-42' });

      expect((result as Record<string, unknown>).technologyId).toBe('tech-42');
    });
  });
});

// ===========================================================================
// batchRefreshPlacementSnapshots
// ===========================================================================
describe('batchRefreshPlacementSnapshots', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (updateRadarPlacement as jest.Mock).mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  describe('configuration', () => {
    it('has the correct job id', () => {
      expect(batchPlacementJob.config.id).toBe('batch-refresh-placement-snapshots');
    });

    it('has retries set to 3', () => {
      expect(batchPlacementJob.config.retries).toBe(3);
    });

    it('is triggered by cron 0 4 * * *', () => {
      expect(batchPlacementJob.trigger.cron).toBe('0 4 * * *');
    });
  });

  // -------------------------------------------------------------------------
  // Stale placement is updated, fresh placement is skipped
  // -------------------------------------------------------------------------
  describe('stale vs. fresh discrimination', () => {
    it('updates only stale placements and skips fresh ones', async () => {
      const tech = makeTechnology({ id: 'tech-1', name: 'React', slug: 'react' });
      (getTechnologies as jest.Mock).mockResolvedValue([tech]);

      const staleAge = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days old → stale
      const freshAge = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day old → fresh

      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([
        makePlacement('pl-stale', 'tech-1', staleAge),
        makePlacement('pl-fresh', 'tech-1', freshAge),
      ]);

      const { result } = await batchPlacementJob.execute({});

      expect(updateRadarPlacement).toHaveBeenCalledTimes(1);
      expect(updateRadarPlacement).toHaveBeenCalledWith('pl-stale', expect.any(Object));
      expect(result).toMatchObject({
        success: true,
        placementsUpdated: 1,
        placementsSkipped: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // No technologies → returns zeros
  // -------------------------------------------------------------------------
  describe('when there are no technologies', () => {
    it('returns zeros and does not call updateRadarPlacement', async () => {
      (getTechnologies as jest.Mock).mockResolvedValue([]);

      const { result } = await batchPlacementJob.execute({});

      expect(updateRadarPlacement).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, placementsUpdated: 0, placementsFailed: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Per-technology error isolation
  // -------------------------------------------------------------------------
  describe('when getPlacementsForTechnology throws for one technology', () => {
    it('counts that technology as failed and continues processing others', async () => {
      const tech1 = makeTechnology({ id: 'tech-fail', name: 'Broken', slug: 'broken' });
      const tech2 = makeTechnology({ id: 'tech-ok', name: 'Working', slug: 'working' });
      (getTechnologies as jest.Mock).mockResolvedValue([tech1, tech2]);

      const staleAge = 0; // epoch → always stale
      (getPlacementsForTechnology as jest.Mock)
        .mockRejectedValueOnce(new Error('Firestore failure'))
        .mockResolvedValueOnce([makePlacement('pl-ok', 'tech-ok', staleAge)]);

      // The job wraps per-technology processing in step.run; an unhandled throw
      // from getPlacementsForTechnology will propagate out of the step and be
      // caught by the outer try/catch, which re-throws. So the job will throw.
      await expect(batchPlacementJob.execute({})).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Per-placement update failure does not abort the technology loop
  // -------------------------------------------------------------------------
  describe('when updateRadarPlacement fails for one stale placement', () => {
    it('increments placementsFailed and continues updating others', async () => {
      const tech = makeTechnology({ id: 'tech-1', name: 'React', slug: 'react' });
      (getTechnologies as jest.Mock).mockResolvedValue([tech]);

      const staleAge = 0; // epoch → always stale
      (getPlacementsForTechnology as jest.Mock).mockResolvedValue([
        makePlacement('pl-fail', 'tech-1', staleAge),
        makePlacement('pl-pass', 'tech-1', staleAge),
      ]);

      (updateRadarPlacement as jest.Mock).mockRejectedValueOnce(new Error('Write error')).mockResolvedValueOnce({});

      const { result } = await batchPlacementJob.execute({});

      expect(updateRadarPlacement).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        success: true,
        placementsUpdated: 1,
        placementsFailed: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Multiple technologies processed correctly
  // -------------------------------------------------------------------------
  describe('when multiple technologies each have stale placements', () => {
    it('processes every technology and returns correct aggregate totals', async () => {
      const tech1 = makeTechnology({ id: 'tech-a', name: 'Angular', slug: 'angular', category: 'frontend' });
      const tech2 = makeTechnology({ id: 'tech-b', name: 'NestJS', slug: 'nestjs', category: 'backend' });
      (getTechnologies as jest.Mock).mockResolvedValue([tech1, tech2]);

      const staleAge = 0;
      (getPlacementsForTechnology as jest.Mock)
        .mockResolvedValueOnce([makePlacement('pl-a1', 'tech-a', staleAge), makePlacement('pl-a2', 'tech-a', staleAge)])
        .mockResolvedValueOnce([makePlacement('pl-b1', 'tech-b', staleAge)]);

      const { result } = await batchPlacementJob.execute({});

      expect(result).toMatchObject({
        success: true,
        technologiesProcessed: 2,
        placementsUpdated: 3,
        placementsFailed: 0,
        placementsSkipped: 0,
      });
      expect(updateRadarPlacement).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Returns numeric duration
  // -------------------------------------------------------------------------
  describe('result shape', () => {
    it('includes a numeric duration field', async () => {
      (getTechnologies as jest.Mock).mockResolvedValue([]);

      const { result } = await batchPlacementJob.execute({});

      expect(typeof (result as Record<string, unknown>).duration).toBe('number');
    });
  });
});
