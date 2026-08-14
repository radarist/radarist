/**
 * @file lib/operation-receipt-pricing.ts
 * @description TEST-021 / AI-029 — the ONE bridge from a captured provider
 * response to a PRICED receipt cost fact, using the canonical rate-card kernel.
 *
 * ARUN-022 captures raw provider counters; TEST-021 owns turning them into money.
 * This module is that seam and it is PURE (no Firestore, no provider I/O): it
 * maps the receipt's provider-raw counter set onto the kernel's `UsageCounters`,
 * derives the explicit `FeeSpec` from the receipt's fee tri-state, prices EACH
 * response INDEPENDENTLY against its own context tier via `priceUsage`, and emits
 * the schema's discriminated `OperationCost` fact — an `estimated` cost carrying
 * the rate-card version, resolved model, selected tier, applied rates, and the
 * per-component priced breakdown, or a fail-closed `unavailable` cost. It never
 * invents a rate and never reads an unknown model/fee/counter as $0.
 *
 * Because every provider response is priced on its own, a turn with one response
 * below 200k and another above 200k selects each response's own tier — the
 * defect that a single per-turn aggregate flat-rate hid.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import {
  getProviderRateCard,
  priceUsage,
  providerIdForSlug,
  RATE_CARD_VERSION,
  type FeeSpec,
  type PriceResult,
  type ProviderId,
  type UsageCounters,
} from '@/lib/ai/rate-card';
import type {
  OperationCost,
  OperationCostUnavailableReason,
  OperationFeeState,
  OperationModelProvenance,
  OperationReceiptCounters,
  OperationReceiptExternalFees,
  OperationUsageCompleteness,
} from '@/lib/schemas/operation-receipt';

/**
 * Map a receipt `provider` slug onto a canonical rate-card provider id, via the
 * ONE canonical alias table in the rate card (`providerIdForSlug`). A provider
 * the card does not model (a keyless search API, an un-priced boundary) has no id
 * — pricing fails closed for it.
 */
export function rateCardProviderId(providerSlug: string): ProviderId | undefined {
  return providerIdForSlug(providerSlug);
}

/** Round a fractional USD amount to exact integer micro-units (1e-6 USD). */
function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** A positive micro-unit value, or undefined so a zero line is omitted. */
function positiveMicros(usd: number | undefined): number | undefined {
  if (usd === undefined) return undefined;
  const micros = usdToMicros(usd);
  return micros > 0 ? micros : undefined;
}

/** A defined per-1M rate, or undefined so an absent rate is omitted. */
function definedRate(rate: number | undefined): number | undefined {
  return typeof rate === 'number' ? rate : undefined;
}

/**
 * Derive the kernel `FeeSpec` from the receipt's fee tri-state + amount:
 *   - `none` → no fee (`{ kind: 'none' }`);
 *   - `applicable-but-unknown` → `{ kind: 'unknown' }` (fails pricing closed —
 *     never a fabricated $0);
 *   - `known` → `{ kind: 'known', amountUsd }` summed from the recorded
 *     micro-unit fees. A `known` state with no amount is a data error and is
 *     treated as `unknown` (fail closed) rather than $0.
 */
export function feeSpecFromReceipt(
  feeState: OperationFeeState,
  externalFees: OperationReceiptExternalFees | undefined
): FeeSpec {
  if (feeState === 'none') return { kind: 'none' };
  if (feeState === 'applicable-but-unknown') return { kind: 'unknown' };
  // known — an amount MUST be explicit. An absent externalFees, or an object
  // carrying only a currency with no amount field, is NOT "known zero": the
  // amount is genuinely unknown and must fail closed (never a fabricated $0 fee).
  // An explicit `0` in any amount field IS a valid known-zero.
  if (!externalFees) return { kind: 'unknown' };
  const amounts = [externalFees.groundingFeeMicros, externalFees.queryFeeMicros, externalFees.imageFeeMicros];
  if (amounts.every((a) => a === undefined)) return { kind: 'unknown' };
  const totalMicros = amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0);
  return { kind: 'known', amountUsd: totalMicros / 1_000_000 };
}

/**
 * Map the receipt's provider-raw counter set onto the kernel's `UsageCounters`.
 *
 * The receipt records the RAW provider prompt counter verbatim (Gemini's
 * `promptTokenCount` INCLUDES its cached subset; Anthropic's `input_tokens`
 * EXCLUDES cache) plus `cacheReadTokens`. The kernel applies the provider's own
 * cache semantics (subtracting the cached subset for a subset provider) and FAILS
 * CLOSED when the cached count exceeds the total prompt — so this bridge passes
 * the counters through UNMODIFIED (only renaming to the kernel's field names and
 * de-micro'ing cache storage). It never reconstructs a subset, which would have
 * hidden an impossible cached>prompt fact. `thinkingTokens→thoughtsTokens`,
 * `cacheStorageMicroTokenHours/1e6→cacheStorageTokenHours`.
 */
