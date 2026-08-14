/**
 * @file graph/preferences.ts
 * @description User preference learning based on insight engagement.
 *
 * Tracks which insights users act on vs dismiss. Builds UserPreference
 * nodes in Neo4j with per-topic weights for personalized insight ranking.
 *
 * Weight formula: (acted_count - dismissed_count * 0.5) / total_count
 *
 * @phase Impulse v1.0 — Phase 4: Intelligence Layer
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { normalizeTopicKey, TOPIC_SEPARATOR_CHARACTERS } from '@/lib/discovery/candidate-topic';

const log = createLogger('graph/preferences');
const MAX_REPLAY_KEY_LENGTH = 2048;

export type PreferenceAction = 'acted' | 'dismissed';

interface PreferenceReplayOutcome {
  applied: boolean;
  payloadMatches: boolean;
}

// ============================================================================
// TYPES
// ============================================================================

export interface UserPreference {
  topic: string;
  weight: number;
  actedCount: number;
  dismissedCount: number;
  /**
   * Epoch ms of the row's last write (`up.lastUpdated`). Absent for rows that
   * never round-tripped through Neo4j (e.g. `cold-start.ts`'s synthetic broad
   * prior) — callers treat a missing value as "undecayed" (age 0).
   */
  lastUpdated?: number;
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Track user engagement with an insight.
 * Creates or updates a UserPreference node for the topic.
 */
export async function trackInsightEngagement(
  userId: string,
  insightId: string,
  action: PreferenceAction,
  topic: string
): Promise<void> {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) throw new Error('Preference topic must not be blank');
  const cypher = `
    MERGE (up:UserPreference { userId: $userId, topic: $topic })
    ON CREATE SET
      up.id = randomUUID(),
      up.acted_count = CASE WHEN $action = 'acted' THEN 1 ELSE 0 END,
      up.dismissed_count = CASE WHEN $action = 'dismissed' THEN 1 ELSE 0 END,
      up.lastUpdated = datetime()
    ON MATCH SET
      up.acted_count = coalesce(up.acted_count, 0) + CASE WHEN $action = 'acted' THEN 1 ELSE 0 END,
      up.dismissed_count = coalesce(up.dismissed_count, 0) + CASE WHEN $action = 'dismissed' THEN 1 ELSE 0 END,
      up.lastUpdated = datetime()
  `;

  await runWriteTransaction(cypher, { userId, topic: normalizedTopic, action, insightId });
  log.info('Insight engagement tracked', { userId, insightId, action, topic: normalizedTopic });
}

/**
 * Apply one replayable engagement exactly once.
 *
 * The receipt and counter update share one Neo4j transaction. Reusing a key
 * with the same immutable payload is a no-op; reusing it for different input
 * fails closed. The schema migration installs uniqueness constraints for both
 * the preference identity and receipt ID before this path is used.
 */
export async function trackInsightEngagementOnce(
  userId: string,
  insightId: string,
  action: PreferenceAction,
  topic: string,
  replayKey: string
): Promise<boolean> {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) throw new Error('Preference topic must not be blank');
  if (!userId.trim()) throw new Error('Preference userId must not be blank');
  if (!insightId.trim()) throw new Error('Preference insightId must not be blank');

  const normalizedReplayKey = replayKey.trim();
  if (!normalizedReplayKey) throw new Error('Preference replay key must not be blank');
  if (normalizedReplayKey.length > MAX_REPLAY_KEY_LENGTH) {
    throw new Error(`Preference replay key must not exceed ${MAX_REPLAY_KEY_LENGTH} characters`);
  }

  const result = await runWriteTransaction<PreferenceReplayOutcome>(
    `MERGE (receipt:PreferenceEngagementReceipt {id: $replayKey})
     ON CREATE SET
       receipt.userId = $userId,
       receipt.insightId = $insightId,
       receipt.action = $action,
       receipt.topic = $topic,
       receipt.applied = false,
       receipt.createdAt = datetime()
     WITH receipt,
          receipt.userId = $userId AND
          receipt.insightId = $insightId AND
          receipt.action = $action AND
          receipt.topic = $topic AS payloadMatches,
          coalesce(receipt.applied, false) AS alreadyApplied
     CALL {
       WITH receipt, payloadMatches, alreadyApplied
       WITH receipt WHERE payloadMatches AND NOT alreadyApplied
       MERGE (up:UserPreference {userId: $userId, topic: $topic})
       ON CREATE SET
         up.id = randomUUID(),
         up.acted_count = CASE WHEN $action = 'acted' THEN 1 ELSE 0 END,
         up.dismissed_count = CASE WHEN $action = 'dismissed' THEN 1 ELSE 0 END,
         up.lastUpdated = datetime()
       ON MATCH SET
         up.acted_count = coalesce(up.acted_count, 0) + CASE WHEN $action = 'acted' THEN 1 ELSE 0 END,
         up.dismissed_count = coalesce(up.dismissed_count, 0) + CASE WHEN $action = 'dismissed' THEN 1 ELSE 0 END,
         up.lastUpdated = datetime()
       SET receipt.applied = true,
           receipt.appliedAt = datetime(),
           receipt.preferenceId = up.id
       RETURN true AS applied
       UNION
       WITH receipt, payloadMatches, alreadyApplied
       WITH receipt WHERE NOT payloadMatches OR alreadyApplied
       RETURN false AS applied
     }
     RETURN applied, payloadMatches`,
    {
      userId,
      insightId,
      action,
      topic: normalizedTopic,
      replayKey: normalizedReplayKey,
    }
  );

  const outcome = result.records[0];
  if (!outcome) throw new Error('Preference replay did not return an atomic outcome');
  if (!outcome.payloadMatches) {
    throw new Error('Preference replay key is already bound to a different engagement payload');
  }

  log.info('Replayable insight engagement processed', {
    userId,
    insightId,
    action,
    topic: normalizedTopic,
    applied: outcome.applied,
  });
  return outcome.applied;
}

