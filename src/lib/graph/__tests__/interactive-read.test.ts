/**
 * @file interactive-read.test.ts
 * @description PERF-008 — the interactive-read wall-clock budget. Locks the
 * bound (a hung read fails fast as a typed unavailability), the pass-through
 * (a healthy read returns its value; a real error is not masked), and the
 * no-unhandled-rejection guarantee for a read that rejects after the deadline.
 *
 * @jest-environment node
 */

import { withGraphReadDeadline, INTERACTIVE_GRAPH_READ_BUDGET_MS } from '../interactive-read';
import { GraphUnavailableError } from '../errors';

describe('withGraphReadDeadline (PERF-008)', () => {
  it('returns the read result when it completes within budget', async () => {
    const result = await withGraphReadDeadline('test', async () => 'ok', 1000);
    expect(result).toBe('ok');
  });

  it('rejects with GraphUnavailableError when the read exceeds the budget', async () => {
    const never = () => new Promise<string>(() => {});
    await expect(withGraphReadDeadline('claims', never, 20)).rejects.toBeInstanceOf(GraphUnavailableError);
  });

  it('carries the operation label and a sanitized budget message on timeout', async () => {
    const never = () => new Promise<string>(() => {});
    const err = (await withGraphReadDeadline('briefing', never, 15).catch((e) => e)) as GraphUnavailableError;

    expect(err).toBeInstanceOf(GraphUnavailableError);
    expect(err.operation).toBe('briefing');
    expect(err.backend).toBe('neo4j');
    expect(err.message).toContain('15ms');
    // No bolt URI / credentials leaked into the surfaced message.
    expect(err.message).not.toMatch(/bolt:|neo4j:\/\//);
  });

  it('propagates a read rejection that happens within budget — real errors are not masked', async () => {
    const boom = () => Promise.reject(new Error('cypher classification error'));
    await expect(withGraphReadDeadline('test', boom, 1000)).rejects.toThrow('cypher classification error');
  });

  it('does not raise an unhandledRejection when the read rejects AFTER the deadline fired', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateReject = () =>
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('driver finally gave up')), 40));

      await expect(withGraphReadDeadline('test', lateReject, 10)).rejects.toBeInstanceOf(GraphUnavailableError);

      // Wait past the late rejection so any unhandled rejection would surface.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('defaults to a bounded budget floored well below the driver worst case', () => {
    expect(INTERACTIVE_GRAPH_READ_BUDGET_MS).toBeGreaterThanOrEqual(1000);
    expect(INTERACTIVE_GRAPH_READ_BUDGET_MS).toBeLessThan(30_000);
  });
});
