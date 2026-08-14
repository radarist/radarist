/**
 * @file lib/__tests__/mission-chains.test.ts
 * @description Unit tests for mission chaining (Superpower #2).
 *
 * Tests the pure helpers (renderPromptWithParent, shouldAdvanceChain) with
 * direct input; tests createChain + findNextChainStep with Firestore mocks.
 *
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    set: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  },
}));

jest.mock('@/lib/missions', () => ({
  createMission: jest.fn(),
}));

import type { Mission } from '@/lib/schemas/mission';
import { renderPromptWithParent, shouldAdvanceChain, createChain, findNextChainStep } from '../mission-chains';
import { db } from '@/lib/firebase-admin';
import { createMission, type CreateMissionExtras } from '@/lib/missions';

type JestMock = jest.Mock<any, any>;

const mockDb = db as unknown as {
  collection: JestMock;
  doc: JestMock;
  set: JestMock;
  get: JestMock;
  update: JestMock;
  where: JestMock;
  limit: JestMock;
};

const mockCreateMission = createMission as unknown as JestMock;

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    userId: 'user-1',
    prompt: 'do a thing',
    agent: 'scout',
    status: 'completed',
    progress: 100,
    entities: [],
    sources: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Mission;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('renderPromptWithParent', () => {
  it('substitutes {{parent.result}} with the parent result', () => {
    const out = renderPromptWithParent('Analyze this: {{parent.result}}', 'FUNDING_EVENT_JSON');
    expect(out).toBe('Analyze this: FUNDING_EVENT_JSON');
  });

  it('handles whitespace in the placeholder', () => {
    const out = renderPromptWithParent('Input: {{ parent.result }}', 'X');
    expect(out).toBe('Input: X');
  });

  it('leaves prompt unchanged when no placeholder present', () => {
    const prompt = 'Research AI funding rounds this week';
    expect(renderPromptWithParent(prompt, 'anything')).toBe(prompt);
  });

  it('caps parent result at 32KB', () => {
    const huge = 'y'.repeat(50 * 1024);
    const out = renderPromptWithParent('{{parent.result}}', huge);
    expect(out.length).toBe(32 * 1024);
  });

  it('substitutes empty string when parent result is undefined', () => {
    const out = renderPromptWithParent('Input: {{parent.result}} end', undefined);
    expect(out).toBe('Input:  end');
  });

  it('replaces all occurrences', () => {
    const out = renderPromptWithParent('A={{parent.result}} B={{parent.result}}', 'X');
    expect(out).toBe('A=X B=X');
  });
});

describe('shouldAdvanceChain', () => {
  it('returns true for a clean completion', () => {
    expect(shouldAdvanceChain(makeMission({ status: 'completed' }))).toBe(true);
  });

  it('returns false for a partial-recovery mission', () => {
    const m = { ...makeMission({ status: 'completed' }), partial: true } as Mission;
    expect(shouldAdvanceChain(m)).toBe(false);
  });

  it('returns false for a failed mission', () => {
    expect(shouldAdvanceChain(makeMission({ status: 'failed' }))).toBe(false);
  });

  it('returns false for a still-running mission', () => {
    expect(shouldAdvanceChain(makeMission({ status: 'running' }))).toBe(false);
  });
});

describe('createChain', () => {
  it('rejects an empty steps array', async () => {
    await expect(createChain('user-1', [])).rejects.toThrow(/at least 1 step/);
  });

  it('rejects more than 5 steps', async () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({ agent: 'scout', prompt: `step ${i}` }));
    await expect(createChain('user-1', steps)).rejects.toThrow(/max of 5/);
  });

  it('creates mission docs for every step and attaches chain metadata', async () => {
    const missionDocs = [
      makeMission({ id: 'm1', agent: 'scout', prompt: 'step 1' }),
      makeMission({ id: 'm2', agent: 'evaluator', prompt: 'step 2' }),
    ];
    mockCreateMission.mockResolvedValueOnce(missionDocs[0]).mockResolvedValueOnce(missionDocs[1]);
    mockDb.update.mockResolvedValue(undefined);

    const result = await createChain('user-1', [
      { agent: 'scout', prompt: 'step 1' },
      { agent: 'evaluator', prompt: 'step 2' },
    ]);

    expect(result.chainId).toMatch(/^chain-/);
    expect(result.missions).toHaveLength(2);
    expect(result.missions[0].chainId).toBe(result.chainId);
    expect(result.missions[0].chainStep).toBe(1);
    expect(result.missions[0].chainTotalSteps).toBe(2);
    expect(result.missions[0].parentMissionId).toBeUndefined();
    expect(result.missions[1].chainStep).toBe(2);
    expect(result.missions[1].parentMissionId).toBe('m1');
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });

  it('OPS-004: applies deliverableExtras to the LAST (report-producing) step only', async () => {
    mockCreateMission
      .mockResolvedValueOnce(makeMission({ id: 'm1', agent: 'scout' }))
      .mockResolvedValueOnce(makeMission({ id: 'm2', agent: 'creator' }));
    mockDb.update.mockResolvedValue(undefined);

    const extras = {
      slots: [{ name: 'main', intent: 'vendor report' }],
      classifierMetadata: { latencyMs: 5, costUsd: 0.003, fallback: false, model: 'm' },
    };
    await createChain(
      'user-1',
      [
        { agent: 'scout', prompt: 'research' },
        { agent: 'creator', prompt: 'report' },
      ],
      extras
    );

    // Step 1 (scout) gets empty extras; step 2 (creator, the deliverable) gets them.
    // AI-053 preserves this exactly for the 3-arg form — it is the contract that
    // lets the sweep cron and the HTTP route stay untouched.
    expect(mockCreateMission.mock.calls[0][2]).toEqual({});
    expect(mockCreateMission.mock.calls[1][2]).toEqual(extras);
  });

  // --------------------------------------------------------------------------
  // AI-053: per-step execution envelopes.
  //
  // `deliverableExtras` is attached to ONE step so the one-time classifier cost
  // is not double-counted. An execution envelope is the opposite: it is
  // per-mission, and a step created without one runs on environment defaults —
  // i.e. outside the amount the user confirmed.
  // --------------------------------------------------------------------------

  // Structural stand-ins for the real envelope: createChain only forwards these
  // to the (mocked) createMission, so the cast belongs at the call boundary —
  // casting the constants themselves to `never` would poison every spread.
  const SCOUT_COST = {
    authorizedMaxCostUsd: 31,
    executionEnvelope: { totalMaxCostUsd: 31, requestedModel: 'claude-sonnet-4-6' },
  };
  const CREATOR_COST = {
    authorizedMaxCostUsd: 31,
    executionEnvelope: { totalMaxCostUsd: 31, requestedModel: 'claude-opus-4-8' },
  };
  const asExtras = (extras: object[]) => extras as unknown as CreateMissionExtras[];

  it('AI-053: applies perStepExtras to EVERY step, deliverableExtras still to the last only', async () => {
    mockCreateMission
      .mockResolvedValueOnce(makeMission({ id: 'm1', agent: 'scout' }))
      .mockResolvedValueOnce(makeMission({ id: 'm2', agent: 'creator' }));
    mockDb.update.mockResolvedValue(undefined);

    const deliverableExtras = { slots: [{ name: 'main', intent: 'vendor report' }] };
    await createChain(
      'user-1',
      [
        { agent: 'scout', prompt: 'research' },
        { agent: 'creator', prompt: 'report' },
      ],
      deliverableExtras,
      asExtras([SCOUT_COST, CREATOR_COST])
    );

    // The scout is no longer created unauthorized — that WAS the AI-053 defect.
    expect(mockCreateMission.mock.calls[0][2]).toEqual(SCOUT_COST);
    expect(mockCreateMission.mock.calls[1][2]).toEqual({ ...CREATOR_COST, ...deliverableExtras });
  });

  it('AI-053: deliverableExtras wins a colliding key on the last step', async () => {
    mockCreateMission
      .mockResolvedValueOnce(makeMission({ id: 'm1', agent: 'scout' }))
      .mockResolvedValueOnce(makeMission({ id: 'm2', agent: 'creator' }));
    mockDb.update.mockResolvedValue(undefined);

    // Pins the spread order. The two key spaces are disjoint by contract, so this
    // only ever fires if a future caller puts the same key in both bags.
    await createChain(
      'user-1',
      [
        { agent: 'scout', prompt: 'research' },
        { agent: 'creator', prompt: 'report' },
      ],
      { slots: [{ name: 'main', intent: 'deliverable wins' }] },
      asExtras([SCOUT_COST, { slots: [{ name: 'ghost', intent: 'per-step loses' }] }])
    );

    const lastExtras = mockCreateMission.mock.calls[1][2] as { slots: Array<{ name: string }> };
    expect(lastExtras.slots[0].name).toBe('main');
  });

  it('AI-053: refuses a perStepExtras array whose length does not match the chain, writing nothing', async () => {
    // Without the explicit length check, `perStepExtras?.[i] ?? {}` degrades
    // silently to an unauthorized step — the exact defect this row removes.
    await expect(
      createChain(
        'user-1',
        [
          { agent: 'scout', prompt: 'research' },
          { agent: 'creator', prompt: 'report' },
        ],
        {},
        asExtras([SCOUT_COST])
      )
    ).rejects.toThrow(/does not match the 2-step chain/);

    expect(mockCreateMission).not.toHaveBeenCalled();
  });

  it('AI-053: omitting perStepExtras leaves middle steps byte-identical to the 3-arg form', async () => {
    mockCreateMission
      .mockResolvedValueOnce(makeMission({ id: 'm1', agent: 'scout' }))
      .mockResolvedValueOnce(makeMission({ id: 'm2', agent: 'scout' }))
      .mockResolvedValueOnce(makeMission({ id: 'm3', agent: 'creator' }));
    mockDb.update.mockResolvedValue(undefined);

    const extras = { slots: [{ name: 'main', intent: 'report' }] };
    await createChain(
      'user-1',
      [
        { agent: 'scout', prompt: 'a' },
        { agent: 'scout', prompt: 'b' },
        { agent: 'creator', prompt: 'c' },
      ],
      extras
    );

    expect(mockCreateMission.mock.calls[0][2]).toEqual({});
    expect(mockCreateMission.mock.calls[1][2]).toEqual({});
    expect(mockCreateMission.mock.calls[2][2]).toEqual(extras);
  });
});

describe('shouldAdvanceChain — quality halt', () => {
  it('advances when the parent L2 verdict is PASS and overallScore ≥ 0.6', () => {
    const m = makeMission({
      qualityJudgement: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        judgeModel: 'gemini-3-flash-preview',
        overallScore: 0.85,
        verdict: 'PASS',
        dimensions: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(true);
  });

  it('halts when the parent L2 overallScore is below 0.6', () => {
    const m = makeMission({
      qualityJudgement: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        judgeModel: 'gemini-3-flash-preview',
        overallScore: 0.25,
        verdict: 'FAIL',
        dimensions: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(false);
  });

  it('halts when the parent L1 verdict is FAIL (even without L2)', () => {
    const m = makeMission({
      qualityReport: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        overallScore: 0.1,
        verdict: 'FAIL',
        checks: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(false);
  });

  it('halts on L1 FAIL even when L2 is above the threshold', () => {
    // L1 critical checks (scout-bundle-parseable, scout-no-citation-padding)
    // encode narrow deterministic violations that a high L2 overall score
    // can mask. L1 FAIL must halt regardless.
    const m = makeMission({
      qualityReport: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        overallScore: 0.38,
        verdict: 'FAIL',
        checks: [],
      },
      qualityJudgement: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        judgeModel: 'gemini-3-flash-preview',
        overallScore: 0.81, // well above the 0.6 halt threshold
        verdict: 'REVISE',
        dimensions: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(false);
  });

  it('advances when L1 is REVISE (soft issues) and no L2 is present', () => {
    const m = makeMission({
      qualityReport: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        overallScore: 0.7,
        verdict: 'REVISE',
        checks: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(true);
  });

  it('advances when neither L1 nor L2 is present (trivial prompts skip both)', () => {
    expect(shouldAdvanceChain(makeMission({}))).toBe(true);
  });

  it('still halts on partial + any quality (partial precedes quality check)', () => {
    const m = { ...makeMission({ status: 'completed' }), partial: true } as Mission;
    Object.assign(m, {
      qualityJudgement: {
        evaluatedAt: '2026-04-22T00:05:00Z',
        judgeModel: 'gemini-3-flash-preview',
        overallScore: 0.9,
        verdict: 'PASS',
        dimensions: [],
      },
    });
    expect(shouldAdvanceChain(m)).toBe(false);
  });
});

describe('findNextChainStep', () => {
  it('returns null when current mission has no chainId', async () => {
    const next = await findNextChainStep(makeMission({}));
    expect(next).toBeNull();
  });

  it('returns null when current mission is the last step', async () => {
    const current = makeMission({ chainId: 'c1', chainStep: 3, chainTotalSteps: 3 });
    const next = await findNextChainStep(current);
    expect(next).toBeNull();
  });

  it('queries for the next step and returns it when found', async () => {
    const current = makeMission({ chainId: 'c1', chainStep: 1, chainTotalSteps: 3 });
    const nextMission = makeMission({ id: 'm2', chainId: 'c1', chainStep: 2 });

    mockDb.get.mockResolvedValueOnce({
      empty: false,
      docs: [{ data: () => nextMission }],
    });

    const next = await findNextChainStep(current);
    expect(next).toEqual(nextMission);
    expect(mockDb.where).toHaveBeenCalledWith('chainId', '==', 'c1');
    expect(mockDb.where).toHaveBeenCalledWith('chainStep', '==', 2);
  });

  it('returns null when no matching next step exists', async () => {
    const current = makeMission({ chainId: 'c1', chainStep: 1, chainTotalSteps: 3 });
    mockDb.get.mockResolvedValueOnce({ empty: true, docs: [] });

    const next = await findNextChainStep(current);
    expect(next).toBeNull();
  });
});
