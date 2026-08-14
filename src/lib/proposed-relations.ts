/**
 * @file proposed-relations.ts
 * @description Data access layer for Proposed Relations (Universal Relations Sprint)
 *
 * ProposedRelations are AI-suggested relationships between entities that await
 * human review in the triage workflow. This module provides CRUD operations,
 * idempotency controls, and triage workflow management.
 *
 * **Key Features:**
 * - Idempotent creation using composite keys
 * - Duplicate detection across pending/rejected states
 * - Soft delete for rejected proposals (30-day retention)
 * - Metrics tracking integration
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { db, removeUndefinedFields } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getCountFromServer,
  runTransaction,
  QueryConstraint,
} from 'firebase/firestore';
import type {
  ProposedRelation,
  CreateProposedRelationInput,
  ProposedRelationStatus,
  RelationType,
  EntityType,
  RelationDiscoverySource,
  MinimalEntitySnapshot,
} from '@/lib/types';
import { PROPOSED_RELATION_LIMITS as LIMITS } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { isSymmetricRelationType } from '@/lib/relation-symmetry-contract';
import {
  generateProposalKey,
  generateProposalKeyCandidates,
  matchesProposalIdentity,
  mergeEquivalentProposalArchives,
  proposalArchivesEquivalent,
  ProposalIdentityConflictError,
} from '@/lib/proposed-relation-key';
export { generateProposalKey } from '@/lib/proposed-relation-key';
const log = createLogger('proposed-relations');

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Collection name in Firestore.
 */
const COLLECTION_NAME = 'proposedRelations';

/**
 * Retention period for rejected proposals (30 days in milliseconds).
 */
const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function proposalSuppressionReason(proposal: ProposedRelation, now: number): string | null {
  if (proposal.status === 'pending') return 'already_pending';
  if (proposal.status === 'rejected' && proposal.updatedAt > now - REJECTION_RETENTION_MS) {
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
    legacy.slice(1).some((candidate) => !proposalArchivesEquivalent(legacy[0].proposal, candidate.proposal))
  ) {
    throw new ProposalIdentityConflictError(
      legacy.map((candidate) => candidate.key),
      'Directional legacy proposal archives disagree'
    );
  }
  return { current, legacy };
}

function isExpiredRejectedProposal(proposal: ProposedRelation, now: number): boolean {
  return proposal.status === 'rejected' && proposal.updatedAt <= now - REJECTION_RETENTION_MS;
}

/**
 * Checks if a relation type is symmetric.
 *
 * @param relationType - The relation type to check
 * @returns True if the relation is symmetric
 */
export function isSymmetricRelation(relationType: RelationType): boolean {
  return isSymmetricRelationType(relationType);
}

// ============================================================================
// FILTERS & QUERIES
// ============================================================================

/**
 * Filter options for querying proposed relations.
 */
export interface ProposedRelationFilters {
  /** Filter by status */
  status?: ProposedRelationStatus | ProposedRelationStatus[];
  /** Filter by source entity type */
  sourceType?: EntityType | EntityType[];
  /** Filter by target entity type */
  targetType?: EntityType | EntityType[];
  /** Filter by relation type */
  relationType?: RelationType | RelationType[];
  /** Filter by discovery source */
  discoveredBy?: RelationDiscoverySource | RelationDiscoverySource[];
  /** Minimum confidence threshold (0-100) */
  minConfidence?: number;
  /** Filter by Linker run ID */
  runId?: string;
  /** Include only proposals newer than this timestamp */
  createdAfter?: number;
  /** Include only proposals older than this timestamp */
  createdBefore?: number;
}

/**
 * Pagination options for cursor-based pagination.
 */