/**
 * Atomically move one previously-recorded engagement from one semantic action
 * to the other. Both counters are updated by one Cypher statement inside one
 * managed Neo4j write transaction, so a rejected write cannot leave only the
 * prior decrement committed.
 *
 * The canonical row is created when an earlier best-effort feedback write never
 * landed, and canonical-equivalent legacy rows are consolidated before the
 * transition. A missing prior count is clamped at zero while the new action is
 * still recorded, matching the recovery behavior of the former decrement-then-
 * increment path without its partial-write window.
 */
export async function transitionInsightEngagement(
  userId: string,
  insightId: string,
  topic: string,
  priorAction: PreferenceAction,
  nextAction: PreferenceAction
): Promise<void> {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) throw new Error('Preference topic must not be blank');
  if (!userId.trim()) throw new Error('Preference userId must not be blank');
  if (!insightId.trim()) throw new Error('Preference insightId must not be blank');
  if (priorAction === nextAction) {
    throw new Error('Preference transition actions must differ');
  }

  const cypher = `
    MERGE (target:UserPreference { userId: $userId, topic: $topic })
    ON CREATE SET
      target.id = randomUUID(),
      target.acted_count = 0,
      target.dismissed_count = 0,
      target.lastUpdated = datetime()
    SET target._preferenceWriteLock = true
    WITH target
    MATCH (up:UserPreference { userId: $userId })
    SET up._preferenceWriteLock = true
    REMOVE up._preferenceWriteLock
    WITH target, up,
      reduce(normalized = '', character IN split(toLower(up.topic), '') |
        CASE WHEN character IN $topicSeparators
          THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
          ELSE normalized + character
        END
      ) AS canonicalWithPossibleTrailingSeparator
    WITH target, up, CASE
      WHEN right(canonicalWithPossibleTrailingSeparator, 1) = '-'
        THEN left(canonicalWithPossibleTrailingSeparator, size(canonicalWithPossibleTrailingSeparator) - 1)
      ELSE canonicalWithPossibleTrailingSeparator
    END AS canonicalTopic
    WHERE canonicalTopic = $topic
    WITH target, collect(up) AS rows
    // The invalid datetime branch deliberately raises inside this statement, rolling back the
    // canonical MERGE and locks if a legacy counter cannot be represented as a non-negative integer.
    WITH target, rows, CASE
      WHEN all(row IN rows WHERE
        (row.acted_count IS NULL OR (
          toInteger(row.acted_count) IS NOT NULL AND
          toFloat(row.acted_count) = toFloat(toInteger(row.acted_count)) AND
          toInteger(row.acted_count) >= 0
        )) AND
        (row.dismissed_count IS NULL OR (
          toInteger(row.dismissed_count) IS NOT NULL AND
          toFloat(row.dismissed_count) = toFloat(toInteger(row.dismissed_count)) AND
          toInteger(row.dismissed_count) >= 0
        ))
      )
        THEN datetime()
      ELSE datetime('invalid-preference-counter')
    END AS transitionTimestamp
    WITH target, rows, transitionTimestamp,
      reduce(total = 0, row IN rows | total + coalesce(toInteger(row.acted_count), 0)) AS actedTotal,
      reduce(total = 0, row IN rows | total + coalesce(toInteger(row.dismissed_count), 0)) AS dismissedTotal
    SET target.topic = $topic,
        target.acted_count = CASE
          WHEN $priorAction = 'acted'
            THEN CASE WHEN actedTotal > 0 THEN actedTotal - 1 ELSE 0 END
          ELSE actedTotal + 1
        END,
        target.dismissed_count = CASE
          WHEN $priorAction = 'dismissed'
            THEN CASE WHEN dismissedTotal > 0 THEN dismissedTotal - 1 ELSE 0 END
          ELSE dismissedTotal + 1
        END,
        target.lastUpdated = transitionTimestamp
    WITH target, [row IN rows WHERE row <> target] AS duplicates
    FOREACH (duplicate IN duplicates | DETACH DELETE duplicate)
  `;

  await runWriteTransaction(cypher, {
    userId,
    topic: normalizedTopic,
    priorAction,
    nextAction,
    topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
  });
  log.info('Insight engagement transitioned', {
    userId,
    insightId,
    topic: normalizedTopic,
    priorAction,
    nextAction,
  });
}

