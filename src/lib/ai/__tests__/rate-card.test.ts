/**
 * @file rate-card.test.ts
 * @description TEST-021 — one canonical, timestamped rate card.
 *
 * A legacy benchmark carried its own Gemini price fixture that
 * had drifted: it priced gemini-3.1-pro-preview output at $18/M against the
 * runtime table's $12/M, overstating the pro tier by 50% and therefore
 * overstating the "switch to flash" saving that the benchmark exists to
 * measure. Benchmarks must price from the same card the app bills against,
 * and must refuse to price a model the card doesn't list.
 *
 * @jest-environment node
 */

import { GEMINI_RATE_CARD, MODEL_PRICING, rateCardPriceUsd } from '../reliability';

describe('GEMINI_RATE_CARD (TEST-021)', () => {
  it('is timestamped and cites its source', () => {
    expect(GEMINI_RATE_CARD.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(GEMINI_RATE_CARD.source).toContain('ai.google.dev');
  });

  it('exposes exactly the runtime pricing table — one source of truth, not a copy', () => {
    expect(GEMINI_RATE_CARD.rates).toBe(MODEL_PRICING);
  });

  it('prices the pro tier at the canonical rate the app bills against', () => {
    // The benchmark fixture said $18/M output. The app bills $12/M.
    expect(GEMINI_RATE_CARD.rates['gemini-3.1-pro-preview']).toEqual({ input: 2.0, output: 12.0 });
  });
});

describe('rateCardPriceUsd (TEST-021)', () => {
  it('bills thinking tokens as output at the <=200k base tier', () => {
    // 100k input (<=200k) + (100k output + 100k thoughts) at $2/$12.
    const cost = rateCardPriceUsd('gemini-3.1-pro-preview', {
      inputTokens: 100_000,
      outputTokens: 100_000,
      thoughtsTokens: 100_000,
    });
    expect(cost).toBeCloseTo((100_000 * 2 + 200_000 * 12) / 1_000_000, 6);
  });

  it('honors the >200k context tier (3.1 Pro input $4/M above the boundary)', () => {
    const below = rateCardPriceUsd('gemini-3.1-pro-preview', { inputTokens: 200_000, outputTokens: 0 });
    const above = rateCardPriceUsd('gemini-3.1-pro-preview', { inputTokens: 300_000, outputTokens: 0 });
    expect(below).toBeCloseTo(0.4, 6); // 200k * $2/M
    expect(above).toBeCloseTo(1.2, 6); // 300k * $4/M
  });

  it('honors the 2.5 Pro 200k split (1.25 vs 2.50 input)', () => {
    expect(rateCardPriceUsd('gemini-2.5-pro', { inputTokens: 100_000, outputTokens: 0 })).toBeCloseTo(0.125, 6);
    expect(rateCardPriceUsd('gemini-2.5-pro', { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo(0.75, 6);
  });

  it('treats absent thinking tokens as zero', () => {
    const cost = rateCardPriceUsd('gemini-2.5-flash', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('throws on an unpriced model rather than guessing a rate', () => {
    expect(() => rateCardPriceUsd('gemini-9-omega', { inputTokens: 1000, outputTokens: 1000 })).toThrow(
      /gemini-9-omega/
    );
  });

  it('names the rate-card date in the failure so a stale card is obvious', () => {
    expect(() => rateCardPriceUsd('gemini-9-omega', { inputTokens: 1, outputTokens: 1 })).toThrow(
      new RegExp(GEMINI_RATE_CARD.asOf)
    );
  });
});
