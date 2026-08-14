/**
 * @file api/documents/process/route.ts
 * @description API endpoint for processing uploaded documents.
 *
 * POST /api/documents/process
 * - Triggers text extraction and chunking for a document
 * - Can process a single document or multiple documents
 * - Optionally configures chunk size and overlap
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/process');
import { getDocumentsPendingProcessing } from '@/lib/document-processing-service';
import { reprocessDocumentContent, reprocessDocuments } from '@/lib/document-reprocess';

/**
 * POST handler for document processing.
 *
 * Expected JSON body:
 * - documentId: string (required if no documentIds)
 * - documentIds: string[] (required if no documentId)
 * - chunkSize: number (optional, default: 1000)
 * - chunkOverlap: number (optional, default: 200)
 * - replaceExisting: boolean (optional, default: true)
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();

    // Validate input
    const { documentId, documentIds, chunkSize, chunkOverlap, replaceExisting } = body;

    if (!documentId && !documentIds) {
      return NextResponse.json({ error: 'Either documentId or documentIds is required' }, { status: 400 });
    }

    if (documentId && documentIds) {
      return NextResponse.json({ error: 'Provide either documentId or documentIds, not both' }, { status: 400 });
    }

    const options = {
      chunkSize: chunkSize ? Number(chunkSize) : undefined,
      chunkOverlap: chunkOverlap ? Number(chunkOverlap) : undefined,
      replaceExisting: replaceExisting !== false,
    };

    // Process single document. UX-036: this used to call `processDocument`
    // directly, which ALWAYS took the stored-file path — a URL document has
    // `storageUrl: ''`, so Process answered 422 for exactly the documents the
    // (type-correct but unreachable) reprocess-url route existed to serve.
    // Both branches of this route now go through the shared operation.
    if (documentId) {
      const outcome = await reprocessDocumentContent(documentId, {
        ...options,
        owner: `user:${auth.uid}`,
        correlationId: `process-${documentId}`,
        // UX-036: this endpoint runs the pipeline inline and does NOT hold the
        // processing claim, so it must stand down while a claimed worker run is
        // live rather than becoming a second writer of the same chunks.
        refuseWhenLive: true,
      });

      if (!outcome.ok) {
        return NextResponse.json(
          {
            success: false,
            documentId: outcome.documentId,
            error: outcome.error,
            code: outcome.code,
            stage: outcome.stage,
          },
          { status: outcome.httpStatus }
        );
      }

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
        result: {
          documentId: outcome.documentId,
          source: outcome.source,
          textLength: outcome.textLength,
          pageCount: outcome.pageCount,
          chunkCount: outcome.chunkCount,
        },
        message: 'Document processed successfully',
      });
    }

    // Process multiple documents
    if (documentIds && Array.isArray(documentIds)) {
      if (documentIds.length === 0) {
        return NextResponse.json({ error: 'documentIds array cannot be empty' }, { status: 400 });
      }

      if (documentIds.length > 50) {
        return NextResponse.json({ error: 'Maximum 50 documents can be processed at once' }, { status: 400 });
      }

      // Same source selection as the single-document branch. This used to call
      // `processDocuments`, which loops over the unconditional stored-file
      // path — so a URL document in a batch still failed with a download error
      // even after the single-document branch was made type-correct.
      const results = await reprocessDocuments(documentIds, {
        ...options,
        owner: `user:${auth.uid}`,
        correlationId: 'process-batch',
        // Same live-run guard as the single-document branch — per document, so
        // one busy id cannot silently double-process while the rest proceed.
        refuseWhenLive: true,
      });

      const successful = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      return NextResponse.json({
        success: failed.length === 0,
        summary: {
          total: results.length,
          successful: successful.length,
          failed: failed.length,
        },
        results: results.map((r) =>
          r.ok
            ? {
                documentId: r.documentId,
                success: true,
                source: r.source,
                textLength: r.textLength,
                chunkCount: r.chunkCount,
              }
            : {
                documentId: r.documentId,
                success: false,
                error: r.error,
                code: r.code,
                stage: r.stage,
              }
        ),
        message:
          failed.length === 0
            ? 'All documents processed successfully'
            : `${successful.length}/${results.length} documents processed successfully`,
      });
    }

    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error during document processing' }, { status: 500 });
  }
}

/**
 * GET handler to get pending documents.
 * Returns documents that are waiting to be processed.
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const pendingDocuments = await getDocumentsPendingProcessing();

    return NextResponse.json({
      count: pendingDocuments.length,
      documents: pendingDocuments.map((doc) => ({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        status: doc.status,
        fileSize: doc.fileSize,
        createdAt: doc.createdAt,
      })),
    });
  } catch (error) {
    log.error('GET error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error getting pending documents' }, { status: 500 });
  }
}
