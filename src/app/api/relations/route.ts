/**
 * @file app/api/relations/route.ts
 * @description API routes for managing denormalized relations
 *
 * This module provides REST API endpoints for the Relations system:
 * - GET: Retrieve relations with filtering
 * - POST: Create new relations
 *
 * Relations use denormalized entity snapshots to avoid N+1 queries.
 *
 * @author Radarist Team
 * @created 2025-11-27
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/relations');
import {
  adminCreateRelation,
  adminGetRelations,
  adminGetRelationsForEntity,
  adminGetAISuggestedRelations,
  adminGetStaleRelations,
} from '@/lib/relations-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import type { Relation, RelationType, EntityType } from '@/lib/types';
import { isCanonicalRelationType } from '@/lib/relation-type-contract';
import { relationCreatePayloadSchema } from '@/lib/relation-write-schema';
import {
  correlationIdFromHeaders,
  withCorrelationIdHeader,
} from '@/lib/observability/correlation';

function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  return withCorrelationIdHeader(NextResponse.json(body, init), correlationId);
}

/**
 * Client-side filtering for relations — server-safe local copy of
 * `relations-queries.filterRelations`. Inlined here (instead of imported from
 * the `@/lib/relations` barrel) because that barrel statically imports the
 * Firebase CLIENT SDK (`db` from `@/lib/firebase` + `firebase/firestore`),
 * which poisons the in-process client when loaded in a server route. This is a
 * pure function — no Firestore access — so duplicating it carries no contract
 * drift. Behavior is byte-for-byte identical to the source.
 */
type RelationFilterCriteria = {
  searchQuery?: string;
  relationType?: RelationType[];
  sourceType?: EntityType[];
  targetType?: EntityType[];
  sourceId?: string;
  targetId?: string;
  aiSuggestedOnly?: boolean;
  aiSuggested?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
};

function filterRelations(relations: Relation[], filters: RelationFilterCriteria): Relation[] {
  let filtered = [...relations];

  // Text search
  if (filters.searchQuery) {
    const query = filters.searchQuery.toLowerCase();
    filtered = filtered.filter(
      (rel) =>
        rel.sourceSnapshot.name.toLowerCase().includes(query) ||
        rel.targetSnapshot.name.toLowerCase().includes(query) ||
        rel.notes?.toLowerCase().includes(query)
    );
  }

  // Relation type filter
  if (filters.relationType && filters.relationType.length > 0) {
    filtered = filtered.filter((rel) => filters.relationType!.includes(rel.relationType));
  }

  // Source type filter
  if (filters.sourceType && filters.sourceType.length > 0) {
    filtered = filtered.filter((rel) => filters.sourceType!.includes(rel.sourceSnapshot.type));
  }

  // Target type filter
  if (filters.targetType && filters.targetType.length > 0) {
    filtered = filtered.filter((rel) => filters.targetType!.includes(rel.targetSnapshot.type));
  }

  // Source ID filter
  if (filters.sourceId) {
    filtered = filtered.filter((rel) => rel.sourceSnapshot.id === filters.sourceId);
  }

  // Target ID filter
  if (filters.targetId) {
    filtered = filtered.filter((rel) => rel.targetSnapshot.id === filters.targetId);
  }

  // AI-suggested only
  if (filters.aiSuggestedOnly) {
    filtered = filtered.filter((rel) => rel.aiSuggested === true);
  }

  // AI-suggested exact match (true = AI-only, false = human-curated only)
  if (filters.aiSuggested !== undefined) {
    filtered = filtered.filter((rel) => (rel.aiSuggested ?? false) === filters.aiSuggested);
  }

  // Minimum confidence threshold
  if (filters.minConfidence !== undefined) {
    filtered = filtered.filter((rel) => (rel.confidence ?? 0) >= filters.minConfidence!);
  }

  // Maximum confidence threshold
  if (filters.maxConfidence !== undefined) {
    filtered = filtered.filter((rel) => (rel.confidence ?? 0) <= filters.maxConfidence!);
  }

  return filtered;
}

