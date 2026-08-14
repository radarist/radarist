/**
 * @file api/entities/[id]/claims/route.ts
 * @description Read-only API endpoint for an entity's graph claims
 * (:Assertion nodes) with their :Evidence.
 *
 * P5-D — Claims UI revival. This is the first review surface for the
 * Reified Assertion Model: the KnowledgeTab fetches this route via
 * useEntityClaims so proposed/curated assertions (and their evidence
 * snippets) become visible per entity.
 *
 * Evidence lookup is null-tolerant (decision D9): assertions synced from
 * Firestore relations are keyed by `relationId`, so when the id lookup
 * misses we fall back to getAssertionWithEvidenceByRelationId.
 *
 * H10 honest degradation: when the graph backend cannot serve the read
 * (GraphUnavailableError), the route returns 503 with a `degraded` flag
 * instead of fabricating an empty claims list.
 *
 * @author Radarist Team
 * @created 2026-07-03
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { GraphUnavailableError, graphDegradedBody } from '@/lib/graph/errors';
import { withGraphReadDeadline } from '@/lib/graph/interactive-read';
import { getAssertionsForEntity, getAssertionWithEvidence, getAssertionWithEvidenceByRelationId } from '@/lib/graph';
import type { GraphAssertion, GraphEvidence } from '@/lib/graph/types';

const log = createLogger('api/entities/[id]/claims');

// ============================================================================
// RESPONSE SHAPE
// ============================================================================

interface EntityRef {
  id: string;
  type: string;
  name: string;
}

interface ClaimResponse {
  id: string;
  predicate: string;
  subject: EntityRef;
  object: EntityRef;
  status: string;
  confidence: number;
  statement: string | null;
  assertedBy: string | null;
  asserterType: 'agent' | 'user' | null;
  createdAt: number | null;
  updatedAt: number | null;
  relationId: string | null;
  evidence: GraphEvidence[];
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Resolve the evidence attached to an assertion. Null-tolerant: tries the
 * assertion id first, then the Firestore relationId the sync path keys on.
 * Enrichment failures degrade to an empty evidence list rather than killing
 * the whole claims response.
 */
async function resolveEvidence(assertion: GraphAssertion): Promise<GraphEvidence[]> {
  try {
    let withEvidence = await getAssertionWithEvidence(assertion.id);
    if (!withEvidence && assertion.relationId) {
      withEvidence = await getAssertionWithEvidenceByRelationId(assertion.relationId);
    }
    return withEvidence?.evidence ?? [];
  } catch (error) {
    log.warn('Evidence enrichment failed for assertion', {
      assertionId: assertion.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function toClaimResponse(assertion: GraphAssertion, evidence: GraphEvidence[]): ClaimResponse {
  return {
    id: assertion.id,
    predicate: assertion.predicate,
    subject: { id: assertion.subjectId, type: assertion.subjectType, name: assertion.subjectName },
    object: { id: assertion.objectId, type: assertion.objectType, name: assertion.objectName },
    status: assertion.status,
    confidence: assertion.confidence,
    statement: assertion.statement ?? null,
    assertedBy: assertion.assertedBy ?? null,
    asserterType: assertion.asserterType ?? null,
    createdAt: assertion.createdAt ?? null,
    updatedAt: assertion.updatedAt ?? null,
    relationId: assertion.relationId ?? null,
    evidence,
  };
}

// ============================================================================
// HANDLER
// ============================================================================

/**
 * GET /api/entities/[id]/claims
 *
 * Returns `{ claims: ClaimResponse[], totalCount: number }` for the entity —
 * every :Assertion where the entity is subject or object, each with its
 * :Evidence nodes.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: 'Entity ID is required' }, { status: 400 });
    }

    // PERF-008: bound the interactive read so a Neo4j outage surfaces the 503
    // below within a measured budget instead of the driver's stacked ~33–60s.
    const claims = await withGraphReadDeadline('entity-claims', async () => {
      const assertions = await getAssertionsForEntity(id);

      // Self-loop assertions appear in both collections — dedupe by id.
      const seen = new Set<string>();
      const unique = [...assertions.asSubject, ...assertions.asObject].filter((assertion) => {
        if (seen.has(assertion.id)) return false;
        seen.add(assertion.id);
        return true;
      });

      return Promise.all(unique.map(async (assertion) => toClaimResponse(assertion, await resolveEvidence(assertion))));
    });

    return NextResponse.json({ claims, totalCount: claims.length });
  } catch (error) {
    if (error instanceof GraphUnavailableError) {
      return NextResponse.json(graphDegradedBody(error), { status: 503 });
    }

    log.error('Failed to fetch entity claims', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to fetch entity claims' }, { status: 500 });
  }
}
