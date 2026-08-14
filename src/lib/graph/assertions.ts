/**
 * @file claims.ts
 * @description Neo4j Assertion service for the Reified Assertion Model.
 *
 * This module provides CRUD operations for Assertions in Neo4j.
 * Assertions are first-class nodes representing relationships between entities
 * with evidence backing.
 *
 * Key Operations:
 * - Create/Read/Update/Delete Assertions
 * - Add Evidence to Assertions
 * - Query assertions for entities
 * - Explain connections between entities
 *
 * @phase Phase 4: Relations-as-Assertions (formerly Relations-as-Claims)
 * @author Radarist Team
 * @created 2026-01-09
 * @updated 2026-04-18 - renamed :Claim vocabulary to :Assertion (see 2026-04-18-schema-simplification migration)
 */

import neo4j from 'neo4j-driver';
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { buildRelationDefaults } from './relation-defaults';
import { currentEdgePredicate } from './current-edge-filter';
import { relationTypeCypherSchema } from './validation';
import type {
  GraphAssertion,
  GraphEvidence,
  GraphRelationType,
  GraphAgent,
  GraphUser,
  CreateAssertionInput,
  EvidenceInput,
  ClaimStatus,
  ConnectionExplanation,
  EntityAssertions,
  DocumentCitations,
  AssertionGraphStats,
} from './types';
import type { EntityType, TransformationEntityType } from '@/lib/types';
import { MACHINE_RELATION_MATERIALIZATION_THRESHOLD } from './materialization-policy';
import { ENTITY_TYPE_GRAPH_LABEL, expandEntityTypes } from './entity-type-vocab';
import { parseCorrelationId } from '@/lib/observability/correlation';
import { isUnresolvedGroundingRedirectUrl, UNRESOLVED_GROUNDING_REDIRECT_KEY } from '@/lib/signals/source-identity';
import { resolveRelationSourceFingerprint } from '@/lib/relation-source-version';

// ============================================================================
// ASSERTION CRUD OPERATIONS
// ============================================================================

/**
 * Derive the asserter type from an `assertedBy` identifier. Both 'agent:*'
 * (mission runtime) and 'ai:*' (AI assistant tools, e.g. 'ai:assistant' from
 * assertions-tools.ts) are machine asserters — they must classify as 'agent'
 * so the Relation Write Contract's confidence gate applies (agent claims
 * below 75 stay 'proposed' until a reviewer approves).
 */
export function deriveAsserterType(assertedBy: string): 'agent' | 'user' {
  return assertedBy.startsWith('agent:') || assertedBy.startsWith('ai:') ? 'agent' : 'user';
}

/**
 * Relation Write Contract gate: should an Assertion be materialized as a
 * typed edge right now? Machine asserters ('agent:*' / 'ai:*') below
 * confidence 75 (0–100 scale) stay 'proposed' with NO typed edge until a
 * reviewer approves (the approval path materializes via updateStatus →
 * 'curated' in sync-assertion-to-neo4j.ts). Human asserters always
 * materialize regardless of confidence.
 *
 * Single shared predicate for every materialization call site — keep the
 * threshold here, not inlined.
 *
 * `opts.reliabilityBonus` (Increment 2 / C4, flag-gated
 * `ASSERTER_RELIABILITY_ENABLED`, default off) is an OPTIONAL ±10 nudge
 * derived from an asserter's decayed approve/reject track record
 * (`asserter-reliability.ts`) — a consistently-approved asserter clears the
 * gate a little sooner, a consistently-rejected one needs more confidence.
 * The param is opt-in and backward-compatible: every existing call site
 * (and the Task 17 golden truth table, which omits opts entirely) sees
 * identical behavior — `opts?.reliabilityBonus ?? 0` is a no-op addend.
 *
 * `opts.claimStatus === 'curated'` (F105) is the primary-triage release valve:
 * a `curated` claim is human-reviewed and AUTHORITATIVE, so it materializes
 * regardless of the machine-confidence threshold. When a human approves a
 * proposed relation the approve path stamps `claimStatus:'curated'` on the
 * (still agent-asserted) relation; without honoring it here, the sub-75
 * agent-confidence gate silently withheld the typed edge the human just
 * approved. This is not a bypass: no aiSuggested machine CREATE path mints
 * `curated` (relation-defaults stamps agent writes `proposed`; the chat/MCP
 * write tools stamp `proposed`; `curateRelation` requires human context — see
 * F102/F106), so only a human decision reaches this branch.
 *
 * `opts.claimStatus === 'rejected'` (F137) NEVER materializes, regardless of
 * confidence or asserter: a re-sync of a rejected relation doc (e.g. a human
 * rejected it, then an unrelated field change re-triggers sync) must not
 * resurrect the typed edge a reviewer explicitly killed. Checked before the
 * confidence/asserter branch so a high-confidence or human-asserted rejected
 * claim still stays withheld.
 */
export function shouldMaterializeAssertion(
  confidence: number,
  assertedBy: string,
  opts?: { reliabilityBonus?: number; claimStatus?: string }
): boolean {
  if (opts?.claimStatus === 'rejected') return false;
  if (opts?.claimStatus === 'curated') return true;
  return (
    confidence + (opts?.reliabilityBonus ?? 0) >= MACHINE_RELATION_MATERIALIZATION_THRESHOLD ||
    deriveAsserterType(assertedBy) !== 'agent'
  );
}

/**
 * Creates a new Assertion node in Neo4j with optional evidence.
 *
 * @param input - Assertion creation input
 * @returns The created assertion
 *
 * @example
 * const assertion = await createAssertion({
 *   subject: { id: 'tech-1', type: 'technology', name: 'TensorFlow' },
 *   object: { id: 'uc-1', type: 'useCase', name: 'Machine Learning' },
 *   predicate: 'ADDRESSES',
 *   confidence: 85,
 *   assertedBy: 'agent:scout',
 *   evidence: [{ sourceType: 'signal', snippet: '...' }]
 * });
 */
