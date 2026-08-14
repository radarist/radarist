/**
 * @file graph/interest-profile.ts
 * @description Per-user `InterestProfile` Neo4j node — the canonical learning
 * target for the discovery loop. Holds the user's vertical + topic interests and
 * a last-updated stamp.
 *
 * On first write it MERGEs a `User` node + a `PROFILE_FOR` edge (User nodes are
 * constrained but not otherwise populated elsewhere). `touchInterestProfile`
 * also ensures this subgraph so the approve path always materializes it, but it
 * never overwrites the user's curated vertical/topics.
 *
 * Part of the discovery + assessment loop, Phase P0 (write substrate). NB: no
 * selector reads these posteriors in P0 — the read-side bias defenses land in
 * P1a before the first reader comes online (BIAS-FIX-1).
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { normalizeTopicKey, TOPIC_SEPARATOR_CHARACTERS } from '@/lib/discovery/candidate-topic';

const log = createLogger('graph/interest-profile');

export interface InterestProfile {
  userId: string;
  vertical: string;
  topics: string[];
  updatedAt: string;
}

/** One bound for every InterestProfile writer and derived snapshot. */
export const MAX_INTEREST_PROFILE_TOPICS = 25;

export type SyntheticInterestProfileUserId = `system-${string}`;

function canonicalTopicsCypher(listExpression: string): string {
  const withoutTrailingSeparator = (expression: string) =>
    `CASE WHEN right(${expression}, 1) = '-' THEN left(${expression}, size(${expression}) - 1) ELSE ${expression} END`;
  const canonical = 'canonicalWithPossibleTrailingSeparator';
  const finalized = withoutTrailingSeparator(canonical);

  return `[${canonical} IN
    [rawTopic IN ${listExpression}
      WHERE rawTopic IS NOT NULL |
      reduce(normalized = '', character IN split(toLower(rawTopic), '') |
        CASE WHEN character IN $topicSeparators
          THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
          ELSE normalized + character
        END
      )
    ]
    WHERE ${finalized} <> '' |
    ${finalized}
  ]`;
}

/**
 * Canonicalize profile topics while preserving the caller's meaningful order.
 * The first occurrence wins, blanks are removed, and the shared profile cap is
 * applied after de-duplication.
 */
export function normalizeInterestProfileTopics(topics: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of topics) {
    const topic = normalizeTopicKey(value);
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    normalized.push(topic);
    if (normalized.length === MAX_INTEREST_PROFILE_TOPICS) break;
  }

  return normalized;
}

function assertHumanProfile(userId: string): void {
  if (userId.startsWith('system-')) {
    throw new Error('Synthetic InterestProfiles must use replaceSyntheticInterestProfileTopics');
  }
}

function assertSyntheticProfile(userId: string): asserts userId is SyntheticInterestProfileUserId {
  if (!userId.startsWith('system-')) {
    throw new Error('Replacing InterestProfile topics is restricted to synthetic system profiles');
  }
}

/**
 * Merge durable topics into a human InterestProfile. Existing membership wins
 * and normalized new topics append in caller order until the shared cap. The
 * read-modify-write expression executes as one Cypher statement, so a feedback
 * append committed before this write cannot be lost by a behavior refresh.
 */
export async function mergeInterestProfileTopics(
  userId: string,
  vertical: string,
  topics: string[],
  options: { preserveExistingVertical?: boolean } = {}
): Promise<void> {
  assertHumanProfile(userId);
  const normalizedTopics = normalizeInterestProfileTopics(topics);
  const updatedAt = new Date().toISOString();
  const cypher = `
    MERGE (ip:InterestProfile { userId: $userId })
    MERGE (u:User { id: $userId })
    MERGE (ip)-[:PROFILE_FOR]->(u)
    SET ip._topicsWriteLock = true
    WITH ip, ${canonicalTopicsCypher('coalesce(ip.topics, []) + $topics')} AS canonicalTopics
    WITH ip, reduce(
      merged = [],
      topic IN canonicalTopics |
        CASE WHEN topic IN merged THEN merged ELSE merged + topic END
    ) AS mergedTopics
    SET ip.vertical = CASE
          WHEN $preserveExistingVertical AND trim(coalesce(ip.vertical, '')) <> '' THEN ip.vertical
          ELSE $vertical
        END,
        ip.topics = mergedTopics[0..$maxTopics],
        ip.updatedAt = $updatedAt
    REMOVE ip._topicsWriteLock
  `;
  await runWriteTransaction(cypher, {
    userId,
    vertical,
    topics: normalizedTopics,
    topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
    maxTopics: MAX_INTEREST_PROFILE_TOPICS,
    preserveExistingVertical: options.preserveExistingVertical === true,
    updatedAt,
  });
  log.info('InterestProfile topics merged', { userId, vertical, topicCount: normalizedTopics.length });
}

/**
 * Replace a synthetic system profile with one complete aggregate snapshot.
 * Replacement is deliberately unavailable to human profiles so refresh jobs
 * cannot erase feedback-derived durable membership.
 */
export async function replaceSyntheticInterestProfileTopics(
  userId: SyntheticInterestProfileUserId,
  vertical: string,
  topics: string[]
): Promise<void> {
  assertSyntheticProfile(userId);
  const normalizedTopics = normalizeInterestProfileTopics(topics);
  const updatedAt = new Date().toISOString();
  const cypher = `
    MERGE (ip:InterestProfile { userId: $userId })
    MERGE (u:User { id: $userId })
    MERGE (ip)-[:PROFILE_FOR]->(u)
    SET ip.vertical = $vertical,
        ip.topics = $topics,
        ip.updatedAt = $updatedAt
  `;
  await runWriteTransaction(cypher, { userId, vertical, topics: normalizedTopics, updatedAt });
  log.info('Synthetic InterestProfile snapshot replaced', {
    userId,
    vertical,
    topicCount: normalizedTopics.length,
  });
}

