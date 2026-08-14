/**
 * PERF-007 replay-integrity regressions for the reconciliation jobs.
 *
 * The pre-existing suite drives steps with a harness that re-executes every
 * `step.run` on every attempt. Real Inngest does not: a step that completed is
 * memoized *by its return value* and its body never runs again. That gap is
 * exactly why a job which recorded its work by mutating a handler-closure
 * variable could look correct in tests and lose every counter in production.
 *
 * The harness below models the real semantics — completed steps replay from
 * memo, a step that threw is not memoized and re-runs — so these tests fail
 * against the closure-mutating implementation for the right reason.
 */

const mockCollectionGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => ({
      get: () => mockCollectionGet(name),
      select: () => ({ get: () => mockCollectionGet(name) }),
    }),
  },
}));

jest.mock('@/lib/graph/signal-projection-policy-admin', () => ({
  loadEligibleSignalProjectionIds: jest.fn(async () => {
    const snapshot = await mockCollectionGet('signals');
    return snapshot.docs.map((document: { id: string }) => document.id);
  }),
}));

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn().mockResolvedValue({ records: [{ fixed: 0 }] }),
}));

jest.mock('@/lib/graph/projection-reconciliation-runner', () => ({
  runProjectionReconciliationCycle: jest.fn(),
}));

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({ config, trigger, handler })),
    send: jest.fn(),
  },
}));

import { checkHealth, runReadTransaction } from '@/lib/graph';
import { runProjectionReconciliationCycle } from '@/lib/graph/projection-reconciliation-runner';
import { inngest } from '../client';
import {
  REMOVED_LEGACY_RECONCILIATION_MODE_ENV,
  assertLegacyReconciliationModeRemoved,
  fullSyncJob,
  reconcileFirestoreNeo4jJob,
} from '../functions/reconcile-firestore-neo4j';

// ============================================================================
// REPLAY HARNESS
// ============================================================================

interface InngestHandlerArgs {
  event: { id?: string; data: Record<string, unknown> };
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    sleep: (name: string, duration: string) => Promise<void>;
  };
}

type InngestJob = { handler: (args: InngestHandlerArgs) => Promise<Record<string, unknown>> };

/**
 * A durable-execution harness with real memoization semantics.
 *
 * One instance represents one Inngest *run*; each `attempt()` is one delivery
 * of that run. Steps that completed in an earlier attempt return their stored
 * value without re-executing, which is the only condition under which the
 * closure-mutation defect is observable.
 */
function createRun() {
  const memo = new Map<string, unknown>();
  const bodiesExecuted: string[] = [];

  async function attempt(
    job: InngestJob,
    event: { id?: string; data: Record<string, unknown> },
    failAtStep?: string
  ): Promise<Record<string, unknown>> {
    const step = {
      async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (memo.has(name)) return memo.get(name) as T;
        if (name === failAtStep) {
          bodiesExecuted.push(name);
          throw new Error(`injected failure at ${name}`);
        }
        const result = await fn();
        bodiesExecuted.push(name);
        memo.set(name, result);
        return result;
      },
      async sleep(): Promise<void> {},
    };
    return job.handler({ event, step });
  }

  return { attempt, memo, bodiesExecuted };
}

// ============================================================================
// FIXTURES
// ============================================================================

function snapshot(ids: string[]) {
  return {
    size: ids.length,
    docs: ids.map((id) => ({ id, data: () => ({}) })),
  };
}

/** Every collection the full sync reads, with a couple of rows that need syncing. */
function setupFirestore(): void {
  const rows: Record<string, string[]> = {
    companies: ['comp-1', 'comp-2'],
    technologies: ['tech-1'],
    strategies: [],
    painPoints: [],
    'use-cases': [],
    signals: [],
    'org-units': [],
    initiatives: [],
    prototypes: [],
    documents: ['doc-1'],
    radars: [],
    radarPlacements: ['rp-1'],
    concepts: ['concept-1'],
    relations: ['rel-1', 'rel-2'],
    entityDocumentLinks: ['link-1'],
  };
  mockCollectionGet.mockImplementation(async (name: string) => snapshot(rows[name] ?? []));
}

