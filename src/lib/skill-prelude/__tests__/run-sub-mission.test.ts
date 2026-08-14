import { runSkillSubMission } from '../run-sub-mission';
import type { SubMissionInput } from '../run-sub-mission';

interface MockOrchestrator {
  runMission: jest.Mock;
}

function makeMockOrchestrator(result: {
  success: boolean;
  result?: string;
  costUsd?: number | null;
  costUnavailableReason?: string;
  errors?: string[];
}): MockOrchestrator {
  return {
    runMission: jest.fn().mockResolvedValue({
      success: result.success,
      result: result.result ?? '',
      costUsd: result.costUsd,
      costUnavailableReason: result.costUnavailableReason,
      tokenUsage: { input: 100, output: 50 },
      durationApiMs: 1000,
      errors: result.errors,
    }),
  };
}

describe('runSkillSubMission', () => {
  it('returns success result with the fenced block', async () => {
    const mock = makeMockOrchestrator({
      success: true,
      result: '<jtbd technology="Workday">Job: minimize time-to-mobility</jtbd>',
      costUsd: 0.04,
    });

    const result = await runSkillSubMission({
      skill: 'jtbd-framing',
      target: 'Workday Skills Cloud',
      maxCostUsd: 0.3,
      timeoutMs: 60_000,
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });

    expect(result.success).toBe(true);
    expect(result.skill).toBe('jtbd-framing');
    expect(result.target).toBe('Workday Skills Cloud');
    expect(result.block).toContain('<jtbd');
    expect(result.costUsd).toBeCloseTo(0.04);
    expect(result.error).toBeUndefined();
  });

  it('builds the prompt with the skill + target', async () => {
    const mock = makeMockOrchestrator({ success: true, result: 'block' });
    await runSkillSubMission({
      skill: 'evolution-stage',
      target: 'Eightfold AI',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });

    const promptArg = mock.runMission.mock.calls[0][0] as string;
    expect(promptArg).toContain('evolution-stage');
    expect(promptArg).toContain('Eightfold AI');
    expect(promptArg).toMatch(/fenced block/i);
  });

  it('omits target wording for brief-level skills', async () => {
    const mock = makeMockOrchestrator({ success: true, result: '<cynefin>...</cynefin>' });
    await runSkillSubMission({
      skill: 'cynefin-classification',
      briefContext: 'Vendor selection in AI-in-HR',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });

    const promptArg = mock.runMission.mock.calls[0][0] as string;
    expect(promptArg).toContain('cynefin-classification');
    expect(promptArg).toContain('Vendor selection in AI-in-HR');
  });

  it('emits an explicit undefined target key for brief-level skills (stripped at the persistence boundary)', async () => {
    const mock = makeMockOrchestrator({ success: true, result: '<cynefin>...</cynefin>' });
    const result = await runSkillSubMission({
      skill: 'cynefin-classification',
      briefContext: 'Vendor selection in AI-in-HR',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });

    expect(Object.prototype.hasOwnProperty.call(result, 'target')).toBe(true);
    expect(result.target).toBeUndefined();
  });

  it('marks the result as failed when the orchestrator returns success=false', async () => {
    const mock = makeMockOrchestrator({ success: false, errors: ['budget exceeded'] });
    const result = await runSkillSubMission({
      skill: 'jtbd-framing',
      target: 'Workday',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('budget exceeded');
    expect(result.block).toBe('');
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailableReason).toBe('accounting-incomplete');
  });

  it('preserves an unpriceable successful sub-mission as null instead of a false zero', async () => {
    const mock = makeMockOrchestrator({
      success: true,
      result: '<jtbd>priced content unavailable</jtbd>',
      costUsd: null,
      costUnavailableReason: 'model=unknown: no rate card',
    });

    const result = await runSkillSubMission({
      skill: 'jtbd-framing',
      target: 'Workday',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });

    expect(result.success).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailableReason).toBe('unknown-pricing');
  });

  it('marks the result as failed when the orchestrator throws', async () => {
    const mock = { runMission: jest.fn().mockRejectedValue(new Error('SDK crash')) };
    const result = await runSkillSubMission({
      skill: 'jtbd-framing',
      target: 'Workday',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SDK crash');
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailableReason).toBe('accounting-incomplete');
  });

  it('truncates a block longer than 4000 chars', async () => {
    const mock = makeMockOrchestrator({ success: true, result: 'x'.repeat(5000) });
    const result = await runSkillSubMission({
      skill: 'jtbd-framing',
      target: 'Workday',
      createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
    });
    expect(result.block.length).toBe(4000);
  });

  // ARUN-022 / AI-029 — a helper session is paid out-of-process provider work.
  // Its per-SERVED-MODEL usage must reach the caller so durable receipts can be
  // flushed; before this it was dropped at the wrapper's type boundary and the
  // spend survived only as an aggregated cost with no model and no counters.
  describe('per-served-model usage passthrough', () => {
    const modelUsage = {
      'claude-sonnet-4-6': {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadInputTokens: 9_000,
        cacheCreationInputTokens: 300,
        costUSD: 0.031,
      },
    };

    function orchestratorReturning(extra: Record<string, unknown>) {
      return {
        runMission: jest.fn().mockResolvedValue({
          success: true,
          result: '<jtbd technology="Workday">Job</jtbd>',
          costUsd: 0.031,
          tokenUsage: { input: 120, output: 45 },
          ...extra,
        }),
      };
    }

    it('surfaces the provider-reported model usage on a successful helper', async () => {
      const mock = orchestratorReturning({ modelUsage });
      const result = await runSkillSubMission({
        skill: 'jtbd-framing',
        target: 'Workday',
        createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
      });

      expect(result.success).toBe(true);
      expect(result.modelUsage).toEqual(modelUsage);
    });

    it('surfaces it on a FAILED helper too — a failed session still burned tokens', async () => {
      const mock = {
        runMission: jest.fn().mockResolvedValue({
          success: false,
          errors: ['skill produced no block'],
          costUsd: 0.012,
          modelUsage,
        }),
      };

      const result = await runSkillSubMission({
        skill: 'jtbd-framing',
        target: 'Workday',
        createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
      });

      expect(result.success).toBe(false);
      expect(result.modelUsage).toEqual(modelUsage);
    });

    it('omits the field entirely when the provider reported no per-model facts', async () => {
      for (const extra of [{}, { modelUsage: {} }]) {
        const mock = orchestratorReturning(extra);
        const result = await runSkillSubMission({
          skill: 'jtbd-framing',
          target: 'Workday',
          createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
        });
        // Absent, never an empty object that a caller might read as "no spend".
        expect(result.modelUsage).toBeUndefined();
      }
    });

    it('reports no model usage when the helper threw before any response arrived', async () => {
      const mock = { runMission: jest.fn().mockRejectedValue(new Error('SDK crash')) };
      const result = await runSkillSubMission({
        skill: 'jtbd-framing',
        target: 'Workday',
        createOrchestrator: () => mock as unknown as ReturnType<SubMissionInput['createOrchestrator']>,
      });

      expect(result.modelUsage).toBeUndefined();
      // The wrapper still refuses to claim the throw cost exactly zero.
      expect(result.costUsd).toBeNull();
      expect(result.costUnavailableReason).toBe('accounting-incomplete');
    });
  });
});
