/**
 * @file gds-algorithms.ts
 * @description High-level wrappers around Neo4j GDS algorithms.
 *
 * Each function owns its own projection lifecycle via withProjection, so
 * callers just get the result. Results are stable — we re-project on every
 * run to reflect current Neo4j state.
 *
 * LICENCE NOTE (standing decision — see docs/LIMITATIONS.md): the Neo4j GDS
 * plugin is GPLv3 (a runtime plugin, not bundled into the MIT app source). FastRP
 * and Node2Vec embeddings are Enterprise-only and UNAVAILABLE on the targeted
 * `neo4j:5.15.0-community` image — so the discovery loop ships no learned
 * link-prediction ranker; its 2-hop generator uses pure Cypher traversal + a
 * confidence floor instead. GDS-backed proximity/dedup is hardening-track only.
 *
 * @phase Phase 5: GDS algorithms
 */

import neo4j from 'neo4j-driver';
import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { withProjection, DEFAULT_GRAPH_NAME } from './gds-projections';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/gds-algorithms');

// ============================================================================
// GDS AVAILABILITY GUARD
// ============================================================================

/**
 * Thrown when the Neo4j GDS plugin is not installed/loaded. Callers get a
 * clear, actionable error instead of an opaque `Unknown function` failure
 * mid-algorithm.
 */
