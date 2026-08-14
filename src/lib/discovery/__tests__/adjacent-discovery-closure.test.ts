/**
 * @jest-environment node
 *
 * @file adjacent-discovery-closure.test.ts
 * @description S12.5 — three-reaction-path acceptance test for the adjacent-discovery closure.
 *
 * Proves the S12 promise end to end: a user's reaction to a discovery signal actually changes
 * what gets fetched next. Exercises the REAL shipped `getAggregateInterestKeywords`
 * (src/lib/discovery/interest-keywords.ts) and REAL `deriveSignalTopic`
 * (src/lib/signals/signal-topic.ts), mocking only the IO seams: the Neo4j reads
 * (`runReadTransaction`), the adjacent-topic candidate source (`getAdjacentDiscoveryTopics`),
 * the discovery feature flags (`getDiscoveryConfig`), and the Firestore radar-entry lookup
 * (`@/lib/firebase-admin`'s `db`).
 *
 * Scenario A pins the key-space alignment that makes B/C/D meaningful: the topic a dislike
 * WRITES (via `deriveSignalTopic`'s `metadata.discoveryTopic` fallback) is the exact same
 * string the selection layer READS (the posterior gate in `getAggregateInterestKeywords`).
 * Before S12 these two key-spaces were disjoint, so a reaction never changed the next fetch.
 */
