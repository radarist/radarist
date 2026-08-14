/**
 * @file benchmark-usage.ts
 * @description TEST-021 — benchmark/runtime pricing RECONCILIATION.
 *
 * A benchmark exists to make a model decision defensible, which it can only do if
 * the dollar figure it prints is the same figure production would bill for the same
 * response. Calling the shared rate card was not sufficient for that: the benchmark
 * still hand-assembled its own `UsageCounters`, passed no occurrence date (so a
 * time-bounded introductory tier resolved differently than in the runtime), and
 * priced the REQUESTED model id even when the provider had served a different
 * concrete model — three ways for a benchmark number and a production receipt to
 * disagree while both claiming the same card.
 *
 * This helper therefore runs the PRODUCTION chain end to end:
 *   `geminiUsageToReceipt` (the exact mapper the Gemini chokepoint uses)
 *     → `resolveModelFields` (the exact served-model provenance rule)
 *     → `priceReceiptCounters` (the exact cost a stored receipt would carry).
 *
 * The result is the receipt's own integer micro-unit amount, so a benchmark row and
 * the receipt the same response would have produced are comparable exactly rather
 * than to within floating-point luck. Anything production cannot price — an
 * unlisted model, a missing counter, a provider that reported no served model — is
 * an explicit unavailable here too, never a zero.
 *
 * This lives at the script boundary rather than in `src/` because only benchmarks
 * consume it; it imports production code and adds none of its own pricing logic.
 */
import { priceReceiptCounters } from '@/lib/operation-receipt-pricing';
import { geminiUsageToReceipt, resolveModelFields } from '@/lib/operation-usage-map';

/** The subset of Gemini `usageMetadata` the benchmark reads. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  /** Cached prompt tokens (a subset of promptTokenCount). */
  cachedContentTokenCount?: number;
}

export interface BenchmarkUsageInput {
  /** The model the benchmark asked for. */
  requestedModel: string;
  /**
   * `response.modelVersion` — what the provider says it SERVED. Required for a
   * priced row: production refuses to bill a requested id as if it were the served
   * one, and a benchmark that did so would publish a rate nobody can reconcile.
   */
  providerModel: unknown;
  usage: GeminiUsageMetadata | undefined;
  /** ISO-8601 instant the response arrived — the `asOf` a dated tier prices against. */
  occurredAt: string;
  /** True when the call used Google Search grounding (a fee applies whose amount the provider never reports). */
  grounded?: boolean;
}

export type BenchmarkReceipt =
  | {
      ok: true;
      costUsd: number;
      /** The receipt's exact integer micro-units — the reconcilable figure. */
      amountMicros: number;
      /** What the amount covers: `tokens` alone, or tokens plus provider fees. */
      covers: 'tokens' | 'tokens-and-fees';
      rateCardVersion: string;
      /** The card model id that actually priced it, after alias resolution. */
      resolvedModel?: string;
      /** The model the provider reported serving. */
      servedModel: string;
    }
  | { ok: false; reason: string };

/**
 * Price one Gemini benchmark call exactly as production would receipt it.
 *
 * Returns an explicit unavailable receipt — never a fabricated or zero cost —
 * whenever production could not price the same response.
 */
export function priceGeminiBenchmarkUsage(input: BenchmarkUsageInput): BenchmarkReceipt {
  // The production mapper decides which counters are present, which are malformed,
  // and whether the usage is honestly `complete`. Re-implementing that judgement
  // here is precisely how the two numbers used to drift.
  const { counters, usageCompleteness } = geminiUsageToReceipt(input.usage);
  const modelFields = resolveModelFields(input.requestedModel, input.providerModel);

  const cost = priceReceiptCounters({
    provider: 'gemini',
    ...modelFields,
    counters,
    usageCompleteness,
    // A grounded call owes a Google Search fee whose per-request charge is
    // free-tier-windowed and never reported per response — exactly what the
    // chokepoint records, so the benchmark inherits the same token-only coverage.
    feeState: input.grounded ? 'applicable-but-unknown' : 'none',
    occurredAt: input.occurredAt,
  });

  if (cost.state !== 'estimated' || cost.amountMicros === undefined || cost.covers === undefined) {
    return {
      ok: false,
      reason: cost.state === 'unavailable' ? cost.reason : 'deferred-estimate',
    };
  }
  return {
    ok: true,
    costUsd: cost.amountMicros / 1_000_000,
    amountMicros: cost.amountMicros,
    covers: cost.covers,
    rateCardVersion: cost.rateCardVersion,
    ...(cost.resolvedModel ? { resolvedModel: cost.resolvedModel } : {}),
    servedModel: modelFields.model ?? input.requestedModel,
  };
}

// ==========================================================================
// PER-MODEL AGGREGATION
// ==========================================================================

/** One benchmark row, reduced to the fields the summary depends on. */
export interface BenchmarkRun {
  ms: number;
  inTok: number;
  outTok: number;
  thoughtsTok: number;
  /** `null` when the response could not be priced. NEVER 0 as a stand-in. */
  costUsd: number | null;
  costUnavailableReason?: string;
  /** Set only when the CALL failed (no response at all). */
  error?: string;
}

export interface BenchmarkModelSummary {
  /** Rows that produced a response — the sample for latency, tokens and quality. */
  sampleCount: number;
  /** Rows whose call threw. Excluded from every sample. */
  failedCallCount: number;
  /** Responses contributing to the cost average. */
  pricedCount: number;
  /** Responses that happened and were billed, but could not be priced. */
  unpricedCount: number;
  p50Ms: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** Mean cost over PRICED responses only; `null` when none could be priced. */
  avgCostUsd: number | null;
  /** Distinct reasons behind `unpricedCount`, sorted for stable output. */
  unpricedReasons: string[];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Reduce one model's benchmark rows to its comparison summary.
 *
 * Two separate exclusions, deliberately NOT collapsed into one:
 *   - a FAILED CALL produced no response, so it leaves every sample;
 *   - an UNPRICEABLE response produced real latency, real tokens and a real answer,
 *     so it stays in those samples and leaves only the cost average.
 * Conflating them (the previous behaviour, which recorded an unpriceable cost as an
 * `error`) let a PRICING gap silently shrink the latency, token and blind-judge
 * samples — a cost-card omission quietly moving the quality verdict.
 *
 * `avgCostUsd` is `null` rather than `0` when nothing priced: averaging fabricated
 * zeros would report a model as effectively free.
 */
export function summarizeBenchmarkRuns(runs: readonly BenchmarkRun[]): BenchmarkModelSummary {
  const responded = runs.filter((run) => !run.error);
  const priced = responded.filter((run): run is BenchmarkRun & { costUsd: number } => typeof run.costUsd === 'number');
  const latencies = responded.map((run) => run.ms).sort((a, b) => a - b);
  return {
    sampleCount: responded.length,
    failedCallCount: runs.length - responded.length,
    pricedCount: priced.length,
    unpricedCount: responded.length - priced.length,
    p50Ms: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
    avgInputTokens: Math.round(mean(responded.map((run) => run.inTok))),
    avgOutputTokens: Math.round(mean(responded.map((run) => run.outTok + run.thoughtsTok))),
    avgCostUsd: priced.length ? mean(priced.map((run) => run.costUsd)) : null,
    unpricedReasons: [
      ...new Set(
        responded.filter((run) => typeof run.costUsd !== 'number').map((run) => run.costUnavailableReason ?? 'unknown')
      ),
    ].sort(),
  };
}
