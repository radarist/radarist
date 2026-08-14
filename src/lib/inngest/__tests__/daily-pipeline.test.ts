/**
 * @jest-environment node
 * @file lib/inngest/__tests__/daily-pipeline.test.ts
 * @description Unit tests for daily-pipeline Inngest functions
 */

type AnyFunction = (...args: any[]) => any;

jest.mock('@/lib/logger', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return {
    createLogger: jest.fn(() => logger),
    __mockLogger: logger,
  };
});

// Mock Firebase
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'mock-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

// Mock inngest client. Handler registry stored inside the mock closure.
jest.mock('@/lib/inngest/client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: registry,
  };
});

// Admin-SDK mock — preserve Firestore's status filtering instead of returning
// every fixture row regardless of the query. The previous mock made impossible
// per-status skip telemetry look reachable in production.
const mockGetSignalsByStatus = jest.fn();
const mockUpdateSignal = jest.fn();
const mockSignalWhere = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: jest.fn((_collectionName: string) => {
      // signals collection: .where('status','in',statuses).get()
      return {
        where: mockSignalWhere.mockImplementation((field: string, op: string, value: unknown) => ({
          get: async () => {
            if (field !== 'status') return { docs: [] };
            const rows = (await mockGetSignalsByStatus()) ?? [];
            const statuses = op === 'in' && Array.isArray(value) ? value : [value];
            const signals = (rows as Array<{ status?: unknown }>).filter((signal) =>
              statuses.includes(signal.status)
            );
            return {
              docs: (signals as unknown[]).map((s) => ({ data: () => s })),
            };
          },
        })),
      };
    }),
  },
}));

// signals module still mocked for updateSignal (used elsewhere in the
// pipeline). getSignalsByStatus is now read through the admin-SDK mock
// above.
jest.mock('@/lib/signals', () => ({
  __esModule: true,
  updateSignal: (...args: unknown[]) => mockUpdateSignal(...args),
}));

// Mock trends-admin (the pipeline dynamic-imports the admin-SDK twin inside
// step.run — @/lib/trends is client-SDK and no longer reachable from here).
const mockComputeTrends = jest.fn();
jest.mock('@/lib/trends-admin', () => ({
  __esModule: true,
  adminComputeTrends: (...args: unknown[]) => mockComputeTrends(...args),
}));

// Mock graph service factory
const mockGetGraphService = jest.fn();
jest.mock('@/lib/graph/service-factory', () => ({
  __esModule: true,
  getGraphService: (...args: unknown[]) => mockGetGraphService(...args),
}));

const mockCountAssertionStructuralDrift = jest.fn();
jest.mock('@/lib/graph/assertion-integrity', () => ({
  __esModule: true,
  countAssertionStructuralDrift: (...args: unknown[]) => mockCountAssertionStructuralDrift(...args),
}));

// Mock proposed-relations (admin twins — the pipeline now calls the
// admin-SDK helpers from @/lib/proposed-relations-admin).
const mockCleanupOldRejectedProposals = jest.fn();
const mockCleanupOrphanedProposals = jest.fn();
jest.mock('@/lib/proposed-relations-admin', () => ({
  __esModule: true,
  cleanupOldRejectedProposals: (...args: unknown[]) => mockCleanupOldRejectedProposals(...args),
  cleanupOrphanedProposals: (...args: unknown[]) => mockCleanupOrphanedProposals(...args),
}));

// Mock relations (for consistency cleanup) — the pipeline now calls the
// admin-SDK twin adminCleanupOrphanedRelations from @/lib/relations-admin.
const mockCleanupOrphanedRelations = jest.fn();
jest.mock('@/lib/relations-admin', () => ({
  __esModule: true,
  adminCleanupOrphanedRelations: (...args: unknown[]) => mockCleanupOrphanedRelations(...args),
}));

// Mock the real graph-refresh pipeline module (the refresh-graph step
// dynamic-imports it — the decorative in-file stub was replaced).
const mockPipelineGraphRefresh = jest.fn();
jest.mock('@/lib/pipeline/graph-refresh', () => ({
  __esModule: true,
  refreshGraphProjection: (...args: unknown[]) => mockPipelineGraphRefresh(...args),
}));

// DISC-017: the recalculate-alignment step dynamic-imports the REAL calculator
// (it used to be a local no-op returning a hardcoded `updated: 0`). Without
// this mock the import resolves the real admin-SDK chain, the step's catch
// swallows the failure, and an "expect 0 updated" assertion passes for the
// wrong reason — a false green of exactly the kind this item exists to remove.
const mockRecalculateAlignmentScores = jest.fn();
jest.mock('@/lib/pipeline/alignment-calculation', () => ({
  __esModule: true,
  recalculateAlignmentScores: (...args: unknown[]) => mockRecalculateAlignmentScores(...args),
}));

function buildAlignmentResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    totalSignals: 0,
    processedSignals: 0,
    updatedSignals: 0,
    skippedSignals: 0,
    errors: [],
    scoreChanges: [],
    processingTimeMs: 1,
    averageOldScore: 0,
    averageNewScore: 0,
    ...overrides,
  };
}

function buildGraphRefreshResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    nodesRefreshed: 0,
    nodesSynced: 0,
    nodesSkipped: 0,
    relationsRefreshed: 0,
    cacheCleared: true,
    schemaUpdated: false,
    errors: [],
    processingTimeMs: 5,
    healthStatus: { healthy: true, backend: 'neo4j', latencyMs: 3 },
    ...overrides,
  };
}

// Import AFTER all mocks
import '../functions/daily-pipeline';

const mockLogger = (
  require('@/lib/logger') as {
    __mockLogger: { info: jest.Mock; error: jest.Mock };
  }
).__mockLogger;

// ============================================================================
// Helpers
// ============================================================================

function getRegistry() {
  const clientMock = require('@/lib/inngest/client');
  return clientMock._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function buildMockStep() {
  return {
    run: jest.fn((name: string, fn: AnyFunction) => fn()),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildMockSignal(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'signal-1',
    title: 'Test Signal',
    description: 'A test signal',
    type: 'news',
    status: 'Validated',
    detectedAt: now - 1000, // 1 second ago, within 24hr window
    alignmentScore: 75,
    linkedEntities: {
      technologies: ['tech-1', 'tech-2'],
      companies: ['company-1'],
    },
    expandedContent: {
      relatedItems: {
        technologies: [{ name: 'React', id: 'react' }],
        companies: [{ name: 'Meta', id: 'meta' }],
      },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests: dailyPipeline
// ============================================================================

describe('dailyPipeline', () => {
  const HANDLER_ID = 'daily-pipeline';

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    mockGetSignalsByStatus.mockResolvedValue([buildMockSignal()]);
    mockRecalculateAlignmentScores.mockResolvedValue(buildAlignmentResult());
    mockComputeTrends.mockResolvedValue({ created: 3, updated: 2, deleted: 0 });
    mockGetGraphService.mockResolvedValue({
      getHealthDetails: jest.fn().mockResolvedValue({ healthy: true }),
      query: jest.fn().mockResolvedValue({ records: [] }),
    });
    mockCleanupOldRejectedProposals.mockResolvedValue(5);
    mockCleanupOrphanedProposals.mockResolvedValue({ deleted: 3 });
    mockPipelineGraphRefresh.mockResolvedValue(buildGraphRefreshResult());
  });

  it('should have correct function id', () => {
    const { configs } = getRegistry();
    expect(configs[HANDLER_ID].id).toBe('daily-pipeline');
  });

  it('should have correct triggers (event + cron)', () => {
    const { triggers } = getRegistry();
    expect(triggers[HANDLER_ID]).toEqual([{ event: 'app/pipeline.trigger' }, { cron: '0 8 * * *' }]);
  });

  it('should complete successfully with signals', async () => {
    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.signalsProcessed).toBe(1);
    expect(result.summary.trendsComputed).toBe(5); // 3 created + 2 updated
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Pipeline complete',
      expect.objectContaining({ durationMs: expect.any(Number), summary: result.summary })
    );
  });

  it('should filter signals to only recent ones (last 24h)', async () => {
    const oldSignal = buildMockSignal({
      id: 'old-signal',
      detectedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    });
    const recentSignal = buildMockSignal({
      id: 'recent-signal',
      detectedAt: Date.now() - 1000,
    });
    mockGetSignalsByStatus.mockResolvedValue([oldSignal, recentSignal]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    // Only the recent signal is processed
    expect(result.summary.signalsProcessed).toBe(1);
  });

  it('should extract entities from signal linkedEntities', async () => {
    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    // The signal has 2 technologies + 1 company + 1 expanded tech + 1 expanded company = 5 entities
    expect(result.summary.entitiesExtracted).toBe(5);
  });

  it('should handle signals with no linked entities', async () => {
    mockGetSignalsByStatus.mockResolvedValue([
      buildMockSignal({
        linkedEntities: {},
        expandedContent: undefined,
      }),
    ]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.summary.entitiesExtracted).toBe(0);
  });

  it('should deduplicate entities with same normalized name', async () => {
    // Signal with two entity names that normalize to the same value
    mockGetSignalsByStatus.mockResolvedValue([
      buildMockSignal({
        id: 'sig-1',
        linkedEntities: { technologies: ['React.js', 'react-js'], companies: [] },
        expandedContent: null,
        detectedAt: Date.now() - 1000,
      }),
    ]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    // "React.js" and "react-js" both normalize to "reactjs" → 1 merged
    expect(result.summary.duplicatesResolved).toBe(1);
  });

  it('should propose relations from co-occurring entities', async () => {
    // Signal with multiple entities generates relations
    mockGetSignalsByStatus.mockResolvedValue([buildMockSignal()]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.summary.relationsProposed).toBeGreaterThan(0);
  });

  it('should compute trends and include them in summary', async () => {
    mockComputeTrends.mockResolvedValue({ created: 5, updated: 3, deleted: 1 });

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.summary.trendsComputed).toBe(8); // 5 + 3
  });

  it('delegates refresh-graph to the real pipeline module and reports its counts (stub replaced)', async () => {
    mockPipelineGraphRefresh.mockResolvedValue(buildGraphRefreshResult({ nodesRefreshed: 7, nodesSynced: 7 }));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(mockPipelineGraphRefresh).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.summary.graphNodesRefreshed).toBe(7);
  });

  it('should report a degraded run when graph refresh skips an unhealthy backend', async () => {
    const { inngest } = require('@/lib/inngest/client');
    mockPipelineGraphRefresh.mockResolvedValue(
      buildGraphRefreshResult({
        success: false,
        healthStatus: { healthy: false, backend: 'unknown', latencyMs: 0 },
      })
    );

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(false);
    expect(result.summary.graphNodesRefreshed).toBe(0);
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/pipeline.completed',
        data: expect.objectContaining({ success: false, failedSteps: ['refresh-graph'] }),
      })
    );
  });

  it('should continue accounting while reporting graph refresh errors as degraded', async () => {
    mockPipelineGraphRefresh.mockRejectedValue(new Error('Neo4j connection failed'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(false);
    expect(result.summary.graphNodesRefreshed).toBe(0);
  });

  it('should send completion event', async () => {
    const { inngest } = require('@/lib/inngest/client');

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/pipeline.completed',
        data: expect.objectContaining({ success: true, failedSteps: [] }),
      })
    );
  });

  it('should fail the job and rethrow if a step throws', async () => {
    mockGetSignalsByStatus.mockRejectedValue(new Error('Signals unavailable'));

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: { name: 'app/pipeline.trigger', data: {} },
        step: buildMockStep(),
      })
    ).rejects.toThrow('Signals unavailable');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Pipeline failed',
      expect.objectContaining({ message: 'Signals unavailable' }),
      expect.objectContaining({ triggeredBy: 'app/pipeline.trigger', completedSteps: [] })
    );
  });

  it('should send failure event when pipeline throws', async () => {
    const { inngest } = require('@/lib/inngest/client');
    mockGetSignalsByStatus.mockRejectedValue(new Error('Something broke'));

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: { name: 'app/pipeline.trigger', data: {} },
        step: buildMockStep(),
      })
    ).rejects.toThrow();

    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/pipeline.failed' }));
  });

  // ==========================================================================
  // DISC-017 — one approved-signal lifecycle through the pipeline
  // ==========================================================================

  describe('DISC-017 status policy, honest counts and replay safety', () => {
    async function runPipeline(step: unknown = buildMockStep()) {
      const { handlers } = getRegistry();
      return handlers[HANDLER_ID]({ event: { name: 'app/pipeline.trigger', data: {} }, step });
    }

    it('selects Validated AND Approved in one query instead of Validated only', async () => {
      await runPipeline();
      expect(mockSignalWhere).toHaveBeenCalledWith('status', 'in', ['Validated', 'Approved']);
    });

    // The reported regression: a human approves a signal, the pipeline
    // processes zero.
    it('processes an Approved signal', async () => {
      mockGetSignalsByStatus.mockResolvedValue([buildMockSignal({ id: 'approved-1', status: 'Approved' })]);

      const result = await runPipeline();

      expect(result.selection.selected).toBe(1);
      expect(result.selection.selectedSignalIdsSample).toEqual(['approved-1']);
      expect(result.selection.selectedSignalIdsOmitted).toBe(0);
      expect(result.summary.signalsProcessed).toBe(1);
    });

    it('bounds the durable selected-signal receipt without hiding omissions', async () => {
      mockGetSignalsByStatus.mockResolvedValue(
        Array.from({ length: 30 }, (_, index) =>
          buildMockSignal({ id: `approved-${index}`, status: 'Approved', detectedAt: Date.now() - index })
        )
      );

      const result = await runPipeline();

      expect(result.selection.selected).toBe(30);
      expect(result.selection.selectedSignalIdsSample).toHaveLength(25);
      expect(result.selection.selectedSignalIdsSample).toContain('approved-0');
      expect(result.selection.selectedSignalIdsOmitted).toBe(5);
    });

    // The SECOND, independent cause: a detectedAt-only window discards a
    // signal detected days ago but approved minutes ago.
    it('selects a stale-detected signal that was approved inside the window', async () => {
      const now = Date.now();
      mockGetSignalsByStatus.mockResolvedValue([
        buildMockSignal({
          id: 'late-approval',
          status: 'Approved',
          detectedAt: now - 5 * 24 * 60 * 60 * 1000,
          reviewedAt: now - 60_000,
        }),
      ]);

      const result = await runPipeline();

      expect(result.selection.selected).toBe(1);
      expect(result.selection.skippedByRecency).toBe(0);
    });

    it('reports the exact Firestore status cohort instead of impossible status skips', async () => {
      mockGetSignalsByStatus.mockResolvedValue([
        buildMockSignal({ id: 'a', status: 'Approved' }),
        buildMockSignal({ id: 'b', status: 'Rejected' }),
        buildMockSignal({ id: 'c', status: 'Rejected' }),
        buildMockSignal({ id: 'd', status: 'Archived' }),
      ]);

      const result = await runPipeline();

      expect(result.selection).toMatchObject({
        queriedStatuses: ['Validated', 'Approved'],
        scanned: 1,
        selected: 1,
        skippedByRecency: 0,
      });
      expect(result.selection).not.toHaveProperty('skippedByStatus');
      expect(result.selection).not.toHaveProperty('skippedStatusCounts');
      expect(mockSignalWhere).toHaveBeenCalledWith('status', 'in', ['Validated', 'Approved']);
    });

    it('accounts for every row returned by the status query', async () => {
      const now = Date.now();
      mockGetSignalsByStatus.mockResolvedValue([
        buildMockSignal({ id: 'fresh', status: 'Validated' }),
        buildMockSignal({ id: 'stale', status: 'Validated', detectedAt: now - 10 * 24 * 60 * 60 * 1000 }),
        buildMockSignal({ id: 'wrong-status', status: 'Detected' }),
      ]);

      const { selection } = await runPipeline();

      expect(selection.selected + selection.skippedByRecency).toBe(selection.scanned);
      expect(selection.scanned).toBe(2);
    });

    it('delegates alignment to the real calculator with the declared statuses', async () => {
      mockRecalculateAlignmentScores.mockResolvedValue(
        buildAlignmentResult({ processedSignals: 9, updatedSignals: 4, skippedSignals: 5 })
      );

      const result = await runPipeline();

      expect(mockRecalculateAlignmentScores).toHaveBeenCalledWith({ signalStatuses: ['Validated', 'Approved'] });
      expect(result.alignment).toEqual({ processed: 9, updated: 4, skipped: 5, failed: 0 });
      // The legacy summary field must now carry real writes, not a hardcoded 0.
      expect(result.summary.alignmentScoresUpdated).toBe(4);
    });

    it('reports calculator errors as failures rather than a clean zero', async () => {
      const { inngest } = require('@/lib/inngest/client');
      mockRecalculateAlignmentScores.mockRejectedValue(new Error('strategies unavailable'));

      const result = await runPipeline();

      expect(result.alignment).toEqual({ processed: 0, updated: 0, skipped: 0, failed: 1 });
      expect(result.success).toBe(false);
      expect(result.steps.find((step: { step: string }) => step.step === 'recalculate-alignment')).toMatchObject({
        success: false,
        persisted: true,
        errors: ['1 alignment recalculation failure'],
      });
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/pipeline.completed',
          data: expect.objectContaining({ success: false, failedSteps: ['recalculate-alignment'] }),
        })
      );
    });

    it('surfaces per-signal calculator errors in the failed count', async () => {
      mockRecalculateAlignmentScores.mockResolvedValue(
        buildAlignmentResult({ processedSignals: 2, updatedSignals: 1, errors: [{ signalId: 'x', error: 'boom' }] })
      );

      const result = await runPipeline();

      expect(result.alignment.failed).toBe(1);
      expect(result.success).toBe(false);
      expect(result.steps.find((step: { step: string }) => step.step === 'recalculate-alignment')).toMatchObject({
        success: false,
        persisted: true,
        errors: ['1 alignment recalculation failure'],
      });
    });

    it('persists an unhealthy graph refresh as a degraded stage and run', async () => {
      mockPipelineGraphRefresh.mockResolvedValue(
        buildGraphRefreshResult({
          success: false,
          healthStatus: { healthy: false, backend: 'unknown', latencyMs: 0 },
        })
      );

      const result = await runPipeline();

      expect(result.success).toBe(false);
      expect(result.summary.graphNodesRefreshed).toBe(0);
      expect(result.steps.find((step: { step: string }) => step.step === 'refresh-graph')).toMatchObject({
        success: false,
        persisted: true,
        errors: ['Graph service was unhealthy'],
        details: expect.objectContaining({ failed: 0, failureReason: 'unhealthy' }),
      });
    });

    it('persists a thrown graph refresh as a degraded stage and run without aborting later accounting', async () => {
      mockPipelineGraphRefresh.mockRejectedValue(new Error('Neo4j connection failed'));

      const result = await runPipeline();

      expect(result.success).toBe(false);
      expect(result.steps.find((step: { step: string }) => step.step === 'refresh-graph')).toMatchObject({
        success: false,
        persisted: true,
        errors: ['Graph refresh failed'],
        details: expect.objectContaining({ failed: 1, failureReason: 'exception' }),
      });
    });

    it('marks analysis-only steps as not persisted', async () => {
      const { steps } = await runPipeline();
      const persistedBy = Object.fromEntries(
        (steps as Array<{ step: string; persisted: boolean }>).map((s) => [s.step, s.persisted])
      );

      expect(persistedBy).toMatchObject({
        'get-signals': false,
        'extract-entities': false,
        'deduplicate-entities': false,
        'propose-relations': false,
        'compute-trends': true,
        'recalculate-alignment': true,
        'refresh-graph': true,
      });
    });

    it('reports enrichment coverage without dispatching enrichment', async () => {
      mockGetSignalsByStatus.mockResolvedValue([
        buildMockSignal({ id: 'enriched', status: 'Approved' }),
        buildMockSignal({ id: 'bare', status: 'Approved', expandedContent: undefined }),
      ]);

      const result = await runPipeline();

      expect(result.enrichment).toEqual({
        candidates: 2,
        alreadyEnriched: 1,
        awaitingOwner: 1,
        owner: 'enrich-liked-signals',
      });
      // Exactly-once holds by single ownership: this pipeline must never queue
      // an expansion itself, or it would double-spend with enrich-liked-signals.
      const { inngest } = require('@/lib/inngest/client') as { inngest: { send: jest.Mock } };
      const sentEventNames = inngest.send.mock.calls.map((call) => (call[0] as { name: string }).name);
      expect(sentEventNames).not.toContain('app/signal.expand.requested');
    });

    // The replay bug: every steps.push used to live INSIDE a step.run callback,
    // so a memoized replay returned an empty steps[] with a fully populated
    // summary — and the error path reported no completed steps at all.
    it('preserves step records and marks them replayed during an Inngest replay', async () => {
      const dateNow = jest.spyOn(Date, 'now').mockReturnValue(5_000);
      const cached: Record<string, unknown> = {
        'get-signals': {
          pipelineStartedAt: 1_000,
          signals: [],
          tally: {
            queriedStatuses: ['Validated', 'Approved'],
            scanned: 3,
            selected: 0,
            skippedByRecency: 3,
          },
          enrichment: { candidates: 0, alreadyEnriched: 0, awaitingOwner: 0, owner: 'enrich-liked-signals' },
          itemsProcessed: 0,
          durationMs: 5,
        },
        'extract-entities': { results: [], itemsProcessed: 0, durationMs: 1 },
        'deduplicate-entities': { result: { merged: 0, duplicates: [] }, itemsProcessed: 0, durationMs: 1 },
        'propose-relations': { relations: [], itemsProcessed: 0, durationMs: 1 },
        'compute-trends': { result: { created: 1, updated: 1, deleted: 0 }, itemsProcessed: 2, durationMs: 1 },
        'recalculate-alignment': {
          result: { processed: 2, updated: 1, skipped: 1, failed: 0 },
          itemsProcessed: 1,
          durationMs: 1,
        },
        'refresh-graph': {
          result: { nodesRefreshed: 4, relationsRefreshed: 0 },
          itemsProcessed: 4,
          durationMs: 1,
        },
        'send-completion': undefined,
      };
      const replayStep = { run: jest.fn((name: string) => Promise.resolve(cached[name])) };

      const result = await runPipeline(replayStep);
      dateNow.mockRestore();

      expect(result.steps).toHaveLength(7);
      expect(result.steps.every((s: { replayed: boolean }) => s.replayed)).toBe(true);
      expect(result.stepsReplayed).toBe(7);
      // Memoized values must still populate the summary faithfully…
      expect(result.summary.alignmentScoresUpdated).toBe(1);
      expect(result.selection.scanned).toBe(3);
      expect(result.selection.selectedSignalIdsSample).toEqual([]);
      expect(result.selection.selectedSignalIdsOmitted).toBe(0);
      expect(result).toMatchObject({ startedAt: 1_000, completedAt: 5_000, duration: 4_000 });
      // …and no step body may re-execute, or the replay would double-write.
      expect(mockGetSignalsByStatus).not.toHaveBeenCalled();
      expect(mockRecalculateAlignmentScores).not.toHaveBeenCalled();
      expect(mockComputeTrends).not.toHaveBeenCalled();
      expect(mockPipelineGraphRefresh).not.toHaveBeenCalled();
    });

    it('marks steps as executed (not replayed) on a normal run', async () => {
      const result = await runPipeline();
      expect(result.stepsReplayed).toBe(0);
      expect(result.steps.every((s: { replayed: boolean }) => s.replayed === false)).toBe(true);
    });
  });

  it('should handle empty signals list', async () => {
    mockGetSignalsByStatus.mockResolvedValue([]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.summary.signalsProcessed).toBe(0);
    expect(result.summary.entitiesExtracted).toBe(0);
    expect(result.summary.relationsProposed).toBe(0);
  });

  it('should handle signal with only expanded content entities', async () => {
    mockGetSignalsByStatus.mockResolvedValue([
      buildMockSignal({
        linkedEntities: null,
        expandedContent: {
          relatedItems: {
            technologies: [{ name: 'TypeScript', id: 'ts' }],
            companies: [{ name: 'Microsoft', id: 'ms' }],
          },
        },
        detectedAt: Date.now() - 1000,
      }),
    ]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: { name: 'app/pipeline.trigger', data: {} },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.summary.entitiesExtracted).toBe(2);
  });
});

