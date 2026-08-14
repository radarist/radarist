/**
 * @file lib/__tests__/operation-receipt-pricing.test.ts
 * @description TEST-021 / AI-029 — the receipt→canonical-card pricing bridge,
 * with the ADVERSARIAL negative cases that keep it FINANCIALLY TRUTHFUL.
 *
 * Positive contract:
 * - each response is priced INDEPENDENTLY on its own context tier;
 * - the raw provider prompt counter is passed through and the kernel applies the
 *   provider's own cache semantics (Gemini cached billed once; Anthropic 5m/1h
 *   distinct);
 * - the priced estimate carries rate-card version, resolved model, tier, applied
 *   rates, and a per-component breakdown whose components SUM EXACTLY to the
 *   headline amountMicros.
 *
 * Fail-closed contract (never a fabricated cost or $0):
 * - missing/partial/unreported usage → unavailable, not estimated $0;
 * - a non-provider-confirmed (requested-fallback / model-less) model → unavailable;
 * - an empty known-fee object → unavailable (not "known zero");
 * - a fee in a non-card currency (EUR) → unavailable (never relabelled USD);
 * - a response before the card's effectiveDate, or after a tier's validUntil → unavailable;
 * - an impossible cached>prompt fact → unavailable (not clamped-and-priced).
 *
 * Pure module — no Firestore, no provider I/O.
 *
 * @jest-environment node
 */

import {
  feeSpecFromReceipt,
  priceReceiptCounters,
  rateCardProviderId,
  receiptCountersToUsage,
} from '../operation-receipt-pricing';
import { RATE_CARD_VERSION, getProviderRateCard } from '@/lib/ai/rate-card';
import type { OperationCost, OperationReceiptCounters } from '../schemas/operation-receipt';

const OCCURRED = '2026-07-22T09:00:00.000Z';

/** Price with the honest defaults (provider-confirmed model, complete usage). */
function price(overrides: {
  provider?: string;
  model?: string | undefined;
  modelProvenance?: 'provider-reported' | 'requested-fallback' | 'unreported';
  usageCompleteness?: 'complete' | 'partial' | 'unreported';
  counters: OperationReceiptCounters;
  feeState?: 'none' | 'known' | 'applicable-but-unknown';
  externalFees?: { currency: string; groundingFeeMicros?: number; queryFeeMicros?: number; imageFeeMicros?: number };
  occurredAt?: string;
}): OperationCost {
  return priceReceiptCounters({
    provider: overrides.provider ?? 'gemini',
    model: 'model' in overrides ? overrides.model : 'gemini-3.5-flash',
    modelProvenance: overrides.modelProvenance ?? 'provider-reported',
    usageCompleteness: overrides.usageCompleteness ?? 'complete',
    counters: overrides.counters,
    feeState: overrides.feeState ?? 'none',
    externalFees: overrides.externalFees,
    occurredAt: overrides.occurredAt ?? OCCURRED,
  });
}

describe('rateCardProviderId', () => {
  it('maps provider slugs to canonical rate-card ids; unmodelled providers are undefined', () => {
    expect(rateCardProviderId('gemini')).toBe('google');
    expect(rateCardProviderId('anthropic')).toBe('anthropic');
    // AI-029 — the chat path's `claude` slug is first-party Anthropic.
    expect(rateCardProviderId('claude')).toBe('anthropic');
    expect(rateCardProviderId('exa')).toBeUndefined();
    expect(rateCardProviderId('firecrawl')).toBeUndefined();
  });
});

