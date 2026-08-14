/**
 * @file proposed-relations-admin.ts
 * @description Admin-SDK twin of `proposed-relations.ts` for SERVER-side callers.
 *
 * Why this exists: `src/lib/proposed-relations.ts` is a CLIENT-SDK module — it
 * imports `db` + `removeUndefinedFields` from `@/lib/firebase` and uses
 * `firebase/firestore`. The Linker AI tools (`src/lib/ai/tools/linker-tools.ts`)
 * are executed on the server inside the stateless `/api/ai/chat` route, where the
 * client SDK can't hold a connection — reads/writes throw `code: 'unavailable'`
 * or the `a540` internal-assertion failure observed for server
 * callers. This module reproduces the exact contract the Linker tools depend on
 * via the Admin SDK so those executors can be re-pointed here.
 *
 * Drop-in for the functions linker-tools imports from `@/lib/proposed-relations`:
 *   - getProposedRelations(filters?)
 *   - createProposedRelationIfNotExists(input)
 *   - approveProposedRelation(id, reviewedBy, options?)
 *   - approveProposedRelationAsMachine(id, reviewedBy)
 *   - rejectProposedRelation(id, reviewedBy, feedbackReason?, options?)
 *   - dismissProposedRelation(id, reviewedBy, options?)
 *   - bulkApproveProposedRelations(ids, reviewedBy, options?)
 *   - type ProposedRelationFilters (re-exported from the client module — pure type)
 * plus the supporting reads (`getProposedRelationById`, `getProposedRelationByKey`)
 * and `updateProposedRelation` the triage operations build on.
 *
 * EXACT-PARITY NOTES:
 * - Proposal identity is imported from a pure shared module so both SDK paths
 *   use the same v2 tuple preimage and legacy-candidate validation.
 * - `removeUndefinedFields` is inlined for the same reason (its only home is
 *   `@/lib/firebase`). Same recursive, Date/array-preserving semantics.
 * - The 30-day rejection-retention window, dedup branches, size validation, and
 *   evidence-array cap match the client byte-for-byte.
 * - `approveProposedRelation` creates proposal-owned claims as `proposed`,
 *   atomically stores the exact relation pointer, then curates and terminally
 *   approves. Foreign/manual duplicates are terminally approved before their
 *   evidence is enriched and retain their ownership metadata. Every failure is
 *   fail-loud and retryable; no negative review mutates a foreign relation.
 * - Human triage functions take optional feedback options. When `feedbackUserId` is
 *   passed for a human action, a successful pending→X transition is folded
 *   into the discovery learning store (`recordProposalFeedback`), best-effort
 *   (never throws). Idempotent early-returns (already approved/rejected) record
 *   nothing. Deliberately keyed on `feedbackUserId`, NOT `reviewedBy` — agent
 *   principals (e.g. `'ai-assistant'`) must not mint `UserPreference` rows.
 * - Machine approval is a separate wrapper. It never records human feedback,
 *   retains `claimStatus:'proposed'`, and leaves the proposal pending unless
 *   the assertion is guaranteed to clear the active reliability-aware graph
 *   materialization floor.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import type {
  CreateProposedRelationInput,
  EntityType,
  EvidenceRef,
  EvidenceReference,
  ProposedRelation,
  Relation,
  RelationType,
} from '@/lib/types';
import { PROPOSED_RELATION_LIMITS as LIMITS, agentNameForDiscoverySource } from '@/lib/types';
import type { ProposedRelationFilters } from '@/lib/proposed-relations';
import { createLogger } from '@/lib/logger';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import {
  generateProposalKey,
  generateProposalKeyCandidates,
  matchesProposalIdentity,
  mergeEquivalentProposalArchives,
  proposalArchivesEquivalent,
  ProposalIdentityConflictError,
} from '@/lib/proposed-relation-key';
export { generateProposalKey } from '@/lib/proposed-relation-key';
import { machineRelationAutoApprovalThreshold } from '@/lib/graph/materialization-policy';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import {
  InvalidCorrelationIdError,
  parseCorrelationId,
  type CorrelationContext,
} from '@/lib/observability/correlation';

const log = createLogger('proposed-relations-admin');
const RELATION_PROVENANCE_MAX = LIMITS.EVIDENCE_ARRAY_MAX * 4;

// Re-export the pure filter type so callers can import it from the admin twin.
export type { ProposedRelationFilters } from '@/lib/proposed-relations';

/**
 * Adapt triage evidence into the durable Relation/graph evidence contract.
 * The sourceKey is deliberately snippet-specific for storage, while document,
 * signal, and URL fields retain the coarser source identity used by
 * corroboration readers.
 */
export function proposedEvidenceToEvidenceRefs(
  proposalId: string,
  evidence: EvidenceReference[]
): EvidenceRef[] {
  return evidence.map((reference) => {
    const location = reference.location as Record<string, unknown>;
    const sourceKey = `proposal:${proposalId}:${reference.sourceType}:${reference.sourceId}:${reference.snippetHash}`;
    const type: EvidenceRef['type'] =
      reference.sourceType === 'document'
        ? 'document_chunk'
        : reference.sourceType === 'signal'
          ? 'signal'
          : reference.sourceType === 'entity_field'
            ? 'entity_field'
            : reference.sourceType === 'web'
              ? 'web_ref'
              : 'user_assertion';

    return {
      id: sourceKey,
      sourceKey,
      type,
      snippet: reference.snippet.slice(0, LIMITS.EVIDENCE_SNIPPET_MAX),
      ...(reference.sourceType === 'web' && typeof location.url === 'string' ? { url: location.url } : {}),
      ...(reference.sourceType === 'document' ? { documentId: reference.sourceId } : {}),
      ...(reference.sourceType === 'document' && typeof location.chunkId === 'string'
        ? { chunkId: location.chunkId }
        : {}),
      ...(reference.sourceType === 'document' && typeof location.pageNumber === 'number'
        ? { pageNumber: location.pageNumber }
        : {}),
      ...(reference.sourceType === 'signal' ? { signalId: reference.sourceId } : {}),
      ...(reference.sourceType === 'entity_field'
        ? {
            entityId: reference.sourceId,
            ...(typeof location.entityType === 'string' ? { entityType: location.entityType as EntityType } : {}),
            ...(typeof location.field === 'string' ? { entityField: location.field } : {}),
          }
        : {}),
      capturedAt: reference.extractedAt,
    };
  });
}

/** Preserve proposal reasoning as source-addressable provenance, not only as
 * the relation's single headline summary. Distinct proposals therefore remain
 * readable after triage rows are archived or deleted. */
function proposalProvenanceToEvidenceRefs(proposal: ProposedRelation): EvidenceRef[] {
  const reasoning = proposal.reasoning.trim();
  const reasoningRef: EvidenceRef[] = reasoning
    ? [
        {
          id: `proposal:${proposal.id}:reasoning`,
          sourceKey: `proposal:${proposal.id}:reasoning`,
          type: 'user_assertion',
          snippet: reasoning.slice(0, LIMITS.EVIDENCE_SNIPPET_MAX),
          capturedAt: proposal.createdAt,
        },
      ]
    : [];
  return [...proposedEvidenceToEvidenceRefs(proposal.id, proposal.evidence), ...reasoningRef];
}