export async function createAssertion(input: CreateAssertionInput): Promise<GraphAssertion> {
  const assertionId = `claim-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const now = Date.now();

  // Determine asserter type from assertedBy format ('agent:'/'ai:' → agent).
  const asserterType: 'agent' | 'user' = deriveAsserterType(input.assertedBy);

  const cypher = `
    // Ensure subject entity exists
    MERGE (subject:Entity {id: $subjectId})
    ON CREATE SET
      subject.entityType = $subjectType,
      subject.name = $subjectName,
      subject.syncedAt = $now,
      subject.firestoreUpdatedAt = $now

    // Ensure object entity exists
    MERGE (object:Entity {id: $objectId})
    ON CREATE SET
      object.entityType = $objectType,
      object.name = $objectName,
      object.syncedAt = $now,
      object.firestoreUpdatedAt = $now

    // Ensure relation type exists
    MERGE (relType:RelationType {name: $predicate})
    ON CREATE SET relType.createdAt = $now, relType.isSystem = false

    // Ensure asserter exists
    MERGE (asserter:${asserterType === 'agent' ? 'Agent' : 'User'} {id: $assertedBy})
    ON CREATE SET asserter.name = $asserterName, asserter.createdAt = $now

    // Create the assertion
    CREATE (claim:Assertion {
      id: $assertionId,
      statement: $statement,
      confidence: $confidence,
      assertedConfidence: $confidence,
      effectiveConfidence: $confidence,
      status: 'proposed',
      reasoningSummary: $reasoningSummary,
      createdAt: $now,
      updatedAt: $now,
      subjectId: $subjectId,
      subjectType: $subjectType,
      subjectName: $subjectName,
      objectId: $objectId,
      objectType: $objectType,
      objectName: $objectName,
      predicate: $predicate,
      assertedBy: $assertedBy,
      asserterType: $asserterType
    })

    // Create relationships
    CREATE (claim)-[:ABOUT_SUBJECT]->(subject)
    CREATE (claim)-[:ABOUT_OBJECT]->(object)
    CREATE (claim)-[:HAS_PREDICATE]->(relType)
    CREATE (claim)-[:ASSERTED_BY]->(asserter)

    RETURN claim
  `;

  // Extract asserter name from ID
  const asserterName = input.assertedBy.split(':')[1] || input.assertedBy;

  // Generate statement if not provided
  const statement =
    input.statement || `${input.subject.name} ${input.predicate.replace(/_/g, ' ').toLowerCase()} ${input.object.name}`;

  const result = await runWriteTransaction<{ claim: GraphAssertion }>(cypher, {
    assertionId,
    subjectId: input.subject.id,
    subjectType: input.subject.type,
    subjectName: input.subject.name,
    objectId: input.object.id,
    objectType: input.object.type,
    objectName: input.object.name,
    predicate: input.predicate,
    confidence: input.confidence,
    reasoningSummary: input.reasoningSummary || null,
    statement,
    assertedBy: input.assertedBy,
    asserterType,
    asserterName,
    now,
  });

  const assertion = result.records[0]?.claim;

  // Add evidence if provided
  if (input.evidence && input.evidence.length > 0) {
    for (const evidence of input.evidence) {
      await addEvidenceToAssertion(assertionId, evidence);
    }
  }

  return {
    ...assertion,
    id: assertionId,
    statement,
    confidence: input.confidence,
    assertedConfidence: input.confidence,
    effectiveConfidence: input.confidence,
    status: 'proposed',
    reasoningSummary: input.reasoningSummary,
    createdAt: now,
    updatedAt: now,
    subjectId: input.subject.id,
    subjectType: input.subject.type,
    subjectName: input.subject.name,
    objectId: input.object.id,
    objectType: input.object.type,
    objectName: input.object.name,
    predicate: input.predicate,
    assertedBy: input.assertedBy,
    asserterType,
  };
}

/**
 * Gets an assertion by ID.
 *
 * @param id - Assertion ID
 * @returns The assertion or null if not found
 */
export async function getAssertion(id: string): Promise<GraphAssertion | null> {
  const cypher = `
    MATCH (claim:Assertion {id: $id})
    RETURN claim
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, { id });
  return result.records[0]?.claim || null;
}

/**
 * Gets an assertion with its evidence.
 *
 * @param id - Assertion ID
 * @returns The assertion with evidence or null
 */
export async function getAssertionWithEvidence(id: string): Promise<{
  claim: GraphAssertion;
  evidence: GraphEvidence[];
} | null> {
  const cypher = `
    MATCH (claim:Assertion {id: $id})
    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    RETURN claim, collect(evidence) as evidence
  `;

  const result = await runReadTransaction<{
    claim: GraphAssertion;
    evidence: GraphEvidence[];
  }>(cypher, { id });

  if (!result.records[0]?.claim) return null;

  return {
    claim: result.records[0].claim,
    evidence: result.records[0].evidence.filter(Boolean),
  };
}

/**
 * Gets an assertion (with its evidence) by the Firestore relationId it backs.
 *
 * M3 / decision D9 (null-tolerant read): legacy Relation rows synced before
 * 2026-07 never had `claimId` written back, so provenance readers cannot
 * follow the pointer. The :Assertion node has always been keyed by
 * `relationId` (the sync upsert MERGEs on it), so this lookup recovers the
 * bridge for those rows without a data backfill.
 *
 * @param relationId - Firestore Relation document ID
 * @returns The assertion with evidence, or null when no Assertion backs it
 */
export async function getAssertionWithEvidenceByRelationId(relationId: string): Promise<{
  claim: GraphAssertion;
  evidence: GraphEvidence[];
} | null> {
  const cypher = `
    MATCH (claim:Assertion {relationId: $relationId})
    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    RETURN claim, collect(evidence) as evidence
  `;

  const result = await runReadTransaction<{
    claim: GraphAssertion;
    evidence: GraphEvidence[];
  }>(cypher, { relationId });

  if (!result.records[0]?.claim) return null;

  return {
    claim: result.records[0].claim,
    evidence: result.records[0].evidence.filter(Boolean),
  };
}

/**
 * Gets all assertions for an entity (as subject or object).
 *
 * @param entityId - Entity ID
 * @returns Assertions where entity is subject or object
 */
export async function getAssertionsForEntity(entityId: string): Promise<EntityAssertions> {
  const cypher = `
    MATCH (entity:Entity {id: $entityId})

    // Assertions where entity is subject
    OPTIONAL MATCH (claimAsSubject:Assertion)-[:ABOUT_SUBJECT]->(entity)

    // Assertions where entity is object
    OPTIONAL MATCH (claimAsObject:Assertion)-[:ABOUT_OBJECT]->(entity)

    RETURN
      collect(DISTINCT claimAsSubject) as asSubject,
      collect(DISTINCT claimAsObject) as asObject
  `;

  const result = await runReadTransaction<{
    asSubject: GraphAssertion[];
    asObject: GraphAssertion[];
  }>(cypher, { entityId });

  const asSubject = result.records[0]?.asSubject.filter(Boolean) || [];
  const asObject = result.records[0]?.asObject.filter(Boolean) || [];

  return {
    asSubject,
    asObject,
    totalCount: asSubject.length + asObject.length,
  };
}

/**
 * Gets all assertions between two specific entities.
 *
 * @param sourceId - Source entity ID
 * @param targetId - Target entity ID
 * @returns Array of assertions connecting the entities
 */
