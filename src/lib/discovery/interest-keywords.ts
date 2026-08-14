/**
 * Interest keyword selection for the signal discovery loop.
 *
 * This module derives the keyword set used to steer signal fetching from a
 * user's accumulated interest weights (see `InterestProfile` in the graph
 * layer). It is server-only (Neo4j driver via `runReadTransaction`) but safe
 * to call from Inngest workers — the Inngest static-import trap is specific
 * to the Firebase *client* SDK, not the Neo4j client.
 *
 * `getAggregateInterestKeywords` combines the aggregate reads below (interest
 * topics, posterior weights, org-wide radar-placed technology names, and
 * radar placement counts) into a ranked fetch-keyword list for `fetch-signals`
 * (a later task).
 */

import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { normalizeInterestProfileTopics } from '@/lib/graph/interest-profile';
import { createLogger } from '@/lib/logger';

import { normalizeTopicKey, TAG_STOPWORDS } from './candidate-topic';
import { applyRecencyDecay, HALF_LIFE_DAYS } from './decay';
import { getDiscoveryConfig } from './discovery-config';
import { getAdjacentDiscoveryTopics } from './topic-adjacency';

const log = createLogger('discovery/interest-keywords');

/**
 * Re-exported for compat — `applyRecencyDecay` + `HALF_LIFE_DAYS` moved to
 * `./decay.ts` (the single decay-of-record for both this fetch lane and
 * `getEffectivePreferences`). Existing importers of this module keep working.
 */
export { applyRecencyDecay, HALF_LIFE_DAYS };
/** Fallback keyword set for cold start / total failure — never return an empty list. */
export const DEFAULT_KEYWORDS = ['technology', 'innovation', 'AI', 'startup'];
const KEYWORD_LIMIT_DEFAULT = 12;
/** Decayed weight below this is skipped THIS run (recovers next run via decay). */
const EXCLUDE_BELOW = -0.25;
/** Max adjacent-topic discovery keywords injected per run — a small, bounded budget. */
const DISCOVERY_SLOTS = 3;
/**
 * Union of every user's `InterestProfile.topics`, de-duplicated.
 * Read-only aggregate across all users — feeds the discovery-loop keyword
 * selection. Never throws: a Neo4j blip must not crash the cron sweep that
 * calls this; failures are logged and resolve to an empty list.
 */
export async function getAggregateInterestTopics(): Promise<string[]> {
  try {
    const result = await runReadTransaction(
      `MATCH (ip:InterestProfile)
       RETURN ip.userId AS userId, ip.topics AS topics
       ORDER BY userId`
    );

    const aggregate = new Set<string>();
    for (const record of result.records) {
      const storedTopics = Array.isArray(record.topics)
        ? record.topics.filter((topic): topic is string => typeof topic === 'string')
        : [];
      for (const topic of normalizeInterestProfileTopics(storedTopics)) aggregate.add(topic);
    }
    return [...aggregate];
  } catch (error) {
    log.error('getAggregateInterestTopics failed', error);
    return [];
  }
}

/** Per-topic posterior weight and recency, aggregated across all users. */
export interface AggregateTopicWeight {
  weight: number;
  ageDays: number;
}

/**
 * Aggregate `UserPreference` rows across all users per topic, summing
 * `acted_count`/`dismissed_count` and taking the most-recent `lastUpdated`
 * (max epoch millis) as the topic's engagement age. Never throws: on read
 * failure, returns an empty Map so the discovery-loop cron degrades to "no
 * signal" rather than crashing.
 */
export async function getAggregateTopicWeights(now: number): Promise<Map<string, AggregateTopicWeight>> {
  try {
    const result = await runReadTransaction(
      `MATCH (up:UserPreference)
       WITH up.topic AS topic,
            sum(toFloat(up.acted_count))     AS acted,
            sum(toFloat(up.dismissed_count)) AS dismissed,
            max(toFloat(up.lastUpdated.epochMillis)) AS lastMillis
       RETURN topic, acted, dismissed, lastMillis`
    );

    const grouped = new Map<string, { acted: number; dismissed: number; lastMillis: number | null }>();

    for (const record of result.records) {
      if (typeof record.topic !== 'string') continue;
      const topic = normalizeTopicKey(record.topic);
      if (!topic) continue;
      const acted = record.acted as number;
      const dismissed = record.dismissed as number;
      const lastMillis = record.lastMillis as number | null;
      const existing = grouped.get(topic);
      grouped.set(topic, {
        acted: (existing?.acted ?? 0) + acted,
        dismissed: (existing?.dismissed ?? 0) + dismissed,
        lastMillis:
          existing?.lastMillis == null
            ? lastMillis
            : lastMillis == null
              ? existing.lastMillis
              : Math.max(existing.lastMillis, lastMillis),
      });
    }

    const weights = new Map<string, AggregateTopicWeight>();
    for (const [topic, { acted, dismissed, lastMillis }] of grouped) {

      const total = acted + dismissed;
      const weight = total === 0 ? 0 : (acted - dismissed * 0.5) / total;
      const ageDays = lastMillis == null ? 0 : Math.max(0, (now - lastMillis) / 86_400_000);

      weights.set(topic, { weight, ageDays });
    }

    return weights;
  } catch (error) {
    log.error('getAggregateTopicWeights failed', error);
    return new Map();
  }
}

