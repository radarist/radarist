/**
 * @jest-environment node
 *
 * OBS-006 — durable elapsed-time measurement for checkpointed runs.
 *
 * The reproduced mismatch: a deep-research JobRun reported `duration: 9` while
 * its own `startedAt`→`completedAt` span was ~561 seconds, because
 * `const startTime = Date.now()` sat in the handler body and Inngest
 * re-initialises the body on every one of a run's per-step HTTP requests.
 *
 * The load-bearing property proven here is `simulateReplay`: a fake step that
 * memoizes results and a clock that advances between requests reproduce the old
 * ~0ms report against a long real span, and show the memoized derivation
 * surviving it.
 */

import {
  captureDurableInstantMs,
  deriveDurableTimingMs,
  parseDurableInstantMs,
  type DurableInstantStep,
} from '../durable-duration';

/**
 * A step whose results persist across "requests", the way Inngest's do. Each
 * request gets a FRESH handler body but the SAME memoized step store.
 */
function createMemoizingStep(): DurableInstantStep & { memoized: Map<string, number> } {
  const memoized = new Map<string, number>();
  return {
    memoized,
    async run(id: string, handler: () => number): Promise<number> {
      if (memoized.has(id)) return memoized.get(id)!;
      const value = handler();
      memoized.set(id, value);
      return value;
    },
  };
}

describe('captureDurableInstantMs', () => {
  it('captures the instant once and replays the same value on every later request', async () => {
    const step = createMemoizingStep();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1_000);
      const first = await captureDurableInstantMs(step, 'capture-start-time');

      // A later request of the SAME run — a different wall clock, same run.
      clock.mockReturnValue(561_000);
      const replayed = await captureDurableInstantMs(step, 'capture-start-time');

      expect(first).toBe(1_000);
      expect(replayed).toBe(1_000);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps distinct step ids independent', async () => {
    const step = createMemoizingStep();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(10);
      await captureDurableInstantMs(step, 'capture-start-time');
      clock.mockReturnValue(99);
      await captureDurableInstantMs(step, 'capture-end-time');
      expect(step.memoized.get('capture-start-time')).toBe(10);
      expect(step.memoized.get('capture-end-time')).toBe(99);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the replay bug this closes', () => {
  /**
   * Two handlers over one run: the pre-fix shape (body-local `Date.now()`) and
   * the fixed shape (both endpoints memoized). The run is executed as THREE
   * requests — a poll checkpoint in the middle — with the clock advancing to a
   * real 561-second span.
   */
  async function simulateReplay(): Promise<{ preFixMs: number; fixedMs: number }> {
    const step = createMemoizingStep();
    const clock = jest.spyOn(Date, 'now');
    try {
      // Request 1: accepted, start captured.
      clock.mockReturnValue(0);
      let preFixStart = Date.now();
      let fixedStart = await captureDurableInstantMs(step, 'capture-start-time');

      // Request 2: resumed mid-poll ~9 minutes later. Fresh body → the local
      // start is re-initialised; the memoized one is not.
      clock.mockReturnValue(560_991);
      preFixStart = Date.now();
      fixedStart = await captureDurableInstantMs(step, 'capture-start-time');

      // Request 3 (terminal), 9ms later — a synthetic replay boundary.
      clock.mockReturnValue(561_000);
      const preFixMs = Date.now() - preFixStart;
      const fixedEnd = await captureDurableInstantMs(step, 'capture-end-time');
      const fixedMs = deriveDurableTimingMs({ startedAtMs: fixedStart, completedAtMs: fixedEnd }).executionMs!;
      return { preFixMs, fixedMs };
    } finally {
      clock.mockRestore();
    }
  }

  it('reproduces the 9ms under-report and shows the memoized derivation surviving it', async () => {
    const { preFixMs, fixedMs } = await simulateReplay();
    // Pre-fix: the final invocation slice only.
    expect(preFixMs).toBe(9);
    // Fixed: the complete synthetic startedAt→completedAt span.
    expect(fixedMs).toBe(561_000);
  });
});

describe('parseDurableInstantMs', () => {
  it('accepts a positive finite epoch', () => {
    expect(parseDurableInstantMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('rejects everything that cannot be an instant', () => {
    for (const bogus of [undefined, null, 0, -1, NaN, Infinity, '1700000000000', {}]) {
      expect(parseDurableInstantMs(bogus)).toBeUndefined();
    }
  });
});

describe('deriveDurableTimingMs', () => {
  it('separates queue wait from execution when an accepted instant is known', () => {
    expect(deriveDurableTimingMs({ acceptedAtMs: 1_000, startedAtMs: 4_000, completedAtMs: 565_000 })).toEqual({
      totalMs: 564_000,
      queueWaitMs: 3_000,
      executionMs: 561_000,
      basis: 'accepted-to-terminal',
    });
  });

  it('reports honestly that queue wait is unknown when no accepted instant exists', () => {
    const timing = deriveDurableTimingMs({ startedAtMs: 4_000, completedAtMs: 565_000 });
    expect(timing).toEqual({ totalMs: 561_000, executionMs: 561_000, basis: 'started-to-terminal' });
    // Absent, NOT zero. A zero queue wait is a measurement; this is the lack of
    // one, and conflating them is the class of bug this row is about.
    expect(timing).not.toHaveProperty('queueWaitMs');
  });

  it('marks a run with no terminal instant incomplete rather than reporting 0ms', () => {
    const timing = deriveDurableTimingMs({ acceptedAtMs: 1_000, startedAtMs: 4_000 });
    expect(timing.basis).toBe('incomplete');
    expect(timing).not.toHaveProperty('totalMs');
    expect(timing).not.toHaveProperty('executionMs');
    expect(timing.queueWaitMs).toBe(3_000);
  });

  it('keeps the provider phase separate from total elapsed', () => {
    const timing = deriveDurableTimingMs({
      acceptedAtMs: 1_000,
      startedAtMs: 1_000,
      completedAtMs: 561_000,
      providerMs: 540_000,
    });
    expect(timing.providerMs).toBe(540_000);
    expect(timing.totalMs).toBe(560_000);
    // Provider time is a component of, never a substitute for, elapsed time.
    expect(timing.providerMs!).toBeLessThan(timing.totalMs!);
  });

  it('clamps a backwards clock to zero instead of reporting a negative span', () => {
    // Clocks can skew across a runtime restart; a negative elapsed time is never
    // a useful report.
    expect(deriveDurableTimingMs({ startedAtMs: 10_000, completedAtMs: 9_000 }).executionMs).toBe(0);
  });

  it('ignores a non-finite provider span rather than emitting NaN', () => {
    expect(deriveDurableTimingMs({ startedAtMs: 1, completedAtMs: 2, providerMs: NaN })).not.toHaveProperty(
      'providerMs'
    );
  });

  it('names every unit with an Ms suffix', () => {
    const timing = deriveDurableTimingMs({
      acceptedAtMs: 1,
      startedAtMs: 2,
      completedAtMs: 3,
      providerMs: 1,
    });
    for (const key of Object.keys(timing)) {
      if (key === 'basis') continue;
      expect(key.endsWith('Ms')).toBe(true);
    }
  });
});