export async function getAssertionsBetweenEntities(sourceId: string, targetId: string): Promise<GraphAssertion[]> {
  const cypher = `
    MATCH (claim:Assertion)
    WHERE (claim.subjectId = $sourceId AND claim.objectId = $targetId)
       OR (claim.subjectId = $targetId AND claim.objectId = $sourceId)
    RETURN claim
    ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    sourceId,
    targetId,
  });

  return result.records.map((r) => r.claim);
}

/**
 * Updates an assertion's status.
 *
 * @param id - Assertion ID
 * @param status - New status
 * @param verifiedBy - Optional user who verified
 */
export async function updateAssertionStatus(id: string, status: ClaimStatus, verifiedBy?: string): Promise<void> {
  const now = Date.now();
  const invalidatedAt = new Date(now).toISOString();

  const cypher = `
    MATCH (claim:Assertion {id: $id})
    SET claim.status = $status,
        claim.updatedAt = $now
        ${verifiedBy ? ', claim.lastVerifiedAt = $now, claim.verifiedBy = $verifiedBy' : ''}
    WITH claim
    OPTIONAL MATCH ()-[edge {claimId: $id}]->()
    FOREACH (r IN CASE WHEN edge IS NULL THEN [] ELSE [edge] END |
      SET r.claimStatus = $status,
          r.updatedAt = $now,
          r.t_invalidated = CASE
            WHEN $status = 'rejected' THEN coalesce(r.t_invalidated, $invalidatedAt)
            ELSE r.t_invalidated
          END
    )
    RETURN claim, count(edge) AS edgesUpdated
  `;

  await runWriteTransaction(cypher, { id, status, now, invalidatedAt, verifiedBy: verifiedBy ?? null });
}

/**
 * Updates an assertion's confidence score.
 *
 * @param id - Assertion ID
 * @param confidence - New confidence (0-100)
 */
export async function updateAssertionConfidence(id: string, confidence: number): Promise<void> {
  // B0 two-field confidence authority: this is an asserter re-affirming their
  // claim, so assertedConfidence refreshes unconditionally; effectiveConfidence
  // (the system's belief) is only backfilled if absent — never clobbered.
  const cypher = `
    MATCH (claim:Assertion {id: $id})
    SET claim.confidence = $confidence,
        claim.assertedConfidence = $confidence,
        claim.effectiveConfidence = coalesce(claim.effectiveConfidence, $confidence),
        claim.updatedAt = $now
    RETURN claim
  `;

  await runWriteTransaction(cypher, { id, confidence, now: Date.now() });
}

/**
 * Deletes an assertion, its associated evidence, and every verifier verdict
 * that described the projection being removed (GRAPH-061).
 *
 * @param id - Assertion ID
 */
export async function deleteAssertion(id: string): Promise<void> {
  const cypher = `
    OPTIONAL MATCH (claim:Assertion {id: $id})
    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    WITH claim, collect(DISTINCT evidence) AS evidenceNodes
    OPTIONAL MATCH ()-[projection {claimId: $id}]->()
    WITH claim, evidenceNodes, collect(DISTINCT projection) AS projectionEdges
    // Read the relation coordinates BEFORE the edges are deleted — afterwards
    // there is nothing left that names them.
    WITH claim, evidenceNodes, projectionEdges,
         [edge IN projectionEdges WHERE edge.relationId IS NOT NULL | edge.relationId] AS relationIds
    OPTIONAL MATCH (edgeVerification:EdgeVerificationResult)
    WHERE edgeVerification.relationId IN relationIds
       OR (claim.relationId IS NOT NULL AND edgeVerification.relationId = claim.relationId)
    WITH claim, evidenceNodes, projectionEdges,
         collect(DISTINCT edgeVerification) AS edgeVerificationResults
    FOREACH (edge IN projectionEdges | DELETE edge)
    FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)
    FOREACH (node IN edgeVerificationResults | DETACH DELETE node)
    FOREACH (assertion IN CASE WHEN claim IS NULL THEN [] ELSE [claim] END | DETACH DELETE assertion)
  `;

  await runWriteTransaction(cypher, { id });
}

// ============================================================================
// EVIDENCE OPERATIONS
// ============================================================================

/**
 * Derives the stable source-identity key evidence accrual MERGEs on.
 *
 * Precedence: a URL is the strongest identity signal (same page cited twice
 * is the same source); a signal/document/chunk id is the next-best stable
 * handle; sourceType is the last-resort fallback (used by `user_assertion`,
 * which intentionally dedupes to exactly one Evidence node per Assertion —
 * see the Design locks note in relation-assertion-sync.ts).
 *
 * GRAPH-070 — one exception to "a URL is the strongest identity signal": an
 * unresolved Google grounding redirect is NOT a publisher identity. Two such
 * URLs may alias one article, so they share the reserved bucket key and dedupe
 * to exactly one Evidence node per Assertion, the same way `user_assertion`
 * does. The raw redirect is still stored as `sourceUrl` — it proves the page
 * was consulted; it just can never be counted as independent corroboration.
 * An explicit `sourceKey` still wins: callers carrying a stable per-ref key
 * (relation sync passes `ref.sourceKey ?? ref.id`) are already redirect-safe.
 */
function deriveEvidenceSourceKey(evidence: EvidenceInput): string {
  const entityFieldKey = evidence.entityId
    ? `entity:${evidence.entityType ?? 'unknown'}:${evidence.entityId}:${evidence.entityField ?? 'unknown'}`
    : undefined;
  const urlKey =
    evidence.sourceUrl !== undefined && isUnresolvedGroundingRedirectUrl(evidence.sourceUrl)
      ? UNRESOLVED_GROUNDING_REDIRECT_KEY
      : evidence.sourceUrl;
  return (
    evidence.sourceKey ??
    urlKey ??
    evidence.signalId ??
    evidence.documentId ??
    evidence.chunkId ??
    entityFieldKey ??
    evidence.sourceType
  );
}

/**
 * Adds evidence to support an assertion. Idempotent multi-source accrual:
 * MERGEs on (assertionId, sourceKey) so re-syncing the same source refreshes
 * the existing Evidence node (snippet + lastSeenAt) instead of duplicating
 * it, while a genuinely new source attaches a new Evidence node alongside
 * the existing ones — this is what enables corroboration counts across
 * multiple independent sources for the same Assertion.
 *
 * @param assertionId - Assertion ID
 * @param evidence - Evidence data
 * @returns The evidence node plus whether this call created it (`created:
 *   false` means an existing Evidence node for this (assertionId, sourceKey)
 *   was refreshed, not duplicated)
 */
export async function addEvidenceToAssertion(
  assertionId: string,
  evidence: EvidenceInput
): Promise<{ evidence: GraphEvidence; created: boolean }> {
  const evidenceId = `evidence-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const now = Date.now();
  const sourceKey = deriveEvidenceSourceKey(evidence);

  const cypher = `
    MATCH (claim:Assertion {id: $assertionId})
    MERGE (claim)-[:SUPPORTED_BY]->(evidence:Evidence {assertionId: $assertionId, sourceKey: $sourceKey})
    ON CREATE SET evidence.id = $evidenceId, evidence.sourceType = $sourceType, evidence.snippet = $snippet,
      evidence.sourceUrl = $sourceUrl, evidence.documentId = $documentId, evidence.chunkId = $chunkId,
      evidence.signalId = $signalId, evidence.entityId = $entityId, evidence.entityType = $entityType,
      evidence.entityField = $entityField, evidence.pageNumber = $pageNumber,
      evidence.relevanceScore = $relevanceScore, evidence.capturedAt = $now, evidence.wasCreated = true
    ON MATCH SET evidence.sourceType = $sourceType, evidence.snippet = $snippet,
      evidence.sourceUrl = $sourceUrl, evidence.documentId = $documentId, evidence.chunkId = $chunkId,
      evidence.signalId = $signalId, evidence.entityId = $entityId, evidence.entityType = $entityType,
      evidence.entityField = $entityField, evidence.pageNumber = $pageNumber,
      evidence.relevanceScore = coalesce($relevanceScore, evidence.relevanceScore),
      evidence.lastSeenAt = $now, evidence.wasCreated = false
    RETURN evidence, evidence.wasCreated AS wasCreated
  `;

  const result = await runWriteTransaction<{ evidence: GraphEvidence; wasCreated: boolean }>(cypher, {
    assertionId,
    evidenceId,
    sourceKey,
    sourceType: evidence.sourceType,
    snippet: evidence.snippet,
    sourceUrl: evidence.sourceUrl || null,
    documentId: evidence.documentId || null,
    chunkId: evidence.chunkId || null,
    signalId: evidence.signalId || null,
    entityId: evidence.entityId || null,
    entityType: evidence.entityType || null,
    entityField: evidence.entityField || null,
    pageNumber: evidence.pageNumber || null,
    relevanceScore: evidence.relevanceScore || null,
    now,
  });

  const record = result.records[0];
  return {
    evidence:
      record?.evidence ||
      ({
        id: evidenceId,
        sourceKey,
        sourceType: evidence.sourceType,
        snippet: evidence.snippet,
        sourceUrl: evidence.sourceUrl,
        documentId: evidence.documentId,
        chunkId: evidence.chunkId,
        signalId: evidence.signalId,
        entityId: evidence.entityId,
        entityType: evidence.entityType,
        entityField: evidence.entityField,
        pageNumber: evidence.pageNumber,
        relevanceScore: evidence.relevanceScore,
        capturedAt: now,
      } as GraphEvidence),
    created: record ? record.wasCreated === true : true,
  };
}

