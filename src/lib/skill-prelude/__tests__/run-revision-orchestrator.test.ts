/**
 * @jest-environment node
 */

/**
 * @file Tests for runRevisionOrchestrator
 *
 * The helper wraps the agent-SDK dynamic import in a try/catch and always
 * returns a structured { success, errors?, ... } result. Under Jest the
 * dynamic `@/lib/agent-import` import cannot be resolved (ESM), so the
 * catch path is exercised automatically.
 */

import { runRevisionOrchestrator } from '../run-revision-orchestrator';

const mockRevisionRunMission = jest.fn();
const mockImportOrchestrator = jest.fn();
const mockAppendSkillInvocation = jest.fn();
jest.mock('@/lib/agent-import', () => ({
  importOrchestrator: (...args: unknown[]) => mockImportOrchestrator(...args),
}));
jest.mock('@/lib/missions', () => ({
  appendSkillInvocation: (...args: unknown[]) => mockAppendSkillInvocation(...args),
}));

describe('runRevisionOrchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockImportOrchestrator.mockRejectedValue(new Error('agent runtime unavailable in test'));
  });

  it('returns success: false with error string when the agent SDK import fails', async () => {
    // The dynamic `await import('@/lib/agent-import')` will fail under Jest
    // because the module uses ESM dynamic-import internally. The wrapper
    // catches that and returns a structured failure.
    const result = await runRevisionOrchestrator({
      prompt: 'test revision prompt',
      agentsDir: '/tmp/agents',
      configPath: '/tmp/config.yaml',
      maxBudgetUsd: 1.0,
      timeoutMs: 60_000,
    });

    expect(result.success).toBe(false);
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailableReason).toBe('accounting-incomplete');
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('includes an error message string (not [object Object])', async () => {
    const result = await runRevisionOrchestrator({
      prompt: 'another prompt',
      agentsDir: '/tmp/agents',
      configPath: '/tmp/config.yaml',
      maxBudgetUsd: 0.5,
      timeoutMs: 30_000,
    });

    expect(result.errors![0]).not.toBe('[object Object]');
    expect(typeof result.errors![0]).toBe('string');
    expect(result.errors![0].length).toBeGreaterThan(0);
  });

  it('returns structured result even when apiKey and logFilePath are omitted', async () => {
    // Optional fields should not cause a type error or unhandled rejection
    const result = await runRevisionOrchestrator({
      prompt: 'minimal input',
      agentsDir: '/tmp/agents',
      configPath: '/tmp/config.yaml',
      maxBudgetUsd: 2.0,
      timeoutMs: 120_000,
      // apiKey and logFilePath intentionally omitted
    });

    // Always returns a structured object — never throws
    expect(typeof result).toBe('object');
    expect(typeof result.success).toBe('boolean');
  });

  it('returns and persists formal Skill() receipts from the revision session', async () => {
    const invocation = {
      skill: 'cite-ieee',
      args: 'repair the exact current report',
      firedAt: '2026-08-01T18:00:00.000Z',
      turn: 3,
    };
    mockRevisionRunMission.mockResolvedValue({
      success: true,
      result: 'revised artifact',
      costUsd: 0.2,
      tokenUsage: { input: 100, output: 50 },
    });
    mockImportOrchestrator.mockResolvedValue({
      createLogger: jest.fn(() => ({ info: jest.fn() })),
      Orchestrator: class MockOrchestrator {
        private readonly options: {
          onSkillInvocation?: (inv: typeof invocation) => Promise<void>;
        };

        constructor(options: { onSkillInvocation?: (inv: typeof invocation) => Promise<void> }) {
          this.options = options;
        }

        async runMission(prompt: string) {
          await this.options.onSkillInvocation?.(invocation);
          return mockRevisionRunMission(prompt);
        }
      },
    });

    const result = await runRevisionOrchestrator({
      prompt: 'revise exact artifact',
      agentsDir: '/tmp/agents',
      configPath: '/tmp/config.yaml',
      maxBudgetUsd: 1,
      timeoutMs: 60_000,
      missionId: 'mission-revision-skill',
    });

    expect(result.skillInvocations).toEqual([invocation]);
    expect(mockAppendSkillInvocation).toHaveBeenCalledWith('mission-revision-skill', invocation);
  });

  it('preserves an unpriceable revision result as canonical null/unknown-pricing', async () => {
    mockRevisionRunMission.mockResolvedValue({
      success: true,
      result: 'revised artifact',
      costUsd: null,
      costUnavailableReason: 'model=made-up-model: no rate card',
      tokenUsage: { input: 100, output: 50 },
    });
    mockImportOrchestrator.mockResolvedValue({
      createLogger: jest.fn(() => ({ info: jest.fn() })),
      Orchestrator: class MockOrchestrator {
        runMission(prompt: string) {
          return mockRevisionRunMission(prompt);
        }
      },
    });

    const result = await runRevisionOrchestrator({
      prompt: 'revise this',
      agentsDir: '/tmp/agents',
      configPath: '/tmp/config.yaml',
      maxBudgetUsd: 1,
      timeoutMs: 60_000,
    });

    expect(result).toMatchObject({
      success: true,
      costUsd: null,
      costUnavailableReason: 'unknown-pricing',
    });
  });

  // ARUN-022 / AI-029 — the revision turn is a full paid out-of-process
  // Anthropic session. Its per-SERVED-MODEL summary must survive the wrapper so
  // the Inngest handler can flush durable receipts; the wrapper's declared
  // result type used to omit it, so the spend reached the ledger as a
  // session-level cost with no served model and no token/cache counters.
  describe('per-served-model usage passthrough', () => {
    const modelUsage = {
      'claude-sonnet-4-6': {
        inputTokens: 900,
        outputTokens: 400,
        cacheReadInputTokens: 12_000,
        cacheCreationInputTokens: 800,
        costUSD: 0.21,
      },
    };

    function withOrchestrator() {
      mockImportOrchestrator.mockResolvedValue({
        createLogger: jest.fn(() => ({ info: jest.fn() })),
        Orchestrator: class MockOrchestrator {
          runMission(prompt: string) {
            return mockRevisionRunMission(prompt);
          }
        },
      });
    }

    async function run() {
      return runRevisionOrchestrator({
        prompt: 'revise this',
        agentsDir: '/tmp/agents',
        configPath: '/tmp/config.yaml',
        maxBudgetUsd: 1,
        timeoutMs: 60_000,
      });
    }

    it('surfaces the provider-reported model usage on a priced revision', async () => {
      mockRevisionRunMission.mockResolvedValue({
        success: true,
        result: 'revised artifact',
        costUsd: 0.21,
        tokenUsage: { input: 900, output: 400 },
        modelUsage,
      });
      withOrchestrator();

      const result = await run();

      expect(result.modelUsage).toEqual(modelUsage);
    });

    it('surfaces it on a FAILED revision — the turn still burned tokens', async () => {
      mockRevisionRunMission.mockResolvedValue({
        success: false,
        errors: ['revision produced no artifact'],
        costUsd: 0.09,
        modelUsage,
      });
      withOrchestrator();

      const result = await run();

      expect(result.success).toBe(false);
      expect(result.modelUsage).toEqual(modelUsage);
    });

    it('surfaces it when the turn was cut short and the cost is unavailable', async () => {
      // A timeout/abort path: the orchestrator recovers usage but cannot price
      // a truthful total. The usage facts must still reach the ledger.
      mockRevisionRunMission.mockResolvedValue({
        success: false,
        errors: ['revision timed out'],
        costUsd: null,
        costUnavailableReason: 'accounting-incomplete',
        modelUsage,
      });
      withOrchestrator();

      const result = await run();

      expect(result.costUsd).toBeNull();
      expect(result.costUnavailableReason).toBe('accounting-incomplete');
      expect(result.modelUsage).toEqual(modelUsage);
    });

    it('reports no model usage when the dispatch itself threw', async () => {
      mockImportOrchestrator.mockRejectedValue(new Error('agent runtime unavailable'));

      const result = await run();

      expect(result.success).toBe(false);
      expect(result.modelUsage).toBeUndefined();
      expect(result.costUnavailableReason).toBe('accounting-incomplete');
    });
  });
});
