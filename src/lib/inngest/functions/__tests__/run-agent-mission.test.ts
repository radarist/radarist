/**
 * @jest-environment node
 */

import { createHash } from 'node:crypto';

// ARUN-022: the mission usage-receipt flush is a server-only boundary that talks
// to Firestore. Unit tests for the Inngest handler do not set up Firestore, so
// the flush must be short-circuited here. The flush itself is unit-tested in
// `src/lib/__tests__/mission-usage-receipts.test.ts` and exercised end-to-end in
// `tests/emulator/arun-022-accounting-producers.emulator.ts`.
jest.mock('@/lib/mission-usage-receipts', () => ({
  flushMissionUsageReceipts: jest.fn().mockResolvedValue({
    flush: undefined,
    settlements: {},
  }),
  // ARUN-022/AI-029: the out-of-process helper/revision sub-session envelope.
  // It MUST be present here — the handler calls it inside a try/catch, so a
  // missing mock would make the flush a silent no-op that still passes.
  flushSubSessionUsageReceipts: jest.fn().mockResolvedValue({
    flush: undefined,
    settlements: {},
  }),
}));

/**
 * @file Tests for run-agent-mission Inngest function
 *
 * Tests verify:
 * - Function is registered with correct config (id, retries, concurrency)
 * - Mission status is updated to 'running' at start
 * - Orchestrator is called with the user prompt
 * - AgentRun record is created after orchestrator completes
 * - Mission is updated with results on success
 * - Mission is updated with failure on orchestrator error
 * - onFailure handler updates mission status
 * - Long prompts are truncated in AgentRun action field
 */

type AnyFunction = (...args: any[]) => any;
type TestCostEnvelope = {
  orchestratorMaxCostUsd: number;
  revisionMaxCostUsd: number;
  preludeMaxCostUsd: number;
  auxiliaryMaxCostUsd: number;
  totalMaxCostUsd: number;
  // COORD-012 execution-envelope extensions. Optional so legacy-shaped
  // memoized values (pre-envelope in-flight runs) stay representable.
  maxToolCalls?: number;
  timeoutMinutes?: number;
  requestedModel?: string;
  authorizedFallbackModel?: string;
  envelopeSource?: 'mission' | 'environment';
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock inngest client with registry pattern (established project convention)
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

// Mock Orchestrator — the source uses pathToFileURL dynamic import which Jest
// cannot resolve (ESM). We intercept at step.run level instead.
const mockRunMission = jest.fn();
const mockOrchestratorConstruction = jest.fn();
const mockAbortMission = jest.fn();
const mockGetUsageSnapshot = jest.fn(
  (): {
    costUsd: number | null;
    tokenUsage: { input: number; output: number };
    costUnavailableReason?: string;
  } => ({ costUsd: 0, tokenUsage: { input: 0, output: 0 } })
);
const mockGetAccumulatedPartial = jest.fn(() => ({ partialResult: '', turn: 0 }));
const mockBudgetUpdateCost = jest.fn();
const mockCreateBudgetHooks = jest.fn((_tokenBudget: number, _maxToolCalls: number) => ({
  hooks: {},
  budgetState: {
    toolCallCount: 0,
    tokensUsed: 0,
    estimatedCostUsd: 0,
    updateCost: (...args: unknown[]) => mockBudgetUpdateCost(...args),
  },
}));
const mockCreatePermissionsHooks = jest.fn((_options: unknown) => ({ hooks: {} }));
const mockLoadAllProfiles = jest.fn((): Map<string, unknown> => new Map());
const mockImportedAgentLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  close: jest.fn(),
};

jest.mock('@/lib/agent-import', () => ({
  importOrchestrator: jest.fn(async () => ({
    createLogger: jest.fn(() => mockImportedAgentLogger),
    createAuditHooks: jest.fn(() => ({ hooks: {} })),
    createBudgetHooks: (tokenBudget: number, maxToolCalls: number) => mockCreateBudgetHooks(tokenBudget, maxToolCalls),
    createPermissionsHooks: (options: unknown) => mockCreatePermissionsHooks(options),
    loadAllProfiles: () => mockLoadAllProfiles(),
    Orchestrator: class MockOrchestrator {
      constructor(options: unknown) {
        mockOrchestratorConstruction(options);
      }

      runMission(prompt: string) {
        return mockRunMission(prompt);
      }

      abort(reason?: string) {
        return mockAbortMission(reason);
      }

      getUsageSnapshot() {
        return mockGetUsageSnapshot();
      }

      getAccumulatedPartial() {
        return mockGetAccumulatedPartial();
      }
    },
  })),
}));

const mockGetMissionUserPreferences = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/user-preferences', () => ({
  getMissionUserPreferences: (...args: unknown[]) => mockGetMissionUserPreferences(...args),
  buildUserPreferencesPreamble: jest.fn(() => ''),
}));

const mockCreateReflection = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/graph/agent-reflections', () => ({
  queryRecentReflections: jest.fn().mockResolvedValue([]),
  buildReflectionPromptBlock: jest.fn(() => ''),
  createReflection: (...args: unknown[]) => mockCreateReflection(...args),
}));

const mockGenerateContentWithMetadata = jest.fn().mockResolvedValue({
  text: 'Reflection generated for test',
  costUsd: 0,
});
jest.mock('@/lib/ai/client', () => ({
  generateContentWithMetadata: (...args: unknown[]) => mockGenerateContentWithMetadata(...args),
}));

// Mock mission service
const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockGetMissionById = jest.fn().mockResolvedValue({ id: 'mission-123', userId: 'user-456' });
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
  getMissionById: async (...args: unknown[]) => {
    const mission = await mockGetMissionById(...args);
    // Most older focused fixtures predate persisted mission ownership. Keep
    // their payloads concise while ensuring production always receives the
    // stored owner; explicit userId values (including invalid blanks) win.
    return mission && typeof mission === 'object' && !Array.isArray(mission) && !('userId' in mission)
      ? { ...mission, userId: 'user-456' }
      : mission;
  },
  appendSkillInvocation: jest.fn().mockResolvedValue(undefined),
}));

// Mock mission chains (T1.8) — the advance-chain step dynamic-imports these.
const mockShouldAdvanceChain = jest.fn().mockReturnValue(false);
const mockFindNextChainStep = jest.fn().mockResolvedValue(null);
const mockRenderPromptWithParent = jest.fn((prompt: string, parentResult?: string) =>
  prompt.replace(/\{\{\s*parent\.result\s*\}\}/g, (parentResult ?? '').slice(0, 32 * 1024))
);
jest.mock('@/lib/mission-chains', () => ({
  __esModule: true,
  shouldAdvanceChain: (...args: unknown[]) => mockShouldAdvanceChain(...args),
  findNextChainStep: (...args: unknown[]) => mockFindNextChainStep(...args),
  renderPromptWithParent: (...args: [string, string?]) => mockRenderPromptWithParent(...args),
}));

// Mock agent runs service
const mockCreateAgentRun = jest.fn().mockResolvedValue({ id: 'run-123' });
const mockRecordMissionFailureFallback = jest.fn().mockResolvedValue({ written: true, reason: 'created' });
jest.mock('@/lib/agent-runs', () => ({
  __esModule: true,
  createAgentRun: (...args: unknown[]) => mockCreateAgentRun(...args),
  recordMissionFailureFallback: (...args: unknown[]) => mockRecordMissionFailureFallback(...args),
}));

// Mock reports service. The runtime is allowed to consume only the strict
// owner-scoped collection reader and exact-ID owned reader. Deliberately do not
// export legacy unscoped helpers: a production regression to one fails loudly.
const mockGetReportsByMissionId = jest.fn().mockResolvedValue([]);
const mockUpdateReport = jest.fn().mockResolvedValue(undefined);
const mockGetReportById = jest.fn().mockResolvedValue(null);
const mockRestoreReportVersion = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  // One strict mission read supplies compact identity; later quality/revision
  // callbacks re-read owned content without memoizing Report HTML.
  // REPORT-004: restoreReportVersion is the deterministic regression rollback.
  getReportsByMissionIdOwnedBy: (...args: unknown[]) => mockGetReportsByMissionId(...args),
  updateReport: (...args: unknown[]) => mockUpdateReport(...args),
  getReportOwnedBy: (...args: unknown[]) => mockGetReportById(...args),
  restoreReportVersion: (...args: unknown[]) => mockRestoreReportVersion(...args),
}));

// REPORT-004: the revise step freezes each prior artifact as an immutable
// version (with receipt) before any paid revision. Default succeeds with a
// deterministic per-report ref; a test overrides it to prove the
// no-durable-restore-path → no-revision rule.
const mockCaptureReportVersionWithReceipt = jest.fn(async (reportId: string) => ({
  versionId: `ver-${reportId}`,
  versionNumber: 1,
  htmlLength: 42,
  htmlSha256: 'a'.repeat(64),
}));
jest.mock('@/lib/reports/report-versions', () => ({
  __esModule: true,
  captureReportVersionWithReceipt: (...args: unknown[]) => mockCaptureReportVersionWithReceipt(...(args as [string])),
}));

// Partial-mock mission-quality: keep the real deterministic evaluator (and
// isRevisionRegression / withAdditionalChecks) by default, but let a test force
// the REVISED evaluation to a specific verdict/score by targeting its result
// text — so the MISSION-002 regression gate can be exercised deterministically.
const mockEvaluateMissionQuality = jest.fn();
jest.mock('@/lib/mission-quality', () => {
  const actual = jest.requireActual('@/lib/mission-quality');
  return {
    __esModule: true,
    ...actual,
    evaluateMissionQuality: (...args: unknown[]) => mockEvaluateMissionQuality(...args),
  };
});
const actualMissionQuality = jest.requireActual('@/lib/mission-quality') as {
  evaluateMissionQuality: (arg: unknown) => unknown;
};
const actualScoutBundleParser = jest.requireActual('@/lib/scout-bundle-parser') as {
  parseScoutBundle: (result: string) => unknown;
};

// Mock graph episodes
const mockCreateEpisode = jest.fn().mockResolvedValue({ id: 'ep-test-1' });
const mockCompleteEpisode = jest.fn().mockResolvedValue(undefined);
const mockFailEpisode = jest.fn().mockResolvedValue(undefined);
const mockFinalizeMissionEpisode = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/graph/episodes', () => ({
  __esModule: true,
  createEpisode: (...args: unknown[]) => mockCreateEpisode(...args),
  completeEpisode: (...args: unknown[]) => mockCompleteEpisode(...args),
  failEpisode: (...args: unknown[]) => mockFailEpisode(...args),
  finalizeMissionEpisode: (...args: unknown[]) => mockFinalizeMissionEpisode(...args),
}));

// Mock agent events (SSE event emission — must never break mission flow)
const mockEmitAgentEvent = jest.fn((_event: unknown) => Promise.resolve());
jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: (event: unknown) => mockEmitAgentEvent(event),
}));

// Mock scout bundle parser. Keep the real verdictFromAdmiralty — M13 asserts
// the SUT derives observation verdicts from the bundle's Admiralty grades.
const mockParseScoutBundle = jest.fn();
jest.mock('@/lib/scout-bundle-parser', () => {
  const actual = jest.requireActual('@/lib/scout-bundle-parser');
  return {
    __esModule: true,
    ...actual,
    parseScoutBundle: (...args: unknown[]) => mockParseScoutBundle(...args),
    containsBundleMarker: jest.fn().mockReturnValue(true),
  };
});

// Mock skill-prelude — sub-mission runner and revision orchestrator.
// Tests override these per-case to assert fan-out, persistence, and revision.
const mockRunSkillSubMission = jest.fn();
const mockRunRevisionOrchestrator = jest.fn();
jest.mock('@/lib/skill-prelude', () => {
  const actual = jest.requireActual('@/lib/skill-prelude');
  return {
    __esModule: true,
    ...actual,
    runSkillSubMission: (...args: unknown[]) => mockRunSkillSubMission(...args),
    runRevisionOrchestrator: (...args: unknown[]) => mockRunRevisionOrchestrator(...args),
  };
});

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// OPS-004: the worker runs a memoized MCP preflight step before any paid stage.
// Default to reachable so existing tests are unaffected; the OPS-004 regression
// overrides it to fail and asserts every paid provider stage is skipped.
const mockPreflightMissionMcp = jest.fn(async () => ({
  ok: true as boolean,
  baseUrl: 'http://127.0.0.1:9002/api/mcp',
  checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
  unreachable: [] as string[],
  reason: undefined as 'mcp-preflight-failed' | undefined,
}));
jest.mock('@/lib/mission-mcp-preflight', () => ({
  __esModule: true,
  preflightMissionMcp: (...args: unknown[]) => mockPreflightMissionMcp(...(args as [])),
  formatMcpPreflightFailure: (result: { baseUrl: string; unreachable: string[] }) =>
    `mcp-preflight-failed: internal platform MCP server(s) unreachable at ${result.baseUrl} (${result.unreachable.join(', ')}).`,
  MCP_PREFLIGHT_FAILED_REASON: 'mcp-preflight-failed',
  REQUIRED_INTERNAL_MCP_SERVERS: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
}));

// Import AFTER all mocks - triggers createFunction and populates registry
import '../run-agent-mission';

// ARUN-022: the mocked mission-usage-receipts flush is imported so tests can
// inspect the arguments it receives for synthetic fallback behavior.
import { flushMissionUsageReceipts, flushSubSessionUsageReceipts } from '@/lib/mission-usage-receipts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTION_ID = 'run-agent-mission';

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

// ARUN-002: deterministic memoized timestamps so the duration assertion is stable.
const CAPTURED_START_MS = 1_700_000_000_000;
const CAPTURED_END_MS = CAPTURED_START_MS + 60_000; // 60s
const EPISODE_FINALIZATION_IDENTITY = {
  episodeId: 'ep-test-1',
  missionId: 'mission-123',
  userId: 'user-456',
  agentName: 'scout',
};

type MockStepOptions = {
  executeOrchestrator?: boolean;
  memoizedCostEnvelope?: TestCostEnvelope;
};

