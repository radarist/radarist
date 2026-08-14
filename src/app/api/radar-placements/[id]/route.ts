/**
 * @file app/api/radar-placements/[id]/route.ts
 * @description Authenticated same-origin handoff for RadarPlacement UPDATE
 * (including ring moves) and DELETE (GRAPH-060).
 *
 * Both verbs enforce auth first, validate the body (PATCH), and route through
 * the Admin-SDK acknowledged-handoff primitives so the response carries an
 * explicit committed-vs-reconciliation-required `graphHandoff`. A move is an
 * update whose `ring` changes; there is no separate move endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  adminUpdateRadarPlacementWithHandoff,
  adminDeleteRadarPlacementWithHandoff,
} from '@/lib/radar-placement-admin';
import { updateRadarPlacementInputSchema } from '@/lib/schemas/radar-placement-schema';
import { classifyPlacementError } from '../route';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/radar-placements/[id]');

/**
 * PATCH /api/radar-placements/[id]
 *
 * Update a placement (including a ring move). At least one field must be present.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Placement id is required' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = updateRadarPlacementInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid placement update', message: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }

  try {
    const { placement, graphHandoff } = await adminUpdateRadarPlacementWithHandoff(id, parsed.data, {
      requireOwnerId: auth.uid,
    });

    if (graphHandoff.reconciliationRequired) {
      log.warn('Placement update committed but graph handoff unacknowledged; reconciliation required', { id });
    }

    return NextResponse.json({ success: true, data: placement, graphHandoff, message: 'Placement updated' });
  } catch (error) {
    const { status, message } = classifyPlacementError(error);
    if (status >= 500) log.error('Failed to update placement', error instanceof Error ? error : undefined, { id });
    return NextResponse.json({ success: false, error: 'Failed to update placement', message }, { status });
  }
}

/**
 * DELETE /api/radar-placements/[id]
 *
 * Delete a placement and its relation cascade, then dispatch the graph removal.
 * A committed delete whose graph dispatch is unacknowledged returns 200 with
 * `reconciliationRequired: true` — the doc is gone; recovery drives the graph.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'Placement id is required' }, { status: 400 });
  }

  try {
    const { graphHandoff } = await adminDeleteRadarPlacementWithHandoff(id, { requireOwnerId: auth.uid });

    if (graphHandoff.reconciliationRequired) {
      log.warn('Placement delete committed but graph handoff unacknowledged; reconciliation required', { id });
    }

    return NextResponse.json({ success: true, data: { deleted: true }, graphHandoff, message: 'Placement deleted' });
  } catch (error) {
    const { status, message } = classifyPlacementError(error);
    if (status >= 500) log.error('Failed to delete placement', error instanceof Error ? error : undefined, { id });
    return NextResponse.json({ success: false, error: 'Failed to delete placement', message }, { status });
  }
}
