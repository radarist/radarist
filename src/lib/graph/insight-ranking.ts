/**
 * @file lib/graph/insight-ranking.ts
 * @description Pure, I/O-free re-ranking of matched observations by the
 * user's per-topic `UserPreference` posterior (US-5, Stage 3 task 14).
 *
 * Kept out of `proactive-insights.ts` (~1100 lines already) deliberately —
 * this module has no Neo4j/Firestore dependency and is exhaustively unit
 * tested in isolation; the caller wires it to live data.
 *
 * **Scoring (decision of record):**
 *  - No topic resolved for the observation's entity, or no `UserPreference`
 *    row for that topic → multiplier `1` (neutral — never penalise absence
 *    of signal).
 *  - SUPPRESS (multiplier = `floorMultiplier`, default `0.5`) ONLY when
 *    `pref.dismissedCount >= pref.actedCount + dismissMargin` AND the
 *    observation's `type` is not in `exemptTypes`. The floor is NEVER 0:
 *    anti-bias — a topic the user keeps dismissing is down-ranked, never
 *    made invisible, so a genuinely important update still surfaces.
 *  - Otherwise BOOST when `pref.weight > 0`: multiplier =
 *    `1 + min(1, weight) * boostFactor` (weight is clamped to 1 so a
 *    stale/ungoverned posterior can't runaway-boost past 1.5x at the
 *    defaults).
 *  - `score = observation.confidence * multiplier`.
 *  - Sort by score descending, STABLE (ties keep original input order —
 *    achieved by decorating each entry with its input index and using it
 *    as the sort tie-breaker rather than relying on engine sort stability).
 *  - `slice(0, cap)`.
 *
 * **`'update'` exemption — enum drift, real and intentional.** The
 * `RankableObservation.type` field is typed as a bare `string` (not the
 * narrower `AgentObservation['observationType']` union) because
 * `observeWatchedEntityUpdates` (proactive-insights.ts) writes
 * `observationType: 'update'` via raw Cypher — a value the TS union has
 * never included. `'update'` insights are the interest-watch lane: a
 * user's explicit "watch this entity" signal should keep surfacing even if
 * they've dismissed unrelated insights about the same topic, so it is
 * exempt from the suppression floor by default.
 */

import type { UserPreference } from './preferences';

/** Minimal shape this module needs from an observation/insight candidate. */
export interface RankableObservation {
  confidence: number;
  entityId: string;
  /**
   * Deliberately a bare `string`, not a narrower union — see the
   * `'update'` enum-drift note in the file docstring.
   */
  type: string;
}

export interface RankOptions {
  /** Maximum number of observations to return (`slice(0, cap)`). */
  cap: number;
  /** Boost strength applied to positive-weight topics. Default `0.5`. */
  boostFactor?: number;
  /** Multiplier applied to suppressed (heavily-dismissed) topics. Default `0.5`. Never 0. */
  floorMultiplier?: number;
  /** `dismissedCount - actedCount` margin required before suppression kicks in. Default `2`. */
  dismissMargin?: number;
  /** Observation types exempt from suppression. Default `['update']`. */
  exemptTypes?: readonly string[];
}

const DEFAULT_BOOST_FACTOR = 0.5;
const DEFAULT_FLOOR_MULTIPLIER = 0.5;
const DEFAULT_DISMISS_MARGIN = 2;
const DEFAULT_EXEMPT_TYPES: readonly string[] = ['update'];

/** Resolve the multiplier for a single observation given its resolved preference (if any). */
function computeMultiplier(
  type: string,
  pref: UserPreference | undefined,
  opts: Required<Omit<RankOptions, 'cap'>>
): number {
  if (!pref) return 1;

  const isExempt = opts.exemptTypes.includes(type);
  const isSuppressed = !isExempt && pref.dismissedCount >= pref.actedCount + opts.dismissMargin;
  if (isSuppressed) return opts.floorMultiplier;

  if (pref.weight > 0) return 1 + Math.min(1, pref.weight) * opts.boostFactor;

  return 1;
}

/**
 * Re-rank observations by the user's per-topic preference posterior, then
 * cap the result. Pure — no I/O; callers resolve `preferences` and
 * `topicByEntityId` from live data before calling this.
 */
export function rankObservationsByPreference<T extends RankableObservation>(
  observations: readonly T[],
  preferences: readonly UserPreference[],
  topicByEntityId: ReadonlyMap<string, string>,
  options: RankOptions
): T[] {
  const boostFactor = options.boostFactor ?? DEFAULT_BOOST_FACTOR;
  const floorMultiplier = options.floorMultiplier ?? DEFAULT_FLOOR_MULTIPLIER;
  const dismissMargin = options.dismissMargin ?? DEFAULT_DISMISS_MARGIN;
  const exemptTypes = options.exemptTypes ?? DEFAULT_EXEMPT_TYPES;

  const prefsByTopic = new Map(preferences.map((pref) => [pref.topic, pref] as const));

  const scored = observations.map((observation, index) => {
    const topic = topicByEntityId.get(observation.entityId);
    const pref = topic !== undefined ? prefsByTopic.get(topic) : undefined;
    const multiplier = computeMultiplier(observation.type, pref, {
      boostFactor,
      floorMultiplier,
      dismissMargin,
      exemptTypes,
    });
    return { observation, index, score: observation.confidence * multiplier };
  });

  // Stable sort: ties broken by original input index, not engine behaviour.
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));

  return scored.slice(0, options.cap).map((entry) => entry.observation);
}
