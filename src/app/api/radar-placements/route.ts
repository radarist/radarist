/**
 * @file app/api/radar-placements/route.ts
 * @description Authenticated same-origin handoff for RadarPlacement CREATE
 * (GRAPH-060).
 *
 * WHY: browser placement mutations used to write Firestore directly and emit the
 * graph-sync event through a client-side Inngest sender that cannot see the
 * server-only (shifted-port, no public base URL) local Inngest endpoint — so it
 * swallowed the failure and left placements without their Neo4j node until a
 * capped reconciliation cycle eventually caught up. This route routes the create
 * through the Admin-SDK mutation primitive, which commits Firestore and then
 * AWAITS the graph-sync dispatch, returning an explicit `graphHandoff` that
 * distinguishes committed-and-acknowledged from committed-but-reconciliation-
 * required. No Inngest key or routing material is ever exposed to the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  adminCreateRadarPlacementWithHandoff,
  adminCascadeDeletePlacementsByRadar,
  adminCascadeDeletePlacementsByTechnology,
  PlacementValidationError,
  PlacementAuthorizationError,
  MalformedPlacementLockError,
  PlacementPairConflictError,
  AmbiguousLegacyPlacementError,
  PlacementParentDeletingError,
} from '@/lib/radar-placement-admin';
import { createRadarPlacementInputSchema } from '@/lib/schemas/radar-placement-schema';
import type { CreateRadarPlacementInput } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/radar-placements');

/**
 * GRAPH-060 #4 — classify a placement mutation error into a status + a PUBLIC
 * message. Typed domain errors carry safe, actionable text; anything else is an
 * internal failure that returns a generic 500 message (never raw exception text).
 */
export function classifyPlacementError(error: unknown): { status: number; message: string } {
  if (error instanceof PlacementAuthorizationError)
    return { status: 403, message: 'Not authorized to modify this radar' };
  if (error instanceof PlacementPairConflictError) {
    return {
      status: 409,
      message: 'This technology already has a different placement on this radar; update it instead',
    };
  }
  if (error instanceof MalformedPlacementLockError) {
    return { status: 409, message: 'Placement pair identity is in conflict; resolve the drift before retrying' };
  }
  if (error instanceof AmbiguousLegacyPlacementError) {
    return { status: 409, message: 'Multiple legacy placements exist for this pair; migration halted for review' };
  }
  if (error instanceof PlacementParentDeletingError) {
    return { status: 409, message: 'That radar or technology is being deleted; try again in a moment' };
  }
  if (error instanceof PlacementValidationError) {
    const raw = error.message;
    // Validation messages are safe, bounded, and actionable.
    if (raw.includes('not found')) return { status: 404, message: raw };
    return { status: 400, message: raw };
  }
  // Message-based fallback: robust across module realms and for the historical
  // plain-Error commit-failure messages. Still never surfaces raw text on 500.
  const raw = error instanceof Error ? error.message : '';
  if (raw.includes('Not authorized')) return { status: 403, message: 'Not authorized to modify this radar' };
  if (raw.includes('pair conflict') || raw.includes('malformed or mismatched')) {
    return { status: 409, message: 'Placement pair identity is in conflict; resolve the drift before retrying' };
  }
  if (raw.includes('multiple legacy placements') || raw.includes('already placed')) {
    return { status: 409, message: 'This technology already has a conflicting placement on this radar' };
  }
  if (
    raw.includes('is not configured on radar') ||
    raw.includes('is not valid on radar') ||
    raw.includes('does not exist')
  ) {
    return { status: 400, message: raw };
  }
  if (raw.includes('not found')) return { status: 404, message: 'Placement not found' };
  return { status: 500, message: 'Internal error while processing the placement' };
}

/**
 * POST /api/radar-placements
 *
 * Create a RadarPlacement. Auth is enforced first, the body is Zod-validated,
 * then the create commits and dispatches through the acknowledged handoff.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createRadarPlacementInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid placement payload', message: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }

  try {
    // #3 — attribution is server-derived from the authenticated uid (a client
    // `placedBy` was already stripped by the schema), and the mutation is
    // authorized against the radar's ownership/legacy policy.
    const input: CreateRadarPlacementInput = { ...parsed.data, placedBy: auth.uid };
    const { placement, graphHandoff } = await adminCreateRadarPlacementWithHandoff(input, {
      requireOwnerId: auth.uid,
    });

    if (graphHandoff.reconciliationRequired) {
      log.warn('Placement committed but graph handoff unacknowledged; reconciliation required', {
        placementId: placement.id,
      });
    }

    return NextResponse.json(
      { success: true, data: placement, graphHandoff, message: 'Placement created' },
      { status: 201 }
    );
  } catch (error) {
    const { status, message } = classifyPlacementError(error);
    if (status >= 500) log.error('Failed to create placement', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Failed to create placement', message }, { status });
  }
}

/**
 * DELETE /api/radar-placements?technologyId=… | ?radarId=…
 *
 * GRAPH-060 #1 — the authenticated bulk-cascade browser paths (technology /
 * radar deletion). Auth first, then the server cascade removes every matching
 * placement + its pair lock + a delete tombstone, authorized against the
 * radar(s). Exactly one of technologyId / radarId is required.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const technologyId = searchParams.get('technologyId');
  const radarId = searchParams.get('radarId');
  if ((technologyId && radarId) || (!technologyId && !radarId)) {
    return NextResponse.json(
      { success: false, error: 'Provide exactly one of technologyId or radarId' },
      { status: 400 }
    );
  }

  try {
    const deleted = radarId
      ? await adminCascadeDeletePlacementsByRadar(radarId, { requireOwnerId: auth.uid })
      : await adminCascadeDeletePlacementsByTechnology(technologyId as string, { requireOwnerId: auth.uid });
    return NextResponse.json({ success: true, data: { deleted } });
  } catch (error) {
    const { status, message } = classifyPlacementError(error);
    if (status >= 500) log.error('Failed to bulk-delete placements', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Failed to delete placements', message }, { status });
  }
}
