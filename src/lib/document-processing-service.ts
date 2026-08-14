/**
 * @file lib/document-processing-service.ts
 * @description Service for processing uploaded documents in the Evidence Layer.
 * Orchestrates text extraction, chunking, and status updates.
 *
 * Pipeline:
 * 1. Download file from Firebase Storage
 * 2. Extract text (PDF, DOCX, TXT, MD)
 * 3. Chunk text for embedding
 * 4. Store chunks in Firestore
 * 5. Update document status
 *
 * Note: Embedding generation is handled separately by the Inngest job.
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import { extractTextFromDocument } from '@/lib/document-extraction';
// The Storage READ (`getDocumentContent`) is routed through the admin-SDK twin
// (`adminGetDocumentContent`) so this server-side processing module does not hit
// the `code: 'unavailable'` failure when the file-upload (PDF/DOCX) path runs in
// the stateless serverless / Inngest worker. Aliased to keep the call site.
import { adminGetDocumentContent as getDocumentContent } from '@/lib/document-storage-admin';
// `prepareChunksFromText` is a pure text-processing helper (no Firestore) and
// stays on the client service. The Firestore WRITE paths (`createChunks`,
// `deleteChunksForDocument`) are routed through the admin-SDK twins so this
// server-side processing module does not hit the `code: 'unavailable'` failure
// in stateless serverless / Inngest workers.
import { prepareChunksFromText } from '@/lib/document-chunk-service';
import {
  adminCreateChunks as createChunks,
  adminDeleteChunksForDocument as deleteChunksForDocument,
} from '@/lib/document-chunk-admin';
import { adminGetDocumentById as getDocumentById, adminUpdateDocument as updateDocument } from '@/lib/document-admin';
import type { Document, DocumentStatus } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('document-processing-service');

// ============================================================================
// TYPES
// ============================================================================

export interface ProcessingResult {
  success: true;
  documentId: string;
  extractedText: string;
  textLength: number;
  pageCount?: number;
  chunkCount: number;
  chunkIds: string[];
}

export interface ProcessingError {
  success: false;
  documentId: string;
  error: string;
  stage: 'download' | 'extraction' | 'chunking' | 'storage';
}

export type ProcessingResponse = ProcessingResult | ProcessingError;

export interface ProcessingOptions {
  /** Chunk size in characters (default: 1000) */
  chunkSize?: number;
  /** Overlap between chunks (default: 200) */
  chunkOverlap?: number;
  /** Whether to delete existing chunks before processing (default: true) */
  replaceExisting?: boolean;
}

// ============================================================================
// TERMINAL-STATE WRITES
// ============================================================================

/**
 * Persist a TERMINAL failure for a document.
 *
 * UX-036: every failure path here used to write `{ status: 'failed' }` and
 * nothing else, so `Document.errorMessage` was never populated by the
 * processing pipeline. The detail sheet renders its "Processing Failed" panel
 * only when `status === 'failed' && errorMessage` — the panel could therefore
 * never appear, and a failed document showed a red badge with no reason
 * anywhere in the product. The reason is now always persisted alongside the
 * status so the UI can tell the user WHY.
 *
 * Best-effort by contract: the caller is already returning a typed failure, so
 * a Firestore write error here must not mask the original cause.
 */
async function markProcessingFailed(documentId: string, error: string, stage: ProcessingError['stage']): Promise<void> {
  try {
    await updateDocument(documentId, {
      status: 'failed' as DocumentStatus,
      errorMessage: `${error} (stage: ${stage})`,
    });
  } catch (writeError) {
    log.error(
      'Failed to persist document processing failure',
      writeError instanceof Error ? writeError : new Error(String(writeError)),
      { documentId, stage }
    );
  }
}

/**
 * The fields written when a processing run STARTS.
 *
 * UX-036: these two writes (`processDocument` and `processDocumentFromContent`)
 * used to set `status: 'processing'` alone. `document-processing-policy.ts`
 * reports a `processing` document with no `processingRequestedAt` as ACTIVE
 * FOREVER — a deliberately safe default, because the recovery action is
 * destructive and an unstamped run may belong to another pipeline (deep
 * research creates its document `processing` and stays silent for minutes).
 * For a run STARTED HERE that default is a trap: a process that died mid-run
 * left the document permanently "Processing" with both Retry and Process hidden
 * in the UI, i.e. unrecoverable — the exact state UX-036 exists to remove.
 *
 * Stamping here bounds every run this module starts, whoever called it: the
 * async worker, the synchronous `/api/documents/process` route, or an ops
 * replay. The stamp is refreshed at RUN start rather than trusted from the
 * enqueue, so a job that waited in the queue gets its full liveness window.
 *
 * Shared by both paths on purpose — a second copy is how the URL path drifted
 * from the file path before.
 */
