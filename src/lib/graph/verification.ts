/**
 * @file graph/verification.ts
 * @description Neo4j CRUD for VerificationResult / EdgeVerificationResult nodes.
 *
 * VerificationResult nodes track entity verification status from the
 * Defense Minister agent. Each result links to the verified entity
 * via a VERIFIES relationship.
 *
 * GRAPH-061 — a verifier result is a claim ABOUT a target, so it may never
 * outlive or drift from that target:
 *
 *   1. Writes are FAIL-CLOSED. Cypher's `CREATE … WITH … MATCH` still commits
 *      the CREATE when the MATCH finds nothing, so the old query minted a
 *      permanently dangling node whenever the target was absent. Both writers
 *      now MATCH the target FIRST and return zero records when it is missing,
 *      which raises `VerificationTargetMissingError` instead of persisting an
 *      unanchored result.
 *   2. Writes are GENERATION-BOUND. Each result records the target's
 *      `sourceFingerprint` at verification time (`targetGeneration`), so a
 *      delete-and-recreate of the same ID cannot silently present an old
 *      verdict as current — readers report it as `stale` instead.
 *   3. Reads traverse the binding rather than the scalar key, so a result whose
 *      target is gone is invisible to consumers even before a sweep runs.
 *
 * Deletion cascade and orphan reconciliation live alongside the deleters and in
 * `reconcileOrphanedVerificationResults` below:
 *
 *   - **Entity deletion** cascades INSIDE `deleteEntityFromGraph`
 *     (`assertions.ts`), in the same transaction as the endpoint, so a verdict
 *     can never survive a partially-applied delete. There is deliberately no
 *     second entity-cascade helper here: the one that used to exist had no
 *     production caller and was a copy of that Cypher free to drift from it.
 *   - **Relation projection teardown** cascades through
 *     `deleteVerificationResultsForRelation`, called by the relation sync after
 *     the typed edge is gone. An `EdgeVerificationResult` is a standalone node
 *     keyed by `relationId`, so nothing about deleting the edge reaches it.
 *
 * @phase Impulse v1.0 — Phase 3: Defense Minister
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/verification');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Raised when a verifier result cannot be anchored because its target is not
 * in the graph. Retryable: the graph projection may simply be lagging behind
 * Firestore, and the next attempt can succeed.
 */
export class VerificationTargetMissingError extends Error {
  public readonly targetKind: 'entity' | 'relation';
  public readonly targetId: string;

  constructor(targetKind: 'entity' | 'relation', targetId: string) {
    super(
      targetKind === 'entity'
        ? `Cannot record a verification result: entity ${targetId} is not present in the graph`
        : `Cannot record an edge verification result: relation ${targetId} has no projected edge in the graph`
    );
    this.name = 'VerificationTargetMissingError';
    this.targetKind = targetKind;
    this.targetId = targetId;
  }
}

export interface VerificationResultInput {
  entityId: string;
  status: 'verified' | 'unverified' | 'disputed';
  score: number;
  sourcesChecked: number;
  sourcesConfirming: number;
  sourcesContradicting: number;
  verifierModel: string;
  reasoning: string;
  strictnessLevel: 'lenient' | 'standard' | 'strict';
}

export interface VerificationResult extends VerificationResultInput {
  id: string;
  checkedAt: string;
  /**
   * The target's `sourceFingerprint` when the verdict was recorded. Absent on
   * pre-GRAPH-061 results and on targets that carry no fingerprint yet.
   */
  targetGeneration?: string;
  /**
   * True when `targetGeneration` is known and no longer matches the target's
   * current generation — the verdict describes content that has since changed.
   */
  stale?: boolean;
}

export interface EdgeVerificationResultInput {
  relationId: string;
  sourceEntityId: string;
  targetEntityId: string;
  status: 'verified' | 'unverified' | 'disputed';
  score: number;
  sourcesChecked: number;
  sourcesConfirming: number;
  sourcesContradicting: number;
  verifierModel: string;
  reasoning: string;
}