// ============================================================================
// Tests: cleanupOrphans (weekly cleanup)
// ============================================================================

describe('cleanupOrphans', () => {
  const HANDLER_ID = 'cleanup-orphans';

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetSignalsByStatus.mockResolvedValue([
      buildMockSignal({ detectedAt: Date.now() - 91 * 24 * 60 * 60 * 1000 }), // 91 days old
    ]);
    mockCleanupOldRejectedProposals.mockResolvedValue(5);
    mockCleanupOrphanedProposals.mockResolvedValue({ deleted: 3 });
    mockCountAssertionStructuralDrift.mockResolvedValue(2);
  });

  it('should have correct function id and cron trigger', () => {
    const { configs, triggers } = getRegistry();
    expect(configs[HANDLER_ID].id).toBe('cleanup-orphans');
    expect(triggers[HANDLER_ID]).toEqual({ cron: '0 3 * * 0' });
  });

  it('should cleanup orphaned claims, old signals, rejected proposals, and orphaned proposals', async () => {
    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.orphanedClaims).toBeDefined();
    expect(result.orphanedClaims).toBe(0);
    expect(result.assertionStructuralDrift).toBe(2);
    expect(result.oldSignals).toBeDefined();
    expect(result.oldRejectedProposals).toBe(5);
    expect(result.orphanedProposals).toBe(3);
    expect(mockCountAssertionStructuralDrift).toHaveBeenCalledTimes(1);
    expect(mockGetGraphService).not.toHaveBeenCalled();
  });

  it('reports graph diagnostic errors without claiming a clean graph', async () => {
    mockCountAssertionStructuralDrift.mockRejectedValue(new Error('Graph service down'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.orphanedClaims).toBe(0);
    expect(result.assertionStructuralDrift).toBeNull();
    expect(mockGetGraphService).not.toHaveBeenCalled();
  });

  it('preserves every memoized step result during an Inngest replay', async () => {
    const cachedResults: Record<string, unknown> = {
      'cleanup-orphaned-claims': { structuralDrift: 4, deleted: 0 },
      'archive-old-signals': 7,
      'cleanup-rejected-proposals': 5,
      'cleanup-orphaned-proposals': 3,
    };
    const replayStep = {
      run: jest.fn((name: string) => Promise.resolve(cachedResults[name])),
    };

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: replayStep });

    expect(result).toEqual({
      assertionStructuralDrift: 4,
      orphanedClaims: 0,
      oldSignals: 7,
      oldRejectedProposals: 5,
      orphanedProposals: 3,
    });
    expect(mockCountAssertionStructuralDrift).not.toHaveBeenCalled();
    expect(mockGetSignalsByStatus).not.toHaveBeenCalled();
    expect(mockCleanupOldRejectedProposals).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedProposals).not.toHaveBeenCalled();
  });

  it('normalizes the historical void claim-cleanup result during replay', async () => {
    const cachedResults: Record<string, unknown> = {
      'cleanup-orphaned-claims': undefined,
      'archive-old-signals': 7,
      'cleanup-rejected-proposals': 5,
      'cleanup-orphaned-proposals': 3,
    };
    const replayStep = {
      run: jest.fn((name: string) => Promise.resolve(cachedResults[name])),
    };

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: replayStep });

    expect(result).toEqual({
      assertionStructuralDrift: null,
      orphanedClaims: 0,
      oldSignals: 7,
      oldRejectedProposals: 5,
      orphanedProposals: 3,
    });
    expect(mockCountAssertionStructuralDrift).not.toHaveBeenCalled();
  });

  it('should handle rejected proposals cleanup error gracefully', async () => {
    mockCleanupOldRejectedProposals.mockRejectedValue(new Error('Cleanup failed'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.oldRejectedProposals).toBe(0);
  });

  it('should handle orphaned proposals cleanup error gracefully', async () => {
    mockCleanupOrphanedProposals.mockRejectedValue(new Error('Orphan cleanup failed'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.orphanedProposals).toBe(0);
  });

  it('should count signals older than 90 days', async () => {
    const recentSignal = buildMockSignal({ status: 'Archived', detectedAt: Date.now() - 1000 });
    const oldSignal1 = buildMockSignal({
      id: 'old-1',
      status: 'Archived',
      detectedAt: Date.now() - 91 * 24 * 60 * 60 * 1000,
    });
    const oldSignal2 = buildMockSignal({
      id: 'old-2',
      status: 'Archived',
      detectedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
    });
    mockGetSignalsByStatus.mockResolvedValue([recentSignal, oldSignal1, oldSignal2]);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.oldSignals).toBe(2);
  });
});

