/**
 * @file app/api/reports/[id]/route.ts
 * @description API route for retrieving, updating, and deleting a specific report by ID
 *
 * Endpoints:
 * - GET /api/reports/[id] - Get report by ID (authenticated)
 * - PUT /api/reports/[id] - Update report by ID (authenticated)
 * - DELETE /api/reports/[id] - Delete report by ID (authenticated)
 *
 * NOTE: This is the authenticated internal API endpoint.
 * The public share page at /share/report/[id] fetches directly
 * from Firestore without auth.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getReportOwnedBy, updateReport, deleteReport, reportsBelongToOwner } from '@/lib/reports';
import { updateReportSchema } from '@/lib/schemas/report';
import { ReportPublicationError } from '@/lib/reports/publication-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports/[id]');

/**
 * GET /api/reports/[id]
 *
 * Retrieve a specific report by its ID.
 *
 * Returns:
 * - 200 with Report object if found
 * - 401 if not authenticated
 * - 404 if report not found
 * - 500 on server error
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    // SEC-009: owner-scoped read. Absent, foreign, and ownerless legacy
    // reports all resolve to the same 404 below, so this full-HTML surface
    // cannot be used to read or probe another user's reports.
    const report = await getReportOwnedBy(id, auth.uid);

    if (!report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    log.error('Failed to get report', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get report' }, { status: 500 });
  }
}

/**
 * PUT /api/reports/[id]
 *
 * Update an existing report by its ID.
 *
 * Returns:
 * - 200 with updated Report object
 * - 400 if input validation fails
 * - 401 if not authenticated
 * - 404 if report not found
 * - 500 on server error
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json();

    const validation = updateReportSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid input', details: validation.error.errors }, { status: 400 });
    }

    // DISC-014: attribute the captured version to the human editor.
    // SEC-009: ownership is enforced inside the update transaction; a foreign
    // or ownerless report throws the same 'Report not found' as an absent one.
    const report = await updateReport(id, validation.data, {
      savedBy: `user:${auth.uid}`,
      requireOwnerId: auth.uid,
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof Error && error.message === 'Report not found') {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    // REPORT-002: sharing a needs-review draft is refused inside the update
    // transaction — surface it as a conflict the owner can resolve (approve
    // the draft first), not a server fault.
    if (error instanceof Error && error.message === 'Report is pending review and cannot be shared') {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // UX-021: a report edit that reintroduces executable/off-origin HTML is
    // caller-fixable — return 422 with the actionable conversion guidance.
    if (error instanceof ReportPublicationError) {
      return NextResponse.json({ error: error.message, violations: error.violations }, { status: 422 });
    }
    log.error('Failed to update report', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}

/**
 * DELETE /api/reports/[id]
 *
 * Delete a report by its ID.
 *
 * Returns:
 * - 204 on successful deletion (no content)
 * - 401 if not authenticated
 * - 500 on server error
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const isOwner = await reportsBelongToOwner([id], auth.uid);
    if (!isOwner) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    await deleteReport(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    log.error('Failed to delete report', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to delete report' }, { status: 500 });
  }
}
