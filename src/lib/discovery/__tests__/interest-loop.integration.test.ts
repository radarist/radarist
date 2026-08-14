/**
 * Interest Loop Wire-Proof Integration Test (Task 26, US-2/US-4)
 *
 * Proves the US-2 novel-topic bridge end to end on a REAL Neo4j instance: the
 * REAL `addInterestTopic` (graph/interest-profile.ts) + REAL `trackInsightEngagement`
 * (graph/preferences.ts) write, then the REAL `getAggregateInterestTopics` +
 * `getAggregateTopicWeights` (discovery/interest-keywords.ts) — UNMOCKED — read.
 * This is the same writer (`trackInsightEngagement`) and the same readers the
 * assessments/fetch-signals lane uses, so a pass here proves the write→read wire
 * genuinely closes: a liked novel topic becomes a fetch-keyword candidate with
 * the expected decayed weight, not just a mocked unit-level assertion.
 *
 * SKIPPED BY DEFAULT. To run against an isolated disposable clone:
 * ```bash
 * NEO4J_URI=bolt://127.0.0.1:17687 \
 * NEO4J_INTEGRATION_DISPOSABLE=true npm run test:integration:neo4j
 * ```
 * Run only against the disposable Neo4j target established by the integration lane.
 * When NEO4J_INTEGRATION_TESTS is set and Neo4j is unreachable, the suite FAILS
 * loudly (it does not silently pass) — see `beforeAll` below.
 *
 * ISOLATION RULE (adversarial R2 fix): `getAggregateInterestTopics` and
 * `getAggregateTopicWeights` read ACROSS ALL users with no userId/prefix filter —
 * they are aggregate-across-the-org by design (decision #11, single-tenant
 * learning). A realistic tag like `'vector-database'` could collide with rows
 * left by other suites/manual testing and corrupt the weight assertion. So the
 * asserted topic here is a per-run SYNTHETIC-UNIQUE string
 * (`int-test-topic-<runstamp>`) that no other test or user could plausibly have
 * written — candidate-PRESENCE is cap-proof regardless, but the weight EQUALITY
 * check only holds under this uniqueness guarantee.
 */
export {};

import {
  checkHealth,
  runWriteTransaction,
  runReadTransaction,
  closeDriver,
  getSession,
} from '@/lib/graph/neo4j-client';

const TEST_PREFIX = 'int-test-interest-loop-';
const RUN_STAMP = Date.now();
const TEST_USER_ID = `${TEST_PREFIX}user-${RUN_STAMP}`;
// Synthetic-unique per the isolation rule above — never a realistic tag.
const TEST_TOPIC = `int-test-topic-${RUN_STAMP}`;
const TEST_INSIGHT_ID = `${TEST_PREFIX}insight-${RUN_STAMP}`;
const TEST_DERIVED_TOPIC = `int-test-derived-${RUN_STAMP}`;
const TEST_REFRESH_TOPIC = `int-test-refresh-${RUN_STAMP}`;
const TEST_SYNTHETIC_USER_ID: `system-${string}` = `system-${TEST_PREFIX}${RUN_STAMP}`;

async function cleanupTestData(): Promise<void> {
  await runWriteTransaction(
    `MATCH (n)
     WHERE (n:InterestProfile OR n:UserPreference OR n:User)
       AND (n.userId STARTS WITH $prefix OR n.userId = $syntheticUserId)
     DETACH DELETE n`,
    { prefix: TEST_PREFIX, syntheticUserId: TEST_SYNTHETIC_USER_ID }
  );
  // User nodes are keyed on `id`, not `userId` — a separate pass catches those.
  await runWriteTransaction(
    `MATCH (u:User)
     WHERE u.id STARTS WITH $prefix OR u.id = $syntheticUserId
     DETACH DELETE u`,
    { prefix: TEST_PREFIX, syntheticUserId: TEST_SYNTHETIC_USER_ID }
  );

  const residue = await runReadTransaction<{ nodeCount: number; writeLockCount: number }>(
    `OPTIONAL MATCH (n)
     WHERE ((n:InterestProfile OR n:UserPreference) AND
              (n.userId STARTS WITH $prefix OR n.userId = $syntheticUserId))
        OR (n:User AND (n.id STARTS WITH $prefix OR n.id = $syntheticUserId))
     WITH collect(n) AS residue
     RETURN size(residue) AS nodeCount,
            size([node IN residue
                  WHERE node:InterestProfile AND node._topicsWriteLock IS NOT NULL]) AS writeLockCount`,
    { prefix: TEST_PREFIX, syntheticUserId: TEST_SYNTHETIC_USER_ID }
  );
  const counts = residue.records[0];
  if (!counts || counts.nodeCount !== 0 || counts.writeLockCount !== 0) {
    throw new Error(
      `[Integration Cleanup] Interest-loop fixture residue remains: nodes=${counts?.nodeCount ?? 'unknown'}, writeLocks=${counts?.writeLockCount ?? 'unknown'}`
    );
  }
}

