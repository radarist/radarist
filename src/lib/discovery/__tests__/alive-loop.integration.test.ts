/**
 * @jest-environment node
 *
 * P5-A (H12+M17) — the alive-loop integration proof: a triage APPROVE must flow
 * through the REAL feedback → preference → selector chain and STRICTLY INCREASE
 * the approved class's ranking on the next selector read.
 *
 * Only the graph client (neo4j-client) and Firestore admin are faked (in-memory);
 * discovery-feedback, entity-topic, preferences, interest-profile, cold-start and
 * the selector all run their real code. This pins the key-space contract end to
 * end: the feedback WRITE key must be one the selector's READ side (meaningfulTags)
 * actually consults. Before M17 the write keyed on the raw first tag (stopwords
 * included, e.g. 'competitor'), which the selector never reads for baseScore but
 * DOES count for the exploration bonus — so approving an entity LOWERED its
 * class's score (inverted learning). This test fails red on that inversion.
 */
export {};

// ---------------------------------------------------------------------------
// In-memory graph fake (the ONLY mocked layer besides Firestore admin + config)
// ---------------------------------------------------------------------------

interface PrefRow {
  acted: number;
  dismissed: number;
}
const prefStore = new Map<string, PrefRow>(); // key: `${userId}|${topic}`
const profileStore = new Map<string, { vertical: string; topics: string[] }>();

function emptySummary() {
  return {
    counters: {
      nodesCreated: 0,
      nodesDeleted: 0,
      relationshipsCreated: 0,
      relationshipsDeleted: 0,
      propertiesSet: 1,
    },
    queryType: 'rw',
    resultAvailableAfter: 0,
    resultConsumedAfter: 0,
  };
}

jest.mock('@/lib/graph/neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: async (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('MERGE (up:UserPreference')) {
      const key = `${params.userId}|${params.topic}`;
      const existing = prefStore.get(key);
      if ('action' in params) {
        // trackInsightEngagement — MERGE + conditional counter bump.
        const action = params.action as 'acted' | 'dismissed';
        if (!existing) {
          prefStore.set(key, {
            acted: action === 'acted' ? 1 : 0,
            dismissed: action === 'dismissed' ? 1 : 0,
          });
        } else if (action === 'acted') {
          existing.acted += 1;
        } else {
          existing.dismissed += 1;
        }
      } else if ('seed' in params && !existing) {
        // seedPreferenceWeight — ON CREATE only (never clobbers earned counts).
        prefStore.set(key, { acted: params.seed as number, dismissed: 0 });
      }
      return { records: [], summary: emptySummary() };
    }
    if (cypher.includes('MATCH (up:UserPreference') && 'delta' in params) {
      // adjustInsightEngagement — MATCH-only (silent no-op on a missing row).
      const key = `${params.userId}|${params.topic}`;
      const existing = prefStore.get(key);
      if (existing) {
        const field = cypher.includes('target.dismissed_count = CASE') ? 'dismissed' : 'acted';
        existing[field] = Math.max(0, existing[field] + (params.delta as number));
      }
      return { records: [], summary: emptySummary() };
    }
    if (cypher.includes('MERGE (ip:InterestProfile')) {
      const userId = params.userId as string;
      if ('vertical' in params) {
        const existingTopics = profileStore.get(userId)?.topics ?? [];
        const incomingTopics = params.topics as string[];
        const topics = 'maxTopics' in params ? [...new Set([...existingTopics, ...incomingTopics])] : incomingTopics;
        profileStore.set(userId, { vertical: params.vertical as string, topics });
      } else if (!profileStore.has(userId)) {
        // touchInterestProfile ensures the subgraph exists.
        profileStore.set(userId, { vertical: '', topics: [] });
      }
      return { records: [], summary: emptySummary() };
    }
    return { records: [], summary: emptySummary() };
  },
  runReadTransaction: async (cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('MATCH (ip:InterestProfile')) {
      const profile = profileStore.get(params.userId as string);
      return {
        records: profile
          ? [{ userId: params.userId, vertical: profile.vertical, topics: profile.topics, updatedAt: 'now' }]
          : [],
        summary: emptySummary(),
      };
    }
    if (cypher.includes('MATCH (up:UserPreference')) {
      // getUserPreferences — weight = (acted - dismissed*0.5) / max(1, total).
      const records = [...prefStore.entries()]
        .filter(([key]) => key.startsWith(`${params.userId}|`))
        .map(([key, row]) => {
          const total = row.acted + row.dismissed;
          return {
            topic: key.split('|')[1],
            weight: (row.acted - row.dismissed * 0.5) / Math.max(1, total),
            actedCount: row.acted,
            dismissedCount: row.dismissed,
          };
        })
        .sort((a, b) => b.weight - a.weight);
      return { records, summary: emptySummary() };
    }
    return { records: [], summary: emptySummary() };
  },
}));

