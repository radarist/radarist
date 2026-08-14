/**
 * @file lib/document-storage-admin.ts
 * @description Admin-SDK twin of the document-storage READ function
 * (`getDocumentContent`) for SERVER-side callers — specifically the document
 * processing service's `downloadFromStorage` path, which runs in the Inngest
 * worker and `/api/documents/*` route handlers.
 *
 * Why this exists: `src/lib/document-storage-service.ts` is a CLIENT-SDK module
 * (it uses `firebase/storage` + `firebase/firestore` + `@/lib/firebase`). It is
 * fine in the browser and in `"use client"` components, but its read path
 * returns `code: 'unavailable'` (the production `a540` failure) in stateless
 * serverless / Inngest worker contexts — the same failure mode observed in
 * Inngest workers and that `document-admin.ts` /
 * `document-chunk-admin.ts` already solve via the narrow admin-helper pattern.
 *
 * This module reproduces `getDocumentContent` EXACTLY via the Admin SDK:
 * - `adminGetDocumentContent` ← getDocumentContent
 *
 * Plus `adminGetOwnedDocumentContent` (SEC-015), the owner-bound read the
 * browser-reachable download route uses. It has no client-SDK counterpart: the
 * authorization it enforces only exists server-side.
 *
 * Behaviour parity with the client `getDocumentContent`:
 *   1. Firestore fallback FIRST (`document_blobs` collection, base64 content) —
 *      mirrors the client `getFromFirestoreFallback` lookup, same doc-id key
 *      derivation (`storagePath.replace(/\//g, '_')`), same `{ content, mimeType }`
 *      return shape (`content` is a Buffer decoded from base64).
 *   2. Firebase Storage SECOND. The client fetches a download URL and reads the
 *      HTTP body + `content-type` header. The admin SDK reads the object bytes
 *      directly via `getStorage().bucket(name).file(path).download()` (returns a
 *      Buffer) and the content type via `file.getMetadata().contentType`,
 *      defaulting to `application/octet-stream` exactly like the client path.
 *   - Returns `null` when the object is found in neither store, identical to the
 *     client. Errors during the Storage read are logged and swallowed → `null`,
 *     matching the client `try/catch` semantics.
 *
 * Bucket name: the Admin app (`@/lib/firebase-admin`) initialises with only a
 * `projectId`, so it has no default bucket configured. We therefore pass the
 * bucket name EXPLICITLY to `.bucket(name)`, sourced from
 * `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` (the same value the client config uses —
 * e.g. `radarist-glyyr.firebasestorage.app`). Under the Storage emulator the
 * Admin SDK honours `FIREBASE_STORAGE_EMULATOR_HOST` (set by `firebase-admin.ts`)
 * and the named bucket resolves against the emulator.
 *
 * Scope: READ (`getDocumentContent`) and WRITE (`uploadDocument`,
 * `deleteStoredDocument`). The
 * `uploadDocument` twin (`adminUploadDocument`) exists because the Inngest worker
 * (`run-document-deep-research.ts`) calls the client `uploadDocument`, whose
 * `firebase/storage` + `firebase/firestore` writes hit the same `code:
 * 'unavailable'` (`a540`) failure in the stateless worker. The metadata /
 * download-URL paths of `document-storage-service.ts` are not server crash sites
 * in the processing pipeline, so they stay on their existing path.
 *
 * The pure validation helpers (`validateFile` / `ALLOWED_MIME_TYPES` /
 * `MAX_FILE_SIZE`) are SDK-agnostic and stay on the client module
 * (`document-storage-service.ts`); callers import them from there.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { db } from '@/lib/firebase-admin';
import { validateFile } from '@/lib/document-storage-service';
import type { UploadResponse } from '@/lib/document-storage-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('document-storage-admin');

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Firestore collection for storing document content when Storage isn't enabled.
 * Mirrors `DOCUMENT_BLOBS_COLLECTION` from `document-storage-service.ts`.
 */
const DOCUMENT_BLOBS_COLLECTION = 'document_blobs';

/**
 * Explicit Storage bucket name. The Admin app inits with only a projectId, so we
 * must name the bucket. Sourced from the same env var the client config reads.
 */
