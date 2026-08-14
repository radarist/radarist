/**
 * @file useEntityClaims.ts
 * @description TanStack Query hook for an entity's graph claims
 * (P5-D — `GET /api/entities/[id]/claims`).
 *
 * The KnowledgeTab claims section previously only rendered when a `claims`
 * prop was passed — and no mount site ever passed one, so :Assertion /
 * :Evidence data had no review surface. This hook lets the tab self-fetch.
 *
 * Shape notes:
 *   - Gated on Firebase auth via `useAuth()` so the query is pending during
 *     the auth-restore window instead of firing with no token (same pattern
 *     as `useInsightDetail`).
 *   - `retry: false` — a 503 (graph degraded) is terminal from the UI's
 *     perspective; retrying would hammer a known-down backend.
 *   - Maps the route's nested subject/object DTO back into the flat
 *     `GraphClaim` shape the KnowledgeTab renders, with evidence attached.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { entityClaimsKeys } from '@/lib/query-keys';
import { useAuth } from '@/components/providers/AuthProvider';
import { createLogger } from '@/lib/logger';
import type { ClaimStatus, GraphClaim, GraphEvidence } from '@/lib/graph/types';
import type { TransformationEntityType } from '@/lib/types';

const log = createLogger('hooks/useEntityClaims');

// ============================================================================
// TYPES
// ============================================================================

/** One claim as served by GET /api/entities/[id]/claims. */
export interface EntityClaimDto {
  id: string;
  predicate: string;
  subject: { id: string; type: TransformationEntityType; name: string };
  object: { id: string; type: TransformationEntityType; name: string };
  status: ClaimStatus;
  confidence: number;
  statement: string | null;
  assertedBy: string | null;
  asserterType: 'agent' | 'user' | null;
  createdAt: number | null;
  updatedAt: number | null;
  relationId: string | null;
  evidence: GraphEvidence[];
}

/** A GraphClaim with its evidence attached. */
export type EntityClaimWithEvidence = GraphClaim & { evidence: GraphEvidence[] };

/** EntityClaims-compatible result with evidence attached per claim. */
export interface EntityClaimsWithEvidence {
  asSubject: EntityClaimWithEvidence[];
  asObject: EntityClaimWithEvidence[];
  totalCount: number;
}

// ============================================================================
// FETCH + MAPPING
// ============================================================================

function dtoToClaim(dto: EntityClaimDto): EntityClaimWithEvidence {
  return {
    id: dto.id,
    predicate: dto.predicate,
    subjectId: dto.subject.id,
    subjectType: dto.subject.type,
    subjectName: dto.subject.name,
    objectId: dto.object.id,
    objectType: dto.object.type,
    objectName: dto.object.name,
    status: dto.status,
    confidence: dto.confidence,
    statement: dto.statement ?? undefined,
    assertedBy: dto.assertedBy ?? 'unknown',
    asserterType: dto.asserterType ?? 'user',
    createdAt: dto.createdAt ?? 0,
    updatedAt: dto.updatedAt ?? dto.createdAt ?? 0,
    relationId: dto.relationId ?? undefined,
    evidence: dto.evidence ?? [],
  };
}

async function fetchEntityClaims(entityId: string): Promise<EntityClaimsWithEvidence> {
  const response = await fetchWithAuth(`/api/entities/${encodeURIComponent(entityId)}/claims`);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Entity claims fetch failed (${response.status}): ${text || response.statusText}`);
  }

  const payload = (await response.json()) as { claims: EntityClaimDto[]; totalCount: number };
  const claims = (payload.claims ?? []).map(dtoToClaim);

  return {
    asSubject: claims.filter((claim) => claim.subjectId === entityId),
    asObject: claims.filter((claim) => claim.subjectId !== entityId && claim.objectId === entityId),
    totalCount: claims.length,
  };
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Fetch the graph claims (assertions + evidence) for an entity.
 *
 * @param entityId - Entity ID (query disabled when empty/undefined)
 * @param options.enabled - Extra gate (e.g. skip when a claims prop is passed)
 */
export function useEntityClaims(entityId: string | undefined, options?: { enabled?: boolean }) {
  const { user, loading: authLoading } = useAuth();

  return useQuery<EntityClaimsWithEvidence>({
    queryKey: entityClaimsKeys.byEntity(entityId ?? ''),
    queryFn: async () => {
      try {
        return await fetchEntityClaims(entityId!);
      } catch (error) {
        log.warn('entity claims fetch failed', {
          entityId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    enabled: !!entityId && !authLoading && !!user && (options?.enabled ?? true),
    retry: false,
    staleTime: 60_000,
  });
}