// Gate the whole suite on an explicit opt-in env var so default runs report
// SKIPPED (not a false PASS). See the file header for the run instruction.
const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration(
  'Interest loop wire-proof: write (addInterestTopic + trackInsightEngagement) → read (aggregate keyword readers)',
  () => {
    beforeAll(async () => {
      // NEO4J_INTEGRATION_TESTS is set — Neo4j MUST be reachable. Fail loudly
      // instead of silently passing when it isn't.
      const health = await checkHealth();
      if (!health.healthy) {
        throw new Error(
          `[Integration Tests] NEO4J_INTEGRATION_TESTS is set but Neo4j is not healthy: ${
            health.error ?? 'unknown error'
          }. Start the disposable Neo4j integration target.`
        );
      }
    });

    beforeEach(async () => {
      await cleanupTestData();
    });

    afterEach(async () => {
      await cleanupTestData();
    });

    afterAll(async () => {
      await closeDriver();
    });

    it('a liked novel topic becomes a fetch-keyword candidate with the expected decayed weight', async () => {
      const { addInterestTopic } = await import('@/lib/graph/interest-profile');
      const { trackInsightEngagement } = await import('@/lib/graph/preferences');
      const { getAggregateInterestTopics, getAggregateTopicWeights, applyRecencyDecay, HALF_LIFE_DAYS } =
        await import('@/lib/discovery/interest-keywords');

      // --- WRITE: the real US-2 bridge — an up-vote on a novel (never-tracked) topic. ---
      const appended = await addInterestTopic(TEST_USER_ID, TEST_TOPIC);
      expect(appended).toBe(true);

      // --- WRITE: the real posterior — same writer the assessments/signals lane uses. ---
      await trackInsightEngagement(TEST_USER_ID, TEST_INSIGHT_ID, 'acted', TEST_TOPIC);

      // --- READ: the real, UNMOCKED aggregate readers `fetch-signals` consults. ---
      const topics = await getAggregateInterestTopics();
      expect(topics).toContain(TEST_TOPIC); // candidate-presence — cap-proof by construction

      const now = Date.now();
      const weights = await getAggregateTopicWeights(now);
      const row = weights.get(TEST_TOPIC);
      expect(row).toBeDefined();

      // A single 'acted' engagement with lastUpdated ~now: weight = (1 - 0*0.5) / 1 = 1,
      // decayed by ~0 age days (write just happened) — expect it to still read as
      // strongly positive. Because TEST_TOPIC is synthetic-unique, no other test/user
      // row can be aggregated into this key, so the equality-shaped assertion below
      // holds exactly (not just "some positive number").
      expect(row!.weight).toBeCloseTo(1, 5);
      expect(row!.ageDays).toBeLessThan(0.01); // just written, sub-second old

      const decayed = applyRecencyDecay(row!.weight, row!.ageDays, HALF_LIFE_DAYS);
      expect(decayed).toBeGreaterThan(0.9); // effectively undecayed at ~0 age
    });

    it('reverses a legacy raw-key vote without leaving a second canonical preference row', async () => {
      const { adjustInsightEngagement, trackInsightEngagement } = await import('@/lib/graph/preferences');
      const legacyUserId = `${TEST_PREFIX}legacy-vote-${RUN_STAMP}`;
      const rawTopic = `Legacy\u00a0RAG ${RUN_STAMP}`;
      const canonicalTopic = `legacy-rag-${RUN_STAMP}`;

      await runWriteTransaction(
        `CREATE (:UserPreference {
           id: randomUUID(), userId: $userId, topic: $rawTopic,
           acted_count: 1, dismissed_count: 0, lastUpdated: datetime()
         })`,
        { userId: legacyUserId, rawTopic }
      );

      await adjustInsightEngagement(legacyUserId, canonicalTopic, 'acted_count', -1);
      await trackInsightEngagement(legacyUserId, TEST_INSIGHT_ID, 'dismissed', canonicalTopic);

      const stored = await runReadTransaction<{ topic: string; acted: number; dismissed: number }>(
        `MATCH (up:UserPreference {userId: $userId})
         RETURN up.topic AS topic, up.acted_count AS acted, up.dismissed_count AS dismissed`,
        { userId: legacyUserId }
      );
      expect(stored.records).toEqual([{ topic: canonicalTopic, acted: 0, dismissed: 1 }]);
    });

    it('preserves human feedback across refreshes while synthetic replacement removes stale topics', async () => {
      const {
        addInterestTopic,
        getInterestProfile,
        mergeInterestProfileTopics,
        replaceSyntheticInterestProfileTopics,
      } = await import('@/lib/graph/interest-profile');

      await mergeInterestProfileTopics(TEST_USER_ID, 'ai-ml-infra', [TEST_DERIVED_TOPIC]);
      await addInterestTopic(TEST_USER_ID, TEST_TOPIC);

      // The old wholesale upsert lost TEST_TOPIC at this point.
      await mergeInterestProfileTopics(TEST_USER_ID, 'ai-ml-infra', [TEST_REFRESH_TOPIC]);
      expect((await getInterestProfile(TEST_USER_ID))?.topics).toEqual(
        expect.arrayContaining([TEST_DERIVED_TOPIC, TEST_TOPIC, TEST_REFRESH_TOPIC])
      );

      // Hold the profile's node lock while both public writers start. Without
      // their pre-read lock they can both capture the same stale list and then
      // overwrite each other after this transaction commits.
      const raceUserId = `${TEST_PREFIX}race-${RUN_STAMP}`;
      const appendedTopic = `append-${RUN_STAMP}`;
      const refreshedTopic = `refresh-${RUN_STAMP}`;
      await mergeInterestProfileTopics(raceUserId, 'ai-ml-infra', ['base-topic']);
      const lockSession = getSession('WRITE');
      const lockTransaction = lockSession.beginTransaction();
      try {
        await lockTransaction.run(
          `MATCH (ip:InterestProfile {userId: $userId})
           SET ip._testHeldLock = true
           REMOVE ip._testHeldLock`,
          { userId: raceUserId }
        );
        const writes = Promise.all([
          addInterestTopic(raceUserId, appendedTopic),
          mergeInterestProfileTopics(raceUserId, 'ai-ml-infra', [refreshedTopic]),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await lockTransaction.commit();
        const [appended] = await writes;
        expect(appended).toBe(true);
      } finally {
        if (lockTransaction.isOpen()) await lockTransaction.rollback();
        await lockSession.close();
      }
      expect((await getInterestProfile(raceUserId))?.topics).toEqual(
        expect.arrayContaining(['base-topic', appendedTopic, refreshedTopic])
      );

      const legacyUserId = `${TEST_PREFIX}legacy-${RUN_STAMP}`;
      await mergeInterestProfileTopics(legacyUserId, 'ai-ml-infra', ['seed-topic']);
      await runWriteTransaction(
        `MATCH (ip:InterestProfile {userId: $userId})
         SET ip.topics = ['-- Vector\u00a0DB --', '\u2003vector-db\u3000', '---', '\u202f', 'LLM\u2009Ops---']`,
        { userId: legacyUserId }
      );
      await addInterestTopic(legacyUserId, '\u1680New\u205fTopic\ufeff');
      const storedLegacy = await runReadTransaction<{ topics: string[] }>(
        `MATCH (ip:InterestProfile {userId: $userId}) RETURN ip.topics AS topics`,
        { userId: legacyUserId }
      );
      expect(storedLegacy.records[0]?.topics).toEqual(['vector-db', 'llm-ops', 'new-topic']);

      // Oversized legacy profiles are repaired deterministically by the next
      // writer: canonical first-seen order wins and storage is reduced to 25.
      const oversizedUserId = `${TEST_PREFIX}oversized-${RUN_STAMP}`;
      const oversizedTopicPrefix = `int-test-cap-${RUN_STAMP}-topic`;
      const expectedBoundedTopics = Array.from({ length: 25 }, (_, index) => `${oversizedTopicPrefix}-${index}`);
      await mergeInterestProfileTopics(oversizedUserId, 'ai-ml-infra', ['seed-topic']);
      await runWriteTransaction(
        `MATCH (ip:InterestProfile {userId: $userId}) SET ip.topics = $topics`,
        {
          userId: oversizedUserId,
          topics: Array.from({ length: 30 }, (_, index) => `-- ${oversizedTopicPrefix}\u00a0${index} --`),
        }
      );
      expect((await getInterestProfile(oversizedUserId))?.topics).toEqual(expectedBoundedTopics);
      const { getAggregateInterestTopics } = await import('@/lib/discovery/interest-keywords');
      const aggregateTopics = await getAggregateInterestTopics();
      expect(aggregateTopics).toEqual(expect.arrayContaining(expectedBoundedTopics));
      expect(aggregateTopics).not.toContain(`${oversizedTopicPrefix}-25`);

      await expect(addInterestTopic(oversizedUserId, 'overflow-topic')).resolves.toBe(false);
      const oversizedStored = await runReadTransaction<{ topics: string[] }>(
        `MATCH (ip:InterestProfile {userId: $userId}) RETURN ip.topics AS topics`,
        { userId: oversizedUserId }
      );
      expect(oversizedStored.records[0]?.topics).toEqual(expectedBoundedTopics);

      await replaceSyntheticInterestProfileTopics(TEST_SYNTHETIC_USER_ID, 'ai-ml-infra', [
        TEST_DERIVED_TOPIC,
        TEST_TOPIC,
      ]);
      await replaceSyntheticInterestProfileTopics(TEST_SYNTHETIC_USER_ID, 'ai-ml-infra', [TEST_REFRESH_TOPIC]);
      expect((await getInterestProfile(TEST_SYNTHETIC_USER_ID))?.topics).toEqual([TEST_REFRESH_TOPIC]);
    });
  }
);