function mergeEvidenceRefs(existing: EvidenceRef[] | undefined, incoming: EvidenceRef[]): EvidenceRef[] {
  const incomingById = new Map(incoming.map((evidence) => [evidence.id, evidence]));
  if (incomingById.size > RELATION_PROVENANCE_MAX) {
    throw new Error(`Proposal provenance exceeds the ${RELATION_PROVENANCE_MAX}-reference relation cap`);
  }

  // Approval must never report success after evicting the proposal being
  // approved. Reserve room for every incoming ref, then retain a deterministic
  // subset of older refs. Replaying the same approval remains byte-identical.
  const retainedExisting = [...(existing ?? [])]
    .filter((evidence) => !incomingById.has(evidence.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, RELATION_PROVENANCE_MAX - incomingById.size);
  return [...retainedExisting, ...incomingById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function enrichApprovedRelation(
  relation: Relation,
  proposal: ProposedRelation,
  isMachineApproval: boolean,
  correlationContext: CorrelationContext,
  ownership: 'proposal-owned' | 'foreign-duplicate'
): Promise<Relation> {
  const incomingEvidence = proposalProvenanceToEvidenceRefs(proposal);
  const { adminUpdateRelationFromFreshState } = await import('@/lib/relations-admin');

  // Duplicate proposals can be approved concurrently. Derive the union from
  // the Relation read INSIDE the Firestore transaction, not from the stale
  // snapshot carried by DuplicateRelationError. A proposal-owned claim must
  // retain exact machine provenance. A foreign/manual same-triple relation is
  // only enriched after approval wins and keeps all of its ownership fields.
  return adminUpdateRelationFromFreshState(
    relation.id,
    (current) => {
      if (!relationMatchesProposal(current, proposal)) {
        throw new Error(
          `Relation ${relation.id} changed identity before proposal ${proposal.id} could be enriched`
        );
      }
      if (
        ownership === 'proposal-owned' &&
        !relationHasExactProposalProvenance(current, proposal, ['proposed', 'curated'])
      ) {
        throw new Error(
          `Relation ${relation.id} changed provenance before proposal ${proposal.id} could be curated`
        );
      }
      const evidenceRefs = mergeEvidenceRefs(current.evidenceRefs, incomingEvidence);
      const reasoningSummary = current.reasoningSummary?.trim() || proposal.reasoning;
      // Human approval is authoritative for the exact semantic triple even
      // when an older/manual duplicate owns the normalized Relation row. Keep
      // its provenance fields, but do not leave a human-approved claim in the
      // machine-only `proposed` state.
      const claimStatus = !isMachineApproval ? 'curated' : current.claimStatus ?? 'proposed';

      // Return an idempotent metadata update even when values already match.
      // A previous Firestore commit may have outlived a failed Neo4j sync
      // acknowledgement; replay must re-dispatch that projection.
      return { evidenceRefs, reasoningSummary, claimStatus };
    },
    ...correlationArgument(correlationContext)
  );
}

/**
 * Confirms that a normalized Relation is the same semantic triple as a
 * proposal, including endpoint types. Symmetric predicates may be stored in
 * either direction; directional predicates must keep their orientation.
 */
export function relationMatchesProposal(
  relation: Pick<Relation, 'relationType' | 'sourceSnapshot' | 'targetSnapshot'>,
  proposal: Pick<
    ProposedRelation,
    'relationType' | 'sourceId' | 'sourceType' | 'targetId' | 'targetType'
  >
): boolean {
  // Firestore rows can predate the current Relation shape. Treat malformed
  // snapshots as a mismatch so triage fails closed with a useful domain error
  // instead of throwing while dereferencing a missing endpoint.
  if (
    !relation?.sourceSnapshot ||
    !relation?.targetSnapshot ||
    typeof relation.sourceSnapshot.id !== 'string' ||
    typeof relation.sourceSnapshot.type !== 'string' ||
    typeof relation.targetSnapshot.id !== 'string' ||
    typeof relation.targetSnapshot.type !== 'string' ||
    typeof relation.relationType !== 'string'
  ) {
    return false;
  }

  if (
    !matchesProposalIdentity(
      {
        sourceId: relation.sourceSnapshot.id,
        targetId: relation.targetSnapshot.id,
        relationType: relation.relationType,
      },
      proposal.sourceId,
      proposal.targetId,
      proposal.relationType
    )
  ) {
    return false;
  }

  const direct =
    relation.sourceSnapshot.id === proposal.sourceId &&
    relation.targetSnapshot.id === proposal.targetId;
  return direct
    ? relation.sourceSnapshot.type === proposal.sourceType &&
        relation.targetSnapshot.type === proposal.targetType
    : relation.sourceSnapshot.type === proposal.targetType &&
        relation.targetSnapshot.type === proposal.sourceType;
}

function relationHasExactProposalProvenance(
  relation: Relation,
  proposal: ProposedRelation,
  allowedClaimStatuses: readonly Relation['claimStatus'][]
): boolean {
  return (
    relationMatchesProposal(relation, proposal) &&
    relation.aiSuggested === true &&
    relation.agentName === agentNameForDiscoverySource(proposal.discoveredBy) &&
    relation.confidence === proposal.confidence &&
    allowedClaimStatuses.includes(relation.claimStatus)
  );
}

function relationHasProposalOwner(
  relation: Relation,
  proposal: ProposedRelation
): boolean {
  return (
    relationMatchesProposal(relation, proposal) &&
    relation.aiSuggested === true &&
    relation.agentName === agentNameForDiscoverySource(proposal.discoveredBy)
  );
}

/**
 * Opt-in learning-feedback wiring for the triage functions below. Callers that
 * have a real end-user identity (API routes, future UI-driven callers) pass
 * `feedbackUserId` to fold the decision into that user's InterestProfile
 * posterior. Deliberately NOT `reviewedBy` — agent principals (e.g.
 * `'ai-assistant'`) would otherwise mint junk `UserPreference{userId:
 * 'ai-assistant'}` rows. Omit this option and no feedback is recorded.
 */
export interface TriageFeedbackOptions extends CorrelationContext {
  feedbackUserId?: string;
}

/** Preserve legacy internal callers while rejecting explicitly malformed ids
 * before any proposal or backing-Relation write occurs. */
function triageCorrelationContext(correlationId: string | undefined): CorrelationContext {
  if (correlationId === undefined) return {};
  const parsed = parseCorrelationId(correlationId);
  if (!parsed) throw new InvalidCorrelationIdError();
  return { correlationId: parsed };
}

function correlationArgument(context: CorrelationContext): [] | [CorrelationContext] {
  return context.correlationId ? [context] : [];
}

/**
 * Invalidates the exact normalized claim correlated with a terminal negative
 * triage decision. Pointer-less lookup covers the create -> pointer crash
 * window, but only claims with machine/proposed provenance may be adopted by
 * that fallback.
 */
async function rejectMaterializedClaimForProposal(
  proposal: ProposedRelation,
  correlationContext: CorrelationContext,
  action: 'rejected' | 'dismissed'
): Promise<void> {
  const { adminCheckDuplicateRelation, adminUpdateRelationFromFreshState } = await import(
    '@/lib/relations-admin'
  );
  const expectedAgentName = agentNameForDiscoverySource(proposal.discoveredBy);
  if (proposal.relationId) {
    await adminUpdateRelationFromFreshState(
      proposal.relationId,
      (current) => {
        const ownsCuratedClaim =
          current.claimStatus === 'curated' && current.agentName === expectedAgentName;
        const ownsUncuratedClaim =
          ['proposed', 'rejected'].includes(current.claimStatus ?? '') &&
          (current.agentName == null || current.agentName === expectedAgentName);
        if (
          !relationMatchesProposal(current, proposal) ||
          current.aiSuggested !== true ||
          (!ownsCuratedClaim && !ownsUncuratedClaim) ||
          current.confidence !== proposal.confidence
        ) {
          throw new Error(
            `Relation ${proposal.relationId} is not the exact claim for proposal ${proposal.id}; refusing ${action} cleanup`
          );
        }
        // Force the normal sync dispatch even on an idempotent replay. The
        // previous Firestore write may have committed before sync acknowledgement.
        return { claimStatus: 'rejected' as const };
      },
      ...correlationArgument(correlationContext)
    );
    log.info(`Marked the correlated claim rejected after proposal ${action}`, {
      proposalId: proposal.id,
      relationId: proposal.relationId,
    });
    return;
  }

  const orphan = await adminCheckDuplicateRelation(
    proposal.sourceId,
    proposal.targetId,
    proposal.relationType
  );
  if (
    !orphan ||
    orphan.aiSuggested !== true ||
    orphan.agentName !== expectedAgentName ||
    !['proposed', 'rejected'].includes(orphan.claimStatus ?? '') ||
    orphan.confidence !== proposal.confidence ||
    !relationMatchesProposal(orphan, proposal)
  ) {
    return;
  }
  await adminUpdateRelationFromFreshState(
    orphan.id,
    (current) => {
      if (
        !relationMatchesProposal(current, proposal) ||
        current.aiSuggested !== true ||
        current.agentName !== expectedAgentName ||
        !['proposed', 'rejected'].includes(current.claimStatus ?? '') ||
        current.confidence !== proposal.confidence
      ) {
        return null;
      }
      return { claimStatus: 'rejected' as const };
    },
    ...correlationArgument(correlationContext)
  );
  log.info(`Rejected an orphaned claim after proposal ${action}`, {
    proposalId: proposal.id,
    relationId: orphan.id,
  });
}

export type MachineRelationApprovalResult =
  | { applied: true; transitioned: boolean; proposal: ProposedRelation }
  | {
      applied: false;
      proposal: ProposedRelation;
      /** BUILD-021: `lost-to-terminal-review` means a concurrent negative
       * review won and the owned claim was invalidated. Reactivating a
       * previously-rejected owned claim always requires a human. */
      reason:
        | 'below-materialization-floor'
        | 'lost-to-terminal-review'
        | 'requires-human-reactivation';
    };

/**
 * Records a triage decision into the discovery learning store, best-effort.
 * Private helper shared by all 5 triage functions below — called ONLY after a
 * successful pending→X status transition (idempotent early-returns must call
 * this with nothing, i.e. must not call it at all). Fails open: a learning-store
 * failure (including a failed dynamic import) is logged and swallowed, never
 * rethrown — recording feedback must never turn a successful triage decision
 * into a failure.
 */
async function recordRelationTriageFeedback(
  feedbackUserId: string | undefined,
  proposalId: string,
  proposal: Pick<ProposedRelation, 'sourceId' | 'sourceType'>,
  action: 'approved' | 'rejected' | 'dismissed',
  reason?: string
): Promise<void> {
  if (!feedbackUserId) return;
  try {
    const { recordProposalFeedback } = await import('@/lib/discovery/discovery-feedback');
    await recordProposalFeedback(
      feedbackUserId,
      proposalId,
      'relation',
      proposal.sourceId,
      proposal.sourceType,
      action,
      reason
    );
  } catch (feedbackError) {
    log.warn('relation triage feedback failed (best-effort, ignored)', {
      proposalId,
      action,
      error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
    });
  }
}

// ============================================================================
// CONSTANTS (mirror proposed-relations.ts)
// ============================================================================

/** Collection name in Firestore. */
const COLLECTION_NAME = 'proposedRelations';

/** Retention period for rejected proposals (30 days in milliseconds). */
const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function proposalSuppressionReason(
  proposal: ProposedRelation,
  now: number
): string | null {
  if (proposal.status === 'pending') return 'already_pending';
  if (
    proposal.status === 'rejected' &&
    proposal.updatedAt > now - REJECTION_RETENTION_MS
  ) {
    return 'recently_rejected';
  }
  if (proposal.status === 'dismissed') return 'dismissed';
  // `removed` is an explicit user decision on a previously-approved relation,
  // so automated writers must not resurrect the same semantic triple.
  if (proposal.status === 'removed') return 'removed';
  if (proposal.status === 'approved') return 'already_approved';
  if (proposal.status === 'processing') return 'already_processing';
  return null;
}

interface ProposalIdentityCandidate {
  key: string;
  proposal: ProposedRelation;
}

function classifyProposalIdentityCandidates(
  candidates: readonly ProposalIdentityCandidate[],
  currentKey: string
): {
  current: ProposalIdentityCandidate | null;
  legacy: ProposalIdentityCandidate[];
} {
  const current = candidates.find((candidate) => candidate.key === currentKey) ?? null;
  const legacy = candidates
    .filter((candidate) => candidate.key !== currentKey)
    .sort((left, right) => left.key.localeCompare(right.key));
  if (
    legacy.length > 1 &&
    legacy.slice(1).some((candidate) =>
      !proposalArchivesEquivalent(legacy[0].proposal, candidate.proposal)
    )
  ) {
    throw new ProposalIdentityConflictError(
      legacy.map((candidate) => candidate.key),
      'Directional legacy proposal archives disagree'
    );
  }
  return { current, legacy };
}

function isExpiredRejectedProposal(proposal: ProposedRelation, now: number): boolean {
  return (
    proposal.status === 'rejected' &&
    proposal.updatedAt <= now - REJECTION_RETENTION_MS
  );
}

// ============================================================================
// PURE HELPERS (inlined to avoid pulling the client SDK across the boundary)
// ============================================================================

/**
 * Strips `undefined` values (Firestore rejects them). Recursively cleans nested
 * plain objects, leaving arrays and `Date` instances intact. Mirrors
 * `removeUndefinedFields` from `@/lib/firebase`.
 */
function removeUndefinedFields<T extends object>(obj: T, deep = true): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (deep && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          return [key, removeUndefinedFields(value as object, deep)];
        }
        return [key, value];
      })
  ) as Partial<T>;
}

