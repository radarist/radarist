/**
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

const mockCreateMission = jest.fn();
const mockUpdateMission = jest.fn();
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  createMission: (...args: unknown[]) => mockCreateMission(...args),
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
}));

// BUILD-036: mock only the admin-backed resolver wrapper; keep the pure core.
const mockResolveBuildContextForUser = jest.fn();
jest.mock('@/lib/build-mission-context', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/build-mission-context'),
  resolveBuildContextForUser: (...args: unknown[]) => mockResolveBuildContextForUser(...args),
}));

const mockComposeBrief = jest.fn();
jest.mock('@/lib/build-mission-eval-brief', () => ({
  __esModule: true,
  composeEvaluationBrief: (...args: unknown[]) => mockComposeBrief(...args),
}));

const mockInngestSend = jest.fn();
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

const mockClassifyMissionIntent = jest.fn();
jest.mock('@/lib/ai/mission-intent-classifier', () => ({
  __esModule: true,
  classifyMissionIntent: (...args: unknown[]) => mockClassifyMissionIntent(...args),
}));

// OPS-004: startMission runs the MCP preflight BEFORE the paid gate/classifier.
// Default healthy so existing dispatch/confirmation tests are unaffected.
const mockPreflightMissionMcp = jest.fn();
jest.mock('@/lib/mission-mcp-preflight', () => ({
  __esModule: true,
  preflightMissionMcp: (...args: unknown[]) => mockPreflightMissionMcp(...args),
  formatMcpPreflightFailure: (r: { reason?: string; unreachable: string[] }) =>
    `${r.reason ?? 'mcp-preflight-failed'}: ${r.unreachable.join(', ')}`,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

const mockLoadBuildConfig = jest.fn((_opts?: unknown) => ({
  budget: { missionCapUsd: 25 },
  limitless: { missionCapUsd: 50, reviewerMaxCostUsd: 10 },
}));
// COORD-012: the dispatch surface folds the target agent's profile budget,
// timeout, and resolved model into the confirmed execution envelope. Default
// mock returns an empty map (profile unknown → environment defaults).
const DEFAULT_DISPATCH_PROFILES = (): Map<string, unknown> =>
  new Map(
    ['scout', 'creator', 'evaluator', 'linker', 'strategist', 'curator'].map((name) => [
      name,
      { model: 'claude-sonnet-5', budget: { max_tokens: 50_000, max_tool_calls: 100 }, timeoutMinutes: 45 },
    ])
  );
const mockDispatchLoadAllProfiles = jest.fn((): Map<string, unknown> => DEFAULT_DISPATCH_PROFILES());
jest.mock('@/lib/agent-import', () => ({
  __esModule: true,
  importSandbox: async () => ({ loadBuildConfig: (opts?: unknown) => mockLoadBuildConfig(opts) }),
  importOrchestrator: async () => ({ loadAllProfiles: () => mockDispatchLoadAllProfiles() }),
}));

// firebase-admin is imported transitively by missions.ts; mock to break chain
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {},
}));

// AI-053: executeStartMission now dispatches through the REAL
// @/lib/mission-research-gate — deliberately NOT mocked, so the gate decision is
// exercised end-to-end by these tests. Its gated branch reaches createChain,
// which would hit the `db: {}` stub above; mock the chain writer instead.
const mockCreateChain = jest.fn();
jest.mock('@/lib/mission-chains', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/mission-chains'),
  createChain: (...args: unknown[]) => mockCreateChain(...args),
}));

// AI-053: pin WHICH mission the one-time classifier spend correlates to.
const mockFlushMissionStageUsage = jest.fn();
jest.mock('@/lib/mission-stage-usage', () => ({
  __esModule: true,
  flushMissionStageUsage: (...args: unknown[]) => mockFlushMissionStageUsage(...args),
}));

// BUILD-019: the iterate executor delegates to the shared core (same module
// the API route uses) — mocked here so executor tests pin the WRAPPER contract.
const mockIterateBuildMission = jest.fn();
jest.mock('@/lib/build-mission-iterate', () => ({
  iterateBuildMission: (...a: unknown[]) => mockIterateBuildMission(...a),
}));

// BUILD-005: the approve executor delegates to the outcome-bearing admin core
// (same module the /api/triage/assessments route wraps) — mocked here so the
// executor tests pin the WRAPPER contract (honest outcome → honest message).
const mockApproveWithOutcome = jest.fn();
const mockGetProposedAssessments = jest.fn();
jest.mock('@/lib/proposed-assessments-admin', () => ({
  approveProposedAssessmentWithOutcome: (...a: unknown[]) => mockApproveWithOutcome(...a),
  getProposedAssessments: (...a: unknown[]) => mockGetProposedAssessments(...a),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  MISSION_TOOLS,
  executeStartMission,
  executeDispatchTechnologyEvaluation,
  executeDispatchBuildMission,
  executeIterateBuildArtifact,
  executeApproveAssessment,
} from '../mission-tools';
import { _resetConfirmationStore } from '@/lib/ai/destructive-confirmation';

const HUMAN_PAID_SESSION_ID = 'human-paid-session-0001';

// ============================================================================
// Tests
// ============================================================================

describe('Mission Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmationStore();
    mockLoadBuildConfig.mockReturnValue({
      budget: { missionCapUsd: 25 },
      limitless: { missionCapUsd: 50, reviewerMaxCostUsd: 10 },
    });
    mockClassifyMissionIntent.mockResolvedValue({
      slots: [{ name: 'main', intent: 'test mission' }],
      metadata: { latencyMs: 1, costUsd: 0, fallback: false, model: 'test-classifier' },
    });
    mockPreflightMissionMcp.mockResolvedValue({
      ok: true,
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
      unreachable: [],
      reason: undefined,
    });
    mockInngestSend.mockResolvedValue(undefined);
  });

  // --------------------------------------------------------------------------
  // Tool declarations
  // --------------------------------------------------------------------------
  describe('MISSION_TOOLS declarations', () => {
    it('exports the mission tools (start/status/list + getArtifactFindings + build dispatchers + iterate + approve)', () => {
      expect(MISSION_TOOLS).toHaveLength(8);
      expect(MISSION_TOOLS.map((t) => t.name)).toContain('getArtifactFindings');
      expect(MISSION_TOOLS.map((t) => t.name)).toContain('dispatchTechnologyEvaluation');
      expect(MISSION_TOOLS.map((t) => t.name)).toContain('dispatchBuildMission');
      expect(MISSION_TOOLS.map((t) => t.name)).toContain('iterateBuildArtifact');
      expect(MISSION_TOOLS.map((t) => t.name)).toContain('approveAssessment');
    });

    it('marks paid dispatch confirmation as machine-only in every paid schema', () => {
      for (const name of [
        'startMission',
        'dispatchTechnologyEvaluation',
        'dispatchBuildMission',
        'iterateBuildArtifact',
      ]) {
        const tool = MISSION_TOOLS.find((candidate) => candidate.name === name);
        const props = tool?.parameters?.properties as Record<string, { description?: string }>;
        expect(props.confirmed?.description).toMatch(/automated\/non-chat callers only/i);
        expect(tool?.description).toContain('CONFIRM SPEND');
        expect(tool?.description).toContain('IDENTICAL arguments');
      }
    });

    it('approveAssessment declares no hard-required args — assessmentId OR technologyId, enforced by the executor', () => {
      const tool = MISSION_TOOLS.find((t) => t.name === 'approveAssessment');
      expect(tool?.parameters?.required).toEqual([]);
      const props = tool?.parameters?.properties as Record<string, unknown>;
      expect(props).toHaveProperty('assessmentId');
      expect(props).toHaveProperty('technologyId');
      expect(props).toHaveProperty('radarId');
      expect(props).toHaveProperty('quadrantId');
    });

    it('should define startMission with correct name', () => {
      const tool = MISSION_TOOLS[0];
      expect(tool.name).toBe('startMission');
    });

    it('should have a non-empty description', () => {
      const tool = MISSION_TOOLS[0];
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(20);
    });

    it('should require prompt and agent parameters', () => {
      const tool = MISSION_TOOLS[0];
      expect(tool.parameters?.required).toEqual(expect.arrayContaining(['prompt', 'agent']));
    });

    it('should define prompt and agent as string properties', () => {
      const tool = MISSION_TOOLS[0];
      const props = tool.parameters?.properties as Record<string, { type: string }>;
      expect(props).toHaveProperty('prompt');
      expect(props).toHaveProperty('agent');
    });
  });

  // --------------------------------------------------------------------------
  // executeStartMission
  // --------------------------------------------------------------------------
  describe('executeStartMission', () => {
    const mockMission = {
      id: 'mission-test-123',
      userId: 'user-456',
      prompt: 'Research competitive landscape for AI startups',
      agent: 'scout',
      status: 'pending',
      progress: 0,
      entities: [],
      sources: [],
      createdAt: '2026-02-23T12:00:00.000Z',
    };

    beforeEach(() => {
      mockCreateMission.mockResolvedValue(mockMission);
    });

    it('OPS-004: refuses with a machine-readable reason BEFORE the paid gate/classifier when MCP is unreachable', async () => {
      mockPreflightMissionMcp.mockResolvedValue({
        ok: false,
        reason: 'mcp-preflight-failed',
        baseUrl: 'http://127.0.0.1:9002/api/mcp',
        checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
        unreachable: ['reports'],
      });

      const result = await executeStartMission(
        { prompt: 'Research competitive landscape for AI startups', agent: 'scout', confirmed: true },
        'user-456'
      );

      expect(result.dispatched).toBe(false);
      // Machine-readable reason, not only free-form message.
      expect(result.reason).toBe('mcp-preflight-failed');
      // The refusal precedes the paid classifier and dispatch, and does not
      // require/consume a confirmation.
      expect(result.requiresConfirmation).toBeUndefined();
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should create mission and fire Inngest event', async () => {
      const result = await executeStartMission(
        { prompt: 'Research competitive landscape for AI startups', agent: 'scout', confirmed: true },
        'user-456'
      );

      // Chat path now invokes the classifier (Phase B+ fix). createMission
      // receives the classifier output as a third arg. We don't assert the
      // exact shape because the classifier may fall back to a default when
      // the AI client is mocked or unavailable in tests — what matters is
      // that the manifest extras are threaded through.
      expect(mockCreateMission).toHaveBeenCalledWith(
        'user-456',
        { prompt: 'Research competitive landscape for AI startups', agent: 'scout' },
        expect.objectContaining({
          slots: expect.any(Array),
          classifierMetadata: expect.objectContaining({
            fallback: expect.any(Boolean),
            model: expect.any(String),
          }),
          authorizedMaxCostUsd: 31,
        })
      );

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/mission.run.requested',
        data: {
          missionId: 'mission-test-123',
          userId: 'user-456',
          prompt: 'Research competitive landscape for AI startups',
          agent: 'scout',
        },
      });

      expect(result.missionId).toBe('mission-test-123');
    });

    it('persists visual ambition through the normal Assistant mission tool', async () => {
      await executeStartMission(
        {
          prompt: 'Create an executive decision dossier',
          agent: 'creator',
          visualAmbition: 'rich-executive',
          confirmed: true,
        },
        'user-456'
      );
      expect(mockCreateMission).toHaveBeenCalledWith(
        'user-456',
        expect.objectContaining({
          designBrief: { visualAmbition: 'rich-executive', source: 'user' },
        }),
        expect.any(Object)
      );
    });

    it('should return missionId and message', async () => {
      const result = await executeStartMission(
        { prompt: 'Analyze technology trends', agent: 'evaluator', confirmed: true },
        'user-789'
      );

      expect(result).toHaveProperty('missionId');
      expect(result).toHaveProperty('message');
      expect(typeof result.missionId).toBe('string');
      expect(typeof result.message).toBe('string');
    });

    it('should include agent name in the message', async () => {
      const result = await executeStartMission(
        { prompt: 'Find related entities', agent: 'linker', confirmed: true },
        'user-789'
      );

      expect(result.message).toContain('linker');
    });

    it('should truncate long prompts in the message', async () => {
      const longPrompt = 'A'.repeat(200);
      const result = await executeStartMission(
        { prompt: longPrompt, agent: 'strategist', confirmed: true },
        'user-789'
      );

      // The message should contain only the first 100 chars of the prompt
      expect(result.message).toContain('A'.repeat(100));
      expect(result.message).not.toContain('A'.repeat(101));
    });

    it('should throw if userId is not provided', async () => {
      await expect(
        executeStartMission(
          { prompt: 'Test prompt', agent: 'scout' },
          '' // empty string
        )
      ).rejects.toThrow('startMission requires an authenticated user');
    });

    it('should reject an invalid agent name BEFORE any dispatch (zero-cost validation)', async () => {
      await expect(
        executeStartMission({ prompt: 'Test prompt', agent: 'nonexistent-agent' }, 'user-456')
      ).rejects.toThrow(/Unknown agent 'nonexistent-agent'/);

      // No mission record, no Inngest event — the request must cost nothing
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should list valid agents in the invalid-agent error', async () => {
      await expect(executeStartMission({ prompt: 'Test prompt', agent: 'wizard' }, 'user-456')).rejects.toThrow(
        /scout.*evaluator.*linker.*curator.*strategist.*creator/
      );
    });

    it('should reject an empty prompt before any dispatch', async () => {
      await expect(executeStartMission({ prompt: '   ', agent: 'scout' }, 'user-456')).rejects.toThrow(
        'startMission requires a non-empty prompt'
      );
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('fails closed for a machine caller until confirmed:true is explicit', async () => {
      const result = await executeStartMission(
        { prompt: 'Research quantum sensing', agent: 'creator' },
        'machine-user'
      );

      expect(result).toMatchObject({
        dispatched: false,
        requiresConfirmation: true,
        amountUsd: 31,
      });
      expect(result.confirmationPhrase).toMatch(/^CONFIRM SPEND \$31 startMission%3A/);
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('ignores human self-confirmation and same-turn retries, accepts the exact next turn once, then rejects replay', async () => {
      const args = {
        prompt: 'Research quantum sensing',
        agent: 'creator',
        theme: 'brand-dark',
        confirmed: true,
      } as const;
      const first = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: 'I approve',
      });

      expect(first.dispatched).toBe(false);
      expect(first.confirmationPhrase).toMatch(/^CONFIRM SPEND \$31 startMission%3A/);
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();

      const sameTurn = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: first.confirmationPhrase,
      });
      expect(sameTurn.dispatched).toBe(false);
      expect(sameTurn.message).toContain('same turn');
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();

      const accepted = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: first.confirmationPhrase,
      });
      expect(accepted.dispatched).toBe(true);
      expect(mockClassifyMissionIntent).toHaveBeenCalledTimes(1);
      expect(mockCreateMission).toHaveBeenCalledTimes(1);
      expect(mockInngestSend).toHaveBeenCalledTimes(1);

      const replay = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-3',
        confirmationText: first.confirmationPhrase,
      });
      expect(replay.dispatched).toBe(false);
      expect(mockClassifyMissionIntent).toHaveBeenCalledTimes(1);
      expect(mockCreateMission).toHaveBeenCalledTimes(1);
      expect(mockInngestSend).toHaveBeenCalledTimes(1);
    });

    it('cancels a staged action on generic approval and does not accept the old phrase afterward', async () => {
      const args = { prompt: 'Research quantum sensing', agent: 'creator' } as const;
      const first = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
      });
      const generic = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: 'yes, go ahead',
      });
      const oldPhrase = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-3',
        confirmationText: first.confirmationPhrase,
      });

      expect(generic.dispatched).toBe(false);
      expect(generic.message).toContain('did not exactly authorize');
      expect(oldPhrase.dispatched).toBe(false);
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('binds confirmation to prompt, agent, theme, and visual ambition', async () => {
      const base = {
        prompt: 'Research quantum sensing',
        agent: 'creator',
        theme: 'brand-dark',
      } as const;
      const changedActions = [
        { ...base, prompt: 'Research quantum networking' },
        { ...base, agent: 'evaluator' },
        { ...base, theme: 'brand-light' },
        { ...base, visualAmbition: 'rich-executive' as const },
      ] as const;

      for (const [index, changed] of changedActions.entries()) {
        _resetConfirmationStore();
        const first = await executeStartMission(base, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: `turn-${index}-1`,
        });
        const result = await executeStartMission(changed, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: `turn-${index}-2`,
          confirmationText: first.confirmationPhrase,
        });
        expect(result.dispatched).toBe(false);
      }

      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('binds the phrase to the complete configured mission spend envelope', async () => {
      const original = process.env.MISSION_MAX_COST_USD;
      process.env.MISSION_MAX_COST_USD = '23';
      try {
        const args = { prompt: 'Research quantum sensing', agent: 'creator' } as const;
        const first = await executeStartMission(args, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-1',
        });
        expect(first.confirmationPhrase).toMatch(/^CONFIRM SPEND \$45\.40 startMission%3A/);

        process.env.MISSION_MAX_COST_USD = '24';
        const changedCap = await executeStartMission(args, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-2',
          confirmationText: first.confirmationPhrase,
        });
        expect(changedCap.dispatched).toBe(false);
        expect(changedCap.confirmationPhrase).toMatch(/^CONFIRM SPEND \$47\.20 startMission%3A/);
        expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
        expect(mockCreateMission).not.toHaveBeenCalled();
        expect(mockInngestSend).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.MISSION_MAX_COST_USD;
        else process.env.MISSION_MAX_COST_USD = original;
      }
    });

    it('requires a fresh confirmation when the component allocation changes but the total does not', async () => {
      const saved = {
        MISSION_MAX_COST_USD: process.env.MISSION_MAX_COST_USD,
        REVISION_MAX_COST_USD: process.env.REVISION_MAX_COST_USD,
        PRELUDE_MAX_TOTAL_COST_USD: process.env.PRELUDE_MAX_TOTAL_COST_USD,
      };
      try {
        process.env.MISSION_MAX_COST_USD = '13';
        process.env.REVISION_MAX_COST_USD = '0.01';
        process.env.PRELUDE_MAX_TOTAL_COST_USD = '2';
        const args = { prompt: 'Research quantum sensing', agent: 'creator' } as const;
        const first = await executeStartMission(args, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-1',
        });
        expect(first.confirmationPhrase).toMatch(/^CONFIRM SPEND \$17\.01 startMission%3A/);

        // Same $17.01 total, different allocation: 11.01 + 2 + 2 + 2.
        process.env.MISSION_MAX_COST_USD = '11.01';
        process.env.REVISION_MAX_COST_USD = '2';
        const reallocated = await executeStartMission(args, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-2',
          confirmationText: first.confirmationPhrase,
        });
        expect(reallocated.dispatched).toBe(false);
        expect(mockCreateMission).not.toHaveBeenCalled();
        expect(mockInngestSend).not.toHaveBeenCalled();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('persists the confirmed execution envelope with profile-aware limits and model pin', async () => {
      const saved = {
        MISSION_MAX_COST_USD: process.env.MISSION_MAX_COST_USD,
        REVISION_MAX_COST_USD: process.env.REVISION_MAX_COST_USD,
        PRELUDE_MAX_TOTAL_COST_USD: process.env.PRELUDE_MAX_TOTAL_COST_USD,
        MISSION_MAX_TOOL_CALLS: process.env.MISSION_MAX_TOOL_CALLS,
        MISSION_TIMEOUT_MINUTES: process.env.MISSION_TIMEOUT_MINUTES,
        IMPULSE_AGENT_FALLBACK_MODEL: process.env.IMPULSE_AGENT_FALLBACK_MODEL,
      };
      try {
        process.env.MISSION_MAX_COST_USD = '13';
        process.env.REVISION_MAX_COST_USD = '0.01';
        process.env.PRELUDE_MAX_TOTAL_COST_USD = '2';
        // Env is LOOSER than the profile on tool calls and TIGHTER on the
        // timeout — the envelope must take the profile's narrowing (120) and
        // the profile's long wall clock (90), not freeze bare env defaults.
        process.env.MISSION_MAX_TOOL_CALLS = '200';
        process.env.MISSION_TIMEOUT_MINUTES = '30';
        process.env.IMPULSE_AGENT_FALLBACK_MODEL = 'claude-sonnet-5';
        mockDispatchLoadAllProfiles.mockReturnValueOnce(
          new Map([
            [
              'creator',
              {
                model: 'claude-opus-5',
                budget: { max_tokens: 100_000, max_tool_calls: 120 },
                timeoutMinutes: 90,
              },
            ],
          ])
        );

        await executeStartMission(
          { prompt: 'Create an executive decision dossier', agent: 'creator', confirmed: true },
          'user-456'
        );

        expect(mockCreateMission).toHaveBeenCalledWith(
          'user-456',
          expect.any(Object),
          expect.objectContaining({
            authorizedMaxCostUsd: 17.01,
            executionEnvelope: {
              orchestratorMaxCostUsd: 13,
              revisionMaxCostUsd: 0.01,
              preludeMaxCostUsd: 2,
              auxiliaryMaxCostUsd: 2,
              totalMaxCostUsd: 17.01,
              maxToolCalls: 120,
              timeoutMinutes: 90,
              requestedModel: 'claude-opus-5',
              authorizedFallbackModel: 'claude-sonnet-5',
            },
          })
        );
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('keeps a narrow profile tool-call guard in the envelope instead of the env default', async () => {
      mockDispatchLoadAllProfiles.mockReturnValueOnce(
        new Map([
          [
            'scout',
            { model: 'claude-sonnet-5', budget: { max_tokens: 50_000, max_tool_calls: 20 }, timeoutMinutes: 45 },
          ],
        ])
      );

      await executeStartMission(
        { prompt: 'Research competitive landscape for AI startups', agent: 'scout', confirmed: true },
        'user-456'
      );

      const extras = mockCreateMission.mock.calls[0]?.[2] as
        { executionEnvelope?: { maxToolCalls?: number; requestedModel?: string } } | undefined;
      expect(extras?.executionEnvelope?.maxToolCalls).toBe(20);
      expect(extras?.executionEnvelope?.requestedModel).toBe('claude-sonnet-5');
    });

    it('refuses dispatch outright when the agent profile cannot be loaded', async () => {
      mockDispatchLoadAllProfiles.mockImplementationOnce(() => {
        throw new Error('agent runtime unavailable');
      });

      const result = await executeStartMission(
        { prompt: 'Research competitive landscape for AI startups', agent: 'scout', confirmed: true },
        'user-456'
      );

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe('agent-profile-unavailable');
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('refuses dispatch before staging any confirmation when the profile has no model', async () => {
      mockDispatchLoadAllProfiles.mockReturnValueOnce(new Map());

      const result = await executeStartMission({ prompt: 'Research quantum sensing', agent: 'creator' }, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
      });

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe('agent-profile-unavailable');
      // Provider-free precondition: the refusal must not consume or stage a
      // paid-confirmation token, so no phrase is minted.
      expect(result.confirmationPhrase).toBeUndefined();
      expect(mockCreateMission).not.toHaveBeenCalled();
    });

    it('does not let another user redeem a staged confirmation', async () => {
      const args = { prompt: 'Research quantum sensing', agent: 'creator' } as const;
      const first = await executeStartMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
      });
      const wrongUser = await executeStartMission(args, 'human-2', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: first.confirmationPhrase,
      });

      expect(wrongUser.dispatched).toBe(false);
      expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should attribute the dispatched mission to the provided userId (MCP key-owner attribution)', async () => {
      await executeStartMission({ prompt: 'Scout the field', agent: 'scout', confirmed: true }, 'key-owner-001');

      expect(mockCreateMission).toHaveBeenCalledWith('key-owner-001', expect.anything(), expect.anything());
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/mission.run.requested',
          data: expect.objectContaining({ userId: 'key-owner-001' }),
        })
      );
    });

    it('should propagate errors from createMission', async () => {
      mockCreateMission.mockRejectedValue(new Error('Firestore write failed'));

      await expect(
        executeStartMission({ prompt: 'Test prompt', agent: 'scout', confirmed: true }, 'user-456')
      ).rejects.toThrow('Firestore write failed');
    });

    it('should propagate errors from inngest.send', async () => {
      mockInngestSend.mockRejectedValue(new Error('Inngest send failed'));

      await expect(
        executeStartMission({ prompt: 'Test prompt', agent: 'scout', confirmed: true }, 'user-456')
      ).rejects.toThrow('Inngest send failed');
    });

    // ------------------------------------------------------------------------
    // AI-053: chat dispatch routes through the research-first gate, and the
    // confirmed envelope covers EVERY step of the chain it creates.
    // ------------------------------------------------------------------------
    describe('AI-053 — research-first gate on the chat path', () => {
      // Clears all six bypasses: creator agent, no {{parent.result}}, no bundle
      // marker, under 3 refs / 5 URLs, over 280 chars is not required because the
      // prompt carries analytical terms ("landscape", "adoption", "forecast").
      const GATING_BRIEF =
        'Analyze the competitive landscape and adoption economics for open-weight AI models ' +
        'over the next 12 months, including vendor pricing pressure and forecast risk.';

      const SCOUT_MISSION = { id: 'm-scout', prompt: 'SCOUT PROMPT', agent: 'scout' };
      const CREATOR_MISSION = { id: 'm-creator', prompt: 'CREATOR PROMPT', agent: 'creator' };

      beforeEach(() => {
        mockCreateChain.mockResolvedValue({
          chainId: 'chain-1',
          missions: [SCOUT_MISSION, CREATOR_MISSION],
        });
        // Distinct profiles: the whole point of per-step envelopes is that the
        // two steps do NOT share a model, tool-call cap, or timeout.
        mockDispatchLoadAllProfiles.mockReturnValue(
          new Map<string, unknown>([
            ['scout', { model: 'claude-sonnet-4-6', budget: { max_tool_calls: 50 } }],
            ['creator', { model: 'claude-opus-4-8', budget: { max_tool_calls: 120 }, timeoutMinutes: 90 }],
          ])
        );
      });

      it('turns a gate-clearing chat creator brief into a scout → creator chain, firing Inngest ONCE for the scout', async () => {
        const result = await executeStartMission(
          { prompt: GATING_BRIEF, agent: 'creator', confirmed: true },
          'user-456'
        );

        expect(mockCreateMission).not.toHaveBeenCalled();
        expect(mockCreateChain).toHaveBeenCalledTimes(1);
        const [, steps] = mockCreateChain.mock.calls[0];
        expect((steps as Array<{ agent: string }>).map((s) => s.agent)).toEqual(['scout', 'creator']);

        expect(result.researchGated).toBe(true);
        expect(result.missionId).toBe('m-scout');
        expect(result.missionIds).toEqual(['m-scout', 'm-creator']);
        expect(result.chainId).toBe('chain-1');

        // Step 2 is fired by run-agent-mission's advance-chain step, not here.
        expect(mockInngestSend).toHaveBeenCalledTimes(1);
        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/mission.run.requested',
          data: { missionId: 'm-scout', userId: 'user-456', prompt: 'SCOUT PROMPT', agent: 'scout' },
        });
      });

      it('gives each chain step its OWN executionEnvelope and a matching authorizedMaxCostUsd', async () => {
        // The highest-value assertion in this file: an envelope/agent swap is
        // undetectable at runtime, because the worker's effective-vs-confirmed
        // guard compares values BOTH derived from the same (wrong) envelope.
        await executeStartMission({ prompt: GATING_BRIEF, agent: 'creator', confirmed: true }, 'user-456');

        const [, , deliverableExtras, perStepExtras] = mockCreateChain.mock.calls[0];
        const steps = perStepExtras as Array<{
          authorizedMaxCostUsd: number;
          executionEnvelope: {
            requestedModel?: string;
            maxToolCalls: number;
            timeoutMinutes: number;
            totalMaxCostUsd: number;
          };
        }>;
        expect(steps).toHaveLength(2);

        expect(steps[0].executionEnvelope.requestedModel).toBe('claude-sonnet-4-6');
        expect(steps[1].executionEnvelope.requestedModel).toBe('claude-opus-4-8');
        // maxToolCalls is min(environment, profile) — the profile's 120 narrows to
        // the environment default, while the scout's 50 is the stricter side.
        expect(steps[0].executionEnvelope.maxToolCalls).toBe(50);
        expect(steps[1].executionEnvelope.maxToolCalls).toBeLessThan(120);
        expect(steps[1].executionEnvelope.timeoutMinutes).toBe(90);

        // The exact invariant buildMissionDocument and the worker both enforce.
        for (const step of steps) {
          expect(step.authorizedMaxCostUsd).toBe(step.executionEnvelope.totalMaxCostUsd);
        }

        // Cost lives per step; the classifier metadata stays on the deliverable.
        expect(deliverableExtras).not.toHaveProperty('authorizedMaxCostUsd');
        expect(deliverableExtras).not.toHaveProperty('executionEnvelope');
        expect(deliverableExtras).toHaveProperty('classifierMetadata');
      });

      it('prices the confirmation at the SUM of both step envelopes', async () => {
        const refusal = await executeStartMission({ prompt: GATING_BRIEF, agent: 'creator' }, 'human-1', {
          principal: 'human',
          requestId: 'req-1',
          sessionId: 'sess-1',
        });

        expect(refusal.dispatched).toBe(false);
        expect(refusal.requiresConfirmation).toBe(true);
        const [, , , perStepExtrasBefore] = mockCreateChain.mock.calls[0] ?? [];
        expect(perStepExtrasBefore).toBeUndefined(); // nothing dispatched yet

        // Two steps on the same environment cost components → exactly double a
        // single-mission dispatch.
        const single = await executeStartMission({ prompt: 'Research quantum sensing', agent: 'creator' }, 'human-1', {
          principal: 'human',
          requestId: 'req-2',
          sessionId: 'sess-1',
        });
        expect(refusal.amountUsd).toBe((single.amountUsd as number) * 2);
        expect(refusal.confirmationPhrase).toContain(`$${refusal.amountUsd}`);
      });

      it.each([
        ['not-creator-agent', { prompt: GATING_BRIEF, agent: 'scout' }],
        ['downstream-of-chain', { prompt: `Analyze the market landscape.\n\n{{parent.result}}`, agent: 'creator' }],
        [
          'inline-research-bundle (marker)',
          { prompt: 'Write the analysis.\n\n### Research Bundle\nSources: ...', agent: 'creator' },
        ],
        [
          'inline-research-bundle (heavy sourcing)',
          {
            prompt:
              'Analyze the market landscape.\n' +
              [1, 2, 3].map((n) => `[${n}] https://example.com/${n}`).join('\n') +
              '\n' +
              'x'.repeat(500),
            agent: 'creator',
          },
        ],
        ['short-narrow-prompt', { prompt: 'Reformat the data I provided earlier as a bullet list', agent: 'creator' }],
      ])('%s still yields a single ungated mission that keeps its own envelope', async (_reason, args) => {
        // The sixth bypass (`explicit-skip`) is unreachable from startMission —
        // there is no such tool argument — and is covered at the gate itself.
        const result = await executeStartMission({ ...args, confirmed: true }, 'user-456');

        expect(mockCreateChain).not.toHaveBeenCalled();
        expect(mockCreateMission).toHaveBeenCalledTimes(1);
        const extras = mockCreateMission.mock.calls[0][2] as {
          authorizedMaxCostUsd?: number;
          executionEnvelope?: { totalMaxCostUsd: number };
        };
        // Regression guard for the easy bug: moving the cost fields onto the
        // per-step channel must NOT de-authorize the ungated branch.
        expect(extras.executionEnvelope).toBeDefined();
        expect(extras.authorizedMaxCostUsd).toBe(extras.executionEnvelope?.totalMaxCostUsd);
        expect(result.researchGated).toBe(false);
        expect(mockInngestSend).toHaveBeenCalledTimes(1);
      });

      it('refuses fail-closed, minting NO phrase, when the SCOUT profile is missing for a gated brief', async () => {
        // New coupling introduced by AI-053: a creator request now depends on the
        // scout profile, because the gate will create a scout step.
        mockDispatchLoadAllProfiles.mockReturnValue(
          new Map<string, unknown>([['creator', { model: 'claude-opus-4-8', budget: { max_tool_calls: 120 } }]])
        );

        const result = await executeStartMission({ prompt: GATING_BRIEF, agent: 'creator' }, 'human-1', {
          principal: 'human',
          requestId: 'req-3',
          sessionId: 'sess-1',
        });

        expect(result.dispatched).toBe(false);
        expect(result.reason).toBe('agent-profile-unavailable');
        expect(result.confirmationPhrase).toBeUndefined();
        expect(result.message).toContain("'scout'");
        expect(result.message).toContain('research-first gate');
        expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
        expect(mockCreateChain).not.toHaveBeenCalled();
        expect(mockCreateMission).not.toHaveBeenCalled();
      });

      it('classifies exactly once and flushes the classifier spend onto the scout head mission', async () => {
        await executeStartMission({ prompt: GATING_BRIEF, agent: 'creator', confirmed: true }, 'user-456');

        // The ORIGINAL brief is classified, not the generated scout prompt.
        expect(mockClassifyMissionIntent).toHaveBeenCalledTimes(1);
        expect(mockClassifyMissionIntent).toHaveBeenCalledWith({ prompt: GATING_BRIEF, agent: 'creator' });
        expect(mockFlushMissionStageUsage).toHaveBeenCalledWith(
          { missionId: 'm-scout', owner: 'user:user-456', stage: 'classifier' },
          expect.anything()
        );
      });

      it('carries the user design brief to the CREATOR step only', async () => {
        await executeStartMission(
          { prompt: GATING_BRIEF, agent: 'creator', theme: 'brand-dark', confirmed: true },
          'user-456'
        );

        const [, steps] = mockCreateChain.mock.calls[0];
        const chainSteps = steps as Array<{ agent: string; designBrief?: unknown }>;
        expect(chainSteps[0].designBrief).toBeUndefined();
        expect(chainSteps[1].designBrief).toEqual({ theme: 'brand-dark', source: 'user' });
      });
    });
  });

  // --------------------------------------------------------------------------
  // executeDispatchTechnologyEvaluation (BUILD-023: buildMode threading)
  // --------------------------------------------------------------------------
  describe('executeDispatchTechnologyEvaluation', () => {
    const ORIGINAL_FLAG = process.env.IMPULSE_BUILD_ENABLED;

    beforeEach(() => {
      process.env.IMPULSE_BUILD_ENABLED = 'true';
      mockComposeBrief.mockResolvedValue({ brief: 'BRIEF', motivation: 'MOTIVE', title: 'LangGraph' });
      mockCreateMission.mockResolvedValue({ id: 'm-eval-1' });
      mockUpdateMission.mockResolvedValue(undefined);
    });

    afterAll(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.IMPULSE_BUILD_ENABLED;
      else process.env.IMPULSE_BUILD_ENABLED = ORIGINAL_FLAG;
    });

    it('returns an honest disabled notice (no mission, no spend) when the flag is off', async () => {
      process.env.IMPULSE_BUILD_ENABLED = 'false';
      const r = await executeDispatchTechnologyEvaluation({ technologyId: 'tech-1', confirmed: true }, 'user-1');
      expect(r.dispatched).toBe(false);
      expect(r.message).toContain('IMPULSE_BUILD_ENABLED');
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('standard dispatch (no buildMode) keeps the $15 default budget and passes no buildMode', async () => {
      const r = await executeDispatchTechnologyEvaluation({ technologyId: 'tech-1', confirmed: true }, 'user-1');
      expect(r.dispatched).toBe(true);
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.budgetUsd).toBe(15);
      expect(payload).not.toHaveProperty('buildMode');
      expect(mockUpdateMission).toHaveBeenCalledWith('m-eval-1', {
        budget: { capUsd: 15, warnThreshold: 0.8, topUps: [] },
      });
    });

    it('limitless without an explicit budget freezes the displayed tier cap on the mission', async () => {
      const r = await executeDispatchTechnologyEvaluation(
        { technologyId: 'tech-1', buildMode: 'limitless', confirmed: true },
        'user-1'
      );
      expect(r.dispatched).toBe(true);
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.buildMode).toBe('limitless');
      expect(payload.budgetUsd).toBe(50);
      expect(mockUpdateMission).toHaveBeenCalledWith('m-eval-1', {
        budget: { capUsd: 50, warnThreshold: 0.8, topUps: [] },
      });
      expect(r.message).toContain('Limitless tier cap');
      expect(r.message).toContain('Limitless premium tier');
    });

    it('limitless with an explicit budget honors it (clamped) and still passes buildMode', async () => {
      await executeDispatchTechnologyEvaluation(
        { technologyId: 'tech-1', buildMode: 'limitless', budgetUsd: 40, confirmed: true },
        'user-1'
      );
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.buildMode).toBe('limitless');
      expect(payload.budgetUsd).toBe(40);
      expect(mockUpdateMission).toHaveBeenCalledWith('m-eval-1', {
        budget: { capUsd: 40, warnThreshold: 0.8, topUps: [] },
      });
    });

    it('rejects a Limitless evaluation cap that cannot fund work beyond the reviewer reserve', async () => {
      const result = await executeDispatchTechnologyEvaluation(
        { technologyId: 'tech-1', buildMode: 'limitless', budgetUsd: 10, confirmed: true },
        'user-1'
      );

      expect(result).toMatchObject({ dispatched: false, amountUsd: 10 });
      expect(result.message).toContain('independent-reviewer reserve');
      expect(mockComposeBrief).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('clamps an oversized explicit budget to $100', async () => {
      await executeDispatchTechnologyEvaluation({ technologyId: 'tech-1', budgetUsd: 500, confirmed: true }, 'user-1');
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.budgetUsd).toBe(100);
    });

    it('rejects an unknown buildMode before any dispatch (zero-cost validation)', async () => {
      await expect(
        executeDispatchTechnologyEvaluation({ technologyId: 'tech-1', buildMode: 'turbo' }, 'user-1')
      ).rejects.toThrow("Unknown buildMode 'turbo'. Valid modes: standard, limitless");
      expect(mockComposeBrief).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
    });

    it("buildMode 'standard' behaves exactly like omitting it", async () => {
      await executeDispatchTechnologyEvaluation(
        { technologyId: 'tech-1', buildMode: 'standard', confirmed: true },
        'user-1'
      );
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.budgetUsd).toBe(15);
      expect(payload).not.toHaveProperty('buildMode');
    });
  });

  // --------------------------------------------------------------------------
  // executeDispatchBuildMission (BUILD-024: solution builds from chat)
  // --------------------------------------------------------------------------
  describe('executeDispatchBuildMission', () => {
    const ORIGINAL_FLAG = process.env.IMPULSE_BUILD_ENABLED;
    const BRIEF = '# Mission: Todo App\n## Objective\nA todo app.\n## Done means\n- CRUD works';

    beforeEach(() => {
      process.env.IMPULSE_BUILD_ENABLED = 'true';
      mockCreateMission.mockResolvedValue({ id: 'm-build-1' });
      mockUpdateMission.mockResolvedValue(undefined);
    });

    afterAll(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.IMPULSE_BUILD_ENABLED;
      else process.env.IMPULSE_BUILD_ENABLED = ORIGINAL_FLAG;
    });

    it('returns an honest disabled notice (no mission, no spend) when the flag is off', async () => {
      process.env.IMPULSE_BUILD_ENABLED = 'false';
      const r = await executeDispatchBuildMission({ prompt: BRIEF, confirmed: true }, 'user-1');
      expect(r.dispatched).toBe(false);
      expect(r.message).toContain('IMPULSE_BUILD_ENABLED');
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('dispatches the prompt unchanged and freezes the displayed standard pipeline cap', async () => {
      const r = await executeDispatchBuildMission({ prompt: BRIEF, confirmed: true }, 'user-1');
      expect(r.dispatched).toBe(true);
      expect(r.missionId).toBe('m-build-1');
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.prompt).toBe(BRIEF); // prompt IS the brief — composer never ran
      expect(payload.kind).toBe('build');
      expect(payload.artifactKind).toBe('solution');
      expect(payload.budgetUsd).toBe(25);
      expect(payload).not.toHaveProperty('buildMode');
      expect(payload).not.toHaveProperty('designBrief'); // no structured designBrief was passed
      expect(mockUpdateMission).toHaveBeenCalledWith('m-build-1', {
        budget: { capUsd: 25, warnThreshold: 0.8, topUps: [] },
      });
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/build-mission.run.requested',
        data: { missionId: 'm-build-1', userId: 'user-1' },
      });
      expect(r.message).toContain('pipeline default cap ($25)');
    });

    it('resolves context refs server-side and persists the immutable manifest (BUILD-036)', async () => {
      const manifest = {
        version: 1 as const,
        items: [
          {
            kind: 'entity' as const,
            refId: 'c1',
            entityType: 'companies',
            title: 'Acme',
            excerpt: 'A robotics company.',
            truncated: false,
            ownership: 'shared' as const,
            provenance: { origin: 'entity:companies', sources: [] as string[] },
            bytes: 20,
          },
        ],
        omitted: [],
        totalBytes: 20,
        counts: { requested: 1, resolved: 1, omitted: 0 },
        digest: 'a'.repeat(64),
      };
      mockResolveBuildContextForUser.mockResolvedValue(manifest);

      const refs = [{ kind: 'entity', entityType: 'companies', id: 'c1' }];
      const r = await executeDispatchBuildMission({ prompt: BRIEF, context: refs, confirmed: true }, 'user-1');

      expect(r.dispatched).toBe(true);
      // Resolved server-side, once, with the exact caller refs.
      expect(mockResolveBuildContextForUser).toHaveBeenCalledWith('user-1', refs);
      // Persisted on the mission (distinct from the output entities/sources arrays).
      const manifestWrite = mockUpdateMission.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>).contextManifest !== undefined
      );
      expect(manifestWrite).toBeTruthy();
      expect((manifestWrite![1] as { contextManifest: unknown }).contextManifest).toEqual(manifest);
      // The raw refs never land on createMission (only the resolved manifest is persisted).
      const created = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(created).not.toHaveProperty('context');
      expect(created).not.toHaveProperty('contextManifest');
    });

    it('rejects malformed context before confirmation staging or mission mutation', async () => {
      await expect(
        executeDispatchBuildMission(
          { prompt: BRIEF, context: [{ kind: 'document', id: '../secret' }], confirmed: true },
          'user-1'
        )
      ).rejects.toThrow('invalid context references');

      expect(mockResolveBuildContextForUser).not.toHaveBeenCalled();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('rejects foreign private context before mission mutation or dispatch', async () => {
      mockResolveBuildContextForUser.mockResolvedValueOnce({
        version: 1,
        items: [],
        omitted: [{ kind: 'report', refId: 'r-foreign', reason: 'unauthorized' }],
        totalBytes: 250,
        counts: { requested: 1, resolved: 0, omitted: 1 },
        digest: 'b'.repeat(64),
      });

      await expect(
        executeDispatchBuildMission(
          { prompt: BRIEF, context: [{ kind: 'report', id: 'r-foreign' }], confirmed: true },
          'user-1'
        )
      ).rejects.toThrow('Build context reference not found');

      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('is an opt-in no-op when no context refs are supplied (BUILD-036)', async () => {
      await executeDispatchBuildMission({ prompt: BRIEF, confirmed: true }, 'user-1');
      expect(mockResolveBuildContextForUser).not.toHaveBeenCalled();
      const persistedManifest = mockUpdateMission.mock.calls.some(
        (c) => 'contextManifest' in (c[1] as Record<string, unknown>)
      );
      expect(persistedManifest).toBe(false);
    });

    it('composes a structured brief and threads the per-artifact design brief (Task 5)', async () => {
      const out = await executeDispatchBuildMission(
        {
          objective: 'Compare vendors',
          mustHaves: ['table', 'chart'],
          buildMode: 'limitless',
          designBrief: { theme: 'brand-dark' },
          confirmed: true,
        },
        'user-1'
      );
      expect(out.dispatched).toBe(true);
      const created = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(created.prompt).toContain('## Acceptance Rubric');
      expect(created.buildMode).toBe('limitless');
      expect(created.designBrief).toBeDefined(); // per-artifact brief passed through
      expect(created.designBrief).toEqual({ theme: 'brand-dark' }); // the RAW partial, not the internally-resolved brief
      expect(out.message).toContain('Compare vendors'); // composed title threaded into the reply
    });

    it('a structured dispatch with no designBrief still composes (defaults resolve inside the composer, nothing leaks to createMission)', async () => {
      await executeDispatchBuildMission(
        { objective: 'Compare vendors', mustHaves: ['table'], confirmed: true },
        'user-1'
      );
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.prompt).toContain('## Acceptance Rubric');
      expect(payload).not.toHaveProperty('designBrief'); // no per-artifact palette was requested
    });

    it('limitless passes buildMode and reports the tier cap when no budget named', async () => {
      const r = await executeDispatchBuildMission({ prompt: BRIEF, buildMode: 'limitless', confirmed: true }, 'user-1');
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.buildMode).toBe('limitless');
      expect(payload.budgetUsd).toBe(50);
      expect(mockUpdateMission).toHaveBeenCalledWith('m-build-1', {
        budget: { capUsd: 50, warnThreshold: 0.8, topUps: [] },
      });
      expect(r.message).toContain('Limitless tier cap');
      expect(r.message).toContain('Limitless premium tier');
    });

    it('rejects a Limitless solution cap that is entirely consumed by the reviewer reserve', async () => {
      const result = await executeDispatchBuildMission(
        { prompt: BRIEF, buildMode: 'limitless', budgetUsd: 10, confirmed: true },
        'user-1'
      );

      expect(result).toMatchObject({ dispatched: false, amountUsd: 10 });
      expect(result.message).toContain('leaves no budget for the builder');
      expect(result.requiresConfirmation).toBeUndefined();
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('an explicit budget is honored (clamped to $100) and written to mission.budget', async () => {
      await executeDispatchBuildMission({ prompt: BRIEF, budgetUsd: 250, confirmed: true }, 'user-1');
      const payload = mockCreateMission.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.budgetUsd).toBe(100);
      expect(mockUpdateMission).toHaveBeenCalledWith('m-build-1', {
        budget: { capUsd: 100, warnThreshold: 0.8, topUps: [] },
      });
    });

    it('rejects a blank prompt with no structured fields, and an unknown buildMode, before any dispatch', async () => {
      await expect(executeDispatchBuildMission({ prompt: '   ' }, 'user-1')).rejects.toThrow(
        'requires either `prompt` or `objective`+`mustHaves`'
      );
      await expect(executeDispatchBuildMission({}, 'user-1')).rejects.toThrow(
        'requires either `prompt` or `objective`+`mustHaves`'
      );
      await expect(executeDispatchBuildMission({ objective: 'Compare vendors' }, 'user-1')).rejects.toThrow(
        'requires either `prompt` or `objective`+`mustHaves`'
      ); // objective alone, no mustHaves — composer never triggers, falls through to the blank-prompt guard
      await expect(executeDispatchBuildMission({ prompt: BRIEF, buildMode: 'mega' }, 'user-1')).rejects.toThrow(
        "Unknown buildMode 'mega'. Valid modes: standard, limitless"
      );
      expect(mockCreateMission).not.toHaveBeenCalled();
    });

    it('throws without an authenticated user', async () => {
      await expect(executeDispatchBuildMission({ prompt: BRIEF }, '')).rejects.toThrow('authenticated user');
    });

    it('fails closed for a non-chat caller until confirmed:true is explicit', async () => {
      const result = await executeDispatchBuildMission({ prompt: BRIEF }, 'machine-user');

      expect(result.dispatched).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.confirmationPhrase).toMatch(/^CONFIRM SPEND \$25 /);
      expect(mockCreateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('binds the phrase to the supervisor-resolved YAML cap, not an env-only default', async () => {
      const originalStandard = process.env.IMPULSE_BUILD_MISSION_MAX_COST_USD;
      const originalLimitless = process.env.IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD;
      delete process.env.IMPULSE_BUILD_MISSION_MAX_COST_USD;
      delete process.env.IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD;
      mockLoadBuildConfig.mockReturnValue({
        budget: { missionCapUsd: 72 },
        limitless: { missionCapUsd: 90, reviewerMaxCostUsd: 10 },
      });

      try {
        const standard = await executeDispatchBuildMission({ prompt: BRIEF }, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'standard-turn-1',
        });
        _resetConfirmationStore();
        const limitless = await executeDispatchBuildMission({ prompt: BRIEF, buildMode: 'limitless' }, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'limitless-turn-1',
        });

        expect(standard.confirmationPhrase).toMatch(/^CONFIRM SPEND \$72 /);
        expect(limitless.confirmationPhrase).toMatch(/^CONFIRM SPEND \$90 /);
        expect(mockLoadBuildConfig).toHaveBeenCalledWith({ yamlPath: 'impulse.config.yaml' });
        expect(mockCreateMission).not.toHaveBeenCalled();
      } finally {
        if (originalStandard === undefined) delete process.env.IMPULSE_BUILD_MISSION_MAX_COST_USD;
        else process.env.IMPULSE_BUILD_MISSION_MAX_COST_USD = originalStandard;
        if (originalLimitless === undefined) delete process.env.IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD;
        else process.env.IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD = originalLimitless;
      }
    });

    it('binds confirmation to the supervisor hard-cap clamp', async () => {
      const original = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
      process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '60';
      mockLoadBuildConfig.mockReturnValue({
        budget: { missionCapUsd: 72 },
        limitless: { missionCapUsd: 90, reviewerMaxCostUsd: 10 },
      });

      try {
        const result = await executeDispatchBuildMission({ prompt: BRIEF, buildMode: 'limitless' }, 'human-1', {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-1',
        });
        expect(result.confirmationPhrase).toMatch(/^CONFIRM SPEND \$60 /);
      } finally {
        if (original === undefined) delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
        else process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = original;
      }
    });

    it('ignores first-call self-confirmation and same-turn retries, then dispatches identical args on the exact next phrase', async () => {
      const args = { prompt: BRIEF, buildMode: 'limitless', budgetUsd: 50, confirmed: true } as const;
      const first = await executeDispatchBuildMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: 'I already approve this',
      });

      expect(first.dispatched).toBe(false);
      expect(first.confirmationPhrase).toMatch(/^CONFIRM SPEND \$50 /);
      expect(mockCreateMission).not.toHaveBeenCalled();

      const sameTurn = await executeDispatchBuildMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: first.confirmationPhrase,
      });
      expect(sameTurn.dispatched).toBe(false);
      expect(sameTurn.message).toContain('same turn');
      expect(mockCreateMission).not.toHaveBeenCalled();

      const accepted = await executeDispatchBuildMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: first.confirmationPhrase,
      });
      expect(accepted.dispatched).toBe(true);
      expect(mockCreateMission).toHaveBeenCalledTimes(1);
      expect(mockInngestSend).toHaveBeenCalledTimes(1);
    });

    it('does not authorize a changed brief or budget with the prior phrase', async () => {
      const first = await executeDispatchBuildMission(
        { prompt: BRIEF, buildMode: 'limitless', budgetUsd: 50 },
        'human-1',
        { principal: 'human', sessionId: HUMAN_PAID_SESSION_ID, requestId: 'turn-1' }
      );

      const changedBrief = await executeDispatchBuildMission(
        { prompt: `${BRIEF}\n- hidden extra`, buildMode: 'limitless', budgetUsd: 50 },
        'human-1',
        {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-2',
          confirmationText: first.confirmationPhrase,
        }
      );
      const changedBudget = await executeDispatchBuildMission(
        { prompt: BRIEF, buildMode: 'limitless', budgetUsd: 75 },
        'human-1',
        {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-2',
          confirmationText: first.confirmationPhrase,
        }
      );

      expect(changedBrief.dispatched).toBe(false);
      expect(changedBudget.dispatched).toBe(false);
      expect(changedBrief.confirmationPhrase).not.toBe(first.confirmationPhrase);
      expect(changedBudget.confirmationPhrase).not.toBe(first.confirmationPhrase);
      expect(mockCreateMission).not.toHaveBeenCalled();
    });

    it('does not let another authenticated user redeem the staged spend', async () => {
      const args = { prompt: BRIEF, buildMode: 'limitless' } as const;
      const first = await executeDispatchBuildMission(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
      });
      const otherUser = await executeDispatchBuildMission(args, 'human-2', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: first.confirmationPhrase,
      });

      expect(otherUser.dispatched).toBe(false);
      expect(mockCreateMission).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // executeIterateBuildArtifact (BUILD-019: artifact iteration from chat/MCP)
  // --------------------------------------------------------------------------
  describe('executeIterateBuildArtifact', () => {
    const ORIGINAL_FLAG = process.env.IMPULSE_BUILD_ENABLED;

    beforeEach(() => {
      process.env.IMPULSE_BUILD_ENABLED = 'true';
      mockIterateBuildMission.mockResolvedValue({ ok: true, missionId: 'm-1', iteration: 2 });
    });

    afterAll(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.IMPULSE_BUILD_ENABLED;
      else process.env.IMPULSE_BUILD_ENABLED = ORIGINAL_FLAG;
    });

    it('returns an honest disabled notice (core never called) when the flag is off', async () => {
      process.env.IMPULSE_BUILD_ENABLED = 'false';
      const r = await executeIterateBuildArtifact({ missionId: 'm-1', instructions: 'dark mode' }, 'user-1');
      expect(r.dispatched).toBe(false);
      expect(r.message).toContain('IMPULSE_BUILD_ENABLED');
      expect(mockIterateBuildMission).not.toHaveBeenCalled();
    });

    it('dispatches through the SHARED core with the authenticated user', async () => {
      const r = await executeIterateBuildArtifact(
        { missionId: ' m-1 ', instructions: 'add CSV export', confirmed: true },
        'user-1'
      );
      expect(mockIterateBuildMission).toHaveBeenCalledWith({
        missionId: 'm-1', // trimmed
        userId: 'user-1',
        instructions: 'add CSV export',
      });
      expect(r.dispatched).toBe(true);
      expect(r.iteration).toBe(2);
      expect(r.message).toContain('Iteration 2');
    });

    it('maps contract violations to an honest message instead of throwing', async () => {
      mockIterateBuildMission.mockResolvedValue({
        ok: false,
        code: 'running',
        error: 'Mission is still running — cancel it first or wait',
      });
      const r = await executeIterateBuildArtifact({ missionId: 'm-1', instructions: 'x', confirmed: true }, 'user-1');
      expect(r.dispatched).toBe(false);
      expect(r.message).toContain('still running');
    });

    it('rejects missing missionId/instructions/user before any dispatch', async () => {
      await expect(executeIterateBuildArtifact({ missionId: '', instructions: 'x' }, 'user-1')).rejects.toThrow(
        'missionId'
      );
      await expect(executeIterateBuildArtifact({ missionId: 'm-1', instructions: '  ' }, 'user-1')).rejects.toThrow(
        'instructions'
      );
      await expect(executeIterateBuildArtifact({ missionId: 'm-1', instructions: 'x' }, '')).rejects.toThrow(
        'authenticated user'
      );
      expect(mockIterateBuildMission).not.toHaveBeenCalled();
    });

    it('stages a $10 phrase and executes only identical iteration instructions on the next exact turn', async () => {
      const args = { missionId: 'm-1', instructions: 'add CSV export', confirmed: true } as const;
      const staged = await executeIterateBuildArtifact(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: 'yes',
      });
      expect(staged.dispatched).toBe(false);
      expect(staged.confirmationPhrase).toMatch(/^CONFIRM SPEND \$10 /);
      expect(mockIterateBuildMission).not.toHaveBeenCalled();

      const sameTurn = await executeIterateBuildArtifact(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-1',
        confirmationText: staged.confirmationPhrase,
      });
      expect(sameTurn.dispatched).toBe(false);
      expect(mockIterateBuildMission).not.toHaveBeenCalled();

      const accepted = await executeIterateBuildArtifact(args, 'human-1', {
        principal: 'human',
        sessionId: HUMAN_PAID_SESSION_ID,
        requestId: 'turn-2',
        confirmationText: staged.confirmationPhrase,
      });
      expect(accepted.dispatched).toBe(true);
      expect(mockIterateBuildMission).toHaveBeenCalledTimes(1);
    });

    it('refuses a prior phrase when iteration instructions change', async () => {
      const staged = await executeIterateBuildArtifact(
        { missionId: 'm-1', instructions: 'add CSV export' },
        'human-1',
        { principal: 'human', sessionId: HUMAN_PAID_SESSION_ID, requestId: 'turn-1' }
      );
      const changed = await executeIterateBuildArtifact(
        { missionId: 'm-1', instructions: 'delete the export instead' },
        'human-1',
        {
          principal: 'human',
          sessionId: HUMAN_PAID_SESSION_ID,
          requestId: 'turn-2',
          confirmationText: staged.confirmationPhrase,
        }
      );

      expect(changed.dispatched).toBe(false);
      expect(changed.confirmationPhrase).not.toBe(staged.confirmationPhrase);
      expect(mockIterateBuildMission).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // executeApproveAssessment (BUILD-005: assessment triage from chat/MCP)
  // --------------------------------------------------------------------------
  describe('executeApproveAssessment', () => {
    const approvedAssessment = (over: Record<string, unknown> = {}) => ({
      id: 'pa-1',
      technologyId: 'tech-1',
      status: 'approved',
      proposedRing: 'Trial',
      radarId: 'radar-1',
      quadrantId: 'q-1',
      appliedPlacementId: 'placement-1',
      ...over,
    });

    it('approves with an explicit target and reports the real placement (applied)', async () => {
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment(),
        placementOutcome: 'applied',
      });

      const r = await executeApproveAssessment(
        { assessmentId: 'pa-1', radarId: 'radar-1', quadrantId: 'q-1' },
        'user-1'
      );

      // reviewedBy is the BARE authenticated uid — the exact value the triage
      // route passes (auth.uid), no 'user:' prefix.
      expect(mockApproveWithOutcome).toHaveBeenCalledWith('pa-1', 'user-1', { radarId: 'radar-1', quadrantId: 'q-1' });
      expect(r.approved).toBe(true);
      expect(r.placementOutcome).toBe('applied');
      expect(r.appliedPlacementId).toBe('placement-1');
      expect(r.message).toContain('placed on radar radar-1');
      expect(r.message).toContain('Trial ring');
    });

    it('resolves the assessment by technologyId — latest PENDING wins (live-caught gap: models cannot look up ids)', async () => {
      mockGetProposedAssessments.mockResolvedValue([
        { id: 'pa-old', technologyId: 'tech-1', status: 'approved', appliedPlacementId: 'p-done', createdAt: 100 },
        { id: 'pa-new-pending', technologyId: 'tech-1', status: 'pending', createdAt: 300 },
        { id: 'pa-mid-stranded', technologyId: 'tech-1', status: 'approved', createdAt: 200 },
      ]);
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment({ id: 'pa-new-pending' }),
        placementOutcome: 'applied',
      });

      const r = await executeApproveAssessment({ technologyId: 'tech-1' }, 'user-1');

      expect(mockGetProposedAssessments).toHaveBeenCalledWith({ technologyId: 'tech-1' });
      expect(mockApproveWithOutcome).toHaveBeenCalledWith('pa-new-pending', 'user-1', {
        radarId: undefined,
        quadrantId: undefined,
      });
      expect(r.placementOutcome).toBe('applied');
    });

    it('resolves by technologyId to the latest STRANDED approved assessment when nothing is pending', async () => {
      mockGetProposedAssessments.mockResolvedValue([
        { id: 'pa-done', technologyId: 'tech-1', status: 'approved', appliedPlacementId: 'p-1', createdAt: 400 },
        { id: 'pa-stranded', technologyId: 'tech-1', status: 'approved', createdAt: 300 },
        { id: 'pa-rejected', technologyId: 'tech-1', status: 'rejected', createdAt: 500 },
      ]);
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment({ id: 'pa-stranded' }),
        placementOutcome: 'applied',
      });

      await executeApproveAssessment({ technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'q-1' }, 'user-1');

      expect(mockApproveWithOutcome).toHaveBeenCalledWith('pa-stranded', 'user-1', {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      });
    });

    it('fails loud when the technology has no pending or stranded assessment (never guesses)', async () => {
      mockGetProposedAssessments.mockResolvedValue([
        { id: 'pa-done', technologyId: 'tech-1', status: 'approved', appliedPlacementId: 'p-1', createdAt: 400 },
      ]);

      await expect(executeApproveAssessment({ technologyId: 'tech-1' }, 'user-1')).rejects.toThrow(
        /no pending or placement-stranded assessment .* fully applied or terminal/
      );
      expect(mockApproveWithOutcome).not.toHaveBeenCalled();
    });

    it('rejects when neither assessmentId nor technologyId is given', async () => {
      await expect(executeApproveAssessment({}, 'user-1')).rejects.toThrow(/assessmentId or technologyId/);
    });

    it('completes a stranded placement on an ALREADY-approved assessment (targeted retry)', async () => {
      // The admin core's BUILD-005 fall-through re-attempts the placement on an
      // approved-without-placement proposal; the tool just relays the outcome.
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment({ appliedPlacementId: 'placement-late' }),
        placementOutcome: 'applied',
      });

      const r = await executeApproveAssessment(
        { assessmentId: 'pa-1', radarId: 'radar-1', quadrantId: 'q-1' },
        'user-1'
      );
      expect(r.placementOutcome).toBe('applied');
      expect(r.appliedPlacementId).toBe('placement-late');
    });

    it('reports verdict-recorded-no-target honestly when no radar target resolves', async () => {
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment({ radarId: undefined, quadrantId: undefined, appliedPlacementId: undefined }),
        placementOutcome: 'unresolved',
      });

      const r = await executeApproveAssessment({ assessmentId: 'pa-1' }, 'user-1');
      expect(mockApproveWithOutcome).toHaveBeenCalledWith('pa-1', 'user-1', {
        radarId: undefined,
        quadrantId: undefined,
      });
      expect(r.approved).toBe(true);
      expect(r.placementOutcome).toBe('unresolved');
      expect(r.message).toContain('no radar target could be resolved');
      expect(r.message).not.toContain('placed on radar');
    });

    it('reports a failed placement as retryable (never claims placement)', async () => {
      mockApproveWithOutcome.mockResolvedValue({
        assessment: approvedAssessment({ appliedPlacementId: undefined }),
        placementOutcome: 'failed',
      });

      const r = await executeApproveAssessment({ assessmentId: 'pa-1' }, 'user-1');
      expect(r.placementOutcome).toBe('failed');
      expect(r.message).toContain('retryable');
      expect(r.message).not.toContain('placed on radar');
    });

    it('rejects unauthenticated calls and invalid args before touching the admin core', async () => {
      await expect(executeApproveAssessment({ assessmentId: 'pa-1' }, '')).rejects.toThrow('authenticated user');
      await expect(executeApproveAssessment({ assessmentId: '' }, 'user-1')).rejects.toThrow('assessmentId');
      expect(mockApproveWithOutcome).not.toHaveBeenCalled();
    });

    it('surfaces the server error loud (not swallowed)', async () => {
      mockApproveWithOutcome.mockRejectedValue(new Error('Proposed assessment not found: pa-404'));
      await expect(executeApproveAssessment({ assessmentId: 'pa-404' }, 'user-1')).rejects.toThrow(
        'Proposed assessment not found: pa-404'
      );
    });
  });
});