export interface PaginationOptions {
  /** Number of items per page */
  limit?: number;
  /** Cursor for pagination (document ID of last item) */
  cursor?: string;
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Result of a paginated query.
 */
export interface PaginatedResult<T> {
  /** Items for current page */
  items: T[];
  /** Cursor for next page (null if no more pages) */
  nextCursor: string | null;
  /** Total count (if requested) */
  totalCount?: number;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Fetches all proposed relations matching the given filters.
 *
 * @param filters - Optional filter criteria
 * @returns Promise resolving to array of ProposedRelation objects
 * @throws Error if Firestore query fails
 */
export async function getProposedRelations(filters?: ProposedRelationFilters): Promise<ProposedRelation[]> {
  const constraints: QueryConstraint[] = [];

  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length === 1) {
      constraints.push(where('status', '==', statuses[0]));
    } else {
      constraints.push(where('status', 'in', statuses));
    }
  }

  if (filters?.sourceType) {
    const types = Array.isArray(filters.sourceType) ? filters.sourceType : [filters.sourceType];
    if (types.length === 1) {
      constraints.push(where('sourceType', '==', types[0]));
    } else {
      constraints.push(where('sourceType', 'in', types));
    }
  }

  if (filters?.relationType) {
    const types = Array.isArray(filters.relationType) ? filters.relationType : [filters.relationType];
    if (types.length === 1) {
      constraints.push(where('relationType', '==', types[0]));
    } else {
      constraints.push(where('relationType', 'in', types));
    }
  }

  if (filters?.minConfidence !== undefined) {
    constraints.push(where('confidence', '>=', filters.minConfidence));
  }

  if (filters?.runId) {
    constraints.push(where('runId', '==', filters.runId));
  }

  if (filters?.createdAfter) {
    constraints.push(where('createdAt', '>=', filters.createdAfter));
  }

  // Default sort by createdAt descending
  constraints.push(orderBy('createdAt', 'desc'));

  const q = query(collection(db, COLLECTION_NAME), ...constraints);
  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => doc.data() as ProposedRelation);
}

/**
 * Fetches proposed relations with cursor-based pagination.
 *
 * @param filters - Optional filter criteria
 * @param pagination - Pagination options
 * @returns Promise resolving to paginated result
 */
export async function getProposedRelationsPaginated(
  filters?: ProposedRelationFilters,
  pagination?: PaginationOptions
): Promise<PaginatedResult<ProposedRelation>> {
  const pageLimit = pagination?.limit ?? 20;
  const constraints: QueryConstraint[] = [];

  // Apply filters
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length === 1) {
      constraints.push(where('status', '==', statuses[0]));
    } else {
      constraints.push(where('status', 'in', statuses));
    }
  }

  if (filters?.minConfidence !== undefined) {
    constraints.push(where('confidence', '>=', filters.minConfidence));
  }

  // Sort order
  constraints.push(orderBy('createdAt', pagination?.sortOrder === 'asc' ? 'asc' : 'desc'));

  // Handle cursor
  if (pagination?.cursor) {
    const cursorDoc = await getDoc(doc(db, COLLECTION_NAME, pagination.cursor));
    if (cursorDoc.exists()) {
      constraints.push(startAfter(cursorDoc));
    }
  }

  // Add limit (fetch one extra to detect if there's a next page)
  constraints.push(limit(pageLimit + 1));

  const q = query(collection(db, COLLECTION_NAME), ...constraints);
  const snapshot = await getDocs(q);

  const docs = snapshot.docs;
  const hasNextPage = docs.length > pageLimit;
  const items = docs.slice(0, pageLimit).map((doc) => doc.data() as ProposedRelation);
  const nextCursor = hasNextPage ? (items[items.length - 1]?.id ?? null) : null;

  return {
    items,
    nextCursor,
  };
}

/**
 * Fetches a single proposed relation by ID.
 *
 * @param id - The unique identifier
 * @returns Promise resolving to ProposedRelation or null
 */
export async function getProposedRelationById(id: string): Promise<ProposedRelation | null> {
  const docRef = doc(db, COLLECTION_NAME, id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as ProposedRelation;
  }
  return null;
}

