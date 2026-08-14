import { missionSchema } from '@/lib/schemas/mission';
import { agentRunSchema } from '@/lib/schemas/agent-run';

const baseMission = {
  id: 'mission-1',
  userId: 'user-1',
  prompt: 'p',
  agent: 'creator',
  status: 'completed' as const,
  progress: 100,
  entities: [],
  sources: [],
  createdAt: '2026-04-29T00:00:00.000Z',
};

const baseAgentRun = {
  id: 'run-1',
  userId: 'user-1',
  agentName: 'creator',
  action: 'mission',
  status: 'success' as const,
  tokenUsage: { input: 0, output: 0 },
  costUsd: 0,
  duration: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
};

describe('missionSchema skillPrelude + revisionAttempts', () => {
  it('accepts a valid skillPrelude array', () => {
    const m = missionSchema.parse({
      ...baseMission,
      skillPrelude: [
        {
          skill: 'jtbd-framing',
          target: 'Workday',
          block: '<jtbd technology="Workday">Job: ...</jtbd>',
          costUsd: 0.04,
          durationMs: 12_000,
          firedAt: '2026-04-29T00:00:01.000Z',
          success: true,
        },
      ],
    });
    expect(m.skillPrelude).toHaveLength(1);
  });

  it('accepts mixed successful and failed entries with and without target (schema unweakened)', () => {
    const m = missionSchema.parse({
      ...baseMission,
      skillPrelude: [
        {
          skill: 'jtbd-framing',
          target: 'Workday',
          block: '<jtbd technology="Workday">Job: ...</jtbd>',
          costUsd: 0.04,
          durationMs: 12_000,
          firedAt: '2026-04-29T00:00:01.000Z',
          success: true,
        },
        {
          skill: 'cynefin-classification',
          block: '',
          costUsd: 0,
          durationMs: 0,
          firedAt: '2026-04-29T00:00:02.000Z',
          success: false,
          error: 'sub-mission timed out',
        },
      ],
    });
    expect(m.skillPrelude).toHaveLength(2);
    expect(m.skillPrelude?.[1].target).toBeUndefined();
    expect(m.skillPrelude?.[1].success).toBe(false);
  });

  it('accepts a valid revisionAttempts array', () => {
    const m = missionSchema.parse({
      ...baseMission,
      revisionAttempts: [
        {
          attempt: 1,
          triggeredByVerdict: 'REVISE',
          failingChecks: ['creator-jtbd-presence'],
          feedback: 'Add JTBD blocks per tech.',
          costUsd: 1.2,
          skillInvocations: [
            {
              skill: 'design-pass',
              args: `review exact final report export ${'a'.repeat(64)}`,
              firedAt: '2026-04-29T00:04:59.000Z',
              turn: 2,
            },
          ],
          durationMs: 180_000,
          revisedAt: '2026-04-29T00:05:00.000Z',
          newVerdict: 'PASS',
        },
      ],
    });
    expect(m.revisionAttempts).toHaveLength(1);
    expect(m.revisionAttempts?.[0]?.skillInvocations?.[0]?.skill).toBe('design-pass');
  });

  it('rejects revisionAttempts with attempt > 1 (cap enforced)', () => {
    expect(() =>
      missionSchema.parse({
        ...baseMission,
        revisionAttempts: [
          {
            attempt: 2,
            triggeredByVerdict: 'REVISE',
            failingChecks: [],
            feedback: '',
            costUsd: 0,
            durationMs: 0,
            revisedAt: '2026-04-29T00:00:00.000Z',
          },
        ],
      })
    ).toThrow();
  });

  it('accepts enablePrelude=false for benchmark opt-out', () => {
    const m = missionSchema.parse({ ...baseMission, enablePrelude: false });
    expect(m.enablePrelude).toBe(false);
  });

  it('treats enablePrelude as optional (default undefined → enabled)', () => {
    const m = missionSchema.parse(baseMission);
    expect(m.enablePrelude).toBeUndefined();
  });

  it('rejects skillPrelude block longer than 4000 chars', () => {
    expect(() =>
      missionSchema.parse({
        ...baseMission,
        skillPrelude: [
          {
            skill: 'jtbd-framing',
            block: 'x'.repeat(4001),
            costUsd: 0,
            durationMs: 0,
            firedAt: '2026-04-29T00:00:00.000Z',
            success: true,
          },
        ],
      })
    ).toThrow();
  });

  it('accepts a full preludeAccounting ledger (ARUN-025)', () => {
    const m = missionSchema.parse({
      ...baseMission,
      preludeAccounting: {
        targets: {
          accepted: ['Workday Skills Cloud', 'Eightfold AI'],
          rejected: [
            { value: '2024-2026', reason: 'timeframe' },
            { value: 'the market', reason: 'generic-prose' },
          ],
          duplicates: [{ value: 'Eightfold AI', canonicalKey: 'eightfold ai' }],
          droppedForCountCap: ['Gloat'],
          countCap: 2,
        },
        tasks: {
          planned: 2,
          executed: 1,
          skipped: [{ skill: 'jtbd-framing', target: 'Eightfold AI', reason: 'budget-exhausted' }],
        },
        cost: { totalUsd: 0.3, capUsd: 2, aborted: true },
      },
    });
    expect(m.preludeAccounting?.targets.accepted).toHaveLength(2);
    expect(m.preludeAccounting?.targets.rejected[0].reason).toBe('timeframe');
    expect(m.preludeAccounting?.tasks.skipped[0].reason).toBe('budget-exhausted');
    expect(m.preludeAccounting?.cost.aborted).toBe(true);
  });

  it('rejects a preludeAccounting with a non-numeric countCap', () => {
    expect(() =>
      missionSchema.parse({
        ...baseMission,
        preludeAccounting: {
          targets: {
            accepted: [],
            rejected: [],
            duplicates: [],
            droppedForCountCap: [],
            countCap: 'six',
          },
          tasks: { planned: 0, executed: 0, skipped: [] },
          cost: { totalUsd: 0, capUsd: 2, aborted: false },
        },
      })
    ).toThrow();
  });
});

describe('agentRunSchema skillPrelude + revisionAttempts', () => {
  it('accepts mirrored fields', () => {
    const r = agentRunSchema.parse({
      ...baseAgentRun,
      skillPrelude: [
        {
          skill: 'cynefin-classification',
          block: '<cynefin>Domain: Complicated</cynefin>',
          costUsd: 0.02,
          durationMs: 8_000,
          firedAt: '2026-04-29T00:00:01.000Z',
          success: true,
        },
      ],
      revisionAttempts: [],
    });
    expect(r.skillPrelude).toHaveLength(1);
    expect(r.revisionAttempts).toEqual([]);
  });
});