/**
 * Gets all evidence for an assertion.
 *
 * @param assertionId - Assertion ID
 * @returns Array of evidence supporting the assertion
 */
export async function getEvidenceForAssertion(assertionId: string): Promise<GraphEvidence[]> {
  const cypher = `
    MATCH (claim:Assertion {id: $assertionId})-[:SUPPORTED_BY]->(evidence:Evidence)
    RETURN evidence
    ORDER BY evidence.capturedAt DESC
  `;

  const result = await runReadTransaction<{ evidence: GraphEvidence }>(cypher, {
    assertionId,
  });

  return result.records.map((r) => r.evidence);
}

/**
 * Removes evidence from an assertion.
 *
 * @param evidenceId - Evidence ID
 */
export async function removeEvidence(evidenceId: string): Promise<void> {
  const cypher = `
    MATCH (evidence:Evidence {id: $evidenceId})
    DETACH DELETE evidence
  `;

  await runWriteTransaction(cypher, { evidenceId });
}

// ============================================================================
// CONNECTION EXPLANATION
// ============================================================================

/**
 * Explains why two entities are connected.
 * Returns all assertions connecting them with evidence.
 *
 * @param sourceId - Source entity ID
 * @param targetId - Target entity ID
 * @returns Array of connection explanations
 */
export async function explainConnection(sourceId: string, targetId: string): Promise<ConnectionExplanation[]> {
  // Pass 1 — :Assertion/:Claim-backed connections (opt-in provenance layer).
  // Matches BOTH labels: Assertion is the post-2026-04-18 rename; Claim is
  // kept for any rows that still exist pre-migration.
  const assertionCypher = `
    MATCH (claim)
    WHERE (claim:Assertion OR claim:Claim)
      AND coalesce(claim.status, 'proposed') <> 'rejected'
      AND (
        (claim.subjectId = $sourceId AND claim.objectId = $targetId)
        OR (claim.subjectId = $targetId AND claim.objectId = $sourceId)
      )

    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    OPTIONAL MATCH (claim)-[:ASSERTED_BY]->(asserter)
    OPTIONAL MATCH (claim)-[:HAS_PREDICATE]->(relType:RelationType)

    RETURN
      claim,
      collect(DISTINCT evidence) as evidence,
      asserter,
      relType
    ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC
  `;

  const assertionResult = await runReadTransaction<{
    claim: GraphAssertion;
    evidence: GraphEvidence[];
    asserter: GraphAgent | GraphUser;
    relType: GraphRelationType;
  }>(assertionCypher, { sourceId, targetId });

  const assertionBacked: ConnectionExplanation[] = assertionResult.records.map((r) => ({
    claim: r.claim,
    evidence: (r.evidence ?? []).filter(Boolean),
    asserter: r.asserter,
    relationType: r.relType,
  }));

  // Pass 2 — Plain typed edges without an Assertion (F3 default path).
  // Synthesise a minimal Assertion-shape object from edge properties so callers
  // that expect ConnectionExplanation still work. Skip edges whose claimId
  // points at an Assertion we already returned above to avoid duplicates.
  const claimedIds = new Set(assertionBacked.map((e) => e.claim?.id).filter(Boolean));
  const edgeCypher = `
    MATCH (s:Entity)-[r]->(o:Entity)
    WHERE ((s.id = $sourceId AND o.id = $targetId) OR (s.id = $targetId AND o.id = $sourceId))
      AND type(r) <> 'ABOUT_SUBJECT' AND type(r) <> 'ABOUT_OBJECT'
      AND type(r) <> 'HAS_PREDICATE' AND type(r) <> 'ASSERTED_BY'
      AND type(r) <> 'SUPPORTED_BY'
      AND ${currentEdgePredicate('r')}
    RETURN
      type(r) AS predicate,
      coalesce(r.relationId, r.claimId, toString(id(r))) AS relationId,
      r.claimId AS claimId,
      r.confidence AS confidence,
      r.effectiveConfidence AS effectiveConfidence,
      r.claimStatus AS claimStatus,
      r.assertedBy AS assertedBy,
      r.notes AS notes,
      r.t_observed AS t_observed,
      r.t_valid AS t_valid,
      r.t_invalidated AS t_invalidated,
      s.id AS subjectId,
      coalesce(s.name, s.id) AS subjectName,
      s.entityType AS subjectType,
      o.id AS objectId,
      coalesce(o.name, o.id) AS objectName,
      o.entityType AS objectType
    ORDER BY coalesce(r.effectiveConfidence, r.confidence) DESC
  `;
  const edgeResult = await runReadTransaction<{
    predicate: string;
    relationId: string;
    claimId?: string | null;
    confidence?: number | null;
    effectiveConfidence?: number | null;
    claimStatus?: string | null;
    assertedBy?: string | null;
    notes?: string | null;
    t_observed?: string | null;
    t_valid?: string | null;
    t_invalidated?: string | null;
    subjectId: string;
    subjectName: string;
    subjectType?: string | null;
    objectId: string;
    objectName: string;
    objectType?: string | null;
  }>(edgeCypher, { sourceId, targetId });

  const edgeBacked: ConnectionExplanation[] = edgeResult.records
    .filter((r) => !r.claimId || !claimedIds.has(r.claimId))
    .map((r) => ({
      claim: {
        id: r.relationId,
        subjectId: r.subjectId,
        subjectType: r.subjectType ?? 'unknown',
        subjectName: r.subjectName,
        objectId: r.objectId,
        objectType: r.objectType ?? 'unknown',
        objectName: r.objectName,
        predicate: r.predicate,
        confidence: r.effectiveConfidence ?? r.confidence ?? 50,
        effectiveConfidence: r.effectiveConfidence ?? r.confidence ?? 50,
        status: (r.claimStatus ?? 'curated') as 'proposed' | 'approved' | 'curated',
        statement: `${r.subjectName} ${r.predicate.replace(/_/g, ' ').toLowerCase()} ${r.objectName}`,
        reasoningSummary: r.notes ?? null,
        createdAt: r.t_observed ? new Date(r.t_observed).getTime() : Date.now(),
        updatedAt: r.t_valid ? new Date(r.t_valid).getTime() : Date.now(),
        assertedBy: r.assertedBy ?? 'unknown',
        asserterType: deriveAsserterType(r.assertedBy ?? ''),
      } as GraphAssertion,
      evidence: [], // Plain edges have no snippet-level evidence
      asserter: {
        id: r.assertedBy ?? 'unknown',
        name: (r.assertedBy ?? 'unknown').split(':')[1] ?? r.assertedBy ?? 'unknown',
      } as GraphAgent | GraphUser,
      relationType: {
        name: r.predicate,
        createdAt: 0,
        isSystem: true,
      } as GraphRelationType,
    }));

  const resolvedConfidence = (e: ConnectionExplanation): number =>
    e.claim?.effectiveConfidence ?? e.claim?.confidence ?? 0;
  return [...assertionBacked, ...edgeBacked].sort((a, b) => resolvedConfidence(b) - resolvedConfidence(a));
}