function startedRunUpdate(): Partial<Document> {
  return {
    status: 'processing' as DocumentStatus,
    processingRequestedAt: Date.now(),
  };
}

/**
 * The fields every successful pass writes. `errorMessage` is cleared to the
 * empty string (the Firestore mappers skip `undefined`, so passing `undefined`
 * would silently LEAVE the previous failure text on a now-healthy document).
 */
function processedUpdate(chunkCount: number, pageCount?: number): Partial<Document> {
  return {
    status: 'processed' as DocumentStatus,
    processedAt: Date.now(),
    chunkCount,
    ...(pageCount !== undefined ? { pageCount } : {}),
    errorMessage: '',
  };
}

// ============================================================================
// MAIN PROCESSING FUNCTION
// ============================================================================

/**
 * Process a document: extract text, chunk it, and store chunks.
 *
 * @param documentId - ID of the document to process
 * @param options - Processing options
 * @returns Processing result or error
 */
export async function processDocument(documentId: string, options?: ProcessingOptions): Promise<ProcessingResponse> {
  const chunkSize = options?.chunkSize ?? 1000;
  const chunkOverlap = options?.chunkOverlap ?? 200;
  const replaceExisting = options?.replaceExisting ?? true;

  try {
    // 1. Get document metadata
    const document = await getDocumentById(documentId);
    if (!document) {
      return {
        success: false,
        documentId,
        error: `Document ${documentId} not found`,
        stage: 'download',
      };
    }

    // Update status to processing
    await updateDocument(documentId, startedRunUpdate());

    // 2. Download file from Storage
    const fileBuffer = await downloadFromStorage(document.storageUrl);
    if (!fileBuffer) {
      // UX-036: a URL document has `storageUrl: ''`, so this branch used to
      // report the opaque "Failed to download file from " with an empty path.
      // Name the real problem — this document has no stored bytes at all and
      // must be processed from its source URL instead.
      const error = document.storageUrl?.trim()
        ? `Failed to download the stored file at ${document.storageUrl}`
        : 'This document has no stored file to process. Reprocess it from its source URL instead.';
      await markProcessingFailed(documentId, error, 'download');
      return { success: false, documentId, error, stage: 'download' };
    }

    // 3. Extract text based on file type
    const mimeType = document.mimeType || 'application/octet-stream';
    const extractionResult = await extractText(fileBuffer, mimeType);
    if (!extractionResult.success) {
      await markProcessingFailed(documentId, extractionResult.error, 'extraction');
      return {
        success: false,
        documentId,
        error: extractionResult.error,
        stage: 'extraction',
      };
    }

    // 4. Validate extracted text
    if (!extractionResult.text || extractionResult.text.trim().length < 10) {
      const error = 'Document contains too little text to process';
      await markProcessingFailed(documentId, error, 'extraction');
      return { success: false, documentId, error, stage: 'extraction' };
    }

    // 5. Delete existing chunks if replacing
    if (replaceExisting) {
      await deleteChunksForDocument(documentId);
    }

    // 6. Chunk the text
    const chunkInputs = prepareChunksFromText(documentId, extractionResult.text, {
      chunkSize,
      chunkOverlap,
    });

    // 7. Store chunks in Firestore
    const chunkIds = await createChunks(chunkInputs);

    // 8. Update document status to processed. chunkCount/pageCount MUST be
    // stamped here — the file path historically omitted them (only the URL
    // content path wrote chunkCount), which left every PDF/DOCX upload
    // showing "—" in the documents table despite having chunks in Firestore.
    await updateDocument(documentId, processedUpdate(chunkIds.length, extractionResult.pageCount));

    log.info('Processed document', {
      documentId,
      textLength: extractionResult.text.length,
      chunkCount: chunkIds.length,
    });

    return {
      success: true,
      documentId,
      extractedText: extractionResult.text,
      textLength: extractionResult.text.length,
      pageCount: extractionResult.pageCount,
      chunkCount: chunkIds.length,
      chunkIds,
    };
  } catch (error) {
    log.error('Error processing', error instanceof Error ? error : new Error(String(error)), { documentId });

    const message = error instanceof Error ? error.message : 'Unknown processing error';
    await markProcessingFailed(documentId, message, 'storage');

    return { success: false, documentId, error: message, stage: 'storage' };
  }
}

// ============================================================================
// URL/CONTENT PROCESSING
// ============================================================================

/**
 * Process a document from already-fetched content (for URL documents).
 * Skips the download step since content is provided directly.
 *
 * @param documentId - ID of the document to process
 * @param content - Pre-fetched text content
 * @param options - Processing options
 * @returns Processing result or error
 */