/**
 * Proposal key generation is re-exported from the shared identity module above
 * so callers of this Admin SDK twin retain the original public API.
 */
/**
 * Validates proposal size before writing. Mirrors `validateProposalSize` from
 * the client module — throws (not a typed error) when the JSON exceeds the cap.
 */
function validateProposalSize(proposal: ProposedRelation): void {
  const size = JSON.stringify(proposal).length;
  if (size > LIMITS.PROPOSAL_MAX_SIZE) {
    throw new Error(`Proposal exceeds size limit: ${size} > ${LIMITS.PROPOSAL_MAX_SIZE}`);
  }
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Fetches all proposed relations matching the given filters. Mirrors
 * `getProposedRelations` from the client module: the same equality/`in`/range
 * `where` clauses, then newest-first by `createdAt`.
 *
 * NOTE: unlike the client (which appends `orderBy('createdAt','desc')` and relies
 * on composite indexes), this sorts in-memory after the fetch — same precedent as
 * `signals-admin.adminGetSignalsByStatus`, so server reads never require a
 * composite index. The returned ordering is identical.
 */
export async function getProposedRelations(filters?: ProposedRelationFilters): Promise<ProposedRelation[]> {
  let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME);

  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length === 1) {
      q = q.where('status', '==', statuses[0]);
    } else {
      q = q.where('status', 'in', statuses);
    }
  }

  if (filters?.sourceType) {
    const types = Array.isArray(filters.sourceType) ? filters.sourceType : [filters.sourceType];
    if (types.length === 1) {
      q = q.where('sourceType', '==', types[0]);
    } else {
      q = q.where('sourceType', 'in', types);
    }
  }

  if (filters?.relationType) {
    const types = Array.isArray(filters.relationType) ? filters.relationType : [filters.relationType];
    if (types.length === 1) {
      q = q.where('relationType', '==', types[0]);
    } else {
      q = q.where('relationType', 'in', types);
    }
  }

  if (filters?.minConfidence !== undefined) {
    q = q.where('confidence', '>=', filters.minConfidence);
  }

  if (filters?.runId) {
    q = q.where('runId', '==', filters.runId);
  }

  if (filters?.createdAfter) {
    q = q.where('createdAt', '>=', filters.createdAfter);
  }

  const snapshot = await q.get();
  const proposals = snapshot.docs.map((doc) => doc.data() as ProposedRelation);
  proposals.sort((a, b) => b.createdAt - a.createdAt);
  return proposals;
}

