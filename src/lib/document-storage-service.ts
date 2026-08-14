/**
 * @file lib/document-storage-service.ts
 * @description Service for uploading documents to Firebase Storage.
 * Handles file upload, URL generation, and deletion.
 *
 * Includes a Firestore fallback for development when Firebase Storage
 * isn't enabled in the project.
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  getMetadata,
} from 'firebase/storage';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
} from 'firebase/firestore';
import { storage, db } from '@/lib/firebase';
import type { DocumentType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('document-storage-service');

// ============================================================================
// FIRESTORE FALLBACK STORAGE (for development when Storage isn't enabled)
// ============================================================================

/**
 * Firestore collection for storing document content when Storage isn't available.
 * This is a development fallback - use real Storage for production.
 */
const DOCUMENT_BLOBS_COLLECTION = 'document_blobs';

/**
 * Check if we should use Firestore fallback storage.
 * Set NEXT_PUBLIC_USE_FIRESTORE_STORAGE=true to force Firestore storage.
 */
const useFirestoreFallback = process.env.NEXT_PUBLIC_USE_FIRESTORE_STORAGE === 'true';

/**
 * Upload document to Firestore as base64 (fallback for dev).
 * Limited to ~1MB due to Firestore document size limits.
 */
async function uploadToFirestoreFallback(
  file: Buffer | Blob,
  fileName: string,
  mimeType: string,
  userId: string,
  storagePath: string
): Promise<UploadResult | null> {
  try {
    const fileSize = file instanceof Blob ? file.size : file.byteLength;

    // Firestore docs have 1MB limit, so limit to 900KB for safety
    if (fileSize > 900 * 1024) {
      log.warn('File too large for Firestore fallback, need Firebase Storage');
      return null;
    }

    // Convert to base64
    let base64Content: string;
    if (file instanceof Blob) {
      const arrayBuffer = await file.arrayBuffer();
      base64Content = Buffer.from(arrayBuffer).toString('base64');
    } else {
      base64Content = file.toString('base64');
    }

    // Store in Firestore
    const blobRef = doc(collection(db, DOCUMENT_BLOBS_COLLECTION), storagePath.replace(/\//g, '_'));
    await setDoc(blobRef, {
      content: base64Content,
      mimeType,
      fileName,
      userId,
      storagePath,
      size: fileSize,
      createdAt: Date.now(),
    });

    log.info('Uploaded to Firestore fallback', { fileName, fileSize });

    // Create a data URL for download (for small files)
    const downloadUrl = `data:${mimeType};base64,${base64Content}`;

    return {
      success: true,
      storageUrl: storagePath,
      downloadUrl,
      path: storagePath,
      mimeType,
      size: fileSize,
    };
  } catch (error) {
    log.error('Firestore fallback upload error', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Get document from Firestore fallback storage.
 */
async function getFromFirestoreFallback(storagePath: string): Promise<{
  content: Buffer;
  mimeType: string;
  size: number;
} | null> {
  try {
    const blobRef = doc(collection(db, DOCUMENT_BLOBS_COLLECTION), storagePath.replace(/\//g, '_'));
    const snapshot = await getDoc(blobRef);

    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    const content = Buffer.from(data.content, 'base64');

    return {
      content,
      mimeType: data.mimeType,
      size: data.size,
    };
  } catch (error) {
    log.error('Firestore fallback get error', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Delete document from Firestore fallback storage.
 */
async function deleteFromFirestoreFallback(storagePath: string): Promise<boolean> {
  const blobRef = doc(collection(db, DOCUMENT_BLOBS_COLLECTION), storagePath.replace(/\//g, '_'));
  const snapshot = await getDoc(blobRef);
  if (!snapshot.exists()) return false;
  await deleteDoc(blobRef);
  return true;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum file size in bytes (50MB).
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Allowed MIME types and their corresponding document types.
 */
export const ALLOWED_MIME_TYPES: Record<string, DocumentType> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' as DocumentType, // PPTX support
  'text/plain': 'text',
  'text/markdown': 'markdown',
};

/**
 * Storage path prefix for documents.
 */
const STORAGE_PREFIX = 'documents';

// ============================================================================
// TYPES
// ============================================================================

export interface UploadResult {
  success: true;
  storageUrl: string;
  downloadUrl: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface UploadError {
  success: false;
  error: string;
}

export type UploadResponse = UploadResult | UploadError;

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate a file before upload.
 *
 * @param size - File size in bytes
 * @param mimeType - File MIME type
 * @returns Validation result
 */
export function validateFile(
  size: number,
  mimeType: string
): { valid: true; documentType: DocumentType } | { valid: false; error: string } {
  // Check size
  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size exceeds maximum of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
    };
  }

  // Check MIME type
  const documentType = ALLOWED_MIME_TYPES[mimeType];
  if (!documentType) {
    return {
      valid: false,
      error: `Unsupported file type: ${mimeType}. Allowed types: PDF, DOCX, TXT, MD`,
    };
  }

  return { valid: true, documentType };
}

// ============================================================================
// UPLOAD OPERATIONS
// ============================================================================

/**
 * Generate a unique storage path for a document.
 *
 * @param fileName - Original file name
 * @param userId - Uploader's user ID
 * @returns Storage path
 */
function generateStoragePath(fileName: string, userId: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${STORAGE_PREFIX}/${userId}/${timestamp}-${randomSuffix}-${sanitizedName}`;
}

/**
 * Upload a document to Firebase Storage.
 * Falls back to Firestore-based storage if Firebase Storage isn't enabled.
 *
 * @param file - File buffer or Blob
 * @param fileName - Original file name
 * @param mimeType - File MIME type
 * @param userId - Uploader's user ID
 * @returns Upload result with URLs
 */
export async function uploadDocument(
  file: Buffer | Blob,
  fileName: string,
  mimeType: string,
  userId: string
): Promise<UploadResponse> {
  // Validate file
  const fileSize = file instanceof Blob ? file.size : file.byteLength;
  const validation = validateFile(fileSize, mimeType);

  if (!validation.valid) {
    return { success: false, error: (validation as { valid: false; error: string }).error };
  }

  // Generate storage path
  const storagePath = generateStoragePath(fileName, userId);

  // If Firestore fallback is enabled, use it directly
  if (useFirestoreFallback) {
    log.info('Using Firestore fallback storage');
    const result = await uploadToFirestoreFallback(file, fileName, mimeType, userId, storagePath);
    if (result) {
      return result;
    }
    return {
      success: false,
      error: 'File too large for Firestore fallback (max ~900KB). Enable Firebase Storage for larger files.',
    };
  }

  // Try Firebase Storage first
  try {
    const storageRef = ref(storage, storagePath);

    // Convert Buffer to Uint8Array if needed
    const fileData = file instanceof Buffer ? new Uint8Array(file) : file;

    // Upload file
    const snapshot = await uploadBytes(storageRef, fileData, {
      contentType: mimeType,
      customMetadata: {
        originalName: fileName,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
      },
    });

    // Get download URL
    const downloadUrl = await getDownloadURL(snapshot.ref);

    log.info('Uploaded to Firebase Storage', { fileName, storagePath });

    return {
      success: true,
      storageUrl: storagePath,
      downloadUrl,
      path: storagePath,
      mimeType,
      size: fileSize,
    };
  } catch (error) {
    log.error('Firebase Storage upload error', error instanceof Error ? error : new Error(String(error)));

    // Try Firestore fallback
    log.info('Attempting Firestore fallback...');
    const fallbackResult = await uploadToFirestoreFallback(file, fileName, mimeType, userId, storagePath);

    if (fallbackResult) {
      log.info('Firestore fallback successful');
      return fallbackResult;
    }

    // If fallback also fails, return appropriate error
    const errorMessage = error instanceof Error ? error.message : 'Unknown upload error';

    if (errorMessage.includes('storage/unknown') || errorMessage.includes('not set up')) {
      return {
        success: false,
        error: 'Firebase Storage is not enabled. For files over 900KB, enable Firebase Storage in the Firebase Console.',
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Get the download URL for a stored document.
 * Tries Firebase Storage first, then Firestore fallback.
 *
 * @param storagePath - Path in Firebase Storage
 * @returns Download URL or null if not found
 */
export async function getDocumentDownloadUrl(storagePath: string): Promise<string | null> {
  // Try Firebase Storage first
  try {
    const storageRef = ref(storage, storagePath);
    return await getDownloadURL(storageRef);
  } catch (error) {
    // Try Firestore fallback
    const fallback = await getFromFirestoreFallback(storagePath);
    if (fallback) {
      return `data:${fallback.mimeType};base64,${fallback.content.toString('base64')}`;
    }

    log.error('Error getting URL', error instanceof Error ? error : new Error(String(error)), { storagePath });
    return null;
  }
}

/**
 * Get metadata for a stored document.
 *
 * @param storagePath - Path in Firebase Storage
 * @returns File metadata or null if not found
 */
export async function getDocumentMetadata(
  storagePath: string
): Promise<{
  size: number;
  mimeType: string;
  uploadedAt?: string;
  originalName?: string;
} | null> {
  try {
    const storageRef = ref(storage, storagePath);
    const metadata = await getMetadata(storageRef);

    return {
      size: metadata.size,
      mimeType: metadata.contentType || 'application/octet-stream',
      uploadedAt: metadata.customMetadata?.uploadedAt,
      originalName: metadata.customMetadata?.originalName,
    };
  } catch (error) {
    log.error('Error getting metadata', error instanceof Error ? error : new Error(String(error)), { storagePath });
    return null;
  }
}

// ============================================================================
// DELETE OPERATIONS
// ============================================================================

/**
 * Delete a document from Firebase Storage or Firestore fallback.
 *
 * @param storagePath - Path in Firebase Storage
 * @returns Whether an object was deleted from Storage or the Firestore fallback
 */
export async function deleteStoredDocument(storagePath: string): Promise<boolean> {
  let storageDeleted = false;
  let firestoreDeleted = false;

  // Try deleting from Firebase Storage
  try {
    const storageRef = ref(storage, storagePath);
    await deleteObject(storageRef);
    storageDeleted = true;
    log.info('Deleted from Firebase Storage', { storagePath });
  } catch {
    // Storage might not be enabled or file might be in Firestore
  }

  // Also try deleting from Firestore fallback
  try {
    firestoreDeleted = await deleteFromFirestoreFallback(storagePath);
    if (firestoreDeleted) {
      log.info('Deleted from Firestore fallback', { storagePath });
    }
  } catch {
    // File might not exist in Firestore
  }

  if (!storageDeleted && !firestoreDeleted) {
    log.warn('Could not delete from any storage', { storagePath });
  }

  return storageDeleted || firestoreDeleted;
}

/**
 * Delete multiple documents from Firebase Storage.
 *
 * @param storagePaths - Array of paths in Firebase Storage
 * @returns Number of successfully deleted files
 */
export async function deleteStoredDocuments(storagePaths: string[]): Promise<number> {
  let deleted = 0;

  for (const path of storagePaths) {
    try {
      if (await deleteStoredDocument(path)) deleted++;
    } catch {
      // Continue with other deletions even if one fails
    }
  }

  return deleted;
}

/**
 * Get the raw content of a stored document.
 * Used for document processing (extraction, chunking).
 *
 * @param storagePath - Path in Firebase Storage or Firestore fallback
 * @returns Document content as Buffer, or null if not found
 */
export async function getDocumentContent(storagePath: string): Promise<{
  content: Buffer;
  mimeType: string;
} | null> {
  // First try Firestore fallback (faster check)
  const fallback = await getFromFirestoreFallback(storagePath);
  if (fallback) {
    return {
      content: fallback.content,
      mimeType: fallback.mimeType,
    };
  }

  // Try Firebase Storage
  try {
    const downloadUrl = await getDocumentDownloadUrl(storagePath);
    if (!downloadUrl) {
      return null;
    }

    // Fetch the file content
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return {
      content: Buffer.from(arrayBuffer),
      mimeType: contentType,
    };
  } catch (error) {
    log.error('Error getting content', error instanceof Error ? error : new Error(String(error)), { storagePath });
    return null;
  }
}
