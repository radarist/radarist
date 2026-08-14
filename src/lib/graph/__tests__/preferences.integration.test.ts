/**
 * Guarded real-Neo4j proof for UserPreference identity and replay safety.
 *
 * Run only through `npm run test:integration:neo4j`; that runner rejects the
 * protected default Bolt port and requires an explicitly disposable target.
 */

import {
  checkHealth,
  closeDriver,
  runReadTransaction,
  runWriteTransaction,
} from '@/lib/graph/neo4j-client';
import { applyMigrationByName } from '../schema-migrations';
import {
  seedPreferenceWeight,
  trackInsightEngagement,
  trackInsightEngagementOnce,
  transitionInsightEngagement,
} from '../preferences';

const MIGRATION_NAME = '2026-07-12-user-preference-identity';
const TEST_PREFIX = `preference-identity-int-${Date.now()}-`;
const COMPOSITE_CONSTRAINT = `CREATE CONSTRAINT user_preference_user_topic IF NOT EXISTS
  FOR (up:UserPreference) REQUIRE (up.userId, up.topic) IS UNIQUE`;
const RECEIPT_CONSTRAINT = `CREATE CONSTRAINT preference_engagement_receipt_id IF NOT EXISTS
  FOR (receipt:PreferenceEngagementReceipt) REQUIRE receipt.id IS UNIQUE`;

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(
    `MATCH (receipt:PreferenceEngagementReceipt)
     WHERE receipt.id STARTS WITH $prefix
     DELETE receipt`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(
    `MATCH (up:UserPreference)
     WHERE up.userId STARTS WITH $prefix
     DELETE up`,
    { prefix: TEST_PREFIX }
  );
}

async function ensurePreferenceConstraints(): Promise<void> {
  await runWriteTransaction(COMPOSITE_CONSTRAINT, {});
  await runWriteTransaction(RECEIPT_CONSTRAINT, {});
}

