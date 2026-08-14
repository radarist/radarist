/**
 * @file build-mission-budget.test.ts
 * @description AUDIT-016 — the cumulative spend authority.
 *
 * These tests exist because the NAIVE fix for AUDIT-016 is worse than the bug:
 * seeding the supervisor's spend counter makes `remaining === 0` reachable for
 * the first time, and a 0 budget used to mean "no per-session cap" downstream.
 * Every "fail closed" case below is pinning that inversion.
 */

import {
  DEFAULT_BUILD_MISSION_HARD_CAP_USD,
  clampCapUsd,
  deriveBuildCostAccounting,
  getBuildMissionHardCapUsd,
  remainingBudgetUsd,
  resolveIterateBudget,
} from '@/lib/build-mission-budget';

describe('getBuildMissionHardCapUsd', () => {
  const original = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
  afterEach(() => {
    if (original === undefined) delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
    else process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = original;
  });

  it('defaults to the documented cumulative ceiling', () => {
    delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
    expect(getBuildMissionHardCapUsd()).toBe(DEFAULT_BUILD_MISSION_HARD_CAP_USD);
    expect(DEFAULT_BUILD_MISSION_HARD_CAP_USD).toBe(150);
  });

  it('honours a valid operator override', () => {
    process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '40';
    expect(getBuildMissionHardCapUsd()).toBe(40);
  });

  it.each(['0', '-5', 'not-a-number', ''])(
    'falls back to the default rather than uncapping on a bad override (%s)',
    (bad) => {
      process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = bad;
      expect(getBuildMissionHardCapUsd()).toBe(DEFAULT_BUILD_MISSION_HARD_CAP_USD);
    }
  );
});

describe('clampCapUsd', () => {
  it('passes a cap below the ceiling through untouched', () => {
    expect(clampCapUsd(25, 150)).toBe(25);
  });

  it('clamps a cap above the ceiling', () => {
    expect(clampCapUsd(500, 150)).toBe(150);
  });

  it('treats a non-finite or non-positive cap as zero budget, never as "unlimited"', () => {
    expect(clampCapUsd(NaN, 150)).toBe(0);
    expect(clampCapUsd(0, 150)).toBe(0);
    expect(clampCapUsd(-10, 150)).toBe(0);
  });
});

describe('remainingBudgetUsd', () => {
  it('reports the unspent remainder', () => {
    expect(remainingBudgetUsd(25, 10)).toBe(15);
  });

  it('never goes negative when a run overshoots its cap', () => {
    expect(remainingBudgetUsd(25, 30)).toBe(0);
  });

  // The NaN path is the fail-open this whole module exists to close: a NaN
  // remaining would reach `maxBudgetUsd`, and the sandbox would silently drop
  // `--max-budget-usd` and launch an UNCAPPED CLI.
  it('returns 0 (not NaN) when either input is not a number', () => {
    expect(remainingBudgetUsd(NaN, 10)).toBe(0);
    expect(remainingBudgetUsd(25, NaN)).toBe(0);
    expect(remainingBudgetUsd(undefined as unknown as number, 10)).toBe(0);
  });
});

describe('resolveIterateBudget', () => {
  it('grants the requested headroom below the ceiling', () => {
    const b = resolveIterateBudget({ priorCapUsd: 25, priorSpentUsd: 20, additionalUsd: 10, hardCapUsd: 150 });
    expect(b).toEqual({ capUsd: 35, headroomUsd: 15, exhausted: false });
  });

  // The regression AUDIT-016 names: cap grew +10 per iteration forever while the
  // supervisor's spend counter reset to 0, so the gate could never fire.
  it('clamps the new cap to the ceiling instead of growing without bound', () => {
    const b = resolveIterateBudget({ priorCapUsd: 148, priorSpentUsd: 100, additionalUsd: 10, hardCapUsd: 150 });
    expect(b.capUsd).toBe(150);
    expect(b.headroomUsd).toBe(50);
  });

  it('refuses the iteration once cumulative spend has reached the ceiling', () => {
    const b = resolveIterateBudget({ priorCapUsd: 150, priorSpentUsd: 150, additionalUsd: 10, hardCapUsd: 150 });
    expect(b).toEqual({ capUsd: 150, headroomUsd: 0, exhausted: true });
  });

  // A session can overshoot its cap slightly. The top-up must buy NEW room, not
  // silently back-fill spend that already happened.
  it('bases new headroom on actual spend when a prior run overshot its cap', () => {
    const b = resolveIterateBudget({ priorCapUsd: 25, priorSpentUsd: 30, additionalUsd: 10, hardCapUsd: 150 });
    expect(b.capUsd).toBe(40); // max(25, 30) + 10 — not 25 + 10 = 35, which would grant only 5
    expect(b.headroomUsd).toBe(10);
    expect(b.exhausted).toBe(false);
  });

  it('coerces hostile inputs to a refusal rather than unbounded budget', () => {
    const b = resolveIterateBudget({
      priorCapUsd: NaN,
      priorSpentUsd: NaN,
      additionalUsd: Infinity,
      hardCapUsd: 150,
    });
    expect(b.capUsd).toBe(0);
    expect(b.exhausted).toBe(true);
  });
});