/**
 * Gets assertions citing a specific document.
 *
 * @param documentId - Document ID
 * @returns Document citations
 */
export async function getAssertionsCitingDocument(documentId: string): Promise<DocumentCitations> {
  const cypher = `
    MATCH (claim:Assertion)-[:SUPPORTED_BY]->(evidence:Evidence)
    WHERE evidence.documentId = $documentId
    RETURN DISTINCT claim
    ORDER BY claim.createdAt DESC
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    documentId,
  });

  return {
    documentId,
    claims: result.records.map((r) => r.claim),
    citationCount: result.records.length,
  };
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Gets assertions by status.
 *
 * @param status - Assertion status
 * @param limit - Maximum results
 * @returns Array of assertions
 */
export async function getAssertionsByStatus(status: ClaimStatus, limit: number = 50): Promise<GraphAssertion[]> {
  // Ensure limit is a Neo4j Integer - LIMIT requires integers
  const safeLimit = neo4j.int(limit);

  const cypher = `
    MATCH (claim:Assertion {status: $status})
    RETURN claim
    ORDER BY claim.createdAt DESC
    LIMIT $limit
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    status,
    limit: safeLimit,
  });

  return result.records.map((r) => r.claim);
}

/**
 * Gets assertions by asserter.
 *
 * @param assertedBy - Asserter ID (e.g., "agent:scout" or "user:abc123")
 * @param limit - Maximum results
 * @returns Array of assertions
 */
export async function getAssertionsByAsserter(assertedBy: string, limit: number = 50): Promise<GraphAssertion[]> {
  // Ensure limit is a Neo4j Integer - LIMIT requires integers
  const safeLimit = neo4j.int(limit);

  const cypher = `
    MATCH (claim:Assertion {assertedBy: $assertedBy})
    RETURN claim
    ORDER BY claim.createdAt DESC
    LIMIT $limit
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    assertedBy,
    limit: safeLimit,
  });

  return result.records.map((r) => r.claim);
}

/**
 * Gets high-confidence assertions (for display).
 *
 * @param minConfidence - Minimum confidence threshold
 * @param limit - Maximum results
 * @returns Array of assertions
 */
export async function getHighConfidenceAssertions(
  minConfidence: number = 80,
  limit: number = 50
): Promise<GraphAssertion[]> {
  // Ensure limit is a Neo4j Integer - LIMIT requires integers
  const safeLimit = neo4j.int(limit);

  const cypher = `
    MATCH (claim:Assertion)
    WHERE coalesce(claim.effectiveConfidence, claim.confidence) >= $minConfidence
      AND claim.status IN ['proposed', 'curated']
    RETURN claim
    ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC
    LIMIT $limit
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    minConfidence,
    limit: safeLimit,
  });

  return result.records.map((r) => r.claim);
}

/**
 * Searches assertions by predicate (relation type).
 *
 * @param predicate - Relation type (e.g., "SOLVES", "USES")
 * @param limit - Maximum results
 * @returns Array of assertions
 */
