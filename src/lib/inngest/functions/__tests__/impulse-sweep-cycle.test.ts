/**
 * @jest-environment node
 */

/**
 * @file Tests for impulse-sweep-cycle Inngest function
 *
 * Tests verify:
 * - Function is registered with correct config (id, cron, retries, concurrency)
 * - SENSE phase: calls executeFindDataGaps and returns early when no gaps
 * - DECIDE phase: routes orphan gaps to linker, stale/missing to scout
 * - ACT phase: creates missions and sends Inngest events
 * - REFLECT phase: atomically records and links one observation per gap
 * - Limits to 3 missions per sweep cycle
 * - Handles errors gracefully in each phase
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock inngest client with registry pattern
jest.mock('../../client', () => {
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

// Mock firebase-admin (sweep config is read live from system-config/global
// via the admin SDK inside the load-sweep-config step)
const mockConfigGet = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: (...args: unknown[]) => mockConfigGet(...args) })),
    })),
  },
}));

// Mock analytics tools
const mockExecuteFindDataGaps = jest.fn();
jest.mock('@/lib/ai/tools/analytics-tools', () => ({
  __esModule: true,
  executeFindDataGaps: (...args: unknown[]) => mockExecuteFindDataGaps(...args),
}));

// Mock missions service (listMissions is still used to check running mission count)
const mockListMissions = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  listMissions: (...args: unknown[]) => mockListMissions(...args),
}));

// Mock research gate — sweep always opts out with skipResearchGate: true
const mockDispatchMissionWithGate = jest.fn();
jest.mock('@/lib/mission-research-gate', () => ({
  __esModule: true,
  dispatchMissionWithGate: (...args: unknown[]) => mockDispatchMissionWithGate(...args),
}));

// Mock graph/episodes (Episode lifecycle for temporal tracking)
jest.mock('@/lib/graph/episodes', () => ({
  __esModule: true,
  createEpisode: jest.fn().mockResolvedValue({ id: 'episode-sweep-1' }),
  completeEpisode: jest.fn().mockResolvedValue(undefined),
  failEpisode: jest.fn().mockResolvedValue(undefined),
}));

// Mock agent-runs (AgentRun record for Activity page)
jest.mock('@/lib/agent-runs', () => ({
  __esModule: true,
  createAgentRun: jest.fn().mockResolvedValue({ id: 'run-sweep-1' }),
}));

// Mock session-memory (getActiveUserIds for REFLECT insight detection)
jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getActiveUserIds: jest.fn().mockResolvedValue([]),
}));

// Mock proactive insights
const mockRecordObservation = jest.fn().mockResolvedValue({
  id: 'obs-123',
  agentType: 'sweep-cycle',
  observationType: 'discovery',
  title: 'test',
  summary: 'test',
  confidence: 0.8,
  entityId: 'ent-1',
  entityName: 'Test',
  entityType: 'companies',
  timestamp: '2026-02-24T00:00:00.000Z',
});
jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  recordAgentObservation: (...args: unknown[]) => mockRecordObservation(...args),
  detectInsightsForUser: jest.fn().mockResolvedValue({ insightsCreated: 0 }),
  observeWatchedEntityUpdates: jest.fn().mockResolvedValue(0),
  generateNarrativeInsights: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/discovery/recommend-stale-reports', () => ({
  __esModule: true,
  recommendStaleReportUpdates: jest.fn().mockResolvedValue(undefined),
}));

const mockRecordSweepObservation = jest.fn().mockResolvedValue({
  status: 'recorded',
  observation: {
    id: 'obs-123',
    agentType: 'sweep-cycle',
    observationType: 'discovery',
    title: 'test',
    summary: 'test',
    confidence: 0.8,
    entityId: 'ent-1',
    entityName: 'Test',
    entityType: 'companies',
    timestamp: '2026-02-24T00:00:00.000Z',
  },
});
jest.mock('@/lib/graph/sweep-observations', () => ({
  __esModule: true,
  recordSweepObservation: (...args: unknown[]) => mockRecordSweepObservation(...args),
}));

// Mock dot-connector (cross-session dot-connecting after observation)
const mockConnectDots = jest.fn().mockResolvedValue({
  userId: 'test-user',
  observationId: 'obs-123',
  connections: [],
  insightsCreated: 0,
});
jest.mock('@/lib/graph/dot-connector', () => ({
  __esModule: true,
  connectDots: (...args: unknown[]) => mockConnectDots(...args),
}));

// Mock agent events (SSE event emission — must never break sweep flow)
jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

// Mock graph/curiosity-gaps — used by the 'reflect-persist-curiosity-gaps' step (for
// gaps classified 'unknown') AND unconditionally by the 'curiosity-gap-pipeline' step
// at the end of every full run. This module imports the REAL neo4j-client directly
// (runWriteTransaction/runReadTransaction), so leaving it unmocked reaches a real bolt
// connection attempt that retries for tens of seconds when Neo4j isn't running locally
// — well past Jest's 5s per-test timeout, hanging every full-cycle test in this file.
jest.mock('@/lib/graph/curiosity-gaps', () => ({
  __esModule: true,
  recordCuriosityGap: jest.fn().mockResolvedValue('gap-test-1'),
  getOpenGaps: jest.fn().mockResolvedValue([]),
  resolveCuriosityGap: jest.fn().mockResolvedValue(undefined),
}));

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// Import AFTER all mocks - triggers createFunction and populates registry
import { resolveSweepAgentRunStatus } from '../impulse-sweep-cycle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTION_ID = 'impulse-sweep-cycle';

function getRegistry() {
  const clientMock = require('../../client');
  return clientMock._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function getHandler(): AnyFunction {
  const handler = getRegistry().handlers[FUNCTION_ID];
  if (!handler) throw new Error(`Handler for '${FUNCTION_ID}' not found in registry`);
  return handler;
}

function getConfig(): Record<string, unknown> {
  const config = getRegistry().configs[FUNCTION_ID];
  if (!config) throw new Error(`Config for '${FUNCTION_ID}' not found in registry`);
  return config;
}

function getTrigger(): Record<string, unknown> {
  return getRegistry().triggers[FUNCTION_ID] as Record<string, unknown>;
}

function buildMockStep() {
  return {
    run: jest.fn((_name: string, fn: AnyFunction) => fn()),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildMemoizedStepWithLostAcknowledgement(failStep: (name: string) => boolean) {
  const cache = new Map<string, unknown>();
  let acknowledgementLost = false;
  return {
    run: jest.fn(async (name: string, fn: AnyFunction) => {
      if (cache.has(name)) return cache.get(name);
      const value = await fn();
      if (!acknowledgementLost && failStep(name)) {
        acknowledgementLost = true;
        throw new Error(`acknowledgement lost after ${name} committed`);
      }
      cache.set(name, value);
      return value;
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function getInngestSend() {
  const clientMock = require('../../client');
  return clientMock.inngest.send as jest.Mock;
}

/** Build a gap object matching the DataGap interface from analytics-tools */
function buildGap(
  overrides: Partial<{
    entityId: string;
    entityName: string;
    entityType: string;
    issues: string[];
  }> = {}
) {
  return {
    entityId: 'ent-1',
    entityName: 'Test Entity',
    entityType: 'companies',
    issues: ['No relations in knowledge graph'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('impulse-sweep-cycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const episodes = jest.requireMock('@/lib/graph/episodes');
    episodes.createEpisode.mockResolvedValue({ id: 'episode-sweep-1' });
    episodes.completeEpisode.mockResolvedValue(undefined);
    const agentRuns = jest.requireMock('@/lib/agent-runs');
    agentRuns.createAgentRun.mockResolvedValue({ id: 'run-sweep-1' });
    // Most behavior tests opt into background automation explicitly.
    mockConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 10 } }),
    });
    mockDispatchMissionWithGate.mockResolvedValue({
      dispatched: [
        {
          id: 'mission-sweep-1',
          userId: 'system-sweep',
          prompt: 'test',
          agent: 'scout',
          status: 'pending',
          progress: 0,
          entities: [],
          sources: [],
          createdAt: '2026-02-24T00:00:00.000Z',
        },
      ],
      gated: false,
    });
    mockRecordObservation.mockResolvedValue({
      id: 'obs-123',
      agentType: 'sweep-cycle',
      observationType: 'discovery',
      title: 'test',
      summary: 'test',
      confidence: 0.8,
      entityId: 'ent-1',
      entityName: 'Test',
      entityType: 'companies',
      timestamp: '2026-02-24T00:00:00.000Z',
    });
    mockRecordSweepObservation.mockResolvedValue({
      status: 'recorded',
      observation: {
        id: 'obs-123',
        agentType: 'sweep-cycle',
        observationType: 'discovery',
        title: 'test',
        summary: 'test',
        confidence: 0.8,
        entityId: 'ent-1',
        entityName: 'Test',
        entityType: 'companies',
        timestamp: '2026-02-24T00:00:00.000Z',
      },
    });
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    sessionMemory.getActiveUserIds.mockResolvedValue([]);
    mockConnectDots.mockResolvedValue({
      userId: 'test-user',
      observationId: 'obs-123',
      connections: [],
      insightsCreated: 0,
    });
  });

  // =========================================================================
  // Registration
  // =========================================================================

  describe('function registration', () => {
    it('should register with correct id', () => {
      expect(getConfig().id).toBe('impulse-sweep-cycle');
    });

    it('should register with correct name', () => {
      expect(getConfig().name).toBe('Impulse Sweep Cycle');
    });

    it('should set retries to 1', () => {
      expect(getConfig().retries).toBe(1);
    });

    it('should set concurrency limit to 1', () => {
      expect(getConfig().concurrency).toEqual({ limit: 1 });
    });

    it('should trigger on cron schedule (every 6h UTC) AND on manual event', () => {
      expect(getTrigger()).toEqual([{ cron: 'TZ=UTC 0 0,6,12,18 * * *' }, { event: 'app/sweep.manual.requested' }]);
    });
  });

  // =========================================================================
  // Sweep config gate (load-sweep-config step)
  // =========================================================================

  describe('sweep config gate', () => {
    it('should exit early without doing any work when sweep is disabled in system-config', async () => {
      mockConfigGet.mockResolvedValue({
        exists: true,
        data: () => ({ sweep: { enabled: false, maxActionsPerSweep: 10 } }),
      });

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result).toEqual({ phase: 'config', action: 'disabled', missionsSpawned: 0 });
      expect(mockExecuteFindDataGaps).not.toHaveBeenCalled();
      expect(mockDispatchMissionWithGate).not.toHaveBeenCalled();
      expect(mockRecordSweepObservation).not.toHaveBeenCalled();

      // Only the config-load step ran — no episode, no SENSE. `capture-sweep-start`
      // is bookkeeping, not work: OBS-004 needs the cycle's start instant to be a
      // MEMOIZED step (a handler-body `Date.now()` is re-initialised on every
      // per-step HTTP request), and it brackets the config load so a slow config
      // read lands inside the reported elapsed time instead of vanishing from it.
      const stepNames = step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepNames).toEqual(['capture-sweep-start', 'mint-sweep-id', 'load-sweep-config']);

      // ARUN-005: even the early exit opens AND closes its live row —
      // agent.started must never dangle without agent.completed.
      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      const types = emitAgentEvent.mock.calls.map((c: [{ type: string }]) => c[0].type);
      expect(types).toContain('agent.started');
      expect(types).toContain('agent.completed');
    });

    it('should cap planned actions at the configured maxActionsPerSweep when lower than the env cap', async () => {
      mockConfigGet.mockResolvedValue({
        exists: true,
        data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 1 } }),
      });
      const gaps = Array.from({ length: 3 }, (_, i) =>
        buildGap({
          entityId: `ent-${i}`,
          entityName: `Entity ${i}`,
          issues: ['No relations in knowledge graph'],
        })
      );
      mockExecuteFindDataGaps.mockResolvedValue({ gaps, totalGaps: 3 });

      const step = buildMockStep();
      await getHandler()({ step });

      // Env cap defaults to 2, configured cap is 1 — the lower value wins.
      expect(mockDispatchMissionWithGate).toHaveBeenCalledTimes(1);
    });

    it('should fail closed when the config read fails', async () => {
      mockConfigGet.mockRejectedValue(new Error('Firestore down'));

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result).toEqual({ phase: 'config', action: 'disabled', missionsSpawned: 0 });
      expect(mockExecuteFindDataGaps).not.toHaveBeenCalled();
    });

    it('should fail closed when the config doc predates the master switch', async () => {
      mockConfigGet.mockResolvedValue({ exists: true, data: () => ({}) });

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result).toEqual({ phase: 'config', action: 'disabled', missionsSpawned: 0 });
      expect(mockDispatchMissionWithGate).not.toHaveBeenCalled();
    });

    it('should fail closed when the config document is missing', async () => {
      mockConfigGet.mockResolvedValue({ exists: false });

      const result = await getHandler()({ step: buildMockStep() });

      expect(result).toEqual({ phase: 'config', action: 'disabled', missionsSpawned: 0 });
      expect(mockExecuteFindDataGaps).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SENSE phase
  // =========================================================================

  describe('SENSE phase', () => {
    it('retries instead of completing when Episode creation fails', async () => {
      const episodes = jest.requireMock('@/lib/graph/episodes');
      episodes.createEpisode.mockRejectedValueOnce(new Error('Neo4j unavailable'));

      await expect(getHandler()({ step: buildMockStep() })).rejects.toThrow('Neo4j unavailable');

      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      expect(emitAgentEvent.mock.calls.some((call: [{ type: string }]) => call[0].type === 'agent.completed')).toBe(
        false
      );
      expect(episodes.completeEpisode).not.toHaveBeenCalled();
      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).not.toHaveBeenCalled();
    });

    it('should call executeFindDataGaps with limit 10', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [], totalGaps: 0 });
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockExecuteFindDataGaps).toHaveBeenCalledWith({ limit: 10 });
    });

    it('runs the zero-spend watched-entity reflection even when no data gaps exist (UX-051)', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [], totalGaps: 0 });
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
      proactiveInsights.observeWatchedEntityUpdates.mockResolvedValue(1);
      proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 1 });

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result).toMatchObject({
        phase: 'sense',
        action: 'no-gaps',
        missionsSpawned: 0,
        insightsSurfaced: 1,
        insightsTotal: 1,
        insightsStatus: 'ok',
      });
      // No paid work is planned, but the organic insight lane still runs.
      expect(mockDispatchMissionWithGate).not.toHaveBeenCalled();
      expect(mockRecordSweepObservation).not.toHaveBeenCalled();
      expect(proactiveInsights.observeWatchedEntityUpdates).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.detectInsightsForUser).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.generateNarrativeInsights).not.toHaveBeenCalled();
      const episodes = jest.requireMock('@/lib/graph/episodes');
      expect(episodes.completeEpisode).toHaveBeenCalledWith('episode-sweep-1', 'Sweep complete: no gaps found');

      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('1 insights surfaced'),
          sweepStats: expect.objectContaining({
            gapsFound: 0,
            missionsSpawned: 0,
            usersProcessed: 1,
            observationsWritten: 1,
            watchedInsights: 1,
            narrativeInsights: 0,
            insightsTotal: 1,
            insightsStatus: 'ok',
            // OBS-004: this early exit dispatched no children, so the child
            // accounting is 'none' — genuinely nothing to account for, which is a
            // different statement from "children ran and produced nothing".
            children: expect.objectContaining({ dispatched: 0, settled: 0, childrenStatus: 'none' }),
          }),
        })
      );
    });

    it('should handle executeFindDataGaps errors gracefully', async () => {
      mockExecuteFindDataGaps.mockRejectedValue(new Error('Neo4j unavailable'));
      const step = buildMockStep();
      const result = await getHandler()({ step });

      // Should treat error as 0 gaps and return early
      expect(result).toEqual({
        phase: 'sense',
        action: 'no-gaps',
        missionsSpawned: 0,
        observationsWritten: 0,
        insightsSurfaced: 0,
        narrativeInsights: 0,
        insightsTotal: 0,
        insightsStatus: 'quiet',
      });
    });

    it('retries instead of completing when the zero-work Episode cannot close', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [], totalGaps: 0 });
      const episodes = jest.requireMock('@/lib/graph/episodes');
      episodes.completeEpisode.mockRejectedValueOnce(new Error('Episode terminal conflict'));

      await expect(getHandler()({ step: buildMockStep() })).rejects.toThrow('Episode terminal conflict');

      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      expect(emitAgentEvent.mock.calls.some((call: [{ type: string }]) => call[0].type === 'agent.completed')).toBe(
        false
      );
    });
  });

  // =========================================================================
  // DECIDE phase
  // =========================================================================

  describe('DECIDE phase', () => {
    it('should route orphan gaps (no relations) to linker agent', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [buildGap({ issues: ['No relations in knowledge graph'] })],
        totalGaps: 1,
      });
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockDispatchMissionWithGate).toHaveBeenCalledWith(
        'system-sweep',
        expect.objectContaining({ agent: 'linker', skipResearchGate: true })
      );
    });

    it('should route stale gaps to scout agent', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({
            entityName: 'Stale Corp',
            issues: ['Stale (not updated in 90+ days)'],
          }),
        ],
        totalGaps: 1,
      });
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockDispatchMissionWithGate).toHaveBeenCalledWith(
        'system-sweep',
        expect.objectContaining({
          agent: 'scout',
          prompt: expect.stringContaining('Update information about'),
          skipResearchGate: true,
        })
      );
    });

    it('should route missing-description gaps to scout agent', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({
            entityName: 'No Desc Tech',
            issues: ['Missing description'],
          }),
        ],
        totalGaps: 1,
      });
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockDispatchMissionWithGate).toHaveBeenCalledWith(
        'system-sweep',
        expect.objectContaining({
          agent: 'scout',
          prompt: expect.stringContaining('Research and provide a description for'),
          skipResearchGate: true,
        })
      );
    });

    it('still reflects watched updates when every data gap is non-actionable (UX-051)', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({
            entityName: 'Weird Gap',
            issues: ['Some unknown issue type'],
          }),
        ],
        totalGaps: 1,
      });
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
      proactiveInsights.observeWatchedEntityUpdates.mockResolvedValue(1);
      proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 1 });
      const step = buildMockStep();
      const result = await getHandler()({ step });

      // No actionable missions, should return early from DECIDE
      expect(mockDispatchMissionWithGate).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        phase: 'decide',
        action: 'no-actionable-gaps',
        gapsFound: 1,
        missionsSpawned: 0,
        insightsSurfaced: 1,
        insightsTotal: 1,
        insightsStatus: 'ok',
      });
      expect(proactiveInsights.observeWatchedEntityUpdates).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.detectInsightsForUser).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.generateNarrativeInsights).not.toHaveBeenCalled();
      const episodes = jest.requireMock('@/lib/graph/episodes');
      expect(episodes.completeEpisode).toHaveBeenCalledWith(
        'episode-sweep-1',
        'Sweep complete: 1 non-actionable gaps found'
      );

      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('1 insights surfaced'),
          sweepStats: expect.objectContaining({
            gapsFound: 1,
            missionsSpawned: 0,
            usersProcessed: 1,
            observationsWritten: 1,
            watchedInsights: 1,
            narrativeInsights: 0,
            insightsTotal: 1,
            insightsStatus: 'ok',
            // Non-actionable gaps dispatch no children — nothing to account for.
            children: expect.objectContaining({ dispatched: 0, childrenStatus: 'none' }),
          }),
        })
      );
    });

    it('should limit to 2 missions per sweep by default (env-overridable)', async () => {
      const gaps = Array.from({ length: 5 }, (_, i) =>
        buildGap({
          entityId: `ent-${i}`,
          entityName: `Entity ${i}`,
          issues: ['No relations in knowledge graph'],
        })
      );
      mockExecuteFindDataGaps.mockResolvedValue({ gaps, totalGaps: 5 });
      const step = buildMockStep();
      await getHandler()({ step });

      // Default cap is 2 missions/cycle. Override via env
      // SWEEP_MAX_MISSIONS_PER_CYCLE.
      expect(mockDispatchMissionWithGate).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // ACT phase
  // =========================================================================

  describe('ACT phase', () => {
    beforeEach(() => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'ent-1', entityName: 'Orphan Co', issues: ['No relations in knowledge graph'] }),
          buildGap({ entityId: 'ent-2', entityName: 'Stale Tech', issues: ['Stale (not updated in 90+ days)'] }),
        ],
        totalGaps: 2,
      });
    });

    it('should create missions and fire Inngest events (capped at 2/cycle by default)', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      // Default cap is 2 missions/cycle (env: SWEEP_MAX_MISSIONS_PER_CYCLE).
      // 2 gaps available → both dispatched.
      expect(mockDispatchMissionWithGate).toHaveBeenCalledTimes(2);
      expect(getInngestSend()).toHaveBeenCalledTimes(2);
    });

    it('should fire app/mission.run.requested events', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      expect(getInngestSend()).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/mission.run.requested',
          data: expect.objectContaining({
            missionId: 'mission-sweep-1',
            userId: 'system-sweep',
          }),
        })
      );
    });

    it('should use system-sweep as the userId', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockDispatchMissionWithGate).toHaveBeenCalledWith(
        'system-sweep',
        expect.objectContaining({ skipResearchGate: true })
      );
    });

    it('should report missionsSpawned=0 when the single mission fails (cap=1 default)', async () => {
      mockDispatchMissionWithGate.mockReset();
      mockDispatchMissionWithGate.mockRejectedValue(new Error('Firestore write failed'));

      const step = buildMockStep();
      const result = await getHandler()({ step });

      // With default cap=1, only one attempt. It fails => 0 spawned.
      expect(result.missionsSpawned).toBe(0);
    });

    it('should return 0 spawned when the dispatch fails', async () => {
      mockDispatchMissionWithGate.mockReset();
      mockDispatchMissionWithGate.mockRejectedValue(new Error('All fail'));

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result.missionsSpawned).toBe(0);
    });
  });

  // =========================================================================
  // REFLECT phase
  // =========================================================================

  describe('REFLECT phase', () => {
    beforeEach(() => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [buildGap({ entityId: 'ent-1', entityName: 'Test Co', issues: ['No relations in knowledge graph'] })],
        totalGaps: 1,
      });
    });

    it('should record an observation after spawning missions', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockRecordSweepObservation).toHaveBeenCalledTimes(1);
      expect(mockRecordSweepObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          sweepId: expect.stringMatching(/^sweep-\d+$/),
          episodeId: 'episode-sweep-1',
          gapIndex: 0,
          confidence: 0.8,
          entityId: 'ent-1',
          entityName: 'Test Co',
          entityType: 'companies',
        })
      );
      // Generic writers serve unrelated observation lifecycles and must not
      // acquire an implicit Episode link.
      expect(mockRecordObservation).not.toHaveBeenCalled();
    });

    it('records N observations for N gaps, each anchored to its own entity', async () => {
      // Regression guard for the 2026-05-12 "gaps[0] anchor" bug. Before the
      // fix, the sweep recorded ONE observation pointing at gaps[0].entityId
      // — so every downstream ProactiveInsight claimed the discovery was
      // about gaps[0] (often unrelated to the actual gap). After the fix,
      // there should be one observation per gap, each carrying its own
      // entityId so dot-connecting builds insights about the real entity.
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'ent-1', entityName: 'Acme Corp', entityType: 'companies' }),
          buildGap({ entityId: 'ent-2', entityName: 'GreenPak', entityType: 'companies' }),
          buildGap({ entityId: 'tech-1', entityName: 'Vector DB', entityType: 'technologies' }),
        ],
        totalGaps: 3,
      });

      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockRecordSweepObservation).toHaveBeenCalledTimes(3);
      const calls = mockRecordSweepObservation.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const entityIds = calls.map((c) => c.entityId).sort();
      expect(entityIds).toEqual(['ent-1', 'ent-2', 'tech-1']);
      expect(calls.map((c) => c.gapIndex)).toEqual([0, 1, 2]);
      const observationSteps = step.run.mock.calls
        .map((call: [string, AnyFunction]) => call[0])
        .filter((name: string) => name.startsWith('reflect-record-observation-'));
      expect(observationSteps).toHaveLength(3);
      expect(new Set(observationSteps).size).toBe(3);
      // Critical: no observation hard-codes gaps[0].entityId for the others.
      expect(new Set(entityIds).size).toBe(3);
    });

    it('should record one observation per gap with a specific entity anchor', async () => {
      // Updated 2026-05-12: the sweep now records ONE observation per gap
      // anchored to that gap's real entity, instead of a single sweep meta-
      // observation that always pinned to gaps[0]. The previous behaviour
      // caused every downstream ProactiveInsight to say "AI Agents connects
      // to X" regardless of what the gap was actually about, because gaps[0]
      // happened to be the AI Agents entity.
      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockRecordSweepObservation).toHaveBeenCalledTimes(1);
      const observationArg = mockRecordSweepObservation.mock.calls[0][0] as Record<string, unknown>;
      // Each per-gap observation carries the gap's own entityId, not a
      // hard-coded gaps[0]. Summary names the specific entity + issues.
      expect(observationArg.entityId).toBeTruthy();
      expect(observationArg.entityName).toBeTruthy();
      expect(observationArg.summary).toMatch(/Sweep cycle flagged/);
    });

    it('should include ISO timestamp in observation', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      const observationArg = mockRecordSweepObservation.mock.calls[0][0] as Record<string, unknown>;
      expect(() => new Date(observationArg.timestamp as string)).not.toThrow();
      expect(typeof observationArg.timestamp).toBe('string');
    });

    it('should let a transient sweep-observation failure escape for durable retry', async () => {
      mockRecordSweepObservation.mockRejectedValue(new Error('Neo4j down'));

      const step = buildMockStep();
      await expect(getHandler()({ step })).rejects.toThrow('Neo4j down');
      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      const completed = emitAgentEvent.mock.calls.filter(
        (call: [{ type: string }]) => call[0].type === 'agent.completed'
      );
      expect(completed).toHaveLength(0);
    });

    it('memoizes earlier gaps when a later observation commits but loses its acknowledgement', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'first', entityName: 'First' }),
          buildGap({ entityId: 'second', entityName: 'Second' }),
        ],
        totalGaps: 2,
      });
      mockRecordSweepObservation.mockImplementation(async (candidate: { entityId: string }) => ({
        status: 'recorded',
        observation: {
          id: `obs-${candidate.entityId}`,
          agentType: 'sweep-cycle',
          observationType: 'discovery',
          title: candidate.entityId,
          summary: candidate.entityId,
          confidence: 0.8,
          entityId: candidate.entityId,
          entityName: candidate.entityId,
          entityType: 'companies',
          timestamp: '2026-07-13T12:00:00.000Z',
        },
      }));
      const step = buildMemoizedStepWithLostAcknowledgement((name) => name.startsWith('reflect-record-observation-1-'));

      await expect(getHandler()({ step })).rejects.toThrow('acknowledgement lost after reflect-record-observation-1-');
      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).not.toHaveBeenCalled();

      await expect(getHandler()({ step })).resolves.toMatchObject({ phase: 'complete' });
      const entityIds = mockRecordSweepObservation.mock.calls.map((call) => (call[0] as { entityId: string }).entityId);
      expect(entityIds.filter((id) => id === 'first')).toHaveLength(1);
      expect(entityIds.filter((id) => id === 'second')).toHaveLength(2);
      expect(createAgentRun).toHaveBeenCalledTimes(1);
      const episodes = jest.requireMock('@/lib/graph/episodes');
      expect(episodes.completeEpisode).toHaveBeenCalledTimes(1);
    });

    it('continues after an explicit non-writing target skip and links only recorded observations', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'missing', entityName: 'Missing' }),
          buildGap({ entityId: 'present', entityName: 'Present' }),
        ],
        totalGaps: 2,
      });
      mockRecordSweepObservation.mockImplementation(async (candidate: { entityId: string }) =>
        candidate.entityId === 'missing'
          ? { status: 'skipped', observationId: 'obs-missing', reason: 'target-unavailable' }
          : {
              status: 'recorded',
              observation: {
                id: 'obs-present',
                agentType: 'sweep-cycle',
                observationType: 'discovery',
                title: 'Present',
                summary: 'Present',
                confidence: 0.8,
                entityId: 'present',
                entityName: 'Present',
                entityType: 'company',
                timestamp: '2026-07-13T12:00:00.000Z',
              },
            }
      );
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);

      await expect(getHandler()({ step: buildMockStep() })).resolves.toMatchObject({ phase: 'complete' });
      expect(mockConnectDots).toHaveBeenCalledTimes(1);
      expect(mockConnectDots).toHaveBeenCalledWith('obs-present', 'user-1');
    });

    it('uses the sweep lifecycle identity, not the Episode id, for CuriosityGaps', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'actionable', issues: ['No relations in knowledge graph'] }),
          buildGap({ entityId: 'unknown', issues: ['Unknown graph issue'] }),
        ],
        totalGaps: 2,
      });

      await getHandler()({ step: buildMockStep() });

      const curiosity = jest.requireMock('@/lib/graph/curiosity-gaps');
      expect(curiosity.recordCuriosityGap).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: expect.stringMatching(/^sweep-\d+$/) })
      );
      expect(curiosity.recordCuriosityGap).not.toHaveBeenCalledWith(
        expect.objectContaining({ missionId: 'episode-sweep-1' })
      );
    });

    it('should call connectDots for each active user after the sweep observation converges', async () => {
      mockRecordSweepObservation.mockResolvedValue({
        status: 'recorded',
        observation: {
          id: 'obs-1',
          agentType: 'sweep-cycle',
          observationType: 'discovery',
          title: 'test',
          summary: 'test',
          confidence: 0.8,
          entityId: 'ent-1',
          entityName: 'Test Co',
          entityType: 'companies',
          timestamp: '2026-02-24T00:00:00.000Z',
        },
      });
      // Override getActiveUserIds to return users
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1', 'user-2']);

      const step = buildMockStep();
      await getHandler()({ step });

      expect(mockConnectDots).toHaveBeenCalledTimes(2);
      expect(mockConnectDots).toHaveBeenCalledWith('obs-1', 'user-1');
      expect(mockConnectDots).toHaveBeenCalledWith('obs-1', 'user-2');
    });

    it('should not fail the sweep if connectDots throws', async () => {
      mockRecordSweepObservation.mockResolvedValue({
        status: 'recorded',
        observation: {
          id: 'obs-1',
          agentType: 'sweep-cycle',
          observationType: 'discovery',
          title: 'test',
          summary: 'test',
          confidence: 0.8,
          entityId: 'ent-1',
          entityName: 'Test Co',
          entityType: 'companies',
          timestamp: '2026-02-24T00:00:00.000Z',
        },
      });
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
      mockConnectDots.mockRejectedValue(new Error('Neo4j timeout'));

      const step = buildMockStep();
      // Should NOT throw
      const result = await getHandler()({ step });
      expect(result.phase).toBe('complete');
    });
  });

  // =========================================================================
  // Full cycle integration
  // =========================================================================

  describe('full cycle', () => {
    it('should execute all four steps in order', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [buildGap()],
        totalGaps: 1,
      });

      const step = buildMockStep();
      await getHandler()({ step });

      const stepNames = step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepNames).toEqual([
        // OBS-004: both elapsed-time endpoints are memoized steps, and they
        // BRACKET the cycle — the start before any work, the end immediately
        // before the summary row that reports the duration.
        'capture-sweep-start',
        'mint-sweep-id',
        'load-sweep-config',
        'create-sweep-episode',
        'sense-discover-gaps',
        'decide-route-tasks',
        'act-spawn-missions',
        expect.stringMatching(/^reflect-record-observation-0-[a-f0-9]{12}$/),
        'reflect-persist-curiosity-gaps',
        'reflect-connect-dots',
        // 'reflect-detect-insights' (the OLD indiscriminate path) was removed in
        // Phase 0 step 0.3 (2026-05-13). Re-enabled as the SCOPED step below:
        // observe explored-entity updates + de-noised detectInsightsForUser.
        'reflect-watched-entity-insights',
        'complete-sweep-episode',
        'curiosity-gap-pipeline', // Task 3.5: CuriosityGap → Mission Pipeline
        'capture-sweep-end',
        'write-sweep-agent-run',
      ]);
    });

    it('stamps ONE shared sweepId on every event and the summary AgentRun (ARUN-005 attribution)', async () => {
      const step = buildMockStep();
      await getHandler()({ step });

      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      const calls = emitAgentEvent.mock.calls.map((c: [Record<string, unknown>]) => c[0]);
      expect(calls.length).toBeGreaterThan(0);
      const sweepIds = new Set(calls.map((c: Record<string, unknown>) => c.sweepId));
      // every event attributable, all to the SAME cycle id
      expect(sweepIds.size).toBe(1);
      const [sweepId] = [...sweepIds];
      expect(sweepId).toMatch(/^sweep-\d+$/);

      // lifecycle pair present so the live row opens and closes
      const types = calls.map((c: Record<string, unknown>) => c.type);
      expect(types).toContain('agent.started');
      expect(types).toContain('agent.completed');

      // the durable summary run carries the same id — this is what wires the
      // run-detail Event Log (getEventsForRun queries by sweepId) and the
      // 'Sweep' kind pill (rowsFromAgentLog keys off entry.sweepId)
      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ sweepId }));
    });

    it('emits lifecycle completion only after Episode and final pipeline completion', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [buildGap()], totalGaps: 1 });
      await getHandler()({ step: buildMockStep() });

      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      const completedIndex = emitAgentEvent.mock.calls.findIndex(
        (call: [{ type: string }]) => call[0].type === 'agent.completed'
      );
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      const completedOrder = emitAgentEvent.mock.invocationCallOrder[completedIndex];
      const episodes = jest.requireMock('@/lib/graph/episodes');
      const curiosity = jest.requireMock('@/lib/graph/curiosity-gaps');
      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(completedOrder).toBeGreaterThan(episodes.completeEpisode.mock.invocationCallOrder[0]);
      expect(completedOrder).toBeGreaterThan(curiosity.getOpenGaps.mock.invocationCallOrder[0]);
      expect(createAgentRun.mock.invocationCallOrder[0]).toBeGreaterThan(
        episodes.completeEpisode.mock.invocationCallOrder[0]
      );
      expect(createAgentRun.mock.invocationCallOrder[0]).toBeGreaterThan(
        curiosity.getOpenGaps.mock.invocationCallOrder[0]
      );
      expect(completedOrder).toBeGreaterThan(createAgentRun.mock.invocationCallOrder[0]);
    });

    it('does not record success or completion when the terminal Episode write fails', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [buildGap()], totalGaps: 1 });
      const episodes = jest.requireMock('@/lib/graph/episodes');
      episodes.completeEpisode.mockRejectedValueOnce(new Error('Episode terminal conflict'));

      await expect(getHandler()({ step: buildMockStep() })).rejects.toThrow('Episode terminal conflict');

      const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
      expect(createAgentRun).not.toHaveBeenCalled();
      const { emitAgentEvent } = jest.requireMock('@/lib/agent-events');
      expect(emitAgentEvent.mock.calls.some((call: [{ type: string }]) => call[0].type === 'agent.completed')).toBe(
        false
      );
    });

    it('surfaces watched-entity insights de-noised: observes explored-entity updates then detects, per active user', async () => {
      // The OLD path promoted every "Sweep: X (stale)" bookkeeping observation
      // into a card (disabled 2026-05-13). The SCOPED re-enable records the
      // explored-entity-changed SIGNAL first (observeWatchedEntityUpdates), then
      // surfaces it via detectInsightsForUser — which de-noises sweep-cycle
      // bookkeeping in its own query. Both run, once per active user.
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [buildGap({ entityId: 'e1', issues: ['No relations in knowledge graph'] })],
      });
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1', 'user-2']);
      proactiveInsights.detectInsightsForUser.mockClear();
      proactiveInsights.observeWatchedEntityUpdates.mockClear();

      const handler = getHandler();
      const step = buildMockStep();
      await handler({ step });

      expect(proactiveInsights.observeWatchedEntityUpdates).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.observeWatchedEntityUpdates).toHaveBeenCalledWith('user-2');
      expect(proactiveInsights.detectInsightsForUser).toHaveBeenCalledWith('user-1');
      expect(proactiveInsights.detectInsightsForUser).toHaveBeenCalledWith('user-2');
    });

    it('does not fail the sweep if watched-entity surfacing throws', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [buildGap({ entityId: 'e1', issues: ['No relations in knowledge graph'] })],
      });
      const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
      const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
      sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
      proactiveInsights.observeWatchedEntityUpdates.mockRejectedValueOnce(new Error('neo4j down'));

      const step = buildMockStep();
      await expect(getHandler()({ step })).resolves.toMatchObject({ phase: 'complete' });
    });

    it('should return complete result with gap and mission counts', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({
        gaps: [
          buildGap({ entityId: 'e1', issues: ['No relations in knowledge graph'] }),
          buildGap({ entityId: 'e2', issues: ['Missing description'] }),
        ],
        totalGaps: 2,
      });

      const step = buildMockStep();
      const result = await getHandler()({ step });

      expect(result).toEqual({
        phase: 'complete',
        gapsFound: 2,
        // Default cap=2 → both gaps spawn missions.
        missionsSpawned: 2,
        // OBS-004: the number of children whose outcomes this cycle is now
        // ACCOUNTABLE for — the denominator the child aggregate settles against.
        childrenDispatched: 2,
        // Insight-production volume surfaced for per-cycle observability (no active
        // users in this test → a healthy pipeline that genuinely produced nothing,
        // which OBS-004 reports as 'quiet' — distinguishable from 'failed').
        insightsSurfaced: 0,
        narrativeInsights: 0,
        insightsTotal: 0,
        observationsWritten: 0,
        insightsStatus: 'quiet',
        // OBS-001/OBS-004: a cycle that dispatched paid children has NOT delivered
        // yet — the children have not reported. `partial` is the honest declaration
        // until they settle; declaring success here is what let a sweep whose two
        // paid children both failed be counted as a success.
        __domainOutcome: { outcome: 'partial', reason: 'children-pending' },
      });
    });

    it('keeps the no-gap path bounded to the organic reflection steps', async () => {
      mockExecuteFindDataGaps.mockResolvedValue({ gaps: [], totalGaps: 0 });

      const step = buildMockStep();
      await getHandler()({ step });

      const stepNames = step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepNames).toEqual([
        'capture-sweep-start',
        'mint-sweep-id',
        'load-sweep-config',
        'create-sweep-episode',
        'sense-discover-gaps',
        'reflect-watched-entity-insights',
        'complete-sweep-episode',
        'capture-sweep-end',
        'write-sweep-agent-run',
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// OBS-004 — durable honest sweep counters
// ---------------------------------------------------------------------------

describe('OBS-004 — durable honest sweep counters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const episodes = jest.requireMock('@/lib/graph/episodes');
    episodes.createEpisode.mockResolvedValue({ id: 'episode-sweep-1' });
    episodes.completeEpisode.mockResolvedValue(undefined);
    const agentRuns = jest.requireMock('@/lib/agent-runs');
    agentRuns.createAgentRun.mockResolvedValue({ id: 'run-sweep-1' });
    mockConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 10 } }),
    });
    mockExecuteFindDataGaps.mockResolvedValue({ gaps: [buildGap()], totalGaps: 1 });
    mockDispatchMissionWithGate.mockResolvedValue({ dispatched: [{ id: 'mission-1' }] });
    const curiosity = jest.requireMock('@/lib/graph/curiosity-gaps');
    curiosity.getOpenGaps.mockResolvedValue([]);
  });

  it('persists narrative-only production — the durable row must never read as zero', async () => {
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
    sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
    proactiveInsights.observeWatchedEntityUpdates.mockResolvedValue(0);
    proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 0 });
    proactiveInsights.generateNarrativeInsights.mockResolvedValue(2);

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({
      insightsSurfaced: 0,
      narrativeInsights: 2,
      insightsTotal: 2,
      insightsStatus: 'ok',
    });

    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        action: expect.stringContaining('2 insights surfaced (0 watched, 2 narrative)'),
        sweepStats: expect.objectContaining({
          usersProcessed: 1,
          watchedInsights: 0,
          narrativeInsights: 2,
          insightsTotal: 2,
          insightsStatus: 'ok',
        }),
      })
    );
  });

  it('persists a failed insight pipeline as failed — zeros must not masquerade as a quiet sweep', async () => {
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    // Persistent rejection (not Once): getActiveUserIds is also called by the
    // earlier reflect-connect-dots step, which swallows its own failure — the
    // rejection must still be live when the insight step reads active users.
    sessionMemory.getActiveUserIds.mockRejectedValue(new Error('neo4j down'));

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({ insightsStatus: 'failed', insightsTotal: 0, narrativeInsights: 0 });

    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failure',
        action: expect.stringContaining('insight generation failed'),
        sweepStats: expect.objectContaining({ insightsStatus: 'failed', insightsTotal: 0 }),
      })
    );
  });

  it('persists a per-user stage failure as failed — a broken loop must not read as quiet', async () => {
    // Every user's OBSERVE throws. The outer try never fires, so before this
    // fix the cycle reported zeros as 'quiet' and UX-051 told the operator
    // the sweep "ran healthily and found no new insights".
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
    sessionMemory.getActiveUserIds.mockResolvedValue(['user-1', 'user-2']);
    proactiveInsights.observeWatchedEntityUpdates.mockRejectedValue(new Error('neo4j write denied'));

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({ insightsStatus: 'failed', insightsTotal: 0 });

    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failure',
        action: expect.stringContaining('insight generation failed'),
        sweepStats: expect.objectContaining({
          insightsStatus: 'failed',
          // Users enumerated but never processed must not be counted as
          // processed — that would overstate coverage on a failing cycle.
          usersProcessed: 0,
        }),
      })
    );
  });

  it('still reports ok when some users fail but others produce insights', async () => {
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
    sessionMemory.getActiveUserIds.mockResolvedValue(['user-1', 'user-2']);
    proactiveInsights.observeWatchedEntityUpdates
      .mockRejectedValueOnce(new Error('one user failed'))
      .mockResolvedValue(1);
    proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 1 });
    proactiveInsights.generateNarrativeInsights.mockResolvedValue(0);

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({ insightsStatus: 'ok', insightsTotal: 1 });
    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ sweepStats: expect.objectContaining({ usersProcessed: 1 }) })
    );
  });

  it('persists a genuinely quiet sweep as quiet — distinguishable from both success and failure', async () => {
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
    sessionMemory.getActiveUserIds.mockResolvedValue(['user-1']);
    proactiveInsights.observeWatchedEntityUpdates.mockResolvedValue(0);
    proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 0 });
    proactiveInsights.generateNarrativeInsights.mockResolvedValue(0);

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({ insightsStatus: 'quiet', insightsTotal: 0 });

    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        action: expect.stringContaining('no new insights'),
        sweepStats: expect.objectContaining({
          insightsStatus: 'quiet',
          watchedInsights: 0,
          narrativeInsights: 0,
          insightsTotal: 0,
        }),
      })
    );
  });

  it('maps the insight outcome to the truthful run-level status without conflating quiet and skipped', () => {
    expect(resolveSweepAgentRunStatus('ok')).toBe('success');
    expect(resolveSweepAgentRunStatus('quiet')).toBe('success');
    expect(resolveSweepAgentRunStatus('failed')).toBe('failure');
    expect(resolveSweepAgentRunStatus('not-run')).toBe('skipped');
  });

  it('persists watched+narrative mixed production with both counters intact', async () => {
    const sessionMemory = jest.requireMock('@/lib/graph/session-memory');
    const proactiveInsights = jest.requireMock('@/lib/graph/proactive-insights');
    sessionMemory.getActiveUserIds.mockResolvedValue(['user-1', 'user-2']);
    proactiveInsights.observeWatchedEntityUpdates.mockResolvedValue(1);
    proactiveInsights.detectInsightsForUser.mockResolvedValue({ insightsCreated: 1 });
    proactiveInsights.generateNarrativeInsights.mockResolvedValue(1);

    const result = await getHandler()({ step: buildMockStep() });

    expect(result).toMatchObject({
      insightsSurfaced: 2,
      narrativeInsights: 2,
      insightsTotal: 4,
      observationsWritten: 2,
      insightsStatus: 'ok',
    });

    const { createAgentRun } = jest.requireMock('@/lib/agent-runs');
    expect(createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sweepStats: expect.objectContaining({
          usersProcessed: 2,
          watchedInsights: 2,
          narrativeInsights: 2,
          insightsTotal: 4,
          observationsWritten: 2,
          insightsStatus: 'ok',
        }),
      })
    );
  });
});
