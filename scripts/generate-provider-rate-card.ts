#!/usr/bin/env npx tsx
/**
 * @file scripts/generate-provider-rate-card.ts
 * @description Deterministic generator for the agent package's
 * provider rate-card adapter.
 *
 * The agent package (`agent/`) is an isolated build that runs inside a Docker
 * sandbox and cannot import from the root `src/` tree. So instead of
 * hand-transcribing prices into `agent/src/` (the exact drift this lane
 * exists to kill), we GENERATE a self-contained adapter from the ONE authored
 * source of truth, `config/provider-rate-card.json`, and commit it.
 *
 * The generated file embeds the Anthropic per-model base-tier rates the agent
 * accounting needs, plus a fail-closed `resolveAnthropicRate` primitive. It is
 * byte-deterministic given the config, so a drift test can assert the committed
 * file equals a fresh render — if someone edits the config and forgets to
 * regenerate, the test fails.
 *
 * Usage:
 *   npx tsx scripts/generate-provider-rate-card.ts          # write the adapter
 *   npx tsx scripts/generate-provider-rate-card.ts --check  # fail if it drifted
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { assertValidRateCard, type ProviderRateCard as KernelRateCard } from '@/lib/ai/rate-card';

const REPO_ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'provider-rate-card.json');
export const ADAPTER_PATH = path.join(REPO_ROOT, 'agent', 'src', 'provider-rate-card.generated.ts');

interface RateTier {
  maxContextTokens: number | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  validUntil?: string;
}
interface ProviderRateCard {
  version: string;
  effectiveDate: string;
  providers: {
    anthropic: {
      source: string;
      sourceDate: string;
      models: Record<string, { tiers: RateTier[] }>;
    };
  };
}

const ANTHROPIC_ADAPTER_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

function basePricedTier(model: string, tiers: RateTier[]): RateTier {
  const tier = tiers.find((t) => t.input !== undefined && t.output !== undefined);
  if (!tier) throw new Error(`Anthropic model "${model}" has no priced base tier in the rate card`);
  return tier;
}

/**
 * Render the agent adapter source from the parsed canonical card. Pure and
 * deterministic: same card in → identical string out. The generation-drift
 * test relies on this.
 */
