/**
 * @file op-lifecycle.test.ts
 * @description GRAPH-055 — operation lifecycle tracker for the graph explorer.
 * Every query/expand round trip gets a monotonic identity; beginning a new
 * operation supersedes (aborts) the previous one; stale completions are
 * detectable via isCurrent(); finish() is idempotent and yields a phase-timed
 * receipt for instrumentation.
 */

import { createGraphOpTracker } from '../op-lifecycle';

describe('createGraphOpTracker', () => {
  it('assigns monotonic ids and tracks the current operation snapshot', () => {
    let clock = 1_000;
    const tracker = createGraphOpTracker(() => clock);

    const op1 = tracker.begin('query');
    expect(op1.id).toBe(1);
    expect(op1.kind).toBe('query');
    expect(tracker.current()).toMatchObject({ id: 1, kind: 'query', phase: 'auth-network', startedAt: 1_000 });

    clock = 1_250;
    op1.markPhase('parse');
    expect(tracker.current()).toMatchObject({ id: 1, phase: 'parse' });
  });

  it('supersedes the previous operation when a new one begins', () => {
    const tracker = createGraphOpTracker(() => 0);

    const op1 = tracker.begin('query');
    expect(op1.isCurrent()).toBe(true);
    expect(op1.signal.aborted).toBe(false);

    const op2 = tracker.begin('expand');
    expect(op1.isCurrent()).toBe(false);
    expect(op1.signal.aborted).toBe(true);
    expect(op2.isCurrent()).toBe(true);
    expect(op2.signal.aborted).toBe(false);
    expect(tracker.current()).toMatchObject({ id: 2, kind: 'expand' });
  });

  it('coerces a success finish on a superseded operation into a superseded receipt', () => {
    const tracker = createGraphOpTracker(() => 0);

    const op1 = tracker.begin('query');
    tracker.begin('query');

    const receipt = op1.finish('success');
    expect(receipt).not.toBeNull();
    expect(receipt?.outcome).toBe('superseded');
  });

  it('preserves explicit error and aborted outcomes on superseded operations', () => {
    const tracker = createGraphOpTracker(() => 0);

    const op1 = tracker.begin('query');
    tracker.begin('query');
    expect(op1.finish('error', 'boom')?.outcome).toBe('error');

    const op3 = tracker.begin('expand');
    tracker.begin('query');
    expect(op3.finish('aborted')?.outcome).toBe('aborted');
  });

  it('finish is idempotent and clears current() only for the current op', () => {
    const tracker = createGraphOpTracker(() => 0);

    const op1 = tracker.begin('query');
    const receipt = op1.finish('success', 'ok');
    expect(receipt?.outcome).toBe('success');
    expect(op1.finish('error')).toBeNull();
    expect(tracker.current()).toBeNull();
    expect(op1.isCurrent()).toBe(false);

    // A finished stale op must not clear a newer current op.
    const op2 = tracker.begin('query');
    const op3 = tracker.begin('expand');
    op2.finish('error');
    expect(tracker.current()).toMatchObject({ id: op3.id });
  });

  it('accumulates per-phase durations into the receipt', () => {
    let clock = 0;
    const tracker = createGraphOpTracker(() => clock);

    const op = tracker.begin('query');
    clock = 400; // auth-network took 400ms
    op.markPhase('parse');
    clock = 450; // parse took 50ms
    op.markPhase('commit');
    clock = 475; // commit took 25ms
    const receipt = op.finish('success');

    expect(receipt?.totalMs).toBe(475);
    expect(receipt?.phaseMs).toEqual({ 'auth-network': 400, parse: 50, commit: 25 });
  });

  it('abortCurrent aborts the signal without finishing the op', () => {
    const tracker = createGraphOpTracker(() => 0);

    const op = tracker.begin('query');
    tracker.abortCurrent('unmount');
    expect(op.signal.aborted).toBe(true);
    // The op still owns its terminal path.
    expect(op.isCurrent()).toBe(true);
    expect(op.finish('aborted', 'unmount')?.outcome).toBe('aborted');
    expect(tracker.current()).toBeNull();
  });

  it('abortCurrent is a no-op when nothing is in flight', () => {
    const tracker = createGraphOpTracker(() => 0);
    expect(() => tracker.abortCurrent('unmount')).not.toThrow();
  });
});
