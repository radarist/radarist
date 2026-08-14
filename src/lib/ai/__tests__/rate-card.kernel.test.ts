/**
 * @file rate-card.kernel.test.ts
 * @description TEST-021 — the pure root pricing kernel over the one authored
 * canonical rate card (config/provider-rate-card.json).
 *
 * Focused regressions the reopened lane requires: cache arithmetic (Gemini
 * cached input is a subset; Anthropic counters are disjoint), 5-minute vs
 * 1-hour cache creation, Google cache storage (token-hours), context-tier
 * boundaries, provider-specific thinking (Gemini adds thoughts, Anthropic never
 * does), mandatory + fail-closed fee state, explicit-context floor, adversarial
 * counters, unknown model/tier/fee fail-closed, and rate-card validation.
 *
 * @jest-environment node
 */

import type { FeeSpec, ProviderRateCard, UsageCounters } from '../rate-card';
import {
  RATE_CARD_VERSION,
  RateCardValidationError,
  assertValidRateCard,
  getProviderRateCard,
  priceUsage,
  resolveModelTier,
} from '../rate-card';

const NO_FEE: FeeSpec = { kind: 'none' };

/** Build usage counters with a default no-fee so each test states only what matters. */
function usage(partial: Partial<UsageCounters> & { inputTokens: number; outputTokens: number }): UsageCounters {
  return { fee: NO_FEE, ...partial };
}

describe('canonical rate card metadata', () => {
  it('is versioned, dated, and cites a source date per provider', () => {
    const card = getProviderRateCard();
    expect(card.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RATE_CARD_VERSION).toBe(card.version);
    expect(card.providers.google.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card.providers.anthropic.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('records the in-effect Sonnet 5 introductory price with a validity window', () => {
    const tier = getProviderRateCard().providers.anthropic.models['claude-sonnet-5'].tiers[0];
    expect(tier.input).toBe(2.0);
    expect(tier.output).toBe(10.0);
    expect(tier.cacheRead).toBe(0.2);
    expect(tier.validUntil).toBe('2026-08-31');
  });
});

describe('priceUsage — Anthropic (disjoint counters, output already includes thinking)', () => {
  it('prices input, output, cache-read, and 5m/1h cache-write as separate line items', () => {
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      })
    );
    expect(r.settlement).toBe('estimated');
    // 5 + 25 + 0.5 + 6.25 + 10
    expect(r.costUsd).toBeCloseTo(46.75, 6);
    expect(r.breakdown?.cacheWrite5mUsd).toBeCloseTo(6.25, 6);
    expect(r.breakdown?.cacheWrite1hUsd).toBeCloseTo(10, 6);
  });

  it('does NOT subtract cache-read from input (Anthropic counters are disjoint)', () => {
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })
    );
    expect(r.costUsd).toBeCloseTo(5.5, 6); // input 5 + cacheRead 0.5
  });

  it('never adds thoughts to Anthropic output — fails closed if thoughts are supplied', () => {
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({ inputTokens: 0, outputTokens: 1_000_000, thoughtsTokens: 1 })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/thoughts-not-separable/);
  });

  it('prices Anthropic output alone (thinking already included) at the model rate', () => {
    const r = priceUsage('anthropic', 'claude-opus-4-8', usage({ inputTokens: 0, outputTokens: 1_000_000 }));
    expect(r.costUsd).toBeCloseTo(25, 6);
  });

  it('honors the in-effect Sonnet 5 introductory price (not the post-promo rate) with an in-window asOf', () => {
    const r = priceUsage(
      'anthropic',
      'claude-sonnet-5',
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, asOf: '2026-08-15' })
    );
    expect(r.costUsd).toBeCloseTo(12, 6); // input 2 + output 10
  });

  it('resolves a dated model alias by longest prefix', () => {
    const r = priceUsage('anthropic', 'claude-haiku-4-5-20251001', usage({ inputTokens: 1_000_000, outputTokens: 0 }));
    expect(r.resolvedModel).toBe('claude-haiku-4-5');
    expect(r.costUsd).toBeCloseTo(1, 6);
  });
});

