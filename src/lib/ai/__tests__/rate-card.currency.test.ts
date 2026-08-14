/**
 * DEP-009 — provider rate-card currency.
 *
 * Pricing fails closed (AI-029): an unlisted model makes `resolveGeminiPricing`
 * return undefined, `calculateCost` return null, and every run persist
 * `costUnavailableReason`. So a model can only become selectable AFTER its
 * rate-card row exists — these tests are the guard that keeps the two in step.
 *
 * Every figure below was re-verified against Google's and Anthropic's primary
 * pricing documentation on 2026-07-30.
 */

import rawCard from '../../../../config/provider-rate-card.json';
import { resolveGeminiPricing } from '../rate-card';

const google = rawCard.providers.google;
const anthropic = rawCard.providers.anthropic;

type Tier = {
  maxContextTokens: number | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheStoragePerHour?: number;
};

function soleTier(provider: { models: Record<string, { tiers: Tier[] }> }, model: string): Tier {
  const entry = provider.models[model];
  expect(entry).toBeDefined();
  expect(entry.tiers).toHaveLength(1);
  return entry.tiers[0];
}

describe('provider rate card currency (DEP-009)', () => {
  describe('gemini-3.6-flash', () => {
    it('is priced at the verified 1.50 / 7.50 rate', () => {
      const tier = soleTier(google, 'gemini-3.6-flash');

      expect(tier.maxContextTokens).toBeNull();
      expect(tier.input).toBe(1.5);
      expect(tier.output).toBe(7.5);
      expect(tier.cacheRead).toBe(0.15);
      expect(tier.cacheStoragePerHour).toBe(1.0);
    });

    it('carries a grounding fee row, so grounded runs do not under-report', () => {
      expect(google.fees.grounding['gemini-3.6-flash']).toEqual({
        freeWindow: 'monthly',
        freeRequests: 5000,
        unit: 'USD per 1,000 search queries',
        perThousandUsd: 14,
      });
    });

    it('resolves pricing through the typed accessor (the fail-closed guard)', () => {
      expect(resolveGeminiPricing('gemini-3.6-flash')).toEqual({ input: 1.5, output: 7.5 });
    });
  });

  describe('gemini-3.5-flash-lite', () => {
    it('is priced at the verified 0.30 / 2.50 rate', () => {
      const tier = soleTier(google, 'gemini-3.5-flash-lite');

      expect(tier.maxContextTokens).toBeNull();
      expect(tier.input).toBe(0.3);
      expect(tier.output).toBe(2.5);
      expect(tier.cacheRead).toBe(0.03);
      expect(tier.cacheStoragePerHour).toBe(1.0);
    });

    it('carries a grounding fee row', () => {
      expect(google.fees.grounding['gemini-3.5-flash-lite']).toEqual({
        freeWindow: 'monthly',
        freeRequests: 5000,
        unit: 'USD per 1,000 search queries',
        perThousandUsd: 14,
      });
    });

    it('resolves pricing through the typed accessor', () => {
      expect(resolveGeminiPricing('gemini-3.5-flash-lite')).toEqual({ input: 0.3, output: 2.5 });
    });
  });

  describe('claude-opus-5', () => {
    it('is priced identically to claude-opus-4-8 (same tier, same tokenizer generation)', () => {
      const tier = soleTier(anthropic, 'claude-opus-5');

      expect(tier).toEqual(soleTier(anthropic, 'claude-opus-4-8'));
      expect(tier.input).toBe(5.0);
      expect(tier.output).toBe(25.0);
    });
  });

  describe('models verified as still current — do NOT retire', () => {
    // The 2026-07-29 review proposed retiring gemini-3-flash-preview as
    // delisted. Re-checked against Google's pricing and deprecation pages on
    // 2026-07-30: it is still listed at 0.50/3.00 with NO announced shutdown
    // date. Removing its row would fail-close cost reporting for a model the
    // provider still serves.
    it('keeps gemini-3-flash-preview priced and resolvable', () => {
      const tier = soleTier(google, 'gemini-3-flash-preview');

      expect(tier.input).toBe(0.5);
      expect(tier.output).toBe(3.0);
      expect(resolveGeminiPricing('gemini-3-flash-preview')).toBeDefined();
    });

    // Both shut down 2026-10-16 — still served today, so still priced.
    it('keeps both gemini-2.5 models priced until their announced shutdown', () => {
      expect(resolveGeminiPricing('gemini-2.5-flash')).toBeDefined();
      expect(resolveGeminiPricing('gemini-2.5-pro')).toBeDefined();
    });
  });

  describe('fail-closed contract', () => {
    it('returns undefined for a model with no rate-card row', () => {
      expect(resolveGeminiPricing('gemini-9.9-imaginary')).toBeUndefined();
    });

    it('prices every Gemini model the card lists', () => {
      for (const model of Object.keys(google.models)) {
        expect(resolveGeminiPricing(model)).toBeDefined();
      }
    });

    it('gives every Gemini model with a grounding fee row a pricing row too', () => {
      const pricedModels = new Set(Object.keys(google.models));

      for (const model of Object.keys(google.fees.grounding)) {
        expect(pricedModels.has(model)).toBe(true);
      }
    });
  });

  it('records the date its rates were verified without re-dating when they took effect', () => {
    // `version` and `sourceDate` say WHEN THIS CARD WAS AUTHORED/VERIFIED.
    // `effectiveDate` says WHEN ITS RATES TOOK EFFECT, and pricing refuses any
    // response that occurred before it (`asOf < card.effectiveDate` →
    // unavailable). This revision only ADDED models; every pre-existing rate is
    // unchanged and has applied since 2026-07-22, so moving `effectiveDate`
    // forward would falsely un-price every receipt in the intervening window.
    expect(rawCard.version).toBe('2026-07-30');
    expect(google.sourceDate).toBe('2026-07-30');
    expect(anthropic.sourceDate).toBe('2026-07-30');
    expect(rawCard.effectiveDate).toBe('2026-07-22');
  });
});
