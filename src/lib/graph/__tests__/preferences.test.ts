/**
 * @jest-environment node
 */

export {};

const mockRunWriteTransaction = jest.fn();
const mockRunReadTransaction = jest.fn();

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: (...args: unknown[]) => mockRunWriteTransaction(...args),
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const {
  trackInsightEngagement,
  getUserPreferences,
  cleanupZombiePreferences,
  cleanupCoarseFeedbackKeys,
  adjustInsightEngagement,
  seedPreferenceWeight,
  trackInsightEngagementOnce,
  transitionInsightEngagement,
} = require('../preferences');

describe('preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('trackInsightEngagement', () => {
    it('should record acted engagement with MERGE on UserPreference', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await trackInsightEngagement('user-1', 'insight-1', 'acted', 'quantum_computing');

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('UserPreference');
      expect(cypher).toContain('MERGE');
    });

    it('should record dismissed engagement', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await trackInsightEngagement('user-1', 'insight-2', 'dismissed', 'blockchain');

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params.action).toBe('dismissed');
      expect(params.topic).toBe('blockchain');
    });

    it('should increment acted_count for acted action', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await trackInsightEngagement('user-1', 'insight-1', 'acted', 'ai');

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('acted_count');
    });

    it('normalizes the persisted topic key', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await trackInsightEngagement('user-1', 'insight-1', 'acted', '  RAG   Pipelines  ');

      expect(mockRunWriteTransaction.mock.calls[0][1]).toMatchObject({ topic: 'rag-pipelines' });
    });
  });

  describe('trackInsightEngagementOnce', () => {
    it('writes the receipt and counter in one transaction and reports a new application', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [{ applied: true, payloadMatches: true }],
      });

      await expect(
        trackInsightEngagementOnce(
          'user-1',
          'signal-1',
          'acted',
          ' RAG\u00a0Pipelines ',
          'signal-feedback-backfill:signal-1'
        )
      ).resolves.toBe(true);

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain('MERGE (receipt:PreferenceEngagementReceipt {id: $replayKey})');
      expect(cypher).toContain('MERGE (up:UserPreference {userId: $userId, topic: $topic})');
      expect(cypher).toContain('SET receipt.applied = true');
      expect(cypher).toContain('RETURN applied, payloadMatches');
      expect(params).toEqual({
        userId: 'user-1',
        insightId: 'signal-1',
        action: 'acted',
        topic: 'rag-pipelines',
        replayKey: 'signal-feedback-backfill:signal-1',
      });
    });

    it('returns false for an exact replay without scheduling another counter branch', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [{ applied: false, payloadMatches: true }],
      });

      await expect(
        trackInsightEngagementOnce(
          'user-1',
          'signal-1',
          'dismissed',
          'quantum-sensing',
          'signal-feedback-backfill:signal-1'
        )
      ).resolves.toBe(false);
    });

    it('fails closed when one replay key is reused for a different immutable payload', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [{ applied: false, payloadMatches: false }],
      });

      await expect(
        trackInsightEngagementOnce(
          'user-2',
          'signal-2',
          'acted',
          'edge-ai',
          'signal-feedback-backfill:signal-1'
        )
      ).rejects.toThrow('already bound to a different engagement payload');
    });

    it('rejects invalid replay identities before opening a write transaction', async () => {
      await expect(trackInsightEngagementOnce('user-1', 'signal-1', 'acted', 'edge-ai', '   ')).rejects.toThrow(
        'replay key must not be blank'
      );
      await expect(
        trackInsightEngagementOnce('user-1', 'signal-1', 'acted', 'edge-ai', 'x'.repeat(2049))
      ).rejects.toThrow('must not exceed 2048');
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });

  describe('transitionInsightEngagement', () => {
    it('moves both semantic counters in one canonical-row transaction', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await transitionInsightEngagement(
        'user-1',
        'signal-1',
        ' RAG\u00a0Pipelines ',
        'acted',
        'dismissed'
      );

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain('MERGE (target:UserPreference { userId: $userId, topic: $topic })');
      expect(cypher).toContain('target.acted_count = CASE');
      expect(cypher).toContain('target.dismissed_count = CASE');
      expect(cypher).toContain("WHEN $priorAction = 'acted'");
      expect(cypher).toContain("WHEN $priorAction = 'dismissed'");
      expect(cypher).toContain("ELSE datetime('invalid-preference-counter')");
      expect(cypher).toContain('coalesce(toInteger(row.acted_count), 0)');
      expect(cypher).toContain('FOREACH (duplicate IN duplicates | DETACH DELETE duplicate)');
      expect(params).toEqual({
        userId: 'user-1',
        topic: 'rag-pipelines',
        priorAction: 'acted',
        nextAction: 'dismissed',
        topicSeparators: expect.arrayContaining(['-', '\u00a0', '\u3000']),
      });
    });

    it('clamps a missing prior count while still recording the next semantic action', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await transitionInsightEngagement('user-1', 'signal-1', 'edge-ai', 'dismissed', 'acted');

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('WHEN dismissedTotal > 0 THEN dismissedTotal - 1 ELSE 0');
      expect(cypher).toContain('ELSE actedTotal + 1');
    });

    it('propagates one atomic write failure without scheduling a fallback mutation', async () => {
      mockRunWriteTransaction.mockRejectedValue(new Error('Neo4j transaction rejected'));

      await expect(
        transitionInsightEngagement('user-1', 'signal-1', 'edge-ai', 'acted', 'dismissed')
      ).rejects.toThrow('Neo4j transaction rejected');
      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid or no-op transitions before opening a write transaction', async () => {
      await expect(
        transitionInsightEngagement('user-1', 'signal-1', 'edge-ai', 'acted', 'acted')
      ).rejects.toThrow('actions must differ');
      await expect(
        transitionInsightEngagement(' ', 'signal-1', 'edge-ai', 'acted', 'dismissed')
      ).rejects.toThrow('userId must not be blank');
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });

  describe('getUserPreferences', () => {
    it('should return weighted preferences for a user', async () => {
      const recordData: Record<string, unknown> = {
        topic: 'quantum_computing',
        weight: 0.75,
        actedCount: { low: 5 },
        dismissedCount: { low: 1 },
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            ...recordData,
            get: (key: string) => recordData[key] ?? null,
          },
        ],
      });

      const prefs = await getUserPreferences('user-1');
      expect(prefs).toHaveLength(1);
      expect(prefs[0].topic).toBe('quantum_computing');
      expect(prefs[0].weight).toBe(0.75);
    });

    it('should return empty array for user with no preferences', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      const prefs = await getUserPreferences('user-999');
      expect(prefs).toHaveLength(0);
    });

    // DUP-5 unification (2026-04 discovery-loop decay-of-record task) — the Cypher
    // now returns `up.lastUpdated` so `getEffectivePreferences` (cold-start.ts) can
    // decay by real recency instead of reading an undecayed weight.
    it('unwraps a native-Date lastUpdated (as returned by neo4j-client toNativeValue) to epoch ms', async () => {
      const asOfDate = new Date('2026-05-01T00:00:00.000Z');
      const recordData: Record<string, unknown> = {
        topic: 'quantum_computing',
        weight: 0.75,
        actedCount: { low: 5 },
        dismissedCount: { low: 1 },
        lastUpdated: asOfDate,
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [{ ...recordData, get: (key: string) => recordData[key] ?? null }],
      });

      const prefs = await getUserPreferences('user-1');

      expect(prefs[0].lastUpdated).toBe(asOfDate.getTime());
    });

    it('omits lastUpdated when the row predates the field (no property returned)', async () => {
      const recordData: Record<string, unknown> = {
        topic: 'quantum_computing',
        weight: 0.75,
        actedCount: { low: 5 },
        dismissedCount: { low: 1 },
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [{ ...recordData, get: (key: string) => recordData[key] ?? null }],
      });

      const prefs = await getUserPreferences('user-1');

      expect(prefs[0].lastUpdated).toBeUndefined();
    });

    it('combines legacy topic-key variants before calculating the posterior', async () => {
      const now = new Date('2026-05-01T00:00:00.000Z');
      mockRunReadTransaction.mockResolvedValue({
        records: [
          { topic: ' RAG  Pipelines ', actedCount: 2, dismissedCount: 0, lastUpdated: now },
          { topic: 'rag-pipelines', actedCount: 0, dismissedCount: 2 },
        ],
      });

      await expect(getUserPreferences('user-1')).resolves.toEqual([
        {
          topic: 'rag-pipelines',
          actedCount: 2,
          dismissedCount: 2,
          weight: 0.25,
          lastUpdated: now.getTime(),
        },
      ]);
    });
  });

  // ------------------------------------------------------------------------
  // cleanupZombiePreferences
  //
  // Hard-deletes UserPreference rows whose topic is the raw action verb
  // instead of an entity type. These were produced by the pre-0.1 route
  // bug; the source is closed but historical residue needs removing.
  // ------------------------------------------------------------------------

  describe('cleanupZombiePreferences', () => {
    function buildSummary(deleted: number) {
      return {
        records: [],
        summary: {
          counters: {
            nodesCreated: 0,
            nodesDeleted: deleted,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
            propertiesSet: 0,
          },
        },
      };
    }

    it('deletes only rows whose topic is the raw action verb', async () => {
      mockRunWriteTransaction.mockResolvedValue(buildSummary(2));

      const deleted = await cleanupZombiePreferences();

      expect(deleted).toBe(2);
      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher] = mockRunWriteTransaction.mock.calls[0];

      // Selection — never widen this without thought.
      expect(cypher).toContain("up.topic IN ['clicked', 'dismissed']");
      expect(cypher).toContain('DETACH DELETE up');

      // Hard delete is intentional here (no audit trail to preserve, unlike
      // ProactiveInsight's soft consume). Regression guard against an
      // accidental SET-consumed-true rewrite.
      expect(cypher).not.toContain('SET');
    });

    it('returns 0 when no zombies exist', async () => {
      mockRunWriteTransaction.mockResolvedValue(buildSummary(0));

      const deleted = await cleanupZombiePreferences();

      expect(deleted).toBe(0);
    });

    it('propagates errors when the write fails', async () => {
      mockRunWriteTransaction.mockRejectedValue(new Error('Neo4j unavailable'));

      await expect(cleanupZombiePreferences()).rejects.toThrow('Neo4j unavailable');
    });
  });

  // -------------------------------------------------------------------------
  // Option A step A.1 — symmetric +/- adjustment for the like toggle
  // -------------------------------------------------------------------------

  describe('adjustInsightEngagement', () => {
    it('MATCHes (does not MERGE) the UserPreference row and applies the delta', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await adjustInsightEngagement('user-1', 'technology', 'acted_count', 1);

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      // MATCH-not-MERGE: we don't create a row on adjustment. The row must
      // have already been created by trackInsightEngagement.
      expect(cypher).toContain('MATCH (up:UserPreference');
      expect(cypher).not.toContain('MERGE');
      expect(cypher.indexOf('SET up._preferenceWriteLock = true')).toBeLessThan(
        cypher.indexOf('reduce(normalized')
      );
      expect(cypher).toContain('REMOVE up._preferenceWriteLock');
      // Interpolated field name (closed enum, safe).
      expect(cypher).toContain('target.acted_count');
    });

    it('clamps the counter at zero so we never write a negative value', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await adjustInsightEngagement('user-1', 'technology', 'acted_count', -1);

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      // The CASE expression guards against subtraction below zero.
      expect(cypher).toMatch(/WHEN selectedTotal \+ \$delta < 0 THEN 0/);
    });

    it('passes through delta in the params', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await adjustInsightEngagement('user-1', 'company', 'dismissed_count', 1);

      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params).toEqual({
        userId: 'user-1',
        topic: 'company',
        delta: 1,
        topicSeparators: expect.arrayContaining(['-', '\u00a0', '\u3000']),
      });
    });

    it('supports the dismissed_count field for A.2 undo', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await adjustInsightEngagement('user-1', 'technology', 'dismissed_count', -1);

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('target.dismissed_count');
    });

    it('consolidates canonical-equivalent legacy rows before applying a vote reversal', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await adjustInsightEngagement('user-1', ' RAG\u00a0Pipelines ', 'acted_count', -1);

      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(params).toMatchObject({ userId: 'user-1', topic: 'rag-pipelines', delta: -1 });
      expect(cypher).toContain('MATCH (up:UserPreference { userId: $userId })');
      expect(cypher).toContain('character IN $topicSeparators');
      expect(cypher).toContain('coalesce(head([row IN rows WHERE row.topic = $topic]), head(rows))');
      expect(cypher).toContain('reduce(total = 0, row IN rows');
      expect(cypher).toContain('FOREACH (duplicate IN duplicates | DETACH DELETE duplicate)');
    });
  });

  describe('cleanupCoarseFeedbackKeys (A1/A5 — remove disjoint old-key rows)', () => {
    function buildSummary(deleted: number) {
      return { records: [], summary: { counters: { nodesDeleted: deleted } } };
    }

    it('deletes rows whose topic ends in a proposalType suffix, by DETACH DELETE', async () => {
      mockRunWriteTransaction.mockResolvedValue(buildSummary(1));
      const deleted = await cleanupCoarseFeedbackKeys();
      expect(deleted).toBe(1);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain("up.topic ENDS WITH ':' + suffix");
      expect(cypher).toContain('DETACH DELETE up');
      expect(params.suffixes).toEqual(['assessment', 'relation', 'entity', 'update']);
    });

    it('propagates a write failure (the migration must not silently no-op)', async () => {
      mockRunWriteTransaction.mockRejectedValue(new Error('Neo4j unavailable'));
      await expect(cleanupCoarseFeedbackKeys()).rejects.toThrow('Neo4j unavailable');
    });
  });

  describe('seedPreferenceWeight (A2 — interest baseline, never clobbers feedback)', () => {
    it('MERGEs the topic, seeding acted_count ON CREATE but only recency ON MATCH', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });
      await seedPreferenceWeight('user-1', 'vector-database', 3);

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain('MERGE (up:UserPreference { userId: $userId, topic: $topic })');
      expect(cypher).toContain('ON CREATE SET');
      expect(cypher).toContain('up.acted_count = $seed');
      // ON MATCH must NOT touch acted_count (would clobber earned feedback)
      expect(cypher).toMatch(/ON MATCH SET\s+up\.lastUpdated = datetime\(\)/);
      expect(params).toEqual({ userId: 'user-1', topic: 'vector-database', seed: 3 });
    });

    it('floors the seed to at least 1', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });
      await seedPreferenceWeight('user-1', 'llm', 0);
      expect(mockRunWriteTransaction.mock.calls[0][1].seed).toBe(1);
    });
  });
});