/**
 * Fetches a single proposed relation by ID. Mirrors `getProposedRelationById`.
 */
export async function getProposedRelationById(id: string): Promise<ProposedRelation | null> {
  const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
  if (docSnap.exists) {
    return docSnap.data() as ProposedRelation;
  }
  return null;
}

/**
 * Fetches a proposed relation by its composite key. Mirrors
 * `getProposedRelationByKey`.
 */
export async function getProposedRelationByKey(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): Promise<ProposedRelation | null> {
  const currentKey = generateProposalKey(sourceId, targetId, relationType);
  const matches: ProposalIdentityCandidate[] = [];
  for (const key of generateProposalKeyCandidates(sourceId, targetId, relationType)) {
    const proposal = await getProposedRelationById(key);
    if (!proposal) continue;
    if (!matchesProposalIdentity(proposal, sourceId, targetId, relationType)) {
      if (key === currentKey) {
        throw new ProposalIdentityConflictError([key], 'V2 proposal identity collision');
      }
      continue;
    }
    matches.push({ key, proposal });
  }
  const { current, legacy } = classifyProposalIdentityCandidates(matches, currentKey);
  if (
    current &&
    legacy.some((candidate) =>
      !proposalArchivesEquivalent(current.proposal, candidate.proposal)
    )
  ) {
    throw new ProposalIdentityConflictError(
      [current.key, ...legacy.map((candidate) => candidate.key)],
      'V2 and legacy proposal archives disagree'
    );
  }
  return current?.proposal ?? legacy[0]?.proposal ?? null;
}

/**
 * Fetches pending proposals between two entities (in either direction). Admin
 * twin of `getPendingProposalsBetween` from the client module — used by the
 * Linker candidate-generator (`src/lib/linker/candidate-generator.ts`) to skip
 * pairs that already have a pending proposal.
 *
 * Replicates the client's two-query, both-direction match (A→B and B→A) over
 * `status == 'pending'`, then concatenates the results in the same order
 * (direction-1 docs first, then direction-2 docs). Return shape is identical.
 *
 * @param entityAId - First entity ID
 * @param entityBId - Second entity ID
 * @returns Promise resolving to array of pending proposals between the entities
 */
export async function adminGetPendingProposalsBetween(
  entityAId: string,
  entityBId: string
): Promise<ProposedRelation[]> {
  // Query for proposals where entityA is source and entityB is target
  const query1 = db
    .collection(COLLECTION_NAME)
    .where('status', '==', 'pending')
    .where('sourceId', '==', entityAId)
    .where('targetId', '==', entityBId);

  // Query for proposals where entityB is source and entityA is target
  const query2 = db
    .collection(COLLECTION_NAME)
    .where('status', '==', 'pending')
    .where('sourceId', '==', entityBId)
    .where('targetId', '==', entityAId);

  const [snap1, snap2] = await Promise.all([query1.get(), query2.get()]);

  const results: ProposedRelation[] = [];
  snap1.docs.forEach((doc) => results.push(doc.data() as ProposedRelation));
  snap2.docs.forEach((doc) => results.push(doc.data() as ProposedRelation));

  return results;
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Creates a new proposed relation if one doesn't already exist. Idempotent and
 * respects the 30-day rejection window. Mirrors
 * `createProposedRelationIfNotExists` — same dedup branches, same return shape
 * (`{ created, proposal, reason? }`), same evidence-array cap, same size
 * validation, same `setDoc`-with-undefined-stripped write semantics.
 *
 * @throws Error if proposal size exceeds limit
 */
export async function createProposedRelationIfNotExists(
  input: CreateProposedRelationInput
): Promise<{ created: boolean; proposal: ProposedRelation; reason?: string }> {
  const currentKey = generateProposalKey(input.sourceId, input.targetId, input.relationType);
  const now = Date.now();

  // Create new proposal
  const proposal: ProposedRelation = {
    id: currentKey,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceSnapshot: input.sourceSnapshot,
    targetType: input.targetType,
    targetId: input.targetId,
    targetSnapshot: input.targetSnapshot,
    relationType: input.relationType,
    confidence: input.confidence,
    reasoning: input.reasoning,
    evidence: input.evidence.slice(0, LIMITS.EVIDENCE_ARRAY_MAX), // Limit evidence count
    status: 'pending',
    discoveredBy: input.discoveredBy,
    runId: input.runId,
    promptVersion: input.promptVersion,
    createdAt: now,
    updatedAt: now,
  };

  // Validate size
  validateProposalSize(proposal);
  const candidateKeys = generateProposalKeyCandidates(
    input.sourceId,
    input.targetId,
    input.relationType
  );
  const candidateRefs = candidateKeys.map((key) => db.collection(COLLECTION_NAME).doc(key));

  return db.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(candidateRefs.map((ref) => transaction.get(ref)));
    const matches: ProposalIdentityCandidate[] = [];
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      const live = snapshot.data() as ProposedRelation;
      const key = candidateKeys[index];
      if (!matchesProposalIdentity(live, input.sourceId, input.targetId, input.relationType)) {
        if (key === currentKey) {
          throw new ProposalIdentityConflictError([key], 'V2 proposal identity collision');
        }
        // Legacy colon-preimage collisions are retained but do not suppress the
        // unrelated v2 proposal.
        return;
      }
      matches.push({ key, proposal: live });
    });

    const { current, legacy } = classifyProposalIdentityCandidates(matches, currentKey);
    if (current) {
      const conflictingLegacy = legacy.filter(
        (candidate) =>
          !proposalArchivesEquivalent(current.proposal, candidate.proposal) &&
          !isExpiredRejectedProposal(candidate.proposal, now)
      );
      if (conflictingLegacy.length > 0) {
        throw new ProposalIdentityConflictError(
          [current.key, ...conflictingLegacy.map((candidate) => candidate.key)],
          'V2 and legacy proposal archives disagree'
        );
      }
    }

    const equivalentCandidates = current
      ? [
          current,
          ...legacy.filter((candidate) =>
            proposalArchivesEquivalent(current.proposal, candidate.proposal)
          ),
        ]
      : legacy;
    const canonicalExisting = equivalentCandidates.length > 0
      ? mergeEquivalentProposalArchives(equivalentCandidates, currentKey)
      : null;
    const reason = canonicalExisting
      ? proposalSuppressionReason(canonicalExisting, now)
      : null;
    if (reason) {
      if (!current || equivalentCandidates.length > 1) {
        transaction.set(candidateRefs[0], removeUndefinedFields(canonicalExisting!));
      }
      for (const candidate of legacy) {
        transaction.delete(candidateRefs[candidateKeys.indexOf(candidate.key)]);
      }
      return { created: false, proposal: canonicalExisting!, reason };
    }

    transaction.set(candidateRefs[0], removeUndefinedFields(proposal));
    for (const candidate of legacy) {
      transaction.delete(candidateRefs[candidateKeys.indexOf(candidate.key)]);
    }
    return { created: true, proposal };
  });
}