export function receiptCountersToUsage(
  counters: OperationReceiptCounters,
  fee: FeeSpec,
  opts: { asOf?: string; contextTokens?: number } = {}
): UsageCounters {
  const usage: UsageCounters = {
    inputTokens: counters.promptTokens ?? 0,
    outputTokens: counters.outputTokens ?? 0,
    fee,
  };
  if (counters.thinkingTokens !== undefined) usage.thoughtsTokens = counters.thinkingTokens;
  if (counters.cacheReadTokens !== undefined) usage.cacheReadTokens = counters.cacheReadTokens;
  if (counters.cacheWrite5mTokens !== undefined) usage.cacheWrite5mTokens = counters.cacheWrite5mTokens;
  if (counters.cacheWrite1hTokens !== undefined) usage.cacheWrite1hTokens = counters.cacheWrite1hTokens;
  if (counters.cacheStorageMicroTokenHours !== undefined) {
    usage.cacheStorageTokenHours = counters.cacheStorageMicroTokenHours / 1_000_000;
  }
  if (opts.contextTokens !== undefined) usage.contextTokens = opts.contextTokens;
  if (opts.asOf !== undefined) usage.asOf = opts.asOf;
  return usage;
}

/** Map a kernel `unavailableReason` string onto the receipt's bounded reason enum. */
function toUnavailableReason(reason: string | undefined): OperationCostUnavailableReason {
  if (!reason) return 'unknown-pricing';
  if (reason.startsWith('invalid-counter')) return 'missing-usage';
  // unknown-provider / unknown-model / no-tier / *-rate-unknown / fee-* / asof-* / context-* → pricing is unknown.
  return 'unknown-pricing';
}

/** Convert a kernel `PriceResult` into the schema's discriminated cost fact. */
export function priceResultToOperationCost(result: PriceResult, feeState: OperationFeeState): OperationCost {
  if (result.settlement !== 'estimated' || result.costUsd === null || result.breakdown === null) {
    return { state: 'unavailable', reason: toUnavailableReason(result.unavailableReason) };
  }

  const b = result.breakdown;
  const breakdown = {
    inputMicros: positiveMicros(b.inputUsd),
    outputMicros: positiveMicros(b.outputUsd),
    cacheReadMicros: positiveMicros(b.cacheReadUsd),
    cacheWrite5mMicros: positiveMicros(b.cacheWrite5mUsd),
    cacheWrite1hMicros: positiveMicros(b.cacheWrite1hUsd),
    cacheStorageMicros: positiveMicros(b.cacheStorageUsd),
    feeMicros: positiveMicros(b.feeUsd),
  };
  // The headline amount is the EXACT sum of the persisted rounded components, so
  // the receipt invariant `amountMicros === Σ breakdown` holds by construction —
  // a reader recomputing the total from the breakdown can never disagree with it.
  const amountMicros = Object.values(breakdown).reduce<number>((sum, m) => sum + (m ?? 0), 0);
  const tier = result.tier;
  const appliedRates = tier
    ? {
        inputPerMillion: definedRate(tier.input),
        outputPerMillion: definedRate(tier.output),
        cacheReadPerMillion: definedRate(tier.cacheRead),
        cacheWrite5mPerMillion: definedRate(tier.cacheWrite5m),
        cacheWrite1hPerMillion: definedRate(tier.cacheWrite1h),
        cacheStoragePerMillionTokenHours: definedRate(tier.cacheStoragePerHour),
      }
    : undefined;

  return {
    state: 'estimated',
    rateCardVersion: result.rateCardVersion,
    amountMicros,
    currency: 'USD',
    // The priced amount includes a fee only when the fee was actually added (known).
    covers: feeState === 'known' ? 'tokens-and-fees' : 'tokens',
    ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
    ...(tier ? { tierMaxContextTokens: tier.maxContextTokens } : {}),
    ...(appliedRates ? { appliedRates } : {}),
    breakdown,
  };
}

