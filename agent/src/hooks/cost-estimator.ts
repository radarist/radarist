/**
 * Mission cost estimation from cumulative token counts.
 *
 * Rates come from the ONE canonical provider rate card
 * (config/provider-rate-card.json) via the generated adapter
 * `../provider-rate-card.generated.ts` — this module no longer transcribes a
 * private price table. FAILS CLOSED: an unknown effective model, or a dated
 * (introductory) rate that has expired or lacks a receipt `asOf`, throws
 * AccountingUnavailableError rather than pricing at a different model's rate or
 * a silent zero. The estimate is never an `actual` settlement.
 */
import { AccountingUnavailableError } from '../accounting-errors.js';
import { resolveAnthropicRate } from '../provider-rate-card.generated.js';

/**
 * Estimate mission cost in USD from cumulative token counts. Resolves a model's
 * rate from the canonical card (exact, then dated-alias prefix). Pass `asOf`
 * (the mission's receipt timestamp, ISO date) to price a dated introductory
 * rate. Throws AccountingUnavailableError for an unknown model or an
 * expired/undated introductory rate — fail closed, never a wrong-model price.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  asOf?: string
): number {
  const p = resolveAnthropicRate(model, asOf ? { asOf } : undefined);
  if (!p) {
    throw new AccountingUnavailableError(
      `Cannot price mission for model "${model}"${asOf ? ` as of ${asOf}` : ''}: ` +
        `unknown effective model or expired/undated introductory rate.`,
      'anthropic-rate-unavailable'
    );
  }
  return (inputTokens * p.input + outputTokens * p.output + cacheReadTokens * p.cacheRead) / 1_000_000;
}
