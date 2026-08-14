jest.mock('@/lib/graph/neo4j-client', () => ({ runReadTransaction: jest.fn() }));
jest.mock('@/lib/discovery/topic-adjacency', () => ({ getAdjacentDiscoveryTopics: jest.fn() }));
jest.mock('@/lib/discovery/discovery-config', () => ({ getDiscoveryConfig: jest.fn() }));

import { meaningfulTags, normalizeTopicKey, TAG_STOPWORDS } from '@/lib/discovery/candidate-topic';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { getAdjacentDiscoveryTopics } from '@/lib/discovery/topic-adjacency';
import { runReadTransaction } from '@/lib/graph/neo4j-client';

import {
  applyRecencyDecay,
  DEFAULT_KEYWORDS,
  getAggregateInterestKeywords,
  getAggregateInterestTopics,
  getAggregateTopicWeights,
  getRadarTechnologyNames,
  getRadarTechnologyPlacementCounts,
} from '@/lib/discovery/interest-keywords';

const mockRunReadTransaction = runReadTransaction as jest.Mock;
const mockGetAdjacentDiscoveryTopics = getAdjacentDiscoveryTopics as jest.Mock;
const mockGetDiscoveryConfig = getDiscoveryConfig as jest.Mock;

describe('applyRecencyDecay', () => {
  it('returns the weight unchanged at age 0 (fresh dislike)', () => {
    // Arrange
    const weight = -0.5;
    const ageDays = 0;
    const halfLifeDays = 30;

    // Act
    const result = applyRecencyDecay(weight, ageDays, halfLifeDays);

    // Assert
    expect(result).toBe(-0.5);
  });

  it('recovers toward neutral after two half-lives', () => {
    // Arrange
    const weight = -0.5;
    const ageDays = 60;
    const halfLifeDays = 30;

    // Act
    const result = applyRecencyDecay(weight, ageDays, halfLifeDays);

    // Assert
    expect(result).toBeCloseTo(-0.125);
  });

  it('decays a high positive weight toward 0 over time', () => {
    // Arrange / Act / Assert
    expect(applyRecencyDecay(1, 30, 30)).toBeCloseTo(0.5);
    expect(applyRecencyDecay(1, 300, 30)).toBeLessThan(0.01);
  });

  it('is the identity at age 0 for an arbitrary weight', () => {
    // Arrange
    const weight = 0.7;

    // Act
    const result = applyRecencyDecay(weight, 0, 30);

    // Assert
    expect(result).toBe(0.7);
  });

  it('throws a RangeError when halfLifeDays is 0', () => {
    // Arrange / Act / Assert
    expect(() => applyRecencyDecay(0.5, 10, 0)).toThrow(RangeError);
  });

  it('throws a RangeError when halfLifeDays is negative', () => {
    // Arrange / Act / Assert
    expect(() => applyRecencyDecay(0.5, 10, -5)).toThrow(RangeError);
  });
});

describe('getAggregateInterestTopics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps per-profile topic arrays to a de-duplicated string array', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topics: ['vector db'] }, { topics: ['rag'] }],
    });

    // Act
    const result = await getAggregateInterestTopics();

    // Assert
    expect(result).toEqual(['vector-db', 'rag']);
  });

  it('normalizes and de-duplicates legacy profile variants', async () => {
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topics: [' Vector  DB ', 'vector-db', 'LLM--Ops', '---', '\u2003'] }],
    });

    await expect(getAggregateInterestTopics()).resolves.toEqual(['vector-db', 'llm-ops']);
  });

  it('caps each oversized legacy profile before forming the cross-profile union', async () => {
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { topics: Array.from({ length: 30 }, (_, index) => `Topic ${index}`) },
        { topics: ['another-user-topic'] },
      ],
    });

    const result = await getAggregateInterestTopics();

    expect(result).toEqual([
      ...Array.from({ length: 25 }, (_, index) => `topic-${index}`),
      'another-user-topic',
    ]);
  });

  it('returns an empty array when there are no records', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({ records: [] });

    // Act
    const result = await getAggregateInterestTopics();

    // Assert
    expect(result).toEqual([]);
  });

  it('returns an empty array (never throws) when the read fails', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getAggregateInterestTopics();

    // Assert
    expect(result).toEqual([]);
  });
});

