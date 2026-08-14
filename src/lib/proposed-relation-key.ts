import { createHash } from 'crypto';

import { isSymmetricRelationType } from '@/lib/relation-symmetry-contract';
import type { ProposedRelation, RelationType } from '@/lib/types';

export const PROPOSED_RELATION_KEY_VERSION = 2 as const;

const LEGACY_SYMMETRIC_RELATION_TYPES: ReadonlySet<RelationType> = new Set([
  'competes_with',
  'partner',
  'competitor',
]);

export class ProposalIdentityConflictError extends Error {
  readonly proposalIds: readonly string[];

  constructor(proposalIds: readonly string[], detail = 'Conflicting proposal identity archives') {
    const sortedIds = [...new Set(proposalIds)].sort();
    super(`${detail}: ${sortedIds.join(', ')}`);
    this.name = 'ProposalIdentityConflictError';
    this.proposalIds = sortedIds;
  }
}

function hashProposalIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').substring(0, 32);
}

/** Delimiter-safe, collision-resistant v2 identity for newly written proposals. */
export function generateProposalKey(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): string {
  const [source, target] =
    isSymmetricRelationType(relationType) && sourceId > targetId
      ? [targetId, sourceId]
      : [sourceId, targetId];
  return hashProposalIdentity(
    JSON.stringify([PROPOSED_RELATION_KEY_VERSION, relationType, source, target])
  );
}

/** Exact pre-v2 colon-concatenated identity retained only for cutover reads. */
export function generateLegacyProposalKey(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): string {
  const [source, target] =
    LEGACY_SYMMETRIC_RELATION_TYPES.has(relationType) && sourceId > targetId
      ? [targetId, sourceId]
      : [sourceId, targetId];
  return hashProposalIdentity(`${source}:${target}:${relationType}`);
}

/**
 * Current identity first, followed by historical orientations that may own an
 * existing proposal. This prevents a symmetry-contract rollout from making a
 * pending/rejected/approved proposal unreachable.
 */
export function generateProposalKeyCandidates(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): string[] {
  const candidates = [
    generateProposalKey(sourceId, targetId, relationType),
    generateLegacyProposalKey(sourceId, targetId, relationType),
  ];
  if (isSymmetricRelationType(relationType)) {
    candidates.push(generateLegacyProposalKey(targetId, sourceId, relationType));
  }
  return [...new Set(candidates)];
}

/**
 * Confirms that a document found through a legacy candidate belongs to the
 * requested semantic triple. The old colon-concatenated preimage was
 * ambiguous, so matching the document ID alone is insufficient during cutover.
 */
export function matchesProposalIdentity(
  proposal: { sourceId: string; targetId: string; relationType: RelationType },
  sourceId: string,
  targetId: string,
  relationType: RelationType
): boolean {
  if (proposal.relationType !== relationType) return false;
  if (proposal.sourceId === sourceId && proposal.targetId === targetId) return true;
  return (
    isSymmetricRelationType(relationType) &&
    proposal.sourceId === targetId &&
    proposal.targetId === sourceId
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)])
    );
  }
  return value;
}

function snapshotContent(snapshot: ProposedRelation['sourceSnapshot']): Record<string, unknown> {
  const { snapshotAt: _snapshotAt, ...content } = snapshot;
  return content;
}

/**
 * Compares reviewed proposal content after canonicalizing symmetric endpoint
 * orientation. Document IDs and capture/update timestamps are storage metadata,
 * not review decisions; all other fields must agree before two archives may be
 * collapsed automatically.
 */
export function proposalArchivesEquivalent(
  left: ProposedRelation,
  right: ProposedRelation
): boolean {
  const normalize = (proposal: ProposedRelation): unknown => {
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      sourceId,
      sourceType,
      sourceSnapshot,
      targetId,
      targetType,
      targetSnapshot,
      ...content
    } = proposal;
    const reverse = isSymmetricRelationType(proposal.relationType) && sourceId > targetId;
    return stableJsonValue({
      sourceId: reverse ? targetId : sourceId,
      sourceType: reverse ? targetType : sourceType,
      sourceSnapshot: snapshotContent(reverse ? targetSnapshot : sourceSnapshot),
      targetId: reverse ? sourceId : targetId,
      targetType: reverse ? sourceType : targetType,
      targetSnapshot: snapshotContent(reverse ? sourceSnapshot : targetSnapshot),
      ...content,
    });
  };

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export interface ProposalArchiveCandidate {
  key: string;
  proposal: ProposedRelation;
}

/**
 * Converges already-equivalent archives without discarding retention/audit
 * time. The current v2 document remains the structural base when present;
 * otherwise the newest archive (then key) wins independently of request
 * orientation. Endpoint snapshots retain their greatest capture timestamp.
 */
export function mergeEquivalentProposalArchives(
  candidates: readonly ProposalArchiveCandidate[],
  currentKey: string
): ProposedRelation {
  if (candidates.length === 0) {
    throw new ProposalIdentityConflictError([], 'Cannot merge an empty proposal archive set');
  }
  if (
    candidates.slice(1).some((candidate) =>
      !proposalArchivesEquivalent(candidates[0].proposal, candidate.proposal)
    )
  ) {
    throw new ProposalIdentityConflictError(
      candidates.map((candidate) => candidate.key),
      'Cannot merge non-equivalent proposal archives'
    );
  }

  const newestFirst = [...candidates].sort(
    (left, right) =>
      right.proposal.updatedAt - left.proposal.updatedAt || left.key.localeCompare(right.key)
  );
  const base =
    candidates.find((candidate) => candidate.key === currentKey)?.proposal ??
    newestFirst[0].proposal;
  const snapshotsFor = (entityId: string) =>
    candidates
      .flatMap(({ proposal }) => {
        if (proposal.sourceId === entityId) return [proposal.sourceSnapshot];
        if (proposal.targetId === entityId) return [proposal.targetSnapshot];
        return [];
      })
      .sort((left, right) => right.snapshotAt - left.snapshotAt);

  return {
    ...base,
    id: currentKey,
    sourceSnapshot: snapshotsFor(base.sourceId)[0] ?? base.sourceSnapshot,
    targetSnapshot: snapshotsFor(base.targetId)[0] ?? base.targetSnapshot,
    createdAt: Math.min(...candidates.map(({ proposal }) => proposal.createdAt)),
    updatedAt: Math.max(...candidates.map(({ proposal }) => proposal.updatedAt)),
  };
}