describeIntegration('UserPreference identity (real Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(
        `[Integration Tests] NEO4J_INTEGRATION_TESTS is set but Neo4j is not healthy: ${
          health.error ?? 'unknown error'
        }. Start the disposable Neo4j integration target.`
      );
    }
    await cleanupFixtures();
  });

  afterEach(async () => {
    await cleanupFixtures();
    await ensurePreferenceConstraints();
  });

  afterAll(async () => {
    try {
      await cleanupFixtures();
      await ensurePreferenceConstraints();
    } finally {
      await closeDriver();
    }
  });

  it('consolidates exact legacy duplicates before installing the composite constraint', async () => {
    const userId = `${TEST_PREFIX}legacy-exact`;
    const canonicalTopic = `${TEST_PREFIX}rag-pipelines`;
    const rawTopic = `${TEST_PREFIX}RAG\u00a0Pipelines`;

    await runWriteTransaction('DROP CONSTRAINT user_preference_user_topic IF EXISTS', {});
    await runWriteTransaction(
      `CREATE (:UserPreference {
         id: $id1, userId: $userId, topic: $canonicalTopic,
         acted_count: 2, dismissed_count: 0, lastUpdated: datetime('2026-07-10T00:00:00Z')
       }),
       (:UserPreference {
         id: $id2, userId: $userId, topic: $canonicalTopic,
         acted_count: 3, dismissed_count: 1, seeded: true, lastUpdated: datetime('2026-07-11T00:00:00Z')
       }),
       (:UserPreference {
         id: $id3, userId: $userId, topic: $rawTopic,
         acted_count: 5, dismissed_count: 2, lastUpdated: datetime('2026-07-12T00:00:00Z')
       })`,
      {
        id1: `${TEST_PREFIX}legacy-1`,
        id2: `${TEST_PREFIX}legacy-2`,
        id3: `${TEST_PREFIX}legacy-3`,
        userId,
        canonicalTopic,
        rawTopic,
      }
    );

    await applyMigrationByName(MIGRATION_NAME, { force: true });

    const stored = await runReadTransaction<{
      topic: string;
      acted: number;
      dismissed: number;
      seeded: boolean;
      updatedAt: Date;
    }>(
      `MATCH (up:UserPreference {userId: $userId})
       RETURN up.topic AS topic, up.acted_count AS acted,
              up.dismissed_count AS dismissed, up.seeded AS seeded,
              up.lastUpdated AS updatedAt`,
      { userId }
    );
    expect(stored.records).toEqual([
      {
        topic: canonicalTopic.toLowerCase(),
        acted: 10,
        dismissed: 3,
        seeded: true,
        updatedAt: new Date('2026-07-12T00:00:00.000Z'),
      },
    ]);
  });

  it('deletes a raw variant before rename when the composite constraint already exists', async () => {
    const userId = `${TEST_PREFIX}early-constraint`;
    const canonicalTopic = `${TEST_PREFIX}edge-ai`;
    const rawTopic = `${TEST_PREFIX}Edge\u00a0AI`;
    await ensurePreferenceConstraints();
    await runWriteTransaction(
      `CREATE (:UserPreference {
         id: $canonicalId, userId: $userId, topic: $canonicalTopic,
         acted_count: 1, dismissed_count: 0
       }),
       (:UserPreference {
         id: $rawId, userId: $userId, topic: $rawTopic,
         acted_count: 2, dismissed_count: 1
       })`,
      {
        canonicalId: `${TEST_PREFIX}canonical`,
        rawId: `${TEST_PREFIX}raw`,
        userId,
        canonicalTopic,
        rawTopic,
      }
    );

    await applyMigrationByName(MIGRATION_NAME, { force: true });

    const stored = await runReadTransaction<{ topic: string; acted: number; dismissed: number }>(
      `MATCH (up:UserPreference {userId: $userId})
       RETURN up.topic AS topic, up.acted_count AS acted, up.dismissed_count AS dismissed`,
      { userId }
    );
    expect(stored.records).toEqual([{ topic: canonicalTopic, acted: 3, dismissed: 1 }]);
  });

  it('serializes concurrent track/seed writes and applies one replay receipt exactly once', async () => {
    const userId = `${TEST_PREFIX}concurrent`;
    const topic = `${TEST_PREFIX}Concurrent\u00a0Topic`;
    const canonicalTopic = `${TEST_PREFIX}concurrent-topic`;
    const replayKey = `${TEST_PREFIX}signal-feedback-backfill:signal-1`;
    await ensurePreferenceConstraints();

    await Promise.all([
      ...Array.from({ length: 20 }, (_, index) =>
        trackInsightEngagement(userId, `${TEST_PREFIX}insight-${index}`, 'acted', topic)
      ),
      ...Array.from({ length: 20 }, () => seedPreferenceWeight(userId, topic, 3)),
    ]);

    const beforeReplay = await runReadTransaction<{ rows: number; acted: number; dismissed: number }>(
      `MATCH (up:UserPreference {userId: $userId, topic: $topic})
       RETURN count(up) AS rows, sum(up.acted_count) AS acted, sum(up.dismissed_count) AS dismissed`,
      { userId, topic: canonicalTopic }
    );
    expect(beforeReplay.records[0]?.rows).toBe(1);
    expect([20, 23]).toContain(beforeReplay.records[0]?.acted);
    expect(beforeReplay.records[0]?.dismissed).toBe(0);

    const replayResults = await Promise.all(
      Array.from({ length: 20 }, () =>
        trackInsightEngagementOnce(userId, 'signal-1', 'dismissed', topic, replayKey)
      )
    );
    expect(replayResults.filter(Boolean)).toHaveLength(1);

    const afterReplay = await runReadTransaction<{
      rows: number;
      acted: number;
      dismissed: number;
      receipts: number;
    }>(
      `MATCH (up:UserPreference {userId: $userId, topic: $topic})
       OPTIONAL MATCH (receipt:PreferenceEngagementReceipt {id: $replayKey})
       RETURN count(DISTINCT up) AS rows, head(collect(DISTINCT up.acted_count)) AS acted,
              head(collect(DISTINCT up.dismissed_count)) AS dismissed,
              count(DISTINCT receipt) AS receipts`,
      { userId, topic: canonicalTopic, replayKey }
    );
    expect(afterReplay.records[0]).toEqual({
      rows: 1,
      acted: beforeReplay.records[0]?.acted,
      dismissed: 1,
      receipts: 1,
    });
  });

  it('serializes concurrent semantic transitions without losing either counter update', async () => {
    const userId = `${TEST_PREFIX}transition-concurrent`;
    const topic = `${TEST_PREFIX}Transition\u00a0Topic`;
    const canonicalTopic = `${TEST_PREFIX}transition-topic`;
    const transitions = 20;
    await ensurePreferenceConstraints();
    await runWriteTransaction(
      `CREATE (:UserPreference {
         id: $id, userId: $userId, topic: $topic,
         acted_count: $transitions, dismissed_count: 0
       })`,
      { id: `${TEST_PREFIX}transition-row`, userId, topic: canonicalTopic, transitions }
    );

    await Promise.all(
      Array.from({ length: transitions }, (_, index) =>
        transitionInsightEngagement(
          userId,
          `${TEST_PREFIX}transition-signal-${index}`,
          topic,
          'acted',
          'dismissed'
        )
      )
    );

    const stored = await runReadTransaction<{ rows: number; acted: number; dismissed: number }>(
      `MATCH (up:UserPreference {userId: $userId, topic: $topic})
       RETURN count(up) AS rows, sum(up.acted_count) AS acted,
              sum(up.dismissed_count) AS dismissed`,
      { userId, topic: canonicalTopic }
    );
    expect(stored.records).toEqual([{ rows: 1, acted: 0, dismissed: transitions }]);
  });

  it('rolls back the canonical MERGE when a corrupted legacy counter rejects the transition', async () => {
    const userId = `${TEST_PREFIX}transition-rollback`;
    const rawTopic = `${TEST_PREFIX}Rollback\u00a0Topic`;
    const canonicalTopic = `${TEST_PREFIX}rollback-topic`;
    await ensurePreferenceConstraints();
    await runWriteTransaction(
      `CREATE (:UserPreference {
         id: $id, userId: $userId, topic: $rawTopic,
         acted_count: 'corrupt', dismissed_count: 0
       })`,
      { id: `${TEST_PREFIX}corrupt-row`, userId, rawTopic }
    );

    await expect(
      transitionInsightEngagement(userId, `${TEST_PREFIX}rollback-signal`, rawTopic, 'acted', 'dismissed')
    ).rejects.toThrow();

    const stored = await runReadTransaction<{ topic: string; acted: unknown; dismissed: number }>(
      `MATCH (up:UserPreference {userId: $userId})
       RETURN up.topic AS topic, up.acted_count AS acted,
              up.dismissed_count AS dismissed
       ORDER BY up.topic`,
      { userId }
    );
    expect(stored.records).toEqual([{ topic: rawTopic, acted: 'corrupt', dismissed: 0 }]);
    expect(stored.records.some((record) => record.topic === canonicalTopic)).toBe(false);
  });
});
