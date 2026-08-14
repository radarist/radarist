/**
 * @file provider-rate-card.test.ts
 * @description TEST-021 — the generated agent adapter must stay faithful to the
 * ONE authored source of truth (config/provider-rate-card.json), and its
 * resolver must fail closed for a genuinely unknown model.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  ANTHROPIC_RATES,
  ANTHROPIC_RATE_VALID_UNTIL,
  RATE_CARD_SOURCE_DATE,
  RATE_CARD_VERSION,
  resolveAnthropicRate,
} from '../src/provider-rate-card.generated.js';

// Read the canonical config directly so this parity check does not depend on
// the generator — it independently proves the committed adapter matches source.
const configPath = fileURLToPath(new URL('../../config/provider-rate-card.json', import.meta.url));
const config = JSON.parse(readFileSync(configPath, 'utf8'));

function baseTier(id: string) {
  return config.providers.anthropic.models[id].tiers.find(
    (t: Record<string, number | null>) => t.input !== undefined && t.output !== undefined
  );
}

describe('provider-rate-card adapter parity (TEST-021)', () => {
  it('reports the version and source date from the canonical config', () => {
    expect(RATE_CARD_VERSION).toBe(config.version);
    expect(RATE_CARD_SOURCE_DATE).toBe(config.providers.anthropic.sourceDate);
  });

  it('embeds exactly the config Anthropic models', () => {
    expect(Object.keys(ANTHROPIC_RATES).sort()).toEqual(Object.keys(config.providers.anthropic.models).sort());
  });

  it('embeds the config base-tier rate for every model (input/output/cacheRead/cacheWrite5m/cacheWrite1h)', () => {
    for (const [id, rate] of Object.entries(ANTHROPIC_RATES)) {
      const tier = baseTier(id);
      expect(rate).toEqual({
        input: tier.input,
        output: tier.output,
        cacheRead: tier.cacheRead,
        cacheWrite5m: tier.cacheWrite5m,
        cacheWrite1h: tier.cacheWrite1h,
      });
    }
  });

  it('honors the in-effect Sonnet 5 introductory input/output price', () => {
    expect(ANTHROPIC_RATES['claude-sonnet-5']).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
  });
});

describe('generated adapter is self-validating (TEST-021)', () => {
  // Structural checks that need no config file, so they protect the generated
  // output even in an isolated agent build (Docker) where the repo root is absent.
  it('every embedded rate is a non-negative finite number', () => {
    for (const rate of Object.values(ANTHROPIC_RATES)) {
      for (const value of [rate.input, rate.output, rate.cacheRead, rate.cacheWrite5m, rate.cacheWrite1h]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('preserves Anthropic prompt-cache multipliers (cache-read 0.1x, 5m 1.25x, 1h 2x)', () => {
    for (const rate of Object.values(ANTHROPIC_RATES)) {
      expect(rate.cacheRead).toBeCloseTo(rate.input * 0.1, 10);
      expect(rate.cacheWrite5m).toBeCloseTo(rate.input * 1.25, 10);
      expect(rate.cacheWrite1h).toBeCloseTo(rate.input * 2, 10);
    }
  });
});

describe('resolveAnthropicRate (TEST-021)', () => {
  it('resolves an exact model id', () => {
    expect(resolveAnthropicRate('claude-opus-4-8')).toEqual(ANTHROPIC_RATES['claude-opus-4-8']);
  });

  it('resolves a dated alias by longest prefix', () => {
    expect(resolveAnthropicRate('claude-haiku-4-5-20251001')).toEqual(ANTHROPIC_RATES['claude-haiku-4-5']);
  });

  it('returns undefined for a genuinely unknown model (caller decides the floor)', () => {
    expect(resolveAnthropicRate('mystery-model')).toBeUndefined();
    expect(resolveAnthropicRate('')).toBeUndefined();
  });

  it('resolves a timeless model with no asOf', () => {
    expect(resolveAnthropicRate('claude-opus-4-8')).toEqual(ANTHROPIC_RATES['claude-opus-4-8']);
    expect(resolveAnthropicRate('claude-opus-4-8', { asOf: '2099-01-01' })).toEqual(ANTHROPIC_RATES['claude-opus-4-8']);
  });
});

describe('resolveAnthropicRate — dated-price freshness (TEST-021)', () => {
  it('carries Sonnet 5 as a dated introductory price', () => {
    expect(ANTHROPIC_RATE_VALID_UNTIL['claude-sonnet-5']).toBe('2026-08-31');
  });

  it('fails closed for a dated price when asOf is omitted (no silent pin to card date)', () => {
    expect(resolveAnthropicRate('claude-sonnet-5')).toBeUndefined();
  });

  it('resolves a dated price for an in-window asOf', () => {
    expect(resolveAnthropicRate('claude-sonnet-5', { asOf: '2026-08-15' })).toEqual(ANTHROPIC_RATES['claude-sonnet-5']);
  });

  it('fails closed for a dated price after its validUntil', () => {
    expect(resolveAnthropicRate('claude-sonnet-5', { asOf: '2026-09-01' })).toBeUndefined();
  });
});
