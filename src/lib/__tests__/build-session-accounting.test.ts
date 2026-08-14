/**
 * @jest-environment node
 */

jest.mock('@/lib/firebase-admin', () => {
  let exists = true;
  let data: Record<string, unknown> = {};
  const ref = { id: 'mission-1' };
  const update = jest.fn((_ref: unknown, patch: Record<string, unknown>) => {
    data = { ...data, ...patch };
  });
  const transaction = {
    get: jest.fn(async () => ({ exists, data: () => data })),
    update,
  };
  const controls = {
    set(next: Record<string, unknown>) {
      exists = true;
      data = structuredClone(next);
      update.mockClear();
      transaction.get.mockClear();
    },
    missing() {
      exists = false;
    },
    read() {
      return structuredClone(data);
    },
    update,
  };
  return {
    db: {
      collection: jest.fn(() => ({ doc: jest.fn(() => ref) })),
      runTransaction: jest.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
    },
    __missionAccountingControls: controls,
  };
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

import {
  finalizeBuildSessionAccounting,
  reconcileBuildMissionCostAccounting,
  reserveBuildSessionBudget,
  type BuildSessionCompletion,
  type BuildSessionReservation,
} from '@/lib/missions';

const controls = (
  jest.requireMock('@/lib/firebase-admin') as {
    __missionAccountingControls: {
      set(value: Record<string, unknown>): void;
      missing(): void;
      read(): Record<string, unknown>;
      update: jest.Mock;
    };
  }
).__missionAccountingControls;

const reservation: BuildSessionReservation = {
  index: 4,
  role: 'builder',
  objective: 'build the accepted scope',
  model: 'claude-opus-4-8',
  startedAt: '2026-07-15T10:00:00.000Z',
  reservedCostUsd: 40,
};

function completion(overrides: Partial<BuildSessionCompletion> = {}): BuildSessionCompletion {
  return {
    index: 4,
    role: 'builder',
    objective: '',
    model: 'claude-opus-4-8',
    startedAt: reservation.startedAt,
    endedAt: '2026-07-15T11:00:00.000Z',
    turns: 42,
    costUsd: 7.5,
    exitReason: 'completed',
    failingChecksHash: null,
    ...overrides,
  };
}

describe('build session reserve/reconcile accounting', () => {
  beforeEach(() => {
    controls.set({ costUsd: 3, tokenUsage: { input: 10, output: 20 }, sessions: [] });
  });

  it('charges the full envelope before launch and makes an identical reservation replay a no-op', async () => {
    const first = await reserveBuildSessionBudget('mission-1', reservation, 50);
    const replay = await reserveBuildSessionBudget('mission-1', reservation, 50);

    expect(first).toEqual({
      status: 'reserved',
      applied: true,
      chargedCostUsd: 40,
      reservedCostUsd: 40,
      missionCostUsd: 43,
    });
    expect(replay).toEqual({ ...first, applied: false });
    expect(controls.read()).toMatchObject({
      costUsd: 43,
      sessions: [reservation],
      buildCostAccounting: {
        settledActualUsd: 0,
        estimatedUsd: 0,
        activeReservedUsd: 40,
        unsettledMaximumUsd: 3,
        trackedSpendUsd: 0,
        maximumExposureUsd: 43,
        unavailableSessionCount: 1,
        invalidSessionIndexes: [],
        observedAt: expect.stringMatching(/^2026-|^20\d\d-/),
      },
    });
    expect(controls.update).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a replay tries to reuse the index for a different launch', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);

    await expect(
      reserveBuildSessionBudget('mission-1', { ...reservation, model: 'different-model' }, 50)
    ).rejects.toThrow(/already reserved with different data/);
    expect(controls.read().costUsd).toBe(43);
  });

  it('fails closed when an existing reservation is missing from the cumulative ledger', async () => {
    controls.set({ costUsd: 10, tokenUsage: { input: 0, output: 0 }, sessions: [reservation] });

    await expect(reserveBuildSessionBudget('mission-1', reservation, 50)).rejects.toThrow(
      /missing from the cumulative cost ledger/
    );
  });

  it('denies launch when an existing reservation replay observes cost above the cap', async () => {
    controls.set({ costUsd: 55, tokenUsage: { input: 0, output: 0 }, sessions: [reservation] });

    await expect(reserveBuildSessionBudget('mission-1', reservation, 50)).resolves.toMatchObject({
      status: 'budget-exceeded',
      applied: false,
      missionCostUsd: 55,
    });
    expect(controls.update).not.toHaveBeenCalled();
  });

  it('atomically reconciles the reserve to reported cost and never charges a finalize replay twice', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);
    const completed = completion();

    const first = await finalizeBuildSessionAccounting('mission-1', completed, { input: 100, output: 50 });
    const replay = await finalizeBuildSessionAccounting('mission-1', completed, { input: 100, output: 50 });

    expect(first).toEqual({
      applied: true,
      chargedCostUsd: 7.5,
      reservedCostUsd: 40,
      missionCostUsd: 10.5,
      endedAt: completed.endedAt,
    });
    expect(replay).toEqual({ ...first, applied: false });
    expect(controls.read()).toMatchObject({
      costUsd: 10.5,
      tokenUsage: { input: 110, output: 70 },
      sessions: [reservation, { ...completed, inputTokens: 100, outputTokens: 50 }],
      buildCostAccounting: {
        settledActualUsd: 7.5,
        estimatedUsd: 0,
        activeReservedUsd: 0,
        unsettledMaximumUsd: 3,
        trackedSpendUsd: 7.5,
        maximumExposureUsd: 10.5,
        unavailableSessionCount: 1,
        invalidSessionIndexes: [],
      },
    });
    expect(controls.update).toHaveBeenCalledTimes(2);
  });

  it('keeps the full pessimistic charge when no valid result cost exists', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);
    const estimated = completion({
      turns: 0,
      costUsd: 40,
      costEstimated: true,
      exitReason: 'timeout',
    });

    const result = await finalizeBuildSessionAccounting('mission-1', estimated, { input: 0, output: 0 });

    expect(result.chargedCostUsd).toBe(40);
    expect(result.missionCostUsd).toBe(43);
    expect(controls.read()).toMatchObject({
      costUsd: 43,
      sessions: [reservation, { ...estimated, inputTokens: 0, outputTokens: 0 }],
    });
  });

  it('refuses a reservation transaction that would cross the current mission cap', async () => {
    controls.set({ costUsd: 15, tokenUsage: { input: 0, output: 0 }, sessions: [] });

    const result = await reserveBuildSessionBudget('mission-1', reservation, 50);

    expect(result).toEqual({
      status: 'budget-exceeded',
      applied: false,
      chargedCostUsd: 0,
      reservedCostUsd: 40,
      missionCostUsd: 15,
    });
    expect(controls.read()).toMatchObject({ costUsd: 15, sessions: [] });
    expect(controls.update).not.toHaveBeenCalled();
  });

  it('uses maximum exposure as authority even when tracked spend is zero', async () => {
    const priorReservation = { ...reservation, index: 1, reservedCostUsd: 45 };
    controls.set({
      costUsd: 45,
      tokenUsage: { input: 0, output: 0 },
      sessions: [priorReservation],
      buildCostAccounting: {
        settledActualUsd: 0,
        estimatedUsd: 0,
        activeReservedUsd: 45,
        unsettledMaximumUsd: 0,
        trackedSpendUsd: 0,
        maximumExposureUsd: 45,
        unavailableSessionCount: 0,
        invalidSessionIndexes: [],
        observedAt: '2026-07-15T09:00:00.000Z',
      },
    });

    await expect(reserveBuildSessionBudget('mission-1', reservation, 50)).resolves.toEqual({
      status: 'budget-exceeded',
      applied: false,
      chargedCostUsd: 0,
      reservedCostUsd: 40,
      missionCostUsd: 45,
    });
    expect(controls.update).not.toHaveBeenCalled();
  });

  it('never lets an estimated completion release part of its pessimistic reserve', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);

    await expect(
      finalizeBuildSessionAccounting(
        'mission-1',
        completion({ costUsd: 1, costEstimated: true, exitReason: 'timeout' }),
        { input: 0, output: 0 }
      )
    ).rejects.toThrow(/must retain its full budget reservation/);
    expect(controls.read()).toMatchObject({ costUsd: 43, sessions: [reservation] });
  });

  it('replays a committed completion with its original timestamp and exact token usage', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);
    const firstCompletion = completion({ endedAt: '2026-07-15T11:00:00.000Z' });
    const retryCompletion = completion({ endedAt: '2026-07-15T11:05:00.000Z' });

    const first = await finalizeBuildSessionAccounting('mission-1', firstCompletion, { input: 100, output: 50 });
    const replay = await finalizeBuildSessionAccounting('mission-1', retryCompletion, { input: 100, output: 50 });

    expect(replay).toEqual({ ...first, applied: false, endedAt: firstCompletion.endedAt });
    expect(controls.update).toHaveBeenCalledTimes(2);
    await expect(
      finalizeBuildSessionAccounting('mission-1', retryCompletion, { input: 101, output: 50 })
    ).rejects.toThrow(/already finalized with different data/);
  });

  it.each([
    ['role', { role: 'reviewer' }],
    ['model', { model: 'different-model' }],
    ['start time', { startedAt: '2026-07-15T10:01:00.000Z' }],
  ] as const)('rejects a completion whose %s does not match the reservation', async (_label, mismatch) => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);

    await expect(
      finalizeBuildSessionAccounting('mission-1', completion(mismatch), { input: 1, output: 1 })
    ).rejects.toThrow(/does not match its durable reservation/);
  });

  it('rejects duplicate and malformed durable reservations', async () => {
    controls.set({
      costUsd: 83,
      tokenUsage: { input: 0, output: 0 },
      sessions: [reservation, { ...reservation }],
    });
    await expect(
      finalizeBuildSessionAccounting('mission-1', completion(), { input: 1, output: 1 })
    ).rejects.toThrow(/no durable budget reservation/);

    controls.set({
      costUsd: 3,
      tokenUsage: { input: 0, output: 0 },
      sessions: [{ ...reservation, reservedCostUsd: Number.NaN }],
    });
    await expect(
      finalizeBuildSessionAccounting('mission-1', completion(), { input: 1, output: 1 })
    ).rejects.toThrow(/invalid durable budget reservation/);
  });

  it('requires a durable reservation and rejects invalid accounting inputs', async () => {
    await expect(finalizeBuildSessionAccounting('mission-1', completion(), { input: 1, output: 1 })).rejects.toThrow(
      /no durable budget reservation/
    );
    await expect(reserveBuildSessionBudget('mission-1', { ...reservation, reservedCostUsd: 0 }, 50)).rejects.toThrow(
      /positive finite/
    );
    await expect(reserveBuildSessionBudget('mission-1', reservation, 0)).rejects.toThrow(
      /positive finite mission cap/
    );
    await expect(
      finalizeBuildSessionAccounting('mission-1', completion({ costUsd: Number.NaN }), { input: 1, output: 1 })
    ).rejects.toThrow(/non-negative finite/);
  });

  it('moves reservation-only terminal work to unsettled exposure without lifecycle inference', async () => {
    await reserveBuildSessionBudget('mission-1', reservation, 50);
    controls.update.mockClear();

    const first = await reconcileBuildMissionCostAccounting('mission-1', {
      state: 'terminal',
      observedAt: '2026-07-15T12:00:00.000Z',
    });
    const replay = await reconcileBuildMissionCostAccounting('mission-1', {
      state: 'terminal',
      observedAt: '2026-07-15T12:05:00.000Z',
    });

    expect(first).toMatchObject({
      applied: true,
      accounting: {
        settledActualUsd: 0,
        activeReservedUsd: 0,
        unsettledMaximumUsd: 43,
        trackedSpendUsd: 0,
        maximumExposureUsd: 43,
        unavailableSessionCount: 2,
        observedAt: '2026-07-15T12:00:00.000Z',
      },
    });
    expect(replay).toEqual({ applied: false, accounting: first.accounting });
    expect(controls.update).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed persisted accounting instead of converting it to a zero-dollar mission', async () => {
    controls.set({
      costUsd: 43,
      tokenUsage: { input: 0, output: 0 },
      sessions: [reservation],
      buildCostAccounting: {
        settledActualUsd: Number.NaN,
        estimatedUsd: 0,
        activeReservedUsd: 40,
        unsettledMaximumUsd: 3,
        trackedSpendUsd: 0,
        maximumExposureUsd: 43,
        unavailableSessionCount: 1,
        invalidSessionIndexes: [],
        observedAt: '2026-07-15T10:00:00.000Z',
      },
    });

    await expect(reserveBuildSessionBudget('mission-1', reservation, 50)).rejects.toThrow(
      /invalid persisted build cost accounting/
    );
    expect(controls.update).not.toHaveBeenCalled();
  });
});