/** Read the user's InterestProfile, or null when none exists. */
export async function getInterestProfile(userId: string): Promise<InterestProfile | null> {
  const cypher = `
    MATCH (ip:InterestProfile { userId: $userId })
    RETURN ip.userId AS userId, ip.vertical AS vertical, ip.topics AS topics, ip.updatedAt AS updatedAt
  `;
  const result = await runReadTransaction(cypher, { userId });
  const record = result.records[0];
  if (!record) return null;
  return {
    userId: (record.userId as string) ?? userId,
    vertical: (record.vertical as string) ?? '',
    topics: normalizeInterestProfileTopics((record.topics as string[]) ?? []),
    updatedAt: (record.updatedAt as string) ?? '',
  };
}

/**
 * Bump the profile's updatedAt without touching vertical/topics. Ensures the
 * InterestProfile/User/PROFILE_FOR subgraph exists (so the approve path always
 * materializes it) but never clobbers curated interests.
 */
export async function touchInterestProfile(userId: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const cypher = `
    MERGE (ip:InterestProfile { userId: $userId })
    MERGE (u:User { id: $userId })
    MERGE (ip)-[:PROFILE_FOR]->(u)
    SET ip.updatedAt = $updatedAt
  `;
  await runWriteTransaction(cypher, { userId, updatedAt });
  log.debug('InterestProfile touched', { userId });
}

/**
 * US-2 bridge (amends the 2026-06-26 discovery-loop decision bound — recorded
 * in `graph-learning.md`): appends `topic` to the user's `InterestProfile.topics`
 * if it isn't already tracked. Called ONLY from an up-vote (never a down-vote).
 * Membership is durable; the separate UserPreference ranking weight decays.
 *
 * Before this, the fetch-keyword candidate set was `InterestProfile.topics ∪
 * radarNames` (`getAggregateInterestKeywords`) — a liked NOVEL topic (one the
 * user has never explored or had seeded) never entered that set, so "similar
 * signals" for an untracked topic could never surface. `getAggregateInterestTopics`
 * reads ALL profiles' `topics` with no extra wiring needed — this append alone
 * makes the topic a fetch candidate on the next discovery cycle.
 *
 * MERGEs the InterestProfile/User/PROFILE_FOR subgraph first (mirrors
 * `touchInterestProfile`) so a first-ever topic add for a brand-new user still
 * materializes the profile rather than silently no-op-ing on a MATCH miss.
 *
 * Additive-only, append-if-absent, capped at
 * `MAX_INTEREST_PROFILE_TOPICS`: at the cap, the append is SKIPPED (logged)
 * rather than evicting the oldest entry — `topics` carries no timestamps, so
 * "oldest" is undefined and eviction could drop a curated topic.
 *
 * Returns `true` when the topic was newly appended; `false` when it was
 * already tracked or the cap blocked the append. Never throws internally —
 * `runWriteTransaction` failures propagate to the caller, which (in
 * `steerSignalInterest`) wraps this call in its own best-effort try/catch so a
 * bridge failure never breaks the posterior write that already landed.
 */
export async function addInterestTopic(userId: string, topic: string): Promise<boolean> {
  assertHumanProfile(userId);
  const normalizedTopic = normalizeInterestProfileTopics([topic])[0];
  if (!normalizedTopic) {
    log.debug('Blank InterestProfile topic ignored', { userId });
    return false;
  }
  const cypher = `
    MERGE (ip:InterestProfile { userId: $userId })
    MERGE (u:User { id: $userId })
    MERGE (ip)-[:PROFILE_FOR]->(u)
    SET ip._topicsWriteLock = true
    WITH ip, ${canonicalTopicsCypher('coalesce(ip.topics, [])')} AS canonicalTopics
    WITH ip, reduce(
      priorTopics = [],
      topic IN canonicalTopics |
        CASE WHEN topic IN priorTopics THEN priorTopics ELSE priorTopics + topic END
    ) AS canonicalPriorTopics
    WITH ip, canonicalPriorTopics[0..$maxTopics] AS priorTopics
    SET ip.topics = CASE
          WHEN $topic IN priorTopics THEN priorTopics
          WHEN size(priorTopics) >= $maxTopics THEN priorTopics
          ELSE priorTopics + $topic
        END
    REMOVE ip._topicsWriteLock
    RETURN ($topic IN priorTopics) AS alreadyPresent, (size(priorTopics) >= $maxTopics) AS atCap
  `;
  const result = await runWriteTransaction<{ alreadyPresent: boolean; atCap: boolean }>(cypher, {
    userId,
    topic: normalizedTopic,
    topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
    maxTopics: MAX_INTEREST_PROFILE_TOPICS,
  });
  const record = result.records[0];
  const alreadyPresent = Boolean(record?.alreadyPresent);
  const atCap = Boolean(record?.atCap);

  if (alreadyPresent) {
    log.debug('InterestProfile topic already tracked (no-op)', { userId, topic: normalizedTopic });
    return false;
  }
  if (atCap) {
    log.warn('InterestProfile topics at cap — skip-append (no eviction)', {
      userId,
      topic: normalizedTopic,
      cap: MAX_INTEREST_PROFILE_TOPICS,
    });
    return false;
  }

  log.info('InterestProfile topic appended', { userId, topic: normalizedTopic });
  return true;
}
