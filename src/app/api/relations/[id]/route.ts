/**
 * @file app/api/relations/[id]/route.ts
 * @description API routes for managing individual relations
 *
 * This module provides REST API endpoints for single relation operations:
 * - GET: Retrieve a specific relation by ID
 * - PUT: Update an existing relation
 * - DELETE: Delete a relation
 *
 * @author Radarist Team
 * @created 2025-11-27
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/relations/[id]');
import { adminGetRelationById, adminUpdateRelation, adminDeleteRelation } from '@/lib/relations-admin';
import { isCanonicalRelationType } from '@/lib/relation-type-contract';
import { relationUpdatePayloadSchema } from '@/lib/relation-write-schema';
import {
  correlationIdFromHeaders,
  withCorrelationIdHeader,
} from '@/lib/observability/correlation';

function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  return withCorrelationIdHeader(NextResponse.json(body, init), correlationId);
}

/**
 * GET /api/relations/[id]
 *
 * Retrieve a specific relation by ID
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": { ... relation object ... }
 * }
 * ```
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
      return NextResponse.json({ success: false, error: 'Relation ID is required' }, { status: 400 });
    }

    const relation = await adminGetRelationById(id);

    if (!relation) {
      return NextResponse.json({ success: false, error: 'Relation not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: relation,
    });
  } catch (error) {
    log.error('Failed to retrieve relation', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to retrieve relation',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/relations/[id]
 *
 * Update an existing relation
 *
 * Request body (partial update):
 * ```json
 * {
 *   "relationType": "competes_with",
 *   "notes": "Updated notes",
 *   "confidence": 90,
 *   "sourceSnapshot": { ... },  // Optional: update snapshot
 *   "targetSnapshot": { ... }   // Optional: update snapshot
 * }
 * ```
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": { ... updated relation object ... }
 * }
 * ```
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const { id } = await params;

    if (!id) {
      return correlatedJson(correlationId, { success: false, error: 'Relation ID is required' }, { status: 400 });
    }

    const updates = await request.json();

    // Validate that at least one field is being updated
    if (Object.keys(updates).length === 0) {
      return correlatedJson(correlationId, { success: false, error: 'No updates provided' }, { status: 400 });
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, 'relationType') &&
      !isCanonicalRelationType(updates.relationType)
    ) {
      return correlatedJson(correlationId, { success: false, error: 'Invalid relationType' }, { status: 400 });
    }

    const parsed = relationUpdatePayloadSchema.safeParse(updates);
    if (!parsed.success) {
      return correlatedJson(
        correlationId,
        { success: false, error: 'Invalid relation update', message: parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }

    const updatedRelation = await adminUpdateRelation(id, parsed.data, { correlationId });

    if (!updatedRelation) {
      return correlatedJson(correlationId, { success: false, error: 'Relation not found' }, { status: 404 });
    }

    return correlatedJson(correlationId, {
      success: true,
      data: updatedRelation,
      message: 'Relation updated successfully',
    });
  } catch (error) {
    log.error('Failed to update relation', error instanceof Error ? error : undefined);
    return correlatedJson(
      correlationId,
      {
        success: false,
        error: 'Failed to update relation',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/relations/[id]
 *
 * Delete a relation permanently
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "message": "Relation deleted successfully"
 * }
 * ```
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const { id } = await params;

    if (!id) {
      return correlatedJson(correlationId, { success: false, error: 'Relation ID is required' }, { status: 400 });
    }

    await adminDeleteRelation(id, { correlationId });

    return correlatedJson(correlationId, {
      success: true,
      data: { deleted: true },
      message: 'Relation deleted successfully',
    });
  } catch (error) {
    log.error('Failed to delete relation', error instanceof Error ? error : undefined);

    // Check if it's a "not found" error
    if (error instanceof Error && error.message.includes('not found')) {
      return correlatedJson(correlationId, { success: false, error: 'Relation not found' }, { status: 404 });
    }

    return correlatedJson(
      correlationId,
      {
        success: false,
        error: 'Failed to delete relation',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