export function renderProviderRateCardAdapter(card: ProviderRateCard): string {
  const anthropic = card.providers.anthropic;
  const entries = Object.entries(anthropic.models).map(([model, { tiers }]) => {
    const tier = basePricedTier(model, tiers);
    for (const field of ANTHROPIC_ADAPTER_FIELDS) {
      if (tier[field] === undefined) {
        throw new Error(`Anthropic model "${model}" base tier is missing a "${field}" rate the agent adapter requires`);
      }
    }
    return (
      `  '${model}': { input: ${tier.input}, output: ${tier.output}, cacheRead: ${tier.cacheRead}, ` +
      `cacheWrite5m: ${tier.cacheWrite5m}, cacheWrite1h: ${tier.cacheWrite1h} },`
    );
  });

  // Introductory-price validity windows, kept in a SEPARATE map so the rate
  // rows stay short/uniform (prettier-stable) and validUntil is still preserved.
  const validUntilEntries = Object.entries(anthropic.models)
    .map(([model, { tiers }]): [string, string] | null => {
      const validUntil = basePricedTier(model, tiers).validUntil;
      return validUntil ? [model, validUntil] : null;
    })
    .filter((e): e is [string, string] => e !== null)
    .map(([model, validUntil]) => `  '${model}': '${validUntil}',`);

  return `/**
 * @file provider-rate-card.generated.ts
 * @description GENERATED. DO NOT EDIT BY HAND.
 *
 * Deterministically generated from the ONE authored source of truth,
 * config/provider-rate-card.json, by scripts/generate-provider-rate-card.ts.
 * Regenerate with:  npm run generate:rate-card   (from the repo root)
 * A drift test fails if this file and the config disagree.
 *
 * The agent package cannot import from the root src/ tree (isolated Docker
 * build), so it consumes this generated copy of the Anthropic rate card rather
 * than a hand-transcribed table. Cache-write is the config's cache storage /
 * five-minute cache-creation price. Current Anthropic models serve their full
 * context window at standard pricing, so a single per-model rate suffices.
 */

/** Rate-card version this adapter was generated from (config .version). */
export const RATE_CARD_VERSION = '${card.version}' as const;

/** Card effective date (metadata). NOT a default as-of: a dated rate requires an
 * explicit caller-supplied as-of, never a silent pin to this date. */
export const RATE_CARD_EFFECTIVE_DATE = '${card.effectiveDate}' as const;

/** Provider price source recorded in the canonical card, for receipts/logs. */
export const RATE_CARD_SOURCE = '${anthropic.source}' as const;
export const RATE_CARD_SOURCE_DATE = '${anthropic.sourceDate}' as const;

export interface AnthropicTurnRate {
  /** Per-1M standard (non-cached) input tokens. */
  input: number;
  /** Per-1M generated output tokens (output already includes thinking). */
  output: number;
  /** Per-1M prompt-cache reads. */
  cacheRead: number;
  /** Per-1M five-minute cache-creation (write) tokens. */
  cacheWrite5m: number;
  /** Per-1M one-hour cache-creation (write) tokens. */
  cacheWrite1h: number;
}

/** Anthropic list pricing per model, per 1M tokens. */
export const ANTHROPIC_RATES: Readonly<Record<string, AnthropicTurnRate>> = Object.freeze({
${entries.join('\n')}
});

/** Models whose rate is an introductory price valid only through the given ISO
 * date; after it, resolveAnthropicRate returns undefined (fail closed). */
export const ANTHROPIC_RATE_VALID_UNTIL: Readonly<Record<string, string>> = Object.freeze({
${validUntilEntries.join('\n')}
});

/**
 * Resolve a model's rate: exact match, else the longest card id the model
 * starts with (so a dated alias like 'claude-haiku-4-5-20251001' resolves to
 * 'claude-haiku-4-5'). Returns undefined for a genuinely unknown model. For a
 * DATED rate (one in ANTHROPIC_RATE_VALID_UNTIL), an explicit \`asOf\` (the
 * operation/receipt timestamp) is REQUIRED: it is NOT defaulted to the card
 * date, so an introductory price cannot silently continue past its window —
 * omitting \`asOf\`, or an \`asOf\` past the window, returns undefined. Timeless
 * rates need no \`asOf\`. The caller decides whether to fail closed or apply a
 * documented estimate floor.
 */
export function resolveAnthropicRate(model: string, opts?: { asOf?: string }): AnthropicTurnRate | undefined {
  const requested = (model ?? '').trim();
  const exact = ANTHROPIC_RATES[requested];
  const prefixId = exact
    ? requested
    : Object.keys(ANTHROPIC_RATES)
        .filter((id) => requested === id || requested.startsWith(\`\${id}-\`))
        .sort((a, b) => b.length - a.length)[0];
  const rate = prefixId ? ANTHROPIC_RATES[prefixId] : undefined;
  if (!rate) return undefined;
  const validUntil = prefixId ? ANTHROPIC_RATE_VALID_UNTIL[prefixId] : undefined;
  if (validUntil && (!opts?.asOf || opts.asOf > validUntil)) return undefined; // dated: needs an in-window asOf
  return rate;
}
`;
}

/**
 * Parse AND validate a card file before rendering. The generated agent adapter
 * is protected by the SAME runtime validation as the root kernel — a malformed
 * card throws (failing generation and `--check`) instead of emitting a bad
 * adapter. Exported (with an injectable path) so the validation is testable
 * against a temporary fixture without touching the tracked config.
 */
export function loadCard(configPath: string = CONFIG_PATH): ProviderRateCard {
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  assertValidRateCard(parsed as KernelRateCard);
  return parsed as ProviderRateCard;
}

function main(): void {
  const check = process.argv.includes('--check');
  const rendered = renderProviderRateCardAdapter(loadCard());
  if (check) {
    let current = '';
    try {
      current = readFileSync(ADAPTER_PATH, 'utf8');
    } catch {
      current = '';
    }
    if (current !== rendered) {
      console.error(
        `provider-rate-card adapter is out of date.\n` +
          `Run \`npm run generate:rate-card\` after editing config/provider-rate-card.json.`
      );
      process.exit(1);
    }
    console.log('provider-rate-card adapter is in sync with the canonical card.');
    return;
  }
  writeFileSync(ADAPTER_PATH, rendered);
  console.log(`Wrote ${path.relative(REPO_ROOT, ADAPTER_PATH)} from ${path.relative(REPO_ROOT, CONFIG_PATH)}.`);
}

if (require.main === module) {
  main();
}