export interface EdgeVerificationResult extends EdgeVerificationResultInput {
  id: string;
  createdAt: string;
  /** The verified edge's `sourceFingerprint` when the verdict was recorded. */
  targetGeneration?: string;
  /** True when the edge's current generation no longer matches the verdict's. */
  stale?: boolean;
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Record an entity verification verdict, bound to the entity it describes.
 *
 * @throws VerificationTargetMissingError when the entity has no graph node —
 * nothing is written.
 */
export async function createVerificationResult(input: VerificationResultInput): Promise<VerificationResult> {
  const id = crypto.randomUUID();
  const checkedAt = new Date().toISOString();

  // MATCH first: an unanchored verdict must cost nothing and leave no node.
  const cypher = `
    MATCH (e { id: $entityId })
    WITH e ORDER BY coalesce(e.updatedAt, 0) DESC LIMIT 1
    CREATE (vr:VerificationResult {
      id: $id,
      entityId: $entityId,
      status: $status,
      score: $score,
      sourcesChecked: $sourcesChecked,
      sourcesConfirming: $sourcesConfirming,
      sourcesContradicting: $sourcesContradicting,
      verifierModel: $verifierModel,
      reasoning: $reasoning,
      strictnessLevel: $strictnessLevel,
      checkedAt: $checkedAt,
      targetGeneration: e.sourceFingerprint
    })
    MERGE (vr)-[:VERIFIES]->(e)
    RETURN vr.id AS id, vr.targetGeneration AS targetGeneration
  `;

  const result = await runWriteTransaction<{ id: string; targetGeneration: string | null }>(cypher, {
    id,
    ...input,
    checkedAt,
  });

  if (result.records.length === 0) {
    log.warn('Refused to record a verification result for a missing graph entity', {
      entityId: input.entityId,
      status: input.status,
    });
    throw new VerificationTargetMissingError('entity', input.entityId);
  }

  const targetGeneration = result.records[0]?.targetGeneration ?? undefined;

  log.info('Verification result created', {
    id,
    entityId: input.entityId,
    status: input.status,
    score: input.score,
    targetGeneration,
  });

  return { id, ...input, checkedAt, ...(targetGeneration ? { targetGeneration } : {}) };
}

// ============================================================================
// EDGE VERIFICATION
// ============================================================================

/**
 * Persist an EdgeVerificationResult for a typed relation.
 *
 * Relations are edges in Neo4j — not nodes — so we cannot create a
 * `:VERIFIES_EDGE` relationship from the result node to the edge. The result is
 * stored as a standalone node keyed by `relationId`; its liveness is therefore
 * enforced by (a) requiring the projected edge to exist at write time,
 * (b) explicit removal in every relation/endpoint deleter, and
 * (c) `reconcileOrphanedVerificationResults`.
 *
 * @throws VerificationTargetMissingError when the relation has no projected
 * edge between the two named endpoints — nothing is written.
 */
export async function createEdgeVerificationResult(
  input: EdgeVerificationResultInput
): Promise<EdgeVerificationResult> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const cypher = `
    MATCH (source { id: $sourceEntityId })-[edge { relationId: $relationId }]->(target { id: $targetEntityId })
    WITH edge ORDER BY coalesce(edge.updatedAt, 0) DESC LIMIT 1
    CREATE (evr:EdgeVerificationResult {
      id: $id,
      relationId: $relationId,
      sourceEntityId: $sourceEntityId,
      targetEntityId: $targetEntityId,
      status: $status,
      score: $score,
      sourcesChecked: $sourcesChecked,
      sourcesConfirming: $sourcesConfirming,
      sourcesContradicting: $sourcesContradicting,
      verifierModel: $verifierModel,
      reasoning: $reasoning,
      createdAt: $createdAt,
      targetGeneration: edge.sourceFingerprint
    })
    RETURN evr.id AS id, evr.targetGeneration AS targetGeneration
  `;

  const result = await runWriteTransaction<{ id: string; targetGeneration: string | null }>(cypher, {
    id,
    ...input,
    createdAt,
  });

  if (result.records.length === 0) {
    log.warn('Refused to record an edge verification result for a missing graph edge', {
      relationId: input.relationId,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
    });
    throw new VerificationTargetMissingError('relation', input.relationId);
  }

  const targetGeneration = result.records[0]?.targetGeneration ?? undefined;

  log.info('Edge verification result created', {
    id,
    relationId: input.relationId,
    status: input.status,
    score: input.score,
    targetGeneration,
  });

