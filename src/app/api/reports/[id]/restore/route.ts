/**
 * @file app/api/reports/[id]/restore/route.ts
 * @description API route for restoring a report to an earlier version.
 *
 * Endpoints:
 * - POST /api/reports/[id]/restore - Restore a report (authenticated).
 *   - Body `{ versionId }` (DISC-014): restore that specific point-in-time
 *     version from the history subcollection.
 *   - No body: the legacy one-step swap of html and previousHtml.
 *
 * Either way the restore snapshots the current head into history first, so it
 * is never destructive. The legacy swap remains reversible (restoring twice
 * returns the report to its pre-restore state).
 *
 * NOTE: This is the authenticated internal API endpoint, following the same
 * auth pattern as /api/reports/[id].
 *
 * @author Radarist Team
 * @created 2026-06-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { restoreReportVersion } from '@/lib/reports';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports/[id]/restore');

const restoreBodySchema = z.object({ versionId: z.string().min(1).optional() });

/**
 * POST /api/reports/[id]/restore
 *
 * Restore a report to an earlier version (specific `versionId`, or the legacy
 * previous-html swap when no body is sent).
 *
 * Returns:
 * - 200 with the restored Report object
 * - 400 if the body is present but malformed
 * - 401 if not authenticated
 * - 404 if the report (or the requested version) is not found
 * - 409 if the report has no previous version to restore
 * - 500 on server error
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  // The body is optional (a bare POST is the legacy swap). Distinguish an
  // absent/empty body (→ legacy swap) from one that is present but unparseable
  // (→ 400). `request.json()` alone can't: it throws for BOTH, so catching it
  // would swallow a truncated body into `{}` and silently run the legacy swap.
  // Read the raw text and only parse when something was actually sent.
  const bodyText = await request.text().catch(() => '');
  let raw: unknown = {};
  if (bodyText.trim().length > 0) {
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }
  const parsed = restoreBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
  }

  try {
    const { id } = await params;
    // SEC-009: ownership is enforced inside the restore transaction; foreign
    // and ownerless reports 404 exactly like absent ones.
    const report = await restoreReportVersion(id, {
      versionId: parsed.data.versionId,
      savedBy: `user:${auth.uid}`,
      requireOwnerId: auth.uid,
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof Error && (error.message === 'Report not found' || error.message === 'Version not found')) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'No previous version available') {
      return NextResponse.json({ error: 'No previous version available' }, { status: 409 });
    }
    log.error('Failed to restore report', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to restore report' }, { status: 500 });
  }
}
