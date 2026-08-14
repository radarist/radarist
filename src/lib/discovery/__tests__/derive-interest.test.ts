/**
 * @jest-environment node
 *
 * A2 — deriveInterestFromBehavior turns explored-entity tags into ranked interest topics
 * on the selector's tag key-space, merges the InterestProfile, and seeds matching
 * UserPreference weights. Idempotent; throws on backing-store failure (callers wrap).
 */
export {};

const mockGetExploredEntityTags = jest.fn();
const mockMergeInterestProfileTopics = jest.fn();
const mockSeedPreferenceWeight = jest.fn();
const mockGetDiscoveryConfig = jest.fn();

jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getExploredEntityTags: (...a: unknown[]) => mockGetExploredEntityTags(...a),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  __esModule: true,
  MAX_INTEREST_PROFILE_TOPICS: 25,
  mergeInterestProfileTopics: (...a: unknown[]) => mockMergeInterestProfileTopics(...a),
}));
jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  seedPreferenceWeight: (...a: unknown[]) => mockSeedPreferenceWeight(...a),
}));
jest.mock('../discovery-config', () => ({
  __esModule: true,
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { deriveInterestFromBehavior } = require('../derive-interest');

describe('deriveInterestFromBehavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDiscoveryConfig.mockReturnValue({ vertical: 'ai-ml-infra' });
    mockMergeInterestProfileTopics.mockResolvedValue(undefined);
    mockSeedPreferenceWeight.mockResolvedValue(undefined);
  });

  it('ranks topics by entity-frequency, upserts the profile, seeds weights (stopwords dropped)', async () => {
    mockGetExploredEntityTags.mockResolvedValue([
      { entityId: 'e1', tags: ['AI', 'Vector DB', 'e2e-test'] },
      { entityId: 'e2', tags: ['vector db', 'llm'] },
    ]);
    const res = await deriveInterestFromBehavior('u1');
    expect(res.topics[0]).toBe('vector-db'); // on 2 entities → ranked first
    expect(res.topics).toEqual(expect.arrayContaining(['vector-db', 'ai', 'llm']));
    expect(res.topics).not.toContain('e2e-test'); // stopword
    expect(mockMergeInterestProfileTopics).toHaveBeenCalledWith('u1', 'ai-ml-infra', res.topics);
    expect(mockSeedPreferenceWeight).toHaveBeenCalledWith('u1', 'vector-db', 2);
    expect(mockSeedPreferenceWeight).toHaveBeenCalledWith('u1', 'ai', 1);
    expect(res.seeded).toBe(3);
  });

  it('dedupes a topic within one entity (AI + ai → count 1)', async () => {
    mockGetExploredEntityTags.mockResolvedValue([{ entityId: 'e1', tags: ['AI', 'ai'] }]);
    await deriveInterestFromBehavior('u1');
    expect(mockSeedPreferenceWeight).toHaveBeenCalledWith('u1', 'ai', 1);
  });

  it('dedupes the same entity explored across sessions (counts once)', async () => {
    mockGetExploredEntityTags.mockResolvedValue([
      { entityId: 'e1', tags: ['llm'] },
      { entityId: 'e1', tags: ['llm'] },
    ]);
    await deriveInterestFromBehavior('u1');
    expect(mockSeedPreferenceWeight).toHaveBeenCalledWith('u1', 'llm', 1);
  });

  it('is a no-op when exploration yields no usable topics (cold-start prior stays)', async () => {
    mockGetExploredEntityTags.mockResolvedValue([{ entityId: 'e1', tags: ['e2e-test'] }]);
    const res = await deriveInterestFromBehavior('u1');
    expect(res).toEqual({ topics: [], seeded: 0 });
    expect(mockMergeInterestProfileTopics).not.toHaveBeenCalled();
    expect(mockSeedPreferenceWeight).not.toHaveBeenCalled();
  });

  it('propagates a read failure (surface, never mask — callers wrap best-effort)', async () => {
    mockGetExploredEntityTags.mockRejectedValue(new Error('neo4j down'));
    await expect(deriveInterestFromBehavior('u1')).rejects.toThrow('neo4j down');
  });

  it('uses a lexical tie-break and the shared profile cap for deterministic ordering', async () => {
    mockGetExploredEntityTags.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ entityId: `e-${i}`, tags: [`topic-${29 - i}`] }))
    );

    const result = await deriveInterestFromBehavior('u1');

    expect(result.topics).toHaveLength(25);
    expect(result.topics.slice(0, 4)).toEqual(['topic-0', 'topic-1', 'topic-10', 'topic-11']);
  });
});