/**
 * Union of every org-wide `Technology` name that has at least one
 * `RadarPlacement`. Phase 1 scope is deliberately un-scoped by radar (no
 * `radarId` param) to match the aggregate philosophy of the other reads in
 * this module. Never throws: on read failure, returns an empty list.
 */
export async function getRadarTechnologyNames(): Promise<string[]> {
  try {
    const result = await runReadTransaction(
      `MATCH (:RadarPlacement)-[:PLACES]->(t:Technology)
       WHERE t.name IS NOT NULL AND trim(t.name) <> ''
       RETURN DISTINCT t.name AS name`
    );

    return result.records.map((record) => record.name as string);
  } catch (error) {
    log.error('getRadarTechnologyNames failed', error);
    return [];
  }
}

/**
 * Org-wide `Technology.name → COUNT(RadarPlacement)`. Used to tie-break equal-weight
 * fetch candidates so central (heavily-placed) techs rank above niche ones (F3).
 * Never throws: on read failure, returns an empty Map.
 */
export async function getRadarTechnologyPlacementCounts(): Promise<Map<string, number>> {
  try {
    const result = await runReadTransaction(
      `MATCH (:RadarPlacement)-[:PLACES]->(t:Technology)
       WHERE t.name IS NOT NULL AND trim(t.name) <> ''
       RETURN t.name AS name, count(*) AS placements`
    );

    const counts = new Map<string, number>();
    for (const record of result.records) {
      // neo4jRecordToObject already coerces Neo4j Integer → JS number; Number(...) is a safe no-op.
      counts.set(record.name as string, Number(record.placements));
    }
    return counts;
  } catch (error) {
    log.error('getRadarTechnologyPlacementCounts failed', error);
    return new Map();
  }
}

/** Result of ranking aggregate interest into a fetch-keyword plan. */
export interface AggregateInterestKeywords {
  keywords: string[];
  /** keyword → topic, ONLY for the injected discovery keywords; {} when the lane is off. */
  discoveryTopics: Record<string, string>;
}

/**
 * Ranks the union of aggregate interest topics and org-wide radar-placed
 * technology names into a bounded, ranked keyword list for signal fetching.
 * Candidates are decayed toward neutral by recency, excluded below
 * `EXCLUDE_BELOW`, sorted by decayed weight descending — ties broken by radar
 * placement count descending, then keyword ascending for determinism (F3) —
 * and truncated to `limit`. Falls back to `DEFAULT_KEYWORDS` on cold start (no candidates),
 * total exclusion (every candidate deeply negative), or any unexpected
 * failure — this feeds a cron and must never throw.
 *
 * When `discoveryConfig.feedbackEnabled` AND `.adjacentDiscoveryEnabled` are
 * both true (default OFF), reserves up to `DISCOVERY_SLOTS` of the `limit`
 * budget for posterior-gated adjacent-topic keywords from
 * `getAdjacentDiscoveryTopics` (novel topics, not muted by a strongly negative
 * posterior, not already selected). With the lane off, `discoveryTopics` is
 * `{}` and `keywords` is byte-identical to the pre-S12.2 output.
 */
