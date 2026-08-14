/**
 * @file discovery/derive-interest.ts
 * @description Derive the user's interest from what they ACTUALLY explored.
 *
 * Turns the tags of a user's `Session-[:EXPLORED]` entities into kebab topics, upserts
 * them onto the InterestProfile, and seeds matching UserPreference weights — all on the
 * SAME tag key-space the selector ranks candidates on (see candidate-topic.ts). This is
 * what makes the scout run on the user's real footprint instead of the hardcoded
 * cold-start prior, and (together with A1's feedback unification) closes the loop.
 *
 * Idempotent. THROWS on a backing-store failure (surface, never mask) — callers (scout
 * route, cron, the AI tool) wrap it best-effort so a derive failure degrades to the
 * cold-start prior rather than blocking a scout. Server-only.
 */
import 'server-only';
import { getExploredEntityTags } from '@/lib/graph/session-memory';
import { MAX_INTEREST_PROFILE_TOPICS, mergeInterestProfileTopics } from '@/lib/graph/interest-profile';
import { seedPreferenceWeight } from '@/lib/graph/preferences';
import { createLogger } from '@/lib/logger';
import { meaningfulTags } from './candidate-topic';
import { getDiscoveryConfig } from './discovery-config';

const log = createLogger('discovery/derive-interest');

export interface DeriveInterestResult {
  topics: string[];
  seeded: number;
}

/**
 * Build the user's interest topics from their exploration and persist them
 * (InterestProfile + UserPreference seed weights). Returns the ranked topics, or an
 * empty result when there is no usable exploration yet (cold-start prior still covers).
 */
export async function deriveInterestFromBehavior(userId: string): Promise<DeriveInterestResult> {
  const explored = await getExploredEntityTags(userId);

  // Entity-frequency per topic: how many DISTINCT explored entities carried each tag.
  const countByTopic = new Map<string, number>();
  const seenEntities = new Set<string>();
  for (const { entityId, tags } of explored) {
    if (seenEntities.has(entityId)) continue; // same entity across sessions counts once
    seenEntities.add(entityId);
    for (const topic of new Set(meaningfulTags(tags))) {
      // Set() dedupes a topic within one entity
      countByTopic.set(topic, (countByTopic.get(topic) ?? 0) + 1);
    }
  }

  if (countByTopic.size === 0) {
    log.info('no usable exploration topics — leaving cold-start prior in place', { userId });
    return { topics: [], seeded: 0 };
  }

  const ranked = [...countByTopic.entries()]
    .sort(([topicA, countA], [topicB, countB]) => countB - countA || topicA.localeCompare(topicB))
    .slice(0, MAX_INTEREST_PROFILE_TOPICS);
  const topics = ranked.map(([topic]) => topic);

  const { vertical } = getDiscoveryConfig();
  await mergeInterestProfileTopics(userId, vertical, topics);
  let seeded = 0;
  for (const [topic, count] of ranked) {
    await seedPreferenceWeight(userId, topic, count);
    seeded += 1;
  }

  log.info('interest derived from behavior', { userId, topicCount: topics.length, seeded });
  return { topics, seeded };
}