describe('feeSpecFromReceipt', () => {
  it('none/applicable-but-unknown/known-with-amount map correctly', () => {
    expect(feeSpecFromReceipt('none', undefined)).toEqual({ kind: 'none' });
    expect(feeSpecFromReceipt('applicable-but-unknown', undefined)).toEqual({ kind: 'unknown' });
    expect(feeSpecFromReceipt('known', { currency: 'USD', groundingFeeMicros: 14000 })).toEqual({
      kind: 'known',
      amountUsd: 0.014,
    });
  });

  it('an EXPLICIT zero amount is a valid known-zero', () => {
    expect(feeSpecFromReceipt('known', { currency: 'USD', groundingFeeMicros: 0 })).toEqual({
      kind: 'known',
      amountUsd: 0,
    });
  });

  it('a known fee with NO amount field (currency only) is unknown, never $0', () => {
    expect(feeSpecFromReceipt('known', { currency: 'USD' })).toEqual({ kind: 'unknown' });
    expect(feeSpecFromReceipt('known', undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('receiptCountersToUsage — passes raw counters through (no reconstruction)', () => {
  it('maps prompt/thinking/cache-storage onto the kernel field names verbatim', () => {
    const usage = receiptCountersToUsage(
      {
        promptTokens: 1000,
        outputTokens: 20,
        thinkingTokens: 5,
        cacheReadTokens: 400,
        cacheStorageMicroTokenHours: 12_500_000,
      },
      { kind: 'none' }
    );
    expect(usage.inputTokens).toBe(1000); // raw, NOT reconstructed
    expect(usage.cacheReadTokens).toBe(400);
    expect(usage.thoughtsTokens).toBe(5);
    expect(usage.cacheStorageTokenHours).toBe(12.5);
  });
});

describe('priceReceiptCounters — per-response pricing', () => {
  it('prices a sub-200k Gemini 3.1 Pro response on the low tier with a breakdown that sums to the total', () => {
    const cost = price({ model: 'gemini-3.1-pro-preview', counters: { promptTokens: 1000, outputTokens: 500 } });
    expect(cost).toEqual({
      state: 'estimated',
      rateCardVersion: RATE_CARD_VERSION,
      amountMicros: 8000, // 2000 input + 6000 output
      currency: 'USD',
      covers: 'tokens',
      resolvedModel: 'gemini-3.1-pro-preview',
      tierMaxContextTokens: 200000,
      appliedRates: {
        inputPerMillion: 2,
        outputPerMillion: 12,
        cacheReadPerMillion: 0.2,
        cacheStoragePerMillionTokenHours: 4.5,
      },
      breakdown: { inputMicros: 2000, outputMicros: 6000 },
    });
  });

  it('selects each response its own tier (sub-200k vs over-200k)', () => {
    const low = price({ model: 'gemini-3.1-pro-preview', counters: { promptTokens: 1000, outputTokens: 100 } });
    const high = price({ model: 'gemini-3.1-pro-preview', counters: { promptTokens: 250_000, outputTokens: 100 } });
    expect(low.state === 'estimated' && low.tierMaxContextTokens).toBe(200000);
    expect(high.state === 'estimated' && high.tierMaxContextTokens).toBeNull();
    expect(high.state === 'estimated' && high.amountMicros).toBe(1_001_800);
  });

  it('bills Gemini cached input ONCE (kernel subtracts the cached subset from the raw prompt)', () => {
    // promptTokens is the RAW total (includes the 500 cached); billable = 500.
    const cost = price({ counters: { promptTokens: 1000, outputTokens: 0, cacheReadTokens: 500 } });
    expect(cost).toMatchObject({
      state: 'estimated',
      amountMicros: 825, // 500*1.5 input + 500*0.15 cacheRead
      breakdown: { inputMicros: 750, cacheReadMicros: 75 },
    });
  });

  it('keeps Anthropic 5m/1h cache writes distinct and sums the breakdown exactly to the headline', () => {
    const cost = price({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      counters: { promptTokens: 1000, outputTokens: 50, cacheWrite5mTokens: 200, cacheWrite1hTokens: 100 },
    });
    expect(cost).toMatchObject({
      state: 'estimated',
      amountMicros: 8500,
      breakdown: { inputMicros: 5000, outputMicros: 1250, cacheWrite5mMicros: 1250, cacheWrite1hMicros: 1000 },
    });
    // Invariant: amountMicros == Σ breakdown.
    if (cost.state === 'estimated' && cost.breakdown) {
      const sum = Object.values(cost.breakdown).reduce<number>((s, m) => s + (m ?? 0), 0);
      expect(sum).toBe(cost.amountMicros);
    }
  });

  it('adds a KNOWN fee once and marks coverage tokens-and-fees', () => {
    const cost = price({
      counters: { promptTokens: 1000, outputTokens: 0 },
      feeState: 'known',
      externalFees: { currency: 'USD', groundingFeeMicros: 14000 },
    });
    expect(cost).toMatchObject({
      state: 'estimated',
      amountMicros: 15500, // 1500 input + 14000 fee
      covers: 'tokens-and-fees',
      breakdown: { inputMicros: 1500, feeMicros: 14000 },
    });
  });

  it('honors a dated introductory tier via occurredAt (priced in-window, unavailable after validUntil)', () => {
    expect(
      price({ provider: 'anthropic', model: 'claude-sonnet-5', counters: { promptTokens: 1000, outputTokens: 0 } })
    ).toMatchObject({ state: 'estimated', amountMicros: 2000 });
    expect(
      price({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        counters: { promptTokens: 1000, outputTokens: 0 },
        occurredAt: '2026-09-15T00:00:00.000Z',
      })
    ).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });
});

describe('priceReceiptCounters — FAIL CLOSED (adversarial)', () => {
  it('missing / partial / unreported usage is unavailable, NEVER estimated $0', () => {
    expect(price({ usageCompleteness: 'unreported', counters: {} })).toEqual({
      state: 'unavailable',
      reason: 'missing-usage',
    });
    expect(price({ usageCompleteness: 'partial', counters: { promptTokens: 10, outputTokens: 5 } })).toEqual({
      state: 'unavailable',
      reason: 'missing-usage',
    });
  });

  it('INDEPENDENTLY rejects a forged `complete` receipt missing required counters (does not trust the enum)', () => {
    // A record claims complete but has no prompt/output tokens — never priced $0.
    expect(price({ usageCompleteness: 'complete', counters: {} })).toEqual({
      state: 'unavailable',
      reason: 'missing-usage',
    });
    expect(price({ usageCompleteness: 'complete', counters: { promptTokens: 10 } })).toEqual({
      state: 'unavailable',
      reason: 'missing-usage',
    });
    expect(price({ usageCompleteness: 'complete', counters: { outputTokens: 10 } })).toEqual({
      state: 'unavailable',
      reason: 'missing-usage',
    });
  });

  it('a requested-model FALLBACK is not billable (only a provider-confirmed model prices)', () => {
    expect(price({ modelProvenance: 'requested-fallback', counters: { promptTokens: 100, outputTokens: 10 } })).toEqual(
      { state: 'unavailable', reason: 'provider-unreported' }
    );
    expect(
      price({ model: undefined, modelProvenance: 'unreported', counters: { promptTokens: 100, outputTokens: 10 } })
    ).toEqual({ state: 'unavailable', reason: 'provider-unreported' });
  });

  it('an empty known-fee object is unavailable (not a fabricated known-zero)', () => {
    expect(
      price({ counters: { promptTokens: 100, outputTokens: 0 }, feeState: 'known', externalFees: { currency: 'USD' } })
    ).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });

  it('a fee in a non-card currency (EUR) is unavailable — never relabelled USD', () => {
    expect(
      price({
        counters: { promptTokens: 100, outputTokens: 0 },
        feeState: 'known',
        externalFees: { currency: 'EUR', groundingFeeMicros: 1000 },
      })
    ).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });

  it('a response BEFORE the card effectiveDate is unavailable (lower dated bound)', () => {
    const card = getProviderRateCard();
    expect(card.effectiveDate).toBe('2026-07-22');
    expect(
      price({ counters: { promptTokens: 100, outputTokens: 10 }, occurredAt: '2020-01-01T00:00:00.000Z' })
    ).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });

  it('an impossible cached>prompt fact is unavailable (not clamped and priced)', () => {
    // promptTokens is the RAW total; a cached subset larger than the total is impossible.
    expect(price({ counters: { promptTokens: 100, outputTokens: 0, cacheReadTokens: 500 } })).toEqual({
      state: 'unavailable',
      reason: 'unknown-pricing',
    });
  });

  describe('an applicable-but-unknown provider fee', () => {
    // The fee is genuinely unknown (Google Search grounding is free-tier-windowed
    // and never reported per response). Discarding the perfectly derivable TOKEN
    // cost along with it lost the dominant shape of research spend from the ledger
    // entirely. Price the tokens, exclude the fee, and say so in `covers`.
    it('still prices the tokens it CAN price, and never folds the fee in as $0', () => {
      const withFee = price({
        counters: { promptTokens: 1_000_000, outputTokens: 0 },
        feeState: 'applicable-but-unknown',
      });
      const withoutFee = price({ counters: { promptTokens: 1_000_000, outputTokens: 0 }, feeState: 'none' });
      expect(withFee).toMatchObject({ state: 'estimated', amountMicros: 1_500_000, currency: 'USD' });
      // Byte-identical to the fee-free response: the unknown fee is EXCLUDED from
      // the amount, not silently valued at zero inside it.
      expect(withFee).toEqual(withoutFee);
    });

    it('declares token-only coverage, so a reader knows fees are additive', () => {
      const cost = price({
        counters: { promptTokens: 1000, outputTokens: 10 },
        feeState: 'applicable-but-unknown',
      });
      expect(cost).toMatchObject({ state: 'estimated', covers: 'tokens' });
    });

    it('does not rescue a response that is unpriceable for any OTHER reason', () => {
      expect(
        price({
          model: 'gemini-does-not-exist',
          counters: { promptTokens: 1000, outputTokens: 10 },
          feeState: 'applicable-but-unknown',
        })
      ).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
      expect(
        price({
          counters: { promptTokens: 1000, outputTokens: 10 },
          usageCompleteness: 'partial',
          feeState: 'applicable-but-unknown',
        })
      ).toEqual({ state: 'unavailable', reason: 'missing-usage' });
    });

    it('leaves the kernel-level fee contract untouched — an unknown fee still fails the kernel closed', () => {
      // The relaxation is a RECEIPT-layer coverage decision. The pure kernel must
      // keep refusing to price an unknown fee, or every other caller silently gains
      // a $0 fee.
      expect(feeSpecFromReceipt('applicable-but-unknown', undefined)).toEqual({ kind: 'unknown' });
    });
  });

  it('an unknown model / unmodelled provider is unavailable (no family/default fallback)', () => {
    expect(price({ model: 'gemini-does-not-exist', counters: { promptTokens: 1000, outputTokens: 10 } })).toEqual({
      state: 'unavailable',
      reason: 'unknown-pricing',
    });
    expect(price({ provider: 'exa', model: 'exa-search', counters: { queryCount: 1 } })).toEqual({
      state: 'unavailable',
      reason: 'unknown-pricing',
    });
  });
});