function buildMockStep(options: MockStepOptions = {}) {
  return {
    run: jest.fn(async (name: string, fn: AnyFunction) => {
      // ARUN-002: memoized start/end timestamps (Inngest caches these across
      // replays). Fixed values make the computed duration deterministic.
      if (name === 'capture-start-time') return CAPTURED_START_MS;
      if (name === 'capture-end-time') return CAPTURED_END_MS;
      // Simulate an Inngest replay/new process: the validation callback is not
      // invoked, and the exact envelope memoized by the earlier process wins.
      if (name === 'validate-authorized-cost-envelope' && options.memoizedCostEnvelope) {
        return options.memoizedCostEnvelope;
      }
      // Intercept the orchestrator step — the real code does a pathToFileURL
      // dynamic import that Jest cannot resolve (ESM module).
      if (name === 'execute-orchestrator') {
        if (options.executeOrchestrator) return fn();
        return mockRunMission();
        // Extract prompt from closure by calling the fn in a controlled way?
        // We can't easily call fn() here, so we call mockRunMission with the
        // prompt that was passed in the event context. The actual prompt
        // assertion is done by checking mockRunMission was called.
      }
      // NOTE: 'execute-revision-orchestrator' was removed in the nested-step
      // fix. Step 2.75 now calls runRevisionOrchestrator() directly (mocked
      // at the @/lib/skill-prelude module boundary). No intercept needed here.
      return fn();
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildObservationStepAcknowledgementLossHarness() {
  const cache = new Map<string, unknown>();
  const executions = new Map<string, number>();
  let loseObservationStepAcknowledgement = true;

  const run = jest.fn(async (name: string, fn: AnyFunction) => {
    if (cache.has(name)) return cache.get(name);
    executions.set(name, (executions.get(name) ?? 0) + 1);

    let result: unknown;
    if (name === 'capture-start-time') result = CAPTURED_START_MS;
    else if (name === 'capture-end-time') result = CAPTURED_END_MS;
    else if (name === 'execute-orchestrator') result = await mockRunMission();
    else result = await fn();

    if (name === 'emit-scout-observations' && loseObservationStepAcknowledgement) {
      loseObservationStepAcknowledgement = false;
      throw new Error('observation step acknowledgement lost after sends committed');
    }

    cache.set(name, result);
    return result;
  });

  return {
    step: {
      run,
      sleep: jest.fn().mockResolvedValue(undefined),
      sendEvent: jest.fn().mockResolvedValue(undefined),
    },
    executions,
  };
}

function buildEventContext(overrides: Record<string, unknown> = {}, stepOptions: MockStepOptions = {}) {
  return {
    event: {
      data: {
        missionId: 'mission-123',
        userId: 'user-456',
        prompt: 'Analyze emerging AI trends',
        agent: 'scout',
        ...overrides,
      },
    },
    step: buildMockStep(stepOptions),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run-agent-mission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-set default mock behavior after clearAllMocks
    mockPreflightMissionMcp.mockResolvedValue({
      ok: true,
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
      unreachable: [],
      reason: undefined,
    });
    mockUpdateMission.mockResolvedValue(undefined);
    mockCreateAgentRun.mockResolvedValue({ id: 'run-123' });
    mockRecordMissionFailureFallback.mockResolvedValue({ written: true, reason: 'created' });
    mockCreateEpisode.mockResolvedValue({ id: 'ep-test-1' });
    mockCompleteEpisode.mockResolvedValue(undefined);
    mockFailEpisode.mockResolvedValue(undefined);
    mockFinalizeMissionEpisode.mockResolvedValue(undefined);
    mockCreateReflection.mockResolvedValue(undefined);
    mockGenerateContentWithMetadata.mockResolvedValue({ text: 'Reflection generated for test', costUsd: 0 });
    mockGetMissionById.mockResolvedValue({ id: 'mission-123', userId: 'user-456' });
    mockGetUsageSnapshot.mockReturnValue({ costUsd: 0, tokenUsage: { input: 0, output: 0 } });
    mockGetAccumulatedPartial.mockReturnValue({ partialResult: '', turn: 0 });
    // MISSION-002 defaults: evaluator delegates to the real deterministic impl;
    // reports service returns no prior report / no-op restore.
    mockEvaluateMissionQuality.mockImplementation((arg: unknown) => actualMissionQuality.evaluateMissionQuality(arg));
    mockGetReportsByMissionId.mockResolvedValue([]);
    mockUpdateReport.mockResolvedValue(undefined);
    mockGetReportById.mockResolvedValue(null);
    // Restore the default pre-revision receipt. Without this a test that pins a
    // specific `htmlSha256` (REPORT-020's byte-identity case must) leaks it into
    // every later test, since this mock carries a default IMPLEMENTATION rather
    // than a queued value, and clearing mocks does not restore implementations.
    mockCaptureReportVersionWithReceipt.mockImplementation(async (reportId: string) => ({
      versionId: `ver-${reportId}`,
      versionNumber: 1,
      htmlLength: 42,
      htmlSha256: 'a'.repeat(64),
    }));
    mockParseScoutBundle.mockReturnValue({ ok: false, error: 'no bundle in test default' });
    mockRunRevisionOrchestrator.mockResolvedValue({ success: false, errors: ['default mock — override per test'] });
    mockLoadAllProfiles.mockReturnValue(new Map());
    mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
      skill: input.skill,
      target: input.target,
      block: `<${input.skill}>BLOCK</${input.skill}>`,
      costUsd: 0.05,
      durationMs: 5_000,
      firedAt: new Date().toISOString(),
      success: true,
    }));
  });

  describe('function registration', () => {
    it('should register with correct id', () => {
      expect(getConfig().id).toBe('run-agent-mission');
    });

    it('should register with correct name', () => {
      expect(getConfig().name).toBe('Run Agent Mission');
    });

    it('should set retries to 0 (single-shot mission semantics, no orchestrator relaunches)', () => {
      // Each retry spins up a fresh Anthropic SDK session with no mid-stream
      // resume at the LLM layer. Failures now
      // surface to the user instead of silently auto-retrying.
      expect(getConfig().retries).toBe(0);
    });

    it('should set concurrency limit to 3', () => {
      expect(getConfig().concurrency).toEqual({ limit: 3 });
    });

    it('should have an onFailure handler', () => {
      expect(typeof getConfig().onFailure).toBe('function');
    });

    it('should trigger on app/mission.run.requested event', () => {
      expect(getTrigger()).toEqual({ event: 'app/mission.run.requested' });
    });
  });

  describe('successful mission execution', () => {
    const orchestratorResult = {
      success: true,
      result: 'Analysis complete: 5 trends identified',
      costUsd: 0.05,
      tokenUsage: { input: 1000, output: 500 },
      errors: undefined,
    };

    beforeEach(() => {
      mockRunMission.mockResolvedValue(orchestratorResult);
    });

    it('should update mission status to running', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-123',
        expect.objectContaining({
          status: 'running',
          progress: 10,
          progressMessage: 'Starting scout agent...',
          // ARUN-009: the post-dequeue clock live UI rows use for
          // execution-only age (queue wait excluded, monotonic into the
          // terminal AgentRun duration).
          executionStartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        })
      );
    });

    it('rejects configuration drift above the exact user-authorized cost envelope before paid work', async () => {
      mockGetMissionById.mockResolvedValue({ authorizedMaxCostUsd: 30 });
      const ctx = buildEventContext();

      await expect(getHandler()(ctx)).rejects.toThrow(
        'Mission cost envelope $31.00 exceeds the user-authorized $30.00 maximum; nothing was started'
      );

      expect(ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0])).toEqual([
        'capture-start-time',
        'authorize-mission-owner',
        'validate-authorized-cost-envelope',
      ]);
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      expect(mockRunMission).not.toHaveBeenCalled();
    });

    it('allows an exact authorized envelope and continues normally', async () => {
      mockGetMissionById.mockResolvedValue({ authorizedMaxCostUsd: 31 });

      await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ success: true });
      expect(mockRunMission).toHaveBeenCalledTimes(1);
    });

    // REPORT-015: the mission mints a DesignBrief and every server-side surface
    // reads it, but the model AUTHORING the report never received it, so it
    // invented a parallel design system. The prompt the orchestrator actually
    // runs must now carry the resolved palette.
    it('delivers the mission DesignBrief into the prompt the orchestrator runs', async () => {
      const { resolveDesignBrief } = await import('@/lib/schemas/design-brief');
      const designBrief = resolveDesignBrief('user-456');
      mockGetMissionById.mockResolvedValue({ id: 'mission-123', userId: 'user-456', designBrief });

      await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

      expect(mockRunMission).toHaveBeenCalledTimes(1);
      expect(mockOrchestratorConstruction).toHaveBeenCalledWith(expect.objectContaining({ roleAgent: 'creator' }));
      const composedPrompt = mockRunMission.mock.calls[0][0] as string;
      expect(composedPrompt).toContain('DESIGN BRIEF');
      expect(composedPrompt).toContain(designBrief.palette.accent);
      expect(composedPrompt).toContain(designBrief.palette.bg);
      expect(composedPrompt).toContain('/css/report-brand.css');
    });

    it('leaves the prompt untouched when the mission has no DesignBrief', async () => {
      mockGetMissionById.mockResolvedValue({ id: 'mission-123', userId: 'user-456' });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      const composedPrompt = mockRunMission.mock.calls[0][0] as string;
      expect(composedPrompt).not.toContain('DESIGN BRIEF');
    });

    it('does not inject the report DesignBrief into a research agent prompt', async () => {
      const { resolveDesignBrief } = await import('@/lib/schemas/design-brief');
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        designBrief: resolveDesignBrief('user-456'),
      });

      await getHandler()(buildEventContext({ agent: 'scout' }, { executeOrchestrator: true }));

      const composedPrompt = mockRunMission.mock.calls[0][0] as string;
      expect(composedPrompt).not.toContain('DESIGN BRIEF');
    });

    // Replay an evaluator disagreement through the worker: deterministic L1
    // refuses an unknown citation while L2 returns a perfect PASS.
    it('persists a canonical FAIL when the judge contradicts a deterministic refusal', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        qualityReport: {
          evaluatedAt: '2026-08-01T13:16:11.553Z',
          overallScore: 0.4615,
          verdict: 'FAIL',
          checks: [
            {
              name: 'creator-citations-resolve',
              pass: false,
              critical: true,
              detail: 'citation [11] does not map to any source in the research bundle',
            },
          ],
        },
        qualityJudgement: {
          evaluatedAt: '2026-08-01T13:18:02.001Z',
          judgeModel: 'gemini-2.5-flash',
          overallScore: 1,
          verdict: 'PASS',
          dimensions: [],
        },
      });

      await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

      const composedUpdate = mockUpdateMission.mock.calls.find(
        (call: [string, Record<string, unknown>]) => call[1] && 'qualityVerdict' in call[1]
      );
      expect(composedUpdate).toBeDefined();
      const verdict = composedUpdate![1].qualityVerdict as {
        verdict: string;
        ceiling: string;
        criticalFailures: string[];
        judge?: { verdict: string };
        disagreement?: { kind: string };
      };
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.ceiling).toBe('FAIL');
      expect(verdict.criticalFailures).toEqual(['creator-citations-resolve']);
      // The judge receipt is retained, not discarded, so the conflict is auditable.
      expect(verdict.judge?.verdict).toBe('PASS');
      expect(verdict.disagreement?.kind).toBe('judge-more-favourable');
    });

    it('writes no canonical verdict when neither evaluator produced one', async () => {
      mockGetMissionById.mockResolvedValue({ id: 'mission-123', userId: 'user-456' });

      await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

      const composedUpdate = mockUpdateMission.mock.calls.find(
        (call: [string, Record<string, unknown>]) => call[1] && 'qualityVerdict' in call[1]
      );
      expect(composedUpdate).toBeUndefined();
    });

    it('uses the memoized authorized envelope when replay skips the validation callback', async () => {
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 4,
        revisionMaxCostUsd: 3,
        preludeMaxCostUsd: 1,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 10,
      };

      await getHandler()(buildEventContext({}, { executeOrchestrator: true, memoizedCostEnvelope }));

      expect(mockOrchestratorConstruction).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 4 }));
    });

    it('reuses a memoized persisted envelope on replay including timeout, tool calls, and model', async () => {
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 4,
        revisionMaxCostUsd: 3,
        preludeMaxCostUsd: 1,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 10,
        maxToolCalls: 77,
        timeoutMinutes: 60,
        requestedModel: 'claude-opus-5',
        envelopeSource: 'mission',
      };

      await getHandler()(buildEventContext({}, { executeOrchestrator: true, memoizedCostEnvelope }));

      expect(mockOrchestratorConstruction).toHaveBeenCalledWith(
        expect.objectContaining({ maxBudgetUsd: 4, timeoutMs: 3_600_000, model: 'claude-opus-5' })
      );
      expect(mockCreateBudgetHooks).toHaveBeenCalledWith(expect.any(Number), 77);
    });

    describe('COORD-012 — persisted execution envelope', () => {
      const persistedEnvelope = {
        orchestratorMaxCostUsd: 13,
        revisionMaxCostUsd: 0.01,
        preludeMaxCostUsd: 2,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 17.01,
        maxToolCalls: 120,
        timeoutMinutes: 90,
        requestedModel: 'claude-opus-5',
      };

      it('runs every paid phase from the persisted envelope even when the worker environment disagrees', async () => {
        // The worker module resolved its own (default $31) envelope at process
        // start — the exact stale-environment shape that ran the failed paid
        // mission at $6.30. The persisted envelope must win outright.
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 17.01,
          executionEnvelope: persistedEnvelope,
        });

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        expect(mockOrchestratorConstruction).toHaveBeenCalledWith(
          expect.objectContaining({ maxBudgetUsd: 13, timeoutMs: 90 * 60_000, model: 'claude-opus-5' })
        );
        expect(mockCreateBudgetHooks).toHaveBeenCalledWith(expect.any(Number), 120);
      });

      it('lets the user-authorized envelope override profile timeout and tool-call narrowing', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 17.01,
          executionEnvelope: persistedEnvelope,
        });
        mockLoadAllProfiles.mockReturnValueOnce(
          new Map([
            [
              'creator',
              {
                budget: { max_tokens: 100_000, max_tool_calls: 50 },
                mcp_servers: { internal: [], external: [] },
                timeoutMinutes: 30,
              },
            ],
          ])
        );

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        expect(mockOrchestratorConstruction).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90 * 60_000 }));
        expect(mockCreateBudgetHooks).toHaveBeenCalledWith(expect.any(Number), 120);
      });

      it('persists the effective envelope before the orchestrator spends anything', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 17.01,
          executionEnvelope: persistedEnvelope,
        });

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        const effectiveCall = mockUpdateMission.mock.calls.find(
          (call: [string, Record<string, unknown>]) => call[1] && 'effectiveExecutionEnvelope' in call[1]
        );
        expect(effectiveCall).toBeDefined();
        expect(effectiveCall![1].effectiveExecutionEnvelope).toEqual(persistedEnvelope);
        const effectiveOrder =
          mockUpdateMission.mock.invocationCallOrder[mockUpdateMission.mock.calls.indexOf(effectiveCall!)];
        const orchestratorOrder = mockRunMission.mock.invocationCallOrder[0];
        expect(effectiveOrder).toBeLessThan(orchestratorOrder);
      });

      it('refuses a persisted envelope whose total disagrees with the authorized cap', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 15.3,
          executionEnvelope: persistedEnvelope,
        });

        await expect(getHandler()(buildEventContext({ agent: 'creator' }))).rejects.toThrow(
          /executionEnvelope totalMaxCostUsd \$17\.01 does not match the user-authorized \$15\.30/
        );
        expect(mockRunMission).not.toHaveBeenCalled();
        expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      });

      it('refuses an internally inconsistent persisted envelope before any paid phase', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 15.3,
          executionEnvelope: { ...persistedEnvelope, totalMaxCostUsd: 15.3 },
        });

        await expect(getHandler()(buildEventContext({ agent: 'creator' }))).rejects.toThrow(/components sum to/);
        expect(mockRunMission).not.toHaveBeenCalled();
        expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      });

      it('pins the envelope-authorized fallback model on the orchestrator', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 17.01,
          executionEnvelope: { ...persistedEnvelope, authorizedFallbackModel: 'claude-sonnet-5' },
        });

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        expect(mockOrchestratorConstruction).toHaveBeenCalledWith(
          expect.objectContaining({ authorizedFallbackModel: 'claude-sonnet-5' })
        );
      });

      it('disables the SDK fallback outright when the envelope authorized none', async () => {
        mockGetMissionById.mockResolvedValue({
          id: 'mission-123',
          userId: 'user-456',
          authorizedMaxCostUsd: 17.01,
          executionEnvelope: persistedEnvelope,
        });

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        expect(mockOrchestratorConstruction).toHaveBeenCalledWith(
          expect.objectContaining({ authorizedFallbackModel: null })
        );
      });

      it('keeps a legacy mission on the environment envelope without inventing a model pin', async () => {
        mockGetMissionById.mockResolvedValue({ id: 'mission-123', userId: 'user-456', authorizedMaxCostUsd: 31 });

        await getHandler()(buildEventContext({ agent: 'creator' }, { executeOrchestrator: true }));

        const options = mockOrchestratorConstruction.mock.calls.at(-1)?.[0] as {
          maxBudgetUsd?: number;
          model?: string;
        };
        expect(options.maxBudgetUsd).toBe(15);
        expect(options.model).toBeUndefined();
        // Legacy missions keep the historical env-then-default fallback chain:
        // the envelope authority option must be entirely absent, not null.
        expect('authorizedFallbackModel' in options).toBe(false);
        const effectiveCall = mockUpdateMission.mock.calls.find(
          (call: [string, Record<string, unknown>]) => call[1] && 'effectiveExecutionEnvelope' in call[1]
        );
        expect(effectiveCall).toBeUndefined();
      });
    });

    it('should invoke the execute-orchestrator step', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      // The orchestrator step is called (prompt is captured in closure from event.data)
      const stepCalls = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepCalls).toContain('execute-orchestrator');
      // mockRunMission is called by the step interceptor
      expect(mockRunMission).toHaveBeenCalled();
    });

    it('should create an AgentRun record', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-456',
          missionId: 'mission-123',
          agentName: 'scout',
          action: 'Mission: Analyze emerging AI trends',
          status: 'success',
          tokenUsage: { input: 1000, output: 500 },
          costUsd: 0.05,
        })
      );
    });

    it('should update mission with completed status and results', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      // The last call to updateMission should be the results update
      const calls = mockUpdateMission.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('mission-123');
      expect(lastCall[1]).toMatchObject({
        status: 'completed',
        progress: 100,
        progressMessage: 'Mission completed',
        result: 'Analysis complete: 5 trends identified',
        tokenUsage: { input: 1000, output: 500 },
        costUsd: 0.05,
      });
    });

    it('should include completedAt in final mission update', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const calls = mockUpdateMission.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].completedAt).toBeDefined();
      expect(() => new Date(lastCall[1].completedAt as string)).not.toThrow();
    });

    it('should return missionId and success true', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result).toMatchObject({
        missionId: 'mission-123',
        success: true,
      });
      expect(typeof result.duration).toBe('number');
    });

    it('should execute all steps in order', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepNames).toEqual([
        'capture-start-time', // ARUN-002: replay-safe start timestamp
        'authorize-mission-owner', // persisted owner gate before state, preferences, or spend
        'validate-authorized-cost-envelope', // exact Assistant-authorized paid envelope
        'mcp-preflight', // OPS-004: memoized internal-MCP reachability gate before any paid stage
        'update-status-running',
        'create-episode',
        'skill-activation-prelude', // Task 6: skill-activation prelude (P3 missions)
        'execute-orchestrator',
        'resolve-owner-scoped-report-truth', // compact owner-bound identity + load-bearing pointers
        'recover-partial-on-failure',
        'complete-episode', // compatibility marker; graph write is deferred
        'evaluate-quality',
        'revise-on-l1-fail', // Task 7: REVISE retry loop (cap=1) — flat, no nested step.run
        'evaluate-quality-llm',
        // REPORT-018: composed AFTER both evaluators have persisted, so it reads
        // their durable values and is deterministic on replay.
        'compose-canonical-quality-verdict',
        'resolve-terminal-outcome', // one memoized truth before reflection/graph/persistence
        // ARUN-014: reflection + episode finalization run BEFORE the duration
        // capture so the recorded execution duration spans them and matches
        // `completedAt` (the pre-ARUN-014 order froze duration before reflection,
        // so live elapsed overshot the persisted value). Both endpoints stay
        // memoized, so the duration is stable and accurate across a replay.
        'create-reflection',
        'finalize-episode', // canonical Episode terminal transition
        'capture-end-time', // ARUN-014: one terminal endpoint after reflection + finalize
        'write-agent-run',
        'record-mission-usage-receipts', // ARUN-022: durable per-model usage receipt + SDK settlement
        'update-mission-results',
        'advance-chain',
        'emit-scout-observations', // SDM Task 4: scout bundle → observations
        // OBS-004: a sweep-dispatched child reports its terminal outcome, cost,
        // elapsed time and durable outputs back to its sweep. It runs LAST — after
        // the canonical Mission and AgentRun are persisted — so the settlement can
        // only ever report an outcome that is already durable.
        'settle-sweep-child-accounting',
      ]);
    });

    it('persists and emits the exact nontrivial execution duration (ARUN-002)', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result.duration).toBe(60_000);
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ duration: 60_000 }));
      expect(mockEmitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent.completed',
          missionId: 'mission-123',
          data: expect.objectContaining({ duration: 60_000 }),
        })
      );
    });

    it('reuses the same timestamp step results across a full handler replay', async () => {
      const cache = new Map<string, unknown>();
      const captureCallbacks = { start: 0, end: 0 };
      let interruptAfterEndCapture = true;
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(CAPTURED_END_MS + 2);
      const replayableStep = {
        run: jest.fn(async (name: string, fn: AnyFunction) => {
          if (cache.has(name)) return cache.get(name);

          let value: unknown;
          if (name === 'capture-start-time') {
            captureCallbacks.start++;
            dateNowSpy.mockReturnValueOnce(CAPTURED_START_MS);
            value = await fn();
          } else if (name === 'capture-end-time') {
            captureCallbacks.end++;
            dateNowSpy.mockReturnValueOnce(CAPTURED_END_MS);
            value = await fn();
          } else if (name === 'execute-orchestrator') {
            value = await mockRunMission();
          } else {
            value = await fn();
          }
          cache.set(name, value);
          if (name === 'capture-end-time' && interruptAfterEndCapture) {
            interruptAfterEndCapture = false;
            throw new Error('simulated replay after terminal timestamp capture');
          }
          return value;
        }),
        sleep: jest.fn().mockResolvedValue(undefined),
        sendEvent: jest.fn().mockResolvedValue(undefined),
      };
      const firstContext = buildEventContext();
      const replayContext = { ...firstContext, step: replayableStep };

      try {
        await expect(getHandler()(replayContext)).rejects.toThrow('simulated replay after terminal timestamp capture');
        const replay = await getHandler()(replayContext);

        expect(replay.duration).toBe(60_000);
        expect(captureCallbacks).toEqual({ start: 1, end: 1 });
        expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
        expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ duration: 60_000 }));

        const completionEvents = mockEmitAgentEvent.mock.calls
          .map(([event]) => event as { type?: string; data?: { duration?: number } })
          .filter((event) => event.type === 'agent.completed');
        expect(completionEvents).toHaveLength(1);
        expect(completionEvents[0].data?.duration).toBe(60_000);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  describe('failed mission execution (orchestrator returns success=false)', () => {
    const failedResult = {
      success: false,
      result: null,
      costUsd: 0.02,
      tokenUsage: { input: 500, output: 100 },
      errors: ['Agent timeout after 30s'],
    };

    beforeEach(() => {
      mockRunMission.mockResolvedValue(failedResult);
    });

    it('should create AgentRun with failure status', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          errors: ['Agent timeout after 30s'],
        })
      );
    });

    it('should update mission with failed status', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const calls = mockUpdateMission.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toMatchObject({
        status: 'failed',
        progress: 100,
        progressMessage: 'Mission failed',
        errors: ['Agent timeout after 30s'],
      });
    });

    it('should return success false', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result).toMatchObject({
        missionId: 'mission-123',
        success: false,
      });
    });

    it('persists and emits the same exact duration for a returned failure', async () => {
      const result = await getHandler()(buildEventContext());

      expect(result.duration).toBe(60_000);
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failure', duration: 60_000 }));
      expect(mockEmitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent.error',
          data: expect.objectContaining({ duration: 60_000 }),
        })
      );
    });

    it('preserves the orchestrator-reported costUsd on the agent-run row (H1)', async () => {
      // Mission failed at the orchestrator level (returned success=false).
      // The agent-run record must surface the partial spend, not zero.
      const ctx = buildEventContext();
      await getHandler()(ctx);
      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          // failedResult.costUsd = 0.02; no prelude in scout path (no
          // CRITICAL DIMENSIONS) → totalMissionCost = 0.02
          costUsd: 0.02,
        })
      );
    });

    it('preserves the orchestrator-reported costUsd on the mission doc (H1)', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);
      const finalUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).status === 'failed'
      );
      expect(finalUpdate).toBeTruthy();
      expect((finalUpdate![1] as { costUsd?: number }).costUsd).toBeCloseTo(0.02, 6);
    });
  });

  describe('wall-clock timeout duration', () => {
    it('persists a partial timeout with the same terminal duration and clears its timers', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(CAPTURED_START_MS));
      const partialResult = 'Recovered checkpoint content. '.repeat(8);
      mockLoadAllProfiles.mockReturnValue(
        new Map([
          [
            'scout',
            {
              budget: { max_tokens: 20_000, max_tool_calls: 30 },
              mcp_servers: { internal: [], external: [] },
              timeoutMinutes: 1,
            },
          ],
        ])
      );
      mockGetMissionById.mockResolvedValue({ partialResult, partialCheckpointTurn: 4 });
      mockGetAccumulatedPartial.mockReturnValue({ partialResult, turn: 4 });
      mockGetUsageSnapshot.mockReturnValue({
        costUsd: 0.42,
        tokenUsage: { input: 12_000, output: 3_000 },
      });

      let signalStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      mockRunMission.mockImplementation(() => {
        signalStarted();
        return new Promise(() => undefined);
      });

      try {
        const pending = getHandler()(buildEventContext({}, { executeOrchestrator: true }));
        await runStarted;
        await jest.advanceTimersByTimeAsync(60_000);
        const result = await pending;

        expect(result).toMatchObject({ missionId: 'mission-123', success: false, duration: 60_000 });
        expect(mockAbortMission).toHaveBeenCalledWith('wall-clock timeout / mission error');
        expect(mockCreateAgentRun).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failure',
            duration: 60_000,
            partial: true,
            partialCheckpointTurn: 4,
            costUsd: 0.42,
            tokenUsage: { input: 12_000, output: 3_000 },
            errors: ['Mission timed out after 1 minute'],
          })
        );
        expect(mockEmitAgentEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'agent.error',
            data: expect.objectContaining({ duration: 60_000 }),
          })
        );
        expect(mockUpdateMission).toHaveBeenCalledWith(
          'mission-123',
          expect.objectContaining({
            status: 'failed',
            progressMessage: 'Mission timed out — partial output recovered',
          })
        );
        const terminalUpdate = mockUpdateMission.mock.calls.find(
          (call) => (call[1] as Record<string, unknown>).status === 'failed'
        );
        const canonicalPartial = String((terminalUpdate?.[1] as { result?: string } | undefined)?.result ?? '');
        expect(canonicalPartial).toContain(partialResult);
        expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
          ...EPISODE_FINALIZATION_IDENTITY,
          status: 'failed',
          summary: canonicalPartial.slice(0, 500),
          legacySummary: 'Analyze emerging AI trends',
          // GRAPH-030: the coarse Episode status mirrors the Mission (`failed`),
          // while `missionOutcome` records that real output was recovered. The
          // Episode enum alone cannot express that, which is why parity needs
          // both fields rather than one.
          missionOutcome: 'partial',
        });
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('prompt truncation', () => {
    it('should truncate long prompts to 100 chars in AgentRun action', async () => {
      const longPrompt = 'A'.repeat(200);
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
        errors: undefined,
      });

      const ctx = buildEventContext({ prompt: longPrompt });
      await getHandler()(ctx);

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          action: `Mission: ${'A'.repeat(100)}`,
        })
      );
    });
  });

  describe('hooks and permission mode', () => {
    // NOTE: The execute-orchestrator step is intercepted at the step.run level
    // because the real code does a pathToFileURL dynamic import that Jest
    // cannot resolve. Hook forwarding to the Orchestrator constructor is
    // verified in agent/tests/orchestrator.test.ts instead.

    it('should invoke execute-orchestrator step (hooks wiring happens inside)', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });

      const ctx = buildEventContext();
      await getHandler()(ctx);

      const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(stepNames).toContain('execute-orchestrator');
    });

    it('passes stricter active-profile limits to the budget hooks', async () => {
      mockLoadAllProfiles.mockReturnValue(
        new Map([
          [
            'scout',
            {
              budget: { max_tokens: 20_000, max_tool_calls: 30 },
              mcp_servers: { internal: [], external: [] },
            },
          ],
        ])
      );
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      expect(mockCreateBudgetHooks).toHaveBeenCalledWith(20_000, 30);
    });

    it('delegates the capability boundary to the Orchestrator instead of building a competing map', async () => {
      mockLoadAllProfiles.mockReturnValue(
        new Map([
          [
            'scout',
            {
              budget: { max_tokens: 20_000, max_tool_calls: 30 },
              mcp_servers: { internal: [], external: ['custom-reader'] },
            },
          ],
        ])
      );
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      // SEC-014: the worker no longer assembles a capability map of its own.
      //
      // It used to build `agentPermissions` here and hand it to
      // `createPermissionsHooks`. That arrangement let the transport and the
      // boundary disagree — the parent turn was never checked, non-MCP built-ins
      // were unconditional, and a profile-load failure fell OPEN. The
      // Orchestrator now derives the policy from the same agent definitions and
      // MCP configs it hands the SDK, and installs the enforcing hook itself, so
      // a worker omission cannot disable the boundary.
      //
      // The bounded-graph guarantee this test was written for is asserted at its
      // new home in `agent/tests/orchestrator.test.ts`
      // ("derives the subagent server lists from the same definitions the SDK
      // receives") and in `agent/tests/capability-policy.test.ts`.
      expect(mockCreatePermissionsHooks).not.toHaveBeenCalled();

      // What the worker still owes the Orchestrator is the profiles directory —
      // without it the policy cannot be derived at all.
      const options = mockOrchestratorConstruction.mock.calls[0]?.[0] as { agentsDir?: string };
      expect(typeof options.agentsDir).toBe('string');
      expect(options.agentsDir).toBeTruthy();
    });

    it('falls back to validated global limits when profiles cannot be loaded', async () => {
      mockLoadAllProfiles.mockImplementationOnce(() => {
        throw new Error('profile load failed');
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      expect(mockCreateBudgetHooks).toHaveBeenCalledWith(50_000, 100);
    });
  });

  describe('episode lifecycle', () => {
    beforeEach(() => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'Analysis complete',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });
    });

    it('should create an Episode at mission start', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockCreateEpisode).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'scout',
          missionId: 'mission-123',
          userId: 'user-456',
        })
      );
    });

    it('finalizes a successful Episode from the canonical result after the compatibility marker', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockCompleteEpisode).not.toHaveBeenCalled();
      expect(mockFailEpisode).not.toHaveBeenCalled();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        status: 'completed',
        summary: 'Analysis complete',
        legacySummary: 'Analysis complete',
        missionOutcome: 'success',
      });

      const steps = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      expect(steps.indexOf('complete-episode')).toBeLessThan(steps.indexOf('evaluate-quality'));
      expect(steps.indexOf('revise-on-l1-fail')).toBeLessThan(steps.indexOf('finalize-episode'));
      expect(steps.indexOf('create-reflection')).toBeLessThan(steps.indexOf('finalize-episode'));
      expect(steps.indexOf('finalize-episode')).toBeLessThan(steps.indexOf('write-agent-run'));
      expect(steps.indexOf('finalize-episode')).toBeLessThan(steps.indexOf('update-mission-results'));
    });

    it('finalizes an in-flight old run whose premature complete-episode step is already memoized', async () => {
      const ctx = buildEventContext();
      const innerRun = ctx.step.run.getMockImplementation()!;
      ctx.step.run.mockImplementation(async (name: string, fn: AnyFunction) => {
        if (name === 'complete-episode') return undefined; // old graph write already memoized
        return innerRun(name, fn);
      });

      await getHandler()(ctx);

      expect(mockCompleteEpisode).not.toHaveBeenCalled();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledTimes(1);
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        status: 'completed',
        summary: 'Analysis complete',
        legacySummary: 'Analysis complete',
        missionOutcome: 'success',
      });
    });

    it('finalizes a returned failure with the exact empty mission-result slice', async () => {
      mockRunMission.mockResolvedValue({
        success: false,
        result: null,
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
        errors: ['timeout'],
      });

      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        status: 'failed',
        summary: '',
        legacySummary: 'Analyze emerging AI trends',
        missionOutcome: 'failed',
      });
      const finalizationOrder = mockFinalizeMissionEpisode.mock.invocationCallOrder[0];
      expect(finalizationOrder).toBeLessThan(mockCreateAgentRun.mock.invocationCallOrder[0]);
      const terminalUpdateIndex = mockUpdateMission.mock.calls.findIndex(
        (call) => (call[1] as Record<string, unknown>).status === 'failed'
      );
      expect(finalizationOrder).toBeLessThan(mockUpdateMission.mock.invocationCallOrder[terminalUpdateIndex]);
    });

    it('should not block mission if Episode creation fails', async () => {
      mockCreateEpisode.mockRejectedValueOnce(new Error('Neo4j unavailable'));

      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      // Mission should still succeed even if Neo4j is down
      expect(result.success).toBe(true);
      // No terminal operation runs because episodeId is undefined.
      expect(mockFinalizeMissionEpisode).not.toHaveBeenCalled();
    });

    it('does not block mission persistence when canonical Episode finalization fails', async () => {
      mockFinalizeMissionEpisode.mockRejectedValueOnce(new Error('Neo4j unavailable'));

      const result = await getHandler()(buildEventContext());

      expect(result).toMatchObject({ success: true });
      expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-123',
        expect.objectContaining({ status: 'completed', result: 'Analysis complete' })
      );
    });

    it('should truncate prompt summary to 200 chars', async () => {
      const longPrompt = 'B'.repeat(300);
      const ctx = buildEventContext({ prompt: longPrompt });
      await getHandler()(ctx);

      const summaryArg = mockCreateEpisode.mock.calls[0][0].summary;
      expect(summaryArg.length).toBe(200);
    });
  });

  describe('OPS-004 MCP preflight (worker fail-fast before any paid stage)', () => {
    beforeEach(() => {
      mockPreflightMissionMcp.mockResolvedValue({
        ok: false,
        reason: 'mcp-preflight-failed',
        baseUrl: 'http://127.0.0.1:9002/api/mcp',
        checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
        unreachable: ['reports'],
      });
    });

    it('throws mcp-preflight-failed and runs ZERO paid provider stages', async () => {
      const ctx = buildEventContext();

      await expect(getHandler()(ctx)).rejects.toThrow(/mcp-preflight-failed/);

      // Not one paid provider stage may run: skill prelude, orchestrator SDK,
      // LLM/quality judge, and revision orchestrator must all be untouched.
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      expect(mockRunMission).not.toHaveBeenCalled();
      expect(mockEvaluateMissionQuality).not.toHaveBeenCalled();
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      // No AgentRun history row is written from the (aborted) main path — the
      // honest fallback row is onFailure's responsibility (asserted below).
      expect(mockCreateAgentRun).not.toHaveBeenCalled();
    });

    it('short-circuits every later paid stage when the Orchestrator returns a typed mcp-preflight failure', async () => {
      // Realistic asymmetric/stale case: the worker's memoized step preflight
      // passed (healthy here), but the Orchestrator's own broader, key-checked
      // preflight failed at run start and RETURNED an ordinary failed result
      // tagged with failureKind. The worker must NOT continue into L1 /
      // fact-check / judge / revision / reflection.
      mockPreflightMissionMcp.mockResolvedValue({
        ok: true,
        baseUrl: 'http://127.0.0.1:9002/api/mcp',
        checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
        unreachable: [],
        reason: undefined,
      });
      mockRunMission.mockResolvedValue({
        success: false,
        failureKind: 'mcp-preflight-failed',
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        errors: ['mcp-preflight-failed: internal platform MCP unreachable at http://127.0.0.1:9002/api/mcp (reports).'],
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow(/mcp-preflight-failed/);

      // The orchestrator ran (its own preflight is inside runMission), but no
      // LATER paid provider stage may run.
      expect(mockEvaluateMissionQuality).not.toHaveBeenCalled();
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockCreateAgentRun).not.toHaveBeenCalled();
      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-123',
        expect.objectContaining({ costUsd: 0, tokenUsage: { input: 0, output: 0 } })
      );
    });

    it('onFailure persists a truthful failed Mission + honest zero/unavailable-usage AgentRun', async () => {
      const error = new Error(
        'mcp-preflight-failed: internal platform MCP server(s) unreachable at http://127.0.0.1:9002/api/mcp (reports).'
      );
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error,
        event: {
          data: { event: { data: { missionId: 'mission-preflight-1', userId: 'user-456', agent: 'creator' } } },
        },
      });

      // Truthful Mission failure with the machine-readable reason + structured
      // failure code preserved.
      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-preflight-1',
        expect.objectContaining({ status: 'failed', errors: [error.message], failureCode: 'mcp-preflight-failed' })
      );
      // Honest fallback AgentRun: no cost recorded (getMissionById → null in
      // this suite), so tracked usage is explicitly unavailable, not fabricated.
      expect(mockRecordMissionFailureFallback).toHaveBeenCalledTimes(1);
      const fallbackArg = mockRecordMissionFailureFallback.mock.calls[0][0] as {
        costUsd?: number;
        tokenUsage?: unknown;
        errorMessage: string;
      };
      expect(fallbackArg.costUsd).toBeUndefined();
      expect(fallbackArg.tokenUsage).toBeUndefined();
      expect(fallbackArg.errorMessage).toMatch(/mcp-preflight-failed/);
    });

    it('onFailure folds the KNOWN classifier spend into the fallback receipt (not a false $0)', async () => {
      // A preflight abort produces no orchestrator cost, but the classifier
      // already billed at dispatch. That known spend must survive into the
      // fallback receipt as a precise cost.
      mockGetMissionById.mockResolvedValue({
        agent: 'creator',
        // no mission.costUsd (orchestrator never ran)
        classifierMetadata: { costUsd: 0.0021 },
      });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('mcp-preflight-failed: reports unreachable'),
        event: { data: { event: { data: { missionId: 'mission-fold-1', userId: 'user-456', agent: 'creator' } } } },
      });

      const fallbackArg = mockRecordMissionFailureFallback.mock.calls[0][0] as {
        costUsd?: number;
        costUnavailableReason?: string;
      };
      expect(fallbackArg.costUsd).toBeCloseTo(0.0021, 6);
      expect(fallbackArg.costUnavailableReason).toBeUndefined();
    });

    it('onFailure preserves unknown-pricing when the sole classifier component is unpriced', async () => {
      // Single present component (classifier), unpriced → the receipt's cost is
      // genuinely unknown-pricing, not the mixed accounting-incomplete.
      mockGetMissionById.mockResolvedValue({
        agent: 'creator',
        classifierMetadata: { costUnavailableReason: 'unknown-pricing' },
      });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('mcp-preflight-failed: reports unreachable'),
        event: { data: { event: { data: { missionId: 'mission-fold-2', userId: 'user-456', agent: 'creator' } } } },
      });

      const fallbackArg = mockRecordMissionFailureFallback.mock.calls[0][0] as {
        costUsd?: number;
        costUnavailableReason?: string;
      };
      expect(fallbackArg.costUsd).toBeUndefined();
      expect(fallbackArg.costUnavailableReason).toBe('unknown-pricing');
    });

    it('onFailure folds prelude + classifier spend into a precise summed receipt', async () => {
      mockGetMissionById.mockResolvedValue({
        agent: 'creator',
        classifierMetadata: { costUsd: 0.002 },
        preludeAccounting: { cost: { totalUsd: 0.5 } },
      });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('mcp-preflight-failed: reports unreachable'),
        event: {
          data: { event: { data: { missionId: 'mission-fold-prelude', userId: 'user-456', agent: 'creator' } } },
        },
      });

      const fallbackArg = mockRecordMissionFailureFallback.mock.calls[0][0] as {
        costUsd?: number;
        costUnavailableReason?: string;
      };
      // 0.002 classifier + 0.5 prelude = 0.502, all priced → precise.
      expect(fallbackArg.costUsd).toBeCloseTo(0.502, 6);
      expect(fallbackArg.costUnavailableReason).toBeUndefined();
    });

    it('onFailure marks accounting-incomplete for a mix of priced orchestrator + unpriced classifier', async () => {
      mockGetMissionById.mockResolvedValue({
        agent: 'creator',
        costUsd: 1.25,
        classifierMetadata: { costUnavailableReason: 'unknown-pricing' },
      });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('later-stage failure'),
        event: { data: { event: { data: { missionId: 'mission-fold-3', userId: 'user-456', agent: 'creator' } } } },
      });

      const fallbackArg = mockRecordMissionFailureFallback.mock.calls[0][0] as {
        costUsd?: number;
        costUnavailableReason?: string;
      };
      expect(fallbackArg.costUsd).toBeUndefined();
      expect(fallbackArg.costUnavailableReason).toBe('accounting-incomplete');
    });
  });

  describe('onFailure handler', () => {
    // Inngest onFailure wraps the original event under event.data.event
    function buildFailureEvent(missionId: string, userId = 'user-456') {
      return {
        data: {
          event: {
            data: { missionId, userId },
          },
        },
      };
    }

    it('should update mission to failed status', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;
      await onFailure({
        error: new Error('Orchestrator crashed'),
        event: buildFailureEvent('mission-fail-1'),
      });

      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-fail-1',
        expect.objectContaining({
          status: 'failed',
          errors: ['Orchestrator crashed'],
        })
      );
    });

    it('should handle string errors', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;
      await onFailure({
        error: 'Something went wrong',
        event: buildFailureEvent('mission-fail-2'),
      });

      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-fail-2',
        expect.objectContaining({
          status: 'failed',
          errors: ['Something went wrong'],
        })
      );
    });

    it('does not mutate or emit for a failed event whose principal mismatches the persisted owner', async () => {
      mockGetMissionById.mockResolvedValue({ id: 'mission-owned', userId: 'stored-owner' });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('Mission mission-owned owner does not match the dispatched user; execution was refused'),
        event: {
          data: {
            event: { data: { missionId: 'mission-owned', userId: 'untrusted-event-user', agent: 'creator' } },
          },
        },
      });

      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockRecordMissionFailureFallback).not.toHaveBeenCalled();
      expect(mockEmitAgentEvent).not.toHaveBeenCalled();
      expect(mockFindNextChainStep).not.toHaveBeenCalled();
    });

    it('does not mutate or emit when failure recovery has no original-event principal', async () => {
      mockGetMissionById.mockResolvedValue({ id: 'mission-owned', userId: 'stored-owner' });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('queued event omitted its principal'),
        event: { data: { event: { data: { missionId: 'mission-owned', agent: 'creator' } } } },
      });

      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockRecordMissionFailureFallback).not.toHaveBeenCalled();
      expect(mockEmitAgentEvent).not.toHaveBeenCalled();
      expect(mockFindNextChainStep).not.toHaveBeenCalled();
    });

    it('requests AgentRun failure reconciliation when the terminal Mission write fails after the run row landed', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'A completed exploratory result with enough body to finish normally before persistence fails.',
        costUsd: 0.05,
        tokenUsage: { input: 100, output: 50 },
      });
      mockUpdateMission.mockImplementation(async (_id: string, update: Record<string, unknown>) => {
        if (update.progress === 100) throw new Error('terminal Mission write unavailable');
      });

      await expect(getHandler()(buildEventContext({ prompt: 'plain' }))).rejects.toThrow(
        'terminal Mission write unavailable'
      );
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));

      mockUpdateMission.mockResolvedValue(undefined);
      const onFailure = getConfig().onFailure as AnyFunction;
      await onFailure({
        error: new Error('terminal Mission write unavailable'),
        event: {
          data: { event: { data: { missionId: 'mission-123', userId: 'user-456', agent: 'scout' } } },
        },
      });

      expect(mockRecordMissionFailureFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: 'mission-123',
          userId: 'user-456',
          errorMessage: 'terminal Mission write unavailable',
        })
      );
    });

    it('should not throw if updateMission fails in onFailure', async () => {
      mockUpdateMission.mockRejectedValueOnce(new Error('Firestore down'));
      const onFailure = getConfig().onFailure as AnyFunction;

      // Should not throw - error is caught and logged
      await expect(
        onFailure({
          error: new Error('Original error'),
          event: buildFailureEvent('mission-fail-3'),
        })
      ).resolves.toBeUndefined();
    });

    it('should set completedAt timestamp on failure', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;
      await onFailure({
        error: new Error('timeout'),
        event: buildFailureEvent('mission-fail-4'),
      });

      const updateCall = mockUpdateMission.mock.calls[0];
      expect(updateCall[1].completedAt).toBeDefined();
      // Should be a valid ISO string
      expect(() => new Date(updateCall[1].completedAt as string)).not.toThrow();
    });

    it('should gracefully handle missing missionId', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;
      // Simulate edge case where event structure is unexpected
      await onFailure({
        error: new Error('crash'),
        event: { data: {} },
      });

      // Should NOT call updateMission when missionId is empty
      expect(mockUpdateMission).not.toHaveBeenCalled();
    });

    it('does not fabricate a duration row for an infrastructure-level failure', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;
      await onFailure({
        error: new Error('AgentRun persistence unavailable'),
        event: buildFailureEvent('mission-infra-fail'),
      });

      expect(mockUpdateMission).toHaveBeenCalledWith(
        'mission-infra-fail',
        expect.objectContaining({ status: 'failed', completedAt: expect.any(String) })
      );
      expect(mockCreateAgentRun).not.toHaveBeenCalled();
    });

    it('does not settle a partial numeric snapshot when nested cost is unavailable', async () => {
      mockGetMissionById.mockResolvedValue({
        agent: 'creator',
        costUsd: 1.25,
        costUnavailableReason: 'unknown-pricing',
        tokenUsage: { input: 100, output: 20 },
      });
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: new Error('post-quality persistence failed'),
        event: buildFailureEvent('mission-unpriced-fail'),
      });

      expect(mockRecordMissionFailureFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: 'mission-unpriced-fail',
          costUsd: undefined,
          costUnavailableReason: 'unknown-pricing',
        })
      );
    });
  });

  describe('run-agent-mission observation emission (scout)', () => {
    it('fires app/entity.observation.recorded for each source × subject entity after a scout completion', async () => {
      // Setup: a scout mission with one subject entity and a result containing 3 sources
      const bundle = {
        queries: ['q1', 'q2', 'q3'],
        sources: [
          {
            id: 1,
            title: 'Source 1',
            url: 'https://example.com/1',
            fetched_via: 'exa',
            tool_call_id: 'call-1',
            admiralty: 'A1',
            date_accessed: '2026-04-26',
          },
          {
            id: 2,
            title: 'Source 2',
            url: 'https://example.com/2',
            fetched_via: 'exa',
            tool_call_id: 'call-2',
            admiralty: 'B2',
            date_accessed: '2026-04-26',
          },
          {
            id: 3,
            title: 'Source 3',
            url: 'https://example.com/3',
            fetched_via: 'firecrawl',
            tool_call_id: 'call-3',
            admiralty: 'A2',
            date_accessed: '2026-04-26',
          },
        ],
        findings: ['Finding 1 [1]'],
        unresolved: [],
      };

      // Step 3 captures these entity IDs before finalization clears the
      // transient mission.entities list; the later emit step uses the memoized
      // capture rather than re-reading the cleared mission.
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        agent: 'scout',
        entities: [{ id: 'tech-1', name: 'Test Technology', type: 'technology', confidence: 0.9, agentName: 'scout' }],
        status: 'completed',
        userId: 'user-456',
        prompt: 'Analyze AI trends',
        progress: 100,
        sources: [],
        createdAt: new Date().toISOString(),
      });

      // parseScoutBundle returns the bundle with 3 sources
      mockParseScoutBundle.mockReturnValue({ ok: true, bundle });

      // Orchestrator succeeds
      mockRunMission.mockResolvedValue({
        success: true,
        result: '```json\n{"queries":["q1","q2","q3"],"sources":[],"findings":["f1"],"unresolved":[]}\n```',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });

      const ctx = buildEventContext({ agent: 'scout' });
      await getHandler()(ctx);

      // Retrieve the inngest mock to check send calls
      const { inngest: inngestMock } = require('../../client');
      const sendCalls = (inngestMock.send as jest.Mock).mock.calls;

      // Filter to observation events only (there may be chain-related sends)
      const observationSends = sendCalls.filter(
        (call: [{ name: string; data: Record<string, unknown> }]) => call[0].name === 'app/entity.observation.recorded'
      );

      // Expect exactly 3 observation events (1 entity × 3 sources)
      expect(observationSends).toHaveLength(3);

      // Each observation should have the correct shape
      for (const [payload] of observationSends) {
        expect(payload).toMatchObject({
          id: expect.stringMatching(/^obs-mission-v1-[a-f0-9]{64}$/),
          name: 'app/entity.observation.recorded',
          data: expect.objectContaining({
            observationId: expect.stringMatching(/^obs-mission-v1-[a-f0-9]{64}$/),
            entityId: 'tech-1',
            verdict: 'confirming',
            agentType: 'scout',
            missionId: 'mission-123',
            observedAt: expect.any(String),
          }),
        });
        expect(payload.data.observationId).toBe(payload.id);
      }

      // Source URLs should cover all 3 sources
      const sourceUrls = observationSends.map(([payload]: [{ data: { sourceUrl: string } }]) => payload.data.sourceUrl);
      expect(sourceUrls).toContain('https://example.com/1');
      expect(sourceUrls).toContain('https://example.com/2');
      expect(sourceUrls).toContain('https://example.com/3');
    });

    it('derives the verdict from each source Admiralty grade instead of hard-coding confirming (M13)', async () => {
      const bundle = {
        queries: ['q1', 'q2', 'q3'],
        sources: [
          {
            id: 1,
            title: 'Reliable confirmation',
            url: 'https://example.com/confirming',
            fetched_via: 'exa',
            tool_call_id: 'call-1',
            admiralty: 'A1',
            date_accessed: '2026-07-02',
          },
          {
            id: 2,
            title: 'Contradicted claim',
            url: 'https://example.com/contradicting',
            fetched_via: 'exa',
            tool_call_id: 'call-2',
            admiralty: 'B5',
            date_accessed: '2026-07-02',
          },
          {
            id: 3,
            title: 'Truth cannot be judged',
            url: 'https://example.com/inconclusive',
            fetched_via: 'firecrawl',
            tool_call_id: 'call-3',
            admiralty: 'C6',
            date_accessed: '2026-07-02',
          },
        ],
        findings: ['Finding 1 [1]'],
        unresolved: [],
      };

      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        agent: 'scout',
        entities: [{ id: 'tech-1', name: 'Test Technology', type: 'technology', confidence: 0.9, agentName: 'scout' }],
        status: 'completed',
        userId: 'user-456',
        prompt: 'Analyze AI trends',
        progress: 100,
        sources: [],
        createdAt: new Date().toISOString(),
      });
      mockParseScoutBundle.mockReturnValue({ ok: true, bundle });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'report',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });

      const ctx = buildEventContext({ agent: 'scout' });
      await getHandler()(ctx);

      const { inngest: inngestMock } = require('../../client');
      const observationSends = (inngestMock.send as jest.Mock).mock.calls.filter(
        (call: [{ name: string }]) => call[0].name === 'app/entity.observation.recorded'
      );
      expect(observationSends).toHaveLength(3);

      const verdictByUrl = new Map<string, string>(
        observationSends.map(([payload]: [{ data: { sourceUrl: string; verdict: string } }]) => [
          payload.data.sourceUrl,
          payload.data.verdict,
        ])
      );
      expect(verdictByUrl.get('https://example.com/confirming')).toBe('confirming');
      expect(verdictByUrl.get('https://example.com/contradicting')).toBe('contradicting');
      expect(verdictByUrl.get('https://example.com/inconclusive')).toBe('inconclusive');
    });

    it('replays byte-identical observation events when the outer step acknowledgement is lost', async () => {
      const sourceUrl = 'https://example.com/ambiguous-step';
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        agent: 'scout',
        entities: [{ id: 'tech-1', name: 'Tech', type: 'technology', confidence: 0.9, agentName: 'scout' }],
        status: 'completed',
        userId: 'user-456',
        prompt: 'Analyze trends',
        progress: 100,
        sources: [],
        createdAt: new Date().toISOString(),
      });
      mockParseScoutBundle.mockReturnValue({
        ok: true,
        bundle: {
          queries: ['q1', 'q2', 'q3'],
          sources: [
            {
              id: 1,
              title: 'Source',
              url: sourceUrl,
              fetched_via: 'exa',
              tool_call_id: 'call-1',
              admiralty: 'A1',
              date_accessed: '2026-07-13',
            },
          ],
          findings: ['Finding [1]'],
          unresolved: [],
        },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'report',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });

      const delivered = new Map<string, Record<string, unknown>>();
      const attempts: Record<string, unknown>[] = [];
      const { inngest: inngestMock } = require('../../client');
      (inngestMock.send as jest.Mock).mockImplementation(async (event: Record<string, unknown>) => {
        attempts.push(event);
        delivered.set(String(event.id), event);
      });
      const harness = buildObservationStepAcknowledgementLossHarness();
      const context = {
        event: {
          data: {
            missionId: 'mission-123',
            userId: 'user-456',
            prompt: 'Analyze emerging AI trends',
            agent: 'scout',
          },
        },
        step: harness.step,
      };

      await expect(getHandler()(context)).rejects.toThrow('acknowledgement lost after sends committed');
      await expect(getHandler()(context)).resolves.toMatchObject({ missionId: 'mission-123', success: true });

      const observationAttempts = attempts.filter((event) => event.name === 'app/entity.observation.recorded');
      expect(observationAttempts).toHaveLength(2);
      expect(observationAttempts[1]).toEqual(observationAttempts[0]);
      expect(delivered.size).toBe(1);
      expect(harness.executions.get('emit-scout-observations')).toBe(2);
      expect(harness.executions.get('execute-orchestrator')).toBe(1);
      expect(harness.executions.get('write-agent-run')).toBe(1);
      expect(harness.executions.get('complete-episode')).toBe(1);
    });

    it('collapses exact duplicate URLs and omits conflicting duplicate verdicts', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        agent: 'scout',
        entities: [{ id: 'tech-1', name: 'Tech', type: 'technology', confidence: 0.9, agentName: 'scout' }],
        status: 'completed',
        userId: 'user-456',
        prompt: 'Analyze trends',
        progress: 100,
        sources: [],
        createdAt: new Date().toISOString(),
      });
      mockParseScoutBundle.mockReturnValue({
        ok: true,
        bundle: {
          queries: ['q1', 'q2', 'q3'],
          sources: [
            {
              id: 1,
              title: 'Exact duplicate A',
              url: 'https://example.com/exact',
              fetched_via: 'exa',
              tool_call_id: 'call-1',
              admiralty: 'A1',
              date_accessed: '2026-07-13',
            },
            {
              id: 2,
              title: 'Exact duplicate B',
              url: 'https://example.com/exact',
              fetched_via: 'exa',
              tool_call_id: 'call-2',
              admiralty: 'A1',
              date_accessed: '2026-07-13',
            },
            {
              id: 3,
              title: 'Conflict A',
              url: 'https://example.com/conflict',
              fetched_via: 'exa',
              tool_call_id: 'call-3',
              admiralty: 'A1',
              date_accessed: '2026-07-13',
            },
            {
              id: 4,
              title: 'Conflict B',
              url: 'https://example.com/conflict',
              fetched_via: 'exa',
              tool_call_id: 'call-4',
              admiralty: 'B5',
              date_accessed: '2026-07-13',
            },
          ],
          findings: ['Finding [1]'],
          unresolved: [],
        },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'report',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });

      await getHandler()(buildEventContext({ agent: 'scout' }));

      const { inngest: inngestMock } = require('../../client');
      const observationSends = (inngestMock.send as jest.Mock).mock.calls
        .map(([event]: [Record<string, unknown>]) => event)
        .filter((event: Record<string, unknown>) => event.name === 'app/entity.observation.recorded');
      expect(observationSends).toHaveLength(1);
      expect(observationSends[0]).toMatchObject({
        data: { sourceUrl: 'https://example.com/exact', verdict: 'confirming' },
      });
    });

    it('does not emit observations when agent is not scout', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'Report: AI trends analysis.',
        costUsd: 0.03,
        tokenUsage: { input: 500, output: 300 },
      });

      // Run with a non-scout agent
      const ctx = buildEventContext({ agent: 'creator' });
      await getHandler()(ctx);

      const { inngest: inngestMock } = require('../../client');
      const observationSends = (inngestMock.send as jest.Mock).mock.calls.filter(
        (call: [{ name: string }]) => call[0].name === 'app/entity.observation.recorded'
      );
      expect(observationSends).toHaveLength(0);
    });

    it('does not throw if parseScoutBundle returns no bundle', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        agent: 'scout',
        entities: [{ id: 'tech-1', name: 'Tech', type: 'technology', confidence: 0.9, agentName: 'scout' }],
        status: 'completed',
        userId: 'user-456',
        prompt: 'Analyze trends',
        progress: 100,
        sources: [],
        createdAt: new Date().toISOString(),
      });
      mockParseScoutBundle.mockReturnValue({ ok: false, error: 'no fenced json block in output' });

      mockRunMission.mockResolvedValue({
        success: true,
        result: 'Plain text result with no bundle.',
        costUsd: 0.01,
        tokenUsage: { input: 200, output: 100 },
      });

      const ctx = buildEventContext({ agent: 'scout' });
      // Should not throw
      const result = await getHandler()(ctx);
      expect(result.success).toBe(true);

      const { inngest: inngestMock } = require('../../client');
      const observationSends = (inngestMock.send as jest.Mock).mock.calls.filter(
        (call: [{ name: string }]) => call[0].name === 'app/entity.observation.recorded'
      );
      expect(observationSends).toHaveLength(0);
    });
  });

  describe('skill-activation prelude (Step 1.7)', () => {
    const promptWithDimensions = `ROLE: creator
SCOPE: Workday Skills Cloud, Eightfold AI
DEPTH: full

DIRECTIVE: Compare AI-in-HR vendors.

CRITICAL DIMENSIONS (invoke matching skills; critique-report fails on missing applicable dimensions):
- JTBD framing per technology: required
- Cynefin domain classification at brief opening: required
- Three Horizons tag per recommendation: N/A
`;

    beforeEach(() => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'OK',
        costUsd: 0.1,
        tokenUsage: { input: 100, output: 50 },
      });
    });

    it('skips when prompt has no CRITICAL DIMENSIONS block', async () => {
      const ctx = buildEventContext({ prompt: 'Plain prompt, no dimensions.', agent: 'creator' });
      await getHandler()(ctx);
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      const skillPreludeWrites = mockUpdateMission.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      expect(skillPreludeWrites).toHaveLength(0);
    });

    it('skips when mission.enablePrelude=false even with CRITICAL DIMENSIONS present', async () => {
      // Per-mission opt-out for controlled A/B benchmarks. Even though the
      // prompt contains dimensions that would normally fan out 3 sub-missions,
      // enablePrelude=false short-circuits the step before the parser runs.
      mockGetMissionById.mockResolvedValue({ enablePrelude: false });
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      const skillPreludeWrites = mockUpdateMission.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      expect(skillPreludeWrites).toHaveLength(0);
    });

    it('runs one sub-mission per required skill (per-entity × 2 + brief × 1 = 3)', async () => {
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);
      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(3);
      const skills = mockRunSkillSubMission.mock.calls.map((c) => (c[0] as { skill: string }).skill);
      expect(skills.filter((s) => s === 'jtbd-framing')).toHaveLength(2);
      expect(skills.filter((s) => s === 'cynefin-classification')).toHaveLength(1);
    });

    // SKILL-010 — six of the seven newly-routed directives act on sources,
    // figures and claims the run has not produced yet. Precomputing them from a
    // 500-character brief excerpt would spend six real helper sessions to
    // produce blocks about nothing, so the prelude must not dispatch them —
    // while still disclosing that they were required.
    it('does not dispatch a helper session for an output-time directive', async () => {
      const prompt = `${promptWithDimensions}- Red-team the headline claim: required
- Citation identifier validation: required
- Source reliability grade per cited source: required
`;

      await getHandler()(buildEventContext({ prompt, agent: 'creator' }));

      const skills = mockRunSkillSubMission.mock.calls.map((c) => (c[0] as { skill: string }).skill);
      expect(skills).not.toContain('red-team-claim');
      expect(skills).not.toContain('verify-citations');
      expect(skills).not.toContain('rate-source-admiralty');
      // Unchanged from the case above: the precomputed set still fans out.
      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(3);

      const acctUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).preludeAccounting !== undefined
      );
      const skipped = (
        acctUpdate![1] as {
          preludeAccounting: { tasks: { skipped: Array<{ skill: string; reason: string }> } };
        }
      ).preludeAccounting.tasks.skipped;

      expect(skipped).toEqual(
        expect.arrayContaining([
          { skill: 'red-team-claim', reason: 'output-time-directive' },
          { skill: 'verify-citations', reason: 'output-time-directive' },
          { skill: 'rate-source-admiralty', reason: 'output-time-directive' },
        ])
      );
    });

    it('still precomputes the one added directive whose input the brief contains', async () => {
      const prompt = `${promptWithDimensions}- Competing hypotheses for the central question: required
`;

      await getHandler()(buildEventContext({ prompt, agent: 'creator' }));

      const skills = mockRunSkillSubMission.mock.calls.map((c) => (c[0] as { skill: string }).skill);
      expect(skills.filter((s) => s === 'analysis-of-competing-hypotheses')).toHaveLength(1);
    });

    // ARUN-022 / AI-029 — each helper session is paid out-of-process provider
    // work. Before this the only trace of it was the aggregated `preludeCostUsd`.
    describe('helper usage receipts', () => {
      const HELPER_USAGE = {
        'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 900, costUSD: 0.05 },
      };

      function preludeReturning(modelUsage?: Record<string, unknown>) {
        mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
          skill: input.skill,
          target: input.target,
          block: `<${input.skill}>BLOCK</${input.skill}>`,
          costUsd: 0.05,
          durationMs: 5_000,
          firedAt: '2026-07-29T09:00:00.000Z',
          success: true,
          ...(modelUsage ? { modelUsage } : {}),
        }));
      }

      it('flushes one receipt batch per helper that reported per-model usage', async () => {
        preludeReturning(HELPER_USAGE);
        await getHandler()(buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }));

        const calls = (flushSubSessionUsageReceipts as jest.Mock).mock.calls
          .map((c) => c[0] as { kind: string; sessionKey: string; missionId: string; modelUsage: unknown })
          .filter((c) => c.kind === 'skill-prelude');
        expect(calls).toHaveLength(3);
        for (const call of calls) {
          expect(call.modelUsage).toEqual(HELPER_USAGE);
          expect(call.missionId).toBe('mission-123');
          // Identity folds in the immutable dispatch instant so a step retry —
          // which launches genuinely new paid sessions — cannot collide with
          // the previous attempt's receipts.
          expect(call.sessionKey).toMatch(/^\d+-\d+$/);
        }
        // One distinct identity per helper.
        expect(new Set(calls.map((c) => c.sessionKey)).size).toBe(3);
      });

      it('does not flush when the provider reported no per-model usage', async () => {
        preludeReturning(undefined);
        await getHandler()(buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }));

        const preludeCalls = (flushSubSessionUsageReceipts as jest.Mock).mock.calls.filter(
          (c) => (c[0] as { kind: string }).kind === 'skill-prelude'
        );
        expect(preludeCalls).toHaveLength(0);
      });

      it('keeps the in-memory model usage OUT of the persisted mission document', async () => {
        preludeReturning(HELPER_USAGE);
        await getHandler()(buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }));

        const write = mockUpdateMission.mock.calls.find(
          (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
        );
        expect(write).toBeDefined();
        const persisted = (write![1] as { skillPrelude: Array<Record<string, unknown>> }).skillPrelude;
        expect(persisted).toHaveLength(3);
        for (const entry of persisted) {
          // The durable home for this is the receipt ledger, not a second copy
          // on the mission doc.
          expect(entry.modelUsage).toBeUndefined();
          expect(entry.skill).toBeDefined();
          expect(entry.costUsd).toBe(0.05);
        }
      });

      it('keeps a ledger outage non-fatal for the mission', async () => {
        preludeReturning(HELPER_USAGE);
        (flushSubSessionUsageReceipts as jest.Mock).mockRejectedValueOnce(new Error('ledger down'));

        const result = await getHandler()(buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }));

        expect(result).toBeDefined();
        const write = mockUpdateMission.mock.calls.find(
          (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
        );
        expect(write).toBeDefined();
      });
    });

    it('uses the memoized replay envelope to bound prelude fan-out', async () => {
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 4,
        revisionMaxCostUsd: 2,
        preludeMaxCostUsd: 0.3,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 8.3,
      };

      await getHandler()(
        buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }, { memoizedCostEnvelope })
      );

      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(1);
      expect(mockRunSkillSubMission).toHaveBeenCalledWith(expect.objectContaining({ maxCostUsd: 0.3 }));
    });

    it('launches no prelude helper sessions at all when the authorized prelude allocation is zero', async () => {
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 13,
        revisionMaxCostUsd: 0.01,
        preludeMaxCostUsd: 0,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 15.01,
      };

      const result = await getHandler()(
        buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }, { memoizedCostEnvelope })
      );

      expect(result).toBeDefined();
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
    });

    it('persists successful sub-missions to mission.skillPrelude', async () => {
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);
      const preludeUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      expect(preludeUpdate).toBeTruthy();
      const skillPrelude = (preludeUpdate![1] as { skillPrelude: Array<{ success: boolean }> }).skillPrelude;
      expect(skillPrelude).toHaveLength(3);
      expect(skillPrelude.every((e) => e.success)).toBe(true);
    });

    it('propagates an unpriceable prelude to the terminal mission without a partial subtotal', async () => {
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: `<${input.skill}>BLOCK</${input.skill}>`,
        costUsd: null,
        costUnavailableReason: 'unknown-pricing',
        durationMs: 5_000,
        firedAt: new Date().toISOString(),
        success: true,
      }));

      await getHandler()(buildEventContext({ prompt: promptWithDimensions, agent: 'creator' }));

      const preludeUpdate = mockUpdateMission.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>).preludeAccounting !== undefined
      )?.[1] as {
        preludeAccounting: { cost: { totalUsd: number | null; costUnavailableReason?: string } };
      };
      expect(preludeUpdate.preludeAccounting.cost).toEqual(
        expect.objectContaining({ totalUsd: null, costUnavailableReason: 'unknown-pricing' })
      );

      const run = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(run).toMatchObject({ costUnavailableReason: 'unknown-pricing' });
      expect(run).not.toHaveProperty('costUsd');
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).status === 'completed')
        .pop()?.[1] as Record<string, unknown>;
      expect(terminal).toMatchObject({
        costUnavailableReason: 'unknown-pricing',
        costUnavailableComponents: ['prelude'],
      });
      expect(terminal).not.toHaveProperty('costUsd');
      expect(terminal).not.toHaveProperty('costBreakdownUsd');
    });

    it('continues mission when all sub-missions fail', async () => {
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: '',
        costUsd: 0,
        durationMs: 100,
        firedAt: new Date().toISOString(),
        success: false,
        error: 'timeout',
      }));
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      const result = await getHandler()(ctx);
      expect(result).toMatchObject({ success: true });
    });

    it('accounts for every launched result when a provider violates its per-task cap', async () => {
      // The mock deliberately returns more than the $0.30 passed to each
      // provider. All three were already launched, so every billed result must
      // remain in the durable ledger even though no later batch may start.
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: 'x',
        costUsd: 1.5,
        durationMs: 100,
        firedAt: new Date().toISOString(),
        success: true,
      }));
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);
      const preludeUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      expect(preludeUpdate).toBeTruthy();
      expect((preludeUpdate![1] as { skillPrelude: unknown[] }).skillPrelude).toHaveLength(3);
    });

    it('reserves the concurrent batch envelope before launch', async () => {
      const manyEntities = `ROLE: creator
SCOPE: Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Eta, Theta
DEPTH: full

DIRECTIVE: Compare the vendors.

CRITICAL DIMENSIONS (invoke matching skills; critique-report fails on missing applicable dimensions):
- JTBD framing per technology: required
`;
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: 'x',
        costUsd: 0.3,
        durationMs: 100,
        firedAt: new Date().toISOString(),
        success: true,
      }));

      await getHandler()(buildEventContext({ prompt: manyEntities, agent: 'creator' }));

      // $2 / $0.30 permits six calls; the remaining two must never launch.
      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(6);
      const preludeUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      expect((preludeUpdate![1] as { skillPrelude: unknown[] }).skillPrelude).toHaveLength(6);
    });

    it('rejects timeframe/generic/duplicate targets before any helper session and records the accounting (ARUN-025)', async () => {
      // SCOPE mixes 2 real entities, a timeframe, a generic-prose fragment, and
      // a duplicate. Only the 2 unique resolvable entities may fan out; the junk
      // and the duplicate must never consume a paid helper session.
      const noisyPrompt = `ROLE: creator
SCOPE: Workday Skills Cloud, Eightfold AI, 2024-2026, the market, Eightfold AI
DEPTH: full

DIRECTIVE: Compare AI-in-HR vendors.

CRITICAL DIMENSIONS (invoke matching skills; critique-report fails on missing applicable dimensions):
- JTBD framing per technology: required
`;
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: 'x',
        costUsd: 0.1,
        durationMs: 10,
        firedAt: new Date().toISOString(),
        success: true,
      }));

      await getHandler()(buildEventContext({ prompt: noisyPrompt, agent: 'creator' }));

      // Only jtbd-framing × { Workday Skills Cloud, Eightfold AI } = 2 sessions.
      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(2);
      const firedTargets = mockRunSkillSubMission.mock.calls.map((c) => (c[0] as { target?: string }).target);
      expect(new Set(firedTargets)).toEqual(new Set(['Workday Skills Cloud', 'Eightfold AI']));

      // The junk + duplicate are recorded with reasons, not silently dropped.
      type PreludeAcct = {
        targets: {
          accepted: string[];
          rejected: Array<{ value: string; reason: string }>;
          duplicates: Array<{ value: string; canonicalKey: string }>;
          droppedForCountCap: string[];
          countCap: number;
        };
        tasks: {
          planned: number;
          executed: number;
          skipped: Array<{ skill: string; target?: string; reason: string }>;
        };
        cost: { totalUsd: number; capUsd: number; aborted: boolean };
      };
      const acctUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).preludeAccounting !== undefined
      );
      expect(acctUpdate).toBeTruthy();
      const acct = (acctUpdate![1] as { preludeAccounting: PreludeAcct }).preludeAccounting;
      expect(acct.targets.accepted).toEqual(['Workday Skills Cloud', 'Eightfold AI']);
      expect(acct.targets.rejected).toEqual([
        { value: '2024-2026', reason: 'timeframe' },
        { value: 'the market', reason: 'generic-prose' },
      ]);
      expect(acct.targets.duplicates).toEqual([{ value: 'Eightfold AI', canonicalKey: 'eightfold ai' }]);
      expect(acct.tasks.planned).toBe(2);
      expect(acct.tasks.executed).toBe(2);
      expect(acct.tasks.skipped).toEqual([]);
    });

    it('records budget-exhausted skips with their reason and exact cost state (ARUN-025)', async () => {
      const sixEntities = `ROLE: creator
SCOPE: Alpha, Beta, Gamma, Delta, Epsilon, Zeta
DEPTH: full

DIRECTIVE: Compare the vendors.

CRITICAL DIMENSIONS (invoke matching skills; critique-report fails on missing applicable dimensions):
- JTBD framing per technology: required
`;
      mockRunSkillSubMission.mockImplementation(async (input: { skill: string; target?: string }) => ({
        skill: input.skill,
        target: input.target,
        block: 'x',
        costUsd: 0.3,
        durationMs: 10,
        firedAt: new Date().toISOString(),
        success: true,
      }));

      // A $0.90 prelude envelope at $0.30/skill affords only 3 of the 6 sessions;
      // the other three must be recorded as skipped, not silently dropped.
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 4,
        revisionMaxCostUsd: 2,
        preludeMaxCostUsd: 0.9,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 8.9,
      };
      await getHandler()(buildEventContext({ prompt: sixEntities, agent: 'creator' }, { memoizedCostEnvelope }));

      expect(mockRunSkillSubMission).toHaveBeenCalledTimes(3);
      const acctUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).preludeAccounting !== undefined
      );
      const acct = (
        acctUpdate![1] as {
          preludeAccounting: {
            tasks: { planned: number; executed: number; skipped: Array<{ reason: string }> };
            cost: { aborted: boolean; totalUsd: number; capUsd: number };
          };
        }
      ).preludeAccounting;
      expect(acct.tasks.planned).toBe(6);
      expect(acct.tasks.executed).toBe(3);
      expect(acct.tasks.skipped).toHaveLength(3);
      expect(acct.tasks.skipped.every((s) => s.reason === 'budget-exhausted')).toBe(true);
      expect(acct.cost.aborted).toBe(true);
      expect(acct.cost.totalUsd).toBeCloseTo(0.9, 6);
      expect(acct.cost.capUsd).toBeCloseTo(0.9, 6);
    });

    it('produces non-empty blocks that flow into the orchestrator step', async () => {
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);
      const preludeUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).skillPrelude !== undefined
      );
      const skillPrelude = (preludeUpdate![1] as { skillPrelude: Array<{ block: string }> }).skillPrelude;
      expect(skillPrelude.some((e) => e.block.length > 0)).toBe(true);
      // execute-orchestrator step ran (mockRunMission was called); the
      // prompt assertion is done indirectly here because the existing step
      // interceptor doesn't expose the prompt closure. End-to-end coverage
      // of the inject path is in Task 9's AI E2E spec.
      expect(mockRunMission).toHaveBeenCalled();
    });

    it('aggregates prelude costUsd into the final mission cost (H2)', async () => {
      // Mock setup: 3 sub-missions × $0.05 = $0.15 prelude cost, plus
      // orchestrator $0.05 = $0.20 expected on mission.costUsd. Pre-fix the
      // mission was only stamped with the orchestrator's $0.05, hiding 75%
      // of the actual spend at the parent-mission level.
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);

      // The final update-mission-results write carries costUsd (alongside
      // status: 'completed'). Find that call.
      const finalUpdate = mockUpdateMission.mock.calls.find(
        (c) =>
          (c[1] as Record<string, unknown>).status === 'completed' &&
          typeof (c[1] as Record<string, unknown>).costUsd === 'number'
      );
      expect(finalUpdate).toBeTruthy();
      const finalCost = (finalUpdate![1] as { costUsd: number }).costUsd;
      // 3 sub-missions × $0.05 + orchestrator $0.05 = $0.20
      expect(finalCost).toBeCloseTo(0.2, 6);
    });

    it('agentRun row also carries the aggregated cost (H2)', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'done',
        costUsd: 0.05,
        tokenUsage: { input: 1000, output: 500 },
      });
      const ctx = buildEventContext({ prompt: promptWithDimensions, agent: 'creator' });
      await getHandler()(ctx);

      // Last createAgentRun call gets the full aggregated cost.
      expect(mockCreateAgentRun).toHaveBeenCalled();
      const lastCall = mockCreateAgentRun.mock.calls.at(-1);
      const arg = lastCall?.[0] as { costUsd: number } | undefined;
      expect(arg?.costUsd).toBeCloseTo(0.2, 6);
    });
  });

  describe('REVISE retry loop (Step 2.75)', () => {
    function seedQualityReport(
      verdict: 'PASS' | 'REVISE' | 'FAIL',
      failingCheckName?: string,
      priorSkillInvocations?: Array<{ skill: string }>
    ): void {
      const doc = {
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [],
        ...(priorSkillInvocations ? { skillInvocations: priorSkillInvocations } : {}),
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: verdict === 'PASS' ? 0.95 : verdict === 'REVISE' ? 0.6 : 0.2,
          verdict,
          checks: failingCheckName
            ? [{ name: failingCheckName, pass: false, critical: false, detail: 'lacks discipline content' }]
            : [],
        },
      };
      // Reflect a promotion write (qualityReport carrying revisedFromVerdict +
      // the promoted result) the way production Firestore would: REPORT-002's
      // terminal-truth read in Step 4 must see the PROMOTED verdict, not the
      // seeded pre-revision one — a static doc would falsely mark a passing
      // promoted report as needs-review.
      mockGetMissionById.mockImplementation(async () => {
        const promoted = mockUpdateMission.mock.calls
          .map((c) => c[1] as Record<string, unknown>)
          .filter(
            (u) => (u.qualityReport as { revisedFromVerdict?: string } | undefined)?.revisedFromVerdict !== undefined
          )
          .pop();
        if (!promoted) return doc;
        return { ...doc, qualityReport: promoted.qualityReport, result: promoted.result };
      });
    }

    beforeEach(() => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'original report draft with enough body to clear the 100-char floor for partial recovery checks.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
    });

    it('skips when L1 verdict is PASS', async () => {
      seedQualityReport('PASS');
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);
      // Only one orchestrator call — the original mission.
      expect(mockRunMission).toHaveBeenCalledTimes(1);
    });

    it('skips when L1 verdict is FAIL (currently only REVISE triggers retry)', async () => {
      seedQualityReport('FAIL');
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);
      expect(mockRunMission).toHaveBeenCalledTimes(1);
    });

    // mission.costUsd must not stop at the main run and prelude while ignoring
    // revisionAttempts[*].costUsd. The fix sums all three
    // components (orchestrator + prelude + every revise attempt) into
    // a single totalMissionCost and writes that to both the mission
    // doc and the agent-run record.
    it('aggregates revise turn cost into mission.costUsd and agent-run.costUsd', async () => {
      // Set up state that step 3 will see: a mission with PASS verdict
      // (so step 2.75 doesn't fire) AND a pre-populated revisionAttempts
      // array (mirrors what would be in Firestore after a prior revise
      // turn wrote there). The cost-aggregation invariant we're pinning is
      // purely about Step 3 + Step 4: given revisionAttempts has entries,
      // their costUsd must roll into mission.costUsd, regardless of how
      // those entries got there. This avoids coupling to the revise-loop
      // dispatch logic and tests the cost math in isolation.
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [
          {
            attempt: 1,
            triggeredByVerdict: 'REVISE',
            failingChecks: ['creator-jtbd-presence'],
            feedback: 'add discipline content',
            costUsd: 0.5,
            durationMs: 1000,
            revisedAt: '2026-04-29T00:00:01.000Z',
            newVerdict: 'PASS',
          },
        ],
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: 0.95,
          verdict: 'PASS',
          checks: [],
        },
      });
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'main run output, long enough to pass the partial-content gate for this assertion path.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      const completedUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).status === 'completed')
        .pop();
      expect(completedUpdate).toBeTruthy();
      // 1.0 main + 0.5 revise = 1.5 — must include both, not just main.
      expect((completedUpdate![1] as { costUsd?: number }).costUsd).toBeCloseTo(1.5, 6);

      // Agent-run row must agree with the mission row.
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 1.5 }));
    });

    it('propagates an unavailable revision cost instead of summing it as zero', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [
          {
            attempt: 1,
            triggeredByVerdict: 'REVISE',
            failingChecks: ['creator-jtbd-presence'],
            feedback: 'add discipline content',
            costUsd: null,
            costUnavailableReason: 'unknown-pricing',
            durationMs: 1000,
            revisedAt: '2026-04-29T00:00:01.000Z',
            newVerdict: 'PASS',
          },
        ],
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: 0.95,
          verdict: 'PASS',
          checks: [],
        },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'main run output, long enough to pass the partial-content gate for this assertion path.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      const run = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(run).toMatchObject({ costUnavailableReason: 'unknown-pricing' });
      expect(run).not.toHaveProperty('costUsd');
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).status === 'completed')
        .pop()?.[1] as Record<string, unknown>;
      expect(terminal).toMatchObject({
        costUnavailableReason: 'unknown-pricing',
        costUnavailableComponents: ['revisions'],
      });
      expect(terminal).not.toHaveProperty('costUsd');
      expect(terminal).not.toHaveProperty('costBreakdownUsd');
    });

    it('runs one revision turn when verdict is REVISE', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original draft with discipline gap',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with discipline content.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);
      // Original mission ran once; revision dispatched via runRevisionOrchestrator.
      expect(mockRunMission).toHaveBeenCalledTimes(1);
      expect(mockRunRevisionOrchestrator).toHaveBeenCalledTimes(1);
      const revisionUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
      );
      expect(revisionUpdate).toBeTruthy();
      const attempts = (revisionUpdate![1] as { revisionAttempts: Array<{ feedback: string }> }).revisionAttempts;
      expect(attempts[0].feedback).toContain('creator-jtbd-presence');
      expect(attempts[0].feedback).toContain('REVISION INSTRUCTIONS');
    });

    it('scores revised output with formal Skill receipts returned by the revision orchestrator', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      const revisionSkillInvocations = [
        { skill: 'cite-ieee', firedAt: '2026-08-01T18:00:00.000Z', turn: 1 },
        { skill: 'design-pass', firedAt: '2026-08-01T18:00:01.000Z', turn: 1 },
      ];
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original draft with discipline gap',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result:
          '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with enough discipline content to clear the partial-output floor and reach the revised quality evaluation.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
        skillInvocations: revisionSkillInvocations,
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockEvaluateMissionQuality).toHaveBeenCalledWith(
        expect.objectContaining({ skillInvocations: revisionSkillInvocations })
      );
    });

    it('SKILL-050: the revised draft is scored against the ORIGINAL receipts too', async () => {
      // A revision corrects ONE skill's output. A skill that fired in the original
      // session and whose output survives into the revised draft still has a
      // formal receipt — it is recorded on the mission, not on this session.
      // Scoring the revision against the revision session alone would fail every
      // already-satisfied skill and make the two verdicts incomparable.
      const originalInvocations = [{ skill: 'design-pass', firedAt: '2026-08-01T17:00:00.000Z', turn: 3 }];
      const revisionInvocations = [{ skill: 'cite-ieee', firedAt: '2026-08-01T18:00:00.000Z', turn: 1 }];
      seedQualityReport('REVISE', 'creator-jtbd-presence', originalInvocations);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original draft with discipline gap',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result:
          '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with enough discipline content to clear the partial-output floor and reach the revised quality evaluation.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
        skillInvocations: revisionInvocations,
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockEvaluateMissionQuality).toHaveBeenCalledWith(
        expect.objectContaining({ skillInvocations: [...originalInvocations, ...revisionInvocations] })
      );
    });

    it('SKILL-050: a revision that fired no skill of its own keeps the original receipts', async () => {
      const originalInvocations = [
        { skill: 'cite-ieee', firedAt: '2026-08-01T17:00:00.000Z', turn: 2 },
        { skill: 'design-pass', firedAt: '2026-08-01T17:00:01.000Z', turn: 3 },
      ];
      seedQualityReport('REVISE', 'creator-jtbd-presence', originalInvocations);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original draft with discipline gap',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result:
          '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with enough discipline content to clear the partial-output floor and reach the revised quality evaluation.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockEvaluateMissionQuality).toHaveBeenCalledWith(
        expect.objectContaining({ skillInvocations: originalInvocations })
      );
    });

    /** REPORT-017 eligibility + REPORT-019 evidence-preserving recovery. */
    describe('scout bundle repair (REPORT-017 / REPORT-019)', () => {
      /**
       * The Scout bundle checks only run when the prompt carries the bundle
       * contract — `containsBundleMarker` keys on `tool_call_id`/`fetched_via`.
       * Using a bare prompt would silently skip every check being tested, so the
       * fixture uses the contract the real mission was dispatched with.
       */
      const SCOUT_BUNDLE_PROMPT =
        'Research the topic and emit a bundle whose sources carry fetched_via and tool_call_id.';

      /** Seed the exact retained quality shape. */
      function seedScoutBundleReport(
        checks: Array<{ name: string; pass: boolean; critical: boolean; detail: string }>,
        originalResult = '',
        extra: Record<string, unknown> = {}
      ) {
        const doc = {
          id: 'mission-123',
          result: originalResult,
          skillPrelude: [],
          revisionAttempts: [],
          qualityReport: { evaluatedAt: '2026-08-01T00:00:00.000Z', overallScore: 0.4, verdict: 'FAIL', checks },
          ...extra,
        };
        mockGetMissionById.mockImplementation(async () => {
          const promoted = mockUpdateMission.mock.calls
            .map((c) => c[1] as Record<string, unknown>)
            .filter(
              (u) => (u.qualityReport as { revisedFromVerdict?: string } | undefined)?.revisedFromVerdict !== undefined
            )
            .pop();
          if (!promoted) return doc;
          return { ...doc, qualityReport: promoted.qualityReport, result: promoted.result };
        });
      }

      const PARSEABLE_WITH_PADDING = [
        {
          name: 'scout-bundle-parseable',
          pass: true,
          critical: true,
          detail: 'bundle parsed — 15 source(s), 10 finding(s)',
        },
        {
          name: 'scout-no-citation-padding',
          pass: false,
          critical: true,
          detail:
            "8 padding violations (first: finding 2 — source 3 snippet does not contain any of the finding's numeric tokens (30%))",
        },
        { name: 'scout-no-fake-urls', pass: true, critical: true, detail: '15 URL(s) reachable' },
      ];

      const source = (id: number, snippet: string) => ({
        id,
        title: `Retained source ${id}`,
        url: `https://example.com/evidence/${id}`,
        fetched_via: 'gemini-grounding',
        tool_call_id: `toolu_retained_${id}`,
        admiralty: 'B2',
        date_accessed: '2026-08-01',
        snippet,
      });
      const RETAINED_BUNDLE = {
        queries: ['market adoption evidence', 'cost benchmark evidence', 'implementation risk evidence'],
        sources: [
          source(1, 'Independent evidence says adoption reached 30% in the measured cohort.'),
          source(2, 'A second measurement also reports adoption reached 30% in the cohort.'),
          source(3, 'The market is changing quickly, with several vendors competing.'),
          source(4, 'Surveyed teams reported a 40% reduction in cycle time.'),
          source(5, 'Teams are applying the technology to delivery workflows.'),
          source(6, 'The benchmark measured $0.28 per million tokens.'),
          source(7, 'Pricing varies by vendor and deployment model.'),
          source(8, 'Median response latency was 180ms.'),
          source(9, 'The study compares several runtime architectures.'),
          source(10, 'The pilot served 5,000 users.'),
          source(11, 'Adoption depends on workflow fit and change management.'),
          source(12, 'Storage consumption measured 110GB.'),
          source(13, 'Storage architecture affects operating cost.'),
          source(14, 'The measured throughput improvement was 2.5x.'),
          source(15, 'Throughput depends on batching and hardware.'),
        ],
        findings: [
          'Enterprise adoption is accelerating in regulated teams [1, 2].',
          'Implementation risk concentrates in workflow integration [3, 5].',
          'Adoption reached 30% in the measured cohort [1, 3].',
          'Cycle time fell 40% in surveyed teams [4, 5].',
          'Inference cost reached $0.28 per million tokens [6, 7].',
          'Median response latency reached 180ms [8, 9].',
          'The pilot served 5,000 users [10, 11].',
          'Storage consumption measured 110GB [12, 13].',
          'Measured throughput improved 2.5x [14, 15].',
          'Adoption reached 30% in another segment [2, 11].',
        ],
        unresolved: ['Long-term retention effects remain unknown.'],
      };
      const ORIGINAL_RESULT = ['Synthetic Scout result.', '```json', JSON.stringify(RETAINED_BUNDLE), '```'].join('\n');

      beforeEach(() => {
        mockParseScoutBundle.mockImplementation((value: string) => actualScoutBundleParser.parseScoutBundle(value));
      });

      it('recovers the synthetic shape inside the one-attempt envelope without a provider rewrite', async () => {
        seedScoutBundleReport(PARSEABLE_WITH_PADDING, ORIGINAL_RESULT);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: ORIGINAL_RESULT,
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
        const revisionUpdate = mockUpdateMission.mock.calls.find(
          (c) =>
            (c[1] as Record<string, unknown>).revisionAttempts !== undefined &&
            (c[1] as Record<string, unknown>).result !== undefined
        );
        const attempts = (
          revisionUpdate![1] as {
            revisionAttempts: Array<{
              feedback: string;
              triggeredByVerdict: string;
              costUsd: number;
              rejected: boolean;
            }>;
          }
        ).revisionAttempts;
        expect(attempts[0].triggeredByVerdict).toBe('FAIL');
        expect(attempts[0].costUsd).toBe(0);
        expect(attempts[0].rejected).toBe(false);
        expect(attempts[0].feedback).toContain('scout-no-citation-padding');
        expect(attempts[0].feedback).toContain('2 unaffected finding(s) preserved byte-for-byte');
        expect(attempts[0].feedback).toContain('8 affected finding(s) moved to unresolved evidence');

        const promoted = revisionUpdate![1] as {
          result: string;
          qualityReport: { verdict: string; checks: Array<{ name: string; pass: boolean }> };
        };
        const parsed = actualScoutBundleParser.parseScoutBundle(promoted.result) as {
          ok: boolean;
          bundle: typeof RETAINED_BUNDLE;
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.bundle.findings).toEqual(RETAINED_BUNDLE.findings.slice(0, 2));
        expect(parsed.bundle.sources).toEqual(RETAINED_BUNDLE.sources);
        expect(parsed.bundle.unresolved.slice(1)).toHaveLength(8);
        expect(parsed.bundle.unresolved.slice(1).every((claim) => !/\[[\d\s,]+\]/.test(claim))).toBe(true);
        expect(promoted.qualityReport.verdict).not.toBe('FAIL');
        expect(promoted.qualityReport.checks).toContainEqual(
          expect.objectContaining({ name: 'scout-no-citation-padding', pass: true })
        );
        // Sources were immutable, so the original passing reachability receipt
        // remains present after the synchronous recovery evaluation.
        expect(promoted.qualityReport.checks).toContainEqual(
          expect.objectContaining({ name: 'scout-no-fake-urls', pass: true })
        );
      });

      it('hands Creator only the recovered supported findings plus visibly unresolved uncited claims', async () => {
        seedScoutBundleReport(PARSEABLE_WITH_PADDING, ORIGINAL_RESULT, {
          chainId: 'chain-report-019',
          chainStep: 1,
          chainTotalSteps: 2,
          status: 'completed',
        });
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: ORIGINAL_RESULT,
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });
        mockShouldAdvanceChain.mockReturnValueOnce(true);
        mockFindNextChainStep.mockResolvedValueOnce({
          id: 'creator-mission-report-019',
          agent: 'creator',
          chainStep: 2,
          prompt: 'Create the report from this Scout evidence only:\n{{parent.result}}',
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        const { inngest } = require('../../client') as { inngest: { send: jest.Mock } };
        const dispatch = inngest.send.mock.calls
          .map((call: [Record<string, unknown>]) => call[0])
          .find((event: { name?: string }) => event.name === 'app/mission.run.requested') as {
          data: { missionId: string; agent: string; prompt: string };
        };
        expect(dispatch.data).toMatchObject({ missionId: 'creator-mission-report-019', agent: 'creator' });
        expect(dispatch.data.prompt).toContain(RETAINED_BUNDLE.findings[0]);
        expect(dispatch.data.prompt).toContain(RETAINED_BUNDLE.findings[1]);
        expect(dispatch.data.prompt).toContain('"unresolved"');
        expect(dispatch.data.prompt).toContain('not supported evidence');
        expect(dispatch.data.prompt).not.toContain(RETAINED_BUNDLE.findings[2]);
        expect(dispatch.data.prompt).not.toMatch(/citation support insufficient[^\n]*\[[\d\s,]+\]/);
      });

      it('refuses a malformed bundle — no repair turn is dispatched at all', async () => {
        seedScoutBundleReport([
          { name: 'scout-bundle-parseable', pass: false, critical: true, detail: 'no fenced json block found' },
        ]);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'prose with no bundle',
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      });

      it('refuses fabricated evidence — an unreachable URL is not a formatting slip', async () => {
        seedScoutBundleReport([
          ...PARSEABLE_WITH_PADDING,
          { name: 'scout-no-fake-urls', pass: false, critical: true, detail: '2 URL(s) unreachable' },
        ]);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'bundle citing sources that do not resolve',
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      });

      it('fails closed when every finding is affected and records the refused zero-cost attempt', async () => {
        const allAffectedResult = [
          'Retained Scout result.',
          '```json',
          JSON.stringify({
            ...RETAINED_BUNDLE,
            findings: ['Adoption reached 30% in the measured cohort [1, 3].'],
          }),
          '```',
        ].join('\n');
        seedScoutBundleReport(PARSEABLE_WITH_PADDING, allAffectedResult);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: allAffectedResult,
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
        const revisionUpdate = mockUpdateMission.mock.calls.find(
          (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
        );
        const attempts = (
          revisionUpdate![1] as {
            revisionAttempts: Array<{ rejected?: boolean; promotionReasons?: string[]; costUsd?: number }>;
          }
        ).revisionAttempts;
        expect(attempts[0].rejected).toBe(true);
        expect(attempts[0].promotionReasons?.join(' ')).toContain('no supported finding remains for Creator');
        expect(attempts[0].costUsd).toBe(0);
        const terminal = mockUpdateMission.mock.calls
          .filter((call) => (call[1] as Record<string, unknown>).status === 'completed')
          .pop()?.[1] as { result?: string };
        expect(terminal.result).toBe(allAffectedResult);
      });

      it('keeps the one-attempt cap — a mission that already used its turn gets no second', async () => {
        const doc = {
          id: 'mission-123',
          skillPrelude: [],
          revisionAttempts: [{ attempt: 1, rejected: true }],
          qualityReport: {
            evaluatedAt: '2026-08-01T00:00:00.000Z',
            overallScore: 0.4,
            verdict: 'FAIL',
            checks: PARSEABLE_WITH_PADDING,
          },
        };
        mockGetMissionById.mockResolvedValue(doc);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'original bundle',
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      });

      it('records no provider receipt or provider cost for deterministic recovery', async () => {
        seedScoutBundleReport(PARSEABLE_WITH_PADDING, ORIGINAL_RESULT);
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: ORIGINAL_RESULT,
          costUsd: 0.53,
          tokenUsage: { input: 100, output: 50 },
        });

        await getHandler()(buildEventContext({ prompt: SCOUT_BUNDLE_PROMPT, agent: 'scout' }));

        const receipts = (flushSubSessionUsageReceipts as jest.Mock).mock.calls
          .map((c) => c[0] as { kind: string; sessionKey: string })
          .filter((c) => c.kind === 'revision');
        expect(receipts).toEqual([]);
        expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
        const terminal = mockUpdateMission.mock.calls
          .filter((call) => (call[1] as Record<string, unknown>).status === 'completed')
          .pop()?.[1] as { costUsd?: number };
        expect(terminal.costUsd).toBeCloseTo(0.53, 6);
      });
    });

    // ARUN-022 / AI-029 — the revision turn is a full paid out-of-process
    // session. Before this its spend survived only as the aggregated
    // `revisionAttempts[].costUsd`, with no served model and no counters.
    describe('revision usage receipts', () => {
      const REVISION_USAGE = {
        'claude-sonnet-4-6': {
          inputTokens: 900,
          outputTokens: 400,
          cacheReadInputTokens: 12_000,
          costUSD: 0.5,
        },
      };

      function revisionSubSessionCalls() {
        return (flushSubSessionUsageReceipts as jest.Mock).mock.calls
          .map((c) => c[0] as { kind: string; sessionKey: string; missionId: string; modelUsage: unknown })
          .filter((c) => c.kind === 'revision');
      }

      it('flushes the revision turn as a durable per-served-model receipt', async () => {
        seedQualityReport('REVISE', 'creator-jtbd-presence');
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'original draft with discipline gap',
          costUsd: 1.0,
          tokenUsage: { input: 100, output: 50 },
        });
        mockRunRevisionOrchestrator.mockResolvedValueOnce({
          success: true,
          result: '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with discipline content.',
          costUsd: 0.5,
          tokenUsage: { input: 80, output: 60 },
          modelUsage: REVISION_USAGE,
        });

        await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

        const calls = revisionSubSessionCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].missionId).toBe('mission-123');
        expect(calls[0].modelUsage).toEqual(REVISION_USAGE);
        // Identity folds in the immutable pre-dispatch instant, so a step retry
        // (a genuinely new paid session) cannot conflict with this one.
        expect(calls[0].sessionKey).toMatch(/^attempt-1-\d+$/);
      });

      it('still receipts a FAILED revision — the turn burned tokens either way', async () => {
        seedQualityReport('REVISE', 'creator-jtbd-presence');
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'original draft with discipline gap',
          costUsd: 1.0,
          tokenUsage: { input: 100, output: 50 },
        });
        mockRunRevisionOrchestrator.mockResolvedValueOnce({
          success: false,
          errors: ['revision produced nothing usable'],
          costUsd: 0.2,
          providerReportedCostUsd: 0.2,
          exposureUsd: 1.5,
          duplicateUsageEvents: 1,
          requestedModel: 'claude-opus-5',
          modelUsage: REVISION_USAGE,
        });

        await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

        expect(revisionSubSessionCalls()).toHaveLength(1);
        const update = mockUpdateMission.mock.calls.find(
          (call) => (call[1] as { revisionAttempts?: unknown }).revisionAttempts !== undefined
        );
        expect((update![1] as { revisionAttempts: Array<Record<string, unknown>> }).revisionAttempts[0]).toMatchObject({
          costUsd: 0.2,
          providerReportedCostUsd: 0.2,
          exposureUsd: 1.5,
          duplicateUsageEvents: 1,
          requestedModel: 'claude-opus-5',
        });
      });

      it('does not flush when the revision reported no per-model usage', async () => {
        seedQualityReport('REVISE', 'creator-jtbd-presence');
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'original draft with discipline gap',
          costUsd: 1.0,
          tokenUsage: { input: 100, output: 50 },
        });
        mockRunRevisionOrchestrator.mockResolvedValueOnce({
          success: true,
          result: '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with discipline content.',
          costUsd: 0.5,
          tokenUsage: { input: 80, output: 60 },
        });

        await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

        expect(revisionSubSessionCalls()).toHaveLength(0);
      });

      it('keeps a ledger outage non-fatal — the revision still promotes', async () => {
        seedQualityReport('REVISE', 'creator-jtbd-presence');
        mockRunMission.mockResolvedValueOnce({
          success: true,
          result: 'original draft with discipline gap',
          costUsd: 1.0,
          tokenUsage: { input: 100, output: 50 },
        });
        mockRunRevisionOrchestrator.mockResolvedValueOnce({
          success: true,
          result: '<jtbd>Job: minimize ...</jtbd>\nrevised report draft now with discipline content.',
          costUsd: 0.5,
          tokenUsage: { input: 80, output: 60 },
          modelUsage: REVISION_USAGE,
        });
        (flushSubSessionUsageReceipts as jest.Mock).mockRejectedValueOnce(new Error('ledger down'));

        await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

        const revisionUpdate = mockUpdateMission.mock.calls.find(
          (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
        );
        expect(revisionUpdate).toBeTruthy();
      });
    });

    it('caps at one retry — does not loop on persistent REVISE', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'still missing discipline content but long enough to pass the 100-char gate',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      mockRunRevisionOrchestrator.mockResolvedValue({
        success: true,
        result: 'revised but still no discipline content, still long enough to pass the 100-char gate here',
        costUsd: 0.25,
        tokenUsage: { input: 40, output: 30 },
      });
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);
      // Original mission runs exactly once; revision helper at most once.
      expect(mockRunMission).toHaveBeenCalledTimes(1);
      expect(mockRunRevisionOrchestrator.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('persists revisionAttempts on the mission', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);
      const revisionUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
      );
      expect(revisionUpdate).toBeTruthy();
      const attempts = (
        revisionUpdate![1] as {
          revisionAttempts: Array<{ attempt: number; triggeredByVerdict: string }>;
        }
      ).revisionAttempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].attempt).toBe(1);
      expect(attempts[0].triggeredByVerdict).toBe('REVISE');
    });

    it('revisionAttempts persists coverageShift when revision turn succeeds', async () => {
      // Seed L1 verdict REVISE with one failing dimension (creator-jtbd-presence).
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original draft missing the discipline anchor',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      // Revision result includes the JTBD block so the post-revision
      // L1 re-eval flips creator-jtbd-presence from fail → pass. This
      // makes coverageShift.dimensionsFixed include that name and
      // dimensionsStillFailing/Newly empty (modulo other intrinsic checks).
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result:
          '<jtbd>Job: ship discipline-anchored briefs</jtbd>\nrevised body with full discipline content for the gate.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      const revisionUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
      );
      expect(revisionUpdate).toBeTruthy();
      const attempts = (
        revisionUpdate![1] as {
          revisionAttempts: Array<{
            coverageShift?: {
              dimensionsFixed: string[];
              dimensionsStillFailing: string[];
              dimensionsNewlyFailing: string[];
            };
          }>;
        }
      ).revisionAttempts;
      expect(attempts).toHaveLength(1);
      const shift = attempts[0].coverageShift;
      expect(shift).toBeDefined();
      expect(Array.isArray(shift!.dimensionsFixed)).toBe(true);
      expect(Array.isArray(shift!.dimensionsStillFailing)).toBe(true);
      expect(Array.isArray(shift!.dimensionsNewlyFailing)).toBe(true);
      // The seeded failing dimension was creator-jtbd-presence; the revised
      // output contains a <jtbd> block, so the dimension must end up in
      // dimensionsFixed (not dimensionsStillFailing).
      expect(shift!.dimensionsFixed).toContain('creator-jtbd-presence');
      expect(shift!.dimensionsStillFailing).not.toContain('creator-jtbd-presence');
      // Pin the wiring: a regression that swapped dimensionsFixed into
      // the dimensionsNewlyFailing slot would only be caught by this.
      expect(shift!.dimensionsNewlyFailing).toEqual([]);
    });

    it('retains original output when the revision turn fails', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the partial-recovery check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      // runRevisionOrchestrator already wraps errors — it returns success:false
      // rather than throwing. Simulate that structured failure path.
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: false,
        errors: ['SDK crash'],
      });
      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      const result = await getHandler()(ctx);
      expect(result).toMatchObject({ success: true });
      // The mission's final result should still be the original — the
      // revision-failure path persists the attempt without promoting a new
      // result.
      const finalResultsUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).result !== undefined)
        .pop();
      const canonicalOriginal = (finalResultsUpdate![1] as { result: string }).result;
      expect(canonicalOriginal).toContain('original report draft');
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        agentName: 'creator',
        status: 'completed',
        summary: canonicalOriginal.slice(0, 500),
        legacySummary: canonicalOriginal.slice(0, 500),
        missionOutcome: 'success',
      });

      // REPORT-020 (E): the retained attempt must say it was REJECTED.
      // `rejected` used to be written only on the bundle-repair path, so an
      // ordinary failure persisted the field ABSENT — which
      // `schemas/mission.ts` defines as "promoted as the canonical result".
      // A failed turn must never be recorded as a promotion.
      const attemptUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined)
        .pop();
      const attempt = (attemptUpdate![1] as { revisionAttempts: Array<Record<string, unknown>> }).revisionAttempts[0];
      expect(attempt.rejected).toBe(true);
      expect(attempt.promotionReasons).toEqual([expect.stringContaining('no usable output')]);
    });

    /**
     * REPORT-020 (C) — a promotion must be backed by bytes that actually changed.
     *
     * A revision can receive an improved score without publishing different
     * bytes. `preRevisionRefs[].htmlSha256` and the recomputed artifact identity
     * must therefore be compared before promotion.
     *
     * Scored quality cannot stand in for this: L1 runs over
     * `revisionText + canonicalHtml`, so prose describing an unpublished draft
     * can flip a check while the artifact stands still. Here the revision is
     * deliberately IMPROVED (verdict PASS, no regression reasons) so that only
     * the byte comparison can reject it.
     */
    it('REPORT-020: rejects an improved revision that republished byte-identical HTML', async () => {
      const UNCHANGED_HTML = '<h1>Original</h1><p>Body that the revision never actually replaced.</p>';
      // Comfortably over the 100-char usable-output floor, so this reaches the
      // promotion decision rather than the revision-failure branch.
      const IMPROVED_BUT_UNPUBLISHED =
        'This revised draft claims every requested fix landed and reads as a clear, well-sourced improvement over the original draft in every dimension the rubric scores.';
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the byte-identity check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: IMPROVED_BUT_UNPUBLISHED,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      // Every read returns the SAME bytes — publication never landed.
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-frozen', html: UNCHANGED_HTML, designPassVerdict: 'PASS', reviewStatus: 'published' },
      ]);
      // The immutable pre-revision receipt therefore carries the same digest the
      // post-revision re-read recomputes.
      mockCaptureReportVersionWithReceipt.mockResolvedValue({
        versionId: 'ver-report-frozen',
        versionNumber: 1,
        htmlLength: UNCHANGED_HTML.length,
        htmlSha256: createHash('sha256').update(UNCHANGED_HTML, 'utf8').digest('hex'),
      } as never);
      // The revision scores BETTER, so nothing but the byte check can stop it.
      mockEvaluateMissionQuality.mockImplementation((arg: unknown) => {
        if (((arg as { result?: string }).result ?? '').startsWith(IMPROVED_BUT_UNPUBLISHED)) {
          return {
            evaluatedAt: '2026-04-29T00:00:02.000Z',
            overallScore: 0.95,
            verdict: 'PASS',
            checks: [{ name: 'creator-jtbd-presence', pass: true, critical: true, detail: 'fixed' }],
          };
        }
        return actualMissionQuality.evaluateMissionQuality(arg);
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // It must not become the canonical result...
      expect(
        mockUpdateMission.mock.calls.find((c) => (c[1] as { result?: string }).result === IMPROVED_BUT_UNPUBLISHED)
      ).toBeUndefined();

      // ...and the attempt must say why, naming the unchanged artifact.
      const attemptUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined)
        .pop();
      const attempt = (attemptUpdate![1] as { revisionAttempts: Array<Record<string, unknown>> }).revisionAttempts[0];
      expect(attempt.rejected).toBe(true);
      expect(attempt.promotionReasons).toEqual([expect.stringContaining('no new bytes')]);
      expect((attempt.promotionReasons as string[])[0]).toContain('report-frozen');
    });

    // MISSION-002: a revision whose verdict rank drops below the original's
    // (e.g. REVISE→FAIL) must never be promoted. The prior behavior
    // unconditionally promoted any successful revise turn, so a lower-quality
    // rewrite could clobber a better original — both in mission.result AND in
    // the report HTML the revision agent republished to the same slot.
    const REGRESSED_REVISION =
      'This revised draft is materially worse than the original and should be rejected by the MISSION-002 regression gate now.';
    const IMPROVED_REVISION =
      'This revised draft is clearly better than the original and should be promoted as the canonical mission result now.';

    it('rejects a regressed revision — keeps original result, marks attempt rejected', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the regression-gate check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: REGRESSED_REVISION,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      // Force the revised output's L1 re-eval to drop the verdict to FAIL
      // (a rank regression below the seeded REVISE original). Original result
      // still delegates to the real evaluator.
      mockEvaluateMissionQuality.mockImplementation((arg: unknown) => {
        if (((arg as { result?: string }).result ?? '').startsWith(REGRESSED_REVISION)) {
          return {
            evaluatedAt: '2026-04-29T00:00:02.000Z',
            overallScore: 0.3,
            verdict: 'FAIL',
            checks: [{ name: 'creator-jtbd-presence', pass: false, critical: true, detail: 'still worse' }],
          };
        }
        return actualMissionQuality.evaluateMissionQuality(arg);
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // The regressed revision must NOT be promoted as the mission result.
      const promoted = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as { result?: string }).result === REGRESSED_REVISION
      );
      expect(promoted).toBeUndefined();

      // The attempt is still recorded (retry spend stays visible) but flagged rejected.
      const attemptUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
      );
      expect(attemptUpdate).toBeTruthy();
      const attempts = (attemptUpdate![1] as { revisionAttempts: Array<{ rejected?: boolean }> }).revisionAttempts;
      expect(attempts[0].rejected).toBe(true);

      // The final persisted result stays the ORIGINAL, not the worse rewrite.
      const finalResultsUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).result !== undefined)
        .pop();
      const canonicalOriginal = (finalResultsUpdate![1] as { result: string }).result;
      expect(canonicalOriginal).toContain('original report draft');
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        agentName: 'creator',
        status: 'completed',
        summary: canonicalOriginal.slice(0, 500),
        legacySummary: canonicalOriginal.slice(0, 500),
        missionOutcome: 'success',
      });
    });

    it('restores EVERY slot report HTML when a revision regresses (multi-slot)', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the regression-gate check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: REGRESSED_REVISION,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      // A multi-slot mission published TWO reports before the revise turn. The
      // revision may clobber either slot — both originals must be restored, not
      // just the newest one (Finding B).
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-newest', html: '<h1>TCO Breakdown</h1>' },
        { id: 'report-older', html: '<h1>Vendor Comparison</h1>' },
      ]);
      mockEvaluateMissionQuality.mockImplementation((arg: unknown) => {
        if (((arg as { result?: string }).result ?? '').startsWith(REGRESSED_REVISION)) {
          return {
            evaluatedAt: '2026-04-29T00:00:02.000Z',
            overallScore: 0.3,
            verdict: 'FAIL',
            checks: [{ name: 'creator-jtbd-presence', pass: false, critical: true, detail: 'still worse' }],
          };
        }
        return actualMissionQuality.evaluateMissionQuality(arg);
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // REPORT-004: both slots roll back DETERMINISTICALLY from their immutable
      // pre-revision versions (exact captured html by versionId), attributed to
      // the mission agent, with lifecycle applied atomically alongside the swap.
      expect(mockRestoreReportVersion).toHaveBeenCalledWith(
        'report-newest',
        expect.objectContaining({
          versionId: 'ver-report-newest',
          savedBy: 'agent:creator',
          requireOwnerId: 'user-456',
        })
      );
      expect(mockRestoreReportVersion).toHaveBeenCalledWith(
        'report-older',
        expect.objectContaining({
          versionId: 'ver-report-older',
          savedBy: 'agent:creator',
          requireOwnerId: 'user-456',
        })
      );
      // Both were frozen (with the check receipt) BEFORE the paid revision ran.
      expect(mockCaptureReportVersionWithReceipt).toHaveBeenCalledWith(
        'report-newest',
        expect.objectContaining({
          reason: 'pre-revision',
          savedBy: 'agent:creator',
          checkReceipt: expect.objectContaining({ verdict: 'REVISE' }),
        })
      );
    });

    it('skips the paid revision entirely when the immutable pre-revision capture fails (REPORT-004)', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the capture-failure check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockGetReportsByMissionId.mockResolvedValue([{ id: 'report-x', html: '<h1>Original</h1>' }]);
      mockCaptureReportVersionWithReceipt.mockResolvedValueOnce(null as never);

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      // No durable restore path → no paid revision (extends MISSION-002's rule).
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
    });

    it('rejects an equal-verdict revision whose republish regressed the design gate (REPORT-003)', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the design-regression check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      const SAME_VERDICT_REVISION =
        'revised draft that keeps the same L1 verdict but republished an off-design artifact, comfortably clearing the one-hundred-character result floor for this check.';
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: SAME_VERDICT_REVISION,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      // Snapshot read (pre-revision): design gate PASS. Re-read (post-revision):
      // the republish flipped the slot to FAIL.
      mockGetReportsByMissionId
        .mockResolvedValueOnce([
          { id: 'report-design', html: '<h1>Original</h1>', designPassVerdict: 'PASS', reviewStatus: 'published' },
        ]) // evaluate-quality canonical read (2.7)
        .mockResolvedValueOnce([
          { id: 'report-design', html: '<h1>Original</h1>', designPassVerdict: 'PASS', reviewStatus: 'published' },
        ]) // revise-step snapshot
        .mockResolvedValue([
          { id: 'report-design', html: '<h1>Rewritten</h1>', designPassVerdict: 'FAIL', reviewStatus: 'needs-review' },
        ]); // post-revision re-read (and later reads)
      // Same verdict before/after → the old rank-only gate would auto-promote.
      mockEvaluateMissionQuality.mockImplementation((arg: unknown) => {
        if (((arg as { result?: string }).result ?? '').startsWith(SAME_VERDICT_REVISION)) {
          return {
            evaluatedAt: '2026-04-29T00:00:02.000Z',
            overallScore: 0.6,
            verdict: 'REVISE',
            checks: [{ name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'still lacking' }],
          };
        }
        return actualMissionQuality.evaluateMissionQuality(arg);
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // The design regression rejects the promotion and rolls the slot back.
      const attemptUpdate = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).revisionAttempts !== undefined
      );
      const attempts = (
        attemptUpdate![1] as { revisionAttempts: Array<{ rejected?: boolean; promotionReasons?: string[] }> }
      ).revisionAttempts;
      expect(attempts[0].rejected).toBe(true);
      expect(attempts[0].promotionReasons?.join(' ')).toMatch(/design gate regressed from PASS to FAIL/);
      expect(mockRestoreReportVersion).toHaveBeenCalledWith(
        'report-design',
        expect.objectContaining({
          versionId: 'ver-report-design',
          alsoSet: expect.objectContaining({ reviewStatus: 'published', designPassVerdict: 'PASS' }),
        })
      );
    });

    it('promotes a non-regressed revision and does not restore the original report', async () => {
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the regression-gate check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: IMPROVED_REVISION,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      mockGetReportsByMissionId.mockResolvedValue([{ id: 'report-orig', html: '<h1>Original</h1>' }]);
      // Revised output improves the verdict (PASS) over the seeded original (REVISE).
      mockEvaluateMissionQuality.mockImplementation((arg: unknown) => {
        if (((arg as { result?: string }).result ?? '').startsWith(IMPROVED_REVISION)) {
          return {
            evaluatedAt: '2026-04-29T00:00:02.000Z',
            overallScore: 0.95,
            verdict: 'PASS',
            checks: [],
          };
        }
        return actualMissionQuality.evaluateMissionQuality(arg);
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // The improved revision is promoted (result + revisionAttempts together).
      const promoteUpdate = mockUpdateMission.mock.calls.find(
        (c) =>
          (c[1] as { result?: string }).result === IMPROVED_REVISION &&
          (c[1] as { revisionAttempts?: unknown }).revisionAttempts !== undefined
      );
      expect(promoteUpdate).toBeTruthy();
      const attempts = (promoteUpdate![1] as { revisionAttempts: Array<{ rejected?: boolean }> }).revisionAttempts;
      expect(attempts[0].rejected).toBe(false);

      // No regression → no rollback of the original report version.
      expect(mockRestoreReportVersion).not.toHaveBeenCalled();
      // REPORT-002: the terminal state must reflect the PROMOTED verdict, not
      // the pre-revision one — a promoted PASS ships as delivered and the
      // artifact is never marked needs-review.
      const terminalAfterPromotion = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminalAfterPromotion?.[1]).toMatchObject({ status: 'completed', outcome: 'delivered' });
      expect(
        mockUpdateReport.mock.calls.find((c) => (c[1] as { reviewStatus?: string }).reviewStatus === 'needs-review')
      ).toBeUndefined();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
        ...EPISODE_FINALIZATION_IDENTITY,
        agentName: 'creator',
        status: 'completed',
        summary: IMPROVED_REVISION.slice(0, 500),
        legacySummary: 'original report draft with full body content for the regression-gate check.',
        missionOutcome: 'success',
      });
    });

    it('scores the revised draft over its report HTML, not the bare summary (symmetry with step 2.7)', async () => {
      // The revised L1 eval must concatenate the republished report HTML the
      // same way the initial evaluate-quality step does — otherwise the two
      // verdicts are computed over different check universes (HTML/entity-gated
      // structural/brand/JTBD checks fire on the HTML but not the summary) and
      // the regression gate compares apples to oranges.
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the symmetry check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      // Revised orchestrator result carries only a short summary + a report-id
      // reference; the real artifact lives in the published report HTML.
      const revisedSummary =
        'Revision complete — see report-abc123-def456 for the full comparison writeup with the corrected framing and expanded vendor coverage.';
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: revisedSummary,
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      const revisedReportHtml =
        '<h1>Vendor Comparison</h1><p>Full revised artifact body with the fixed JTBD framing.</p>';
      // The referenced report belongs to THIS mission — the free-text fallback
      // only accepts a report whose missionId matches (see below).
      mockGetReportById.mockResolvedValue({
        id: 'report-abc123-def456',
        missionId: 'mission-123',
        html: revisedReportHtml,
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // The revised evaluation must have been fed summary + HTML, not the summary alone.
      const evalCall = mockEvaluateMissionQuality.mock.calls.find((c) =>
        String((c[0] as { result?: string }).result ?? '').includes(revisedReportHtml)
      );
      expect(evalCall).toBeTruthy();
      expect((evalCall![0] as { result: string }).result).toContain(revisedSummary);
      expect(mockGetReportById).toHaveBeenCalledWith('report-abc123-def456', 'user-456');
    });

    it('never pulls a report from ANOTHER mission into the evaluation via an id in agent free text', async () => {
      // The id comes from model output, so a hallucinated or prompt-injected
      // reference must not drag an unrelated report's HTML into this mission's
      // quality verdict.
      seedQualityReport('REVISE', 'creator-jtbd-presence');
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'original draft mentioning report-zzz999-yyy888 which belongs to a different mission entirely.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      const foreignHtml = '<h1>Another mission artifact</h1><p>must never be evaluated here.</p>';
      mockGetReportById.mockResolvedValue({
        id: 'report-zzz999-yyy888',
        missionId: 'mission-OTHER',
        html: foreignHtml,
      });
      mockGetReportsByMissionId.mockResolvedValue([]);

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      const contaminated = mockEvaluateMissionQuality.mock.calls.find((c) =>
        String((c[0] as { result?: string }).result ?? '').includes(foreignHtml)
      );
      expect(contaminated).toBeUndefined();
    });
  });

  // MISSION-006: the resume-from-checkpoint describe was removed with the
  // dead branch it pinned — retries:0 makes attempt>0 unreachable, so the
  // handler no longer has a resume path (recovery = partial-recovery +
  // explicit re-dispatch/iterate).

  // ==========================================================================
  // MISSION-002 — replay safety + snapshot-failure recovery
  // ==========================================================================

  describe('MISSION-002 — replay safety + snapshot-failure recovery', () => {
    it('replay: the memoized revise-step return re-applies the promotion, so Step 4 finalizes the REVISED result', async () => {
      // Simulates an Inngest replay AFTER the revise step completed: the
      // step's callback is NOT executed — only its memoized return value is
      // handed back. Pre-fix the promotion lived in an in-step outer-state
      // mutation, so a replay finalized the ORIGINAL result; post-fix the
      // promotion is derived from the memoized return value.
      const REVISED = 'revised report draft — memoized promotion text, long enough to be a real deliverable body.';
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'original report draft with full body content for the replay check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      const innerRun = ctx.step.run.getMockImplementation()!;
      ctx.step.run.mockImplementation(async (name: string, fn: AnyFunction) => {
        if (name === 'revise-on-l1-fail') return REVISED; // memoized — callback skipped
        return innerRun(name, fn);
      });

      await getHandler()(ctx);

      // The revision orchestrator did NOT re-run (the step was memoized)…
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      // …and Step 4 finalized the promoted revision, not the original.
      const completedUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).status === 'completed')
        .pop();
      expect(completedUpdate).toBeTruthy();
      expect((completedUpdate![1] as { result?: string }).result).toBe(REVISED);
    });

    it('crash-window re-run: a step re-executed AFTER promotion re-returns the persisted promoted result', async () => {
      // The narrow hazard: the in-step updateMission({result: revised}) landed
      // but the process died before Inngest memoized the step's return. The
      // re-executed step hits the mission doc with a non-rejected attempt +
      // promoted result — it must RE-RETURN that promotion, not fall through
      // to the verdict/cap guards (which would null out and let Step 4
      // restore the original).
      const PROMOTED = 'previously promoted revision text persisted on the mission doc — full body.';
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        result: PROMOTED,
        revisionAttempts: [
          {
            attempt: 1,
            triggeredByVerdict: 'REVISE',
            failingChecks: ['creator-jtbd-presence'],
            feedback: 'fix it',
            costUsd: 0.5,
            durationMs: 1000,
            revisedAt: '2026-04-29T00:00:01.000Z',
            newVerdict: 'PASS',
            rejected: false,
          },
        ],
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:02.000Z',
          overallScore: 0.95,
          verdict: 'PASS', // post-promotion verdict — the old guard would exit null here
          checks: [],
        },
      });
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft that must NOT win the re-run.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      // No second revision dispatched…
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      // …and finalization carries the persisted promotion, not the original.
      const completedUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).status === 'completed')
        .pop();
      expect((completedUpdate![1] as { result?: string }).result).toBe(PROMOTED);
    });

    it('snapshot failure: the revision is skipped entirely — no restore path means no revision attempt', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [{ name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'gap' }],
        },
      });
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'original report draft with full body content for the snapshot-failure check.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
      // Compact owner-scoped identity resolution succeeds first, then the
      // independent pre-revision content snapshot dies. Regression restore
      // would be impossible, so the paid revision must not run at all.
      mockGetReportsByMissionId
        .mockResolvedValueOnce([{ id: 'report-original', missionId: 'mission-123', html: '<h1>Original report</h1>' }])
        .mockRejectedValueOnce(new Error('firestore unavailable during snapshot'))
        .mockResolvedValue([{ id: 'report-original', missionId: 'mission-123', html: '<h1>Original report</h1>' }]);
      mockGetReportById.mockResolvedValue({
        id: 'report-original',
        missionId: 'mission-123',
        html: '<h1>Original report</h1>',
      });

      const ctx = buildEventContext({ prompt: 'plain', agent: 'creator' });
      await getHandler()(ctx);

      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockCaptureReportVersionWithReceipt).not.toHaveBeenCalled();
      expect(mockGetReportsByMissionId.mock.calls.slice(0, 2)).toEqual([
        ['mission-123', 'user-456'],
        ['mission-123', 'user-456'],
      ]);
      // The mission still finalizes with the ORIGINAL result.
      const completedUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).status === 'completed')
        .pop();
      expect((completedUpdate![1] as { result?: string }).result).toContain('original report draft');
    });
  });

  // ==========================================================================
  // REPORT-002 — mission terminal truth (Step 4)
  // ==========================================================================

  describe('REPORT-002 — mission terminal truth', () => {
    it('memoizes compact owner-bound report identity without Report HTML or foreign event ownership', async () => {
      const reportHtmlSentinel = '<article>REPORT_BODY_MUST_NOT_ENTER_INNGEST_HISTORY</article>';
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'owner-compact',
        slots: [{ name: 'main-report', intent: 'the deliverable' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-22T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([
        {
          id: 'report-compact-1',
          ownerId: 'owner-compact',
          missionId: 'mission-123',
          html: reportHtmlSentinel,
        },
        { id: ' report-compact-1 ', ownerId: 'owner-compact', missionId: 'mission-123', html: 'duplicate' },
        { id: 'report-compact-2', ownerId: 'owner-compact', missionId: 'mission-123', html: 'second body' },
      ]);
      mockGetReportById.mockResolvedValue({
        id: 'report-compact-1',
        ownerId: 'owner-compact',
        missionId: 'mission-123',
        html: reportHtmlSentinel,
      });
      mockEvaluateMissionQuality.mockReturnValue({
        evaluatedAt: '2026-07-22T00:00:01.000Z',
        overallScore: 1,
        verdict: 'PASS',
        checks: [],
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'A complete mission summary whose canonical report body remains outside the memoized step payload.',
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });

      const ctx = buildEventContext({ userId: 'owner-compact', prompt: 'plain', agent: 'creator' });
      const innerRun = ctx.step.run.getMockImplementation()!;
      let memoizedReportTruth: unknown;
      ctx.step.run.mockImplementation(async (name: string, fn: AnyFunction) => {
        if (name === 'resolve-owner-scoped-report-truth') {
          memoizedReportTruth = await fn();
          return memoizedReportTruth;
        }
        return innerRun(name, fn);
      });

      await getHandler()(ctx);

      expect(memoizedReportTruth).toEqual({
        ownerId: 'owner-compact',
        promisedReport: true,
        resolution: { ok: true, reportIds: ['report-compact-1', 'report-compact-2'] },
        terminalState: {
          executionSucceeded: true,
          deliverable: {
            required: true,
            resolution: 'owner-visible',
            ownerVisibleArtifactIds: ['report-compact-1', 'report-compact-2'],
          },
        },
      });
      expect(JSON.stringify(memoizedReportTruth)).not.toContain(reportHtmlSentinel);
      expect(JSON.stringify(memoizedReportTruth)).not.toContain('"html"');
      expect(mockGetReportsByMissionId).toHaveBeenCalledWith('mission-123', 'owner-compact');
      expect(mockGetReportById).toHaveBeenCalledWith('report-compact-1', 'owner-compact');
      expect(mockUpdateMission).toHaveBeenCalledWith('mission-123', {
        reportId: 'report-compact-1',
        reportIds: ['report-compact-1', 'report-compact-2'],
      });
    });

    it('rejects an event user that does not match the persisted mission owner before reading any Report', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'stored-owner',
        slots: [{ name: 'main-report' }],
        classifierMetadata: { fallback: false },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'A completed result that must not authorize report access for the wrong dispatched user.',
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });

      await expect(
        getHandler()(buildEventContext({ userId: 'different-event-user', prompt: 'plain', agent: 'creator' }))
      ).rejects.toThrow('owner does not match the dispatched user');

      expect(mockPreflightMissionMcp).not.toHaveBeenCalled();
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockEmitAgentEvent).not.toHaveBeenCalled();
      expect(mockCreateEpisode).not.toHaveBeenCalled();
      expect(mockGetMissionUserPreferences).not.toHaveBeenCalled();
      expect(mockRunSkillSubMission).not.toHaveBeenCalled();
      expect(mockRunMission).not.toHaveBeenCalled();
      expect(mockGenerateContentWithMetadata).not.toHaveBeenCalled();
      expect(mockGetReportsByMissionId).not.toHaveBeenCalled();
      expect(mockGetReportById).not.toHaveBeenCalled();
      expect(mockEvaluateMissionQuality).not.toHaveBeenCalled();
      expect(mockCreateAgentRun).not.toHaveBeenCalled();
    });

    it('treats the durable report-pointer write as load-bearing before quality or revision work', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        slots: [{ name: 'main-report' }],
        classifierMetadata: { fallback: false },
      });
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-pointer-load', ownerId: 'user-456', missionId: 'mission-123', html: '<p>artifact</p>' },
      ]);
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'A completed result whose durable report pointer cannot be persisted.',
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });
      mockUpdateMission.mockImplementation(async (_missionId: string, update: Record<string, unknown>) => {
        if (Array.isArray(update.reportIds)) throw new Error('durable report pointer write failed');
      });

      await expect(getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }))).rejects.toThrow(
        'durable report pointer write failed'
      );

      expect(mockGetReportsByMissionId).toHaveBeenCalledWith('mission-123', 'user-456');
      expect(mockGetReportById).not.toHaveBeenCalled();
      expect(mockEvaluateMissionQuality).not.toHaveBeenCalled();
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockCreateAgentRun).not.toHaveBeenCalled();
    });

    it('distinguishes a promised-report lookup outage from proven absence and preserves prior pointers', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        reportId: 'report-prior-1',
        reportIds: ['report-prior-1'],
        outcome: 'delivered',
        slots: [{ name: 'main-report', intent: 'the deliverable' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
      });
      mockGetReportsByMissionId.mockRejectedValue(new Error('firestore deadline exceeded'));
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'The SDK completed, but Report availability cannot be proven during this terminal read.',
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });

      const handlerResult = await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(handlerResult).toMatchObject({ missionId: 'mission-123', success: false });
      expect(mockGetReportsByMissionId).toHaveBeenCalledWith('mission-123', 'user-456');
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockUpdateReport).not.toHaveBeenCalled();
      expect(mockGenerateContentWithMetadata).not.toHaveBeenCalled();
      expect(mockCreateReflection).not.toHaveBeenCalled();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: 'mission-123', status: 'failed' })
      );
      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          errors: expect.arrayContaining([expect.stringMatching(/owner-scoped Report lookup failed/i)]),
        })
      );
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({
        status: 'failed',
        progressMessage: 'Mission failed — Report lookup could not be verified',
      });
      expect(terminal?.[1]).not.toHaveProperty('reportId');
      expect(terminal?.[1]).not.toHaveProperty('reportIds');
      expect(terminal?.[2]).toEqual({ deleteFields: ['outcome'] });
    });

    it('keeps an unpromised legacy chain mission successful when the Report lookup is unavailable', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        reportId: 'report-prior-chain',
        reportIds: ['report-prior-chain'],
        slots: [{ name: 'main', intent: 'legacy default (no classifier)' }],
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-22T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [],
        },
      });
      mockEvaluateMissionQuality.mockReturnValue({
        evaluatedAt: '2026-07-22T00:00:01.000Z',
        overallScore: 1,
        verdict: 'PASS',
        checks: [],
      });
      mockGetReportsByMissionId.mockRejectedValue(new Error('firestore deadline exceeded'));
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'A chain-step summary with enough content to complete even though no report was promised.',
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });

      const handlerResult = await getHandler()(buildEventContext({ prompt: 'plain', agent: 'scout' }));

      expect(handlerResult).toMatchObject({ missionId: 'mission-123', success: true });
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({ status: 'completed', outcome: 'delivered' });
      expect(terminal?.[1]).not.toHaveProperty('reportId');
      expect(terminal?.[1]).not.toHaveProperty('reportIds');
    });

    it('quarantines an owner-visible report when the SDK fails after publication and mirrors failure truth', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        userId: 'user-456',
        slots: [{ name: 'main-report', intent: 'the deliverable' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-22T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [],
        },
      });
      const publishedReport = {
        id: 'report-before-sdk-failure',
        ownerId: 'user-456',
        missionId: 'mission-123',
        html: '<h1>Published before the SDK stream failed</h1>',
      };
      mockGetReportsByMissionId.mockResolvedValue([publishedReport]);
      mockGetReportById.mockResolvedValue(publishedReport);
      mockRunMission.mockResolvedValue({
        success: false,
        result: 'The report was published before the provider stream returned its terminal failure.',
        errors: ['provider stream failed after publish'],
        costUsd: 1,
        tokenUsage: { input: 100, output: 50 },
      });

      const handlerResult = await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(handlerResult).toMatchObject({ missionId: 'mission-123', success: false });
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockGenerateContentWithMetadata).not.toHaveBeenCalled();
      expect(mockCreateReflection).not.toHaveBeenCalled();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: 'mission-123', status: 'failed' })
      );
      expect(mockUpdateReport).toHaveBeenCalledWith(
        'report-before-sdk-failure',
        expect.objectContaining({
          reviewStatus: 'needs-review',
          shared: false,
          qualityGate: expect.objectContaining({ verdict: 'FAIL' }),
        }),
        { savedBy: 'agent:creator', requireOwnerId: 'user-456' }
      );
      const run = mockCreateAgentRun.mock.calls.at(-1)?.[0] as { status?: string; errors?: string[] };
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(run.status).toBe('failure');
      expect(terminal?.[1]).toMatchObject({
        status: 'failed',
        outcome: 'needs-review',
        reportId: 'report-before-sdk-failure',
        reportIds: ['report-before-sdk-failure'],
      });
      expect((terminal?.[1] as { errors?: string[] }).errors).toEqual(run.errors);
    });

    it('terminates a slotted mission with zero published reports as FAILED — never green', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report', intent: 'the deliverable' }],
        // A REAL classifier decision — this is what makes the slot manifest a
        // report PROMISE (a legacy/fallback 'main' slot is not; see the
        // chain-safety test below).
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [{ name: 'citations-present', pass: false, critical: false, detail: 'missing citations' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a long summary of work that claims completion but published no artifact at all — over 100 chars long.',
        costUsd: 3.08,
        tokenUsage: { input: 100, output: 50 },
      });

      const handlerResult = await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(handlerResult).toMatchObject({ missionId: 'mission-123', success: false });
      expect(mockGetReportsByMissionId).toHaveBeenCalledWith('mission-123', 'user-456');
      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
      expect(mockGenerateContentWithMetadata).not.toHaveBeenCalled();
      expect(mockCreateReflection).not.toHaveBeenCalled();
      expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: 'mission-123', status: 'failed' })
      );
      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({
        status: 'failed',
        outcome: 'no-deliverable',
        progressMessage: 'Mission finished without publishing its report deliverable',
        reportId: null,
        reportIds: [],
      });
      const errors = (terminal?.[1] as { errors?: string[] }).errors ?? [];
      expect(errors.join(' ')).toMatch(/no report was published/i);
      // The terminal event is honest too — no celebration for a missing artifact.
      expect(mockEmitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent.error', data: expect.objectContaining({ success: false }) })
      );
    });

    it('retains an unclean post-revision artifact as an owner-visible needs-review draft with the exact failed checks', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        // Cap reached — no further revision runs; the REVISE verdict is final.
        revisionAttempts: [
          {
            attempt: 1,
            triggeredByVerdict: 'REVISE',
            failingChecks: ['creator-brand-compliance'],
            feedback: 'fix brand',
            costUsd: 0.5,
            durationMs: 1000,
            revisedAt: '2026-07-18T00:00:01.000Z',
            newVerdict: 'REVISE',
            rejected: false,
          },
        ],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [
            { name: 'creator-brand-compliance', pass: false, critical: false, detail: '3 brand violation(s)' },
            { name: 'skill-adherence', pass: false, critical: false, detail: 'process heuristic' },
          ],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-live-1', title: 'The Deliverable', html: '<p>x</p>' },
      ]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'summary of the mission run that produced one report artifact — long enough for the result floor.',
        costUsd: 2.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      // The report is retained as a needs-review draft with ONLY the
      // substantive failed checks in its receipt (process heuristics excluded).
      expect(mockUpdateReport).toHaveBeenCalledWith(
        'report-live-1',
        expect.objectContaining({
          reviewStatus: 'needs-review',
          qualityGate: expect.objectContaining({
            verdict: 'REVISE',
            failingChecks: [expect.objectContaining({ name: 'creator-brand-compliance', critical: false })],
            repair: expect.stringMatching(/approve/i),
          }),
        }),
        { savedBy: 'agent:creator', requireOwnerId: 'user-456' }
      );

      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({
        status: 'completed',
        outcome: 'needs-review',
        progressMessage: 'Mission completed — report needs review',
        reportId: 'report-live-1',
        reportIds: ['report-live-1'],
      });
      // The run→report link uses the authenticated private route.
      expect((terminal?.[1] as { result?: string }).result).toContain('/reports/report-live-1');
      expect((terminal?.[1] as { result?: string }).result).toMatch(/needs review/i);
    });

    it('links the delivered report via /reports/{id} and keeps the durable reportId at terminal persistence', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [{ name: 'result-exists', pass: true, critical: true, detail: 'ok' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([{ id: 'report-clean-1', title: 'Clean', html: '<p>x</p>' }]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'summary of a clean run with a published artifact — comfortably above the minimum result length.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({
        status: 'completed',
        outcome: 'delivered',
        progressMessage: 'Mission completed',
        reportId: 'report-clean-1',
        reportIds: ['report-clean-1'],
        // The transient phase pointer clears; the durable identity stays.
        preliminaryReportId: null,
      });
      expect((terminal?.[1] as { result?: string }).result).toContain('Report: /reports/report-clean-1');
      // A clean delivery never marks the report needs-review.
      const needsReviewCall = mockUpdateReport.mock.calls.find(
        (c) => (c[1] as { reviewStatus?: string }).reviewStatus === 'needs-review'
      );
      expect(needsReviewCall).toBeUndefined();
    });

    it('does NOT fail a report-less mission whose slots are the legacy default (chain steps, classifier fallback)', async () => {
      // Chain steps call createMission with no slots, so missions.ts stamps
      // [{ name: 'main', intent: 'legacy default (no classifier)' }]. A scout
      // publishes no report document — treating that manifest as a report
      // promise would fail the step and halt the whole chain at step 1.
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main', intent: 'legacy default (no classifier)' }],
        // No classifierMetadata → no classifier ran → not a promise.
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [{ name: 'result-exists', pass: true, critical: true, detail: 'ok' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a scout bundle summary with plenty of body text to clear the minimum result length floor.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'scout' }));

      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({ status: 'completed', outcome: 'delivered' });
    });

    it('does NOT fail a report-less mission whose slot manifest came from the classifier fallback', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main', intent: 'fallback default (classifier failed)' }],
        classifierMetadata: { latencyMs: 5, costUsd: 0, fallback: true, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 1,
          verdict: 'PASS',
          checks: [{ name: 'result-exists', pass: true, critical: true, detail: 'ok' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a linker bundle summary with plenty of body text to clear the minimum result length floor.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'linker' }));

      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({ status: 'completed', outcome: 'delivered' });
    });

    it('writes the AgentRun row with the SAME terminal truth as the mission (no green pill on a failed run)', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report', intent: 'the deliverable' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [{ name: 'citations-present', pass: false, critical: false, detail: 'missing citations' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a summary claiming completion while publishing no artifact whatsoever — over the length floor.',
        costUsd: 3.08,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      // The run row must not celebrate a mission that delivered nothing.
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failure' }));
      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({ status: 'failed', outcome: 'no-deliverable' });
    });

    it('marks EVERY published slot needs-review, not just the newest', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report' }, { name: 'appendix' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [
          {
            attempt: 1,
            triggeredByVerdict: 'REVISE',
            failingChecks: ['creator-brand-compliance'],
            feedback: 'fix brand',
            costUsd: 0.5,
            durationMs: 1000,
            revisedAt: '2026-07-18T00:00:01.000Z',
            newVerdict: 'REVISE',
            rejected: false,
          },
        ],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [{ name: 'creator-brand-compliance', pass: false, critical: false, detail: '3 violations' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-main', title: 'Main', html: '<p>a</p>' },
        { id: 'report-appendix', title: 'Appendix', html: '<p>b</p>' },
      ]);
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a multi-slot mission summary with enough body text to clear the minimum result length floor.',
        costUsd: 2.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      for (const reportId of ['report-main', 'report-appendix']) {
        expect(mockUpdateReport).toHaveBeenCalledWith(
          reportId,
          expect.objectContaining({ reviewStatus: 'needs-review' }),
          { savedBy: 'agent:creator', requireOwnerId: 'user-456' }
        );
      }
    });

    it('fails both the AgentRun and mission when a report cannot be made private for review', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        slots: [{ name: 'main-report' }],
        classifierMetadata: { latencyMs: 10, costUsd: 0, fallback: false, model: 'test' },
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-07-18T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks: [{ name: 'creator-brand-compliance', pass: false, critical: false, detail: '3 violations' }],
        },
      });
      mockGetReportsByMissionId.mockResolvedValue([{ id: 'report-stuck', title: 'Stuck', html: '<p>a</p>' }]);
      mockUpdateReport.mockRejectedValueOnce(new Error('Report not found'));
      mockRunMission.mockResolvedValueOnce({
        success: true,
        result: 'a summary for a run whose artifact could not be withheld — long enough for the result floor.',
        costUsd: 2.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockUpdateReport).toHaveBeenCalledWith(
        'report-stuck',
        expect.objectContaining({ reviewStatus: 'needs-review', shared: false }),
        { savedBy: 'agent:creator', requireOwnerId: 'user-456' }
      );
      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          errors: expect.arrayContaining([expect.stringMatching(/could not be made private/i)]),
        })
      );
      const terminal = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).progress === 100)
        .pop();
      expect(terminal?.[1]).toMatchObject({
        status: 'failed',
        outcome: 'needs-review',
        progressMessage: 'Mission failed — report review isolation could not be enforced',
      });
      expect(((terminal?.[1] as { errors?: string[] }).errors ?? []).join(' ')).toMatch(/review them immediately/i);
    });
  });

  // ==========================================================================
  // MISSION-001 — active-orchestrator cancellation on wall-clock timeout
  // ==========================================================================

  describe('MISSION-001 — active-orchestrator cancellation', () => {
    it('wall-clock timeout aborts the ACTIVE orchestrator (it settles via abort) and persists billed usage', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(CAPTURED_START_MS));
      mockLoadAllProfiles.mockReturnValue(
        new Map([
          [
            'scout',
            {
              budget: { max_tokens: 20_000, max_tool_calls: 30 },
              mcp_servers: { internal: [], external: [] },
              timeoutMinutes: 1,
            },
          ],
        ])
      );
      const partialResult = 'Recovered checkpoint content from the active abort. '.repeat(4);
      mockGetMissionById.mockResolvedValue({ partialResult, partialCheckpointTurn: 2 });
      mockGetAccumulatedPartial.mockReturnValue({ partialResult, turn: 2 });

      // ACTIVE orchestrator: keeps "working" until abort() actually fires —
      // then it settles (a compliant SDK loop exits on the abort signal).
      // This is the cancellation proof the idle-hang test cannot give:
      // settlement is CAUSED by the abort call, and the billed usage snapshot
      // taken at abort time is what gets persisted.
      let settledViaAbort = false;
      let resolveRun!: (v: unknown) => void;
      let signalStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      mockRunMission.mockImplementation(() => {
        signalStarted();
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      });
      mockAbortMission.mockImplementation(() => {
        // Spend at the moment of cancellation — this is what must be billed.
        mockGetUsageSnapshot.mockReturnValue({
          costUsd: 0.77,
          tokenUsage: { input: 21_000, output: 4_200 },
        });
        settledViaAbort = true;
        resolveRun({ success: false, result: '', costUsd: 0, tokenUsage: { input: 0, output: 0 } });
      });

      try {
        const pending = getHandler()(buildEventContext({}, { executeOrchestrator: true }));
        await runStarted;
        expect(settledViaAbort).toBe(false); // still actively running pre-timeout
        await jest.advanceTimersByTimeAsync(60_000);
        const result = await pending;

        // The abort call is what terminated the in-flight orchestrator.
        expect(mockAbortMission).toHaveBeenCalledWith('wall-clock timeout / mission error');
        expect(settledViaAbort).toBe(true);

        expect(result).toMatchObject({ missionId: 'mission-123', success: false, duration: 60_000 });
        // Billed usage from the at-abort snapshot is persisted — not $0/0.
        expect(mockCreateAgentRun).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failure',
            duration: 60_000,
            costUsd: 0.77,
            tokenUsage: { input: 21_000, output: 4_200 },
          })
        );
        expect(mockUpdateMission).toHaveBeenCalledWith('mission-123', expect.objectContaining({ status: 'failed' }));
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
        mockAbortMission.mockReset();
        mockGetUsageSnapshot.mockReturnValue({ costUsd: 0, tokenUsage: { input: 0, output: 0 } });
      }
    });
  });

  describe('TEST-021 — nullable runtime cost bridge', () => {
    it('does not emit the BudgetState initial zero before the first onUsage snapshot', async () => {
      mockRunMission.mockImplementation(async () => {
        const options = mockOrchestratorConstruction.mock.calls.at(-1)?.[0] as {
          hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
        };
        const postToolUse = options.hooks?.PostToolUse?.at(-1)?.hooks[0];
        await postToolUse?.({
          tool_name: 'mcp__reports__list',
          tool_input: {},
          tool_response: { ok: true },
          tool_use_id: 'tool-before-usage',
        });
        return {
          success: true,
          result: 'mission output long enough to finish after the first tool event.',
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
        };
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      const toolEvent = mockEmitAgentEvent.mock.calls
        .map(([event]) => event as { type?: string; data?: Record<string, unknown> })
        .find((event) => event.type === 'agent.tool_call');
      expect(toolEvent?.data).toMatchObject({ costUnavailableReason: 'accounting-incomplete' });
      expect(toolEvent?.data).not.toHaveProperty('costUsd');
    });

    it('forwards nullable onUsage snapshots and their reason to BudgetState without coercion', async () => {
      mockRunMission.mockImplementation(async () => {
        const options = mockOrchestratorConstruction.mock.calls.at(-1)?.[0] as {
          onUsage?: (usage: {
            costUsd: number | null;
            tokenUsage: { input: number; output: number };
            costUnavailableReason?: string;
          }) => void;
        };
        options.onUsage?.({
          costUsd: null,
          tokenUsage: { input: 120, output: 30 },
          costUnavailableReason: 'model=unknown: no rate card',
        });
        return {
          success: true,
          result: 'mission output long enough to complete the nullable onUsage bridge test.',
          costUsd: null,
          costUnavailableReason: 'model=unknown: no rate card',
          tokenUsage: { input: 120, output: 30 },
        };
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      expect(mockBudgetUpdateCost).toHaveBeenCalledWith(
        null,
        expect.any(Number),
        expect.any(Number),
        150,
        'model=unknown: no rate card'
      );
    });

    it.each([
      { success: true, expectedStatus: 'success' },
      { success: false, expectedStatus: 'failure' },
    ])('persists a $expectedStatus result as unavailable, never as $0', async ({ success, expectedStatus }) => {
      mockRunMission.mockResolvedValue({
        success,
        result: 'mission output long enough to exercise terminal nullable-cost persistence.',
        costUsd: null,
        costUnavailableReason: 'model=unknown: no rate card',
        tokenUsage: { input: 100, output: 50 },
        ...(success ? {} : { errors: ['provider result failed'] }),
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      const run = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(run).toMatchObject({ status: expectedStatus, costUnavailableReason: 'unknown-pricing' });
      expect(run).not.toHaveProperty('costUsd');
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => ['completed', 'failed'].includes(String((call[1] as Record<string, unknown>).status)))
        .pop()?.[1] as Record<string, unknown>;
      expect(terminal).toMatchObject({
        costUnavailableReason: 'unknown-pricing',
        costUnavailableComponents: ['orchestrator'],
      });
      expect(terminal).not.toHaveProperty('costUsd');
      expect(terminal).not.toHaveProperty('costBreakdownUsd');
      const summary = mockImportedAgentLogger.info.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('[mission] id=mission-123 success='));
      expect(summary).toContain('cost=unavailable');
      expect(summary).not.toContain('cost=$0');
    });

    it('marks abort accounting incomplete when the snapshot throws before any onUsage callback', async () => {
      mockRunMission.mockRejectedValue(new Error('provider stream crashed'));
      mockGetUsageSnapshot.mockImplementation(() => {
        throw new Error('usage snapshot unavailable');
      });

      await getHandler()(buildEventContext({}, { executeOrchestrator: true }));

      const run = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(run).toMatchObject({ costUnavailableReason: 'accounting-incomplete' });
      expect(run).not.toHaveProperty('costUsd');
      const terminal = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).status === 'failed')
        .pop()?.[1] as Record<string, unknown>;
      expect(terminal).toMatchObject({
        costUnavailableReason: 'accounting-incomplete',
        costUnavailableComponents: ['orchestrator'],
      });
      expect(terminal).not.toHaveProperty('costUsd');
      expect(terminal).not.toHaveProperty('costBreakdownUsd');
    });
  });

  // ==========================================================================
  // ARUN-003 — honest model attribution + persisted modelUsage
  // ==========================================================================

  describe('ARUN-003 — model attribution on the AgentRun', () => {
    it('persists the SDK modelUsage breakdown and derives the primary model when result.model is absent', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'mission output long enough to clear the partial-content recovery gate for this test.',
        costUsd: 1.2,
        tokenUsage: { input: 1000, output: 500 },
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0.01 },
          'claude-opus-4-8': { inputTokens: 900, outputTokens: 450, cacheReadInputTokens: 200, costUSD: 1.19 },
        },
      });

      await getHandler()(buildEventContext());

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-8', // primary = most output tokens, NOT a Sonnet fallback
          modelUsage: expect.objectContaining({
            'claude-opus-4-8': expect.objectContaining({ outputTokens: 450 }),
          }),
        })
      );
    });

    it('persists requested/served divergence and settlement/exposure as separate facts', async () => {
      mockRunMission.mockResolvedValue({
        success: false,
        result: 'failed run with enough retained output to remain auditable after terminalization.',
        costUsd: 0.42,
        providerReportedCostUsd: 0.42,
        exposureUsd: 5.5,
        duplicateUsageEvents: 2,
        requestedModel: 'claude-opus-5',
        modelSubstitution: {
          requested: 'claude-opus-5',
          served: 'claude-opus-4-8',
          servedModels: ['claude-opus-4-8'],
          authorized: true,
          authorizedBy: 'explicit-pair',
        },
        tokenUsage: { input: 1000, output: 500 },
        modelUsage: {
          'claude-opus-4-8': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, costUSD: 0.42 },
        },
        errors: ['maximum budget'],
      });

      await getHandler()(buildEventContext());

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-8',
          requestedModel: 'claude-opus-5',
          providerReportedCostUsd: 0.42,
          exposureUsd: 5.5,
          duplicateUsageEvents: 2,
          modelSubstitution: expect.objectContaining({ authorizedBy: 'explicit-pair' }),
        })
      );
    });

    it('omits the model entirely when the result reports neither model nor modelUsage — never fabricates Sonnet', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'mission output long enough to clear the partial-content recovery gate for this test.',
        costUsd: 0.5,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext());

      const payload = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('model');
      expect(payload).not.toHaveProperty('modelUsage');
    });
  });

  // ==========================================================================
  // MISSION-005 — auxiliary Gemini costs fold into the total + breakdown
  // ==========================================================================

  describe('MISSION-005 — auxiliary cost accounting', () => {
    it('folds judge/fact-check/reflection costs into the AgentRun + mission totals with an exact breakdown', async () => {
      // The aux steps persist their spend on the mission doc; Step 3's re-read
      // (the same one that loads revisionAttempts) picks them up.
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [],
        judgeCostUsd: 0.03,
        factCheckCostUsd: 0.05,
        reflectionCostUsd: 0.002,
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: 0.95,
          verdict: 'PASS',
          checks: [],
        },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'mission output long enough to clear the partial-content recovery gate for this test.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext());

      // AgentRun bill = orchestrator + judge + fact-check + reflection.
      expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ costUsd: expect.closeTo(1.082, 6) }));
      // Mission doc carries the same total + an exactly-summing breakdown.
      const completedUpdate = mockUpdateMission.mock.calls
        .filter((c) => (c[1] as Record<string, unknown>).status === 'completed')
        .pop();
      const update = completedUpdate![1] as {
        costUsd: number;
        costBreakdownUsd: Record<string, number>;
      };
      expect(update.costUsd).toBeCloseTo(1.082, 6);
      expect(update.costBreakdownUsd).toEqual({
        orchestrator: 1.0,
        classifier: 0,
        prelude: 0,
        revisions: 0,
        judge: 0.03,
        factCheck: 0.05,
        reflection: 0.002,
      });
      const summed = Object.values(update.costBreakdownUsd).reduce((s, v) => s + v, 0);
      expect(summed).toBeCloseTo(update.costUsd, 6); // no double counting
      const completionEvent = mockEmitAgentEvent.mock.calls
        .map(([event]) => event as { type?: string; data?: { costUsd?: number } })
        .find((event) => event.type === 'agent.completed');
      expect(completionEvent?.data?.costUsd).toBeCloseTo(1.082, 6);
    });

    it('marks the whole mission cost unavailable when any paid component is unpriced', async () => {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [],
        judgeCostUsd: 0.03,
        costUnavailableComponents: ['factCheck'],
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'mission output long enough to clear the partial-content recovery gate for this test.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });

      await getHandler()(buildEventContext());

      const run = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
      expect(run).toMatchObject({ costUnavailableReason: 'unknown-pricing' });
      expect(run).not.toHaveProperty('costUsd');

      const completedUpdate = mockUpdateMission.mock.calls
        .filter((call) => (call[1] as Record<string, unknown>).status === 'completed')
        .pop()?.[1] as Record<string, unknown>;
      expect(completedUpdate).toMatchObject({
        costUnavailableReason: 'unknown-pricing',
        costUnavailableComponents: ['factCheck'],
      });
      expect(completedUpdate).not.toHaveProperty('costUsd');
      expect(completedUpdate).not.toHaveProperty('costBreakdownUsd');
      const completionEvent = mockEmitAgentEvent.mock.calls
        .map(([event]) => event as { type?: string; data?: Record<string, unknown> })
        .find((event) => event.type === 'agent.completed');
      expect(completionEvent?.data).toMatchObject({
        costUnavailableReason: 'unknown-pricing',
        costUnavailableComponents: ['factCheck'],
      });
      expect(completionEvent?.data).not.toHaveProperty('costUsd');
    });
  });

  // ==========================================================================
  // MISSION-003 — substantive, artifact-aware revision
  // ==========================================================================

  describe('MISSION-003 — substantive, artifact-aware revision', () => {
    function seedReviseReport(checks: Array<{ name: string; pass: boolean; critical: boolean; detail: string }>) {
      mockGetMissionById.mockResolvedValue({
        id: 'mission-123',
        skillPrelude: [],
        revisionAttempts: [],
        qualityReport: {
          evaluatedAt: '2026-04-29T00:00:00.000Z',
          overallScore: 0.6,
          verdict: 'REVISE',
          checks,
        },
      });
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'original report draft with enough body to clear the partial recovery floor for this test.',
        costUsd: 1.0,
        tokenUsage: { input: 100, output: 50 },
      });
    }

    it('does NOT spend a revision turn when only process heuristics fail (skill-adherence / not-partial)', async () => {
      seedReviseReport([
        { name: 'skill-adherence', pass: false, critical: false, detail: 'no Skill() calls' },
        { name: 'not-partial', pass: false, critical: false, detail: 'partial recovery' },
      ]);

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
    });

    it('the revision brief names the existing deliverables (Report IDs + slots) to revise in place', async () => {
      seedReviseReport([{ name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'lacks JTBD content' }]);
      mockGetReportsByMissionId.mockResolvedValue([
        { id: 'report-abc', html: '<h1>Draft</h1>', slotName: 'main-report', title: 'AI Radar Brief' },
      ]);
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: 'revised draft long enough to clear the floor with substantially reworked JTBD content.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockRunRevisionOrchestrator).toHaveBeenCalledTimes(1);
      const params = mockRunRevisionOrchestrator.mock.calls[0][0] as { prompt: string };
      expect(params.prompt).toContain('EXISTING DELIVERABLES');
      expect(params.prompt).toContain('Report report-abc');
      expect(params.prompt).toContain('slot: main-report');
      // REPORT-004: the brief carries the immutable prior-version identity and
      // the exact-HTML loading instruction (metadata-only loads rebuilt blind).
      expect(params.prompt).toContain('prior version ver-report-abc');
      expect(params.prompt).toContain('includeHtml: true');
    });

    it('clamps an oversized REVISION_MAX_COST_USD env override to the mission cap', async () => {
      const prev = process.env.REVISION_MAX_COST_USD;
      process.env.REVISION_MAX_COST_USD = '5000';
      try {
        seedReviseReport([
          { name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'lacks JTBD content' },
        ]);
        mockRunRevisionOrchestrator.mockResolvedValueOnce({
          success: true,
          result: 'revised draft long enough to clear the floor with substantially reworked JTBD content.',
          costUsd: 0.5,
          tokenUsage: { input: 80, output: 60 },
        });

        await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

        const params = mockRunRevisionOrchestrator.mock.calls[0][0] as { maxBudgetUsd: number };
        // "revise can't cost more than the original" is now enforced, not asserted.
        expect(params.maxBudgetUsd).toBeLessThanOrEqual(15); // MISSION_MAX_COST_USD default
      } finally {
        if (prev === undefined) delete process.env.REVISION_MAX_COST_USD;
        else process.env.REVISION_MAX_COST_USD = prev;
      }
    });

    it('uses the memoized replay envelope for the paid revision turn', async () => {
      seedReviseReport([{ name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'lacks JTBD content' }]);
      mockRunRevisionOrchestrator.mockResolvedValueOnce({
        success: true,
        result: 'revised draft long enough to clear the floor with substantially reworked JTBD content.',
        costUsd: 0.5,
        tokenUsage: { input: 80, output: 60 },
      });
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 4,
        revisionMaxCostUsd: 0.75,
        preludeMaxCostUsd: 1,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 7.75,
      };

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }, { memoizedCostEnvelope }));

      expect(mockRunRevisionOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 0.75 }));
    });

    it('skips the paid revision turn entirely when the authorized revision allocation is zero', async () => {
      seedReviseReport([{ name: 'creator-jtbd-presence', pass: false, critical: false, detail: 'lacks JTBD content' }]);
      const memoizedCostEnvelope: TestCostEnvelope = {
        orchestratorMaxCostUsd: 13,
        revisionMaxCostUsd: 0,
        preludeMaxCostUsd: 2,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 17,
      };

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }, { memoizedCostEnvelope }));

      expect(mockRunRevisionOrchestrator).not.toHaveBeenCalled();
    });
  });

  describe('ARUN-022 — mission usage receipt flush', () => {
    beforeEach(() => {
      (flushMissionUsageReceipts as jest.Mock).mockClear();
      // Restore a safe default so later tests are not contaminated by a failure fixture.
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'x'.repeat(200),
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });
    });

    afterEach(() => {
      // Contain our failure fixtures so later sibling tests see the default success path.
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'x'.repeat(200),
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      });
    });

    it('passes through SDK-reported per-model modelUsage', async () => {
      mockRunMission.mockResolvedValue({
        success: true,
        result: 'x'.repeat(200),
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
        modelUsage: {
          'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0.01 },
        },
      });

      await getHandler()(buildEventContext());

      expect(flushMissionUsageReceipts).toHaveBeenCalled();
      const args = (flushMissionUsageReceipts as jest.Mock).mock.calls[0][0] as {
        modelUsage: Record<string, unknown>;
      };
      expect(args.modelUsage['claude-sonnet-4']).toMatchObject({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        costUSD: 0.01,
      });
      expect(args.modelUsage['claude-sonnet-4']).not.toHaveProperty('cacheCreationInputTokens');
    });

    it('synthesizes a partial model entry from aggregate tokenUsage when per-model breakdown is missing', async () => {
      mockRunMission.mockResolvedValue({
        success: false,
        result: null,
        costUsd: 0.02,
        tokenUsage: { input: 500, output: 100 },
        errors: ['timeout'],
      });

      await getHandler()(buildEventContext());

      expect(flushMissionUsageReceipts).toHaveBeenCalled();
      const args = (flushMissionUsageReceipts as jest.Mock).mock.calls[0][0] as {
        modelUsage: Record<string, unknown>;
      };
      expect(args.modelUsage['unknown']).toMatchObject({
        inputTokens: 500,
        outputTokens: 100,
        costUSD: 0.02,
      });
      expect(args.modelUsage['unknown']).not.toHaveProperty('cacheReadInputTokens');
    });

    it('omits costUSD from the synthetic entry when only tokenUsage is known', async () => {
      mockRunMission.mockResolvedValue({
        success: false,
        result: null,
        costUsd: null,
        tokenUsage: { input: 30, output: 10 },
        errors: ['abort'],
      });

      await getHandler()(buildEventContext());

      const args = (flushMissionUsageReceipts as jest.Mock).mock.calls[0][0] as {
        modelUsage: Record<string, unknown>;
      };
      expect(args.modelUsage['unknown']).toMatchObject({
        inputTokens: 30,
        outputTokens: 10,
      });
      expect(args.modelUsage['unknown']).not.toHaveProperty('costUSD');
      expect(args.modelUsage['unknown']).not.toHaveProperty('cacheReadInputTokens');
    });
  });

  describe('ARUN-014 — processing-phase telemetry', () => {
    it('binds design-pass quality evidence to the independently hashed canonical report bytes', async () => {
      const html = '<article><h1>Exact reviewed export</h1></article>';
      const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
      const report = {
        id: 'report-reviewed',
        missionId: 'mission-123',
        html,
        artifactIdentity: {
          sha256,
          revisionNumber: 1,
          reviewedBy: ['design-pass', 'critique-report'] as const,
        },
        designPassVerdict: 'PASS' as const,
        designPassDetails: 'Exact staged export reviewed.',
      };
      mockGetReportsByMissionId.mockResolvedValue([report]);
      mockGetReportById.mockResolvedValue(report);

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      expect(mockEvaluateMissionQuality).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactEvidence: {
            reportId: 'report-reviewed',
            sha256,
            revisionNumber: 1,
            reviewedBy: ['design-pass', 'critique-report'],
            designPassVerdict: 'PASS',
            designPassDetails: 'Exact staged export reviewed.',
          },
          artifactIdentity: { reportId: 'report-reviewed', sha256, revisionNumber: 1 },
        })
      );
    });

    it('persists a quality-review phase (with the preliminary report link) during evaluate-quality', async () => {
      // REPORT-002: durable identity is load-bearing and lands before the
      // best-effort phase telemetry; neither comes from a result-text regex.
      mockGetReportsByMissionId.mockResolvedValue([{ id: 'report-prelim', html: '<p>artifact</p>' }]);

      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      const identityWriteIndex = mockUpdateMission.mock.calls.findIndex(
        (call) => (call[1] as Record<string, unknown>).reportId === 'report-prelim'
      );
      const qualityPhaseWriteIndex = mockUpdateMission.mock.calls.findIndex(
        (call) => (call[1] as Record<string, unknown>).phase === 'quality-review'
      );
      const qualityPhaseWrite = mockUpdateMission.mock.calls[qualityPhaseWriteIndex];
      expect(identityWriteIndex).toBeGreaterThanOrEqual(0);
      expect(identityWriteIndex).toBeLessThan(qualityPhaseWriteIndex);
      expect(mockUpdateMission.mock.calls[identityWriteIndex]?.[1]).toMatchObject({
        reportId: 'report-prelim',
        reportIds: ['report-prelim'],
      });
      expect(qualityPhaseWrite).toBeDefined();
      expect(qualityPhaseWrite?.[1]).toMatchObject({
        phase: 'quality-review',
        preliminaryReportId: 'report-prelim',
      });
    });

    it('clears the phase at terminal persistence so the UI stops showing a processing state', async () => {
      await getHandler()(buildEventContext({ prompt: 'plain', agent: 'creator' }));

      const terminal = mockUpdateMission.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>).status === 'completed'
      );
      expect(terminal?.[1]).toMatchObject({ phase: null });
    });
  });
});

