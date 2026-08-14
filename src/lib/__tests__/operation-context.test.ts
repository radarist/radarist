/**
 * @file lib/__tests__/operation-context.test.ts
 * @description ARUN-022 — ambient operation-usage sink (AsyncLocalStorage).
 *
 * Pins the propagation contract every provider chokepoint relies on:
 * - capture is a STRICT no-op when no boundary opened a sink (an un-instrumented
 *   path is unchanged);
 * - capture inside a boundary lands in that boundary's sink, across awaits;
 * - nesting swaps the sink for the inner scope only;
 * - a throwing sink never propagates into the provider path.
 *
 * @jest-environment node
 */

import {
  captureProviderUsage,
  getOperationUsageSink,
  runWithOperationUsageSink,
  type CapturedProviderUsage,
  type OperationUsageSink,
} from '../operation-context';

function usage(operation: string): CapturedProviderUsage {
  return {
    provider: 'gemini',
    operation,
    counters: {},
    usageCompleteness: 'unreported',
    occurredAt: '2026-07-22T00:00:00.000Z',
    feeState: 'none',
  };
}

class ArraySink implements OperationUsageSink {
  readonly items: CapturedProviderUsage[] = [];
  collect(u: CapturedProviderUsage): void {
    this.items.push(u);
  }
}

describe('operation-context — ambient usage sink', () => {
  it('capture is a no-op when no boundary is active', () => {
    expect(getOperationUsageSink()).toBeUndefined();
    expect(() => captureProviderUsage(usage('gemini.generate-content'))).not.toThrow();
  });

  it('captures into the active boundary sink, across an await', async () => {
    const sink = new ArraySink();
    await runWithOperationUsageSink(sink, async () => {
      captureProviderUsage(usage('a'));
      await Promise.resolve();
      captureProviderUsage(usage('b'));
    });
    expect(sink.items.map((u) => u.operation)).toEqual(['a', 'b']);
    // Sink is restored (unset) after the scope returns.
    expect(getOperationUsageSink()).toBeUndefined();
  });

  it('a nested scope captures into the inner sink only, then restores the outer', async () => {
    const outer = new ArraySink();
    const inner = new ArraySink();
    await runWithOperationUsageSink(outer, async () => {
      captureProviderUsage(usage('outer-1'));
      await runWithOperationUsageSink(inner, async () => {
        captureProviderUsage(usage('inner-1'));
      });
      captureProviderUsage(usage('outer-2'));
    });
    expect(outer.items.map((u) => u.operation)).toEqual(['outer-1', 'outer-2']);
    expect(inner.items.map((u) => u.operation)).toEqual(['inner-1']);
  });

  it('a throwing sink never breaks the provider path', async () => {
    const throwing: OperationUsageSink = {
      collect() {
        throw new Error('sink is broken');
      },
    };
    await expect(
      runWithOperationUsageSink(throwing, async () => {
        captureProviderUsage(usage('x'));
        return 'provider-result';
      })
    ).resolves.toBe('provider-result');
  });
});
