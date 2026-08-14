/**
 * @file build-mission-iterate.test.ts
 * @description Locks the shared iterate core (BUILD-019) used by BOTH the
 * /api/missions/:id/iterate route and the iterateBuildArtifact AI tool:
 * precondition codes, the Iteration-N brief append, the fresh QA slate, the
 * budget bump, and the supervisor re-dispatch.
 *
 * @jest-environment node
 */

export {}; // module-scope the mock consts

const mockGetMissionById = jest.fn();
const mockUpdateMission = jest.fn();
const mockInngestSend = jest.fn();
const mockSandboxExec = jest.fn();

jest.mock('@/lib/missions', () => ({
  getMissionById: (...a: unknown[]) => mockGetMissionById(...a),
  updateMission: (...a: unknown[]) => mockUpdateMission(...a),
}));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => mockInngestSend(...a) } }));
jest.mock('@/lib/agent-import', () => ({
  importSandbox: jest.fn(async () => ({ defaultExec: (...a: unknown[]) => mockSandboxExec(...a) })),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { iterateBuildMission, resumeBuildMission } = require('../build-mission-iterate');
const { MISSION_PROMPT_MAX_CHARS } = require('../schemas/mission');

const BASE_MISSION = {
  id: 'm-1',
  userId: 'user-1',
  kind: 'build',
  status: 'completed',
  sandbox: { volume: 'vol-1' },
  prompt: '# Mission: Todo App\n## Done means\n- CRUD works',
  budget: { capUsd: 25, warnThreshold: 0.8, topUps: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMissionById.mockResolvedValue(BASE_MISSION);
  mockUpdateMission.mockResolvedValue(undefined);
  mockInngestSend.mockResolvedValue(undefined);
  mockSandboxExec.mockResolvedValue({ code: 0, stdout: '[]', stderr: '' });
});

describe('iterateBuildMission preconditions', () => {
  it.each([
    ['not-found', null],
    ['forbidden', { ...BASE_MISSION, userId: 'someone-else' }],
    ['not-build', { ...BASE_MISSION, kind: 'research' }],
    ['running', { ...BASE_MISSION, status: 'running' }],
    ['running', { ...BASE_MISSION, status: 'pending' }],
    ['no-sandbox', { ...BASE_MISSION, sandbox: undefined }],
  ] as Array<[string, Record<string, unknown> | null]>)(
    'returns %s without any write or dispatch',
    async (code, mission) => {
      mockGetMissionById.mockResolvedValue(mission);
      const r = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x' });
      expect(r).toMatchObject({ ok: false, code });
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    }
  );

  // ARUN-005: system-dispatched builds are iterable by the local user;
  // only another human's missions stay forbidden.
  it('allows iterating a system-owned build', async () => {
    mockGetMissionById.mockResolvedValue({ ...BASE_MISSION, userId: 'system-discovery' });
    const r = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x' });
    expect(r).toMatchObject({ ok: true });
  });

  it('rejects a brief that would exceed MISSION_PROMPT_MAX_CHARS', async () => {
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      prompt: 'x'.repeat(MISSION_PROMPT_MAX_CHARS - 10),
    });
    const r = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'y'.repeat(100) });
    expect(r).toMatchObject({ ok: false, code: 'brief-too-long' });
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });
});