export async function getAssertionsByPredicate(predicate: string, limit: number = 50): Promise<GraphAssertion[]> {
  // Ensure limit is a Neo4j Integer - LIMIT requires integers
  const safeLimit = neo4j.int(limit);

  const cypher = `
    MATCH (claim:Assertion {predicate: $predicate})
    RETURN claim
    ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC
    LIMIT $limit
  `;

  const result = await runReadTransaction<{ claim: GraphAssertion }>(cypher, {
    predicate,
    limit: safeLimit,
  });

  return result.records.map((r) => r.claim);
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Gets comprehensive statistics about the assertion graph.
 *
 * @returns Assertion graph statistics
 */
export async function getAssertionStats(): Promise<AssertionGraphStats> {
  const cypher = `
    MATCH (claim:Assertion)
    WITH
      count(claim) as totalClaims,
      avg(coalesce(claim.effectiveConfidence, claim.confidence)) as avgConfidence

    // Count by status
    OPTIONAL MATCH (proposed:Assertion {status: 'proposed'})
    OPTIONAL MATCH (curated:Assertion {status: 'curated'})
    OPTIONAL MATCH (rejected:Assertion {status: 'rejected'})
    OPTIONAL MATCH (derived:Assertion {status: 'derived'})

    // Count by asserter type
    OPTIONAL MATCH (agentClaims:Assertion {asserterType: 'agent'})
    OPTIONAL MATCH (userClaims:Assertion {asserterType: 'user'})

    // Count assertions with evidence
    OPTIONAL MATCH (claimWithEvidence:Assertion)-[:SUPPORTED_BY]->(:Evidence)

    // Count total evidence
    OPTIONAL MATCH (evidence:Evidence)

    RETURN
      totalClaims,
      avgConfidence,
      count(DISTINCT proposed) as proposedCount,
      count(DISTINCT curated) as curatedCount,
      count(DISTINCT rejected) as rejectedCount,
      count(DISTINCT derived) as derivedCount,
      count(DISTINCT agentClaims) as agentCount,
      count(DISTINCT userClaims) as userCount,
      count(DISTINCT claimWithEvidence) as claimsWithEvidence,
      count(DISTINCT evidence) as totalEvidence
  `;

  // Get top relation types separately
  const topRelationsCypher = `
    MATCH (claim:Assertion)
    WITH claim.predicate as predicate, count(*) as count
    ORDER BY count DESC
    LIMIT 10
    RETURN predicate as name, count
  `;

  const [statsResult, topRelationsResult] = await Promise.all([
    runReadTransaction<{
      totalClaims: number;
      avgConfidence: number;
      proposedCount: number;
      curatedCount: number;
      rejectedCount: number;
      derivedCount: number;
      agentCount: number;
      userCount: number;
      claimsWithEvidence: number;
      totalEvidence: number;
    }>(cypher, {}),
    runReadTransaction<{ name: string; count: number }>(topRelationsCypher, {}),
  ]);

  const stats = statsResult.records[0];
  const topRelations = topRelationsResult.records;

  return {
    totalClaims: stats?.totalClaims || 0,
    byStatus: {
      proposed: stats?.proposedCount || 0,
      curated: stats?.curatedCount || 0,
      rejected: stats?.rejectedCount || 0,
      derived: stats?.derivedCount || 0,
    },
    avgConfidence: stats?.avgConfidence || 0,
    claimsWithEvidence: stats?.claimsWithEvidence || 0,
    totalEvidence: stats?.totalEvidence || 0,
    byAsserterType: {
      agent: stats?.agentCount || 0,
      user: stats?.userCount || 0,
    },
    topRelationTypes: topRelations,
  };
}

// ============================================================================
// ENTITY SYNC
// ============================================================================

/**
 * Syncs an entity from Firestore to Neo4j.
 * Called when entities are created/updated in Firestore.
 *
 * @param entity - Entity data to sync
 */
export async function syncEntity(entity: {
  id: string;
  entityType: TransformationEntityType;
  name: string;
  description?: string;
  status?: string;
  tags?: string[];
  updatedAt?: number;
  /**
   * OBS-003 — the request identity that drove this projection.
   *
   * Optional, and parsed through {@link parseCorrelationId} before it can reach a
   * graph property, so unrecognised caller text is discarded rather than written.
   * This is the graph-operation trace (the same role `:Assertion.correlationId`
   * plays), NOT a durable Firestore source generation: an `:Entity` projection
   * has no `sourceCorrelationId`/`sourceFingerprint` pair to be checked against,
   * so it carries only the latest known request.
   */
  correlationId?: string;
}): Promise<void> {
  // A refresh with no accepted request (cron) must not erase the last known one,
  // so the stamp coalesces instead of overwriting. `syncedAt` still moves — the
  // projection genuinely happened, it just has no request to attribute it to.
  const cypher = `
    MERGE (e:Entity {id: $id})
    SET
      e.entityType = $entityType,
      e.name = $name,
      e.description = $description,
      e.status = $status,
      e.tags = $tags,
      e.syncedAt = $syncedAt,
      e.firestoreUpdatedAt = $firestoreUpdatedAt,
      e.syncCorrelationId = coalesce($syncCorrelationId, e.syncCorrelationId)
    RETURN e
  `;

  await runWriteTransaction(cypher, {
    id: entity.id,
    entityType: entity.entityType,
    name: entity.name,
    description: entity.description || null,
    status: entity.status || null,
    tags: entity.tags || [],
    syncedAt: Date.now(),
    firestoreUpdatedAt: entity.updatedAt || Date.now(),
    syncCorrelationId: parseCorrelationId(entity.correlationId),
  });
}

/**
 * Deletes an entity from Neo4j together with every Assertion whose scalar
 * topology names it as subject or object. The Assertion, Evidence, typed
 * projection, document chunks, verifier results, and endpoint deletion happen
 * in one Neo4j transaction, preventing partial cleanup inside the supported
 * delete path.
 * Event ordering and later writers remain the caller's responsibility.
 * Concrete type labels and relation-writer `:Entity {entityType}` placeholders
 * are both recognized. More than one candidate for the requested type fails
 * closed without deleting either endpoint or its Assertion topology.
 *
 * GRAPH-061: `DETACH DELETE endpoint` removes the `VERIFIES` edge but not the
 * `VerificationResult` node behind it, and `EdgeVerificationResult` carries no
 * relationship at all — both survived every endpoint deletion as unanchored
 * claims about entities that no longer exist. They are now collected and
 * removed in the same transaction as the endpoint they describe.
 *
 * @param entityId - Entity ID to delete
 * @param entityType - Canonical entity type used to isolate colliding IDs
 */
export interface DeleteEntityFromGraphResult {
  assertionsDeleted: number;
  evidenceDeleted: number;
  projectionsDeleted: number;
  chunksDeleted: number;
  endpointsDeleted: number;
  verificationResultsDeleted: number;
  edgeVerificationResultsDeleted: number;
}

export async function deleteEntityFromGraph(
  entityId: string,
  entityType: EntityType
): Promise<DeleteEntityFromGraphResult> {
  const endpointLabel = ENTITY_TYPE_GRAPH_LABEL[entityType];
  if (!endpointLabel) {
    throw new Error(`Unsupported graph entity type: ${String(entityType)}`);
  }
  const entityTypes = expandEntityTypes([entityType]);

  const cypher = `
    OPTIONAL MATCH (endpoint {id: $entityId})
    WHERE $endpointLabel IN labels(endpoint)
      OR ('Entity' IN labels(endpoint) AND endpoint.entityType IN $entityTypes)
    WITH collect(DISTINCT endpoint) AS endpoints
    WHERE size(endpoints) <= 1
    WITH endpoints, head(endpoints) AS endpoint

    OPTIONAL MATCH (claim)
    WHERE (claim:Assertion OR claim:Claim)
      AND (
        (claim.subjectId = $entityId AND claim.subjectType IN $entityTypes)
        OR (claim.objectId = $entityId AND claim.objectType IN $entityTypes)
        OR (
          endpoint IS NOT NULL
          AND EXISTS {
            MATCH (claim)-[:ABOUT_SUBJECT|ABOUT_OBJECT]->(endpoint)
          }
        )
      )
    OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
    WITH endpoints,
         collect(DISTINCT claim) AS assertions,
         collect(DISTINCT evidence) AS evidenceNodes

    OPTIONAL MATCH ()-[projection]->()
    WHERE projection.claimId IN [assertion IN assertions | assertion.id]
    WITH endpoints, assertions, evidenceNodes,
         collect(DISTINCT projection) AS projectionEdges

    OPTIONAL MATCH (document:Document {id: $entityId})-[:CONTAINS]->(chunk:Chunk)
    WHERE $entityType = 'document'
    WITH endpoints, assertions, evidenceNodes, projectionEdges,
         collect(DISTINCT chunk) AS chunks

    OPTIONAL MATCH (entityVerification:VerificationResult {entityId: $entityId})
    WITH endpoints, assertions, evidenceNodes, projectionEdges, chunks,
         collect(DISTINCT entityVerification) AS verificationResults

    // Edge verdicts are standalone nodes keyed by relationId, so they are
    // reachable only through the scalar coordinates they recorded: either
    // endpoint of the deleted entity, or a relation whose Assertion is going
    // away with it.
    OPTIONAL MATCH (edgeVerification:EdgeVerificationResult)
    WHERE edgeVerification.sourceEntityId = $entityId
       OR edgeVerification.targetEntityId = $entityId
       OR edgeVerification.relationId IN [assertion IN assertions | assertion.relationId]
    WITH endpoints, assertions, evidenceNodes, projectionEdges, chunks, verificationResults,
         collect(DISTINCT edgeVerification) AS edgeVerificationResults

    WITH assertions, evidenceNodes, projectionEdges, chunks, endpoints,
         verificationResults, edgeVerificationResults,
         size(assertions) AS assertionsDeleted,
         size(evidenceNodes) AS evidenceDeleted,
         size(projectionEdges) AS projectionsDeleted,
         size(chunks) AS chunksDeleted,
         size(endpoints) AS endpointsDeleted,
         size(verificationResults) AS verificationResultsDeleted,
         size(edgeVerificationResults) AS edgeVerificationResultsDeleted
    FOREACH (edge IN projectionEdges | DELETE edge)
    FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)
    FOREACH (assertion IN assertions | DETACH DELETE assertion)
    FOREACH (chunk IN chunks | DETACH DELETE chunk)
    FOREACH (node IN verificationResults | DETACH DELETE node)
    FOREACH (node IN edgeVerificationResults | DETACH DELETE node)
    FOREACH (endpoint IN endpoints | DETACH DELETE endpoint)
    RETURN assertionsDeleted, evidenceDeleted, projectionsDeleted,
           chunksDeleted, endpointsDeleted,
           verificationResultsDeleted, edgeVerificationResultsDeleted
  `;

  const result = await runWriteTransaction<DeleteEntityFromGraphResult>(cypher, {
    entityId,
    entityType,
    entityTypes,
    endpointLabel,
  });
  if (result.records.length === 0) {
    throw new Error(`Ambiguous graph endpoint: multiple ${entityType} nodes share id ${entityId}`);
  }
  return result.records[0];
}

// ============================================================================
// BULK OPERATIONS
// ============================================================================

/**
 * Creates multiple assertions in a single transaction.
 *
 * @param inputs - Array of assertion inputs
 * @returns Array of created assertions
 */
export async function bulkCreateAssertions(inputs: CreateAssertionInput[]): Promise<GraphAssertion[]> {
  const assertions: GraphAssertion[] = [];

  for (const input of inputs) {
    const assertion = await createAssertion(input);
    assertions.push(assertion);
  }

  return assertions;
}

/**
 * Approves multiple assertions (sets status to 'curated').
 *
 * @param assertionIds - Array of assertion IDs
 * @param verifiedBy - User who verified
 */
export async function bulkApproveAssertions(assertionIds: string[], _verifiedBy: string): Promise<void> {
  const cypher = `
    UNWIND $assertionIds as assertionId
    MATCH (claim:Assertion {id: assertionId})
    SET claim.status = 'curated',
        claim.updatedAt = $now,
        claim.lastVerifiedAt = $now
    RETURN claim
  `;

  await runWriteTransaction(cypher, {
    assertionIds,
    now: Date.now(),
  });
}

/**
 * Rejects multiple assertions.
 *
 * @param assertionIds - Array of assertion IDs
 */
export async function bulkRejectAssertions(assertionIds: string[]): Promise<void> {
  const now = Date.now();
  const invalidatedAt = new Date(now).toISOString();
  const cypher = `
    UNWIND $assertionIds as assertionId
    MATCH (claim:Assertion {id: assertionId})
    SET claim.status = 'rejected',
        claim.updatedAt = $now
    WITH claim, assertionId
    OPTIONAL MATCH ()-[edge {claimId: assertionId}]->()
    FOREACH (r IN CASE WHEN edge IS NULL THEN [] ELSE [edge] END |
      SET r.claimStatus = 'rejected',
          r.updatedAt = $now,
          r.t_invalidated = coalesce(r.t_invalidated, $invalidatedAt)
    )
    RETURN count(DISTINCT claim) AS assertionsUpdated, count(edge) AS edgesUpdated
  `;

  await runWriteTransaction(cypher, {
    assertionIds,
    now,
    invalidatedAt,
  });
}

// ============================================================================
// ASSERTION → EDGE MATERIALIZATION
// ============================================================================

/**
 * Materializes an approved Assertion as a typed edge between its subject and object.
 * Idempotent: if the edge already exists with the same claimId, properties are
 * refreshed but no duplicate edge is created (MERGE on claimId).
 *
 * The edge carries the Assertion's confidence, full temporal fields, and a claimId
 * back-pointer for provenance traversal. Graph-traversal code can then walk
 * typed edges (e.g., (:Technology)-[:ADDRESSES]->(:UseCase)) and recover the
 * backing Assertion+Evidence via MATCH (a)-[r]->(b) WHERE r.claimId IS NOT NULL
 * MATCH (c:Assertion {id: r.claimId})-[:SUPPORTED_BY]->(e:Evidence).
 *
 * Note: the edge property is still named `claimId` (foreign key on 14,694 edges);
 * the node-label rename happened without a data migration of the edge property.
 *
 * @param assertionId - ID of the Assertion to materialize
 * @returns null if the Assertion doesn't exist; otherwise {created, edgeType}
 */
export async function materializeAssertionAsEdge(
  assertionId: string,
  opts?: {
    sourceRelationType?: string;
    correlationId?: string;
    sourceCorrelationId?: string;
    sourceFingerprint?: string;
  }
): Promise<{ created: boolean; edgeType: string } | null> {
  const correlationId = opts?.correlationId === undefined ? null : parseCorrelationId(opts.correlationId);
  if (opts?.correlationId !== undefined && !correlationId) {
    throw new Error('Invalid assertion materialization correlation ID');
  }
  const hasSourceCorrelationId = opts?.sourceCorrelationId !== undefined;
  const hasSourceFingerprint = opts?.sourceFingerprint !== undefined;
  if (hasSourceCorrelationId !== hasSourceFingerprint) {
    throw new Error('Assertion materialization source version must contain both fields');
  }
  const requestedSourceCorrelationId =
    opts?.sourceCorrelationId === undefined ? null : parseCorrelationId(opts.sourceCorrelationId);
  if (opts?.sourceCorrelationId !== undefined && !requestedSourceCorrelationId) {
    throw new Error('Invalid assertion materialization source correlation ID');
  }
  const requestedSourceFingerprint = resolveRelationSourceFingerprint(opts?.sourceFingerprint) ?? null;

  // A topology/status update can land after the optimistic read below but
  // before the write transaction acquires the Assertion lock. Retry from a
  // fresh snapshot when that happens; never project stale endpoints or status.
  const MAX_SNAPSHOT_ATTEMPTS = 3;
  let assertion = await getAssertion(assertionId);

  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    if (!assertion || assertion.status === 'rejected') return null;

    const assertionHasSourceCorrelation = assertion.sourceCorrelationId != null;
    const assertionHasSourceFingerprint = assertion.sourceFingerprint != null;
    if (!hasSourceCorrelationId && assertionHasSourceCorrelation !== assertionHasSourceFingerprint) {
      throw new Error(`Assertion ${assertionId} has incomplete source version metadata`);
    }
    const inheritedSourceCorrelationId = assertionHasSourceCorrelation
      ? parseCorrelationId(assertion.sourceCorrelationId)
      : null;
    if (!hasSourceCorrelationId && assertionHasSourceCorrelation && !inheritedSourceCorrelationId) {
      throw new Error(`Assertion ${assertionId} has an invalid source correlation ID`);
    }
    const inheritedSourceFingerprint = assertionHasSourceFingerprint
      ? (resolveRelationSourceFingerprint(assertion.sourceFingerprint) ?? null)
      : null;
    const sourceCorrelationId = requestedSourceCorrelationId ?? inheritedSourceCorrelationId;
    const sourceFingerprint = requestedSourceFingerprint ?? inheritedSourceFingerprint;

    const snapshotStatus = assertion.status ?? 'proposed';
    const snapshotSourceCorrelationId = assertion.sourceCorrelationId ?? null;
    const snapshotSourceFingerprint = assertion.sourceFingerprint ?? null;
    // CRIT-1: the edge MUST carry the REAL Firestore relationId (when the
    // Assertion backs a synced Relation). buildRelationDefaults otherwise
    // mints a random relationId and breaks temporal self-exclusion.
    const defaults = buildRelationDefaults({
      source: assertion.asserterType === 'agent' ? 'agent' : 'user',
      assertedBy: assertion.assertedBy,
      confidence: assertion.assertedConfidence ?? assertion.confidence,
      overrides: {
        claimId: assertionId,
        claimStatus: snapshotStatus,
        ...(assertion.relationId ? { relationId: assertion.relationId } : {}),
        ...(opts?.sourceRelationType ? { sourceRelationType: opts.sourceRelationType } : {}),
      },
    });

    // Whitelist predicate against RelationType union before interpolation.
    const safePredicate = relationTypeCypherSchema.parse(assertion.predicate);
    const relationIdRefresh = assertion.relationId ? 'r.relationId = $properties.relationId,' : '';
    const cypher = `
      MATCH (claim:Assertion {id: $assertionId})
      // Acquire the same node write lock used by status/topology updates, then
      // verify every field used to build this dynamic projection still matches
      // the optimistic snapshot.
      SET claim.updatedAt = claim.updatedAt
      WITH claim
      WHERE coalesce(claim.status, 'proposed') = $snapshotStatus
        AND coalesce(claim.status, 'proposed') <> 'rejected'
        AND claim.subjectId = $subjectId
        AND claim.objectId = $objectId
        AND claim.predicate = $predicate
        AND coalesce(claim.sourceCorrelationId, '') = coalesce($snapshotSourceCorrelationId, '')
        AND coalesce(claim.sourceFingerprint, '') = coalesce($snapshotSourceFingerprint, '')
      MATCH (s:Entity {id: $subjectId}), (o:Entity {id: $objectId})

      // One Assertion has one current typed projection. Remove stale topology
      // and collapse legacy exact duplicates before MERGE.
      OPTIONAL MATCH ()-[oldProjection {claimId: $assertionId}]->()
      WITH claim, s, o, collect(oldProjection) AS projections
      FOREACH (edge IN [candidate IN projections WHERE
        coalesce(startNode(candidate).id, '') <> $subjectId OR
        coalesce(endNode(candidate).id, '') <> $objectId OR
        type(candidate) <> $predicate
      ] | DELETE edge)
      WITH claim, s, o
      OPTIONAL MATCH (s)-[exactEdge:\`${safePredicate}\` {claimId: $assertionId}]->(o)
      WITH claim, s, o, collect(exactEdge) AS exactEdges
      FOREACH (edge IN tail(exactEdges) | DELETE edge)

      MERGE (s)-[r:\`${safePredicate}\` {claimId: $assertionId}]->(o)
      ON CREATE SET r = $properties,
                    r.correlationId = $correlationId,
                    r.sourceCorrelationId = $sourceCorrelationId,
                    r.sourceFingerprint = $sourceFingerprint,
                    r.wasCreated = true
      ON MATCH SET r.confidence = $properties.confidence,
                   r.assertedConfidence = $properties.assertedConfidence,
                   r.effectiveConfidence = coalesce(r.effectiveConfidence, $properties.effectiveConfidence),
                   r.claimStatus = $properties.claimStatus,
                   r.t_valid = $properties.t_valid,
                   r.sourceRelationType = $properties.sourceRelationType,
                   r.correlationId = coalesce($correlationId, r.correlationId),
                   r.sourceCorrelationId = coalesce($sourceCorrelationId, r.sourceCorrelationId),
                   r.sourceFingerprint = coalesce($sourceFingerprint, r.sourceFingerprint),
                   ${relationIdRefresh}
                   r.t_invalidated = null,
                   r.wasCreated = false
      SET claim.sourceCorrelationId = coalesce($sourceCorrelationId, claim.sourceCorrelationId),
          claim.sourceFingerprint = coalesce($sourceFingerprint, claim.sourceFingerprint)
      RETURN r.wasCreated AS created, type(r) AS edgeType
    `;

    const result = await runWriteTransaction<{ created: boolean; edgeType: string }>(cypher, {
      subjectId: assertion.subjectId,
      objectId: assertion.objectId,
      predicate: assertion.predicate,
      snapshotStatus,
      snapshotSourceCorrelationId,
      snapshotSourceFingerprint,
      assertionId,
      properties: defaults,
      correlationId,
      sourceCorrelationId,
      sourceFingerprint,
    });

    const record = result.records[0];
    if (record) return { created: record.created === true, edgeType: record.edgeType };

    const latest = await getAssertion(assertionId);
    if (!latest || latest.status === 'rejected') return null;
    const snapshotChanged =
      (latest.status ?? 'proposed') !== snapshotStatus ||
      latest.subjectId !== assertion.subjectId ||
      latest.objectId !== assertion.objectId ||
      latest.predicate !== assertion.predicate;
    if (!snapshotChanged) return null;
    assertion = latest;
  }

  throw new Error(`Assertion ${assertionId} changed during ${MAX_SNAPSHOT_ATTEMPTS} materialization attempts`);
}