// ---------------------------------------------------------------------------
// A halted chain must not leave downstream steps
// 'pending' forever — they are marked failed with the halt reason so the Runs
// and Missions surfaces tell the truth.
// ---------------------------------------------------------------------------
describe('advance-chain halt (T1.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMission.mockResolvedValue(undefined);
    mockCreateAgentRun.mockResolvedValue({ id: 'run-123' });
    mockRecordMissionFailureFallback.mockResolvedValue({ written: true, reason: 'created' });
    mockCreateEpisode.mockResolvedValue({ id: 'ep-test-1' });
    mockCompleteEpisode.mockResolvedValue(undefined);
    mockFailEpisode.mockResolvedValue(undefined);
    mockFinalizeMissionEpisode.mockResolvedValue(undefined);
    mockGetUsageSnapshot.mockReturnValue({ costUsd: 0, tokenUsage: { input: 0, output: 0 } });
    mockGetAccumulatedPartial.mockReturnValue({ partialResult: '', turn: 0 });
    mockEvaluateMissionQuality.mockImplementation((arg: unknown) => actualMissionQuality.evaluateMissionQuality(arg));
    mockGetReportsByMissionId.mockResolvedValue([]);
    mockUpdateReport.mockResolvedValue(undefined);
    mockGetReportById.mockResolvedValue(null);
    // Restore the default pre-revision receipt. Without this a test that pins a
    // specific `htmlSha256` (REPORT-020's byte-identity case must) leaks it into
    // every later test, since this mock carries a default IMPLEMENTATION rather
    // than a queued value, and clearing mocks does not restore implementations.
    mockCaptureReportVersionWithReceipt.mockImplementation(async (reportId: string) => ({
      versionId: `ver-${reportId}`,
      versionNumber: 1,
      htmlLength: 42,
      htmlSha256: 'a'.repeat(64),
    }));
    mockParseScoutBundle.mockReturnValue({ ok: false, error: 'no bundle in test default' });
    mockRunRevisionOrchestrator.mockResolvedValue({ success: false, errors: ['default'] });
    mockLoadAllProfiles.mockReturnValue(new Map());
    mockRunMission.mockResolvedValue({
      success: true,
      result: 'Chain step result — long enough to skip partial recovery. ' + 'x'.repeat(120),
      tokenUsage: { input: 1000, output: 500 },
      costUsd: 0.05,
    });
  });

  it('marks downstream pending chain steps failed when the chain halts', async () => {
    mockGetMissionById.mockResolvedValue({
      id: 'mission-123',
      chainId: 'chain-x',
      chainStep: 1,
      status: 'completed',
      qualityReport: { verdict: 'FAIL', overallScore: 0.5 },
    });
    mockShouldAdvanceChain.mockReturnValue(false);
    mockFindNextChainStep
      .mockResolvedValueOnce({ id: 'mission-next', status: 'pending', chainStep: 2, chainId: 'chain-x' })
      .mockResolvedValueOnce(null);

    const ctx = buildEventContext();
    await getHandler()(ctx);

    expect(mockUpdateMission).toHaveBeenCalledWith(
      'mission-next',
      expect.objectContaining({
        status: 'failed',
        errors: [expect.stringContaining('chain halted upstream')],
      })
    );
  });

  it('does not touch downstream steps that already ran', async () => {
    mockGetMissionById.mockResolvedValue({
      id: 'mission-123',
      chainId: 'chain-x',
      chainStep: 1,
      status: 'completed',
      qualityReport: { verdict: 'FAIL', overallScore: 0.5 },
    });
    mockShouldAdvanceChain.mockReturnValue(false);
    mockFindNextChainStep
      .mockResolvedValueOnce({ id: 'mission-done', status: 'completed', chainStep: 2, chainId: 'chain-x' })
      .mockResolvedValueOnce(null);

    const ctx = buildEventContext();
    await getHandler()(ctx);

    const failedUpdates = mockUpdateMission.mock.calls.filter(
      (c: unknown[]) => c[0] === 'mission-done' && (c[1] as { status?: string }).status === 'failed'
    );
    expect(failedUpdates).toHaveLength(0);
  });
});