describe('getAggregateTopicWeights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('computes the posterior weight from summed acted/dismissed counts', async () => {
    // Arrange
    const now = Date.now();
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topic: 'rag', acted: 3, dismissed: 1, lastMillis: now }],
    });

    // Act
    const result = await getAggregateTopicWeights(now);

    // Assert
    expect(result.get('rag')?.weight).toBeCloseTo(0.625);
    expect(result.get('rag')?.ageDays).toBeCloseTo(0);
  });

  it('combines legacy topic-key variants before calculating weight', async () => {
    const now = Date.now();
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { topic: 'RAG Pipelines', acted: 2, dismissed: 0, lastMillis: now - 1000 },
        { topic: 'rag-pipelines', acted: 0, dismissed: 2, lastMillis: now },
      ],
    });

    const result = await getAggregateTopicWeights(now);

    expect([...result.keys()]).toEqual(['rag-pipelines']);
    expect(result.get('rag-pipelines')?.weight).toBeCloseTo(0.25);
    expect(result.get('rag-pipelines')?.ageDays).toBe(0);
  });

  it('computes ageDays from the most-recent engagement timestamp', async () => {
    // Arrange
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86_400_000;
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topic: 'rag', acted: 2, dismissed: 0, lastMillis: thirtyDaysAgo }],
    });

    // Act
    const result = await getAggregateTopicWeights(now);

    // Assert
    expect(result.get('rag')?.ageDays).toBeCloseTo(30);
  });

  it('returns a weight of 0 (not NaN) when acted and dismissed are both 0', async () => {
    // Arrange
    const now = Date.now();
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topic: 'rag', acted: 0, dismissed: 0, lastMillis: now }],
    });

    // Act
    const result = await getAggregateTopicWeights(now);

    // Assert
    expect(result.get('rag')?.weight).toBe(0);
  });

  it('defaults ageDays to 0 when lastMillis is null', async () => {
    // Arrange
    const now = Date.now();
    mockRunReadTransaction.mockResolvedValue({
      records: [{ topic: 'rag', acted: 1, dismissed: 0, lastMillis: null }],
    });

    // Act
    const result = await getAggregateTopicWeights(now);

    // Assert
    expect(result.get('rag')?.ageDays).toBe(0);
  });

  it('returns an empty Map (never throws) when the read fails', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getAggregateTopicWeights(Date.now());

    // Assert
    expect(result.size).toBe(0);
  });
});

describe('getRadarTechnologyNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps distinct radar-placed technology name records to a string array', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ name: 'pgvector' }, { name: 'Kubernetes' }],
    });

    // Act
    const result = await getRadarTechnologyNames();

    // Assert
    expect(result).toEqual(['pgvector', 'Kubernetes']);
  });

  it('returns an empty array (never throws) when the read fails', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getRadarTechnologyNames();

    // Assert
    expect(result).toEqual([]);
  });
});

describe('getRadarTechnologyPlacementCounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps technology name records to a placement-count Map', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { name: 'AI Agents', placements: 7 },
        { name: '4D Imaging Radar', placements: 1 },
      ],
    });

    // Act
    const result = await getRadarTechnologyPlacementCounts();

    // Assert
    expect(result.get('AI Agents')).toBe(7);
    expect(result.get('4D Imaging Radar')).toBe(1);
  });

  it('returns an empty Map (never throws) when the read fails', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getRadarTechnologyPlacementCounts();

    // Assert
    expect(result.size).toBe(0);
  });
});