export async function getAggregateInterestKeywords(opts: {
  limit?: number;
  maxSignals: number;
  now: number;
}): Promise<AggregateInterestKeywords> {
  const limit = Math.max(1, opts.limit ?? KEYWORD_LIMIT_DEFAULT);

  try {
    const [topics, weights, radarNames, placementCounts] = await Promise.all([
      getAggregateInterestTopics(),
      getAggregateTopicWeights(opts.now),
      getRadarTechnologyNames(),
      getRadarTechnologyPlacementCounts(),
    ]);

    // Ranking identity is always canonical, even when the display keyword comes
    // from a human-readable Technology name. Without this split, a negative
    // posterior for `rag-pipelines` could be bypassed by a neutral radar name
    // such as `RAG Pipelines`.
    const radarDisplayByTopic = new Map<string, string>();
    for (const rawName of [...radarNames].sort()) {
      const topic = normalizeTopicKey(rawName);
      if (topic && !radarDisplayByTopic.has(topic)) radarDisplayByTopic.set(topic, rawName.trim());
    }

    const canonicalPlacementCounts = new Map<string, number>();
    for (const [rawName, count] of placementCounts) {
      const topic = normalizeTopicKey(rawName);
      if (!topic) continue;
      canonicalPlacementCounts.set(topic, (canonicalPlacementCounts.get(topic) ?? 0) + count);
    }

    const candidateTopics = new Set<string>();
    for (const rawTopic of [...topics, ...radarNames]) {
      const topic = normalizeTopicKey(rawTopic);
      if (!topic || TAG_STOPWORDS.has(topic)) continue;
      candidateTopics.add(topic);
    }

    const candidates = [...candidateTopics].map((topic) => ({
      topic,
      keyword: radarDisplayByTopic.get(topic) ?? topic,
      ...(weights.get(topic) ?? { weight: 0, ageDays: 0 }),
    }));

    if (candidates.length === 0) {
      return { keywords: DEFAULT_KEYWORDS, discoveryTopics: {} };
    }

    const decayed = candidates.map(({ topic, keyword, weight, ageDays }) => ({
      topic,
      keyword,
      decayed: applyRecencyDecay(weight, ageDays, HALF_LIFE_DAYS),
    }));

    const surviving = decayed.filter((candidate) => candidate.decayed >= EXCLUDE_BELOW);

    if (surviving.length === 0) {
      return { keywords: DEFAULT_KEYWORDS, discoveryTopics: {} };
    }

    // Multi-key sort: (1) decayed weight desc, (2) radar placement count desc — so a
    // central (heavily-placed) tech outranks a niche one when both tie at weight 0 —
    // (3) keyword asc as the final deterministic tie-break (F3).
    surviving.sort((a, b) => {
      if (b.decayed !== a.decayed) return b.decayed - a.decayed;
      const pa = canonicalPlacementCounts.get(a.topic) ?? 0;
      const pb = canonicalPlacementCounts.get(b.topic) ?? 0;
      if (pb !== pa) return pb - pa;
      return a.keyword.localeCompare(b.keyword);
    });

    // Reinforcement keeps the bulk of the budget; a small slice is reserved for
    // the discovery lane below (computed first so its actual K, not the
    // DISCOVERY_SLOTS cap, determines how much reinforcement is displaced).
    const selectedTopics = new Set(surviving.map((candidate) => candidate.topic));
    const discoveryTopics: Record<string, string> = {};
    const discoveryConfig = getDiscoveryConfig();

    if (discoveryConfig.feedbackEnabled && discoveryConfig.adjacentDiscoveryEnabled) {
      const interestTopicSet = new Set(topics.map(normalizeTopicKey));
      const discoveryCandidates = await getAdjacentDiscoveryTopics({
        interestTopics: topics,
        trackedNames: radarNames,
      });
      // At most min(DISCOVERY_SLOTS, limit) discovery keywords — a small `limit` (unreachable in
      // prod; fetch-signals always uses the default) must not let discovery exceed the total budget.
      const discoveryBudget = Math.min(DISCOVERY_SLOTS, limit);

      for (const candidate of discoveryCandidates) {
        if (Object.keys(discoveryTopics).length >= discoveryBudget) break;
        if (interestTopicSet.has(normalizeTopicKey(candidate.topic))) continue; // novelty
        const keywordTopic = normalizeTopicKey(candidate.keyword);
        if (!keywordTopic || selectedTopics.has(keywordTopic)) continue; // already fetched
        // Posterior gate on the TOPIC (posterior key-space), same decay as reinforcement.
        const topicWeight = weights.get(normalizeTopicKey(candidate.topic)) ?? { weight: 0, ageDays: 0 };
        if (applyRecencyDecay(topicWeight.weight, topicWeight.ageDays, HALF_LIFE_DAYS) < EXCLUDE_BELOW) continue; // muted
        discoveryTopics[candidate.keyword] = candidate.topic;
        selectedTopics.add(keywordTopic);
      }
    }

    const discoveryKeywords = Object.keys(discoveryTopics);
    const reinforcement = surviving.slice(0, Math.max(0, limit - discoveryKeywords.length));

    return {
      keywords: [...reinforcement.map((candidate) => candidate.keyword), ...discoveryKeywords],
      discoveryTopics,
    };
  } catch (error) {
    log.error('getAggregateInterestKeywords failed', error);
    return { keywords: DEFAULT_KEYWORDS, discoveryTopics: {} };
  }
}