/**
 * Adjust an existing UserPreference counter by ±1, clamped at zero.
 *
 * Used by Option A's like/unlike toggle (A.1): a true → false transition
 * decrements `acted_count`, the reverse increments it. Unlike
 * `trackInsightEngagement` (which only ever increments and always creates
 * the row), this helper assumes the preference row was created by an
 * earlier `trackInsightEngagement` call — so it `MATCH`es rather than
 * `MERGE`s. Canonical-equivalent legacy rows are consolidated before the
 * adjustment so a historical `RAG Pipelines` vote can be reversed through the
 * current `rag-pipelines` key. If no equivalent row exists, the adjustment is
 * a silent no-op: we never decrement a counter that was never incremented.
 *
 * Clamping rule: `max(0, count + delta)`. Prevents negative counters when
 * the unlike races a different code path that already cleared the row.
 */
export async function adjustInsightEngagement(
  userId: string,
  topic: string,
  field: 'acted_count' | 'dismissed_count',
  delta: 1 | -1
): Promise<void> {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) throw new Error('Preference topic must not be blank');
  // Cypher property names are interpolated only from the closed enum above —
  // safe against injection because the type narrows to two literal values.
  const otherField = field === 'acted_count' ? 'dismissed_count' : 'acted_count';
  const cypher = `
    MATCH (up:UserPreference { userId: $userId })
    SET up._preferenceWriteLock = true
    REMOVE up._preferenceWriteLock
    WITH up,
      reduce(normalized = '', character IN split(toLower(up.topic), '') |
        CASE WHEN character IN $topicSeparators
          THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
          ELSE normalized + character
        END
      ) AS canonicalWithPossibleTrailingSeparator
    WITH up, CASE
      WHEN right(canonicalWithPossibleTrailingSeparator, 1) = '-'
        THEN left(canonicalWithPossibleTrailingSeparator, size(canonicalWithPossibleTrailingSeparator) - 1)
      ELSE canonicalWithPossibleTrailingSeparator
    END AS canonicalTopic
    WHERE canonicalTopic = $topic
    WITH up ORDER BY elementId(up)
    WITH collect(up) AS rows
    WITH rows,
      coalesce(head([row IN rows WHERE row.topic = $topic]), head(rows)) AS target,
      reduce(total = 0, row IN rows | total + coalesce(row.${field}, 0)) AS selectedTotal,
      reduce(total = 0, row IN rows | total + coalesce(row.${otherField}, 0)) AS otherTotal
    WHERE target IS NOT NULL
    SET target.topic = $topic,
        target.${field} = CASE WHEN selectedTotal + $delta < 0 THEN 0 ELSE selectedTotal + $delta END,
        target.${otherField} = otherTotal,
        target.lastUpdated = datetime()
    WITH target, [row IN rows WHERE row <> target] AS duplicates
    FOREACH (duplicate IN duplicates | DETACH DELETE duplicate)
  `;

  await runWriteTransaction(cypher, {
    userId,
    topic: normalizedTopic,
    delta,
    topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
  });
  log.info('Insight engagement adjusted', { userId, topic: normalizedTopic, field, delta });
}

/**
 * Seed a baseline positive weight for a topic the user has shown interest in (e.g. via
 * exploration), WITHOUT clobbering earned feedback. ON CREATE establishes the baseline
 * acted_count; ON MATCH only bumps recency — a topic the user has already approved or
 * rejected keeps its real counts. Idempotent, so it is safe to call every derive cycle.
 *
 * Used by deriveInterestFromBehavior (A2) to put the user's real interests into the same
 * UserPreference store the selector ranks on.
 */
