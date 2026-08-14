/**
 * @file api/documents/refresh/route.ts
 * @description API endpoint for refreshing URL document content.
 *
 * POST /api/documents/refresh
 * - Triggers a refresh of URL document content
 * - Sends an event to the Inngest job to fetch and update the document
 *
 * @phase Knowledge Tab Sprint
 * @author Radarist Team
 * @created 2026-01-14
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/refresh');
import { adminGetDocumentById } from '@/lib/document-admin';
import { isRefreshActive } from '@/lib/document-refresh-policy';
import { inngest } from '@/lib/inngest/client';

/**
 * POST handler for document refresh.
 *
 * Expected JSON body:
 * - documentId: string (required)
 * - force: boolean (optional, skip concurrency check)
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();
    const { documentId, force = false } = body;

    // Validate input
    if (!documentId) {
      return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
    }

    // Verify document exists and is a URL type
    const document = await adminGetDocumentById(documentId);
    if (!document) {
      return NextResponse.json({ error: `Document ${documentId} not found` }, { status: 404 });
    }

    if (document.type !== 'url') {
      return NextResponse.json({ error: 'Only URL documents can be refreshed' }, { status: 400 });
    }

    // Check if refresh is already in progress. The guard is time-bounded
    // (isRefreshActive): a refreshInProgress flag left behind by a crashed
    // worker goes stale after REFRESH_STALE_MS and no longer blocks refreshes.
    if (!force && isRefreshActive(document)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Refresh already in progress for this document',
          skipped: true,
        },
        { status: 409 }
      );
    }

    // Trigger the Inngest job
    await inngest.send({
      name: 'app/document.refresh.requested',
      data: {
        documentId,
        force,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Document refresh triggered',
      documentId,
    });
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error during document refresh' }, { status: 500 });
  }
}