export async function processDocumentFromContent(
  documentId: string,
  content: string,
  options?: ProcessingOptions
): Promise<ProcessingResponse> {
  const chunkSize = options?.chunkSize ?? 1000;
  const chunkOverlap = options?.chunkOverlap ?? 200;
  const replaceExisting = options?.replaceExisting ?? true;

  try {
    // 1. Get document metadata
    const document = await getDocumentById(documentId);
    if (!document) {
      return {
        success: false,
        documentId,
        error: `Document ${documentId} not found`,
        stage: 'download',
      };
    }

    // Update status to processing
    await updateDocument(documentId, startedRunUpdate());

    // 2. Validate content
    if (!content || content.trim().length < 10) {
      const error = 'URL content contains too little text to process';
      await markProcessingFailed(documentId, error, 'extraction');
      return { success: false, documentId, error, stage: 'extraction' };
    }

    // 3. Delete existing chunks if replacing
    if (replaceExisting) {
      await deleteChunksForDocument(documentId);
    }

    // 4. Chunk the text
    const chunkInputs = prepareChunksFromText(documentId, content, {
      chunkSize,
      chunkOverlap,
    });

    // 5. Store chunks in Firestore
    const chunkIds = await createChunks(chunkInputs);

    // 6. Update document status to processed
    await updateDocument(documentId, processedUpdate(chunkIds.length));

    log.info('Processed URL document', { documentId, textLength: content.length, chunkCount: chunkIds.length });

    return {
      success: true,
      documentId,
      extractedText: content,
      textLength: content.length,
      chunkCount: chunkIds.length,
      chunkIds,
    };
  } catch (error) {
    log.error('Error processing URL', error instanceof Error ? error : new Error(String(error)), { documentId });

    const message = error instanceof Error ? error.message : 'Unknown processing error';
    await markProcessingFailed(documentId, message, 'storage');

    return { success: false, documentId, error: message, stage: 'storage' };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Download a file from Firebase Storage.
 *
 * @param storagePath - Path in Firebase Storage
 * @returns File as Buffer or null if download fails
 */
async function downloadFromStorage(storagePath: string): Promise<Buffer | null> {
  try {
    // Use getDocumentContent which supports both Firebase Storage and Firestore fallback
    const result = await getDocumentContent(storagePath);
    if (!result) {
      log.error('File not found', undefined, { storagePath });
      return null;
    }
    return result.content;
  } catch (error) {
    log.error('Download error', error instanceof Error ? error : new Error(String(error)), { storagePath });
    return null;
  }
}

/**
 * Extract text from a file buffer based on MIME type.
 *
 * @param buffer - File buffer
 * @param mimeType - MIME type of the file
 * @returns Extraction result
 */
async function extractText(
  buffer: Buffer,
  mimeType: string
): Promise<{ success: true; text: string; pageCount?: number } | { success: false; error: string }> {
  // Handle plain text and markdown directly
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    const text = buffer.toString('utf-8');
    return { success: true, text };
  }

  // Use document-extraction for PDF and DOCX
  const result = await extractTextFromDocument(buffer, mimeType);

  if (!result.success) {
    return { success: false, error: result.error || 'Extraction failed' };
  }

  return {
    success: true,
    text: result.text,
    pageCount: result.pageCount,
  };
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Process multiple documents.
 *
 * @param documentIds - Array of document IDs to process
 * @param options - Processing options
 * @returns Array of processing results
 */
export async function processDocuments(
  documentIds: string[],
  options?: ProcessingOptions
): Promise<ProcessingResponse[]> {
  const results: ProcessingResponse[] = [];

  for (const documentId of documentIds) {
    const result = await processDocument(documentId, options);
    results.push(result);
  }

  const successful = results.filter((r) => r.success).length;
  log.info('Batch complete', { successful, total: documentIds.length });

  return results;
}

/**
 * Reprocess a document (delete existing chunks and process again).
 *
 * @param documentId - Document ID to reprocess
 * @param options - Processing options
 * @returns Processing result
 */
export async function reprocessDocument(
  documentId: string,
  options?: Omit<ProcessingOptions, 'replaceExisting'>
): Promise<ProcessingResponse> {
  return processDocument(documentId, { ...options, replaceExisting: true });
}

// ============================================================================
// STATUS HELPERS
// ============================================================================

/**
 * Get documents that need processing.
 *
 * @returns Array of documents with status 'pending'
 */
export async function getDocumentsPendingProcessing(): Promise<Document[]> {
  // Server-side processing module — use the admin-SDK twin to avoid the
  // `code: 'unavailable'` failure in stateless serverless / Inngest workers.
  const { adminGetDocuments } = await import('@/lib/document-admin');
  return adminGetDocuments({ status: 'uploaded' });
}

/**
 * Get documents that failed processing.
 *
 * @returns Array of documents with status 'failed'
 */
export async function getDocumentsWithErrors(): Promise<Document[]> {
  const { adminGetDocuments } = await import('@/lib/document-admin');
  return adminGetDocuments({ status: 'failed' });
}
