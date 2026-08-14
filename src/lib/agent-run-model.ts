/**
 * @file agent-run-model.ts
 * @description ARUN-003: primary-model semantics for agent runs. Pure module
 * (no Firebase imports) so the Inngest handler, services, and tests can share
 * the one rule without module-mock collisions.
 *
 * The primary model of a run that reported a per-model usage breakdown but no
 * top-level model is the one that produced the most OUTPUT tokens — the work
 * model — not whichever entry happens to iterate first. Returns undefined for
 * an empty/missing breakdown: callers omit the field rather than inventing a
 * model (the old hardcoded Sonnet fallback misattributed real spend).
 */

export function primaryModelFromUsage(
  modelUsage?: Record<string, { outputTokens: number }>
): string | undefined {
  if (!modelUsage) return undefined;
  let best: string | undefined;
  let bestOutput = -1;
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (usage.outputTokens > bestOutput) {
      best = model;
      bestOutput = usage.outputTokens;
    }
  }
  return best;
}