describe('deriveBuildCostAccounting', () => {
  const reservation = {
    index: 0,
    reservedCostUsd: 40,
  };

  it('keeps an in-flight envelope reserved instead of reporting it as settled spend', () => {
    expect(deriveBuildCostAccounting([reservation], { terminal: false })).toEqual({
      settledActualUsd: 0,
      estimatedUsd: 0,
      activeReservedUsd: 40,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: 0,
      maximumExposureUsd: 40,
      unavailableSessionCount: 0,
      invalidSessionIndexes: [],
    });
  });

  it.each(['cancel', 'crash', 'stop'])(
    'moves a terminal reservation-only %s into unsettled exposure, never settled spend',
    () => {
      expect(deriveBuildCostAccounting([reservation], { terminal: true })).toEqual({
        settledActualUsd: 0,
        estimatedUsd: 0,
        activeReservedUsd: 0,
        unsettledMaximumUsd: 40,
        trackedSpendUsd: 0,
        maximumExposureUsd: 40,
        unavailableSessionCount: 1,
        invalidSessionIndexes: [],
      });
    }
  );

  it('reconciles a valid provider completion from reserved to settled actual cost', () => {
    expect(
      deriveBuildCostAccounting(
        [
          reservation,
          {
            index: 0,
            endedAt: '2026-07-19T10:10:00.000Z',
            costUsd: 7.5,
          },
        ],
        { terminal: false }
      )
    ).toEqual({
      settledActualUsd: 7.5,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: 7.5,
      maximumExposureUsd: 7.5,
      unavailableSessionCount: 0,
      invalidSessionIndexes: [],
    });
  });

  it('keeps an explicitly estimated completion separate from settled actual cost', () => {
    expect(
      deriveBuildCostAccounting(
        [
          reservation,
          {
            index: 0,
            endedAt: '2026-07-19T10:10:00.000Z',
            costUsd: 40,
            costEstimated: true,
          },
        ],
        { terminal: true }
      )
    ).toEqual({
      settledActualUsd: 0,
      estimatedUsd: 40,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: 40,
      maximumExposureUsd: 40,
      unavailableSessionCount: 0,
      invalidSessionIndexes: [],
    });
  });

  it('classifies a completion without valid provider cost as unavailable unsettled exposure', () => {
    expect(
      deriveBuildCostAccounting(
        [reservation, { index: 0, endedAt: '2026-07-19T10:10:00.000Z' }],
        { terminal: true }
      )
    ).toEqual({
      settledActualUsd: 0,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 40,
      trackedSpendUsd: 0,
      maximumExposureUsd: 40,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [],
    });
  });

  it('collapses identical reservation and completion replays by session index', () => {
    const completed = {
      index: 0,
      endedAt: '2026-07-19T10:10:00.000Z',
      costUsd: 7.5,
    };
    expect(
      deriveBuildCostAccounting([reservation, { ...reservation }, completed, { ...completed }], {
        terminal: true,
      })
    ).toMatchObject({
      settledActualUsd: 7.5,
      maximumExposureUsd: 7.5,
      invalidSessionIndexes: [],
    });
  });

  it('fails closed on conflicting replays without double-counting either claimed actual', () => {
    expect(
      deriveBuildCostAccounting(
        [
          reservation,
          { index: 0, endedAt: '2026-07-19T10:10:00.000Z', costUsd: 7.5 },
          { index: 0, endedAt: '2026-07-19T10:11:00.000Z', costUsd: 8 },
        ],
        { terminal: true }
      )
    ).toEqual({
      settledActualUsd: 0,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 40,
      trackedSpendUsd: 0,
      maximumExposureUsd: 40,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [0],
    });
  });

  it('supports legacy completions without reservations and marks unknowable records unavailable', () => {
    expect(
      deriveBuildCostAccounting(
        [
          { index: 0, endedAt: '2026-07-19T10:10:00.000Z', costUsd: 2.25 },
          { index: 1, endedAt: '2026-07-19T10:11:00.000Z' },
        ],
        { terminal: true }
      )
    ).toEqual({
      settledActualUsd: 2.25,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: 2.25,
      maximumExposureUsd: 2.25,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [],
    });
  });

  it('aggregates mixed sessions without conflating actual, estimated, reserved, and unsettled', () => {
    const accounting = deriveBuildCostAccounting(
      [
        { index: 0, reservedCostUsd: 20 },
        { index: 0, endedAt: '2026-07-19T10:10:00.000Z', costUsd: 4 },
        { index: 1, reservedCostUsd: 30 },
        {
          index: 1,
          endedAt: '2026-07-19T10:20:00.000Z',
          costUsd: 30,
          costEstimated: true,
        },
        { index: 2, reservedCostUsd: 10 },
        { index: 3, reservedCostUsd: 12 },
        { index: 3, endedAt: '2026-07-19T10:30:00.000Z' },
      ],
      { terminal: false }
    );

    expect(accounting).toEqual({
      settledActualUsd: 4,
      estimatedUsd: 30,
      activeReservedUsd: 10,
      unsettledMaximumUsd: 12,
      trackedSpendUsd: 34,
      maximumExposureUsd: 56,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [],
    });
  });

  it('rejects an unsafe index and never lets non-finite amounts poison totals', () => {
    expect(() =>
      deriveBuildCostAccounting([{ index: -1, reservedCostUsd: 10 }], { terminal: false })
    ).toThrow(/invalid session index/);

    expect(
      deriveBuildCostAccounting(
        [
          { index: 0, reservedCostUsd: Number.NaN },
          { index: 0, endedAt: '2026-07-19T10:10:00.000Z', costUsd: Number.POSITIVE_INFINITY },
        ],
        { terminal: true }
      )
    ).toEqual({
      settledActualUsd: 0,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: 0,
      maximumExposureUsd: 0,
      unavailableSessionCount: 1,
      invalidSessionIndexes: [0],
    });
  });
});
