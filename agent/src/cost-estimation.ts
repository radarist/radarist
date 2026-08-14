/**
 * @file cost-estimation.ts
 * @description MISSION-004: model- and cache-aware per-turn cost estimation.
 *
 * The abort/fallback paths cannot rely on the SDK's authoritative
 * `total_cost_usd` (never produced when the loop throws; undercounts on
 * budget aborts), so the orchestrator estimates from the usage stream. The
 * old estimator priced EVERY token at Sonnet list rates and ignored
 * cache-creation tokens entirely — an Opus-heavy mission's abort estimate
 * could be ~5× low. This module prices each turn by the model that actually
 * produced it (every assistant message carries `model`) and includes
 * cache-creation (write) tokens (`cacheWrite` = the SDK's five-minute
 * cache_creation_input_tokens).
 *
 * Rates come from the ONE canonical provider rate card
 * (config/provider-rate-card.json) via the generated adapter
 * `provider-rate-card.generated.ts` — this module no longer owns a private
 * price table. A model that matches the card exactly (or by dated-alias prefix)
 * is priced at its real card rate, so an in-effect promotional price (e.g.
 * Sonnet 5 through 2026-08-31, when an in-window `asOf` is supplied) is honored.
 * FAILS CLOSED: an unknown effective model, or a dated (introductory) rate that
 * has expired or lacks a receipt `asOf`, throws AccountingUnavailableError —
 * it is NEVER priced at a different model's rate or coerced to zero. Output is
 * inclusive of thinking (Anthropic output_tokens already includes it) and
 * cache-creation is priced explicitly at the five-minute rate. This estimate is
 * never an `actual` settlement — the SDK's authoritative billed amount wins.
 */

import { AccountingUnavailableError } from './accounting-errors.js';
import { resolveAnthropicRate } from './provider-rate-card.generated.js';

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Estimate one turn's cost in USD from its usage counters and the model that
 * produced it. `cacheWrite` is priced at the five-minute cache-creation rate.
 * Pass `asOf` (the turn's receipt timestamp, ISO date) to price a dated
 * introductory rate. Throws AccountingUnavailableError when the model is unknown
 * or a dated rate is expired/lacks an in-window `asOf` — fail closed, never a
 * wrong-model price or a silent zero.
 */
export function estimateTurnCostUsd(model: string | undefined, usage: TurnUsage, asOf?: string): number {
  const card = resolveAnthropicRate(model ?? '', asOf ? { asOf } : undefined);
  if (!card) {
    throw new AccountingUnavailableError(
      `Cannot price turn for model "${model ?? '(unknown)'}"${asOf ? ` as of ${asOf}` : ''}: ` +
        `unknown effective model or expired/undated introductory rate.`,
      'anthropic-rate-unavailable'
    );
  }
  return (
    (usage.input * card.input +
      usage.output * card.output +
      usage.cacheRead * card.cacheRead +
      usage.cacheWrite * card.cacheWrite5m) /
    1_000_000
  );
}
