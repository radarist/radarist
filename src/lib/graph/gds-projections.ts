/**
 * @file gds-projections.ts
 * @description Neo4j Graph Data Science (GDS) projection lifecycle helpers.
 *
 * All GDS algorithms (Louvain, PageRank, nodeSimilarity, etc.) need an
 * in-memory graph projection — a named snapshot of the subset of the
 * Neo4j graph we want to analyze. These helpers own the create/drop
 * lifecycle so algorithm code doesn't duplicate the boilerplate.
 *
 * Naming: every {@link withProjection} run projects under a unique
 * per-run name (`<base>-<suffix>`). A fixed shared name + drop-before-
 * project meant two concurrent GDS calls destroyed each other's
 * projection mid-algorithm (M7).
 *
 * Relationship types: GDS projection throws on tokens that don't exist in the
 * database, so the requested types are intersected with
 * `CALL db.relationshipTypes()` on every call (CRIT-3 — a single phantom
 * type like REQUIRES silently killed the entire GDS layer). The Cypher
 * projection includes only current, non-rejected relationships.
 *
 * @phase Phase 5: GDS algorithms
 */

import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { CLAIM_RELATION_PREDICATES } from './relation-registry';

const log = createLogger('graph/gds-projections');

/** Canonical base name for the default knowledge-graph projection. */
export const DEFAULT_GRAPH_NAME = 'kg-default';

/** Labels included in the default knowledge-graph projection. */
export const DEFAULT_NODE_LABELS = [
  'Technology',
  'Company',
  'UseCase',
  'PainPoint',
  'Strategy',
  'Signal',
  'Prototype',
  'Initiative',
  'OrgUnit',
  'Document',
];

/**
 * Typed domain relationships requested for the default projection.
 * Intersected with the live database's relationship types at projection
 * time — types listed here but absent from the DB are dropped (with a
 * warning), never passed to gds.graph.project.
 *
 * NOTE: this is a GDS-projection allow-list, not the predicate vocabulary —
 * see `src/lib/graph/relation-registry.ts` for the canonical
 * relation-type → Neo4j-predicate mapping.
 */
export const DEFAULT_RELATIONSHIP_TYPES = [...CLAIM_RELATION_PREDICATES];

export interface ProjectionStats {
  graphName: string;
  nodeCount: number;
  relationshipCount: number;
}

export const CURRENT_GDS_NODE_QUERY = `
  MATCH (node)
  WHERE any(label IN labels(node) WHERE label IN $labels)
  RETURN id(node) AS id
`;

export const CURRENT_GDS_RELATIONSHIP_QUERY = `
  MATCH (source)-[relationship]->(target)
  WHERE type(relationship) IN $relTypes
    AND relationship.t_invalidated IS NULL
    AND coalesce(relationship.claimStatus, 'curated') <> 'rejected'
    AND any(label IN labels(source) WHERE label IN $labels)
    AND any(label IN labels(target) WHERE label IN $labels)
  RETURN id(source) AS source, id(target) AS target
`;

/** Monotonic counter so two same-millisecond runs still get distinct names. */
let projectionRunCounter = 0;

/**
 * Build a collision-safe per-run projection name from a base name.
 * Monotonic counter + timestamp: unique within the process and across
 * (non-clock-skewed) restarts.
 */
export function uniqueProjectionName(baseName: string): string {
  projectionRunCounter += 1;
  return `${baseName}-${Date.now().toString(36)}-${projectionRunCounter}`;
}

/**
 * Check whether a named projection currently exists in GDS.
 */
export async function projectionExists(graphName: string = DEFAULT_GRAPH_NAME): Promise<boolean> {
  const result = await runReadTransaction<{ exists: boolean }>(
    `CALL gds.graph.exists($graphName) YIELD exists RETURN exists`,
    { graphName }
  );
  return result.records[0]?.exists === true;
}

/**
 * Fetch the relationship types that actually exist in the database.
 * Called once per projection (per-call, not per-process) so a projection
 * always reflects the current schema — types can appear between runs.
 */