/**
 * Creates a proposed relation (simple version without idempotency checks).
 * Use `createProposedRelationIfNotExists` for idempotent creation. Mirrors
 * `createProposedRelation`.
 */
export async function createProposedRelation(input: CreateProposedRelationInput): Promise<ProposedRelation> {
  const result = await createProposedRelationIfNotExists(input);
  return result.proposal;
}

/**
 * Updates a proposed relation. Mirrors `updateProposedRelation` — reads first to
 * 404, strips undefined, stamps `updatedAt`, returns the merged record.
 *
 * @throws Error if proposal not found
 */
export async function updateProposedRelation(
  id: string,
  updates: Partial<Omit<ProposedRelation, 'id' | 'createdAt'>>
): Promise<ProposedRelation> {
  const docRef = db.collection(COLLECTION_NAME).doc(id);
  const existing = await docRef.get();

  if (!existing.exists) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  const updatedData = removeUndefinedFields({
    ...updates,
    updatedAt: Date.now(),
  });

  await docRef.update(updatedData);

  return { ...(existing.data() as ProposedRelation), ...updatedData };
}

export interface MaterializedRelationAttachment {
  proposal: ProposedRelation;
  attached: boolean;
  reason?: 'already-attached' | 'proposal-not-pending';
}

export interface MaterializedRelationAttachmentOptions {
  /** Human approval may intentionally reactivate a previously-rejected claim
   * (or reconcile a stale proposed confidence) after the 30-day proposal
   * retention window. The relation update and pointer write share one tx. */
  allowHumanReactivation?: boolean;
}

/**
 * Correlates a machine-created Relation with its durable triage proposal.
 *
 * The compare-and-set closes the create -> pointer crash window without ever
 * replacing a different relation pointer or reviving a terminal proposal.
 * Callers supply only the candidate id; the transaction reads and validates
 * the authoritative Relation before writing a pointer or reactivation.
 */
export async function attachMaterializedRelationToProposal(
  id: string,
  relation: Pick<Relation, 'id'>,
  options: MaterializedRelationAttachmentOptions = {}
): Promise<MaterializedRelationAttachment> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_NAME).doc(id);
    const snap = await tx.get(ref);
    const stored = snap.data() as ProposedRelation | undefined;
    if (!stored) {
      throw new Error(`Proposed relation not found: ${id}`);
    }
    const proposal = { ...stored, id };
    if (proposal.relationId && proposal.relationId !== relation.id) {
      throw new Error(
        `Proposal ${id} is already attached to a different relation: ${proposal.relationId}`
      );
    }
    // A concurrent terminal review owns the outcome. Return it before applying
    // pending-only Relation checks: that review may already have curated or
    // rejected the claim, and this function has no write left to perform.
    if (proposal.status !== 'pending') {
      return { proposal, attached: false, reason: 'proposal-not-pending' };
    }

    const relationRef = db.collection('relations').doc(relation.id);
    const relationSnap = await tx.get(relationRef);
    const authoritative = relationSnap.data() as Relation | undefined;
    if (!authoritative) {
      throw new Error(`Relation not found while attaching proposal ${id}: ${relation.id}`);
    }
    const authoritativeRelation = { ...authoritative, id: relation.id };
    if (!relationMatchesProposal(authoritativeRelation, proposal)) {
      throw new Error(`Relation ${relation.id} does not match proposal ${id}`);
    }
    const ownerMatches = relationHasProposalOwner(authoritativeRelation, proposal);
    const exactProposed =
      ownerMatches &&
      authoritativeRelation.claimStatus === 'proposed' &&
      authoritativeRelation.confidence === proposal.confidence;
    const exactAlreadyCurated =
      proposal.relationId === relation.id &&
      ownerMatches &&
      authoritativeRelation.claimStatus === 'curated' &&
      authoritativeRelation.confidence === proposal.confidence;
    const humanReactivation =
      options.allowHumanReactivation === true &&
      ownerMatches &&
      (authoritativeRelation.claimStatus === 'rejected' ||
        authoritativeRelation.claimStatus === 'proposed');
    if (!exactProposed && !exactAlreadyCurated && !humanReactivation) {
      throw new Error(
        `Relation ${relation.id} is not the proposal-owned claim for proposal ${id}`
      );
    }
    if (
      humanReactivation &&
      (authoritativeRelation.claimStatus !== 'proposed' ||
        authoritativeRelation.confidence !== proposal.confidence)
    ) {
      tx.update(relationRef, {
        claimStatus: 'proposed',
        confidence: proposal.confidence,
        updatedAt: now,
      });
    }
    if (proposal.relationId === relation.id) {
      return { proposal, attached: false, reason: 'already-attached' };
    }

    const updated: ProposedRelation = {
      ...proposal,
      relationId: relation.id,
      updatedAt: now,
    };
    tx.update(ref, { relationId: relation.id, updatedAt: now });
    return { proposal: updated, attached: true };
  });
}

// ============================================================================
// TRIAGE OPERATIONS
// ============================================================================

/**
 * Approves a proposed relation. Idempotent when already approved, throws on
 * non-pending. Proposal-owned claims use proposed -> pointer -> curate ->
 * approval ordering. Existing foreign/manual duplicates keep their ownership
 * metadata and are enriched only after the approval CAS wins.
 *
 * @throws Error if proposal not found or not pending, or if relation creation
 * fails or relation/proposal identity changes during approval
 */
