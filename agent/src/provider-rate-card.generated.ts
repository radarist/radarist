/**
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
export const RATE_CARD_VERSION = '2026-07-30' as const;

/** Card effective date (metadata). NOT a default as-of: a dated rate requires an
 * explicit caller-supplied as-of, never a silent pin to this date. */
export const RATE_CARD_EFFECTIVE_DATE = '2026-07-22' as const;

/** Provider price source recorded in the canonical card, for receipts/logs. */
export const RATE_CARD_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing' as const;
export const RATE_CARD_SOURCE_DATE = '2026-07-30' as const;

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
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
});

/** Models whose rate is an introductory price valid only through the given ISO
 * date; after it, resolveAnthropicRate returns undefined (fail closed). */
export const ANTHROPIC_RATE_VALID_UNTIL: Readonly<Record<string, string>> = Object.freeze({
  'claude-sonnet-5': '2026-08-31',
});

/**
 * Resolve a model's rate: exact match, else the longest card id the model
 * starts with (so a dated alias like 'claude-haiku-4-5-20251001' resolves to
 * 'claude-haiku-4-5'). Returns undefined for a genuinely unknown model. For a
 * DATED rate (one in ANTHROPIC_RATE_VALID_UNTIL), an explicit `asOf` (the
 * operation/receipt timestamp) is REQUIRED: it is NOT defaulted to the card
 * date, so an introductory price cannot silently continue past its window —
 * omitting `asOf`, or an `asOf` past the window, returns undefined. Timeless
 * rates need no `asOf`. The caller decides whether to fail closed or apply a
 * documented estimate floor.
 */
export function resolveAnthropicRate(model: string, opts?: { asOf?: string }): AnthropicTurnRate | undefined {
  const requested = (model ?? '').trim();
  const exact = ANTHROPIC_RATES[requested];
  const prefixId = exact
    ? requested
    : Object.keys(ANTHROPIC_RATES)
        .filter((id) => requested === id || requested.startsWith(`${id}-`))
        .sort((a, b) => b.length - a.length)[0];
  const rate = prefixId ? ANTHROPIC_RATES[prefixId] : undefined;
  if (!rate) return undefined;
  const validUntil = prefixId ? ANTHROPIC_RATE_VALID_UNTIL[prefixId] : undefined;
  if (validUntil && (!opts?.asOf || opts.asOf > validUntil)) return undefined; // dated: needs an in-window asOf
  return rate;
}
