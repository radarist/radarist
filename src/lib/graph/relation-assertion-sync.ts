/**
 * @file relation-assertion-sync.ts
 * @description Honour the Relation Write Contract when a Firestore Relation
 * is synced to Neo4j. Every typed edge that lands in the graph via this path
 * is backed by an :Assertion node (and optionally :Evidence) with temporal
 * fields, confidence, provenance, and a stable `relationId` back-pointer.
 *
 * A bare typed edge copied directly from Firestore bypasses the assertion
 * contract. This module replaces that path.
 *
 * @updated 2026-04-18 - :Claim vocabulary renamed to :Assertion across the
 * codebase. Cypher literals emit :Assertion; the migration file still matches
 * both labels for the historical case.
 */
import { runWriteTransaction } from './neo4j-client';
import {
  addEvidenceToAssertion,
  deriveAsserterType,
  getAssertion,
  materializeAssertionAsEdge,
  shouldMaterializeAssertion,
} from './assertions';
import { applyCorroborationNudge } from './confidence-calibration';
import { getAsserterReliability } from './asserter-reliability';
import { relationTypeCypherSchema } from './validation';
import type { ClaimStatus, GraphAssertion, EvidenceInput } from './types';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId } from '@/lib/observability/correlation';
import { resolveRelationSourceFingerprint } from '@/lib/relation-source-version';

const log = createLogger('graph/relation-assertion-sync');

/**
 * Increment 2 (C4) upstream resolution: resolve the reliability bonus BEFORE
 * the materialization gate check. Flag off (default) or a reliability read
 * failure both resolve to bonus 0 — a byte-identical baseline with the
 * pre-C4 behavior. `getAsserterReliability` itself never throws, but this
 * wrapper adds a defense-in-depth try/catch so a future change there can
 * never turn a sync call into a hard failure.
 */
