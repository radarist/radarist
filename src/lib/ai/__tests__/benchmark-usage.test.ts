/**
 * @file benchmark-usage.test.ts
 * @description TEST-021 — the chat-model benchmark must produce the SAME figure
 * production would receipt for the same response.
 *
 * The reconciliation cases are the point: a benchmark that merely "uses the rate
 * card" can still disagree with the runtime by mapping counters itself, omitting
 * the occurrence date a dated tier needs, or pricing the requested model id rather
 * than the one the provider served. Each of those is asserted against the real
 * production pricer here, not against a hand-computed constant.
 *
 * @jest-environment node
 */

import { priceGeminiBenchmarkUsage, summarizeBenchmarkRuns } from '../../../../scripts/lib/benchmark-usage';
import { priceReceiptCounters } from '@/lib/operation-receipt-pricing';
import { geminiUsageToReceipt, resolveModelFields } from '@/lib/operation-usage-map';
import type { BenchmarkRun, GeminiUsageMetadata } from '../../../../scripts/lib/benchmark-usage';

const OCCURRED = '2026-07-25T12:00:00.000Z';

function bench(
  model: string,
  usage: GeminiUsageMetadata | undefined,
  opts: { providerModel?: unknown; occurredAt?: string; grounded?: boolean } = {}
) {
  return priceGeminiBenchmarkUsage({
    requestedModel: model,
    // Default to the provider confirming the requested id, which is the ordinary case.
    providerModel: 'providerModel' in opts ? opts.providerModel : model,
    usage,
    occurredAt: opts.occurredAt ?? OCCURRED,
    ...(opts.grounded !== undefined ? { grounded: opts.grounded } : {}),
  });
}

/** The cost a stored receipt would carry for the same response. */
function productionCost(model: string, usage: GeminiUsageMetadata | undefined, providerModel: unknown = model) {
  const { counters, usageCompleteness } = geminiUsageToReceipt(usage);
  return priceReceiptCounters({
    provider: 'gemini',
    ...resolveModelFields(model, providerModel),
    counters,
    usageCompleteness,
    feeState: 'none',
    occurredAt: OCCURRED,
  });
}

describe('priceGeminiBenchmarkUsage (TEST-021)', () => {
  it('prices uncached usage: thoughts added as output, at the <=200k tier', () => {
    const r = bench('gemini-3.5-flash', {
      promptTokenCount: 100_000,
      candidatesTokenCount: 100_000,
      thoughtsTokenCount: 100_000,
    });
    // input 100k * $1.5/M + output (100k+100k) * $9/M = 0.15 + 1.8 = 1.95
    expect(r).toMatchObject({ ok: true, costUsd: expect.closeTo(1.95, 6) });
  });

  it('bills cached prompt tokens at the cache-read rate, not full input (subset, no double count)', () => {
    const r = bench('gemini-3.1-pro-preview', {
      promptTokenCount: 100_000,
      candidatesTokenCount: 0,
      cachedContentTokenCount: 40_000,
    });
    // remainder 60k * $2/M + cached 40k * $0.2/M = 0.12 + 0.008 = 0.128
    if (!r.ok) throw new Error(`unexpected unavailable: ${r.reason}`);
    expect(r.costUsd).toBeCloseTo(0.128, 6);
  });

  it('honors the >200k context tier for a large prompt', () => {
    const r = bench('gemini-3.1-pro-preview', { promptTokenCount: 250_000, candidatesTokenCount: 0 });
    if (!r.ok) throw new Error(`unexpected unavailable: ${r.reason}`);
    expect(r.costUsd).toBeCloseTo(1.0, 6); // 250k * $4/M
  });

  it('fails the receipt when promptTokenCount is missing (no false zero)', () => {
    const r = bench('gemini-3.5-flash', { candidatesTokenCount: 100 });
    expect(r).toEqual({ ok: false, reason: 'missing-usage' });
  });

  it('fails the receipt when candidatesTokenCount is missing', () => {
    const r = bench('gemini-3.5-flash', { promptTokenCount: 100 });
    expect(r).toEqual({ ok: false, reason: 'missing-usage' });
  });

  it('fails the receipt when usageMetadata is entirely absent', () => {
    expect(bench('gemini-3.5-flash', undefined).ok).toBe(false);
  });

  it('allows an explicit zero for a required counter (0 is present, undefined is not)', () => {
    const r = bench('gemini-3.5-flash', { promptTokenCount: 0, candidatesTokenCount: 0 });
    expect(r).toMatchObject({ ok: true, costUsd: 0, amountMicros: 0 });
  });

  it('fails the receipt for an unpriceable model rather than guessing', () => {
    expect(bench('gemini-9-imaginary', { promptTokenCount: 100, candidatesTokenCount: 100 }).ok).toBe(false);
  });

  it('fails closed when reported cache exceeds the prompt (inconsistent counters)', () => {
    const r = bench('gemini-3.1-pro-preview', {
      promptTokenCount: 100,
      candidatesTokenCount: 0,
      cachedContentTokenCount: 101,
    });
    expect(r.ok).toBe(false);
  });
});

