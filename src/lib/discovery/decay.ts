/**
 * @file discovery/decay.ts
 * @description The single decay-of-record for `UserPreference` posterior weights.
 *
 * Before this module, the same `UserPreference` posterior was decayed two
 * different ways: the fetch-keyword lane (`interest-keywords.ts`,
 * `getAggregateInterestKeywords`) applied this 30-day exponential decay inline,
 * while `getEffectivePreferences` (`cold-start.ts` — consumed by the discovery
 * selector and the briefing ranker) read the RAW, undecayed weight. One store,
 * two effective posteriors. Both lanes now import `applyRecencyDecay` +
 * `HALF_LIFE_DAYS` from here so a future change to the decay curve can't drift
 * between them again.
 *
 * Pure module — no side-effecting imports — safe to import anywhere.
 */

/** Recency half-life (days) applied to posterior interest weights. */
export const HALF_LIFE_DAYS = 30;

/**
 * Exponential recency decay of an interest weight toward neutral (0).
 * A disliked topic's negative weight decays back toward 0 over time — the
 * system forgets old feedback rather than permanently suppressing a topic.
 *   decayed = weight * 0.5 ^ (ageDays / halfLifeDays)
 */
export function applyRecencyDecay(weight: number, ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be > 0');
  }

  return weight * Math.pow(0.5, ageDays / halfLifeDays);
}