export class GdsUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Neo4j GDS plugin unavailable — the gds.version() probe failed (${cause}). ` +
        `Install the Graph Data Science plugin on the Neo4j server (e.g. NEO4J_PLUGINS='["graph-data-science"]') ` +
        `or skip GDS-backed features.`
    );
    this.name = 'GdsUnavailableError';
  }
}

/**
 * Positive-only per-process cache: a confirmed-available plugin is not
 * re-probed, but a failed probe is retried on the next call so a transient
 * connection error can't permanently disable the GDS layer.
 */
let gdsAvailabilityVerified = false;

async function ensureGdsAvailable(): Promise<void> {
  if (gdsAvailabilityVerified) return;
  try {
    await runReadTransaction(`RETURN gds.version() AS version`, {});
    gdsAvailabilityVerified = true;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    log.warn('GDS availability probe failed', { error: cause });
    throw new GdsUnavailableError(cause);
  }
}

/** Test hook: clear the positive availability cache. */
export function __resetGdsAvailabilityForTests(): void {
  gdsAvailabilityVerified = false;
}

// ============================================================================
// LOUVAIN — community detection
// ============================================================================

export interface LouvainResult {
  communityCount: number;
  modularity: number;
  nodesWritten: number;
  topCommunities: Array<{ communityId: number; size: number }>;
}

/**
 * Run Louvain community detection on the default knowledge graph and
 * write the resulting community id to each node's `gdsCommunity` property.
 *
 * Returns modularity (quality 0..1) + top community sizes for reporting.
 */
export async function runLouvainCommunity(options: { topN?: number } = {}): Promise<LouvainResult> {
  const topN = options.topN ?? 10;

  await ensureGdsAvailable();

  return withProjection(DEFAULT_GRAPH_NAME, async (stats) => {
    const writeResult = await runWriteTransaction<{
      communityCount: number;
      modularity: number;
      nodesWritten: number;
    }>(
      `
      CALL gds.louvain.write($graphName, { writeProperty: 'gdsCommunity' })
      YIELD communityCount, modularity, nodePropertiesWritten
      RETURN communityCount, modularity, nodePropertiesWritten AS nodesWritten
      `,
      { graphName: stats.graphName }
    );

    const topResult = await runReadTransaction<{ communityId: number; size: number }>(
      `
      MATCH (n) WHERE n.gdsCommunity IS NOT NULL
      RETURN n.gdsCommunity AS communityId, count(*) AS size
      ORDER BY size DESC
      LIMIT toInteger($topN)
      `,
      { topN }
    );

    const rec = writeResult.records[0];
    const result: LouvainResult = {
      communityCount: rec?.communityCount ?? 0,
      modularity: rec?.modularity ?? 0,
      nodesWritten: rec?.nodesWritten ?? 0,
      topCommunities: topResult.records,
    };
    log.info('louvain complete', {
      communityCount: result.communityCount,
      modularity: result.modularity.toFixed(3),
    });
    return result;
  });
}

// ============================================================================
// NODE SIMILARITY — dedup candidate detection
// ============================================================================

export interface DupeCandidate {
  aId: string;
  aName: string;
  aLabel: string;
  bId: string;
  bName: string;
  bLabel: string;
  similarity: number;
}

/**
 * Run gds.nodeSimilarity.stream on the projection and return pairs with
 * Jaccard similarity >= threshold. Primarily used to surface duplicate
 * entities (e.g. the "angular × 66" pattern we manually cleaned earlier).
 *
 * Only returns pairs of the same label, since cross-label similarity
 * (e.g. a Technology similar to a Company) is not meaningful for dedup.
 */
export async function detectDuplicateCandidates(
  options: { threshold?: number; limit?: number; minDegree?: number } = {}
): Promise<DupeCandidate[]> {
  const threshold = options.threshold ?? 0.85;
  const limit = options.limit ?? 50;
  // Min-degree guard: prevents spurious Jaccard=1.0 matches from pairs
  // that both have only 1-2 shared neighbors (a low-signal coincidence,
  // not a real dupe). Requires both nodes to have at least this many
  // edges in the actual Neo4j graph.
  const minDegree = options.minDegree ?? 3;

  await ensureGdsAvailable();

  return withProjection(DEFAULT_GRAPH_NAME, async (stats) => {
    const result = await runReadTransaction<{
      aId: string;
      aName: string;
      aLabel: string;
      bId: string;
      bName: string;
      bLabel: string;
      similarity: number;
    }>(
      `
      CALL gds.nodeSimilarity.stream($graphName, {
        similarityCutoff: $threshold,
        degreeCutoff: toInteger($minDegree)
      })
      YIELD node1, node2, similarity
      WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity
      WITH a, b, similarity,
           [l IN labels(a) WHERE l IN ['Technology','Company','UseCase','PainPoint','Strategy','Signal','Prototype','Initiative','OrgUnit','Document']][0] AS aLabel,
           [l IN labels(b) WHERE l IN ['Technology','Company','UseCase','PainPoint','Strategy','Signal','Prototype','Initiative','OrgUnit','Document']][0] AS bLabel
      WHERE aLabel = bLabel
      RETURN a.id AS aId, a.name AS aName, aLabel,
             b.id AS bId, b.name AS bName, bLabel,
             similarity
      ORDER BY similarity DESC
      LIMIT toInteger($limit)
      `,
      { graphName: stats.graphName, threshold, limit, minDegree }
    );
    log.info('node similarity complete', { pairsFound: result.records.length, threshold });
    return result.records;
  });
}

// ============================================================================
// PAGE RANK — personalized for a user's radar placements
// ============================================================================

export interface PageRankHit {
  id: string;
  name: string;
  label: string;
  score: number;
}

/**
 * Run personalized PageRank with source nodes derived from a user's
 * radar placements. Returns top-K Technology nodes ranked by PPR score.
 *
 * If the user has no placements (or ids don't resolve in Neo4j),
 * falls back to a global PageRank with no personalization.
 */
export async function runPersonalizedPageRankForUser(
  sourceEntityIds: string[],
  options: { topN?: number; maxIterations?: number } = {}
): Promise<PageRankHit[]> {
  const topN = options.topN ?? 10;
  const maxIterations = options.maxIterations ?? 20;

  await ensureGdsAvailable();

  return withProjection(DEFAULT_GRAPH_NAME, async (stats) => {
    // Resolve source entity ids to internal node ids via gds.util.asNode
    const sourceNodes = await runReadTransaction<{ internalId: number }>(
      `
      UNWIND $ids AS id
      MATCH (n {id: id})
      RETURN id(n) AS internalId
      `,
      { ids: sourceEntityIds }
    );
    const internalIds = sourceNodes.records.map((r) => r.internalId);

    // GDS proc validation requires Integer (not Double). Wrap JS numbers
    // with neo4j.int() so they serialize as Neo4j Integer.
    const config: Record<string, unknown> = { maxIterations: neo4j.int(maxIterations) };
    if (internalIds.length > 0) {
      config.sourceNodes = internalIds.map((id) => neo4j.int(id));
    }

    const result = await runReadTransaction<{
      id: string;
      name: string;
      label: string;
      score: number;
    }>(
      `
      CALL gds.pageRank.stream($graphName, $config)
      YIELD nodeId, score
      WITH gds.util.asNode(nodeId) AS n, score
      WHERE 'Technology' IN labels(n)
      RETURN n.id AS id, n.name AS name, 'Technology' AS label, score
      ORDER BY score DESC
      LIMIT toInteger($topN)
      `,
      { graphName: stats.graphName, config, topN }
    );
    log.info('pagerank complete', { sourceCount: internalIds.length, topN });
    return result.records;
  });
}