describe('benchmark/runtime reconciliation', () => {
  const cases: Array<[string, string, GeminiUsageMetadata]> = [
    ['plain', 'gemini-3.5-flash', { promptTokenCount: 12_345, candidatesTokenCount: 6_789 }],
    [
      'with thoughts and cache',
      'gemini-3.1-pro-preview',
      {
        promptTokenCount: 180_000,
        candidatesTokenCount: 4_000,
        thoughtsTokenCount: 2_500,
        cachedContentTokenCount: 90_000,
      },
    ],
    ['above the tier boundary', 'gemini-2.5-pro', { promptTokenCount: 300_000, candidatesTokenCount: 1_000 }],
  ];

  it.each(cases)('matches the production receipt amount exactly (%s)', (_label, model, usage) => {
    const benchmark = priceGeminiBenchmarkUsage({
      requestedModel: model,
      providerModel: model,
      usage,
      occurredAt: OCCURRED,
    });
    const production = productionCost(model, usage);
    if (!benchmark.ok) throw new Error(`benchmark unavailable: ${benchmark.reason}`);
    if (production.state !== 'estimated') throw new Error(`production unavailable: ${JSON.stringify(production)}`);
    // Integer micro-units, so this is exact equality — not float-tolerant.
    expect(benchmark.amountMicros).toBe(production.amountMicros);
    expect(benchmark.rateCardVersion).toBe(production.rateCardVersion);
    expect(benchmark.resolvedModel).toBe(production.resolvedModel);
  });

  it('prices the SERVED model, not the requested alias, exactly as a receipt does', () => {
    // A preview/alias id that routes to a different concrete model must bill at the
    // served model's rate. Pricing the requested id here was a silent divergence.
    const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 0 };
    const served = priceGeminiBenchmarkUsage({
      requestedModel: 'gemini-3.1-pro-preview',
      providerModel: 'gemini-3.5-flash',
      usage,
      occurredAt: OCCURRED,
    });
    if (!served.ok) throw new Error(`unexpected unavailable: ${served.reason}`);
    expect(served.servedModel).toBe('gemini-3.5-flash');
    // $1.5/M for the served flash model, not $2/M for the requested pro id.
    expect(served.amountMicros).toBe(1_500_000);
    const production = productionCost('gemini-3.1-pro-preview', usage, 'gemini-3.5-flash');
    expect(production).toMatchObject({ amountMicros: 1_500_000 });
  });

  it('refuses to price when the provider reported NO served model (same rule as production)', () => {
    const r = bench(
      'gemini-3.5-flash',
      { promptTokenCount: 100, candidatesTokenCount: 10 },
      { providerModel: undefined }
    );
    expect(r).toEqual({ ok: false, reason: 'provider-unreported' });
  });

  it('applies the occurrence date, so a response before the card existed is unpriceable', () => {
    const r = bench(
      'gemini-3.5-flash',
      { promptTokenCount: 100, candidatesTokenCount: 10 },
      { occurredAt: '2020-01-01T00:00:00.000Z' }
    );
    expect(r).toEqual({ ok: false, reason: 'unknown-pricing' });
  });

  it('reports token-only coverage for a grounded call instead of a silently fee-free total', () => {
    const grounded = bench(
      'gemini-3.5-flash',
      { promptTokenCount: 1_000_000, candidatesTokenCount: 0 },
      { grounded: true }
    );
    if (!grounded.ok) throw new Error(`unexpected unavailable: ${grounded.reason}`);
    expect(grounded.covers).toBe('tokens');
    expect(grounded.amountMicros).toBe(1_500_000);
  });
});

describe('summarizeBenchmarkRuns', () => {
  function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
    return { ms: 100, inTok: 1000, outTok: 200, thoughtsTok: 0, costUsd: 0.01, ...overrides };
  }

  it('averages cost over PRICED responses only — an unpriced row is never a $0', () => {
    const s = summarizeBenchmarkRuns([
      run({ costUsd: 0.02 }),
      run({ costUsd: 0.04 }),
      run({ costUsd: null, costUnavailableReason: 'provider-unreported' }),
    ]);
    // Averaging the unpriced row as zero would report $0.02 — a third cheaper than
    // the model actually is, from data the benchmark never had.
    expect(s.avgCostUsd).toBeCloseTo(0.03, 10);
    expect(s.pricedCount).toBe(2);
    expect(s.unpricedCount).toBe(1);
    expect(s.unpricedReasons).toEqual(['provider-unreported']);
  });

  it('keeps an unpriceable response in the latency and token samples', () => {
    // A pricing gap must not shrink the samples that decide latency and quality.
    const s = summarizeBenchmarkRuns([
      run({ ms: 100, inTok: 1000 }),
      run({ ms: 900, inTok: 3000, costUsd: null, costUnavailableReason: 'unknown-pricing' }),
    ]);
    expect(s.sampleCount).toBe(2);
    expect(s.avgInputTokens).toBe(2000);
    expect(s.p50Ms).toBe(900);
  });

  it('drops a FAILED CALL from every sample, including latency', () => {
    const s = summarizeBenchmarkRuns([run({ ms: 100 }), run({ ms: 9999, error: 'ECONNRESET', costUsd: null })]);
    expect(s.sampleCount).toBe(1);
    expect(s.failedCallCount).toBe(1);
    expect(s.p50Ms).toBe(100);
    expect(s.unpricedCount).toBe(0);
  });

  it('reports NO cost at all when nothing could be priced, rather than $0', () => {
    const s = summarizeBenchmarkRuns([run({ costUsd: null }), run({ costUsd: null })]);
    expect(s.avgCostUsd).toBeNull();
    expect(s.pricedCount).toBe(0);
  });

  it('reports a provable zero-cost response as $0, not as unavailable', () => {
    const s = summarizeBenchmarkRuns([run({ costUsd: 0 })]);
    expect(s.avgCostUsd).toBe(0);
    expect(s.pricedCount).toBe(1);
    expect(s.unpricedCount).toBe(0);
  });

  it('handles an empty set without inventing a figure', () => {
    const s = summarizeBenchmarkRuns([]);
    expect(s).toMatchObject({ sampleCount: 0, pricedCount: 0, avgCostUsd: null, p50Ms: 0 });
  });
});
