/**
 * @file lib/__tests__/operation-receipt-instrument.test.ts
 * @description ARUN-022 — provider-usage → receipt instrumentation bridge.
 *
 * Pins the shared instrumentation seam:
 * - `resolveModelFields` produces the schema's exact provenance triple for a
 *   provider-reported / requested-fallback / model-less response;
 * - `geminiUsageToReceipt` maps usage with DISTINCT tiers and honest completeness
 *   (an absent `usageMetadata` is `unreported`, never a token estimate);
 * - `recordCapturedUsage` builds a valid receipt input, defaults cost to the
 *   honest `unavailable / accounting-incomplete` fact (no rate card invented),
 *   and is best-effort (a record failure returns null, never throws into the
 *   provider path);
 * - `flushCapturedUsage` gives each capture a STABLE, distinct identity so
 *   replaying the same captures never double-records.
 *
 * @jest-environment node
 */

import { resolveModelFields, geminiUsageToReceipt } from '../operation-usage-map';

const mockRecordOperationReceiptWithOutcome = jest.fn();
jest.mock('../operation-receipt-repository', () => {
  // Defined INSIDE the factory (class declarations are not hoisted like jest.mock),
  // so the instrument's `instanceof OperationReceiptConflictError` works under mock.
  class OperationReceiptConflictError extends Error {
    constructor() {
      super('conflict');
      this.name = 'OperationReceiptConflictError';
    }
  }
  return {
    recordOperationReceiptWithOutcome: (...args: unknown[]) => mockRecordOperationReceiptWithOutcome(...args),
    OperationReceiptConflictError,
  };
});
const { OperationReceiptConflictError: MockOperationReceiptConflictError } = jest.requireMock(
  '../operation-receipt-repository'
) as { OperationReceiptConflictError: new () => Error };
const mockUpsertMarker = jest.fn();
jest.mock('../operation-accounting-marker-repository', () => ({
  upsertParentAccountingMarker: (...args: unknown[]) => mockUpsertMarker(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import {
  recordCapturedUsage,
  flushCapturedUsage,
  withCapturedUsage,
  BufferingUsageSink,
} from '../operation-receipt-instrument';
import { captureProviderUsage } from '../operation-context';
import type { OperationReceiptCorrelation } from '../schemas/operation-receipt';
import type { CapturedProviderUsage } from '../operation-context';

const correlation: OperationReceiptCorrelation = {
  parentType: 'verification',
  owner: 'user:system',
  correlationId: 'inngest-run-1',
  inngestRunId: 'run-1',
  verificationResultId: 'vr-1',
  entityId: 'company-1',
  entityType: 'companies',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Echo the built input back as a written receipt so callers can inspect it.
  mockRecordOperationReceiptWithOutcome.mockImplementation(async (input: Record<string, unknown>) => ({
    receipt: { ...input, id: 'receipt-id', recordedAt: '2026-07-22T00:00:00.000Z' },
    outcome: 'written',
  }));
  mockUpsertMarker.mockResolvedValue(undefined);
});

describe('resolveModelFields — provenance triple', () => {
  it('provider-reported when the provider named a served model (models/ prefix stripped)', () => {
    expect(resolveModelFields('gemini-3.5-flash', 'models/gemini-3-pro')).toEqual({
      model: 'gemini-3-pro',
      requestedModel: 'gemini-3.5-flash',
      modelProvenance: 'provider-reported',
    });
  });

  it('requested-fallback (model === requestedModel) when the provider named nothing', () => {
    expect(resolveModelFields('gemini-3.5-flash', undefined)).toEqual({
      model: 'gemini-3.5-flash',
      requestedModel: 'gemini-3.5-flash',
      modelProvenance: 'requested-fallback',
    });
  });

  it('unreported with no model for a model-less keyless call', () => {
    expect(resolveModelFields(undefined, undefined)).toEqual({ modelProvenance: 'unreported' });
  });
});

describe('geminiUsageToReceipt — counters + completeness', () => {
  it('stores the RAW provider prompt counter verbatim, with cached as a distinct subset', () => {
    const { counters, usageCompleteness } = geminiUsageToReceipt({
      promptTokenCount: 1000, // RAW total prompt tokens (INCLUDES the cached 800)
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 800,
    });
    expect(counters).toEqual({
      promptTokens: 1000, // raw, verbatim — the kernel subtracts the cached subset when pricing
      outputTokens: 200,
      thinkingTokens: 50,
      cacheReadTokens: 800,
    });
    expect(usageCompleteness).toBe('complete');
  });

  it('records an impossible cached>prompt fact verbatim, and is PARTIAL (missing candidates)', () => {
    const result = geminiUsageToReceipt({ promptTokenCount: 500, cachedContentTokenCount: 900 });
    // Verbatim — cached 900 > total 500 is preserved, not silently clamped to 0.
    expect(result.counters).toEqual({ promptTokens: 500, cacheReadTokens: 900 });
    // A missing required counter (candidates) → partial, never complete.
    expect(result.usageCompleteness).toBe('partial');
  });

  it('an absent usageMetadata is unreported with ZERO counters (no estimate)', () => {
    expect(geminiUsageToReceipt(undefined)).toEqual({ counters: {}, usageCompleteness: 'unreported' });
  });

  it('a PRESENT-but-empty usageMetadata is partial with empty counters (never complete $0)', () => {
    expect(geminiUsageToReceipt({})).toEqual({ counters: {}, usageCompleteness: 'partial' });
  });

  it('a query-only observation (no token accounting) is PARTIAL, not complete', () => {
    expect(geminiUsageToReceipt(undefined, { groundingQueryCount: 3 })).toEqual({
      counters: { queryCount: 3 },
      usageCompleteness: 'partial',
    });
  });

  it('records explicit-zero required counters (distinguishable from absent) as complete', () => {
    expect(geminiUsageToReceipt({ promptTokenCount: 0, candidatesTokenCount: 0 })).toEqual({
      counters: { promptTokens: 0, outputTokens: 0 },
      usageCompleteness: 'complete',
    });
  });

  it.each([1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'a malformed required counter (%p) fails closed to partial and is not recorded',
    (bad) => {
      const result = geminiUsageToReceipt({ promptTokenCount: bad as number, candidatesTokenCount: 20 });
      expect(result.usageCompleteness).toBe('partial');
      expect(result.counters.promptTokens).toBeUndefined();
      expect(result.counters.outputTokens).toBe(20);
    }
  );

  it('a malformed OPTIONAL counter also downgrades a complete response to partial', () => {
    const result = geminiUsageToReceipt({ promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: -5 });
    expect(result.usageCompleteness).toBe('partial');
    expect(result.counters).toEqual({ promptTokens: 10, outputTokens: 20 });
  });

  it('folds a grounding query count in alongside valid token tiers (complete)', () => {
    const result = geminiUsageToReceipt({ promptTokenCount: 10, candidatesTokenCount: 20 }, { groundingQueryCount: 2 });
    expect(result.counters).toEqual({ promptTokens: 10, outputTokens: 20, queryCount: 2 });
    expect(result.usageCompleteness).toBe('complete');
  });
});

describe('recordCapturedUsage', () => {
  const usage: CapturedProviderUsage = {
    provider: 'gemini',
    operation: 'gemini.grounded-generate',
    requestedModel: 'gemini-3.5-flash',
    providerModel: 'models/gemini-3.5-flash',
    counters: { promptTokens: 100, outputTokens: 50, queryCount: 1 },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T09:00:00.000Z',
    feeState: 'applicable-but-unknown',
  };

  it('builds a RAW-facts receipt input (correlation, provenance, occurrence, scope) with NO cost — the repository derives it', async () => {
    const { outcome, receipt } = await recordCapturedUsage(correlation, usage, { invocationId: 'inv-0' }, 'standalone');
    expect(outcome).toBe('written');
    expect(receipt?.id).toBe('receipt-id');

    expect(mockRecordOperationReceiptWithOutcome).toHaveBeenCalledTimes(1);
    const input = mockRecordOperationReceiptWithOutcome.mock.calls[0][0];
    expect(input).toMatchObject({
      correlation,
      operation: 'gemini.grounded-generate',
      invocationId: 'inv-0',
      attempt: 0,
      responseOrdinal: 0,
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      requestedModel: 'gemini-3.5-flash',
      modelProvenance: 'provider-reported',
      counters: { promptTokens: 100, outputTokens: 50, queryCount: 1 },
      usageCompleteness: 'complete',
      occurredAt: '2026-07-22T09:00:00.000Z',
      accountingScope: 'standalone',
      feeState: 'applicable-but-unknown',
    });
    // The seam NEVER supplies a cost — the repository mints the canonical estimate
    // from these raw facts, so a forged/actual cost is unrepresentable here.
    expect(input).not.toHaveProperty('cost');
  });

  it('the signature carries no cost parameter (4 args) so a caller cannot inject a forged estimate', () => {
    // A provider ACTUAL settlement is a separate, append-only, owner-scoped fact.
    expect(recordCapturedUsage).toHaveLength(4);
  });

  it('classifies a CONFLICT distinctly (best-effort, never throws)', async () => {
    mockRecordOperationReceiptWithOutcome.mockRejectedValueOnce(new MockOperationReceiptConflictError());
    const res = await recordCapturedUsage(correlation, usage, { invocationId: 'inv-c' }, 'standalone');
    expect(res).toEqual({ outcome: 'conflicted', receipt: null });
  });

  it('classifies a generic failure as `failed` (best-effort, never throws)', async () => {
    mockRecordOperationReceiptWithOutcome.mockRejectedValueOnce(new Error('transport down'));
    const res = await recordCapturedUsage(correlation, usage, { invocationId: 'inv-f' }, 'standalone');
    expect(res).toEqual({ outcome: 'failed', receipt: null });
  });

  it('surfaces an idempotent `replayed` outcome from the repository', async () => {
    mockRecordOperationReceiptWithOutcome.mockResolvedValueOnce({ receipt: { id: 'r' }, outcome: 'replayed' });
    const res = await recordCapturedUsage(correlation, usage, { invocationId: 'inv-r' }, 'standalone');
    expect(res.outcome).toBe('replayed');
  });

  it('omits externalFees when the capture carried none', async () => {
    await recordCapturedUsage(correlation, usage, { invocationId: 'inv-2' }, 'standalone');
    const input = mockRecordOperationReceiptWithOutcome.mock.calls[0][0];
    expect(input).not.toHaveProperty('externalFees');
  });
});

describe('flushCapturedUsage — structured result + durable marker', () => {
  const cap = (operation: string, extra: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage => ({
    provider: 'gemini',
    operation,
    counters: {},
    usageCompleteness: 'unreported',
    occurredAt: '2026-07-22T09:00:00.000Z',
    feeState: 'none',
    ...extra,
  });

  it('assigns each capture a distinct invocationId and returns a complete FlushResult', async () => {
    const captured: CapturedProviderUsage[] = [
      cap('gemini.grounded-generate', { counters: { queryCount: 1 }, usageCompleteness: 'complete' }),
      cap('gemini.grounded-generate', { counters: { queryCount: 1 }, usageCompleteness: 'complete' }),
    ];

    const result = await flushCapturedUsage(correlation, captured, 'vr-1', 'standalone');

    expect(mockRecordOperationReceiptWithOutcome).toHaveBeenCalledTimes(2);
    const invocationIds = mockRecordOperationReceiptWithOutcome.mock.calls.map((c) => c[0].invocationId);
    expect(invocationIds).toEqual(['vr-1.0', 'vr-1.1']);
    expect(mockRecordOperationReceiptWithOutcome.mock.calls.every((c) => c[0].accountingScope === 'standalone')).toBe(
      true
    );
    expect(result).toMatchObject({
      expected: 2,
      written: 2,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      complete: true,
      markerPersisted: true,
    });
    expect(result.receipts).toHaveLength(2);
  });

  it('writes a PER-BATCH marker (batchId = invocation prefix) with complete state when nothing is lost', async () => {
    await flushCapturedUsage(correlation, [cap('gemini.grounded-generate')], 'vr-1', 'standalone');
    expect(mockUpsertMarker).toHaveBeenCalledTimes(1);
    expect(mockUpsertMarker.mock.calls[0][0]).toMatchObject({
      owner: 'user:system',
      parentType: 'verification',
      correlationId: 'inngest-run-1',
      batchId: 'vr-1',
      expected: 1,
      written: 1,
      conflicted: 0,
      failed: 0,
      occurredAt: '2026-07-22T09:00:00.000Z',
    });
  });

  it('reports incomplete (and a marker showing the loss) when a capture conflicts', async () => {
    mockRecordOperationReceiptWithOutcome
      .mockResolvedValueOnce({ receipt: { id: 'r0' }, outcome: 'written' })
      .mockRejectedValueOnce(new MockOperationReceiptConflictError());
    const result = await flushCapturedUsage(correlation, [cap('gemini.a'), cap('gemini.b')], 'vr-loss', 'standalone');
    expect(result).toMatchObject({ expected: 2, written: 1, conflicted: 1, failed: 0, complete: false });
    expect(mockUpsertMarker.mock.calls[0][0]).toMatchObject({
      expected: 2,
      written: 1,
      conflicted: 1,
      batchId: 'vr-loss',
    });
  });

  it('a malformed capture timestamp does NOT block recording the loss (occurredAt omitted)', async () => {
    // Every capture carries a malformed occurredAt; the marker must still be written
    // (loss counts are the terminal fact) with occurredAt ABSENT.
    mockRecordOperationReceiptWithOutcome.mockRejectedValue(new Error('bad timestamp rejected by schema'));
    const result = await flushCapturedUsage(
      correlation,
      [cap('gemini.a', { occurredAt: 'not-a-date' }), cap('gemini.b', { occurredAt: 'also-bad' })],
      'vr-badtime',
      'standalone'
    );
    expect(result).toMatchObject({ expected: 2, failed: 2, complete: false, markerPersisted: true });
    const markerArg = mockUpsertMarker.mock.calls[0][0];
    expect(markerArg).toMatchObject({ expected: 2, failed: 2, batchId: 'vr-badtime' });
    expect(markerArg).not.toHaveProperty('occurredAt');
  });

  it('picks the max VALID timestamp when some captures are malformed', async () => {
    await flushCapturedUsage(
      correlation,
      [cap('gemini.a', { occurredAt: 'garbage' }), cap('gemini.b', { occurredAt: '2026-07-22T10:00:00.000Z' })],
      'vr-mixed',
      'standalone'
    );
    expect(mockUpsertMarker.mock.calls[0][0].occurredAt).toBe('2026-07-22T10:00:00.000Z');
  });

  it('exposes markerPersisted=false when the marker write itself FAILS (loss record may be lost)', async () => {
    mockUpsertMarker.mockRejectedValueOnce(new Error('firestore down'));
    const result = await flushCapturedUsage(
      correlation,
      [cap('gemini.grounded-generate')],
      'vr-markerfail',
      'standalone'
    );
    // The flush still succeeds best-effort, but the caller is told the marker was lost.
    expect(result.markerPersisted).toBe(false);
  });

  it('re-flushing the same captures under the same prefix targets the SAME identities (idempotent)', async () => {
    const captured: CapturedProviderUsage[] = [cap('gemini.grounded-generate')];

    await flushCapturedUsage(correlation, captured, 'vr-1', 'standalone');
    await flushCapturedUsage(correlation, captured, 'vr-1', 'standalone');

    const invocationIds = mockRecordOperationReceiptWithOutcome.mock.calls.map((c) => c[0].invocationId);
    expect(invocationIds).toEqual(['vr-1.0', 'vr-1.0']);
  });

  it('does NOT write a marker for an empty flush (no provider calls to account); markerPersisted stays true', async () => {
    const result = await flushCapturedUsage(correlation, [], 'vr-empty', 'standalone');
    expect(result).toMatchObject({ expected: 0, written: 0, complete: true, markerPersisted: true });
    expect(mockUpsertMarker).not.toHaveBeenCalled();
  });

  it('accepts a per-capture scope RESOLVER so one batch can mix included/additional', async () => {
    const captured: CapturedProviderUsage[] = [cap('gemini.chat'), cap('gemini.generate-infographic')];
    await flushCapturedUsage(correlation, captured, 'turn-1', (u) =>
      u.operation === 'gemini.chat' ? 'included-in-parent' : 'additional-to-parent'
    );
    const scopes = mockRecordOperationReceiptWithOutcome.mock.calls.map((c) => c[0].accountingScope);
    expect(scopes).toEqual(['included-in-parent', 'additional-to-parent']);
  });

  it('BufferingUsageSink collects in capture order for the flush', () => {
    const sink = new BufferingUsageSink();
    sink.collect(cap('a'));
    sink.collect(cap('b'));
    expect(sink.captured.map((u) => u.operation)).toEqual(['a', 'b']);
  });
});

describe('withCapturedUsage — capture-now / correlate-later scope', () => {
  it('returns the fn result and everything captured during it', async () => {
    const { result, captured } = await withCapturedUsage(async () => {
      captureProviderUsage({
        provider: 'gemini',
        operation: 'x',
        counters: { queryCount: 1 },
        usageCompleteness: 'complete',
        occurredAt: '2026-07-22T09:00:00.000Z',
        feeState: 'none',
      });
      captureProviderUsage({
        provider: 'gemini',
        operation: 'y',
        counters: {},
        usageCompleteness: 'unreported',
        occurredAt: '2026-07-22T09:00:00.000Z',
        feeState: 'none',
      });
      return 'verdict';
    });
    expect(result).toBe('verdict');
    expect(captured.map((u) => u.operation)).toEqual(['x', 'y']);
  });

  it("propagates the fn's own error unchanged (never masks a real failure as success)", async () => {
    await expect(
      withCapturedUsage(async () => {
        throw new Error('real verification failure');
      })
    ).rejects.toThrow('real verification failure');
  });
});