/**
 * GET /api/relations
 *
 * Retrieve relations with optional filtering
 *
 * Query parameters:
 * - entityId: Filter by source or target entity ID
 * - entityType: Filter by entity type (technology, company, etc.)
 * - relationType: Filter by relation type (uses, enables, etc.)
 * - aiSuggested: Filter AI-suggested relations (true/false)
 * - stale: Get stale relations needing refresh (true/false)
 * - minConfidence: Minimum confidence score (0-100)
 * - maxConfidence: Maximum confidence score (0-100)
 *
 * Examples:
 * - /api/relations - Get all relations
 * - /api/relations?entityId=tech-123 - Get relations for entity
 * - /api/relations?relationType=uses - Get "uses" relations
 * - /api/relations?aiSuggested=true - Get AI suggestions
 * - /api/relations?stale=true - Get stale snapshots
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);

    const entityId = searchParams.get('entityId');
    const _entityType = searchParams.get('entityType') as EntityType | null;
    const relationType = searchParams.get('relationType') as RelationType | null;
    const aiSuggested = searchParams.get('aiSuggested');
    const stale = searchParams.get('stale');
    const minConfidence = searchParams.get('minConfidence');
    const maxConfidence = searchParams.get('maxConfidence');

    let relations: Relation[];

    // Handle special queries
    if (stale === 'true') {
      // Get stale relations (snapshots > 7 days old)
      relations = await adminGetStaleRelations(7);
    } else if (entityId) {
      // Get relations for specific entity
      relations = await adminGetRelationsForEntity(entityId);
    } else if (aiSuggested === 'true') {
      // Get AI-suggested relations
      relations = await adminGetAISuggestedRelations();
    } else {
      // Get all relations
      relations = await adminGetRelations();
    }

    // Apply filters if provided. Typed as RelationFilterCriteria (not Record<…>)
    // so a key mismatch with filterRelations is a compile error, not a silent no-op.
    const filters: RelationFilterCriteria = {};

    if (relationType) {
      filters.relationType = [relationType];
    }

    if (aiSuggested === 'true') {
      filters.aiSuggested = true;
    } else if (aiSuggested === 'false') {
      filters.aiSuggested = false;
    }

    if (minConfidence) {
      const parsed = parseInt(minConfidence, 10);
      if (!Number.isNaN(parsed)) filters.minConfidence = parsed;
    }

    if (maxConfidence) {
      const parsed = parseInt(maxConfidence, 10);
      if (!Number.isNaN(parsed)) filters.maxConfidence = parsed;
    }

    // Apply filters if any were provided
    if (Object.keys(filters).length > 0) {
      relations = filterRelations(relations, filters);
    }

    return NextResponse.json({
      success: true,
      data: relations,
      count: relations.length,
    });
  } catch (error) {
    log.error('Failed to retrieve relations', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to retrieve relations',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/relations
 *
 * Create a new relation between two entities
 *
 * Request body:
 * ```json
 * {
 *   "relationType": "uses" | "enables" | "competes_with" | ...,
 *   "sourceSnapshot": {
 *     "type": "technology",
 *     "id": "tech-123",
 *     "name": "React",
 *     "description": "...",
 *     "status": "Adopt",
 *     "tags": ["frontend", "ui"],
 *     "snapshotAt": 1234567890
 *   },
 *   "targetSnapshot": {
 *     "type": "company",
 *     "id": "company-456",
 *     "name": "Meta",
 *     "description": "...",
 *     "snapshotAt": 1234567890
 *   },
 *   "notes": "Optional notes about this relation",
 *   "confidence": 85,
 *   "aiSuggested": false
 * }
 * ```
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": { ... relation object ... }
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    return NextResponse.json({ success: false, error: 'Invalid correlation ID' }, { status: 400 });
  }

  try {
    const body = await request.json();

    // Validate required fields
    const { relationType, sourceSnapshot, targetSnapshot } = body;

    if (!relationType) {
      return correlatedJson(correlationId, { success: false, error: 'relationType is required' }, { status: 400 });
    }

    if (!isCanonicalRelationType(relationType)) {
      return correlatedJson(correlationId, { success: false, error: 'Invalid relationType' }, { status: 400 });
    }

    if (!sourceSnapshot || !targetSnapshot) {
      return correlatedJson(
        correlationId,
        { success: false, error: 'sourceSnapshot and targetSnapshot are required' },
        { status: 400 }
      );
    }

    const parsed = relationCreatePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return correlatedJson(
        correlationId,
        { success: false, error: 'Invalid relation payload', message: parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }

    // Create the relation
    const relation = await adminCreateRelation(parsed.data, { correlationId });

    return correlatedJson(
      correlationId,
      {
        success: true,
        data: relation,
        message: 'Relation created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('Failed to create relation', error instanceof Error ? error : undefined);
    return correlatedJson(
      correlationId,
      {
        success: false,
        error: 'Failed to create relation',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/** Delete every relation for one entity through the server-owned graph handoff. */
export async function DELETE(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    return NextResponse.json({ success: false, error: 'Invalid correlation ID' }, { status: 400 });
  }

  const entityId = new URL(request.url).searchParams.get('entityId');
  if (!entityId) {
    return correlatedJson(correlationId, { success: false, error: 'entityId is required' }, { status: 400 });
  }

  try {
    const deleted = await adminDeleteRelationsForEntity(entityId, { correlationId });
    return correlatedJson(correlationId, { success: true, data: { deleted } });
  } catch (error) {
    log.error('Failed to delete entity relations', error instanceof Error ? error : undefined, { entityId });
    return correlatedJson(
      correlationId,
      {
        success: false,
        error: 'Failed to delete entity relations',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
