/**
 * @file app/api/reports/[id]/versions/[versionId]/route.ts
 * @description DISC-014 — fetch a single stored report version (for
 * point-in-time preview), including its full html body.
 *
 * Endpoints:
 * - GET /api/reports/[id]/versions/[versionId] — one version with html.
 *
 * Follows the same auth pattern as the sibling /api/reports/[id] routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getReportVersionOwnedBy } from '@/lib/reports/report-versions';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports/[id]/versions/[versionId]');

/**
 * GET /api/reports/[id]/versions/[versionId]
 *
 * Returns:
 * - 200 with the full ReportVersion (includes html)
 * - 401 if not authenticated
 * - 404 if the version does not exist — or the parent report is absent,
 *   foreign, or ownerless (SEC-009: historical HTML is owner-only, and every
 *   deny case shares this one response)
 * - 500 on server error
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id, versionId } = await params;
    const version = await getReportVersionOwnedBy(id, versionId, auth.uid);
    if (!version) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }
    return NextResponse.json(version);
  } catch (error) {
    log.error('Failed to get report version', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get report version' }, { status: 500 });
  }
}
