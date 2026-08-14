/**
 * @file app/api/reports/[id]/versions/route.ts
 * @description DISC-014 — list a report's version history.
 *
 * Endpoints:
 * - GET /api/reports/[id]/versions — metadata-only list of stored versions
 *   (newest-first), never including the html bodies.
 *
 * Follows the same auth pattern as the sibling /api/reports/[id] routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { listReportVersionsOwnedBy } from '@/lib/reports/report-versions';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports/[id]/versions');

/**
 * GET /api/reports/[id]/versions
 *
 * Returns:
 * - 200 with `{ versions: ReportVersionSummary[] }` (newest-first, no html)
 * - 401 if not authenticated
 * - 404 if the report is absent, foreign, or ownerless (SEC-009 — one
 *   indistinguishable not-found)
 * - 500 on server error
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const versions = await listReportVersionsOwnedBy(id, auth.uid);
    return NextResponse.json({ versions });
  } catch (error) {
    if (error instanceof Error && error.message === 'Report not found') {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    log.error('Failed to list report versions', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list report versions' }, { status: 500 });
  }
}
