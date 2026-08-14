/**
 * @file rate-card.generation.test.ts
 * @description TEST-021 — the generated agent adapter must not drift from the
 * one authored source of truth, and the root kernel, the config, and the agent
 * adapter must agree exactly (root/agent parity).
 *
 * @jest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { ANTHROPIC_RATES, ANTHROPIC_RATE_VALID_UNTIL } from '../../../../agent/src/provider-rate-card.generated';
import {
  ADAPTER_PATH,
  CONFIG_PATH,
  loadCard,
  renderProviderRateCardAdapter,
} from '../../../../scripts/generate-provider-rate-card';
import { ANTHROPIC_PRICING, MODEL_PRICING, RateCardValidationError, getProviderRateCard } from '../rate-card';

const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/** First tier of a model that carries both input and output rates. */
function baseTier(models: Record<string, { tiers: Array<Record<string, number | null>> }>, id: string) {
  return models[id].tiers.find((t) => t.input !== undefined && t.output !== undefined)!;
}

describe('generated adapter drift (TEST-021)', () => {
  it('the committed agent adapter equals a fresh render of the canonical config', () => {
    const rendered = renderProviderRateCardAdapter(rawConfig);
    const committed = readFileSync(ADAPTER_PATH, 'utf8');
    expect(committed).toBe(rendered);
  });
});

describe('generator validates rather than casts (TEST-021)', () => {
  it('loadCard accepts the real canonical config', () => {
    expect(() => loadCard(CONFIG_PATH)).not.toThrow();
  });

  it('loadCard rejects a malformed card (temp fixture — never mutates the tracked config)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rate-card-fixture-'));
    const badPath = path.join(dir, 'bad.json');
    // Structurally invalid: a negative rate. The generator must throw, not cast.
    const bad = JSON.parse(JSON.stringify(rawConfig));
    bad.providers.anthropic.models['claude-haiku-4-5'].tiers[0].input = -1;
    writeFileSync(badPath, JSON.stringify(bad));
    try {
      expect(() => loadCard(badPath)).toThrow(RateCardValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('root/agent parity (TEST-021)', () => {
  it('the kernel loads the same version the config declares', () => {
    expect(getProviderRateCard().version).toBe(rawConfig.version);
  });

  it('kernel Gemini pricing matches the config base tiers exactly', () => {
    for (const [id, rate] of Object.entries(MODEL_PRICING)) {
      const tier = baseTier(rawConfig.providers.google.models, id);
      expect(rate).toEqual({ input: tier.input, output: tier.output });
    }
  });

  it('kernel Anthropic pricing matches the config base tiers exactly (cacheCreation = 5m write)', () => {
    for (const [id, rate] of Object.entries(ANTHROPIC_PRICING)) {
      const tier = baseTier(rawConfig.providers.anthropic.models, id);
      expect(rate).toEqual({
        input: tier.input,
        output: tier.output,
        cacheRead: tier.cacheRead,
        cacheCreation: tier.cacheWrite5m,
      });
    }
  });

  it('the agent adapter rates equal the root kernel + config for every Anthropic model', () => {
    // Same model set on both sides.
    expect(Object.keys(ANTHROPIC_RATES).sort()).toEqual(Object.keys(ANTHROPIC_PRICING).sort());
    for (const [id, agentRate] of Object.entries(ANTHROPIC_RATES)) {
      const rootRate = ANTHROPIC_PRICING[id];
      const tier = baseTier(rawConfig.providers.anthropic.models, id);
      expect(agentRate.input).toBe(rootRate.input);
      expect(agentRate.output).toBe(rootRate.output);
      expect(agentRate.cacheRead).toBe(rootRate.cacheRead);
      // Root ANTHROPIC_PRICING carries only the 5m write (as cacheCreation);
      // the agent adapter carries both writes, checked against config.
      expect(agentRate.cacheWrite5m).toBe(rootRate.cacheCreation);
      expect(agentRate.cacheWrite5m).toBe(tier.cacheWrite5m);
      expect(agentRate.cacheWrite1h).toBe(tier.cacheWrite1h);
    }
  });

  it('the agent adapter preserves each dated tier validUntil from the config', () => {
    for (const [id, model] of Object.entries<{ tiers: Array<Record<string, unknown>> }>(
      rawConfig.providers.anthropic.models
    )) {
      const dated = model.tiers.find((t) => t.validUntil !== undefined);
      if (dated) {
        expect(ANTHROPIC_RATE_VALID_UNTIL[id]).toBe(dated.validUntil);
      } else {
        expect(ANTHROPIC_RATE_VALID_UNTIL[id]).toBeUndefined();
      }
    }
  });
});