describe('priceUsage — Gemini (cached input is a subset; candidates exclude thoughts)', () => {
  it('prices the cached portion at cache-read and the remainder at input, never double-counting', () => {
    const r = priceUsage(
      'google',
      'gemini-3.1-pro-preview',
      usage({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 40_000 })
    );
    // remainder 60k * $2/M = 0.12 ; cached 40k * $0.2/M = 0.008 => 0.128
    expect(r.costUsd).toBeCloseTo(0.128, 6);
  });

  it('adds thinking tokens to Gemini output', () => {
    const r = priceUsage(
      'google',
      'gemini-3.5-flash',
      usage({ inputTokens: 0, outputTokens: 100_000, thoughtsTokens: 100_000 })
    );
    expect(r.costUsd).toBeCloseTo(1.8, 6); // 200k * $9/M
  });

  it('prices Google cache storage per token-hour', () => {
    const r = priceUsage(
      'google',
      'gemini-2.5-pro',
      usage({ inputTokens: 0, outputTokens: 0, cacheStorageTokenHours: 1_000_000 })
    );
    expect(r.costUsd).toBeCloseTo(4.5, 6);
  });
});

describe('priceUsage — context tier boundary (both tiers now priced)', () => {
  it('uses the <=200k tier at or below the boundary for gemini-3.1-pro', () => {
    expect(resolveModelTier('google', 'gemini-3.1-pro-preview', 200_000)?.input).toBe(2.0);
    const r = priceUsage(
      'google',
      'gemini-3.1-pro-preview',
      usage({ inputTokens: 200_000, outputTokens: 0, contextTokens: 200_000 })
    );
    expect(r.costUsd).toBeCloseTo(0.4, 6);
  });

  it('uses the >200k tier above the boundary (input 4 / output 18 / cache-read 0.40)', () => {
    const r = priceUsage(
      'google',
      'gemini-3.1-pro-preview',
      usage({ inputTokens: 250_000, outputTokens: 0, contextTokens: 250_000 })
    );
    expect(r.tier?.input).toBe(4.0);
    expect(r.costUsd).toBeCloseTo(1.0, 6); // 250k * $4/M
  });

  it('splits gemini-2.5-pro at 200k (1.25 vs 2.50 input)', () => {
    const below = priceUsage('google', 'gemini-2.5-pro', usage({ inputTokens: 100_000, outputTokens: 0 }));
    const above = priceUsage('google', 'gemini-2.5-pro', usage({ inputTokens: 300_000, outputTokens: 0 }));
    expect(below.costUsd).toBeCloseTo(0.125, 6); // 100k * 1.25
    expect(above.costUsd).toBeCloseTo(0.75, 6); // 300k * 2.50
  });
});

describe('priceUsage — explicit context floor and cache-creation in derived context', () => {
  it('fails closed when explicit context is below the provider-derived prompt size', () => {
    // input 100k + 5m cache-creation 50k => derived prompt 150k; a 100k context is impossible.
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({ inputTokens: 100_000, outputTokens: 0, cacheWrite5mTokens: 50_000, contextTokens: 100_000 })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/context-below-prompt/);
  });

  it('accepts an explicit context at or above the derived prompt size', () => {
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({ inputTokens: 100_000, outputTokens: 0, cacheWrite5mTokens: 50_000, contextTokens: 150_000 })
    );
    expect(r.settlement).toBe('estimated');
  });
});