/**
 * Fetches a proposed relation by its composite key.
 *
 * @param sourceId - Source entity ID
 * @param targetId - Target entity ID
 * @param relationType - Relation type
 * @returns Promise resolving to ProposedRelation or null
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
  if (current && legacy.some((candidate) => !proposalArchivesEquivalent(current.proposal, candidate.proposal))) {
    throw new ProposalIdentityConflictError(
      [current.key, ...legacy.map((candidate) => candidate.key)],
      'V2 and legacy proposal archives disagree'
    );
  }
  return current?.proposal ?? legacy[0]?.proposal ?? null;
}

/**
 * Counts pending proposed relations.
 *
 * @returns Promise resolving to count of pending proposals
 */
export async function getPendingProposedRelationsCount(): Promise<number> {
  const q = query(collection(db, COLLECTION_NAME), where('status', '==', 'pending'));
  const snapshot = await getCountFromServer(q);
  return snapshot.data().count;
}

/**
 * Fetches all proposed relations for a specific entity.
 *
 * @param entityId - The entity ID
 * @returns Promise resolving to array of ProposedRelations
 */
export async function getProposedRelationsByEntity(entityId: string): Promise<ProposedRelation[]> {
  // Query for relations where entity is source
  const sourceQuery = query(
    collection(db, COLLECTION_NAME),
    where('sourceId', '==', entityId),
    orderBy('createdAt', 'desc')
  );

  // Query for relations where entity is target
  const targetQuery = query(
    collection(db, COLLECTION_NAME),
    where('targetId', '==', entityId),
    orderBy('createdAt', 'desc')
  );

  const [sourceSnap, targetSnap] = await Promise.all([getDocs(sourceQuery), getDocs(targetQuery)]);

  const relations = new Map<string, ProposedRelation>();

  // Deduplicate by ID
  sourceSnap.docs.forEach((doc) => {
    relations.set(doc.id, doc.data() as ProposedRelation);
  });
  targetSnap.docs.forEach((doc) => {
    relations.set(doc.id, doc.data() as ProposedRelation);
  });

  return Array.from(relations.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * PII patterns for sanitization.
 */
const PII_PATTERNS = [
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[EMAIL]' },
  { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, replacement: '[PHONE]' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[CARD]' },
];

/**
 * Sanitizes text by removing PII and truncating to max length.
 *
 * @param text - Text to sanitize
 * @param maxLength - Maximum length
 * @returns Sanitized text
 */
export function sanitizeText(text: string, maxLength: number): string {
  let sanitized = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.slice(0, maxLength);
}

/**
 * Validates proposal size before writing.
 *
 * @param proposal - The proposal to validate
 * @throws Error if proposal exceeds size limit
 */
export function validateProposalSize(proposal: ProposedRelation): void {
  const size = JSON.stringify(proposal).length;
  if (size > LIMITS.PROPOSAL_MAX_SIZE) {
    throw new Error(`Proposal exceeds size limit: ${size} > ${LIMITS.PROPOSAL_MAX_SIZE}`);
  }
}

/**
 * Creates a minimal entity snapshot with truncation and PII removal.
 *
 * Firestore does not allow `undefined` values, so we only include
 * optional fields when they have actual values.
 *
 * @param type - Entity type
 * @param id - Entity ID
 * @param name - Entity name
 * @param description - Entity description (optional)
 * @param status - Entity status (optional)
 * @returns MinimalEntitySnapshot
 */
export function createMinimalSnapshot(
  type: EntityType,
  id: string,
  name: string,
  description?: string,
  status?: string
): MinimalEntitySnapshot {
  const snapshot: MinimalEntitySnapshot = {
    type,
    id,
    name: sanitizeText(name, LIMITS.SNAPSHOT_NAME_MAX),
    snapshotAt: Date.now(),
  };

  // Only include optional fields if they have values (Firestore rejects undefined)
  if (description) {
    snapshot.description = sanitizeText(description, LIMITS.SNAPSHOT_DESCRIPTION_MAX);
  }

  if (status) {
    snapshot.status = status;
  }

  return snapshot;
}

/**
 * Creates a new proposed relation if one doesn't already exist.
 *
 * This function is idempotent - it will not create duplicate proposals.
 * It also respects the 30-day rejection window.
 *
 * @param input - The proposal data
 * @returns Object indicating whether creation succeeded and the proposal
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
  const candidateKeys = generateProposalKeyCandidates(input.sourceId, input.targetId, input.relationType);
  const candidateRefs = candidateKeys.map((key) => doc(db, COLLECTION_NAME, key));

  return runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all(candidateRefs.map((ref) => transaction.get(ref)));
    const matches: ProposalIdentityCandidate[] = [];
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) return;
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
      ? [current, ...legacy.filter((candidate) => proposalArchivesEquivalent(current.proposal, candidate.proposal))]
      : legacy;
    const canonicalExisting =
      equivalentCandidates.length > 0 ? mergeEquivalentProposalArchives(equivalentCandidates, currentKey) : null;
    const reason = canonicalExisting ? proposalSuppressionReason(canonicalExisting, now) : null;
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
 * Use createProposedRelationIfNotExists for idempotent creation.
 *
 * @param input - The proposal data
 * @returns The created proposal
 */
export async function createProposedRelation(input: CreateProposedRelationInput): Promise<ProposedRelation> {
  const result = await createProposedRelationIfNotExists(input);
  return result.proposal;
}

/**
 * Updates a proposed relation.
 *
 * @param id - The proposal ID
 * @param updates - Partial updates to apply
 * @returns The updated proposal
 * @throws Error if proposal not found
 */
export async function updateProposedRelation(
  id: string,
  updates: Partial<Omit<ProposedRelation, 'id' | 'createdAt'>>
): Promise<ProposedRelation> {
  const docRef = doc(db, COLLECTION_NAME, id);
  const existing = await getDoc(docRef);

  if (!existing.exists()) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  const updatedData = removeUndefinedFields({
    ...updates,
    updatedAt: Date.now(),
  });

  await updateDoc(docRef, updatedData);

  return { ...(existing.data() as ProposedRelation), ...updatedData };
}

// ============================================================================
// TRIAGE OPERATIONS
// ============================================================================

/**
 * Approves a proposed relation.
 *
 * @param id - The proposal ID
 * @param reviewedBy - User ID of reviewer
 * @returns The updated proposal
 * @throws Error if proposal not found or not pending
 */
export async function approveProposedRelation(id: string, reviewedBy: string): Promise<ProposedRelation> {
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // If already approved, return the existing proposal (idempotent operation)
  // This prevents race condition errors when the UI tries to approve twice
  if (proposal.status === 'approved') {
    log.warn('Proposal is already approved, returning existing', { id });
    return proposal;
  }

  // If not pending (e.g., rejected or dismissed), throw error
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is not pending: ${proposal.status}`);
  }

  // Task 0.2b: Create the actual relation ATOMICALLY with the approval.
  // Previously, only the hook (useProposedRelations.ts:108) created the relation
  // via a separate /api/relations/from-ids call AFTER approval. Any direct caller
  // (agent, MCP, chat) that used approveProposedRelation() without the hook left
  // "zombie" approved proposals with no backing relation.
  // Task 0.2b: Create the actual relation atomically with the approval.
  // Best-effort — if relation creation fails (duplicate, module load, test env),
  // the approval still proceeds. The hook path also creates the relation as a fallback.
  try {
    const mod = await import('@/lib/relations-validation').catch(() => null);
    if (mod?.createRelationFromIds) {
      await mod.createRelationFromIds({
        sourceId: proposal.sourceId,
        sourceType: proposal.sourceType,
        targetId: proposal.targetId,
        targetType: proposal.targetType,
        relationType: proposal.relationType,
        confidence: proposal.confidence,
        aiSuggested: true,
        agentName: mod.agentNameForDiscoverySource(proposal.discoveredBy),
        // F105: human approval stamps `curated` so the sync materialization
        // gate releases the edge even below the 75 machine-confidence
        // threshold (parity with the admin twin).
        claimStatus: 'curated',
      });
      log.info('Relation created atomically with approval', { proposalId: id });
    }
  } catch (relationError) {
    log.warn('Relation creation during approval failed (may already exist)', {
      proposalId: id,
      error: relationError instanceof Error ? relationError.message : String(relationError),
    });
  }

  return updateProposedRelation(id, {
    status: 'approved',
    reviewedAt: Date.now(),
    reviewedBy,
  });
}

/**
 * Rejects a proposed relation.
 *
 * @param id - The proposal ID
 * @param reviewedBy - User ID of reviewer
 * @param feedbackReason - Optional reason for rejection
 * @returns The updated proposal
 * @throws Error if proposal not found or not pending
 */
export async function rejectProposedRelation(
  id: string,
  reviewedBy: string,
  feedbackReason?: string
): Promise<ProposedRelation> {
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // If already rejected, return the existing proposal (idempotent operation)
  if (proposal.status === 'rejected') {
    log.warn('Proposal is already rejected, returning existing', { id });
    return proposal;
  }

  // If not pending (e.g., approved or dismissed), throw error
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal is not pending: ${proposal.status}`);
  }

  return updateProposedRelation(id, {
    status: 'rejected',
    reviewedAt: Date.now(),
    reviewedBy,
    feedbackReason,
  });
}

/**
 * Dismisses a proposed relation (won't be re-proposed).
 *
 * @param id - The proposal ID
 * @param reviewedBy - User ID of reviewer
 * @returns The updated proposal
 */
export async function dismissProposedRelation(id: string, reviewedBy: string): Promise<ProposedRelation> {
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  return updateProposedRelation(id, {
    status: 'dismissed',
    reviewedAt: Date.now(),
    reviewedBy,
  });
}

/**
 * Bulk approves multiple proposals.
 *
 * @param ids - Array of proposal IDs
 * @param reviewedBy - User ID of reviewer
 * @returns Object with counts of successful/failed approvals
 */
export async function bulkApproveProposedRelations(
  ids: string[],
  reviewedBy: string
): Promise<{ approved: number; failed: number; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => approveProposedRelation(id, reviewedBy)));

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
 * Bulk rejects multiple proposals.
 *
 * @param ids - Array of proposal IDs
 * @param reviewedBy - User ID of reviewer
 * @returns Object with counts of successful/failed rejections
 */
