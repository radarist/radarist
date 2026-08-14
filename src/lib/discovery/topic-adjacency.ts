/**
 * @file discovery/topic-adjacency.ts
 * @description Gated concept-adjacency discovery — turns the org's tracked
 * interest topics into a ranked list of adjacent-but-untracked Technology
 * keywords to seed signal fetching with.
 *
 * Live-data simulation determined the graph has NO `RELATED_CONCEPT`/`SIMILAR_TO`
 * edges and `gdsCommunity` is useless; the dense edge is `HAS_CONCEPT`
 * (Entity→`:Concept`). Free-form interest strings don't string-match nodes but
 * resolve to `Concept.canonicalName` after normalization. Two garbage sources
 * are gated out: (1) meta/hub concepts (`Competitor`, `Startup`, `Series A`…)
 * that fan out to everything and carry no topical signal, and (2) `:Company`
 * neighbors (a company name is a poor signal-search keyword) — restricted to
 * `:Technology` at the query level.
 *
 * Pure read module. Feeds a cron — NEVER throws; resolves to `[]` on failure.
 */

import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { createLogger } from '@/lib/logger';

import { deriveFeedbackTopic, TAG_STOPWORDS } from './candidate-topic';

const log = createLogger('discovery/topic-adjacency');

/** Concepts below this entity count are too idiosyncratic to be useful seeds. */
const CONCEPT_FANOUT_MIN = 2;
/** Concepts above this entity count are meta/hub concepts (fan out to everything). */
const CONCEPT_FANOUT_MAX = 40;
/** Default max candidates any ONE concept may contribute. */
const DEFAULT_PER_SEED_CAP = 3;

/** lowercase, hyphens→spaces, collapse whitespace runs, trim. */
const norm = (s: string): string => s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Meta/hub concepts that fan out to nearly every entity and carry no topical
 * signal — normalized union of `TAG_STOPWORDS` plus company-lifecycle terms
 * observed in live exploration data (funding stages, maturity descriptors).
 */
const ADJACENCY_META_STOP: Set<string> = new Set(
  [
    ...TAG_STOPWORDS,
    'series a',
    'series b',
    'series c',
    'seed',
    'angel',
    'pre seed',
    'ipo',
    'acquired',
    'public',
    'private',
    'startup',
    'enterprise',
    'growth',
    'mature',
    'emerging',
    'declining',
  ].map(norm)
);

/** Test-fixture entity names that must never leak into a discovery candidate. */
const TEST_FIXTURE_NAME = /e2e test|test tech \d|^test /i;

/** A ranked adjacent-but-untracked discovery candidate. */
export interface DiscoveryCandidate {
  keyword: string;
  topic: string;
  seedConcepts: number;
}

interface AdjacencyRecord {
  concept: string;
  name: string;
  tags: unknown;
}

/**
 * Ranks adjacent-but-untracked Technology keywords reachable from the org's
 * tracked interest topics via the `Concept.HAS_CONCEPT` fan-out, gating out
 * meta/hub concepts, already-radar-tracked names, and test fixtures. Ranked by
 * distinct concept-seed count (desc) then keyword (asc). Never throws — a read
 * failure (or any unexpected error) logs a warning and resolves to `[]` so a
 * Neo4j blip cannot crash the cron that calls this.
 */
export async function getAdjacentDiscoveryTopics(opts: {
  interestTopics: string[];
  trackedNames: string[];
  perSeedCap?: number;
}): Promise<DiscoveryCandidate[]> {
  const perSeedCap = opts.perSeedCap ?? DEFAULT_PER_SEED_CAP;

  try {
    const interestNorms = [...new Set(opts.interestTopics.map(norm))].filter(Boolean);
    const trackedLower = opts.trackedNames.map((n) => n.toLowerCase());

    if (interestNorms.length === 0) {
      return [];
    }

    const result = await runReadTransaction<AdjacencyRecord>(
      `MATCH (c:Concept)
       WHERE toLower(replace(c.canonicalName,'-',' ')) IN $interestNorms
         AND c.entityCount >= $fanMin AND c.entityCount <= $fanMax
       MATCH (c)<-[:HAS_CONCEPT]-(e:Technology)
       WHERE e.name IS NOT NULL AND e.tags IS NOT NULL AND size(e.tags) > 0
         AND NOT toLower(e.name) IN $trackedLower
       RETURN toLower(replace(c.canonicalName,'-',' ')) AS concept, e.name AS name, e.tags AS tags
       ORDER BY concept, name`,
      {
        interestNorms,
        fanMin: CONCEPT_FANOUT_MIN,
        fanMax: CONCEPT_FANOUT_MAX,
        trackedLower,
      }
    );

    const candidates = new Map<string, { topic: string; concepts: Set<string> }>();
    const acceptedByConcept = new Map<string, number>();

    for (const record of result.records) {
      const concept = norm(record.concept);
      const name = record.name;
      const tags = record.tags;

      if (ADJACENCY_META_STOP.has(concept)) continue;
      if (TEST_FIXTURE_NAME.test(name)) continue;
      if (Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'e2e-test')) continue;

      const topic = deriveFeedbackTopic(tags, 'technology');
      if (!topic || topic === 'technology') continue;

      if (trackedLower.includes(name.toLowerCase())) continue;

      const existing = candidates.get(name);
      if (existing) {
        if (existing.concepts.has(concept)) continue;
        const acceptedCount = acceptedByConcept.get(concept) ?? 0;
        if (acceptedCount >= perSeedCap) continue;
        existing.concepts.add(concept);
        acceptedByConcept.set(concept, acceptedCount + 1);
      } else {
        const acceptedCount = acceptedByConcept.get(concept) ?? 0;
        if (acceptedCount >= perSeedCap) continue;
        candidates.set(name, { topic, concepts: new Set([concept]) });
        acceptedByConcept.set(concept, acceptedCount + 1);
      }
    }

    const ranked = [...candidates.entries()].map(([keyword, { topic, concepts }]) => ({
      keyword,
      topic,
      seedConcepts: concepts.size,
    }));

    ranked.sort((a, b) => b.seedConcepts - a.seedConcepts || a.keyword.localeCompare(b.keyword));

    return ranked;
  } catch (error) {
    log.warn('getAdjacentDiscoveryTopics failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
