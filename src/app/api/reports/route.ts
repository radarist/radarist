/**
 * @file app/api/reports/route.ts
 * @description API routes for managing shareable reports
 *
 * Endpoints:
 * - POST /api/reports - Create a new report (authenticated)
 * - GET /api/reports - List all reports (authenticated)
 *
 * Both endpoints require Firebase Auth token in the Authorization header.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createReport, listReportsOwnedBy } from '@/lib/reports';
import { createReportSchema } from '@/lib/schemas/report';
import { ReportPublicationError } from '@/lib/reports/publication-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports');

/**
 * POST /api/reports
 *
 * Create a new shareable report.
 *
 * Request body:
 * ```json
 * {
 *   "title": "Q1 Technology Radar Report",
 *   "html": "<html>...</html>",
 *   "createdBy": "agent",
 *   "agentType": "creator",
 *   "missionId": "mission-123",
 *   "entityIds": ["tech-1", "tech-2"],
 *   "metadata": {
 *     "description": "Quarterly overview",
 *     "ogImage": "https://example.com/og.png",
 *     "dataSnapshotAt": "2026-02-23T10:00:00Z"
 *   }
 * }
 * ```
 *
 * Returns: 201 with the created Report object
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const validation = createReportSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }

    // Always stamp ownerId from the authenticated caller — never trust the
    // body. C4 ownership decisions in listReports/getReportById/etc. all
    // run against this field.
    const report = await createReport({ ...validation.data, ownerId: auth.uid });
    log.info('Report created via API', { reportId: report.id, uid: auth.uid });

    return NextResponse.json(report, { status: 201 });
  } catch (error) {
    // UX-021: executable/off-origin report HTML is a caller-fixable problem, not
    // a server fault — return 422 with the actionable conversion guidance.
    if (error instanceof ReportPublicationError) {
      return NextResponse.json({ error: error.message, violations: error.violations }, { status: 422 });
    }
    log.error('Failed to create report', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to create report' }, { status: 500 });
  }
}

/**
 * GET /api/reports
 *
 * List the authenticated caller's reports, ordered by creation date (newest
 * first). SEC-009: the listing is owner-scoped server-side — other users'
 * reports and ownerless legacy records never appear.
 *
 * Returns: 200 with array of Report objects
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const reports = await listReportsOwnedBy(auth.uid);
    return NextResponse.json(reports);
  } catch (error) {
    log.error('Failed to list reports', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list reports' }, { status: 500 });
  }
}