/**
 * Price ONE captured provider response against the canonical card and return the
 * schema's `OperationCost` fact. Fails closed to `unavailable` whenever the
 * provider is not on the card, the model/tier/fee/counter is unknown, or a dated
 * tier is out of window — never a guessed number.
 *
 * `occurredAt` (the provider-occurrence ISO timestamp) supplies the `asOf` date a
 * time-bounded (introductory) rate is checked against, so an expired promo tier
 * fails closed rather than pinning to the card date.
 */
export function priceReceiptCounters(input: {
  provider: string;
  model?: string;
  requestedModel?: string;
  /** How the receipt's `model` was obtained — only a provider-confirmed model prices. */
  modelProvenance: OperationModelProvenance;
  /** Honest completeness of the counters — only `complete` prices. */
  usageCompleteness: OperationUsageCompleteness;
  counters: OperationReceiptCounters;
  feeState: OperationFeeState;
  externalFees?: OperationReceiptExternalFees;
  occurredAt: string;
  contextTokens?: number;
}): OperationCost {
  const card = getProviderRateCard();
  const providerId = rateCardProviderId(input.provider);
  // A provider the card doesn't model cannot be priced at all.
  if (!providerId) return { state: 'unavailable', reason: 'unknown-pricing' };

  // Usage must be the provider's COMPLETE accounting. Missing / partial /
  // unreported counters cannot become an estimated $0 — they fail closed.
  if (input.usageCompleteness !== 'complete') return { state: 'unavailable', reason: 'missing-usage' };

  // INDEPENDENTLY require the required provider counters — do not trust the
  // completeness enum alone. A receipt that claims `complete` but is missing its
  // prompt or output tokens (a forged or buggy record) cannot be priced. An
  // explicit 0 is present and prices; only genuine absence fails closed here.
  if (input.counters.promptTokens === undefined || input.counters.outputTokens === undefined) {
    return { state: 'unavailable', reason: 'missing-usage' };
  }

  // Only a PROVIDER-CONFIRMED served model may be billed. A requested-model
  // fallback (the provider reported no model) is useful metadata but is not
  // sufficient to price against — pricing the requested id as if it were the
  // billed model is a silent lie. Fail closed.
  if (input.modelProvenance !== 'provider-reported' || !input.model) {
    return { state: 'unavailable', reason: 'provider-unreported' };
  }

  // A KNOWN fee in a currency other than the card's cannot be folded into the
  // card-currency total — never relabel e.g. EUR as USD. Fail the whole cost
  // closed (the token portion alone can't be a "complete" headline when a fee in
  // another currency applies).
  if (input.feeState === 'known' && input.externalFees && input.externalFees.currency !== card.currency) {
    return { state: 'unavailable', reason: 'unknown-pricing' };
  }

  // Enforce BOTH bounds of dated pricing. The card did not exist before its
  // `effectiveDate`, so a response that occurred earlier cannot be priced against
  // it (the upper `validUntil` bound is enforced inside the kernel). ISO dates
  // compare lexically; `occurredAt` is a schema-guaranteed ISO datetime.
  const asOf = input.occurredAt.slice(0, 10);
  if (asOf < card.effectiveDate) return { state: 'unavailable', reason: 'unknown-pricing' };

  // FEE COVERAGE, not fee fabrication. An `applicable-but-unknown` fee (a grounded
  // Google Search whose per-request charge is free-tier-windowed and never reported
  // per response) used to fail the WHOLE cost closed, so a grounded response — the
  // dominant shape of research spend — contributed nothing at all to the ledger,
  // and its perfectly well-known token cost was discarded along with the unknown
  // fee. That is not conservatism, it is data loss: the tokens were billed and
  // their price is exactly derivable.
  //
  // Instead the tokens are priced with the fee EXCLUDED (never zeroed), and the
  // resulting cost declares `covers: 'tokens'` — the schema's explicit statement
  // that external fees are ADDITIVE to this amount. The receipt's own
  // `feeState: 'applicable-but-unknown'` remains the standing disclosure that such
  // a fee exists and its amount is unknown, and the canonical roll-up
  // (`summarizeOperationAccounting`) reads it and refuses to call any total that
  // contains one whole. A `known` fee in an unsupported currency, a malformed
  // counter, an unknown model — all still fail closed as before.
  const tokenFee: FeeSpec =
    input.feeState === 'applicable-but-unknown'
      ? { kind: 'none' }
      : feeSpecFromReceipt(input.feeState, input.externalFees);
  const usage = receiptCountersToUsage(input.counters, tokenFee, { asOf, contextTokens: input.contextTokens });
  const result = priceUsage(providerId, input.model, usage);
  return priceResultToOperationCost(result, input.feeState);
}

export const PRICING_RATE_CARD_VERSION = RATE_CARD_VERSION;