// ============================================================================
// Tests: consistencyCleanup (daily consistency cleanup)
// ============================================================================

describe('consistencyCleanup', () => {
  const HANDLER_ID = 'consistency-cleanup';

  beforeEach(() => {
    jest.clearAllMocks();

    mockCleanupOrphanedRelations.mockResolvedValue({ checked: 100, orphaned: 5, deleted: 5 });
    mockCleanupOrphanedProposals.mockResolvedValue({ deleted: 3 });
    mockCountAssertionStructuralDrift.mockResolvedValue(0);
  });

  it('should have correct function id and cron trigger', () => {
    const { configs, triggers } = getRegistry();
    expect(configs[HANDLER_ID].id).toBe('consistency-cleanup');
    expect(triggers[HANDLER_ID]).toEqual({ cron: '0 4 * * *' });
  });

  it('should have retries set to 2', () => {
    const { configs } = getRegistry();
    expect(configs[HANDLER_ID].retries).toBe(2);
  });

  it('runs the graph boundary as a read-only diagnostic', async () => {
    const { handlers } = getRegistry();
    const mockStep = buildMockStep();
    const result = await handlers[HANDLER_ID]({ step: mockStep });

    expect(mockStep.run).toHaveBeenCalledTimes(3);
    expect(mockStep.run).toHaveBeenCalledWith('cleanup-orphaned-firestore-relations', expect.any(Function));
    expect(mockStep.run).toHaveBeenCalledWith('cleanup-orphaned-neo4j-relationships', expect.any(Function));
    expect(mockStep.run).toHaveBeenCalledWith('cleanup-orphaned-proposals-daily', expect.any(Function));

    expect(result.firestoreRelations).toEqual({ checked: 100, orphaned: 5, deleted: 5 });
    expect(result.neo4jAssertions).toEqual({ structuralDrift: 0, deleted: 0 });
    expect(result.orphanedProposals).toBeDefined();
    expect(mockCountAssertionStructuralDrift).toHaveBeenCalledTimes(1);
    expect(mockGetGraphService).not.toHaveBeenCalled();
  });

  it('reports structural drift without attempting repair', async () => {
    mockCountAssertionStructuralDrift.mockResolvedValue(73);

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.neo4jAssertions).toEqual({ structuralDrift: 73, deleted: 0 });
    expect(mockGetGraphService).not.toHaveBeenCalled();
  });

  it('preserves memoized step results during an Inngest replay', async () => {
    const cachedResults: Record<string, unknown> = {
      'cleanup-orphaned-firestore-relations': { checked: 100, orphaned: 5, deleted: 5 },
      'cleanup-orphaned-neo4j-relationships': { structuralDrift: 73, deleted: 0 },
      'cleanup-orphaned-proposals-daily': { deleted: 3 },
    };
    const replayStep = {
      run: jest.fn((name: string) => Promise.resolve(cachedResults[name])),
    };

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: replayStep });

    expect(result).toEqual({
      firestoreRelations: { checked: 100, orphaned: 5, deleted: 5 },
      neo4jAssertions: { structuralDrift: 73, deleted: 0 },
      orphanedProposals: { deleted: 3 },
    });
    expect(mockCleanupOrphanedRelations).not.toHaveBeenCalled();
    expect(mockCountAssertionStructuralDrift).not.toHaveBeenCalled();
    expect(mockCleanupOrphanedProposals).not.toHaveBeenCalled();
  });

  it('normalizes the historical void Neo4j-cleanup result during replay', async () => {
    const cachedResults: Record<string, unknown> = {
      'cleanup-orphaned-firestore-relations': { checked: 100, orphaned: 5, deleted: 5 },
      'cleanup-orphaned-neo4j-relationships': undefined,
      'cleanup-orphaned-proposals-daily': { deleted: 3 },
    };
    const replayStep = {
      run: jest.fn((name: string) => Promise.resolve(cachedResults[name])),
    };

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: replayStep });

    expect(result).toEqual({
      firestoreRelations: { checked: 100, orphaned: 5, deleted: 5 },
      neo4jAssertions: { structuralDrift: null, deleted: 0 },
      orphanedProposals: { deleted: 3 },
    });
    expect(mockCountAssertionStructuralDrift).not.toHaveBeenCalled();
  });

  it('should handle Firestore relation cleanup errors gracefully', async () => {
    mockCleanupOrphanedRelations.mockRejectedValue(new Error('Cleanup failed'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    // Should not throw, should record error
    expect(result.firestoreRelations).toMatchObject({ checked: 0, orphaned: 0, deleted: 0 });
  });

  it('reports Neo4j diagnostic errors without claiming a clean graph', async () => {
    mockCountAssertionStructuralDrift.mockRejectedValue(new Error('Neo4j down'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.neo4jAssertions).toMatchObject({ structuralDrift: null, deleted: 0 });
  });

  it('should handle orphaned proposals cleanup errors gracefully', async () => {
    mockCleanupOrphanedProposals.mockRejectedValue(new Error('Proposals cleanup failed'));

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({ step: buildMockStep() });

    expect(result.orphanedProposals).toMatchObject({ deleted: 0 });
  });
});

// ============================================================================
// OBS-003 — the accepted request identity survives the whole pipeline
// ============================================================================

describe('dailyPipeline correlation (OBS-003)', () => {
  const HANDLER_ID = 'daily-pipeline';
  const ACCEPTED = 'corr_3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSignalsByStatus.mockResolvedValue([buildMockSignal()]);
    mockRecalculateAlignmentScores.mockResolvedValue(buildAlignmentResult());
    mockComputeTrends.mockResolvedValue({ created: 1, updated: 0, deleted: 0 });
    mockPipelineGraphRefresh.mockResolvedValue(buildGraphRefreshResult());
  });

  async function runPipeline(data: Record<string, unknown>, step: unknown = buildMockStep()) {
    const { handlers } = getRegistry();
    return handlers[HANDLER_ID]({ event: { name: 'app/pipeline.trigger', data }, step });
  }

  /** The event payload for the first send matching `name`. */
  function sentEventData(name: string): Record<string, unknown> | undefined {
    const { inngest } = require('@/lib/inngest/client') as { inngest: { send: jest.Mock } };
    const call = inngest.send.mock.calls.find(([event]) => event?.name === name);
    return call?.[0]?.data;
  }

  it('reports the accepted identity on its own run receipt', async () => {
    // The receipt is what the middleware persists as the JobRun `output`, so
    // this is where an operator reading the run sees which request caused it.
    const result = await runPipeline({ correlationId: ACCEPTED });

    expect(result.correlationId).toBe(ACCEPTED);
  });

  it('carries the identity into the completion fan-out', async () => {
    await runPipeline({ correlationId: ACCEPTED });

    expect(sentEventData('app/pipeline.completed')?.correlationId).toBe(ACCEPTED);
  });

  it('carries the identity into the failure fan-out', async () => {
    mockGetSignalsByStatus.mockRejectedValue(new Error('Firestore unavailable'));

    await expect(runPipeline({ correlationId: ACCEPTED })).rejects.toThrow('Firestore unavailable');

    expect(sentEventData('app/pipeline.failed')?.correlationId).toBe(ACCEPTED);
  });

  it('hands the identity to the graph refresh so graph writes carry evidence', async () => {
    await runPipeline({ correlationId: ACCEPTED });

    expect(mockPipelineGraphRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: ACCEPTED })
    );
  });

  it('never invents an identity for a scheduled run', async () => {
    // A cron run has no accepted request. Minting a token here would be a
    // fabricated provenance claim, so every surface must simply omit it.
    const result = await runPipeline({});

    expect(result.correlationId).toBeUndefined();
    expect(sentEventData('app/pipeline.completed')).not.toHaveProperty('correlationId');
    expect(mockPipelineGraphRefresh.mock.calls[0][0]).not.toHaveProperty('correlationId');
  });

  it('discards a malformed identity rather than persisting caller text', async () => {
    const result = await runPipeline({ correlationId: '../../etc/passwd' });

    expect(result.correlationId).toBeUndefined();
    expect(sentEventData('app/pipeline.completed')).not.toHaveProperty('correlationId');
  });
});