export async function seedPreferenceWeight(userId: string, topic: string, seedActedCount: number): Promise<void> {
  const normalizedTopic = normalizeTopicKey(topic);
  if (!normalizedTopic) throw new Error('Preference topic must not be blank');
  const seed = Math.max(1, Math.floor(seedActedCount));
  const cypher = `
    MERGE (up:UserPreference { userId: $userId, topic: $topic })
    ON CREATE SET
      up.id = randomUUID(),
      up.acted_count = $seed,
      up.dismissed_count = 0,
      up.seeded = true,
      up.lastUpdated = datetime()
    ON MATCH SET
      up.lastUpdated = datetime()
  `;

  await runWriteTransaction(cypher, { userId, topic: normalizedTopic, seed });
  log.info('UserPreference weight seeded', { userId, topic: normalizedTopic, seed });
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all preferences for a user, ordered by weight (highest first).
 */
export async function getUserPreferences(userId: string): Promise<UserPreference[]> {
  const cypher = `
    MATCH (up:UserPreference { userId: $userId })
    RETURN up.topic AS topic,
           up.acted_count AS actedCount,
           up.dismissed_count AS dismissedCount,
           up.lastUpdated AS lastUpdated
  `;

  const result = await runReadTransaction(cypher, { userId });
  const grouped = new Map<string, { actedCount: number; dismissedCount: number; lastUpdated?: number }>();
  const asCount = (value: unknown): number =>
    typeof value === 'object' && value !== null && 'low' in value
      ? Number((value as { low: number }).low)
      : Number(value ?? 0);

  for (const record of result.records) {
    if (typeof record.topic !== 'string') continue;
    const topic = normalizeTopicKey(record.topic);
    if (!topic) continue;
    // The Neo4j client (neo4j-client.ts's toNativeValue) already converts a
    // `datetime()` property to a native JS `Date` — unwrap to epoch ms here.
    // A missing/null property (row predates this field) yields `undefined`.
    const rawLastUpdated = record.lastUpdated;
    const lastUpdated =
      rawLastUpdated instanceof Date
        ? rawLastUpdated.getTime()
        : typeof rawLastUpdated === 'number'
          ? rawLastUpdated
          : undefined;
    const existing = grouped.get(topic);
    grouped.set(topic, {
      actedCount: (existing?.actedCount ?? 0) + asCount(record.actedCount),
      dismissedCount: (existing?.dismissedCount ?? 0) + asCount(record.dismissedCount),
      ...((existing?.lastUpdated !== undefined || lastUpdated !== undefined)
        ? { lastUpdated: Math.max(existing?.lastUpdated ?? 0, lastUpdated ?? 0) }
        : {}),
    });
  }

  return [...grouped.entries()]
    .map(([topic, preference]) => {
      const total = preference.actedCount + preference.dismissedCount;
      return {
        topic,
        weight: total === 0 ? 0 : (preference.actedCount - preference.dismissedCount * 0.5) / total,
        ...preference,
      };
    })
    .sort((left, right) => right.weight - left.weight || left.topic.localeCompare(right.topic));
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Hard-delete UserPreference rows whose `topic` is the raw action verb
 * (`'clicked'` / `'dismissed'`) instead of an entity type.
 *
 * Background: before Phase 0 step 0.1, `/api/graph/preference` passed the
 * action string as both action and topic. That left zombie rows like
 * `(:UserPreference { topic: 'clicked' })` cluttering the per-topic
 * preference weights. The source bug is fixed; this one-shot removes the
 * historical residue.
 *
 * Returns the number of rows deleted (per the Neo4j summary counter).
 *
 * Phase 0 step 0.9 of the briefing-pipeline cleanup plan (2026-05-13).
 */
/**
 * Delete UserPreference rows keyed on the OLD coarse `<entityType>:<proposalType>` scheme
 * (e.g. `technology:assessment`, `technology:relation`). A1 unified feedback onto the
 * entity's TAG topic, so these rows are now disjoint from the selector's read key-space —
 * dead weight the selector never consults. The faithful per-entity signal is rebuilt by
 * the migration replay (scripts/migrate-feedback-keyspace) and by deriveInterestFromBehavior.
 * One-shot cleanup; idempotent (a second run deletes nothing). Returns rows deleted.
 */
export async function cleanupCoarseFeedbackKeys(): Promise<number> {
  const PROPOSAL_TYPE_SUFFIXES = ['assessment', 'relation', 'entity', 'update'];
  try {
    const result = await runWriteTransaction(
      `MATCH (up:UserPreference)
       WHERE any(suffix IN $suffixes WHERE up.topic ENDS WITH ':' + suffix)
       DETACH DELETE up`,
      { suffixes: PROPOSAL_TYPE_SUFFIXES }
    );
    return result.summary.counters.nodesDeleted ?? 0;
  } catch (error) {
    log.error('Failed to clean coarse feedback keys', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export async function cleanupZombiePreferences(): Promise<number> {
  try {
    const result = await runWriteTransaction(
      `MATCH (up:UserPreference)
       WHERE up.topic IN ['clicked', 'dismissed']
       DETACH DELETE up`,
      {}
    );
    return result.summary.counters.nodesDeleted ?? 0;
  } catch (error) {
    log.error('Failed to clean zombie preferences', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