export async function bulkRejectProposedRelations(
  ids: string[],
  reviewedBy: string
): Promise<{ rejected: number; failed: number; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => rejectProposedRelation(id, reviewedBy)));

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

/**
 * Bulk deletes multiple proposals.
 *
 * @param ids - Array of proposal IDs
 * @returns Object with counts of successful/failed deletions
 */
export async function bulkDeleteProposedRelations(
  ids: string[]
): Promise<{ deleted: number; failed: number; failedIds: string[]; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => deleteProposedRelation(id)));

  const errors: string[] = [];
  // UX-037 — report WHICH ids failed, not just how many, so the caller can keep
  // exactly those selected and let the operator retry them.
  const failedIds: string[] = [];
  let deleted = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      deleted++;
    } else {
      failedIds.push(ids[index]);
      errors.push(`${ids[index]}: ${result.reason}`);
    }
  });

  return { deleted, failed: failedIds.length, failedIds, errors };
}

// ============================================================================
// REWORK OPERATIONS
// ============================================================================

/**
 * Reverts a rejected or dismissed proposal back to pending.
 * This allows the proposal to be reconsidered.
 *
 * @param id - The proposal ID
 * @param reviewedBy - User ID performing the revert
 * @returns The updated proposal
 * @throws Error if proposal not found or not rejected/dismissed
 */