async function approveProposedRelationInternal(
  id: string,
  reviewedBy: string,
  options: {
    approvalActor: 'human' | 'machine';
    feedbackUserId?: string;
    correlationId?: string;
  }
): Promise<MachineRelationApprovalResult> {
  const correlationContext = triageCorrelationContext(options.correlationId);
  const proposal = await getProposedRelationById(id);
  const isMachineApproval = options.approvalActor === 'machine';

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  if (
    isMachineApproval &&
    proposal.status === 'pending' &&
    proposal.confidence < machineRelationAutoApprovalThreshold(getDiscoveryConfig().asserterReliabilityEnabled)
  ) {
    return { applied: false, proposal, reason: 'below-materialization-floor' };
  }

  // If already approved, return the existing proposal (idempotent operation).
  if (proposal.status === 'approved') {
    log.warn('Proposal is already approved, returning existing', { id });
    if (!proposal.relationId) {
      throw new Error(
        `Approved proposal ${id} has no backing relation pointer`
      );
    }
    // Older approvals may predate durable provenance enrichment. Replaying an
    // approved proposal repairs the linked relation without creating a second
    // relation or changing the proposal's terminal status.
    const { adminGetRelationById } = await import('@/lib/relations-admin');
    const existingRelation = await adminGetRelationById(proposal.relationId);
    if (!existingRelation) {
      throw new Error(
        `Approved proposal ${id} points to missing relation ${proposal.relationId}`
      );
    }
    const ownership = relationHasExactProposalProvenance(
      existingRelation,
      proposal,
      ['proposed', 'curated']
    )
      ? 'proposal-owned'
      : 'foreign-duplicate';
    await enrichApprovedRelation(
      existingRelation,
      proposal,
      isMachineApproval,
      correlationContext,
      ownership
    );
    return { applied: true, transitioned: false, proposal };
  }

  // If not pending (e.g., rejected or dismissed), throw error.
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is not pending: ${proposal.status}`);
  }

  // Proposal-owned claims follow proposed -> pointer -> curate -> terminal CAS.
  // That ordering leaves every crash state recoverable by retry or negative
  // triage. A pre-existing foreign/manual duplicate follows terminal CAS first,
  // then non-destructive evidence enrichment, so a concurrent reject cannot
  // write proposal provenance onto somebody else's relation.
  const { adminCreateRelationFromIds, adminGetRelationById, DuplicateRelationError } = await import(
    '@/lib/relations-admin'
  );
  let relationId: string;
  const evidenceRefs = proposalProvenanceToEvidenceRefs(proposal);
  let materializedRelation: Relation;
  let proposalOwnedClaim = false;

  const resolveAttachmentRace = async (
    attachment: MaterializedRelationAttachment,
    ownedRelationId: string
  ): Promise<MachineRelationApprovalResult | null> => {
    if (attachment.reason !== 'proposal-not-pending') return null;
    if (attachment.proposal.status === 'approved') {
      return { applied: true, transitioned: false, proposal: attachment.proposal };
    }
    if (!['rejected', 'dismissed', 'removed'].includes(attachment.proposal.status)) {
      throw new Error(
        `Proposal ${id} became ${attachment.proposal.status} before relation attachment`
      );
    }
    await rejectMaterializedClaimForProposal(
      { ...attachment.proposal, relationId: ownedRelationId },
      correlationContext,
      attachment.proposal.status === 'dismissed' ? 'dismissed' : 'rejected'
    );
    return {
      applied: false,
      proposal: attachment.proposal,
      reason: 'lost-to-terminal-review',
    };
  };

  if (proposal.relationId) {
    const correlated = await adminGetRelationById(proposal.relationId);
    if (!correlated) {
      throw new Error(
        `Proposal ${id} points to missing relation ${proposal.relationId}; refusing to create a replacement`
      );
    }
    if (!relationMatchesProposal(correlated, proposal)) {
      throw new Error(
        `Proposal ${id} points to relation ${proposal.relationId} with different identity`
      );
    }
    const exactOwned = relationHasExactProposalProvenance(
      correlated,
      proposal,
      ['proposed', 'curated']
    );
    const humanReactivation =
      !isMachineApproval &&
      relationHasProposalOwner(correlated, proposal) &&
      ['proposed', 'rejected'].includes(correlated.claimStatus ?? '');
    if (
      isMachineApproval &&
      relationHasProposalOwner(correlated, proposal) &&
      !exactOwned
    ) {
      return { applied: false, proposal, reason: 'requires-human-reactivation' };
    }
    proposalOwnedClaim = exactOwned || humanReactivation;
    materializedRelation = correlated;
    relationId = correlated.id;
    if (proposalOwnedClaim) {
      const attachment = await attachMaterializedRelationToProposal(id, correlated, {
        allowHumanReactivation: !isMachineApproval,
      });
      const raceResult = await resolveAttachmentRace(attachment, relationId);
      if (raceResult) return raceResult;
      materializedRelation = await enrichApprovedRelation(
        correlated,
        proposal,
        isMachineApproval,
        correlationContext,
        'proposal-owned'
      );
    }
  } else {
    try {
      const returnedRelation = await adminCreateRelationFromIds(
        {
          sourceId: proposal.sourceId,
          sourceType: proposal.sourceType,
          targetId: proposal.targetId,
          targetType: proposal.targetType,
          relationType: proposal.relationType,
          confidence: proposal.confidence,
          aiSuggested: true,
          agentName: agentNameForDiscoverySource(proposal.discoveredBy),
          evidenceRefs,
          reasoningSummary: proposal.reasoning,
          // Always start withheld. Human curation happens only after the exact
          // relation pointer is durable on the proposal.
          claimStatus: 'proposed',
        },
        ...correlationArgument(correlationContext)
      );
      // `adminCreateRelationFromIds` may return a pre-existing row from its
      // idempotency fast path. Classify the authoritative row exactly as the
      // DuplicateRelationError path; a resolved return does not imply ownership.
      materializedRelation =
        (await adminGetRelationById(returnedRelation.id)) ?? returnedRelation;
      if (!relationMatchesProposal(materializedRelation, proposal)) {
        throw new Error(
          `Returned relation ${materializedRelation.id} does not match proposal ${id}`
        );
      }
      const exactProposed = relationHasExactProposalProvenance(
        materializedRelation,
        proposal,
        ['proposed']
      );
      const humanReactivation =
        !isMachineApproval &&
        relationHasProposalOwner(materializedRelation, proposal) &&
        ['proposed', 'rejected'].includes(materializedRelation.claimStatus ?? '');
      if (
        isMachineApproval &&
        relationHasProposalOwner(materializedRelation, proposal) &&
        !exactProposed
      ) {
        return { applied: false, proposal, reason: 'requires-human-reactivation' };
      }
      proposalOwnedClaim = exactProposed || humanReactivation;
    } catch (relationError) {
      if (relationError instanceof DuplicateRelationError) {
        materializedRelation =
          (await adminGetRelationById(relationError.existingRelation.id)) ??
          relationError.existingRelation;
        if (!relationMatchesProposal(materializedRelation, proposal)) {
          throw new Error(
            `Duplicate relation ${materializedRelation.id} does not match proposal ${id}`
          );
        }
        const exactProposed = relationHasExactProposalProvenance(
          materializedRelation,
          proposal,
          ['proposed']
        );
        const humanReactivation =
          !isMachineApproval &&
          relationHasProposalOwner(materializedRelation, proposal) &&
          ['proposed', 'rejected'].includes(materializedRelation.claimStatus ?? '');
        if (
          isMachineApproval &&
          relationHasProposalOwner(materializedRelation, proposal) &&
          !exactProposed
        ) {
          return { applied: false, proposal, reason: 'requires-human-reactivation' };
        }
        proposalOwnedClaim = exactProposed || humanReactivation;
      } else {
        log.error(
          'Relation creation during approval FAILED — approval aborted',
          relationError instanceof Error ? relationError : new Error(String(relationError)),
          { proposalId: id }
        );
        throw relationError; // fail-loud: no 200 without the relation
      }
    }
    relationId = materializedRelation.id;
    if (proposalOwnedClaim) {
      const attachment = await attachMaterializedRelationToProposal(id, materializedRelation, {
        allowHumanReactivation: !isMachineApproval,
      });
      const raceResult = await resolveAttachmentRace(attachment, relationId);
      if (raceResult) return raceResult;
      materializedRelation = await enrichApprovedRelation(
        materializedRelation,
        proposal,
        isMachineApproval,
        correlationContext,
        'proposal-owned'
      );
    }
  }

  // BUILD-021: the terminal flip is a compare-and-set — only a still-pending
  // proposal can be approved, so when a human and the autopilot race, exactly
  // ONE writer sets reviewedBy/reviewedAt (no last-writer-wins provenance).
  const casNow = Date.now();
  const casResult = await db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_NAME).doc(id);
    const snap = await tx.get(ref);
    const current = snap.data() as ProposedRelation | undefined;
    if (!current) throw new Error(`Proposed relation vanished during approval: ${id}`);
    if (current.status !== 'pending') {
      return { won: false as const, current };
    }
    if (current.relationId && current.relationId !== relationId) {
      throw new Error(
        `Proposal ${id} acquired a different relation pointer before approval: ${current.relationId}`
      );
    }
    const relationRef = db.collection('relations').doc(relationId);
    const relationSnap = await tx.get(relationRef);
    const freshRelation = relationSnap.data() as Relation | undefined;
    if (!freshRelation) {
      throw new Error(`Relation ${relationId} vanished before proposal ${id} approval`);
    }
    const authoritativeRelation = { ...freshRelation, id: relationId };
    if (!relationMatchesProposal(authoritativeRelation, proposal)) {
      throw new Error(
        `Relation ${relationId} changed identity before proposal ${id} approval`
      );
    }
    if (
      proposalOwnedClaim &&
      !relationHasExactProposalProvenance(
        authoritativeRelation,
        proposal,
        ['proposed', 'curated']
      )
    ) {
      throw new Error(
        `Relation ${relationId} changed provenance before proposal ${id} approval`
      );
    }
    tx.update(ref, { status: 'approved', reviewedAt: casNow, reviewedBy, relationId, updatedAt: casNow });
    return {
      won: true as const,
      current: { ...current, status: 'approved' as const, reviewedAt: casNow, reviewedBy, relationId },
    };
  });

  if (!casResult.won) {
    if (casResult.current.status === 'approved') {
      if (!casResult.current.relationId) {
        throw new Error(
          `Approved proposal ${id} has no backing relation pointer`
        );
      }
      if (casResult.current.relationId !== relationId) {
        throw new Error(
          `Proposal ${id} was concurrently approved with a different relation pointer: ${casResult.current.relationId}`
        );
      }
      // Lost the race to a concurrent approver — their provenance stands; the
      // exact-owned relation was already converged before the CAS. Foreign
      // duplicates are enriched only after an approval has definitely won.
      if (!proposalOwnedClaim) {
        await enrichApprovedRelation(
          materializedRelation,
          proposal,
          isMachineApproval,
          correlationContext,
          'foreign-duplicate'
        );
      }
      log.info('Approval CAS lost to a concurrent approver — keeping their provenance', {
        proposalId: id,
        winnerReviewedBy: casResult.current.reviewedBy,
      });
      return { applied: true, transitioned: false, proposal: casResult.current };
    }
    // The proposal was rejected/dismissed while we were materializing. Only a
    // proposal-owned claim may be invalidated; a manual/foreign duplicate is
    // left byte-for-byte untouched.
    log.warn('Approval CAS lost to a terminal reject/dismiss', {
      proposalId: id,
      relationId,
      terminalStatus: casResult.current.status,
      proposalOwnedClaim,
    });
    if (proposalOwnedClaim) {
      await rejectMaterializedClaimForProposal(
        { ...casResult.current, relationId },
        correlationContext,
        casResult.current.status === 'dismissed' ? 'dismissed' : 'rejected'
      );
    }
    return { applied: false, proposal: casResult.current, reason: 'lost-to-terminal-review' };
  }

  if (!proposalOwnedClaim) {
    await enrichApprovedRelation(
      materializedRelation,
      proposal,
      isMachineApproval,
      correlationContext,
      'foreign-duplicate'
    );
  }

  await recordRelationTriageFeedback(
    isMachineApproval ? undefined : options.feedbackUserId,
    id,
    proposal,
    'approved'
  );
  return { applied: true, transitioned: true, proposal: casResult.current };
}

export interface RelationTriageTransitionResult {
  proposal: ProposedRelation;
  transitioned: boolean;
}

/** Human approval is authoritative and stamps the backing claim as curated. */
export async function approveProposedRelationWithOutcome(
  id: string,
  reviewedBy: string,
  options?: TriageFeedbackOptions
): Promise<RelationTriageTransitionResult> {
  const result = await approveProposedRelationInternal(id, reviewedBy, {
    approvalActor: 'human',
    feedbackUserId: options?.feedbackUserId,
    correlationId: options?.correlationId,
  });
  if (!result.applied) {
    if (result.reason === 'lost-to-terminal-review') {
      // BUILD-021: another reviewer rejected/dismissed this proposal while
      // the approval was in flight — their decision stands and the
      // materialized claim was already marked rejected for edge cleanup.
      throw new Error(
        `Proposal ${id} was ${result.proposal.status} by another reviewer while this approval was in flight — their decision stands`
      );
    }
    throw new Error(`Human approval unexpectedly deferred for proposal ${id}`);
  }
  return { proposal: result.proposal, transitioned: result.transitioned };
}

export async function approveProposedRelation(
  id: string,
  reviewedBy: string,
  options?: TriageFeedbackOptions
): Promise<ProposedRelation> {
  return (await approveProposedRelationWithOutcome(id, reviewedBy, options)).proposal;
}

/**
 * Machine approval keeps proposed provenance and closes triage only when the
 * relation is guaranteed to clear the graph gate under the worst reliability
 * penalty. Lower-confidence proposals and rejected-claim reactivation remain
 * pending for human review.
 */
export async function approveProposedRelationAsMachine(
  id: string,
  reviewedBy: string
): Promise<MachineRelationApprovalResult> {
  return approveProposedRelationInternal(id, reviewedBy, { approvalActor: 'machine' });
}

/**
 * Rejects a proposed relation. Mirrors `rejectProposedRelation` — idempotent
 * when already rejected, throws on non-pending.
 *
 * @throws Error if proposal not found or not pending
 */
export async function rejectProposedRelationWithOutcome(
  id: string,
  reviewedBy: string,
  feedbackReason?: string,
  options?: TriageFeedbackOptions
): Promise<RelationTriageTransitionResult> {
  const correlationContext = triageCorrelationContext(options?.correlationId);
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // If already rejected, return the existing proposal (idempotent operation).
  if (proposal.status === 'rejected') {
    log.warn('Proposal is already rejected, returning existing', { id });
    await rejectMaterializedClaimForProposal(proposal, correlationContext, 'rejected');
    return { proposal, transitioned: false };
  }

  // If not pending (e.g., approved or dismissed), throw error.
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is not pending: ${proposal.status}`);
  }

  const reviewedAt = Date.now();
  const casResult = await db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_NAME).doc(id);
    const snap = await tx.get(ref);
    const current = snap.data() as ProposedRelation | undefined;
    if (!current) throw new Error(`Proposed relation vanished during rejection: ${id}`);
    const currentProposal = { ...current, id };
    if (current.status === 'rejected') {
      return { won: false as const, proposal: currentProposal };
    }
    if (current.status !== 'pending') {
      throw new Error(`Proposal is not pending: ${current.status}`);
    }
    const updates = removeUndefinedFields({
      status: 'rejected' as const,
      reviewedAt,
      reviewedBy,
      feedbackReason,
      updatedAt: reviewedAt,
    });
    tx.update(ref, updates);
    return {
      won: true as const,
      before: currentProposal,
      proposal: { ...currentProposal, ...updates },
    };
  });
  if (!casResult.won) {
    log.warn('Proposal rejection lost to an already-completed rejection', { id });
    await rejectMaterializedClaimForProposal(casResult.proposal, correlationContext, 'rejected');
    return { proposal: casResult.proposal, transitioned: false };
  }
  const decisionSource = casResult.before;
  const updated = casResult.proposal;
  // BUILD-022/AUDIT-023: invalidate either the exact pointer or the narrowly
  // adopted machine/proposed triple from the create -> pointer crash window.
  await rejectMaterializedClaimForProposal(decisionSource, correlationContext, 'rejected');
  await recordRelationTriageFeedback(options?.feedbackUserId, id, decisionSource, 'rejected', feedbackReason);
  return { proposal: updated, transitioned: true };
}