describe('priceUsage — provider fee state (mandatory + fail closed)', () => {
  it('keeps a KNOWN fee as its own line item on top of token cost', () => {
    const r = priceUsage(
      'anthropic',
      'claude-haiku-4-5',
      usage({ inputTokens: 1_000_000, outputTokens: 0, fee: { kind: 'known', amountUsd: 0.05 } })
    );
    expect(r.breakdown?.feeUsd).toBeCloseTo(0.05, 6);
    expect(r.costUsd).toBeCloseTo(1.05, 6);
  });

  it('fails closed when a fee applies but its amount is unknown', () => {
    const r = priceUsage(
      'anthropic',
      'claude-haiku-4-5',
      usage({ inputTokens: 1, outputTokens: 0, fee: { kind: 'unknown' } })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/fee-unknown-required/);
  });

  it('fails closed when the required fee is missing entirely', () => {
    const bad = { inputTokens: 1, outputTokens: 0 } as unknown as UsageCounters;
    const r = priceUsage('anthropic', 'claude-haiku-4-5', bad);
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/fee-required/);
  });

  it('fails closed on an invalid known-fee amount', () => {
    for (const amountUsd of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      const r = priceUsage(
        'anthropic',
        'claude-haiku-4-5',
        usage({ inputTokens: 1, outputTokens: 0, fee: { kind: 'known', amountUsd } })
      );
      expect(r.settlement).toBe('unavailable');
      expect(r.unavailableReason).toMatch(/invalid-fee/);
    }
  });

  it('fails closed on an unrecognized fee kind (no fall-through to zero fee)', () => {
    const bad = {
      inputTokens: 1,
      outputTokens: 0,
      fee: { kind: 'complimentary' },
    } as unknown as UsageCounters;
    const r = priceUsage('anthropic', 'claude-haiku-4-5', bad);
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-fee-kind/);
  });
});

describe('priceUsage — required counters cannot be omitted-to-zero', () => {
  it('is unavailable when the required inputTokens is missing', () => {
    const bad = { outputTokens: 100, fee: NO_FEE } as unknown as UsageCounters;
    const r = priceUsage('anthropic', 'claude-opus-4-8', bad);
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-counter:.*inputTokens/);
  });

  it('is unavailable when the required outputTokens is missing (never a confident zero)', () => {
    const bad = { inputTokens: 100, fee: NO_FEE } as unknown as UsageCounters;
    const r = priceUsage('anthropic', 'claude-opus-4-8', bad);
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-counter:.*outputTokens/);
  });

  it('still allows an EXPLICIT zero output (0 is present, undefined is not)', () => {
    const r = priceUsage('anthropic', 'claude-opus-4-8', usage({ inputTokens: 1_000_000, outputTokens: 0 }));
    expect(r.settlement).toBe('estimated');
    expect(r.costUsd).toBeCloseTo(5, 6);
  });
});

describe('priceUsage — rate freshness (validUntil enforcement)', () => {
  const base = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

  it('prices the Sonnet 5 promo at an as-of date within the window', () => {
    const r = priceUsage('anthropic', 'claude-sonnet-5', usage({ ...base, asOf: '2026-08-15' }));
    expect(r.settlement).toBe('estimated');
    expect(r.costUsd).toBeCloseTo(12, 6); // 2 + 10
  });

  it('fails closed for usage dated after the promo validUntil (2026-08-31)', () => {
    const r = priceUsage('anthropic', 'claude-sonnet-5', usage({ ...base, asOf: '2026-09-01' }));
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/tier-rate-expired/);
  });

  it('fails closed on a dated tier when asOf is omitted (no silent pin to the card date)', () => {
    const r = priceUsage('anthropic', 'claude-sonnet-5', usage({ ...base }));
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/asof-required-for-dated-tier/);
  });

  it('does not require asOf for a timeless tier, even far in the future', () => {
    const withFuture = priceUsage('anthropic', 'claude-opus-4-8', usage({ ...base, asOf: '2099-01-01' }));
    const withNone = priceUsage('anthropic', 'claude-opus-4-8', usage({ ...base }));
    expect(withFuture.settlement).toBe('estimated');
    expect(withNone.settlement).toBe('estimated');
  });

  it('fails closed on an invalid as-of date', () => {
    const r = priceUsage('anthropic', 'claude-sonnet-5', usage({ ...base, asOf: '2026-13-40' }));
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-asof/);
  });
});

describe('priceUsage — adversarial counters fail closed (no silent clamping)', () => {
  const bad: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ];

  it.each(bad)('is unavailable when inputTokens is %s', (_label, value) => {
    const r = priceUsage('anthropic', 'claude-opus-4-8', usage({ inputTokens: value, outputTokens: 0 }));
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-counter/);
  });

  it('is unavailable for an invalid context value rather than coercing it', () => {
    const r = priceUsage(
      'google',
      'gemini-3.1-pro-preview',
      usage({ inputTokens: 1000, outputTokens: 0, contextTokens: Number.NaN })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/invalid-context/);
  });

  it('is unavailable when a subset provider reports cache-read greater than input', () => {
    const r = priceUsage(
      'google',
      'gemini-3.1-pro-preview',
      usage({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 100_001 })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/cache-read-exceeds-input/);
  });
});