const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

/**
 * Storage path prefix for documents. Mirrors `STORAGE_PREFIX` from
 * `document-storage-service.ts` so admin-uploaded objects land at the same
 * `documents/<userId>/...` path the client path produces.
 */
const STORAGE_PREFIX = 'documents';

// ============================================================================
// FIRESTORE FALLBACK READ (admin-SDK mirror of getFromFirestoreFallback)
// ============================================================================

/**
 * Get document content from the Firestore fallback store. Admin-SDK mirror of
 * `getFromFirestoreFallback` from `document-storage-service.ts`: same doc-id key
 * derivation, same base64 → Buffer decode, returns `null` when the blob doc does
 * not exist or on error.
 */
async function adminGetFromFirestoreFallback(storagePath: string): Promise<{
  content: Buffer;
  mimeType: string;
  size: number;
  /** Recorded uploader (`uploadToFirestoreFallback` writes it), or `null`. */
  recordedOwnerId: string | null;
  /** Recorded path, so a slash-to-underscore id collision cannot pass as a hit. */
  recordedStoragePath: string | null;
} | null> {
  try {
    const docId = storagePath.replace(/\//g, '_');
    const snapshot = await db.collection(DOCUMENT_BLOBS_COLLECTION).doc(docId).get();

    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data()!;
    const content = Buffer.from(data.content, 'base64');

    return {
      content,
      mimeType: data.mimeType,
      size: data.size,
      recordedOwnerId: typeof data.userId === 'string' && data.userId.trim().length > 0 ? data.userId.trim() : null,
      recordedStoragePath: typeof data.storagePath === 'string' ? data.storagePath : null,
    };
  } catch (error) {
    log.error('Firestore fallback get error', error instanceof Error ? error : new Error(String(error)), {
      storagePath,
    });
    return null;
  }
}

// ============================================================================
// CONTENT READ (admin-SDK mirror of getDocumentContent)
// ============================================================================

/**
 * Get the raw content of a stored document. Admin-SDK mirror of
 * `getDocumentContent` from `document-storage-service.ts`. Used by the
 * server-side document processing pipeline (extraction, chunking).
 *
 * Tries the Firestore fallback first (faster check), then Firebase Storage via
 * the Admin SDK. Returns the document content as a Buffer plus its MIME type, or
 * `null` if not found in either store.
 *
 * @param storagePath - Path in Firebase Storage or Firestore fallback
 * @returns `{ content, mimeType }` or `null` if not found
 */
export async function adminGetDocumentContent(storagePath: string): Promise<{
  content: Buffer;
  mimeType: string;
} | null> {
  // First try Firestore fallback (faster check) — mirrors the client.
  const fallback = await adminGetFromFirestoreFallback(storagePath);
  if (fallback) {
    return {
      content: fallback.content,
      mimeType: fallback.mimeType,
    };
  }

  // Try Firebase Storage via the Admin SDK.
  try {
    if (!STORAGE_BUCKET) {
      log.error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set; cannot read from Storage', undefined, {
        storagePath,
      });
      return null;
    }

    const file = getStorage().bucket(STORAGE_BUCKET).file(storagePath);

    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }

    // Read the object bytes (Buffer) and its content type.
    const [content] = await file.download();
    const [metadata] = await file.getMetadata();
    const mimeType = metadata.contentType || 'application/octet-stream';

    return {
      content,
      mimeType,
    };
  } catch (error) {
    log.error('Error getting content', error instanceof Error ? error : new Error(String(error)), { storagePath });
    return null;
  }
}

