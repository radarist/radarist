/**
 * @file discovery/cold-start.ts
 * @description Cold-start defenses so the selector is never starved before the
 * user has generated any behavioral signal. Provides a broad default prior and a
 * one-shot InterestProfile seeder (the deferred onboarding picker will call it).
 */
import 'server-only';
import { getUserPreferences, type UserPreference } from '@/lib/graph/preferences';
import {
  mergeInterestProfileTopics,
  replaceSyntheticInterestProfileTopics,
  type SyntheticInterestProfileUserId,
} from '@/lib/graph/interest-profile';
import { createLogger } from '@/lib/logger';
import { applyRecencyDecay, HALF_LIFE_DAYS } from './decay';
import { getDiscoveryConfig } from './discovery-config';

const MS_PER_DAY = 86_400_000;

const log = createLogger('discovery/cold-start');

/**
 * Broad default interests for the showcase.
 *
 * BIAS-MINOR (accepted + documented): these are AI/ML-flavored topics — a
 * single-domain showcase prior, NOT a general-purpose one. Deriving the prior from
 * the scouted radar's own quadrant labels is a hardening-track option, deliberately
 * not built; a hardcoded, documented bias is acceptable for the showcase. (NB: these
 * are topic WEIGHTS for ranking — candidate SCOPING is by radar, not by this prior.)
 */
export const DEFAULT_BROAD_TOPICS = [
  'vector-database',
  'llm-orchestration',
  'model-serving',
  'data-pipeline',
  'observability',
] as const;

function broadPrior(explorationRate: number): UserPreference[] {
  return DEFAULT_BROAD_TOPICS.map((topic) => ({
    topic,
    weight: explorationRate,
    actedCount: 0,
    dismissedCount: 0,
  }));
}

/**
 * The user's real preferences, or a low-confidence broad prior when they have
 * none yet. Fails toward broad: a read error returns the prior, never empty.
 *
 * Applies the SAME 30-day recency decay `getAggregateInterestKeywords` (the
 * fetch lane) applies, so the selector and the briefing ranker consume the
 * decayed posterior too — one decay-of-record for all readers of
 * `UserPreference` (DUP-5 unification). A row with no `lastUpdated` (the
 * synthetic broad-prior rows, or a legacy row that predates the field) is
 * treated as age-0 — undecayed.
 */
export async function getEffectivePreferences(userId: string): Promise<UserPreference[]> {
  const { explorationRate } = getDiscoveryConfig();
  try {
    const prefs = await getUserPreferences(userId);
    if (!prefs || prefs.length === 0) return broadPrior(explorationRate);

    const now = Date.now();
    return prefs.map((pref) => {
      if (pref.lastUpdated == null) return pref;
      const ageDays = Math.max(0, (now - pref.lastUpdated) / MS_PER_DAY);
      return { ...pref, weight: applyRecencyDecay(pref.weight, ageDays, HALF_LIFE_DAYS) };
    });
  } catch (error) {
    log.warn('getEffectivePreferences fell back to broad prior', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return broadPrior(explorationRate);
  }
}

/**
 * Seed a human InterestProfile by durable merge, or a reserved system profile
 * by exact synthetic replacement. Best-effort — a seed failure leaves the
 * caller covered by the broad prior, so it never throws.
 */
export async function seedInterestProfile(userId: string, topics?: string[]): Promise<void> {
  const { vertical } = getDiscoveryConfig();
  const seedTopics = topics ?? [...DEFAULT_BROAD_TOPICS];
  try {
    if (userId.startsWith('system-')) {
      await replaceSyntheticInterestProfileTopics(userId as SyntheticInterestProfileUserId, vertical, seedTopics);
    } else {
      await mergeInterestProfileTopics(userId, vertical, seedTopics);
    }
  } catch (error) {
    log.warn('seedInterestProfile failed (best-effort, ignored)', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