// NB: this file deliberately uses require() (not ES `import`) for every mocked module AND
// the two modules under test. `import` statements are hoisted above ALL other top-level
// statements by the CJS transform this project's Jest pipeline applies, which would run the
// `@/lib/firebase-admin` factory (capturing the `db` object below) before `db` is initialized
// (TDZ `ReferenceError`). Plain `require()` calls execute in textual order instead, matching
// the established pattern in signal-topic.test.ts.
const entriesByRadar: Record<string, Array<{ id: number; tags?: string[] }>> = {};
const db = {
  collection: (c: string) => ({
    doc: (radarId: string) => ({
      collection: (_sub: string) => ({
        get: async () => ({ docs: (entriesByRadar[radarId] ?? []).map((e) => ({ data: () => e })) }),
      }),
    }),
    _c: c,
  }),
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/graph/neo4j-client', () => ({ runReadTransaction: jest.fn() }));
jest.mock('@/lib/discovery/topic-adjacency', () => ({ getAdjacentDiscoveryTopics: jest.fn() }));
jest.mock('@/lib/discovery/discovery-config', () => ({ getDiscoveryConfig: jest.fn() }));

import type { Signal } from '@/lib/types';

// `typeof import(...)` is a type-only construct (erased entirely at compile time — no runtime
// module load, so it can't reintroduce the hoisting/TDZ issue) used to give the require()'d
// real implementations below their real signatures instead of an implicit `any`.
type GetAggregateInterestKeywordsFn = typeof import('@/lib/discovery/interest-keywords').getAggregateInterestKeywords;
type DeriveSignalTopicFn = typeof import('@/lib/signals/signal-topic').deriveSignalTopic;

const { runReadTransaction } = require('@/lib/graph/neo4j-client');
const { getAdjacentDiscoveryTopics } = require('@/lib/discovery/topic-adjacency');
const { getDiscoveryConfig } = require('@/lib/discovery/discovery-config');
const getAggregateInterestKeywords: GetAggregateInterestKeywordsFn =
  require('@/lib/discovery/interest-keywords').getAggregateInterestKeywords;
const deriveSignalTopic: DeriveSignalTopicFn = require('@/lib/signals/signal-topic').deriveSignalTopic;

const mockRunReadTransaction = runReadTransaction as jest.Mock;
const mockGetAdjacentDiscoveryTopics = getAdjacentDiscoveryTopics as jest.Mock;
const mockGetDiscoveryConfig = getDiscoveryConfig as jest.Mock;

/** Shared topic/keyword constants — the SAME strings on both the write side (a dislike/like
 *  recorded against a discovery signal) and the read side (the selection layer's posterior
 *  gate), so the key-space alignment scenario A proves is visible throughout B/C/D. */
const DISCOVERY_TOPIC = 'agentic-memory';
const DISCOVERY_KEYWORD = 'RAG Pipelines';
const NOW = Date.now();

/** A neutral reinforcement candidate present in every fixture below so `getAggregateInterestKeywords`
 *  doesn't short-circuit to DEFAULT_KEYWORDS on cold start — the discovery lane only ever runs
 *  after at least one reinforcement candidate survives the exclusion filter. */
const BASELINE_TOPIC = 'baseline-topic';

function sig(over: Record<string, unknown> = {}): Signal {
  return { id: 'sig-1', linkedEntities: {}, ...over } as unknown as Signal;
}

interface RouterFixture {
  interestTopics: string[];
  userPreferenceRecords: Array<{ topic: string; acted: number; dismissed: number; lastMillis: number }>;
  radarNames?: string[];
}

/**
 * Cypher-substring router mirroring the fixture pattern in interest-keywords.test.ts: routes
 * the four parallel reads (InterestProfile topics / UserPreference weights / RadarPlacement
 * technology names / RadarPlacement placement counts) to fixture data based on which query text
 * was passed in. 'placements' is checked before 'RadarPlacement' since the placement-count
 * Cypher also contains the substring 'RadarPlacement'.
 */
function mockCypherRouter(fixture: RouterFixture) {
  mockRunReadTransaction.mockImplementation(async (cypher: string) => {
    if (cypher.includes('UserPreference')) {
      return { records: fixture.userPreferenceRecords };
    }
    if (cypher.includes('placements')) {
      return { records: [] };
    }
    if (cypher.includes('InterestProfile')) {
      return { records: [{ topics: fixture.interestTopics }] };
    }
    if (cypher.includes('RadarPlacement')) {
      return { records: (fixture.radarNames ?? []).map((name) => ({ name })) };
    }
    return { records: [] };
  });
}

describe('adjacent-discovery closure (S12.5 acceptance)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true, adjacentDiscoveryEnabled: true });
  });

  describe('A. key-space alignment (the core of the fix)', () => {
    it('resolves a discovery-lane signal (no linked tech) to the exact topic string the selection layer gates on', async () => {
      // Arrange — a discovery signal carries no linked radar tech; its topic lives only in metadata.
      const signal = sig({ linkedEntities: {}, metadata: { discoveryTopic: DISCOVERY_TOPIC } });

      // Act
      const topic = await deriveSignalTopic(signal);

      // Assert — the WRITE key-space (what a reaction records) is byte-identical to
      // DISCOVERY_TOPIC, the READ key-space scenarios B/C gate suppression/graduation on.
      expect(topic).toBe(DISCOVERY_TOPIC);
    });
  });

  describe('B. dislike suppresses', () => {
    beforeEach(() => {
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: DISCOVERY_KEYWORD, topic: DISCOVERY_TOPIC, seedConcepts: 2 },
      ]);
    });

    it('injects the discovery keyword while the topic posterior is neutral (no prior reaction)', async () => {
      // Arrange — DISCOVERY_TOPIC has no UserPreference row at all (never reacted to).
      mockCypherRouter({
        interestTopics: [BASELINE_TOPIC],
        userPreferenceRecords: [{ topic: BASELINE_TOPIC, acted: 5, dismissed: 0, lastMillis: NOW }],
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert
      expect(result.keywords).toContain(DISCOVERY_KEYWORD);
      expect(result.discoveryTopics[DISCOVERY_KEYWORD]).toBe(DISCOVERY_TOPIC);
    });

    it('suppresses the same discovery keyword once a recorded dislike decays its topic posterior below EXCLUDE_BELOW', async () => {
      // Arrange — a fresh dislike against DISCOVERY_TOPIC: acted:0, dismissed:10 → weight -0.5,
      // ageDays 0 (no decay yet) → decayed -0.5, below the -0.25 EXCLUDE_BELOW gate.
      mockCypherRouter({
        interestTopics: [BASELINE_TOPIC],
        userPreferenceRecords: [
          { topic: BASELINE_TOPIC, acted: 5, dismissed: 0, lastMillis: NOW },
          { topic: DISCOVERY_TOPIC, acted: 0, dismissed: 10, lastMillis: NOW },
        ],
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — the dislike suppressed it: absent from both the keyword list and the
      // discovery topic map.
      expect(result.keywords).not.toContain(DISCOVERY_KEYWORD);
      expect(result.discoveryTopics).not.toHaveProperty(DISCOVERY_KEYWORD);
      expect(result.discoveryTopics).toEqual({});
    });
  });

  describe('C. like graduates', () => {
    it('promotes DISCOVERY_TOPIC to a normal reinforcement keyword and novelty-gates it out of the discovery lane', async () => {
      // Arrange — DISCOVERY_TOPIC is now BOTH a tracked InterestProfile topic AND carries a
      // strongly positive UserPreference posterior (a "like"): acted:8, dismissed:0 → weight 1.0.
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        { keyword: DISCOVERY_KEYWORD, topic: DISCOVERY_TOPIC, seedConcepts: 2 },
      ]);
      mockCypherRouter({
        interestTopics: [BASELINE_TOPIC, DISCOVERY_TOPIC],
        userPreferenceRecords: [
          { topic: BASELINE_TOPIC, acted: 5, dismissed: 0, lastMillis: NOW },
          { topic: DISCOVERY_TOPIC, acted: 8, dismissed: 0, lastMillis: NOW },
        ],
      });

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — graduated: present as a normal reinforcement keyword (the tag), never
      // re-injected as a discovery candidate (the novelty filter keeps a now-tracked topic
      // out of the discovery lane). The discovery `keyword` is the tech NAME, distinct from
      // the graduated topic tag, and must not surface anywhere in the output either.
      expect(result.keywords).toContain(DISCOVERY_TOPIC);
      expect(result.keywords).not.toContain(DISCOVERY_KEYWORD);
      expect(result.discoveryTopics).toEqual({});
    });
  });

  describe('D. ignore is stable (no churn, no double-inject)', () => {
    const VECTOR_SEARCH = { keyword: 'Vector Search', topic: 'vector-db', seedConcepts: 2 };
    const GRAPH_RAG = { keyword: 'Graph RAG', topic: 'graph-rag', seedConcepts: 1 };

    beforeEach(() => {
      mockCypherRouter({
        interestTopics: [BASELINE_TOPIC],
        userPreferenceRecords: [{ topic: BASELINE_TOPIC, acted: 5, dismissed: 0, lastMillis: NOW }],
      });
    });

    it('injects both untracked candidates ranked by seedConcepts, deterministically across repeated calls', async () => {
      // Arrange — two neutral, untracked candidates; DISCOVERY_SLOTS (3) has room for both.
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([VECTOR_SEARCH, GRAPH_RAG]);

      // Act
      const first = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });
      const second = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — both present, the higher-seedConcepts one orders first among the discovery
      // tail, and an identical repeat call is byte-identical (no rotation churn).
      expect(first.keywords).toContain('Vector Search');
      expect(first.keywords).toContain('Graph RAG');
      expect(first.keywords.indexOf('Vector Search')).toBeLessThan(first.keywords.indexOf('Graph RAG'));
      expect(second.keywords).toEqual(first.keywords);
    });

    it('does not double-inject a discovery candidate whose keyword collides with an already-selected reinforcement keyword', async () => {
      // Arrange — a discovery candidate claims the SAME keyword as the reinforcement fixture's
      // BASELINE_TOPIC, with a seedConcepts (5) high enough to win priority if not de-duplicated.
      mockGetAdjacentDiscoveryTopics.mockResolvedValue([
        VECTOR_SEARCH,
        GRAPH_RAG,
        { keyword: BASELINE_TOPIC, topic: 'x', seedConcepts: 5 },
      ]);

      // Act
      const result = await getAggregateInterestKeywords({ maxSignals: 30, now: NOW });

      // Assert — BASELINE_TOPIC appears exactly once (from reinforcement); the colliding
      // discovery candidate is dropped, not double-injected.
      expect(result.keywords.filter((k) => k === BASELINE_TOPIC)).toHaveLength(1);
      expect(result.discoveryTopics).not.toHaveProperty(BASELINE_TOPIC);
    });
  });
});