describe('iterateBuildMission dispatch', () => {
  it('appends an "## Iteration N" block, resets the QA slate, bumps the budget, and re-dispatches', async () => {
    const r = await iterateBuildMission({
      missionId: 'm-1',
      userId: 'user-1',
      instructions: 'Make the landing page dark-mode.',
    });

    expect(r).toEqual({ ok: true, missionId: 'm-1', iteration: 1 });
    const [, update] = mockUpdateMission.mock.calls[0];
    expect(update.prompt).toContain('## Iteration 1');
    expect(update.prompt).toContain('Make the landing page dark-mode.');
    expect(update.prompt.startsWith(BASE_MISSION.prompt)).toBe(true); // original brief retained
    expect(update.status).toBe('pending');
    expect(update.qaGate).toEqual({ attempts: 0, findings: [] }); // must re-earn its PASS
    expect(update.budget).toEqual({ capUsd: 35, warnThreshold: 0.8, topUps: [] }); // 25 + default 10
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'app/build-mission.run.requested',
      data: { missionId: 'm-1', userId: 'user-1', instructions: 'Make the landing page dark-mode.' },
    });
  });

  it('counts prior iterations from the brief so the Nth iteration is numbered honestly', async () => {
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      prompt: `${BASE_MISSION.prompt}\n\n---\n\n## Iteration 1 (2026-07-10)\n\nfirst tweak\n`,
    });
    const r = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'second tweak' });
    expect(r).toMatchObject({ ok: true, iteration: 2 });
    const [, update] = mockUpdateMission.mock.calls[0];
    expect(update.prompt).toContain('## Iteration 2');
  });

  it('honors an explicit additionalBudgetUsd', async () => {
    await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x', additionalBudgetUsd: 40 });
    const [, update] = mockUpdateMission.mock.calls[0];
    expect(update.budget.capUsd).toBe(65);
  });
});

// AUDIT-017 — the GC destroys the container AND its volume, then writes
// `sandbox.state: 'destroyed'`. Nothing read that field, and `!mission.sandbox`
// is still false for a reclaimed sandbox (the object survives), so an iterate
// past the retention window provisioned a BRAND-NEW EMPTY volume and forced the
// agent into phase 06-build against code that no longer existed: real spend,
// nonsense artifact, and a false "resumes the same sandbox" promise.
describe('reclaimed sandbox (AUDIT-017)', () => {
  it('refuses to iterate a build whose sandbox the GC already reclaimed', async () => {
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      sandbox: { volume: 'vol-1', state: 'destroyed' },
    });

    const res = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'add dark mode' });

    expect(res).toEqual({
      ok: false,
      code: 'sandbox-reclaimed',
      error: expect.stringContaining('reclaimed'),
    });
    // The whole point: no money is spent and no empty sandbox is provisioned.
    expect(mockInngestSend).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it.each(['running', 'stopped', 'paused'])('still iterates a sandbox in state %s', async (state) => {
    mockGetMissionById.mockResolvedValue({ ...BASE_MISSION, sandbox: { volume: 'vol-1', state } });
    const res = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x' });
    expect(res.ok).toBe(true);
  });
});

// AUDIT-016 — an iterate used to raise the cap by a flat +$10 forever while the
// supervisor re-zeroed its spend counter, so each iteration bought a fresh
// envelope and the budget gate could never fire.
describe('cumulative spend ceiling (AUDIT-016)', () => {
  const original = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
  afterEach(() => {
    if (original === undefined) delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
    else process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = original;
  });

  it('refuses to iterate a mission that has reached the cumulative ceiling', async () => {
    process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '150';
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      costUsd: 150, // already at the ceiling
      budget: { capUsd: 150, warnThreshold: 0.8, topUps: [] },
    });

    const res = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'again' });

    expect(res).toEqual({
      ok: false,
      code: 'budget-exhausted',
      error: expect.stringContaining('150'),
    });
    expect(mockInngestSend).not.toHaveBeenCalled(); // no dispatch, no spend
  });

  it('clamps the new cap to the ceiling instead of growing +$10 without bound', async () => {
    process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '150';
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      costUsd: 100,
      budget: { capUsd: 145, warnThreshold: 0.8, topUps: [] },
    });

    const res = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x' });

    expect(res.ok).toBe(true);
    const update = mockUpdateMission.mock.calls[0][1];
    expect(update.budget.capUsd).toBe(150); // 145 + 10 = 155 → clamped, NOT 155
  });

  // A session can overshoot its cap. The top-up must buy NEW room rather than
  // silently back-filling spend that already happened.
  it('bases new headroom on actual cumulative spend when a prior run overshot its cap', async () => {
    mockGetMissionById.mockResolvedValue({
      ...BASE_MISSION,
      costUsd: 30, // overshot the 25 cap
      budget: { capUsd: 25, warnThreshold: 0.8, topUps: [] },
    });

    const res = await iterateBuildMission({ missionId: 'm-1', userId: 'user-1', instructions: 'x' });

    expect(res.ok).toBe(true);
    const update = mockUpdateMission.mock.calls[0][1];
    // max(25, 30) + 10 = 40, giving a real $10 of headroom.
    // The old `priorCap + additional` = 35 would have granted only $5.
    expect(update.budget.capUsd).toBe(40);
  });
});

