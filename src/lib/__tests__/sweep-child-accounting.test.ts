/**
 * @jest-environment node
 *
 * OBS-004 — sweep child accounting.
 *
 * The synthetic fixture represents a sweep that reports success even though its
 * paid children fail, produce no proposals, and accrue cost and elapsed time.
 * Each child outcome is now an explicit field rather than being inferred from
 * dispatch success.
 */

import {
  aggregateSweepChildren,
  dispatchOnlySweepChildAggregate,
  resolveSweepStatusWithChildren,
  type SweepChildSettlement,
} from '../sweep-child-accounting';

describe('aggregateSweepChildren — failed paid children', () => {
  const reportedSweep: SweepChildSettlement[] = [
    { missionId: 'mission-fixture-child-a', outcome: 'failed', costUsd: 5.5, durationMs: 15_000, outputs: { proposals: 0 } },
    { missionId: 'mission-fixture-child-b', outcome: 'failed', costUsd: 5.75, durationMs: 16_000, outputs: { proposals: 0 } },
  ];

  it('reports the exact terminal partition instead of a dispatch count', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: reportedSweep });
    expect(aggregate.byOutcome).toEqual({ failed: 2 });
    expect(aggregate.failedChildren).toBe(2);
    expect(aggregate.outcome).toBe('failed');
    expect(aggregate.childrenStatus).toBe('settled');
  });

  it('surfaces child cost that dispatch-only accounting omits', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: reportedSweep });
    expect(aggregate.costUsd).toBeCloseTo(11.25, 2);
    expect(aggregate.costUnavailableChildren).toBe(0);
  });

  it('counts the zero durable proposals as an observation, not an absence', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: reportedSweep });
    expect(aggregate.outputs).toEqual({ proposals: 0, reports: 0, entities: 0 });
  });

  it('reports the children elapsed time rather than one handler slice', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: reportedSweep });
    expect(aggregate.childDurationMs).toBe(31_000);
  });

  it('drives the sweep row to failure — the whole point of the row', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: reportedSweep });
    // Pre-fix the status came ONLY from the insight lane, so a healthy REFLECT
    // reported success while every paid child had failed.
    expect(resolveSweepStatusWithChildren({ insightsStatus: 'ok', children: aggregate })).toBe('failure');
  });
});

describe('aggregateSweepChildren — completeness', () => {
  it('reports none when nothing was dispatched', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 0, settlements: [] });
    expect(aggregate.childrenStatus).toBe('none');
    expect(aggregate.outcome).toBeUndefined();
  });

  it('reports pending while dispatched children have not reported', () => {
    const aggregate = aggregateSweepChildren({ dispatched: 2, settlements: [] });
    expect(aggregate.childrenStatus).toBe('pending');
    // An aggregate over nothing has NO outcome. Defaulting to success here is
    // exactly how the reported sweep came to claim one.
    expect(aggregate.outcome).toBeUndefined();
  });

  it('reports partial while some children are outstanding', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 3,
      settlements: [{ missionId: 'm-1', outcome: 'success' }],
    });
    expect(aggregate.childrenStatus).toBe('partial');
    // An all-success but incomplete batch must not claim success yet.
    expect(aggregate.outcome).toBe('partial');
  });

  it('reports settled once every dispatched child has reported', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 2,
      settlements: [
        { missionId: 'm-1', outcome: 'success' },
        { missionId: 'm-2', outcome: 'success' },
      ],
    });
    expect(aggregate.childrenStatus).toBe('settled');
    expect(aggregate.outcome).toBe('success');
  });

  it('keeps a settlement for an unrecorded dispatch rather than discarding a real outcome', () => {
    // The dispatch list can lag (a step retried, a deploy replayed a memoized
    // pre-OBS-004 result). The child's work still happened.
    const aggregate = aggregateSweepChildren({
      dispatched: 0,
      settlements: [{ missionId: 'm-orphan', outcome: 'failed', costUsd: 3 }],
    });
    expect(aggregate.settled).toBe(1);
    expect(aggregate.failedChildren).toBe(1);
    expect(aggregate.costUsd).toBe(3);
    expect(aggregate.childrenStatus).toBe('settled');
  });
});