  return { id, ...input, createdAt, ...(targetGeneration ? { targetGeneration } : {}) };
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

export async function getVerificationForEntity(entityId: string): Promise<VerificationResult | null> {
  // Traverse VERIFIES rather than matching vr.entityId: a result whose target
  // was deleted must not be reported as this entity's current verdict, even
  // before the orphan sweep removes it.
  const cypher = `
    MATCH (vr:VerificationResult)-[:VERIFIES]->(e { id: $entityId })
    RETURN vr.id AS id, vr.status AS status, vr.score AS score,
           vr.sourcesChecked AS sourcesChecked,
           vr.sourcesConfirming AS sourcesConfirming,
           vr.sourcesContradicting AS sourcesContradicting,
           vr.verifierModel AS verifierModel,
           vr.reasoning AS reasoning,
           vr.strictnessLevel AS strictnessLevel,
           vr.checkedAt AS checkedAt,
           vr.entityId AS entityId,
           vr.targetGeneration AS targetGeneration,
           e.sourceFingerprint AS currentGeneration
    ORDER BY vr.checkedAt DESC
    LIMIT 1
  `;

  const result = await runReadTransaction(cypher, { entityId });

  if (!result.records || result.records.length === 0) {
    return null;
  }

  const record = result.records[0];
  const targetGeneration = (record.targetGeneration as string | null) ?? undefined;
  const currentGeneration = (record.currentGeneration as string | null) ?? undefined;
  return {
    id: record.id as string,
    entityId: record.entityId as string,
    status: record.status as VerificationResult['status'],
    score: typeof record.score === 'object' ? (record.score as { low: number }).low : (record.score as number),
    sourcesChecked: record.sourcesChecked as number,
    sourcesConfirming: record.sourcesConfirming as number,
    sourcesContradicting: record.sourcesContradicting as number,
    verifierModel: record.verifierModel as string,
    reasoning: record.reasoning as string,
    strictnessLevel: record.strictnessLevel as VerificationResult['strictnessLevel'],
    checkedAt: record.checkedAt as string,
    ...(targetGeneration ? { targetGeneration } : {}),
    // Only a KNOWN mismatch is stale. A legacy result with no recorded
    // generation, or a target with no fingerprint, stays unlabelled rather
    // than being guessed either way.
    ...(targetGeneration && currentGeneration ? { stale: targetGeneration !== currentGeneration } : {}),
  };
}

// ============================================================================
// LIFECYCLE — CASCADE + RECONCILIATION (GRAPH-061)
// ============================================================================

export interface VerificationCascadeResult {
  entityResultsDeleted: number;
  edgeResultsDeleted: number;
}

/**
 * Remove every `EdgeVerificationResult` for a relation whose projection is
 * being torn down. Keyed by `relationId` because the edge itself is gone by
 * the time the sweep would otherwise notice.
 */
export async function deleteVerificationResultsForRelation(relationId: string): Promise<number> {
  const cypher = `
    MATCH (evr:EdgeVerificationResult { relationId: $relationId })
    WITH collect(evr) AS results, count(evr) AS deleted
    FOREACH (node IN results | DETACH DELETE node)
    RETURN deleted
  `;
  const result = await runWriteTransaction<{ deleted: number }>(cypher, { relationId });
  return result.records[0]?.deleted ?? 0;
}

export interface OrphanedVerificationCensus {
  entityResults: number;
  edgeResults: number;
}

/**
 * Count verifier results whose target no longer exists. Read-only — used by the
 * graph health gate and by the reconciler to report what it is about to remove.
 */
export async function countOrphanedVerificationResults(): Promise<OrphanedVerificationCensus> {
  const cypher = `
    CALL {
      MATCH (vr:VerificationResult)
      WHERE NOT (vr)-[:VERIFIES]->()
      RETURN count(vr) AS entityResults, 0 AS edgeResults
      UNION ALL
      MATCH (evr:EdgeVerificationResult)
      WHERE NOT EXISTS { MATCH ()-[edge { relationId: evr.relationId }]->() }
      RETURN 0 AS entityResults, count(evr) AS edgeResults
    }
    RETURN sum(entityResults) AS entityResults, sum(edgeResults) AS edgeResults
  `;
  const result = await runReadTransaction<OrphanedVerificationCensus>(cypher);
  return {
    entityResults: result.records[0]?.entityResults ?? 0,
    edgeResults: result.records[0]?.edgeResults ?? 0,
  };
}

/**
 * Delete verifier results whose target no longer exists.
 *
 * This is the backstop for results that predate the cascade (or were written by
 * a path that crashed between the two writes). A `VerificationResult` is
 * orphaned when it has no `VERIFIES` binding; an `EdgeVerificationResult` is
 * orphaned when no projected edge carries its `relationId`.
 */
export async function reconcileOrphanedVerificationResults(): Promise<VerificationCascadeResult> {
  const entityCypher = `
    MATCH (vr:VerificationResult)
    WHERE NOT (vr)-[:VERIFIES]->()
    WITH collect(vr) AS results, count(vr) AS deleted
    FOREACH (node IN results | DETACH DELETE node)
    RETURN deleted
  `;
  const edgeCypher = `
    MATCH (evr:EdgeVerificationResult)
    WHERE NOT EXISTS { MATCH ()-[edge { relationId: evr.relationId }]->() }
    WITH collect(evr) AS results, count(evr) AS deleted
    FOREACH (node IN results | DETACH DELETE node)
    RETURN deleted
  `;

  const entityResult = await runWriteTransaction<{ deleted: number }>(entityCypher);
  const edgeResult = await runWriteTransaction<{ deleted: number }>(edgeCypher);

  const cascade: VerificationCascadeResult = {
    entityResultsDeleted: entityResult.records[0]?.deleted ?? 0,
    edgeResultsDeleted: edgeResult.records[0]?.deleted ?? 0,
  };

  if (cascade.entityResultsDeleted > 0 || cascade.edgeResultsDeleted > 0) {
    log.info('Removed orphaned verifier results', {
      entityResultsDeleted: cascade.entityResultsDeleted,
      edgeResultsDeleted: cascade.edgeResultsDeleted,
    });
  }

  return cascade;
}