async function fetchExistingRelationshipTypes(): Promise<Set<string>> {
  const result = await runReadTransaction<{ relationshipType: string }>(
    `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType`,
    {}
  );
  return new Set(result.records.map((r) => r.relationshipType));
}

/**
 * Create a knowledge-graph projection. Idempotent: drops any existing
 * projection with the same name before creating the fresh one, so callers
 * always get a projection reflecting current Neo4j state.
 *
 * CRIT-3: the requested relationship types are intersected with
 * `db.relationshipTypes()` first — gds.graph.project throws on unknown
 * tokens, and one phantom type (REQUIRES) aborted every nightly GDS run.
 */
export async function projectKnowledgeGraph(graphName: string = DEFAULT_GRAPH_NAME): Promise<ProjectionStats> {
  const existingTypes = await fetchExistingRelationshipTypes();
  const relTypes = DEFAULT_RELATIONSHIP_TYPES.filter((t) => existingTypes.has(t));
  const droppedTypes = DEFAULT_RELATIONSHIP_TYPES.filter((t) => !existingTypes.has(t));

  if (droppedTypes.length > 0) {
    log.warn('dropping projection relationship types not present in the database', {
      graphName,
      droppedTypes,
    });
  }
  if (relTypes.length === 0) {
    throw new Error(
      `Cannot project '${graphName}': none of the requested relationship types exist in the database ` +
        `(requested: ${DEFAULT_RELATIONSHIP_TYPES.join(', ')})`
    );
  }

  if (await projectionExists(graphName)) {
    await dropProjection(graphName);
  }

  const result = await runWriteTransaction<{
    graphName: string;
    nodeCount: number;
    relationshipCount: number;
  }>(
    `
    CALL gds.graph.project.cypher(
      $graphName,
      $nodeQuery,
      $relationshipQuery,
      {parameters: {labels: $labels, relTypes: $relTypes}}
    )
    YIELD graphName, nodeCount, relationshipCount
    RETURN graphName, nodeCount, relationshipCount
    `,
    {
      graphName,
      labels: DEFAULT_NODE_LABELS,
      relTypes,
      nodeQuery: CURRENT_GDS_NODE_QUERY,
      relationshipQuery: CURRENT_GDS_RELATIONSHIP_QUERY,
    }
  );

  const rec = result.records[0];
  log.info('gds projection created', {
    graphName,
    nodeCount: rec?.nodeCount,
    relationshipCount: rec?.relationshipCount,
    relationshipTypes: relTypes.length,
  });

  return {
    graphName: rec?.graphName ?? graphName,
    nodeCount: rec?.nodeCount ?? 0,
    relationshipCount: rec?.relationshipCount ?? 0,
  };
}

/**
 * Drop a named projection. Silent no-op if the projection doesn't exist.
 */
export async function dropProjection(graphName: string = DEFAULT_GRAPH_NAME): Promise<void> {
  await runWriteTransaction(
    `CALL gds.graph.drop($graphName, false)
     YIELD graphName
     RETURN graphName`,
    { graphName }
  );
  log.debug('gds projection dropped', { graphName });
}

/**
 * Project → run algorithm → drop. The projection gets a unique per-run
 * name derived from `baseName` (M7: a fixed shared name meant concurrent
 * runs destroyed each other's projection); the callback must target
 * `stats.graphName`. Always drops in a finally so GDS memory isn't leaked
 * between runs.
 */
export async function withProjection<T>(baseName: string, fn: (stats: ProjectionStats) => Promise<T>): Promise<T> {
  const graphName = uniqueProjectionName(baseName);
  const stats = await projectKnowledgeGraph(graphName);
  try {
    return await fn(stats);
  } finally {
    await dropProjection(graphName).catch((e) => {
      log.warn('projection drop failed', { graphName, error: e instanceof Error ? e.message : String(e) });
    });
  }
}