export async function rejectProposedRelation(
  id: string,
  reviewedBy: string,
  feedbackReason?: string,
  options?: TriageFeedbackOptions
): Promise<ProposedRelation> {
  return (await rejectProposedRelationWithOutcome(id, reviewedBy, feedbackReason, options)).proposal;
}

/**
 * Dismisses a proposed relation (won't be re-proposed). Mirrors
 * `dismissProposedRelation`.
 */
export async function dismissProposedRelation(
  id: string,
  reviewedBy: string,
  options?: TriageFeedbackOptions
): Promise<ProposedRelation> {
  const correlationContext = triageCorrelationContext(options?.correlationId);
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // If already dismissed, return the existing proposal (idempotent operation).
  if (proposal.status === 'dismissed') {
    log.warn('Proposal is already dismissed, returning existing', { id });
    await rejectMaterializedClaimForProposal(proposal, correlationContext, 'dismissed');
    return proposal;
  }

  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is not pending: ${proposal.status}`);
  }

  const reviewedAt = Date.now();
  const casResult = await db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_NAME).doc(id);
    const snap = await tx.get(ref);
    const current = snap.data() as ProposedRelation | undefined;
    if (!current) throw new Error(`Proposed relation vanished during dismissal: ${id}`);
    const currentProposal = { ...current, id };
    if (current.status === 'dismissed') {
      return { won: false as const, proposal: currentProposal };
    }
    if (current.status !== 'pending') {
      throw new Error(`Proposal is not pending: ${current.status}`);
    }
    const updates = {
      status: 'dismissed' as const,
      reviewedAt,
      reviewedBy,
      updatedAt: reviewedAt,
    };
    tx.update(ref, updates);
    return {
      won: true as const,
      before: currentProposal,
      proposal: { ...currentProposal, ...updates },
    };
  });
  if (!casResult.won) {
    await rejectMaterializedClaimForProposal(casResult.proposal, correlationContext, 'dismissed');
    return casResult.proposal;
  }

  await rejectMaterializedClaimForProposal(casResult.before, correlationContext, 'dismissed');
  await recordRelationTriageFeedback(options?.feedbackUserId, id, casResult.before, 'dismissed');
  return casResult.proposal;
}

/**
 * Bulk approves multiple proposals. Mirrors `bulkApproveProposedRelations` —
 * `Promise.allSettled`, same `{ approved, failed, errors }` aggregation and
 * `${id}: ${reason}` error formatting.
 */
export async function bulkApproveProposedRelations(
  ids: string[],
  reviewedBy: string,
  options?: TriageFeedbackOptions
): Promise<{ approved: number; failed: number; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => approveProposedRelation(id, reviewedBy, options)));

  const errors: string[] = [];
  let approved = 0;
  let failed = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      approved++;
    } else {
      failed++;
      errors.push(`${ids[index]}: ${result.reason}`);
    }
  });

  return { approved, failed, errors };
}

/**
 * Bulk rejects multiple proposals. Mirrors `bulkRejectProposedRelations`.
 */
export async function bulkRejectProposedRelations(
  ids: string[],
  reviewedBy: string,
  options?: TriageFeedbackOptions
): Promise<{ rejected: number; failed: number; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => rejectProposedRelation(id, reviewedBy, undefined, options)));

  const errors: string[] = [];
  let rejected = 0;
  let failed = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      rejected++;
    } else {
      failed++;
      errors.push(`${ids[index]}: ${result.reason}`);
    }
  });

  return { rejected, failed, errors };
}

// ============================================================================
// CLEANUP OPERATIONS
// ============================================================================

/**
 * Deletes a proposed relation. Mirrors `deleteProposedRelation`.
 */
export async function deleteProposedRelation(id: string): Promise<void> {
  await db.collection(COLLECTION_NAME).doc(id).delete();
}

/**
 * Cleans up old rejected proposals past the retention period. Mirrors
 * `cleanupOldRejectedProposals` — same `status == 'rejected'` + `updatedAt <
 * cutoff` filter, parallel deletes, returns the number of proposals deleted.
 *
 * @returns Number of proposals deleted
 */
export async function cleanupOldRejectedProposals(): Promise<number> {
  const cutoff = Date.now() - REJECTION_RETENTION_MS;

  const snapshot = await db
    .collection(COLLECTION_NAME)
    .where('status', '==', 'rejected')
    .where('updatedAt', '<', cutoff)
    .get();

  const deletePromises = snapshot.docs.map((doc) => doc.ref.delete());
  await Promise.all(deletePromises);

  return snapshot.docs.length;
}

/**
 * Cleans up proposed relations where source or target entity no longer exists.
 * Mirrors `cleanupOrphanedProposals` — checks every pending proposal's source
 * and target via `checkEntityExists`, deletes the ones with a missing endpoint,
 * and returns the same `{ checked, orphaned, deleted }` statistics. Same
 * per-proposal try/catch (a check failure is logged and skipped, not fatal) and
 * per-delete try/catch (a delete failure is logged and the count not
 * incremented) as the client.
 *
 * @returns Cleanup statistics
 */
export async function cleanupOrphanedProposals(): Promise<{
  checked: number;
  orphaned: number;
  deleted: number;
}> {
  log.info('Starting orphaned proposal cleanup');

  // Get all pending proposals
  const pendingProposals = await getProposedRelations({ status: 'pending' });
  log.info('Checking pending proposals', { count: pendingProposals.length });

  const orphanedIds: string[] = [];

  // Check each proposal for orphaned entities
  for (const proposal of pendingProposals) {
    try {
      // Check if source entity exists
      const sourceExists = await checkEntityExists(proposal.sourceType, proposal.sourceId);

      // Check if target entity exists
      const targetExists = await checkEntityExists(proposal.targetType, proposal.targetId);

      if (!sourceExists || !targetExists) {
        log.info('Found orphaned proposal', { id: proposal.id, sourceExists, targetExists });
        orphanedIds.push(proposal.id);
      }
    } catch (error) {
      log.warn('Error checking proposal', { id: proposal.id, error: String(error) });
    }
  }

  // Delete orphaned proposals
  let deleted = 0;
  for (const id of orphanedIds) {
    try {
      await db.collection(COLLECTION_NAME).doc(id).delete();
      deleted++;
    } catch (error) {
      log.error('Failed to delete orphaned proposal', error instanceof Error ? error : new Error(String(error)), {
        id,
      });
    }
  }

  log.info('Cleanup complete', { checked: pendingProposals.length, orphaned: orphanedIds.length, deleted });

  return {
    checked: pendingProposals.length,
    orphaned: orphanedIds.length,
    deleted,
  };
}

/**
 * Checks if an entity exists in Firestore. Used by `cleanupOrphanedProposals` to
 * detect orphaned references. Mirrors the client's private `checkEntityExists` —
 * same `EntityType → collection` map, same unknown-type warning + `false`
 * return, same error-swallowing (log + `false`) on read failure.
 *
 * @param entityType - Type of entity
 * @param entityId - Entity ID
 * @returns True if entity exists
 */
async function checkEntityExists(entityType: EntityType, entityId: string): Promise<boolean> {
  // Canonical EntityType→collection map — admin twin of the client
  // checkEntityExists. Local copy used the wrong `useCases`/`orgUnits`
  // spellings (see entity-collections.ts).
  const collectionName = ENTITY_COLLECTIONS[entityType];
  if (!collectionName) {
    log.warn('Unknown entity type', { entityType });
    return false;
  }

  try {
    const docSnap = await db.collection(collectionName).doc(entityId).get();
    return docSnap.exists;
  } catch (error) {
    log.error('Error checking entity existence', error instanceof Error ? error : new Error(String(error)), {
      entityType,
      entityId,
    });
    return false;
  }
}