export async function revertProposedRelation(id: string, reviewedBy: string): Promise<ProposedRelation> {
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // Only allow revert for rejected or dismissed proposals
  if (proposal.status !== 'rejected' && proposal.status !== 'dismissed') {
    throw new Error(
      `Cannot revert proposal with status: ${proposal.status}. Only rejected or dismissed proposals can be reverted.`
    );
  }

  return updateProposedRelation(id, {
    status: 'pending',
    reviewedAt: Date.now(),
    reviewedBy,
    // Clear feedback reason when reverting
    feedbackReason: undefined,
  });
}

/**
 * Marks an approved proposal as removed.
 * This should be called after the corresponding relation has been deleted.
 *
 * @param id - The proposal ID
 * @param removedBy - User ID performing the removal
 * @returns The updated proposal
 * @throws Error if proposal not found or not approved
 */
export async function markProposedRelationAsRemoved(id: string, removedBy: string): Promise<ProposedRelation> {
  const proposal = await getProposedRelationById(id);

  if (!proposal) {
    throw new Error(`Proposed relation not found: ${id}`);
  }

  // Only allow marking as removed for approved proposals
  if (proposal.status !== 'approved') {
    throw new Error(
      `Cannot mark as removed: proposal status is ${proposal.status}. Only approved proposals can be removed.`
    );
  }

  return updateProposedRelation(id, {
    status: 'removed',
    reviewedAt: Date.now(),
    reviewedBy: removedBy,
  });
}

