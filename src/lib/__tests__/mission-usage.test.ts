/**
 * @file lib/__tests__/mission-usage.test.ts
 * @description ARUN-020 — the ONE authoritative usage snapshot for a mission
 * doc. Every surface that renders or aggregates mission spend (runs list rows,
 * run detail, the daily token/cost summaries) must read THIS accessor so a
 * running build can never show zero tokens on one surface and real spend on
 * another. Pure module: no Firebase imports.
 *
 * @jest-environment node
 */

import { missionDurationMs, missionUsageSnapshot } from '../mission-usage';
import type { Mission } from '@/lib/schemas/mission';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'build-1',
    userId: 'u1',
    prompt: 'Prototype: internal knowledge search',
    agent: 'builder',
    kind: 'build',
    status: 'running',
    progress: 50,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-05-09T09:00:00.000Z',
    ...overrides,
  } as Mission;
}

describe('missionUsageSnapshot (ARUN-020)', () => {
  it('reports unpersisted tokens/cost as undefined (display: unavailable), with zeroed aggregation fields', () => {
    const snap = missionUsageSnapshot(mission({ tokenUsage: undefined, costUsd: undefined }));
    expect(snap.tokens).toBeUndefined();
    expect(snap.costUsd).toBeUndefined();
    expect(snap.input).toBe(0);
    expect(snap.output).toBe(0);
    expect(snap.costUnavailable).toBe(true);
  });

  it('sums persisted token usage and passes non-build settled cost through', () => {
    const snap = missionUsageSnapshot(
      mission({ kind: 'research', tokenUsage: { input: 5000, output: 3000 }, costUsd: 4.2 })
    );
    expect(snap.tokens).toBe(8000);
    expect(snap.input).toBe(5000);
    expect(snap.output).toBe(3000);
    expect(snap.costUsd).toBe(4.2);
  });

  it('keeps a genuine persisted zero distinct from unpersisted (0 is a real measurement)', () => {
    const snap = missionUsageSnapshot(mission({ kind: 'research', tokenUsage: { input: 0, output: 0 }, costUsd: 0 }));
    expect(snap.tokens).toBe(0);
    expect(snap.costUsd).toBe(0);
  });

  it('reflects explicit build buckets without classifying from mission lifecycle', () => {
    const snap = missionUsageSnapshot(
      mission({
        status: 'running',
        costUsd: 6.5,
        tokenUsage: undefined,
        buildCostAccounting: {
          settledActualUsd: 0,
          estimatedUsd: 0,
          activeReservedUsd: 6.5,
          unsettledMaximumUsd: 0,
          trackedSpendUsd: 0,
          maximumExposureUsd: 6.5,
          unavailableSessionCount: 0,
          invalidSessionIndexes: [],
          observedAt: '2026-07-19T10:00:00.000Z',
        },
      })
    );
    expect(snap.costUsd).toBe(0);
    expect(snap.settledCostUsd).toBe(0);
    expect(snap.estimatedCostUsd).toBe(0);
    expect(snap.reservedCostUsd).toBe(6.5);
    expect(snap.unsettledMaximumUsd).toBe(0);
    expect(snap.maximumExposureUsd).toBe(6.5);
    expect(snap.costUnavailable).toBe(false);
    expect(snap.tokens).toBeUndefined();
  });

  it('treats a legacy build total as unsettled exposure instead of guessing from status', () => {
    const running = missionUsageSnapshot(mission({ status: 'running', costUsd: 6.5 }));
    const failed = missionUsageSnapshot(mission({ status: 'failed', costUsd: 6.5 }));

    expect(running).toMatchObject({
      costUsd: undefined,
      unsettledMaximumUsd: 6.5,
      maximumExposureUsd: 6.5,
      costUnavailable: true,
    });
    expect(failed).toMatchObject(running);
  });

  it('does not turn malformed explicit accounting into a precise zero-dollar result', () => {
    const snap = missionUsageSnapshot(
      mission({
        costUsd: 99,
        buildCostAccounting: {
          settledActualUsd: Number.NaN,
        } as never,
      })
    );

    expect(snap.costUsd).toBeUndefined();
    expect(snap.maximumExposureUsd).toBeUndefined();
    expect(snap.costUnavailable).toBe(true);
  });

  describe('ARUN-027: provable incompleteness vs simple absence', () => {
    it('flags persisted-but-corrupt accounting as provably incomplete', () => {
      const snap = missionUsageSnapshot(
        mission({ costUsd: 99, buildCostAccounting: { settledActualUsd: Number.NaN } as never })
      );

      // The ledger EXISTS and failed validation — real spend it cannot state.
      expect(snap.costUnavailableReason).toBe('accounting-incomplete');
    });

    it('flags accounting that reports unstatable sessions as provably incomplete', () => {
      const snap = missionUsageSnapshot(
        mission({
          buildCostAccounting: {
            settledActualUsd: 1,
            estimatedUsd: 0,
            activeReservedUsd: 0,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 1,
            maximumExposureUsd: 1,
            unavailableSessionCount: 1,
            invalidSessionIndexes: [],
            observedAt: '2026-07-27T00:00:00.000Z',
          } as never,
        })
      );

      expect(snap.costUnavailable).toBe(true);
      expect(snap.costUnavailableReason).toBe('accounting-incomplete');
    });

    it('does NOT claim lost receipts when there is simply no accounting basis', () => {
      // A legacy build doc, and a failed build that never charged anything.
      // "We have no record" is not "our record is provably missing spend";
      // reporting the latter on every legacy row would cry wolf.
      const legacy = missionUsageSnapshot(mission({ status: 'running', costUsd: 6.5 }));
      const nothingRecorded = missionUsageSnapshot(mission({ status: 'failed', costUsd: undefined }));

      expect(legacy.costUnavailable).toBe(true);
      expect(legacy.costUnavailableReason).toBeUndefined();
      expect(nothingRecorded.costUnavailableReason).toBeUndefined();
    });

    it('reports no reason when the accounting is whole', () => {
      const snap = missionUsageSnapshot(
        mission({
          buildCostAccounting: {
            settledActualUsd: 2,
            estimatedUsd: 1,
            activeReservedUsd: 0,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 3,
            maximumExposureUsd: 3,
            unavailableSessionCount: 0,
            invalidSessionIndexes: [],
            observedAt: '2026-07-27T00:00:00.000Z',
          } as never,
        })
      );

      expect(snap.costUnavailable).toBe(false);
      expect(snap.costUnavailableReason).toBeUndefined();
    });
  });
});

describe('missionDurationMs — the one duration rule for mission docs', () => {
  it('completed mission: completedAt - createdAt', () => {
    expect(
      missionDurationMs(
        mission({ status: 'completed', createdAt: '2026-05-09T09:00:00.000Z', completedAt: '2026-05-09T09:05:00.000Z' })
      )
    ).toBe(5 * 60 * 1000);
  });

  it('in-flight mission: elapsed age from createdAt', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-09T09:00:30.000Z'));
    expect(missionDurationMs(mission({ status: 'running', createdAt: '2026-05-09T09:00:00.000Z' }))).toBe(30_000);
    jest.useRealTimers();
  });

  it('terminal mission without completedAt: unknowable — undefined, never a fabricated 0', () => {
    expect(missionDurationMs(mission({ status: 'failed', completedAt: undefined }))).toBeUndefined();
  });
});
