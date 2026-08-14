/**
 * @file graph/temporal-queries.ts
 * @description Temporal edge query + invalidation service.
 *
 * Reads: queries edges with temporal metadata (t_valid, t_observed, t_invalidated).
 * Writes: invalidatePriorEdges() — the "supersede, never delete" operation
 *   used by the write path when a new version of a (subject, predicate, object)
 *   triple arrives.
 *
 * Edges without temporal fields are silently excluded from temporal reads
 * (they predate the temporal migration).
 *
 * @phase Impulse v1.0 — Phase 5: Temporal Knowledge (F1 — 2026-04-18)
 */

import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { relationTypeCypherSchema } from './validation';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/temporal');

// ============================================================================
// TYPES
// ============================================================================

export interface TemporalEdge {
  sourceId: string;
  targetId: string;
  relType: string;
  t_valid: string;
  t_observed: string;
  t_invalidated: string | null;
}

export interface TimelineEntry {
  relType: string;
  connectedEntityId: string;
  connectedEntityName: string;
  t_valid: string;
  t_observed: string;
  t_invalidated: string | null;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get edges that were observed (discovered by agents) since a given date.
 */
export async function getChangedSince(since: Date): Promise<TemporalEdge[]> {
  const cypher = `
    MATCH (a)-[r]->(b)
    WHERE r.t_observed IS NOT NULL AND r.t_observed > $since
    RETURN a.id AS sourceId, b.id AS targetId,
           type(r) AS relType, r.t_observed AS t_observed,
           r.t_valid AS t_valid, r.t_invalidated AS t_invalidated
    ORDER BY r.t_observed DESC
    LIMIT 100
  `;

  const result = await runReadTransaction(cypher, {
    since: since.toISOString(),
  });

  return result.records.map((r) => ({
    sourceId: (r.sourceId as string) ?? '',
    targetId: (r.targetId as string) ?? '',
    relType: (r.relType as string) ?? '',
    t_observed: String(r.t_observed ?? ''),
    t_valid: String(r.t_valid ?? ''),
    t_invalidated: r.t_invalidated ? String(r.t_invalidated) : null,
  }));
}

/**
 * Get the full relationship timeline for an entity, ordered by t_valid.
 */
export async function getEntityTimeline(entityId: string): Promise<TimelineEntry[]> {
  const cypher = `
    MATCH (a {id: $entityId})-[r]-(b)
    WHERE r.t_valid IS NOT NULL
    RETURN type(r) AS relType, b.id AS connectedEntityId,
           coalesce(b.name, b.title, '') AS connectedEntityName,
           r.t_valid AS t_valid, r.t_observed AS t_observed,
           r.t_invalidated AS t_invalidated
    ORDER BY r.t_valid ASC
  `;

  const result = await runReadTransaction(cypher, { entityId });

  return result.records.map((r) => ({
    relType: (r.relType as string) ?? '',
    connectedEntityId: (r.connectedEntityId as string) ?? '',
    connectedEntityName: (r.connectedEntityName as string) ?? '',
    t_valid: String(r.t_valid ?? ''),
    t_observed: String(r.t_observed ?? ''),
    t_invalidated: r.t_invalidated ? String(r.t_invalidated) : null,
  }));
}

// ============================================================================
// WRITES — supersede-never-delete invalidation
// ============================================================================

/**
 * Mark every edge with the same (subjectId, predicate, objectId) triple as
 * the incoming edge as `t_invalidated = now()`, excluding the incoming edge
 * itself (identified by relationId).
 *
 * Called from the write path right before MERGE so the new edge is the only
 * one with `t_invalidated IS NULL` for that triple. Gives us true temporal
 * truth queries ("what's still valid?") without deleting any history.
 *
 * @returns number of edges newly invalidated (0 if this is the first write
 *   for the triple, or if the existing edge is already invalidated).
 */
export async function invalidatePriorEdges(input: {
  subjectId: string;
  predicate: string;
  objectId: string;
  excludeRelationId?: string;
  /**
   * F134: the original lowercase relationType (e.g. 'mentions', 'about'). The
   * `predicate` above is the COLLAPSED Neo4j type — 32/50 relation types
   * resolve to the single `RELATED_TO` edge, so two semantically distinct
   * relations between the same ordered pair share one (s, RELATED_TO, o) match.
   * Without scoping, invalidating one supersedes the other's still-live edge.
   * When provided, invalidation is scoped to edges carrying the SAME
   * sourceRelationType, so distinct predicates that collapse together no longer
   * invalidate each other. Legacy edges that predate the sourceRelationType
   * stamp (coalesce → '') are left untouched by a real relationType — safe
   * under-invalidation rather than the prior unsafe over-invalidation.
   */
  sourceRelationType?: string;
}): Promise<number> {
  const { subjectId, predicate, objectId, excludeRelationId = '', sourceRelationType } = input;

  // Cypher can't parameterize relationship types. Validate against the
  // RelationType whitelist before interpolating.
  try {
    relationTypeCypherSchema.parse(predicate);
  } catch {
    log.warn('invalidatePriorEdges: refusing unsafe predicate', { predicate });
    return 0;
  }

  const cypher = `
    MATCH (s:Entity {id: $subjectId})-[r:\`${predicate}\`]->(o:Entity {id: $objectId})
    WHERE r.t_invalidated IS NULL
      AND coalesce(r.relationId, '') <> $excludeRelationId
      AND ($sourceRelationType IS NULL OR coalesce(r.sourceRelationType, '') = $sourceRelationType)
    SET r.t_invalidated = toString(datetime())
    RETURN count(r) AS n
  `;

  try {
    const result = await runWriteTransaction<{ n: number }>(cypher, {
      subjectId,
      predicate,
      objectId,
      excludeRelationId,
      sourceRelationType: sourceRelationType ?? null,
    });
    const n = result.records[0]?.n ?? 0;
    if (n > 0) {
      log.info('Invalidated prior edges', { subjectId, predicate, objectId, count: n });
    }
    return n;
  } catch (err) {
    log.warn('invalidatePriorEdges failed', {
      subjectId,
      predicate,
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