// BUILD-038: recovery is a bounded same-volume continuation, not a one-click
// implicit +$25. Turn and USD authority are separate; USD requires a confirmed
// authenticated caller and is appended to the top-up ledger.
describe('resumeBuildMission', () => {
  const RESUMABLE_MISSION = {
    ...BASE_MISSION,
    status: 'failed',
    completedAt: '2026-07-19T09:00:00.000Z',
    buildMode: 'limitless',
    buildPhase: '06-build',
    sandbox: { volumeName: 'radarist_build_m-1', state: 'stopped' },
    sessions: [
      {
        index: 0,
        role: 'builder',
        objective: 'build',
        model: 'claude-opus-4-8',
        startedAt: '2026-07-19T08:00:00.000Z',
        endedAt: '2026-07-19T09:00:00.000Z',
        turns: 160,
        costUsd: 22,
        exitReason: 'max-turns',
      },
    ],
    costUsd: 22,
    budget: { capUsd: 50, warnThreshold: 0.8, topUps: [] },
  };

  beforeEach(() => {
    mockGetMissionById.mockResolvedValue(RESUMABLE_MISSION);
  });

  it('defaults to turns-only continuation under unused original authority and never adds $25', async () => {
    const r = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });

    expect(r).toEqual({
      ok: true,
      missionId: 'm-1',
      additionalTurns: 40,
      additionalBudgetUsd: 0,
      authorizedMaxTurns: 40,
      capUsd: 50,
    });

    expect(mockUpdateMission).toHaveBeenCalledTimes(2);
    const [missionId, update] = mockUpdateMission.mock.calls[0];
    expect(missionId).toBe('m-1');
    expect(update).not.toHaveProperty('prompt'); // same goal — MISSION.md is not rewritten
    expect(update).not.toHaveProperty('buildPhase'); // continue from .impulse/STATUS.json, don't pin back to 06-build
    expect(update.status).toBe('pending');
    expect(update.buildState).toBe('provisioning');
    expect(update.qaGate).toEqual({ attempts: 0, findings: [] }); // must re-earn its PASS
    expect(update.budget).toEqual({
      capUsd: 50,
      warnThreshold: 0.8,
      topUps: [],
    });
    expect(update.recovery).toEqual(
      expect.objectContaining({
        authorizedMaxTurns: 40,
        terminal: expect.objectContaining({ reason: 'turns-exhausted' }),
        attempts: [
          expect.objectContaining({
            additionalTurns: 40,
            additionalBudgetUsd: 0,
            maxNewExposureUsd: 0,
            volumeName: 'radarist_build_m-1',
            status: 'dispatching',
          }),
        ],
      })
    );

    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const [event] = mockInngestSend.mock.calls[0];
    expect(event).toEqual({
      name: 'app/build-mission.run.requested',
      data: { missionId: 'm-1', userId: 'user-1', recoveryOperationId: expect.stringMatching(/^recovery-/) },
    });
    expect(event.data).not.toHaveProperty('instructions'); // no instructions → supervisor won't rewrite MISSION.md
  });

  // ARUN-005 parity: a resumed system-dispatched build is not foreign-owned.
  it('allows resuming a system-owned build', async () => {
    mockGetMissionById.mockResolvedValue({ ...RESUMABLE_MISSION, userId: 'system-discovery' });
    const r = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });
    expect(r).toMatchObject({ ok: true });
  });

  it.each([
    ['not-found', null],
    ['forbidden', { ...RESUMABLE_MISSION, userId: 'someone-else' }],
    ['not-build', { ...RESUMABLE_MISSION, kind: 'research' }],
    ['not-limitless', { ...RESUMABLE_MISSION, buildMode: 'standard' }],
    ['running', { ...RESUMABLE_MISSION, status: 'running' }],
    ['not-failed', { ...RESUMABLE_MISSION, status: 'completed' }],
    ['published', { ...RESUMABLE_MISSION, buildPhase: 'published' }],
    ['no-sandbox', { ...RESUMABLE_MISSION, sandbox: undefined }],
    ['sandbox-reclaimed', { ...RESUMABLE_MISSION, sandbox: { volumeName: 'vol-1', state: 'destroyed' } }],
  ] as Array<[string, Record<string, unknown> | null]>)(
    'returns %s without any write or dispatch',
    async (code, mission) => {
      mockGetMissionById.mockResolvedValue(mission);
      const r = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1', additionalTurns: 40 });
      expect(r).toMatchObject({ ok: false, code });
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    }
  );

  describe('budget authority', () => {
    const original = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
    afterEach(() => {
      if (original === undefined) delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
      else process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = original;
    });

    it('refuses to resume a mission that already sits at the cumulative ceiling', async () => {
      mockGetMissionById.mockResolvedValue({
        ...RESUMABLE_MISSION,
        costUsd: 50,
      });

      const r = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });

      expect(r).toEqual({
        ok: false,
        code: 'budget-exhausted',
        error: expect.stringContaining('50'),
      });
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockUpdateMission).not.toHaveBeenCalled();
    });

    it('requires explicit confirmation before any USD top-up', async () => {
      const r = await resumeBuildMission({
        missionId: 'm-1',
        userId: 'user-1',
        additionalTurns: 40,
        additionalBudgetUsd: 25,
      });
      expect(r).toMatchObject({ ok: false, code: 'confirmation-required' });
      expect(mockUpdateMission).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('records exactly the confirmed top-up while keeping turns separate', async () => {
      const r = await resumeBuildMission({
        missionId: 'm-1',
        userId: 'user-1',
        additionalTurns: 20,
        additionalBudgetUsd: 25,
        confirmedBy: 'user-1',
        confirmationFingerprint: 'a'.repeat(64),
      });
      expect(r).toMatchObject({
        ok: true,
        additionalTurns: 20,
        additionalBudgetUsd: 25,
        authorizedMaxTurns: 20,
        capUsd: 75,
      });
      const [, update] = mockUpdateMission.mock.calls[0];
      expect(update.budget.topUps).toEqual([
        expect.objectContaining({ amountUsd: 25, grantedBy: 'user-1' }),
      ]);
      expect(update.recovery.attempts[0]).toEqual(
        expect.objectContaining({ additionalTurns: 20, additionalBudgetUsd: 25, maxNewExposureUsd: 25 })
      );
    });
  });

  it('rolls authority back and records a retryable failure when dispatch is rejected', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('Inngest unavailable'));
    const r = await resumeBuildMission({
      missionId: 'm-1',
      userId: 'user-1',
      additionalTurns: 20,
      additionalBudgetUsd: 10,
      confirmedBy: 'user-1',
      confirmationFingerprint: 'b'.repeat(64),
    });
    expect(r).toMatchObject({ ok: false, code: 'dispatch-failed' });
    expect(mockUpdateMission).toHaveBeenCalledTimes(2);
    const rollback = mockUpdateMission.mock.calls[1][1];
    expect(rollback).toEqual(
      expect.objectContaining({ status: 'failed', buildState: 'paused', budget: RESUMABLE_MISSION.budget })
    );
    expect(rollback.recovery.attempts[0]).toEqual(
      expect.objectContaining({ status: 'dispatch-failed', failure: 'Inngest unavailable' })
    );
  });

  it('refuses recovery before any write when the retained Docker volume is gone', async () => {
    mockSandboxExec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no such volume' });

    const result = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });

    expect(result).toMatchObject({ ok: false, code: 'sandbox-reclaimed' });
    expect(mockSandboxExec).toHaveBeenCalledWith('docker', [
      'volume',
      'inspect',
      'radarist_build_m-1',
    ]);
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('serializes concurrent recovery requests so only one can dispatch', async () => {
    let releaseProbe: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined;
    mockSandboxExec.mockImplementationOnce(
      () =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          releaseProbe = resolve;
        })
    );

    const first = resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });
    await Promise.resolve();
    await Promise.resolve();
    const second = await resumeBuildMission({ missionId: 'm-1', userId: 'user-1' });

    expect(second).toMatchObject({ ok: false, code: 'operation-in-progress' });
    releaseProbe?.({ code: 0, stdout: '[]', stderr: '' });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
  });
});