/** Neo4j holds nothing, so every Firestore row counts as missing. */
function setupEmptyGraph(): void {
  (runReadTransaction as jest.Mock).mockResolvedValue({ records: [] });
}

function sentEventIds(): string[] {
  return (inngest.send as jest.Mock).mock.calls
    .map(([event]) => (event as { id?: string }).id)
    .filter((id): id is string => typeof id === 'string');
}

// ============================================================================
// TESTS
// ============================================================================

describe('reconciliation replay integrity (PERF-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[REMOVED_LEGACY_RECONCILIATION_MODE_ENV];
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['accepted'] });
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    setupFirestore();
    setupEmptyGraph();
    (runProjectionReconciliationCycle as jest.Mock).mockImplementation(async () => ({
      timestamp: 1,
      syncsTriggered: 7,
      repairsApplied: 2,
      errors: [],
      repairPlan: { planHash: 'b'.repeat(64) },
    }));
  });

  afterEach(() => {
    delete process.env[REMOVED_LEGACY_RECONCILIATION_MODE_ENV];
  });

  // ==========================================================================
  // Removed legacy path
  // ==========================================================================

  describe('removed legacy reconciler', () => {
    it('rejects the value that used to select the removed path', () => {
      process.env[REMOVED_LEGACY_RECONCILIATION_MODE_ENV] = 'true';

      expect(() => assertLegacyReconciliationModeRemoved()).toThrow(/removed in PERF-007/);
    });

    it('names the variable and the required operator action', () => {
      expect(() =>
        assertLegacyReconciliationModeRemoved({ [REMOVED_LEGACY_RECONCILIATION_MODE_ENV]: 'true' })
      ).toThrow(/Unset the variable/);
    });

    it('leaves an inert leftover value alone', () => {
      expect(() =>
        assertLegacyReconciliationModeRemoved({ [REMOVED_LEGACY_RECONCILIATION_MODE_ENV]: 'false' })
      ).not.toThrow();
      expect(() => assertLegacyReconciliationModeRemoved({})).not.toThrow();
    });

    it('fails the scheduled cycle instead of silently running a different algorithm', async () => {
      process.env[REMOVED_LEGACY_RECONCILIATION_MODE_ENV] = 'true';
      const run = createRun();

      await expect(
        run.attempt(reconcileFirestoreNeo4jJob as unknown as InngestJob, { id: 'evt-1', data: {} })
      ).rejects.toThrow(/removed in PERF-007/);
      expect(runProjectionReconciliationCycle).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Scheduled job — durable report
  // ==========================================================================

  describe('scheduled reconciliation', () => {
    const job = reconcileFirestoreNeo4jJob as unknown as InngestJob;

    it('returns the memoized cycle report on replay without re-running the cycle', async () => {
      const run = createRun();

      await expect(
        run.attempt(job, { id: 'evt-1', data: {} }, 'fix-orphan-edges-v1')
      ).rejects.toThrow(/injected failure/);
      const replay = await run.attempt(job, { id: 'evt-1', data: {} });

      // The expensive cycle ran once; the replay read its durable return value.
      expect(runProjectionReconciliationCycle).toHaveBeenCalledTimes(1);
      expect(replay.report).toEqual(
        expect.objectContaining({ syncsTriggered: 7, repairsApplied: 2 })
      );
    });

    it('derives success from the durable report rather than asserting it', async () => {
      (runProjectionReconciliationCycle as jest.Mock).mockResolvedValue({
        timestamp: 1,
        syncsTriggered: 0,
        repairsApplied: 0,
        errors: ['companies/comp-1: dispatch rejected'],
        repairPlan: { planHash: 'c'.repeat(64) },
      });
      const run = createRun();

      const result = await run.attempt(job, { id: 'evt-1', data: {} });

      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Full sync — durable counters and stable dispatch identity
  // ==========================================================================

  describe('full sync', () => {
    const job = fullSyncJob as unknown as InngestJob;

    it('reports the work earlier attempts did instead of a zeroed closure', async () => {
      const run = createRun();

      await expect(
        run.attempt(job, { id: 'evt-full-1', data: { phase: 'all' } }, 'full-sync-relations')
      ).rejects.toThrow(/injected failure/);
      const replay = await run.attempt(job, { id: 'evt-full-1', data: { phase: 'all' } });

      // comp-1, comp-2, tech-1, doc-1, rp-1, concept-1 were dispatched during
      // the first attempt. A closure-based counter reports 0 here.
      expect(replay.entitiesSynced).toBe(6);
      expect(replay.relationsSynced).toBe(2);
      expect(replay.documentLinksSynced).toBe(1);
      expect(replay.success).toBe(true);
    });

    it('does not re-dispatch entity syncs whose step already completed', async () => {
      const run = createRun();

      await expect(
        run.attempt(job, { id: 'evt-full-1', data: { phase: 'all' } }, 'full-sync-relations')
      ).rejects.toThrow(/injected failure/);
      const afterFirstAttempt = sentEventIds().filter((id) => id.includes(':company:'));
      const beforeReplay = (inngest.send as jest.Mock).mock.calls.length;

      await run.attempt(job, { id: 'evt-full-1', data: { phase: 'all' } });

      const replaySends = (inngest.send as jest.Mock).mock.calls
        .slice(beforeReplay)
        .map(([event]) => (event as { id?: string }).id);
      expect(afterFirstAttempt).toHaveLength(2);
      expect(replaySends.some((id) => typeof id === 'string' && id.includes(':company:'))).toBe(
        false
      );
    });

    it('gives every dispatch a replay-stable identity for the same run', async () => {
      const first = await createRun().attempt(job, { id: 'evt-same', data: { phase: 'entities' } });
      const firstIds = sentEventIds();
      const firstSendCount = (inngest.send as jest.Mock).mock.calls.length;
      (inngest.send as jest.Mock).mockClear();

      const second = await createRun().attempt(job, { id: 'evt-same', data: { phase: 'entities' } });

      // Asserting equality alone would pass vacuously against an implementation
      // that stamps no IDs at all, so require that every send carried one.
      expect(firstSendCount).toBe(6);
      expect(firstIds).toHaveLength(firstSendCount);
      expect(second.entitiesSynced).toBe(first.entitiesSynced);
      expect(sentEventIds()).toEqual(firstIds);
    });

    it('gives two separate runs distinct identities so neither is deduplicated away', async () => {
      await createRun().attempt(job, { id: 'evt-run-a', data: { phase: 'entities' } });
      const runA = sentEventIds();
      (inngest.send as jest.Mock).mockClear();

      await createRun().attempt(job, { id: 'evt-run-b', data: { phase: 'entities' } });
      const runB = sentEventIds();

      expect(runA).not.toHaveLength(0);
      expect(runA).toHaveLength(runB.length);
      expect(runA.filter((id) => runB.includes(id))).toEqual([]);
    });

    it('refuses to run without a triggering event ID rather than inventing one', async () => {
      const run = createRun();

      await expect(run.attempt(job, { data: { phase: 'entities' } })).rejects.toThrow(
        /replay-stable dispatch identity/
      );
      expect(inngest.send).not.toHaveBeenCalled();
    });

    it('bounds the diagnostics it carries in a durable result', async () => {
      mockCollectionGet.mockImplementation(async (name: string) =>
        name === 'companies'
          ? snapshot(Array.from({ length: 80 }, (_, index) => `comp-${index}`))
          : snapshot([])
      );
      (inngest.send as jest.Mock).mockRejectedValue(new Error('dispatch rejected'));
      const run = createRun();

      const result = await run.attempt(job, { id: 'evt-bounded', data: { phase: 'entities' } });

      expect((result.errors as string[]).length).toBe(50);
      expect(result.success).toBe(false);
    });
  });
});
