/**
 * @file chat-file-upload.ts
 * @description Client-side helper for uploading files to the document library from the AI chat.
 *
 * This module provides functions for:
 * - Uploading files to the document library via /api/documents/upload
 * - Polling document processing status
 * - Determining if a file should be uploaded to the library (based on size)
 *
 * Used in "Full Mode" when files are too large for inline context extraction.
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type { DocumentReference, DocumentProcessingStatus } from '@/types/ai-assistant';
import { createLogger } from '@/lib/logger';
const log = createLogger('chat-file-upload');

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Size threshold for suggesting library upload (50KB of extracted text).
 * Files with extracted text above this threshold should use Full Mode.
 */
export const LIBRARY_UPLOAD_THRESHOLD = 50 * 1024;

/**
 * Polling interval for document processing status (ms).
 */
export const STATUS_POLL_INTERVAL = 2000;

/**
 * Maximum polling attempts before giving up.
 */
export const MAX_POLL_ATTEMPTS = 60; // 2 minutes at 2s intervals

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result from uploading a file to the document library.
 */
export interface UploadResult {
  success: boolean;
  documentId?: string;
  documentTitle?: string;
  status?: string;
  processingQueued?: boolean;
  processingCompleted?: boolean;
  processingError?: string;
  error?: string;
}

/**
 * Document status response from the API.
 */
export interface DocumentStatusResponse {
  id: string;
  title: string;
  status: 'uploaded' | 'processing' | 'processed' | 'failed' | 'blocked';
  chunkCount?: number;
  errorMessage?: string;
}

// ============================================================================
// UPLOAD FUNCTIONS
// ============================================================================

/**
 * Upload a file to the document library.
 *
 * @param file - File to upload
 * @param options - Additional upload options
 * @returns Upload result with document ID
 *
 * Ownership is assigned server-side from the authenticated request
 * (`/api/documents/upload` derives `uploadedBy` from the Firebase ID token and
 * ignores any body `userId` to prevent impersonation), so callers do not — and
 * cannot — pass an uploader identity here.
 *
 * @example
 * ```typescript
 * const result = await uploadFileToLibrary(file, {
 *   title: 'Annual Report 2024',
 *   description: 'Uploaded from AI chat',
 *   tags: ['ai-upload', 'report'],
 * });
 *
 * if (result.success) {
 *   console.log('Document ID:', result.documentId);
 * }
 * ```
 */
export async function uploadFileToLibrary(
  file: File,
  options?: {
    title?: string;
    description?: string;
    tags?: string[];
  }
): Promise<UploadResult> {
  try {
    const formData = new FormData();
    formData.append('file', file);

    if (options?.title) {
      formData.append('title', options.title);
    }

    if (options?.description) {
      formData.append('description', options.description);
    }

    if (options?.tags && options.tags.length > 0) {
      formData.append('tags', options.tags.join(','));
    }

    // Always trigger async processing
    formData.append('processAsync', 'true');

    const response = await fetchWithAuth('/api/documents/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Upload failed with status ${response.status}`,
      };
    }

    const data = await response.json();

    if (!data.success || !data.document?.id) {
      return {
        success: false,
        error: data.error || 'Upload response missing document ID',
      };
    }

    return {
      success: true,
      documentId: data.document.id,
      documentTitle: data.document.title,
      status: data.document.status,
      processingQueued: data.processingQueued ?? false,
      processingCompleted: data.processingCompleted ?? false,
      processingError: data.processingError,
    };
  } catch (error) {
    log.error('Upload error', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload file',
    };
  }
}

// ============================================================================
// STATUS POLLING FUNCTIONS
// ============================================================================

/**
 * Get the processing status of a document.
 *
 * @param documentId - Document ID to check
 * @returns Document status
 */
