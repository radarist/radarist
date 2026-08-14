/**
 * @file lib/research/__tests__/deep-research-progress.test.ts
 * @description PRODUCT-003 — only provider-reported facts may describe
 * provider progress. These tests pin both halves of that: the facts we DO
 * surface come verbatim from the interaction, and the things the provider never
 * reports — a stage name, a completion percentage, an ETA — are never invented,
 * including for a run that reports nothing at all for its whole lifetime.
 */

import {
  DEEP_RESEARCH_PROGRESS_HEARTBEAT,
  DEEP_RESEARCH_STALL_OBSERVATIONS,
  MAX_PROVIDER_STEP_TYPE_LENGTH,
  MAX_RETAINED_PROVIDER_STEPS,
  describeDeepResearchProgress,
  nextDeepResearchProgress,
  readDeepResearchObservation,
  shouldPersistDeepResearchProgress,
  type DeepResearchProgress,
} from '@/lib/research/deep-research-progress';

const OBSERVED_AT = '2026-07-30T10:00:00.000Z';

const context = (pollIteration: number, terminal?: DeepResearchProgress['terminal']) => ({
  interactionId: 'interaction-1',
  pollIteration,
  maxPollIterations: 60,
  pollIntervalSeconds: 15,
  ...(terminal ? { terminal } : {}),
});

/** Fold a sequence of provider step counts through the reducer. */
function foldCounts(counts: Array<number | undefined>): DeepResearchProgress {
  let progress: DeepResearchProgress | undefined;
  counts.forEach((count, index) => {
    progress = nextDeepResearchProgress(
      progress,
      {
        providerStatus: 'in_progress',
        ...(count === undefined ? {} : { steps: Array.from({ length: count }, (_, i) => ({ index: i })) }),
        observedAt: OBSERVED_AT,
      },
      context(index)
    );
  });
  return progress!;
}

