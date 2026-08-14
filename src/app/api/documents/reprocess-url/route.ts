/**
 * @file api/documents/reprocess-url/route.ts
 * @description API endpoint for reprocessing URL documents.
 *
 * POST /api/documents/reprocess-url
 * - Re-fetches content from the original URL
 * - Creates chunks from the content
 * - Updates document status
 *
 * Useful for documents that failed processing or are stuck in pending state.
 *
 * @phase Phase 8: URL Document Processing
 * @author Radarist Team
 * @created 2026-01-15
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/reprocess-url');
import { adminGetDocumentById } from '@/lib/document-admin';
import { reprocessDocumentContent } from '@/lib/document-reprocess';

// ============================================================================
// CONTENT FETCHING + TDM GATE + CHUNKING — centralized in
// @/lib/document-reprocess (UX-036). This route keeps only its URL-document
// precondition; the fetch/gate/process body it used to own was the ONLY
// type-correct implementation in the tree and had zero callers.
// ============================================================================

// ============================================================================
// API HANDLER
// ============================================================================

/**
 * POST /api/documents/reprocess-url
 *
 * Reprocess a URL document by re-fetching content and creating chunks.
 *
 * Request body:
 * - documentId: string (required) - The document ID to reprocess
 *
 * Response:
 * - 200: Document reprocessed successfully
 * - 400: Invalid request or not a URL document
 * - 403: The site reserved this content from text/data mining (TDM opt-out);
 *        the document is marked `blocked` with the reason
 * - 404: Document not found
 * - 500: Server error
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // Parse request body
    const body = await request.json();
    const { documentId } = body;

    if (!documentId) {
      return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
    }

    // Get document
    const document = await adminGetDocumentById(documentId);
    if (!document) {
      return NextResponse.json({ error: `Document ${documentId} not found` }, { status: 404 });
    }

    // Verify it's a URL type document
    if (document.type !== 'url') {
      return NextResponse.json(
        {
          error:
            'Only URL documents can be reprocessed with this endpoint. Use /api/documents/process for uploaded documents.',
        },
        { status: 400 }
      );
    }

    // Verify document has original URL
    if (!document.originalUrl) {
      return NextResponse.json({ error: 'Document does not have an original URL stored' }, { status: 400 });
    }

    log.info('Starting reprocess', { title: document.title, url: document.originalUrl });

    // The TDM gate, the receipted re-fetch and the chunking pass all live in
    // the shared operation so this route, /api/documents/process and the
    // Inngest worker cannot drift apart.
    const outcome = await reprocessDocumentContent(documentId, {
      replaceExisting: true,
      owner: `user:${auth.uid}`,
      correlationId: `reprocess-${documentId}`,
      // UX-036: like /api/documents/process, this route runs the pipeline
      // inline without holding the processing claim, so it stands down while a
      // claimed worker run is live instead of racing it for the same chunks.
      refuseWhenLive: true,
    });

    if (!outcome.ok) {
      log.info('Reprocess refused', { documentId, code: outcome.code });
      return NextResponse.json(
        {
          error: outcome.error,
          documentId,
          code: outcome.code,
          stage: outcome.stage,
          ...(outcome.code === 'tdm-blocked' ? { tdmBlocked: true } : {}),
        },
        { status: outcome.httpStatus }
      );
    }

    log.info('Successfully reprocessed document', { documentId, chunkCount: outcome.chunkCount });

    try {
      const { inngest } = await import('@/lib/inngest/client');
      await inngest.send({
        name: 'app/document.sync.requested',
        data: { documentId, operation: 'update' },
      });
    } catch {
      // Graph sync is best-effort
    }

    return NextResponse.json({
      success: true,
      document: {
        id: documentId,
        title: document.title,
        status: 'processed',
        chunkCount: outcome.chunkCount,
        textLength: outcome.textLength,
      },
      message: 'Document reprocessed successfully',
    });
  } catch (error) {
    log.error('Reprocess failed', error instanceof Error ? error : undefined);

    return NextResponse.json(
      {
        error: 'Failed to reprocess document',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
