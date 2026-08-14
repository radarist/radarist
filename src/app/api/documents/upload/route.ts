/**
 * @file api/documents/upload/route.ts
 * @description API endpoint for uploading documents to the Evidence Layer.
 *
 * POST /api/documents/upload
 * - Accepts multipart/form-data with a file
 * - Validates file size and type
 * - Uploads to Firebase Storage
 * - Creates Document record in Firestore
 * - Optionally triggers async processing (chunking/embedding)
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/upload');
import { validateFile, ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from '@/lib/document-storage-service';
import { adminUploadDocument } from '@/lib/document-storage-admin';
import { adminCreateDocument } from '@/lib/document-admin';
import { inngest } from '@/lib/inngest/client';
import { processDocument } from '@/lib/document-processing-service';
import type { DocumentType } from '@/lib/types';

/**
 * POST handler for document upload.
 *
 * Expected form data:
 * - file: The document file (required)
 * - title: Document title (optional, defaults to filename)
 * - description: Document description (optional)
 * - tags: Comma-separated tags (optional)
 * - processAsync: Whether to trigger async processing (optional, default: true)
 *
 * The uploader is taken from the authenticated session (auth.uid), NOT from the
 * request body — a body `userId` is ignored.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const formData = await request.formData();

    // Extract file
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Owner is ALWAYS the authenticated session user — never a body-supplied
    // value. Trusting formData.get('userId') would let any authenticated caller
    // upload a document owned by (and in the storage path of) another user.
    const userId = auth.uid;

    const title = (formData.get('title') as string) || file.name;
    const description = formData.get('description') as string | undefined;
    const tagsString = formData.get('tags') as string | undefined;
    const tags = tagsString
      ? tagsString
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const processAsync = formData.get('processAsync') !== 'false';

    // Validate file
    const validation = validateFile(file.size, file.type);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to Firebase Storage
    const uploadResult = await adminUploadDocument(buffer, file.name, file.type, userId);

    if (!uploadResult.success) {
      return NextResponse.json({ error: uploadResult.error }, { status: 500 });
    }

    // Get document type from MIME type
    const documentType: DocumentType = ALLOWED_MIME_TYPES[file.type] || 'text';

    // Create Firestore document record
    const document = await adminCreateDocument({
      title,
      type: documentType,
      storageUrl: uploadResult.storageUrl,
      description,
      tags,
      fileSize: uploadResult.size,
      mimeType: uploadResult.mimeType,
      uploadedBy: userId,
    });

    // Trigger async processing via Inngest (non-blocking)
    let processingQueued = false;
    let processingCompleted = false;
    let processingError: string | undefined;

    if (processAsync) {
      try {
        await inngest.send({
          name: 'app/document.process.requested',
          data: { documentId: document.id },
        });
        processingQueued = true;
        log.info('Queued processing for document', { documentId: document.id });
      } catch (_inngestError) {
        // Inngest failed - try direct processing as fallback
        log.warn('Inngest not available, using direct processing');

        try {
          log.info('Starting direct processing for document', { documentId: document.id });
          const result = await processDocument(document.id);

          if (result.success) {
            processingCompleted = true;
            log.info('Direct processing completed', { chunkCount: result.chunkCount });

            try {
              const { triggerDocumentSync } = await import('@/lib/inngest/functions/sync-document-to-neo4j');
              await triggerDocumentSync(document.id, 'update');
            } catch {
              // Graph sync is best-effort even in fallback
            }
          } else {
            processingError = result.error;
            log.warn('Direct processing failed', { error: result.error });
          }
        } catch (directError) {
          processingError = directError instanceof Error ? directError.message : 'Direct processing failed';
          log.error('Direct processing error', directError instanceof Error ? directError : undefined);
        }
      }
    }

    log.info('Created document', { documentId: document.id, title: document.title });

    // Determine the message based on processing state
    let message: string;
    if (processingCompleted) {
      message = 'Document uploaded and processed successfully.';
    } else if (processingQueued) {
      message = 'Document uploaded. Processing will begin shortly.';
    } else if (processingError) {
      message = `Document uploaded but processing failed: ${processingError}`;
    } else if (processAsync) {
      message = 'Document uploaded. Manual processing may be required.';
    } else {
      message = 'Document uploaded successfully.';
    }

    return NextResponse.json({
      success: true,
      document: {
        id: document.id,
        title: document.title,
        type: document.type,
        status: processingCompleted ? 'processed' : document.status,
        storageUrl: document.storageUrl,
        downloadUrl: uploadResult.downloadUrl,
        fileSize: document.fileSize,
        mimeType: document.mimeType,
        createdAt: document.createdAt,
      },
      processingQueued,
      processingCompleted,
      processingError,
      message,
    });
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error during document upload' }, { status: 500 });
  }
}

/**
 * GET handler for upload configuration.
 * Returns allowed file types and size limits.
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  return NextResponse.json({
    maxFileSize: MAX_FILE_SIZE,
    maxFileSizeMB: MAX_FILE_SIZE / (1024 * 1024),
    allowedTypes: Object.keys(ALLOWED_MIME_TYPES),
    allowedExtensions: ['pdf', 'docx', 'pptx', 'txt', 'md'],
  });
}