describe('aggregateSweepChildren — cost honesty (AI-029)', () => {
  it('excludes an unprovable cost from the total and counts it instead', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 2,
      settlements: [
        { missionId: 'm-1', outcome: 'success', costUsd: 2.5 },
        { missionId: 'm-2', outcome: 'success', costUnavailableReason: 'unknown-pricing' },
      ],
    });
    // 2.5, not 2.5 + 0: an unpriced child must not make the total look exact.
    expect(aggregate.costUsd).toBe(2.5);
    expect(aggregate.costUnavailableChildren).toBe(1);
  });

  it('treats a non-finite cost as unprovable rather than poisoning the sum', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 2,
      settlements: [
        { missionId: 'm-1', outcome: 'success', costUsd: 1 },
        { missionId: 'm-2', outcome: 'success', costUsd: Number.NaN },
      ],
    });
    expect(aggregate.costUsd).toBe(1);
    expect(aggregate.costUnavailableChildren).toBe(1);
  });

  it('rounds away float noise so a displayed total is not 11.245799999999999', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 3,
      settlements: [
        { missionId: 'm-1', outcome: 'success', costUsd: 0.1 },
        { missionId: 'm-2', outcome: 'success', costUsd: 0.2 },
        { missionId: 'm-3', outcome: 'success', costUsd: 0.3 },
      ],
    });
    expect(aggregate.costUsd).toBe(0.6);
  });

  it('ignores negative or malformed token and duration values', () => {
    const aggregate = aggregateSweepChildren({
      dispatched: 1,
      settlements: [
        {
          missionId: 'm-1',
          outcome: 'success',
          tokensIn: -5,
          tokensOut: 10,
          durationMs: Number.POSITIVE_INFINITY,
        },
      ],
    });
    expect(aggregate.tokensIn).toBe(0);
    expect(aggregate.tokensOut).toBe(10);
    expect(aggregate.childDurationMs).toBe(0);
  });
});

describe('aggregateSweepChildren — idempotency of the derived counters', () => {
  it('is a pure function of the settlement SET, so a re-report cannot double-count', () => {
    const settlements: SweepChildSettlement[] = [
      { missionId: 'm-1', outcome: 'failed', costUsd: 5 },
      { missionId: 'm-2', outcome: 'success', costUsd: 2 },
    ];
    const first = aggregateSweepChildren({ dispatched: 2, settlements });
    // Settlements are stored keyed by missionId, so a replayed report overwrites
    // its own key. Aggregating the same set again is byte-identical.
    const second = aggregateSweepChildren({ dispatched: 2, settlements: [...settlements] });
    expect(second).toEqual(first);
    expect(second.costUsd).toBe(7);
  });
});

describe('dispatchOnlySweepChildAggregate', () => {
  it('reports the known dispatch count with nothing settled', () => {
    const aggregate = dispatchOnlySweepChildAggregate(3);
    expect(aggregate.dispatched).toBe(3);
    expect(aggregate.settled).toBe(0);
    expect(aggregate.childrenStatus).toBe('pending');
    expect(aggregate.costUsd).toBe(0);
    expect(aggregate.outcome).toBeUndefined();
  });
});

describe('resolveSweepStatusWithChildren', () => {
  const noChildren = { failedChildren: 0, settled: 0, childrenStatus: 'none' as const };

  it('preserves the insight lane semantics when there are no children', () => {
    expect(resolveSweepStatusWithChildren({ insightsStatus: 'failed', children: noChildren })).toBe('failure');
    expect(resolveSweepStatusWithChildren({ insightsStatus: 'not-run', children: noChildren })).toBe('skipped');
    expect(resolveSweepStatusWithChildren({ insightsStatus: 'quiet', children: noChildren })).toBe('success');
    expect(resolveSweepStatusWithChildren({ insightsStatus: 'ok', children: noChildren })).toBe('success');
  });

  it('lets a single failed child override a healthy insight lane', () => {
    expect(
      resolveSweepStatusWithChildren({
        insightsStatus: 'ok',
        children: { failedChildren: 1, settled: 2, childrenStatus: 'settled' },
      })
    ).toBe('failure');
  });

  it('does not call a still-pending batch a failure — nothing has gone wrong yet', () => {
    expect(
      resolveSweepStatusWithChildren({
        insightsStatus: 'ok',
        children: { failedChildren: 0, settled: 0, childrenStatus: 'pending' },
      })
    ).toBe('success');
  });

  it('does not report skipped when children actually ran', () => {
    // 'not-run' describes the insight lane. If children settled, the cycle did
    // real (paid) work and calling it skipped would understate it.
    expect(
      resolveSweepStatusWithChildren({
        insightsStatus: 'not-run',
        children: { failedChildren: 0, settled: 2, childrenStatus: 'settled' },
      })
    ).toBe('success');
  });
});