export async function getDocumentStatus(documentId: string): Promise<DocumentStatusResponse | null> {
  try {
    // Use the documents API to get the document status
    const response = await fetchWithAuth(`/api/documents/${documentId}`, {
      method: 'GET',
    });

    if (!response.ok) {
      log.error('Failed to get document status', undefined, { status: response.status });
      return null;
    }

    const data = await response.json();
    return {
      id: data.id,
      title: data.title,
      status: data.status,
      chunkCount: data.chunkCount,
      errorMessage: data.errorMessage,
    };
  } catch (error) {
    log.error('Error getting document status', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Convert document status to processing status.
 */
function toProcessingStatus(status: string): DocumentProcessingStatus {
  switch (status) {
    case 'uploaded':
    case 'processing':
      return 'processing';
    case 'processed':
      return 'ready';
    case 'failed':
    case 'blocked':
      return 'failed';
    default:
      return 'processing';
  }
}

/**
 * Poll document status until it's processed or failed.
 *
 * @param documentId - Document ID to poll
 * @param onStatusChange - Callback when status changes
 * @param options - Polling options
 * @returns Final document reference
 *
 * @example
 * ```typescript
 * const ref = await pollDocumentStatus(docId, (ref) => {
 *   console.log(`Status: ${ref.status}`);
 * });
 *
 * if (ref.status === 'ready') {
 *   console.log('Document is ready for Q&A!');
 * }
 * ```
 */
export async function pollDocumentStatus(
  documentId: string,
  onStatusChange?: (ref: DocumentReference) => void,
  options?: {
    interval?: number;
    maxAttempts?: number;
  }
): Promise<DocumentReference> {
  const interval = options?.interval ?? STATUS_POLL_INTERVAL;
  const maxAttempts = options?.maxAttempts ?? MAX_POLL_ATTEMPTS;

  let attempts = 0;
  let lastStatus: DocumentProcessingStatus = 'processing';

  const createReference = (
    status: DocumentProcessingStatus,
    name: string,
    errorMessage?: string
  ): DocumentReference => ({
    documentId,
    name,
    status,
    errorMessage,
    uploadedAt: Date.now(),
  });

  while (attempts < maxAttempts) {
    const statusResponse = await getDocumentStatus(documentId);

    if (!statusResponse) {
      // API error, keep polling
      await sleep(interval);
      attempts++;
      continue;
    }

    const currentStatus = toProcessingStatus(statusResponse.status);
    const ref = createReference(currentStatus, statusResponse.title, statusResponse.errorMessage);

    // Notify on status change
    if (currentStatus !== lastStatus) {
      lastStatus = currentStatus;
      onStatusChange?.(ref);
    }

    // If processing is complete (ready or failed), return
    if (currentStatus === 'ready' || currentStatus === 'failed') {
      return ref;
    }

    await sleep(interval);
    attempts++;
  }

  // Timeout - return with current status
  return createReference('failed', 'Unknown', 'Processing timeout');
}

/**
 * Create an initial document reference for a file being uploaded.
 *
 * @param file - File being uploaded
 * @returns Initial document reference with "uploading" status
 */
export function createUploadingReference(file: File): DocumentReference {
  return {
    documentId: '', // Will be set after upload
    name: file.name,
    status: 'uploading',
    uploadedAt: Date.now(),
  };
}

/**
 * Create a document reference from upload result.
 *
 * @param result - Upload result
 * @param fileName - Original file name
 * @returns Document reference
 */
export function createReferenceFromUpload(result: UploadResult, fileName: string): DocumentReference {
  if (result.success && result.documentId) {
    // If processing already completed, mark as ready
    const status: DocumentProcessingStatus = result.processingCompleted
      ? 'ready'
      : result.processingError
        ? 'failed'
        : 'processing';

    return {
      documentId: result.documentId,
      name: result.documentTitle || fileName,
      status,
      errorMessage: result.processingError,
      uploadedAt: Date.now(),
    };
  }

  return {
    documentId: '',
    name: fileName,
    status: 'failed',
    errorMessage: result.error,
    uploadedAt: Date.now(),
  };
}

// ============================================================================
// DOCUMENT METADATA ANALYSIS
// ============================================================================

/**
 * Result from analyzing document content for metadata.
 */
export interface DocumentMetadataResult {
  success: boolean;
  description: string;
  tags: string[];
  documentType?: string;
  keyTopics?: string[];
  error?: string;
}

/**
 * Analyze document content to generate metadata (description, tags) using AI.
 *
 * @param text - Extracted text content from the document
 * @param fileName - Original file name
 * @param fileType - MIME type of the file
 * @returns Generated metadata
 *
 * @example
 * ```typescript
 * const metadata = await analyzeDocumentForMetadata(
 *   extractedText,
 *   'Annual Report 2024.pdf',
 *   'application/pdf'
 * );
 *
 * console.log(metadata.description); // "Annual financial report covering Q1-Q4 2024..."
 * console.log(metadata.tags); // ['annual-report', 'financial', 'ai-upload']
 * ```
 */
export async function analyzeDocumentForMetadata(
  text: string,
  fileName: string,
  fileType?: string
): Promise<DocumentMetadataResult> {
  try {
    const response = await fetchWithAuth('/api/ai/analyze-document', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        fileName,
        fileType,
      }),
    });

    if (!response.ok) {
      log.error('Metadata analysis failed', undefined, { status: response.status });
      return {
        success: false,
        description: 'Document uploaded via AI Assistant',
        tags: ['ai-upload'],
        error: `Analysis failed with status ${response.status}`,
      };
    }

    const data = await response.json();
    return {
      success: data.success,
      description: data.description || 'Document uploaded via AI Assistant',
      tags: data.tags || ['ai-upload'],
      documentType: data.documentType,
      keyTopics: data.keyTopics,
      error: data.error,
    };
  } catch (error) {
    log.error('Metadata analysis error', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      description: 'Document uploaded via AI Assistant',
      tags: ['ai-upload'],
      error: error instanceof Error ? error.message : 'Analysis failed',
    };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a file's extracted text size suggests library upload.
 *
 * @param extractedTextSize - Size of extracted text in bytes
 * @returns Whether library upload is recommended
 */
export function shouldUploadToLibrary(extractedTextSize: number): boolean {
  return extractedTextSize > LIBRARY_UPLOAD_THRESHOLD;
}