describe('readDeepResearchObservation — verbatim provider facts only', () => {
  it('reads the raw provider status and the provider’s own step types', () => {
    const observation = readDeepResearchObservation(
      { status: 'in_progress', steps: [{ type: 'model_output' }, { name: 'web_search' }] },
      OBSERVED_AT
    );
    expect(observation).toEqual({
      providerStatus: 'in_progress',
      steps: [
        { index: 0, type: 'model_output' },
        { index: 1, type: 'web_search' },
      ],
      observedAt: OBSERVED_AT,
    });
  });

  it('leaves a step untyped rather than inventing a stage name for it', () => {
    const observation = readDeepResearchObservation(
      { status: 'in_progress', steps: [{}, { type: '   ' }] },
      OBSERVED_AT
    );
    expect(observation.steps).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it('bounds an untrusted provider step type', () => {
    const observation = readDeepResearchObservation(
      { status: 'in_progress', steps: [{ type: 'x'.repeat(500) }] },
      OBSERVED_AT
    );
    expect(observation.steps?.[0].type).toHaveLength(MAX_PROVIDER_STEP_TYPE_LENGTH);
  });

  it('distinguishes "no step list reported" from "an empty step list"', () => {
    expect(readDeepResearchObservation({ status: 'in_progress' }, OBSERVED_AT).steps).toBeUndefined();
    expect(readDeepResearchObservation({ status: 'in_progress', steps: [] }, OBSERVED_AT).steps).toEqual([]);
  });

  it('degrades an unexpected shape to "unknown" rather than throwing or guessing', () => {
    expect(readDeepResearchObservation(null, OBSERVED_AT)).toEqual({
      providerStatus: 'unknown',
      observedAt: OBSERVED_AT,
    });
    expect(readDeepResearchObservation({ status: 42, steps: 'nope' }, OBSERVED_AT)).toEqual({
      providerStatus: 'unknown',
      observedAt: OBSERVED_AT,
    });
  });
});

describe('nextDeepResearchProgress — stall detection from provider steps only', () => {
  it('resets the counter whenever the provider reports a new step', () => {
    const progress = foldCounts([1, 2, 2, 3]);
    expect(progress.stepCount).toBe(3);
    expect(progress.observationsWithoutNewStep).toBe(0);
    expect(progress.stalled).toBe(false);
    expect(progress.observations).toBe(4);
  });

  it('declares a stall only after the threshold of unchanged observations', () => {
    const justUnder = foldCounts([1, ...Array(DEEP_RESEARCH_STALL_OBSERVATIONS - 1).fill(1)]);
    expect(justUnder.observationsWithoutNewStep).toBe(DEEP_RESEARCH_STALL_OBSERVATIONS - 1);
    expect(justUnder.stalled).toBe(false);

    const atThreshold = foldCounts([1, ...Array(DEEP_RESEARCH_STALL_OBSERVATIONS).fill(1)]);
    expect(atThreshold.stalled).toBe(true);
  });

  it('never calls a run stalled when the provider reports no step list at all', () => {
    const progress = foldCounts(Array(DEEP_RESEARCH_STALL_OBSERVATIONS + 5).fill(undefined));
    expect(progress.progressUnavailable).toBe(true);
    expect(progress.stalled).toBe(false);
    expect(progress.stepCount).toBeUndefined();
  });

  it('treats the provider starting to report steps midway as progress, not another stalled check', () => {
    const progress = foldCounts([undefined, undefined, 3]);
    expect(progress.stepCount).toBe(3);
    expect(progress.observationsWithoutNewStep).toBe(0);
  });

  it('retains only the most recent provider steps', () => {
    const many = Array.from({ length: MAX_RETAINED_PROVIDER_STEPS + 5 }, (_, i) => ({ index: i, type: `s${i}` }));
    const progress = nextDeepResearchProgress(
      undefined,
      { providerStatus: 'in_progress', steps: many, observedAt: OBSERVED_AT },
      context(0)
    );
    expect(progress.steps).toHaveLength(MAX_RETAINED_PROVIDER_STEPS);
    expect(progress.stepCount).toBe(MAX_RETAINED_PROVIDER_STEPS + 5);
    expect(progress.steps[progress.steps.length - 1].type).toBe(`s${MAX_RETAINED_PROVIDER_STEPS + 4}`);
  });

  it('reports the poll budget as OUR measurement, with no percentage or ETA anywhere', () => {
    const progress = foldCounts([1, 2]);
    expect(progress.poll).toEqual({ iteration: 2, max: 60, intervalSeconds: 15 });
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toMatch(/percent|eta|remaining|estimate/i);
  });

  it('keeps a non-settled run resumable and a settled one not', () => {
    expect(foldCounts([1]).resumable).toBe(true);
    const completed = nextDeepResearchProgress(
      undefined,
      { providerStatus: 'completed', steps: [{ index: 0 }], observedAt: OBSERVED_AT },
      context(3, { state: 'completed' })
    );
    expect(completed.resumable).toBe(false);
    const failed = nextDeepResearchProgress(
      undefined,
      { providerStatus: 'failed', steps: [{ index: 0 }], observedAt: OBSERVED_AT },
      context(3, { state: 'failed', reason: 'provider said so' })
    );
    expect(failed.resumable).toBe(false);
    const timedOut = nextDeepResearchProgress(
      undefined,
      { providerStatus: 'in_progress', steps: [{ index: 0 }], observedAt: OBSERVED_AT },
      context(59, { state: 'timed-out' })
    );
    expect(timedOut.resumable).toBe(true);
  });

  it('re-derives an identical snapshot from the same fold — safe across an Inngest replay', () => {
    expect(foldCounts([1, 1, 2, 2, 2])).toEqual(foldCounts([1, 1, 2, 2, 2]));
  });
});

describe('shouldPersistDeepResearchProgress — bounded writes', () => {
  const base = foldCounts([1]);

  it('always persists the first snapshot and any terminal one', () => {
    expect(shouldPersistDeepResearchProgress(undefined, base)).toBe(true);
    expect(shouldPersistDeepResearchProgress(base, { ...base, terminal: { state: 'completed' } })).toBe(true);
  });

  it('persists a provider status change, a step change, and a stall transition', () => {
    expect(shouldPersistDeepResearchProgress(base, { ...base, providerStatus: 'completed' })).toBe(true);
    expect(shouldPersistDeepResearchProgress(base, { ...base, stepCount: 2 })).toBe(true);
    expect(shouldPersistDeepResearchProgress(base, { ...base, stalled: true })).toBe(true);
    expect(shouldPersistDeepResearchProgress(base, { ...base, progressUnavailable: true })).toBe(true);
  });

  it('skips an unchanged snapshot but still heartbeats so a slow run visibly advances', () => {
    const unchanged = { ...base, observations: DEEP_RESEARCH_PROGRESS_HEARTBEAT + 1 };
    expect(shouldPersistDeepResearchProgress(base, unchanged)).toBe(false);
    const heartbeat = { ...base, observations: DEEP_RESEARCH_PROGRESS_HEARTBEAT };
    expect(shouldPersistDeepResearchProgress(base, heartbeat)).toBe(true);
  });
});

describe('describeDeepResearchProgress — says only what is known', () => {
  it('states the provider step count for a healthy run', () => {
    const described = describeDeepResearchProgress(foldCounts([1, 2, 3]));
    expect(described.tone).toBe('running');
    expect(described.headline).toBe('3 provider steps reported');
    expect(described.detail).toContain('in_progress');
  });

  it('says progress detail is unavailable instead of inventing a stage', () => {
    const described = describeDeepResearchProgress(foldCounts([undefined, undefined]));
    expect(described.tone).toBe('unavailable');
    expect(described.headline).toBe('Progress detail unavailable');
    expect(described.detail).toContain('no plan or step detail');
  });

  it('names the stall without claiming to know why', () => {
    const described = describeDeepResearchProgress(foldCounts([1, ...Array(DEEP_RESEARCH_STALL_OBSERVATIONS).fill(1)]));
    expect(described.tone).toBe('stalled');
    expect(described.headline).toBe('No new provider step recently');
  });

  it('distinguishes our exhausted poll budget from a provider failure, and offers the resume handle', () => {
    const timedOut = nextDeepResearchProgress(
      foldCounts([2]),
      { providerStatus: 'in_progress', steps: [{ index: 0 }, { index: 1 }], observedAt: OBSERVED_AT },
      context(59, { state: 'timed-out' })
    );
    const described = describeDeepResearchProgress(timedOut);
    expect(described.headline).toContain('outlasted our poll budget');
    expect(described.detail).toContain('may still be running');
    expect(described.detail).toContain('interaction-1');
  });

  it('carries the provider’s own terminal reason through a failure', () => {
    const failed = nextDeepResearchProgress(
      undefined,
      { providerStatus: 'cancelled', steps: [], observedAt: OBSERVED_AT },
      context(4, { state: 'failed', reason: 'Deep research ended with provider status "cancelled"' })
    );
    const described = describeDeepResearchProgress(failed);
    expect(described.tone).toBe('error');
    expect(described.detail).toContain('cancelled');
  });

  it('never emits a percentage or an ETA in any branch', () => {
    const snapshots = [
      foldCounts([1, 2]),
      foldCounts([undefined]),
      foldCounts([1, ...Array(DEEP_RESEARCH_STALL_OBSERVATIONS).fill(1)]),
      nextDeepResearchProgress(
        undefined,
        { providerStatus: 'completed', steps: [], observedAt: OBSERVED_AT },
        context(3, { state: 'completed' })
      ),
      nextDeepResearchProgress(
        undefined,
        { providerStatus: 'failed', observedAt: OBSERVED_AT },
        context(3, { state: 'failed' })
      ),
      nextDeepResearchProgress(
        undefined,
        { providerStatus: 'in_progress', steps: [], observedAt: OBSERVED_AT },
        context(59, { state: 'timed-out' })
      ),
    ];
    for (const snapshot of snapshots) {
      const described = describeDeepResearchProgress(snapshot);
      expect(`${described.headline} ${described.detail}`).not.toMatch(/%|\bETA\b|minutes left|about \d+ min/i);
    }
  });
});