// ---------------------------------------------------------------------------
// Firestore admin fake — both the entity-topic doc read and the selector's
// whole-collection candidate scan read from this map.
// ---------------------------------------------------------------------------

const firestoreDocs: Record<string, Record<string, { name: string; tags: string[] }>> = {
  technologies: {
    // 'Competitor' is a TAG_STOPWORD and deliberately FIRST — the M17 trap.
    't-approved': { name: 'ApprovedTech', tags: ['Competitor', 'Vector Database'] },
    't-other': { name: 'SameClassTech', tags: ['Competitor', 'Vector Database'] },
    't-unrelated': { name: 'UnrelatedTech', tags: ['Quantum Sensing'] },
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (c: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: Boolean(firestoreDocs[c]?.[id]),
          data: () => firestoreDocs[c]?.[id],
        }),
      }),
      get: async () => ({
        docs: Object.entries(firestoreDocs[c] ?? {}).map(([id, data]) => ({ id, data: () => data })),
      }),
    }),
  },
}));

jest.mock('@/lib/proposed-assessments-admin', () => ({ getProposedAssessments: async () => [] }));
jest.mock('@/lib/proposed-entities-admin', () => ({ getProposedEntities: async () => [] }));
jest.mock('@/lib/proposed-relations-admin', () => ({ getProposedRelations: async () => [] }));
jest.mock('../discovery-config', () => ({
  __esModule: true,
  getDiscoveryConfig: () => ({
    feedbackEnabled: true,
    explorationRate: 0.15,
    vertical: 'ai-ml-infra',
  }),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { recordProposalFeedback } = require('../discovery-feedback');
const { selectDiscoveryEntities } = require('../discovery-entity-selector');

type Candidate = { entityId: string; topic: string; baseScore: number; score: number };

const selectorOpts = { entityType: 'technology' as const, userId: 'u1', limit: 10 };

describe('alive loop — approve → posterior → selector (integration)', () => {
  beforeEach(() => {
    prefStore.clear();
    profileStore.clear();
    // The user already has an InterestProfile (cold-start done) so the selector runs.
    profileStore.set('u1', { vertical: 'ai-ml-infra', topics: [] });
  });

  it("M17: approving a proposal STRICTLY INCREASES the approved class's selector score", async () => {
    const before: Candidate[] = await selectDiscoveryEntities(selectorOpts);
    const s0 = before.find((c) => c.entityId === 't-other');
    expect(s0).toBeDefined();

    // Human approves an evaluation of a same-class entity ('Vector Database').
    await recordProposalFeedback('u1', 'prop-1', 'assessment', 't-approved', 'technology', 'approved');

    const after: Candidate[] = await selectDiscoveryEntities(selectorOpts);
    const s1 = after.find((c) => c.entityId === 't-other');
    expect(s1).toBeDefined();

    // The core alive-loop contract: positive feedback re-ranks the class UP.
    expect(s1!.score).toBeGreaterThan(s0!.score);
    // ...via the learned weight (the selector actually READ the posterior),
    expect(s1!.baseScore).toBeGreaterThan(0);
    // ...on the meaningful-tag key, not the stopword.
    expect(s1!.topic).toBe('vector-database');
    expect(prefStore.has('u1|vector-database')).toBe(true);
    expect(prefStore.has('u1|competitor')).toBe(false);
  });

  it('M17: a reasoned reject lands its negative signal on the meaningful-tag key (not the stopword)', async () => {
    await recordProposalFeedback('u1', 'prop-2', 'assessment', 't-approved', 'technology', 'rejected', 'low-quality');

    // The negative posterior must live on the SAME key the selector reads —
    // a 'competitor'-keyed row would be stranded (and invert the exploration bonus).
    expect(prefStore.get('u1|vector-database')).toEqual({ acted: 0, dismissed: 1 });
    expect(prefStore.has('u1|competitor')).toBe(false);
  });
});