describe('getAggregateInterestKeywords', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: false, adjacentDiscoveryEnabled: false });
  });

  const NOW = Date.now();

  /**
   * Cypher-substring router: routes the four parallel reads
   * (InterestProfile topics / UserPreference weights / RadarPlacement
   * technology names / RadarPlacement placement counts) to distinct fixtures
   * based on which query text was passed in, so the underlying reads can be
   * exercised independently through the single `getAggregateInterestKeywords`
   * entry point. The placement-counts query is checked FIRST since its Cypher
   * also contains the substring "RadarPlacement" (`cypher.includes('placements')`
   * is the unique marker — it aliases `count(*) AS placements`).
   */
  function mockUnionFixture() {
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['vector db', 'rag'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [
            { topic: 'vector db', acted: 8, dismissed: 0, lastMillis: NOW }, // weight 1.0
            { topic: 'rag', acted: 1, dismissed: 5, lastMillis: NOW }, // weight (1-2.5)/6 = -0.25
          ],
        };
      }
      if (cypher.includes('placements')) {
        return { records: [] }; // no placement data — not the focus of this fixture
      }
      if (cypher.includes('RadarPlacement')) {
        return { records: [{ name: 'pgvector' }] }; // neutral: no UserPreference row
      }
      return { records: [] };
    });
  }

  it('unions topics and radar tech names, ranking the liked topic first (a, b)', async () => {
    // Arrange
    mockUnionFixture();

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    // Assert — liked topic ranks first, radar tech (neutral) present, nothing excluded
    expect(result.keywords).toEqual(['vector-db', 'pgvector', 'rag']);
    // Discovery lane is OFF by default — no adjacency lookup, empty topic map (regression lock).
    expect(result.discoveryTopics).toEqual({});
    expect(mockGetAdjacentDiscoveryTopics).not.toHaveBeenCalled();
  });

  it('clamps a non-positive opts.limit to at least 1, never returning an empty keyword list', async () => {
    // Arrange
    mockUnionFixture();

    // Act
    const result = await getAggregateInterestKeywords({ limit: 0, maxSignals: 30, now: NOW });

    // Assert — top candidate ('vector db', weight 1.0) still survives the clamp
    expect(result.keywords).toEqual(['vector-db']);
  });

  it('excludes a deeply-disliked candidate from keywords (c)', async () => {
    // Arrange
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['vector db', 'toxic'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [
            { topic: 'vector db', acted: 8, dismissed: 0, lastMillis: NOW }, // weight 1.0
            { topic: 'toxic', acted: 0, dismissed: 10, lastMillis: NOW }, // weight -0.5
          ],
        };
      }
      return { records: [] };
    });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    // Assert
    expect(result.keywords).toContain('vector-db');
    expect(result.keywords).not.toContain('toxic');
  });

  it('cannot bypass a negative canonical posterior through a differently formatted radar name', async () => {
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['safe topic'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [
            { topic: 'safe-topic', acted: 1, dismissed: 0, lastMillis: NOW },
            { topic: 'rag-pipelines', acted: 0, dismissed: 10, lastMillis: NOW },
          ],
        };
      }
      if (cypher.includes('placements')) {
        return { records: [{ name: 'RAG Pipelines', placements: 50 }] };
      }
      if (cypher.includes('RadarPlacement')) {
        return { records: [{ name: 'RAG Pipelines' }] };
      }
      return { records: [] };
    });

    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    expect(result.keywords).toEqual(['safe-topic']);
    expect(result.keywords.map(normalizeTopicKey)).not.toContain('rag-pipelines');
  });

  it('deduplicates canonical-equivalent radar names and combines their placement counts', async () => {
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('placements')) {
        return {
          records: [
            { name: 'RAG Pipelines', placements: 4 },
            { name: 'rag-pipelines', placements: 4 },
            { name: 'Zeta Stack', placements: 7 },
          ],
        };
      }
      if (cypher.includes('RadarPlacement')) {
        return { records: [{ name: 'rag-pipelines' }, { name: 'RAG Pipelines' }, { name: 'Zeta Stack' }] };
      }
      return { records: [] };
    });

    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    expect(result.keywords).toEqual(['RAG Pipelines', 'Zeta Stack']);
    expect(result.keywords.map(normalizeTopicKey).filter((topic) => topic === 'rag-pipelines')).toHaveLength(1);
  });

  it('falls back to DEFAULT_KEYWORDS on cold start — no candidates at all (d)', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({ records: [] });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 20, now: NOW });

    // Assert
    expect(result.keywords).toEqual(DEFAULT_KEYWORDS);
  });

  it('falls back to DEFAULT_KEYWORDS when every candidate is excluded (never returns an empty keyword list)', async () => {
    // Arrange
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['toxic'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return { records: [{ topic: 'toxic', acted: 0, dismissed: 10, lastMillis: NOW }] }; // weight -0.5
      }
      return { records: [] };
    });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 20, now: NOW });

    // Assert
    expect(result.keywords).toEqual(DEFAULT_KEYWORDS);
    expect(result.keywords.length).toBeGreaterThan(0);
  });

  it('never throws — falls back to DEFAULT_KEYWORDS when the underlying read rejects', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 20, now: NOW });

    // Assert
    expect(result.keywords).toEqual(DEFAULT_KEYWORDS);
  });

  it('excludes a workflow/priority stopword even when it would otherwise rank top (F2)', async () => {
    // Arrange — 'p0-priority' has a much higher posterior weight than the real topic
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['p0-priority', 'vector-database'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [
            { topic: 'p0-priority', acted: 10, dismissed: 0, lastMillis: NOW }, // weight 1.0
            { topic: 'vector-database', acted: 1, dismissed: 0, lastMillis: NOW }, // weight 1.0
          ],
        };
      }
      return { records: [] };
    });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    // Assert
    expect(result.keywords).toContain('vector-database');
    expect(result.keywords).not.toContain('p0-priority');
  });

  it('excludes stopwords case-insensitively (F2)', async () => {
    // Arrange
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['PUBLIC', 'vector-database'] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [
            { topic: 'PUBLIC', acted: 10, dismissed: 0, lastMillis: NOW },
            { topic: 'vector-database', acted: 1, dismissed: 0, lastMillis: NOW },
          ],
        };
      }
      return { records: [] };
    });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    // Assert
    expect(result.keywords).not.toContain('PUBLIC');
  });

  it('does NOT filter a generic-but-real topic like "technology" (guards against over-filtering) (F2)', async () => {
    // Arrange — 'technology' is the sole candidate; it must survive
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: ['technology'] }] };
      }
      return { records: [] };
    });

    // Act
    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    // Assert
    expect(result.keywords).toContain('technology');
  });

  // DUP-6 unification — `candidate-topic.ts`'s `TAG_STOPWORDS` is now the SINGLE
  // stopword source for both the write side (`meaningfulTags`, seeding
  // InterestProfile/UserPreference) and this fetch side (previously a disjoint
  // `TOPIC_STOPWORDS` list local to this module).
  it('stopword filtering is identical on write and fetch sides', async () => {
    const stopwordTokens = [...TAG_STOPWORDS];
    const survivorTopic = 'vector-database';

    // Write side: meaningfulTags (candidate-topic.ts) drops every merged stopword.
    for (const token of stopwordTokens) {
      expect(meaningfulTags([token])).toEqual([]);
    }
    expect(meaningfulTags([survivorTopic])).toEqual([survivorTopic]);

    // Fetch side: getAggregateInterestKeywords (interest-keywords.ts) drops the
    // SAME tokens, over the same posterior-weighting path, keeping the survivor.
    mockRunReadTransaction.mockImplementation(async (cypher: string) => {
      if (cypher.includes('InterestProfile')) {
        return { records: [{ topics: [...stopwordTokens, survivorTopic] }] };
      }
      if (cypher.includes('UserPreference')) {
        return {
          records: [...stopwordTokens, survivorTopic].map((topic) => ({
            topic,
            acted: 10,
            dismissed: 0,
            lastMillis: NOW,
          })),
        };
      }
      return { records: [] };
    });

    const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

    for (const token of stopwordTokens) {
      expect(result.keywords).not.toContain(token);
    }
    expect(result.keywords).toContain(survivorTopic);
  });

  describe('placement-count tie-break (F3)', () => {
    it('ranks a heavily-placed radar tech above a niche one when both decay to the same weight', async () => {
      // Arrange — both are radar-name candidates with no UserPreference row → decayed weight 0 for each.
      // Radar names arrive alphabetically ('4D…' before 'AI…'), which is the pre-fix (buggy) order.
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('placements')) {
          return {
            records: [
              { name: 'AI Agents', placements: 7 },
              { name: '4D Imaging Radar', placements: 1 },
            ],
          };
        }
        if (cypher.includes('RadarPlacement')) {
          return { records: [{ name: '4D Imaging Radar' }, { name: 'AI Agents' }] };
        }
        return { records: [] };
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — central tech (7 placements) outranks the niche one (1 placement)
      expect(result.keywords.indexOf('AI Agents')).toBeLessThan(result.keywords.indexOf('4D Imaging Radar'));
    });

    it('lets decayed weight dominate the tie-break — a positive-weight topic still outranks a heavily-placed radar tech', async () => {
      // Arrange — 'vector db' has a positive posterior weight; 'BigTech' is a radar name with
      // no UserPreference row (decayed weight 0) but a very high placement count.
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('InterestProfile')) {
          return { records: [{ topics: ['vector db'] }] };
        }
        if (cypher.includes('UserPreference')) {
          return { records: [{ topic: 'vector db', acted: 5, dismissed: 0, lastMillis: NOW }] }; // weight 1.0
        }
        if (cypher.includes('placements')) {
          return { records: [{ name: 'BigTech', placements: 100 }] };
        }
        if (cypher.includes('RadarPlacement')) {
          return { records: [{ name: 'BigTech' }] };
        }
        return { records: [] };
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — decayed weight (key #1) dominates the placement-count tie-break (key #2)
      expect(result.keywords.indexOf('vector db')).toBeLessThan(result.keywords.indexOf('BigTech'));
    });

    it('falls back to alphabetical order when both decayed weight AND placement count are equal', async () => {
      // Arrange — two radar names, equal (absent) weight, equal placement count
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('placements')) {
          return {
            records: [
              { name: 'Zeta Framework', placements: 5 },
              { name: 'Alpha Framework', placements: 5 },
            ],
          };
        }
        if (cypher.includes('RadarPlacement')) {
          return { records: [{ name: 'Zeta Framework' }, { name: 'Alpha Framework' }] };
        }
        return { records: [] };
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — final tie-break is alphabetical
      expect(result.keywords).toEqual(['Alpha Framework', 'Zeta Framework']);
    });
  });

  describe('discovery lane (adjacent-topic injection, S12.2)', () => {
    /**
     * Five reinforcement candidates with strictly descending posterior weight so
     * slice-boundary assertions below are deterministic: topic-a (1.0) > topic-b
     * (0.7) > topic-c (0.25) > tech-d (0, neutral) > tech-e (0, neutral, tie
     * broken by insertion order).
     */
    function mockRichFixture() {
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('InterestProfile')) {
          return { records: [{ topics: ['topic-a', 'topic-b', 'topic-c'] }] };
        }
        if (cypher.includes('UserPreference')) {
          return {
            records: [
              { topic: 'topic-a', acted: 10, dismissed: 0, lastMillis: NOW }, // weight 1.0
              { topic: 'topic-b', acted: 8, dismissed: 2, lastMillis: NOW }, // weight 0.7
              { topic: 'topic-c', acted: 5, dismissed: 5, lastMillis: NOW }, // weight 0.25
            ],
          };
        }
        if (cypher.includes('placements')) {
          return { records: [] }; // no placement data — tie between tech-d/tech-e resolves alphabetically
        }
        if (cypher.includes('RadarPlacement')) {
          return { records: [{ name: 'tech-d' }, { name: 'tech-e' }] };
        }
        return { records: [] };
      });
    }

    it('injects a novel, neutral-posterior discovery candidate and reserves its slot from reinforcement', async () => {
      // Arrange
      mockRichFixture();
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'RAG Pipelines', topic: 'agentic-memory', seedConcepts: 2 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 3, maxSignals: 30, now: NOW });

      // Assert — limit=3, K=1 discovery keyword → reinforcement slice is limit-K=2 (top 2 by weight)
      expect(result.keywords).toEqual(['topic-a', 'topic-b', 'RAG Pipelines']);
      expect(result.discoveryTopics).toEqual({ 'RAG Pipelines': 'agentic-memory' });
    });

    it('excludes a discovery candidate whose topic posterior is muted (strongly negative)', async () => {
      // Arrange
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('InterestProfile')) {
          return { records: [{ topics: ['topic-a', 'topic-b', 'topic-c'] }] };
        }
        if (cypher.includes('UserPreference')) {
          return {
            records: [
              { topic: 'topic-a', acted: 10, dismissed: 0, lastMillis: NOW },
              { topic: 'topic-b', acted: 8, dismissed: 2, lastMillis: NOW },
              { topic: 'topic-c', acted: 5, dismissed: 5, lastMillis: NOW },
              { topic: 'agentic-memory', acted: 0, dismissed: 10, lastMillis: NOW }, // weight -0.5, ageDays 0
            ],
          };
        }
        if (cypher.includes('placements')) {
          return { records: [] }; // no placement data — not the focus of this fixture
        }
        if (cypher.includes('RadarPlacement')) {
          return { records: [{ name: 'tech-d' }, { name: 'tech-e' }] };
        }
        return { records: [] };
      });
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'RAG Pipelines', topic: 'agentic-memory', seedConcepts: 2 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 3, maxSignals: 30, now: NOW });

      // Assert — excluded from BOTH the keyword list and the discovery topic map
      expect(result.keywords).not.toContain('RAG Pipelines');
      expect(result.discoveryTopics).toEqual({});
    });

    it('excludes a discovery candidate whose topic is already an interest topic (novelty gate)', async () => {
      // Arrange
      mockRichFixture();
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'Some Keyword', topic: 'topic-a', seedConcepts: 3 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 3, maxSignals: 30, now: NOW });

      // Assert
      expect(result.keywords).not.toContain('Some Keyword');
      expect(result.discoveryTopics).toEqual({});
    });

    it('excludes a novelty gate match across spacing/hyphenation forms (Fix 1 — normalize both sides)', async () => {
      // Arrange — tracked interest topic is space-separated ('agentic ai'); one discovery candidate's
      // topic is the same concept in kebab form ('agentic-ai') and must be recognized as non-novel;
      // a second candidate's topic ('agentic-memory') is genuinely different and must be injected.
      mockRunReadTransaction.mockImplementation(async (cypher: string) => {
        if (cypher.includes('InterestProfile')) {
          return { records: [{ topics: ['agentic ai'] }] };
        }
        return { records: [] };
      });
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'RAG Pipelines', topic: 'agentic-memory', seedConcepts: 1 },
        { keyword: 'Agent X', topic: 'agentic-ai', seedConcepts: 1 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 10, maxSignals: 30, now: NOW });

      // Assert
      expect(result.keywords).toContain('RAG Pipelines');
      expect(result.keywords).not.toContain('Agent X');
      expect(result.discoveryTopics).toEqual({ 'RAG Pipelines': 'agentic-memory' });
    });

    it('caps injected discovery keywords at DISCOVERY_SLOTS (3) even with more eligible candidates', async () => {
      // Arrange
      mockRichFixture();
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'kw1', topic: 'novel-1', seedConcepts: 6 },
        { keyword: 'kw2', topic: 'novel-2', seedConcepts: 5 },
        { keyword: 'kw3', topic: 'novel-3', seedConcepts: 4 },
        { keyword: 'kw4', topic: 'novel-4', seedConcepts: 3 },
        { keyword: 'kw5', topic: 'novel-5', seedConcepts: 2 },
        { keyword: 'kw6', topic: 'novel-6', seedConcepts: 1 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 10, maxSignals: 30, now: NOW });

      // Assert — exactly 3 (DISCOVERY_SLOTS) of the 6 eligible candidates are injected, first-ranked-first
      expect(Object.keys(result.discoveryTopics)).toHaveLength(3);
      expect(result.keywords).toEqual(expect.arrayContaining(['kw1', 'kw2', 'kw3']));
      expect(result.keywords).not.toContain('kw4');
    });

    it('keeps the lane OFF when only feedbackEnabled is true (adjacentDiscoveryEnabled false)', async () => {
      // Arrange
      mockRichFixture();
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: false });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'RAG Pipelines', topic: 'agentic-memory', seedConcepts: 2 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 3, maxSignals: 30, now: NOW });

      // Assert
      expect(result.discoveryTopics).toEqual({});
      expect(mockGetAdjacentDiscoveryTopics).not.toHaveBeenCalled();
    });

    it('keeps the lane OFF when only adjacentDiscoveryEnabled is true (feedbackEnabled false)', async () => {
      // Arrange
      mockRichFixture();
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: false, adjacentDiscoveryEnabled: true });
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: 'RAG Pipelines', topic: 'agentic-memory', seedConcepts: 2 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ limit: 3, maxSignals: 30, now: NOW });

      // Assert
      expect(result.discoveryTopics).toEqual({});
      expect(mockGetAdjacentDiscoveryTopics).not.toHaveBeenCalled();
    });

    it('short-circuits before the discovery lane on cold start (no candidates at all)', async () => {
      // Arrange
      mockRunReadTransaction.mockResolvedValue({ records: [] });
      mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 20, now: NOW });

      // Assert
      expect(result).toEqual({ keywords: DEFAULT_KEYWORDS, discoveryTopics: {} });
      expect(mockGetAdjacentDiscoveryTopics).not.toHaveBeenCalled();
    });
  });
});