/**
 * Read stored content on behalf of a document owner who has ALREADY been
 * authorized against `Document.uploadedBy` — SEC-015 defence in depth.
 *
 * `adminGetDocumentContent` resolves whatever path it is handed, which makes it
 * a confused deputy for a browser-reachable route: `storageUrl` is mutable
 * Firestore data (the emulator rules allow a browser to CREATE a document), so a
 * record the caller legitimately owns can name another user's object. This twin
 * refuses when the stored content records an owner that CONTRADICTS the
 * document owner, using the same identity fields `adminDeleteStoredDocument`
 * already requires.
 *
 * Deliberately narrower than the delete gate in two ways, so no legitimate
 * owner download breaks:
 *
 * - It does NOT require the `documents/<uid>/<object>` path shape. The seeded
 *   showcase corpus stores content under a fixed `documents/demo/...` path, so
 *   path-shape ownership would refuse the demo operator their own files.
 * - Content that records NO owner at all is served, exactly as before. A
 *   contradiction is evidence; silence is not, and inventing a refusal here
 *   would strand legacy objects that predate uploader metadata.
 *
 * @param storagePath - The owning document's `storageUrl`
 * @param ownerId - The document's authoritative owner (already == caller uid)
 * @returns `{ content, mimeType }`, or `null` when absent or contradicted
 */