// ============================================================================
// CLEANUP OPERATIONS
// ============================================================================

/**
 * Deletes a proposed relation.
 *
 * @param id - The proposal ID
 */
export async function deleteProposedRelation(id: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION_NAME, id));
}

/**
 * Fetches pending proposals between two entities (in either direction).
 *
 * @param entityId1 - First entity ID
 * @param entityId2 - Second entity ID
 * @returns Promise resolving to array of pending proposals between the entities
 */
export async function getPendingProposalsBetween(entityId1: string, entityId2: string): Promise<ProposedRelation[]> {
  // Query for proposals where entity1 is source and entity2 is target
  const query1 = query(
    collection(db, COLLECTION_NAME),
    where('status', '==', 'pending'),
    where('sourceId', '==', entityId1),
    where('targetId', '==', entityId2)
  );

  // Query for proposals where entity2 is source and entity1 is target
  const query2 = query(
    collection(db, COLLECTION_NAME),
    where('status', '==', 'pending'),
    where('sourceId', '==', entityId2),
    where('targetId', '==', entityId1)
  );

  const [snap1, snap2] = await Promise.all([getDocs(query1), getDocs(query2)]);

  const results: ProposedRelation[] = [];
  snap1.docs.forEach((doc) => results.push(doc.data() as ProposedRelation));
  snap2.docs.forEach((doc) => results.push(doc.data() as ProposedRelation));

  return results;
}

/**
 * Cleans up old rejected proposals past the retention period.
 *
 * @returns Number of proposals deleted
 */
export async function cleanupOldRejectedProposals(): Promise<number> {
  const cutoff = Date.now() - REJECTION_RETENTION_MS;

  const q = query(collection(db, COLLECTION_NAME), where('status', '==', 'rejected'), where('updatedAt', '<', cutoff));

  const snapshot = await getDocs(q);
  const deletePromises = snapshot.docs.map((doc) => deleteDoc(doc.ref));
  await Promise.all(deletePromises);

  return snapshot.docs.length;
}

/**
 * Cleans up proposed relations where source or target entity no longer exists.
 * This should be run periodically to remove orphaned proposals.
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
      await deleteDoc(doc(db, COLLECTION_NAME, id));
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
 * Checks if an entity exists in Firestore.
 * Used by cleanup functions to detect orphaned references.
 *
 * @param entityType - Type of entity
 * @param entityId - Entity ID
 * @returns True if entity exists
 */
async function checkEntityExists(entityType: EntityType, entityId: string): Promise<boolean> {
  // Canonical EntityType→collection map (src/lib/entity-collections.ts). A local
  // copy here used `useCases`/`orgUnits`, which do not match the app's
  // `use-cases`/`org-units` collections — so this existence check always
  // returned false for app-created use cases and org units, marking their
  // proposed relations orphaned.
  const collectionName = ENTITY_COLLECTIONS[entityType];
  if (!collectionName) {
    log.warn('Unknown entity type', { entityType });
    return false;
  }

  try {
    const docRef = doc(db, collectionName, entityId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists();
  } catch (error) {
    log.error('Error checking entity existence', error instanceof Error ? error : new Error(String(error)), {
      entityType,
      entityId,
    });
    return false;
  }
}
