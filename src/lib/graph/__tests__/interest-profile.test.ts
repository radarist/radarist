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

const mockLogWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const {
  MAX_INTEREST_PROFILE_TOPICS,
  mergeInterestProfileTopics,
  normalizeInterestProfileTopics,
  replaceSyntheticInterestProfileTopics,
  getInterestProfile,
  touchInterestProfile,
  addInterestTopic,
} = require('../interest-profile');
const { TOPIC_SEPARATOR_CHARACTERS } = require('@/lib/discovery/candidate-topic');

describe('interest-profile', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('profile topic write semantics', () => {
    it('normalizes and de-duplicates deterministically under one exported cap', () => {
      const noisy = [
        '-- Vector\u00a0DB --',
        '\u2003vector   db\u3000',
        '',
        '---',
        '\u202f',
        'LLM--Ops---',
        'llm-ops',
        ...Array.from({ length: 30 }, (_, i) => `T ${i}`),
      ];

      const result = normalizeInterestProfileTopics(noisy);

      expect(MAX_INTEREST_PROFILE_TOPICS).toBe(25);
      expect(result.slice(0, 2)).toEqual(['vector-db', 'llm-ops']);
      expect(result).toHaveLength(MAX_INTEREST_PROFILE_TOPICS);
      expect(new Set(result).size).toBe(result.length);
    });

    it('atomically merges human topics without replacing prior feedback membership', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await mergeInterestProfileTopics('user-1', 'ai-ml-infra', [
        ' Vector Database ',
        'vector   database',
        'LLM Orchestration',
      ]);

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('MERGE (ip:InterestProfile { userId: $userId })');
      expect(cypher).toContain('MERGE (u:User { id: $userId })');
      expect(cypher).toContain('MERGE (ip)-[:PROFILE_FOR]->(u)');
      expect(cypher.indexOf('SET ip._topicsWriteLock = true')).toBeLessThan(
        cypher.indexOf('coalesce(ip.topics, []) + $topics')
      );
      expect(cypher).toContain('coalesce(ip.topics, []) + $topics');
      expect(cypher).toContain('character IN $topicSeparators');
      expect(cypher).toContain('WHERE CASE WHEN right(canonicalWithPossibleTrailingSeparator, 1)');
      expect(cypher).toContain('CASE WHEN topic IN merged THEN merged ELSE merged + topic END');
      expect(cypher).toContain('mergedTopics[0..$maxTopics]');
      expect(cypher).toContain('REMOVE ip._topicsWriteLock');

      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params).toMatchObject({
        userId: 'user-1',
        vertical: 'ai-ml-infra',
        topics: ['vector-database', 'llm-orchestration'],
        topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
        maxTopics: MAX_INTEREST_PROFILE_TOPICS,
        preserveExistingVertical: false,
      });
      expect(typeof params.updatedAt).toBe('string');
    });

    it('can preserve a non-blank existing vertical for historical backfills', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await mergeInterestProfileTopics('user-1', 'ai-ml-infra', ['RAG'], { preserveExistingVertical: true });

      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain("$preserveExistingVertical AND trim(coalesce(ip.vertical, '')) <> ''");
      expect(params).toMatchObject({ preserveExistingVertical: true, vertical: 'ai-ml-infra' });
    });

    it('rejects the human merge API for reserved synthetic profiles', async () => {
      await expect(mergeInterestProfileTopics('system-discovery', 'ai-ml-infra', ['llm'])).rejects.toThrow(
        'Synthetic InterestProfiles'
      );
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('replaces a synthetic snapshot exactly so stale aggregate topics can disappear', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await replaceSyntheticInterestProfileTopics('system-discovery', 'ai-ml-infra', [
        ' Graph DB ',
        'graph   db',
        'LLM',
      ]);

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('ip.topics = $topics');
      expect(cypher).not.toContain('coalesce(ip.topics');
      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params).toMatchObject({
        userId: 'system-discovery',
        vertical: 'ai-ml-infra',
        topics: ['graph-db', 'llm'],
      });
      expect(typeof params.updatedAt).toBe('string');
    });

    it('rejects synthetic replacement for a human profile', async () => {
      await expect(replaceSyntheticInterestProfileTopics('user-1', 'v', ['llm'])).rejects.toThrow(
        'restricted to synthetic'
      );
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });

  describe('getInterestProfile', () => {
    it('returns null when no node exists', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      const result = await getInterestProfile('nobody');

      expect(result).toBeNull();
    });

    it('returns the profile object when a row exists', async () => {
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            userId: 'user-1',
            vertical: 'ai-ml-infra',
            topics: ['vector-database'],
            updatedAt: '2026-06-23T00:00:00.000Z',
          },
        ],
      });

      const result = await getInterestProfile('user-1');

      expect(result).toEqual({
        userId: 'user-1',
        vertical: 'ai-ml-infra',
        topics: ['vector-database'],
        updatedAt: '2026-06-23T00:00:00.000Z',
      });
    });

    it('coerces a missing topics list to an empty array', async () => {
      mockRunReadTransaction.mockResolvedValue({
        records: [{ userId: 'user-1', vertical: 'ai-ml-infra', topics: null, updatedAt: '2026-06-23T00:00:00.000Z' }],
      });

      const result = await getInterestProfile('user-1');

      expect(result?.topics).toEqual([]);
    });

    it('normalizes and de-duplicates legacy topic variants at the read boundary', async () => {
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            userId: 'user-1',
            vertical: 'ai-ml-infra',
            topics: [' Vector  DB ', 'vector-db', 'LLM--Ops'],
            updatedAt: '2026-06-23T00:00:00.000Z',
          },
        ],
      });

      await expect(getInterestProfile('user-1')).resolves.toMatchObject({
        topics: ['vector-db', 'llm-ops'],
      });
    });

    it('deterministically caps oversized legacy profiles at the first 25 canonical topics', async () => {
      const legacyTopics = Array.from({ length: 30 }, (_, index) => ` Topic ${index} `);
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            userId: 'user-1',
            vertical: 'ai-ml-infra',
            topics: legacyTopics,
            updatedAt: '2026-06-23T00:00:00.000Z',
          },
        ],
      });

      const result = await getInterestProfile('user-1');

      expect(result?.topics).toEqual(Array.from({ length: 25 }, (_, index) => `topic-${index}`));
    });
  });

  describe('touchInterestProfile', () => {
    it('ensures the subgraph and sets ONLY updatedAt (never overwrites vertical/topics)', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await touchInterestProfile('user-1');

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      // Touch runs on every approve; it must create the subgraph if absent so
      // the M0 (:InterestProfile)-[:PROFILE_FOR]->(:User) observable holds.
      expect(cypher).toContain('MERGE (ip:InterestProfile { userId: $userId })');
      expect(cypher).toContain('MERGE (u:User { id: $userId })');
      expect(cypher).toContain('MERGE (ip)-[:PROFILE_FOR]->(u)');
      expect(cypher).toContain('ip.updatedAt = $updatedAt');
      // ...but it must NOT clobber the user's curated vertical/topics.
      expect(cypher).not.toContain('ip.topics');
      expect(cypher).not.toContain('ip.vertical');

      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params).toMatchObject({ userId: 'user-1' });
      expect(typeof params.updatedAt).toBe('string');
    });
  });

  describe('addInterestTopic', () => {
    it('up-vote on an untracked topic appends it to InterestProfile.topics (deduped)', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ alreadyPresent: false, atCap: false }] });

      const result = await addInterestTopic('user-1', 'quantum-sensing');

      expect(result).toBe(true);
      expect(mockLogWarn).not.toHaveBeenCalled();

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      // Cypher pins (adversarial R1 fix): CASE + coalesce append-if-absent + a
      // parameterized cap (no drop-oldest — topics carries no timestamps). The
      // cap is passed as $maxTopics (drift guard) rather than a hardcoded
      // literal, so the exported bound only needs to change in one place.
      expect(cypher).toContain('CASE');
      expect(cypher).toContain('coalesce(ip.topics, [])');
      expect(cypher.indexOf('SET ip._topicsWriteLock = true')).toBeLessThan(
        cypher.indexOf('coalesce(ip.topics, [])')
      );
      expect(cypher).toContain('character IN $topicSeparators');
      expect(cypher).toContain('canonicalPriorTopics[0..$maxTopics] AS priorTopics');
      expect(cypher).toContain('REMOVE ip._topicsWriteLock');
      expect(cypher).toContain('>= $maxTopics');
      expect(cypher).toContain('priorTopics + $topic');
      expect(cypher).not.toContain('>= 24');

      const params = mockRunWriteTransaction.mock.calls[0][1];
      expect(params).toMatchObject({
        userId: 'user-1',
        topic: 'quantum-sensing',
        topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
        maxTopics: MAX_INTEREST_PROFILE_TOPICS,
      });
    });

    it('an already-tracked topic is a no-op (dedup) — returns false, no warn', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ alreadyPresent: true, atCap: false }] });

      const result = await addInterestTopic('user-1', 'vector-database');

      expect(result).toBe(false);
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('at the shared cap, append is skipped and logged with nothing evicted', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ alreadyPresent: false, atCap: true }] });

      const result = await addInterestTopic('user-1', 'topic-number-25');

      expect(result).toBe(false);
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('cap'),
        expect.objectContaining({ userId: 'user-1', topic: 'topic-number-25' })
      );
      // The CASE branch itself (asserted above) preserves priorTopics unchanged at cap —
      // this test pins the observable side effect: no eviction, just a skip + log.
    });

    it('creates the profile via MERGE for a first-time user', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ alreadyPresent: false, atCap: false }] });

      await addInterestTopic('brand-new-user', 'topic-x');

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('MERGE (ip:InterestProfile { userId: $userId })');
      expect(cypher).toContain('MERGE (u:User { id: $userId })');
      expect(cypher).toContain('MERGE (ip)-[:PROFILE_FOR]->(u)');
    });

    it('normalizes an appended topic and ignores a blank without querying Neo4j', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ alreadyPresent: false, atCap: false }] });

      await expect(addInterestTopic('user-1', ' Agent   Orchestration ')).resolves.toBe(true);
      expect(mockRunWriteTransaction.mock.calls[0][1]).toMatchObject({ topic: 'agent-orchestration' });

      jest.clearAllMocks();
      await expect(addInterestTopic('user-1', '   ')).resolves.toBe(false);
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });
});