describe('priceUsage — fail closed on unknowns', () => {
  it('is unavailable for an unknown provider', () => {
    const r = priceUsage('openai' as never, 'gpt-5', usage({ inputTokens: 1, outputTokens: 1 }));
    expect(r.settlement).toBe('unavailable');
    expect(r.costUsd).toBeNull();
  });

  it('is unavailable for an unknown model', () => {
    const r = priceUsage('google', 'gemini-9-imaginary', usage({ inputTokens: 1, outputTokens: 1 }));
    expect(r.settlement).toBe('unavailable');
  });

  it('is unavailable when a needed cache-read rate is absent but the counter is non-zero', () => {
    // gemini-2.5-flash HAS a cache-read rate; use a synthetic absence via cache-write on Gemini
    // (Gemini tiers carry no cacheWrite5m), so a non-zero 5m counter is unpriceable.
    const r = priceUsage(
      'google',
      'gemini-2.5-flash',
      usage({ inputTokens: 1_000, outputTokens: 0, cacheWrite5mTokens: 1_000 })
    );
    expect(r.settlement).toBe('unavailable');
    expect(r.unavailableReason).toMatch(/cache-write-5m-rate-unknown/);
  });

  it('never emits an actual settlement — rate-card math is always an estimate', () => {
    const r = priceUsage('anthropic', 'claude-opus-4-8', usage({ inputTokens: 1_000_000, outputTokens: 0 }));
    expect(r.settlement).toBe('estimated');
  });

  it('preserves the raw counters it was given', () => {
    const r = priceUsage(
      'anthropic',
      'claude-opus-4-8',
      usage({ inputTokens: 123, outputTokens: 45, cacheReadTokens: 6, cacheWrite5mTokens: 7, cacheWrite1hTokens: 8 })
    );
    expect(r.counters).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      thoughtsTokens: 0,
      cacheReadTokens: 6,
      cacheWrite5mTokens: 7,
      cacheWrite1hTokens: 8,
      cacheStorageTokenHours: 0,
    });
  });
});

describe('assertValidRateCard (TEST-021)', () => {
  function validCard(): ProviderRateCard {
    // Deep-clone the real card so mutations don't touch the frozen singleton.
    return JSON.parse(JSON.stringify(getProviderRateCard()));
  }

  it('accepts the authored canonical card', () => {
    expect(() => assertValidRateCard(getProviderRateCard())).not.toThrow();
  });

  it('rejects an unsupported currency', () => {
    const c = validCard();
    c.currency = 'EUR';
    expect(() => assertValidRateCard(c)).toThrow(RateCardValidationError);
  });

  it('rejects a non-ISO version', () => {
    const c = validCard();
    c.version = 'v1';
    expect(() => assertValidRateCard(c)).toThrow(/version/i);
  });

  it('rejects a negative rate', () => {
    const c = validCard();
    c.providers.anthropic.models['claude-opus-4-8'].tiers[0].input = -1;
    expect(() => assertValidRateCard(c)).toThrow(/non-negative/i);
  });

  it('rejects tiers that are not strictly ascending', () => {
    const c = validCard();
    c.providers.google.models['gemini-3.1-pro-preview'].tiers = [
      { maxContextTokens: 200000, input: 2, output: 12 },
      { maxContextTokens: 100000, input: 4, output: 18 },
      { maxContextTokens: null, input: 4, output: 18 },
    ];
    expect(() => assertValidRateCard(c)).toThrow(/strictly greater/i);
  });

  it('rejects a model whose final tier is bounded', () => {
    const c = validCard();
    c.providers.google.models['gemini-2.5-flash'].tiers = [{ maxContextTokens: 200000, input: 0.3, output: 2.5 }];
    expect(() => assertValidRateCard(c)).toThrow(/final tier must be unbounded/i);
  });

  it('rejects an invalid validUntil date', () => {
    const c = validCard();
    c.providers.anthropic.models['claude-sonnet-5'].tiers[0].validUntil = '2026-13-40';
    expect(() => assertValidRateCard(c)).toThrow(/validUntil/i);
  });
});