export async function adminGetOwnedDocumentContent(
  storagePath: string,
  ownerId: string
): Promise<{
  content: Buffer;
  mimeType: string;
} | null> {
  // An empty path is a document with no stored bytes (build-mission verdicts,
  // freshly created URL/deep-research records). Returning early keeps it a
  // clean "no content" instead of a thrown-and-swallowed Firestore id error.
  if (!storagePath || !ownerId) return null;

  const fallback = await adminGetFromFirestoreFallback(storagePath);
  if (fallback) {
    if (fallback.recordedOwnerId !== null && fallback.recordedOwnerId !== ownerId) {
      log.warn('Refused stored content whose fallback owner contradicts the document owner');
      return null;
    }
    if (fallback.recordedStoragePath !== null && fallback.recordedStoragePath !== storagePath) {
      log.warn('Refused stored content whose fallback path does not match the requested object');
      return null;
    }
    return { content: fallback.content, mimeType: fallback.mimeType };
  }

  try {
    if (!STORAGE_BUCKET) {
      log.error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set; cannot read from Storage');
      return null;
    }

    const file = getStorage().bucket(STORAGE_BUCKET).file(storagePath);

    const [exists] = await file.exists();
    if (!exists) return null;

    // Metadata BEFORE bytes: the uploader check must be able to refuse without
    // this process ever holding the object's contents.
    const [metadata] = await file.getMetadata();
    const recordedOwner = metadata.metadata?.uploadedBy;
    if (typeof recordedOwner === 'string' && recordedOwner.trim().length > 0 && recordedOwner.trim() !== ownerId) {
      log.warn('Refused stored content whose Storage uploader contradicts the document owner');
      return null;
    }

    const [content] = await file.download();
    return { content, mimeType: metadata.contentType || 'application/octet-stream' };
  } catch (error) {
    log.error('Error getting owned content', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

// ============================================================================
// DELETE (owner-bound server contract)
// ============================================================================

export interface AdminStoredDocumentDeleteResult {
  storage: 'deleted' | 'absent' | 'unconfigured';
  firestoreFallback: 'deleted' | 'absent';
}

/**
 * A persisted `storageUrl` is data, not authority. Resolve only the exact
 * object shape produced by both upload paths before touching either backend.
 */
export function isOwnedDocumentStoragePath(storagePath: string, ownerId: string): boolean {
  if (!ownerId || ownerId !== ownerId.trim() || ownerId.includes('/')) return false;
  const parts = storagePath.split('/');
  const objectName = parts[2] ?? '';
  return (
    parts.length === 3 &&
    parts[0] === STORAGE_PREFIX &&
    parts[1] === ownerId &&
    objectName.length > 0 &&
    objectName !== '.' &&
    objectName !== '..'
  );
}

/**
 * Delete an exact owner-scoped document object from both storage backends.
 *
 * This is deliberately fail-closed rather than browser-service parity:
 * `storageUrl` is mutable Firestore data, so trusting it would turn the Admin
 * SDK into a confused deputy. The path, Storage custom metadata, fallback
 * identity, and fallback owner must all agree with the authoritative document
 * owner. Storage deletion is generation-preconditioned so an object replaced
 * after metadata inspection survives and the parent document remains retryable.
 *
 * Missing objects are idempotent. A configured Storage backend that reports the
 * object absent plus an absent fallback is proof that cleanup already converged.
 * Without a configured bucket, an absent fallback is not enough evidence to
 * discard a parent that claims a stored object, so deletion fails loudly.
 */
export async function adminDeleteStoredDocument(
  storagePath: string,
  expectedOwnerId: string
): Promise<AdminStoredDocumentDeleteResult> {
  if (!isOwnedDocumentStoragePath(storagePath, expectedOwnerId)) {
    throw new Error('Document storage identity does not match its owner');
  }

  const bucket = STORAGE_BUCKET ? getStorage().bucket(STORAGE_BUCKET) : null;
  let inspectedGeneration: string | number | null = null;

  // Inspect and authorize Storage before mutating either backend. This avoids
  // deleting an owned fallback only to discover that storageUrl targeted an
  // object whose uploader metadata belongs to somebody else.
  if (bucket) {
    const inspectedFile = bucket.file(storagePath);
    const [exists] = await inspectedFile.exists();
    if (exists) {
      const [metadata] = await inspectedFile.getMetadata();
      if (metadata.metadata?.uploadedBy !== expectedOwnerId) {
        throw new Error('Document Storage metadata does not match its owner');
      }
      if (metadata.generation === undefined || metadata.generation === null || metadata.generation === '') {
        throw new Error('Document Storage generation metadata is missing');
      }
      inspectedGeneration = metadata.generation;
    }
  }

  const fallbackRef = db.collection(DOCUMENT_BLOBS_COLLECTION).doc(storagePath.replace(/\//g, '_'));

  // Verify and remove the fallback atomically. The stored path check also
  // defeats collisions in the legacy slash-to-underscore document id.
  const fallbackState = await db.runTransaction<AdminStoredDocumentDeleteResult['firestoreFallback']>(async (transaction) => {
    const snapshot = await transaction.get(fallbackRef);
    if (!snapshot.exists) return 'absent';
    const data = snapshot.data() as Record<string, unknown>;
    if (data.storagePath !== storagePath || data.userId !== expectedOwnerId) {
      throw new Error('Document fallback storage identity does not match its owner');
    }
    transaction.delete(fallbackRef);
    return 'deleted';
  });

  if (!bucket) {
    if (fallbackState === 'absent') {
      throw new Error('Document storage cleanup cannot be verified without a configured bucket');
    }
    log.info('Deleted from Firestore fallback', { storagePath });
    return { storage: 'unconfigured', firestoreFallback: fallbackState };
  }

  if (inspectedGeneration === null) {
    if (fallbackState === 'deleted') log.info('Deleted from Firestore fallback', { storagePath });
    return { storage: 'absent', firestoreFallback: fallbackState };
  }

  // Bind deletion to the exact object generation inspected above. If another
  // writer replaces it, GCS rejects the delete and the parent remains.
  const exactFile = bucket.file(storagePath, {
    preconditionOpts: { ifGenerationMatch: inspectedGeneration },
  });
  await exactFile.delete({ ignoreNotFound: true });
  log.info('Deleted from Firebase Storage', { storagePath });
  if (fallbackState === 'deleted') log.info('Deleted from Firestore fallback', { storagePath });
  return { storage: 'deleted', firestoreFallback: fallbackState };
}

// ============================================================================
// UPLOAD (admin-SDK mirror of uploadDocument)
// ============================================================================

/**
 * Generate a unique storage path for a document. Admin-SDK mirror of
 * `generateStoragePath` from `document-storage-service.ts`: same prefix,
 * same `<timestamp>-<random>-<sanitizedName>` shape, same sanitization regex.
 */
function generateStoragePath(fileName: string, userId: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${STORAGE_PREFIX}/${userId}/${timestamp}-${randomSuffix}-${sanitizedName}`;
}

/**
 * Build a Firebase-style media download URL for an object, matching the URL
 * shape the client `getDownloadURL` produces (`.../o/<encodedPath>?alt=media&token=…`).
 *
 * We can't call `getDownloadURL` server-side, and `getSignedUrl` requires a
 * signing key the Admin app doesn't have in emulator / project-id-only ADC mode.
 * Instead the upload writes a `firebaseStorageDownloadTokens` metadata value (the
 * same mechanism `getDownloadURL` reads) and we assemble the public media URL
 * around it. Honors `FIREBASE_STORAGE_EMULATOR_HOST` so the URL resolves against
 * the Storage emulator in dev.
 */
function buildDownloadUrl(bucket: string, storagePath: string, token: string): string {
  const encodedPath = encodeURIComponent(storagePath);
  const query = `alt=media&token=${token}`;
  const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;

  if (emulatorHost) {
    // Emulator serves the same REST path over plain HTTP at the configured host.
    return `http://${emulatorHost}/v0/b/${bucket}/o/${encodedPath}?${query}`;
  }

  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?${query}`;
}

/**
 * Upload a document to Firebase Storage. Admin-SDK twin of `uploadDocument` from
 * `document-storage-service.ts`, for SERVER-side callers (the Inngest worker
 * `run-document-deep-research.ts`) whose client-SDK `firebase/storage` writes hit
 * the `code: 'unavailable'` (`a540`) failure in stateless contexts.
 *
 * Behaviour parity with the client `uploadDocument`:
 *   1. Validates via the shared `validateFile` helper; returns
 *      `{ success: false, error }` on failure — identical shape.
 *   2. Generates the same `documents/<userId>/<timestamp>-<rand>-<name>` path.
 *   3. Writes the bytes via the Admin SDK `getStorage().bucket(BUCKET).file(path).save(...)`
 *      with the same `contentType` and the same `originalName` / `uploadedBy` /
 *      `uploadedAt` custom metadata the client attaches.
 *   4. Returns the same `{ success: true, storageUrl, downloadUrl, path, mimeType, size }`
 *      shape. `storageUrl` and `path` are the storage path (matching the client);
 *      `downloadUrl` is the Firebase media URL built from the upload token.
 *
 * Differences from the client (by design — admin runs server-side only):
 *   - No Firestore base64 fallback. The fallback exists for browser callers when
 *     Firebase Storage isn't enabled; the server pipeline targets real Storage
 *     (and the emulator honors the named bucket). On any Storage write error we
 *     return `{ success: false, error }`, the same failure shape the client emits.
 *
 * @param file - File buffer or Blob
 * @param fileName - Original file name
 * @param mimeType - File MIME type
 * @param userId - Uploader's user ID
 * @returns Upload result with URLs, or `{ success: false, error }`
 */
export async function adminUploadDocument(
  file: Buffer | Blob,
  fileName: string,
  mimeType: string,
  userId: string
): Promise<UploadResponse> {
  // Validate file — shared helper, same return shape as the client path.
  const fileSize = file instanceof Blob ? file.size : file.byteLength;
  const validation = validateFile(fileSize, mimeType);

  if (!validation.valid) {
    return { success: false, error: (validation as { valid: false; error: string }).error };
  }

  if (!STORAGE_BUCKET) {
    log.error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set; cannot write to Storage', undefined, {
      fileName,
    });
    return {
      success: false,
      error: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured; cannot upload to Firebase Storage.',
    };
  }

  // Generate storage path — same shape as the client.
  const storagePath = generateStoragePath(fileName, userId);

  try {
    // Normalize a Blob to a Buffer for the Admin SDK `save` (it accepts Buffer).
    const buffer = file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : file;

    // Download token mirrors what `getDownloadURL` reads, so the returned
    // `downloadUrl` resolves the same way the client URL does.
    const downloadToken = randomUUID();

    const storageFile = getStorage().bucket(STORAGE_BUCKET).file(storagePath);

    await storageFile.save(buffer, {
      contentType: mimeType,
      metadata: {
        contentType: mimeType,
        metadata: {
          originalName: fileName,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });

    const downloadUrl = buildDownloadUrl(STORAGE_BUCKET, storagePath, downloadToken);

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
    log.error('Firebase Storage upload error', error instanceof Error ? error : new Error(String(error)), {
      fileName,
      storagePath,
    });

    const errorMessage = error instanceof Error ? error.message : 'Unknown upload error';
    return {
      success: false,
      error: errorMessage,
    };
  }
}