async function resolveReliabilityBonus(assertedBy: string): Promise<number> {
  if (!getDiscoveryConfig().asserterReliabilityEnabled) return 0;

  try {
    const { reliabilityBonus } = await getAsserterReliability(assertedBy);
    return reliabilityBonus;
  } catch (err) {
    log.warn('asserter reliability resolution failed — falling back to bonus 0', {
      assertedBy,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Input for syncing a Firestore Relation as an Assertion-backed typed edge.
 *
 * - `relationId` is the Firestore document ID and acts as the idempotency key:
 *   re-syncing a relation upserts the same Assertion, not a duplicate.
 * - `predicate` is the Neo4j relationship type (e.g. 'USES', 'VENDOR').
 * - `assertedBy` must be prefixed — 'agent:<name>', 'ai:<name>', or 'user:<id>'
 *   — so the downstream materialization can choose correct temporal/confidence
 *   defaults ('agent:' and 'ai:' both classify as machine asserters).
 * - `confidence` is 0–100 (matching Firestore Relation shape).
 */
export interface SyncRelationAsAssertionInput {
  relationId: string;
  /** Latest stable, opaque graph-operation trace. */
  correlationId?: string;
  /** Correlation half of the authoritative Firestore source generation. */
  sourceCorrelationId?: string;
  /** SHA-256 of the authoritative graph-driving Firestore generation. */
  sourceFingerprint?: string;
  subject: { id: string; type: string; name?: string };
  object: { id: string; type: string; name?: string };
  predicate: string;
  confidence: number;
  assertedBy: string;
  notes?: string | null;
  /** Durable justification, kept separate from operator-facing relation notes. */
  reasoningSummary?: string | null;
  evidence?: EvidenceInput[];
  /**
   * Firestore `Relation.claimStatus`. `'curated'` is the human-triage release
   * signal (F105): it lets a below-threshold agent-asserted assertion
   * materialize because a human reviewed/approved it. Only the human approve
   * paths stamp `curated` on an agent-asserted relation.
   */
  claimStatus?: ClaimStatus;
  /**
   * F134: the original lowercase relationType (e.g. 'mentions'). `predicate` is
   * the collapsed Neo4j type; this is stamped onto the edge as
   * `sourceRelationType` and used to scope temporal invalidation so distinct
   * relation types that collapse to the same predicate don't invalidate each
   * other.
   */
  sourceRelationType?: string;
}

function resolvePersistableCorrelationId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const correlationId = parseCorrelationId(value);
  if (!correlationId) {
    throw new Error('Invalid relation correlation ID');
  }
  return correlationId;
}

function resolvePersistableSourceVersion(input: SyncRelationAsAssertionInput): {
  sourceCorrelationId: string | null;
  sourceFingerprint: string | null;
} {
  const hasSourceCorrelationId = input.sourceCorrelationId !== undefined;
  const hasSourceFingerprint = input.sourceFingerprint !== undefined;
  if (hasSourceCorrelationId !== hasSourceFingerprint) {
    throw new Error('Relation source version must contain both correlation and fingerprint');
  }
  const sourceCorrelationId = resolvePersistableCorrelationId(input.sourceCorrelationId);
  const sourceFingerprint = resolveRelationSourceFingerprint(input.sourceFingerprint) ?? null;
  return { sourceCorrelationId, sourceFingerprint };
}

/**
 * M4: Current document sync creates `:Document:Entity`, but older graph data
 * can still contain `:Document` without the shared label. Document endpoints
 * therefore MERGE on `:Document` and set `:Entity`, keeping legacy and current
 * write paths converged on one node without creating a shadow duplicate.
 */
function isDocumentEndpoint(type: string | undefined): boolean {
  return (type ?? '').toLowerCase() === 'document';
}

/**
 * Build the endpoint MERGE clause for a relation subject/object.
 *
 * @param alias - Cypher variable name (e.g. 's', 'subject')
 * @param side - which parameter family to reference ($subjectId / $objectId …)
 * @param endpointType - entity type of the endpoint ('document' gets the M4 treatment)
 * @param timestampParam - Cypher parameter carrying the write timestamp (millis)
 */
function buildEndpointMergeClause(
  alias: string,
  side: 'subject' | 'object',
  endpointType: string,
  timestampParam: string
): string {
  const mergeLabel = isDocumentEndpoint(endpointType) ? 'Document' : 'Entity';
  const labelPromotion = isDocumentEndpoint(endpointType) ? `\n    SET ${alias}:Entity` : '';
  return `MERGE (${alias}:${mergeLabel} {id: $${side}Id})
    ON CREATE SET
      ${alias}.entityType = $${side}Type,
      ${alias}.name = $${side}Name,
      ${alias}.syncedAt = ${timestampParam},
      ${alias}.firestoreUpdatedAt = ${timestampParam}${labelPromotion}`;
}

export interface SyncRelationAsAssertionResult {
  claimId: string;
  edgeType: string;
  edgeCreated: boolean;
  claimCreated: boolean;
  evidenceCreated: number;
  /**
   * True when the Relation Write Contract confidence gate withheld edge
   * materialization (agent/'ai:' asserter below confidence 75): the
   * :Assertion stays 'proposed' with no typed edge until a reviewer approves.
   */
  materializationSkipped?: boolean;
}

/**
 * Upsert an :Assertion keyed by Firestore relationId.
 *
 * Behaviour:
 * - If an Assertion with `relationId = $relationId` already exists, refresh its
 *   mutable fields (confidence, asserter, names, notes) and return it.
 * - Otherwise CREATE a new Assertion plus the surrounding structural edges
 *   (ABOUT_SUBJECT / ABOUT_OBJECT / HAS_PREDICATE / ASSERTED_BY) and the
 *   :RelationType / :Agent|:User nodes they terminate at.
 *
 * Kept here — not in claims.ts — because the idempotency-on-relationId is a
 * Firestore-sync concern, not a general Assertion creation concern.
 */
async function upsertAssertionByRelationId(
  input: SyncRelationAsAssertionInput
): Promise<{ claim: GraphAssertion; created: boolean }> {
  const asserterType: 'agent' | 'user' = deriveAsserterType(input.assertedBy);
  const asserterLabel = asserterType === 'agent' ? 'Agent' : 'User';
  const asserterName = input.assertedBy.split(':')[1] || input.assertedBy;
  const statement = `${input.subject.name ?? input.subject.id} ${input.predicate
    .replace(/_/g, ' ')
    .toLowerCase()} ${input.object.name ?? input.object.id}`;
  const now = Date.now();
  const invalidatedAt = new Date(now).toISOString();
  const assertionId = `claim-${now}-${Math.random().toString(36).slice(2, 9)}`;
  const claimStatus = input.claimStatus ?? null;
  const reasoningSummary = input.reasoningSummary ?? input.notes ?? null;
  const correlationId = resolvePersistableCorrelationId(input.correlationId);

  const cypher = `
    ${buildEndpointMergeClause('subject', 'subject', input.subject.type, '$now')}

    ${buildEndpointMergeClause('object', 'object', input.object.type, '$now')}

    MERGE (relType:RelationType {name: $predicate})
    ON CREATE SET relType.createdAt = $now, relType.isSystem = false

    MERGE (asserter:${asserterLabel} {id: $assertedBy})
    ON CREATE SET asserter.name = $asserterName, asserter.createdAt = $now

    MERGE (claim:Assertion {relationId: $relationId})
    ON CREATE SET
      claim.id = $assertionId,
      claim.statement = $statement,
      claim.confidence = $confidence,
      claim.assertedConfidence = $confidence,
      claim.effectiveConfidence = $confidence,
      claim.status = coalesce($claimStatus, 'proposed'),
      claim.reasoningSummary = $reasoningSummary,
      claim.createdAt = $now,
      claim.updatedAt = $now,
      claim.subjectId = $subjectId,
      claim.subjectType = $subjectType,
      claim.subjectName = $subjectName,
      claim.objectId = $objectId,
      claim.objectType = $objectType,
      claim.objectName = $objectName,
      claim.predicate = $predicate,
      claim.assertedBy = $assertedBy,
      claim.asserterType = $asserterType,
      claim.correlationId = $correlationId,
      claim.wasCreated = true
    ON MATCH SET
      claim.statement = $statement,
      claim.confidence = $confidence,
      claim.assertedConfidence = $confidence,
      claim.effectiveConfidence = coalesce(claim.effectiveConfidence, $confidence),
      // An omitted status means "metadata/topology refresh", not "reset the
      // review decision". This matters for legacy events that predate the
      // claimStatus field and for partial update events.
      claim.status = coalesce($claimStatus, claim.status, 'proposed'),
      claim.reasoningSummary = $reasoningSummary,
      claim.subjectId = $subjectId,
      claim.subjectType = $subjectType,
      claim.subjectName = $subjectName,
      claim.objectId = $objectId,
      claim.objectType = $objectType,
      claim.objectName = $objectName,
      claim.predicate = $predicate,
      claim.assertedBy = $assertedBy,
      claim.asserterType = $asserterType,
      claim.correlationId = coalesce($correlationId, claim.correlationId),
      claim.updatedAt = $now,
      claim.wasCreated = false

    WITH claim, subject, object, relType, asserter, claim.wasCreated AS wasCreated

    // Status and its typed projection are one Neo4j transaction. In
    // particular, a rejection can never commit on the Assertion while leaving
    // a current edge behind. Preserve the first invalidation time on replay.
    OPTIONAL MATCH ()-[statusEdge {claimId: claim.id}]->()
    WITH claim, subject, object, relType, asserter, wasCreated,
         collect(statusEdge) AS statusEdges
    FOREACH (edge IN statusEdges |
      SET edge.claimStatus = claim.status,
          edge.correlationId = coalesce($correlationId, edge.correlationId),
          edge.updatedAt = $now,
          edge.t_invalidated = CASE
            WHEN claim.status = 'rejected' THEN coalesce(edge.t_invalidated, $invalidatedAt)
            ELSE edge.t_invalidated
          END
    )
    WITH claim, subject, object, relType, asserter, wasCreated

    // Structural role edges carry no history or metadata. Delete every old
    // binding before recreating the current one so legacy duplicate role edges
    // collapse to exactly one as well as stale targets being removed.
    OPTIONAL MATCH (claim)-[oldSubject:ABOUT_SUBJECT]->()
    WITH claim, subject, object, relType, asserter, wasCreated,
         collect(oldSubject) AS oldSubjects
    FOREACH (r IN oldSubjects | DELETE r)
    WITH claim, subject, object, relType, asserter, wasCreated

    OPTIONAL MATCH (claim)-[oldObject:ABOUT_OBJECT]->()
    WITH claim, subject, object, relType, asserter, wasCreated,
         collect(oldObject) AS oldObjects
    FOREACH (r IN oldObjects | DELETE r)
    WITH claim, subject, object, relType, asserter, wasCreated

    OPTIONAL MATCH (claim)-[oldPredicate:HAS_PREDICATE]->()
    WITH claim, subject, object, relType, asserter, wasCreated,
         collect(oldPredicate) AS oldPredicates
    FOREACH (r IN oldPredicates | DELETE r)
    WITH claim, subject, object, relType, asserter, wasCreated

    OPTIONAL MATCH (claim)-[oldAsserter:ASSERTED_BY]->()
    WITH claim, subject, object, relType, asserter, wasCreated,
         collect(oldAsserter) AS oldAsserters
    FOREACH (r IN oldAsserters | DELETE r)
    WITH claim, subject, object, relType, asserter, wasCreated

    MERGE (claim)-[:ABOUT_SUBJECT]->(subject)
    MERGE (claim)-[:ABOUT_OBJECT]->(object)
    MERGE (claim)-[:HAS_PREDICATE]->(relType)
    MERGE (claim)-[:ASSERTED_BY]->(asserter)

    WITH DISTINCT claim, wasCreated

    // In-place topology edits are not temporal revisions: Firestore retains no
    // prior Relation revision to back an old projection. Delete obsolete edges
    // for this same relation/claim so history never points at a rewritten claim.
    OPTIONAL MATCH (oldSource)-[oldEdge]->(oldTarget)
    WHERE oldEdge.relationId = $relationId OR oldEdge.claimId = claim.id
    WITH claim, wasCreated, collect(oldEdge) AS projectionEdges
    FOREACH (r IN [edge IN projectionEdges WHERE
      coalesce(edge.claimId, '') <> claim.id OR
      coalesce(startNode(edge).id, '') <> $subjectId OR
      coalesce(endNode(edge).id, '') <> $objectId OR
      type(edge) <> $predicate
    ] | DELETE r)

    WITH claim, wasCreated
    RETURN claim, wasCreated
  `;

  const result = await runWriteTransaction<{ claim: GraphAssertion; wasCreated: boolean }>(cypher, {
    relationId: input.relationId,
    assertionId,
    statement,
    subjectId: input.subject.id,
    subjectType: input.subject.type,
    subjectName: input.subject.name ?? input.subject.id,
    objectId: input.object.id,
    objectType: input.object.type,
    objectName: input.object.name ?? input.object.id,
    predicate: input.predicate,
    confidence: input.confidence,
    reasoningSummary,
    claimStatus,
    assertedBy: input.assertedBy,
    asserterType,
    asserterName,
    now,
    invalidatedAt,
    correlationId,
  });

  const record = result.records[0];
  if (!record) {
    throw new Error(`upsertAssertionByRelationId failed: no record returned for relationId=${input.relationId}`);
  }
  return { claim: record.claim, created: record.wasCreated === true };
}

async function stampAssertionSourceVersion(
  claimId: string,
  relationId: string,
  input: SyncRelationAsAssertionInput
): Promise<void> {
  const { sourceCorrelationId, sourceFingerprint } = resolvePersistableSourceVersion(input);
  if (!sourceCorrelationId || !sourceFingerprint) return;

  const result = await runWriteTransaction<{ updated: number }>(
    `MATCH (claim:Assertion {id: $claimId, relationId: $relationId})
     SET claim.sourceCorrelationId = $sourceCorrelationId,
         claim.sourceFingerprint = $sourceFingerprint
     RETURN count(claim) AS updated`,
    { claimId, relationId, sourceCorrelationId, sourceFingerprint }
  );
  if (result.records[0]?.updated !== 1) {
    throw new Error(`Failed to finalize source version for Assertion ${claimId}`);
  }
}

/**
 * Detach-delete an Assertion plus its evidence plus the materialized typed edge
 * for a given Firestore relationId.
 *
 * Idempotent: running against a relationId with no Assertion in graph returns 0.
 *
 * @returns the number of :Assertion nodes removed (0 or 1)
 */
export async function deleteAssertionByRelationId(relationId: string): Promise<number> {
  const cypher = `
    OPTIONAL MATCH (claim:Assertion {relationId: $relationId})
    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    OPTIONAL MATCH ()-[edge {claimId: claim.id}]->()
    WITH claim, collect(DISTINCT evidence) AS ev, collect(DISTINCT edge) AS edges
    FOREACH (e IN ev | DETACH DELETE e)
    FOREACH (r IN edges | DELETE r)
    WITH claim
    WHERE claim IS NOT NULL
    DETACH DELETE claim
    RETURN count(claim) AS removed
  `;
  const result = await runWriteTransaction<{ removed: number }>(cypher, { relationId });
  return result.records[0]?.removed ?? 0;
}

/**
 * Full Assertion-first sync for a Firestore Relation.
 *
 * 1. Upsert the backing Assertion (idempotent on relationId)
 * 2. Attach Evidence — structured evidence from the caller if provided,
 *    else synthesize one from `notes` when notes are non-empty (so every
 *    agent-created Assertion has at least minimal Evidence).
 * 3. Materialize the typed edge via materializeAssertionAsEdge — which carries
 *    temporal + confidence + claimStatus per buildRelationDefaults. Gated by
 *    shouldMaterializeAssertion: machine assertions below confidence 75 keep
 *    the :Assertion at 'proposed' with no typed edge (reviewer approves later).
 *
 * Returns counters so the caller can surface them on the Inngest run output
 * (helpful for backfill observability).
 */
export async function syncRelationAsAssertion(
  input: SyncRelationAsAssertionInput
): Promise<SyncRelationAsAssertionResult> {
  const { claim, created } = await upsertAssertionByRelationId(input);
  // The database value is authoritative. In particular, an omitted incoming
  // status preserves an existing curated/rejected state in the upsert above.
  const currentClaimStatus = claim.status ?? input.claimStatus ?? 'proposed';

  let evidenceCreated = 0;
  const evidence = resolveEvidenceInput(input);
  // Evidence accrues on EVERY sync, not only first insert: addEvidenceToAssertion
  // MERGEs on (assertionId, sourceKey), so a re-sync of an already-seen source is
  // a no-op refresh while a genuinely new source attaches a new Evidence node —
  // this is what lets multiple independent sources corroborate one Assertion.
  if (evidence.length > 0) {
    for (const piece of evidence) {
      try {
        const r = await addEvidenceToAssertion(claim.id, piece);
        if (r.created) evidenceCreated++; // counter = NEW evidence only
      } catch (err) {
        log.warn('addEvidenceToAssertion failed', {
          claimId: claim.id,
          relationId: input.relationId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Source-version convergence is stamped only after every source-driven
        // write succeeds. Propagate the failure so Inngest retries instead of
        // leaving an Assertion that appears current while Evidence is missing.
        throw err;
      }
    }
  }

  // Relation Write Contract gate: machine assertions ('agent:*' / 'ai:*')
  // below confidence 75 stay 'proposed' with NO typed edge — a reviewer
  // approves them later (updateStatus → 'curated' in
  // sync-assertion-to-neo4j.ts materializes the withheld edge). F1
  // invalidation is also skipped: with no superseding edge written there is
  // nothing that supersedes the prior triple.
  //
  // Increment 2 (C4): resolveReliabilityBonus is a byte-identical no-op
  // (returns 0) unless ASSERTER_RELIABILITY_ENABLED is on AND the asserter
  // has an accrued track record — the gate call below is unconditionally
  // safe to make with the resolved bonus.
  const reliabilityBonus = await resolveReliabilityBonus(input.assertedBy);
  // F105: a human-curated claim (set by the triage Approve path) releases the
  // gate regardless of the machine-confidence threshold.
  if (
    !shouldMaterializeAssertion(input.confidence, input.assertedBy, {
      reliabilityBonus,
      claimStatus: currentClaimStatus,
    })
  ) {
    log.info('Edge materialization skipped by status/confidence gate', {
      claimId: claim.id,
      relationId: input.relationId,
      confidence: input.confidence,
      assertedBy: input.assertedBy,
      claimStatus: currentClaimStatus,
      reliabilityBonus,
    });

    // C3: no typed edge is going to be materialized on this path, so the
    // Assertion node is the only thing that can carry the nudge — apply it
    // here rather than skipping it. Best-effort: a failure here must never
    // abort the sync — the Assertion is already durably written above.
    try {
      await applyCorroborationNudge(input.relationId);
    } catch (err) {
      log.warn('corroboration nudge failed (non-fatal)', {
        claimId: claim.id,
        relationId: input.relationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await stampAssertionSourceVersion(claim.id, input.relationId, input);

    return {
      claimId: claim.id,
      edgeType: input.predicate,
      edgeCreated: false,
      claimCreated: created,
      evidenceCreated,
      materializationSkipped: true,
    };
  }

  // F1 temporal invalidation: before materialising the edge, mark any prior
  // edge for the same (subject, predicate, object) triple as invalidated.
  // We do this BEFORE the MERGE so a re-sync of the same relationId is a
  // no-op (the new edge's own relationId is excluded from invalidation).
  try {
    const { invalidatePriorEdges } = await import('./temporal-queries');
    await invalidatePriorEdges({
      subjectId: input.subject.id,
      predicate: input.predicate,
      objectId: input.object.id,
      excludeRelationId: input.relationId,
      // F134: scope invalidation to this relation's original type so a
      // sibling relation that collapses to the same Neo4j predicate is not
      // wrongly superseded.
      sourceRelationType: input.sourceRelationType,
    });
  } catch (err) {
    // Don't fail the write just because invalidation failed — log and proceed.
    log.warn('temporal invalidation failed (non-fatal)', {
      relationId: input.relationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // F134: stamp the original relationType onto the materialized edge so future
  // invalidations can scope to it.
  const correlationId = resolvePersistableCorrelationId(input.correlationId);
  const { sourceCorrelationId, sourceFingerprint } = resolvePersistableSourceVersion(input);
  const materialized = await materializeAssertionAsEdge(claim.id, {
    sourceRelationType: input.sourceRelationType,
    ...(correlationId ? { correlationId } : {}),
    ...(sourceCorrelationId ? { sourceCorrelationId } : {}),
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
  });
  if (!materialized) {
    // A concurrent rejection owns the final state. Treat the guarded refusal as
    // a successful withheld projection, while still failing loudly for a truly
    // missing Assertion or endpoint.
    const latest = await getAssertion(claim.id);
    if (latest?.status === 'rejected') {
      await stampAssertionSourceVersion(claim.id, input.relationId, input);
      return {
        claimId: claim.id,
        edgeType: input.predicate,
        edgeCreated: false,
        claimCreated: created,
        evidenceCreated,
        materializationSkipped: true,
      };
    }
    throw new Error(`materializeAssertionAsEdge returned null for assertion ${claim.id}`);
  }

  // C3: re-derive the corroboration nudge from the CURRENT evidence set
  // (not just what this call added — a re-sync with no new evidence still
  // recomputes from what's already attached) and mirror it onto both the
  // Assertion and the typed edge. Fires AFTER materialization so a
  // first-materialized edge inherits the nudge too (not just the Assertion
  // node it was upserted from). Best-effort: a failure here must never abort
  // the sync — the Assertion/edge are already durably written above.
  try {
    await applyCorroborationNudge(input.relationId);
  } catch (err) {
    log.warn('corroboration nudge failed (non-fatal)', {
      claimId: claim.id,
      relationId: input.relationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    claimId: claim.id,
    edgeType: materialized.edgeType,
    edgeCreated: materialized.created,
    claimCreated: created,
    evidenceCreated,
  };
}

function resolveEvidenceInput(input: SyncRelationAsAssertionInput): EvidenceInput[] {
  if (input.evidence && input.evidence.length > 0) return input.evidence;
  const annotation = input.reasoningSummary ?? input.notes;
  if (annotation && annotation.trim().length > 0) {
    return [
      {
        sourceType: 'user_assertion',
        snippet: annotation.slice(0, 500),
      },
    ];
  }
  return [];
}

// Exported for testing only — contract-tests can assert the shape of the
// statement / asserter derivation directly without going through the full
// write path.

const _testOnly = { resolveEvidenceInput };
// Silence the lint by exporting it; negligible runtime cost.
export { _testOnly };

// ============================================================================
// F3 — Direct edge write (curated, no Assertion node)
// ============================================================================

/**
 * Write path for curated edges that don't need a reified :Assertion. This
 * is the Graphiti-aligned default per the 2026-04-18 schema audit: edge
 * properties carry confidence/temporal/assertedBy/notes, no Assertion plumbing.
 *
 * Use when:
 *   - claimStatus is 'curated' or caller is explicitly human-curated
 *   - AND no structured snippet evidence needs to be preserved
 *
 * For agent-proposed edges or edges with real Evidence, keep using
 * {@link syncRelationAsAssertion} — the Assertion node is a genuine value-add there.
 *
 * Handles F1 temporal invalidation (marks prior same-triple edges as
 * t_invalidated) before the MERGE, matching the Assertion-first path.
 */
export async function syncRelationAsEdge(input: SyncRelationAsAssertionInput): Promise<{
  edgeType: string;
  edgeCreated: boolean;
}> {
  const predicate = input.predicate;
  const correlationId = resolvePersistableCorrelationId(input.correlationId);
  const { sourceCorrelationId, sourceFingerprint } = resolvePersistableSourceVersion(input);
  // Whitelist via shared schema (preserves throw-on-invalid behavior).
  relationTypeCypherSchema.parse(predicate);

  // F1: invalidate prior versions of this triple.
  try {
    const { invalidatePriorEdges } = await import('./temporal-queries');
    await invalidatePriorEdges({
      subjectId: input.subject.id,
      predicate,
      objectId: input.object.id,
      excludeRelationId: input.relationId,
      // F134: scope to the original relationType so a sibling relation that
      // collapses to the same Neo4j predicate isn't wrongly superseded.
      sourceRelationType: input.sourceRelationType,
    });
  } catch (err) {
    log.warn('temporal invalidation failed (non-fatal)', {
      relationId: input.relationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const now = new Date().toISOString();
  const asserterType: 'agent' | 'user' | 'system' =
    deriveAsserterType(input.assertedBy) === 'agent'
      ? 'agent'
      : input.assertedBy.startsWith('user:')
        ? 'user'
        : 'system';

  const cypher = `
    ${buildEndpointMergeClause('s', 'subject', input.subject.type, '$nowMs')}

    ${buildEndpointMergeClause('o', 'object', input.object.type, '$nowMs')}

    // A mutable Relation has one current projection. Remove a previous
    // endpoint/predicate/class projection inside the same transaction that
    // writes the replacement, so a failed rewrite leaves the old edge intact.
    WITH s, o
    OPTIONAL MATCH (oldSource)-[oldEdge]->(oldTarget)
    WHERE oldEdge.relationId = $relationId
      AND (
        coalesce(startNode(oldEdge).id, '') <> $subjectId OR
        coalesce(endNode(oldEdge).id, '') <> $objectId OR
        type(oldEdge) <> $predicate OR
        oldEdge.claimId IS NOT NULL
      )
    WITH s, o,
         [edge IN collect(oldEdge) WHERE
           coalesce(startNode(edge).id, '') <> $subjectId OR
           coalesce(endNode(edge).id, '') <> $objectId OR
           type(edge) <> $predicate OR
           edge.claimId IS NOT NULL
         ] AS obsoleteEdges
    FOREACH (edge IN obsoleteEdges | DELETE edge)

    // MERGE alone does not repair legacy duplicate relationships. Keep one
    // exact direct projection and remove the rest before the MERGE executes.
    WITH s, o
    OPTIONAL MATCH (s)-[exactEdge:\`${predicate}\` {relationId: $relationId}]->(o)
    WHERE exactEdge.claimId IS NULL
    WITH s, o, collect(exactEdge) AS exactEdges
    FOREACH (edge IN tail(exactEdges) | DELETE edge)

    MERGE (s)-[r:\`${predicate}\` {relationId: $relationId}]->(o)
    ON CREATE SET
      r.t_observed = $now,
      r.t_valid = $now,
      r.t_invalidated = null,
      r.confidence = $confidence,
      r.assertedConfidence = $confidence,
      r.effectiveConfidence = $confidence,
      r.claimStatus = 'curated',
      r.assertedBy = $assertedBy,
      r.aiSuggested = $aiSuggested,
      r.sourceRelationType = $sourceRelationType,
      r.correlationId = $correlationId,
      r.sourceCorrelationId = $sourceCorrelationId,
      r.sourceFingerprint = $sourceFingerprint,
      r.notes = $notes,
      r.createdAt = $nowMs,
      r.wasCreated = true
    ON MATCH SET
      r.confidence = $confidence,
      r.assertedConfidence = $confidence,
      r.effectiveConfidence = coalesce(r.effectiveConfidence, $confidence),
      r.notes = $notes,
      r.assertedBy = $assertedBy,
      r.claimStatus = 'curated',
      r.sourceRelationType = $sourceRelationType,
      r.correlationId = coalesce($correlationId, r.correlationId),
      r.sourceCorrelationId = coalesce($sourceCorrelationId, r.sourceCorrelationId),
      r.sourceFingerprint = coalesce($sourceFingerprint, r.sourceFingerprint),
      r.t_valid = $now,
      r.t_invalidated = null,
      r.updatedAt = $nowMs,
      r.wasCreated = false
    RETURN r.wasCreated AS created, type(r) AS edgeType
  `;

  const result = await runWriteTransaction<{ created: boolean; edgeType: string }>(cypher, {
    subjectId: input.subject.id,
    subjectType: input.subject.type,
    subjectName: input.subject.name ?? input.subject.id,
    objectId: input.object.id,
    objectType: input.object.type,
    objectName: input.object.name ?? input.object.id,
    relationId: input.relationId,
    predicate,
    now,
    nowMs: Date.now(),
    confidence: input.confidence,
    assertedBy: input.assertedBy,
    aiSuggested: asserterType === 'agent',
    sourceRelationType: input.sourceRelationType ?? null,
    notes: input.notes ?? null,
    correlationId,
    sourceCorrelationId,
    sourceFingerprint,
  });

  const row = result.records[0];
  return {
    edgeType: row?.edgeType ?? predicate,
    edgeCreated: row?.created === true,
  };
}
