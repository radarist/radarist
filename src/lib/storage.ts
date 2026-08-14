/**
 * @file lib/storage.ts
 * @description Firebase Storage image upload utility.
 *
 * Used by Nano Banana image generation (infographics in reports)
 * and user-generated visualizations. Supports configurable path
 * prefixes (infographics/, visualizations/) and custom filenames.
 *
 * Server-only module — do NOT import in 'use client' components.
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import { adminApp } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { MAX_RASTER_IMAGE_BYTES } from '@/lib/raster-image';

const log = createLogger('storage');
const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const IMAGE_PATH_PREFIXES = new Set(['infographics', 'visualizations']);
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

/**
 * Upload an image to Firebase Storage and return its public URL.
 *
 * @param data - Image bytes as Buffer
 * @param userId - User ID for path scoping
 * @param contentType - MIME type (image/png or image/jpeg)
 * @param pathPrefix - Storage path prefix (e.g., 'infographics', 'visualizations')
 * @param filename - Optional custom filename. If omitted, generates {timestamp}-{random}.{ext}
 * @returns Public download URL
 */
export async function uploadImage(
  data: Buffer,
  userId: string,
  contentType: string,
  pathPrefix: string,
  filename?: string
): Promise<string> {
  if (!STORAGE_BUCKET) {
    throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured; cannot upload an image.');
  }
  if (!IMAGE_PATH_PREFIXES.has(pathPrefix)) {
    throw new Error(`Unsupported image storage prefix: ${pathPrefix}`);
  }
  if (!IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported image content type: ${contentType}`);
  }

  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/svg+xml' ? 'svg' : 'png';
  const name = filename ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `${pathPrefix}/${userId}/${name}`;
  const storageFile = getStorage(adminApp).bucket(STORAGE_BUCKET).file(path);

  log.info('[storage] Uploading image', {
    path,
    contentType,
    size: data.length,
  });

  await storageFile.save(data, {
    contentType,
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: randomUUID(),
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        originalName: name,
      },
    },
  });
  const url = await getDownloadURL(storageFile);

  log.info('[storage] Upload complete', { path, url });
  return url;
}

/** Delete one exact server-owned image object. Missing objects are idempotent. */
export async function deleteStoredImage(path: string): Promise<void> {
  if (!STORAGE_BUCKET) {
    throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured; cannot delete an image.');
  }

  const prefix = path.split('/', 1)[0];
  if (!IMAGE_PATH_PREFIXES.has(prefix)) {
    throw new Error(`Unsupported image storage path: ${path}`);
  }

  await getStorage(adminApp).bucket(STORAGE_BUCKET).file(path).delete({ ignoreNotFound: true });
  log.info('[storage] Image deleted', { path });
}

export interface StoredVisualizationImage {
  content: Buffer;
  mimeType: string;
  uploadedBy?: string;
}

export const MAX_VISUALIZATION_EXPORT_BYTES = MAX_RASTER_IMAGE_BYTES;

export interface StoredVisualizationReadPolicy {
  ownerId: string;
  expectedMimeType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
  /** Compatibility for owner-scoped objects created before uploader metadata. */
  allowMissingOwnerMetadata?: boolean;
}

function metadataSizeInBytes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Read one exact visualization object through the Admin SDK. */
export async function downloadStoredVisualization(
  path: string,
  policy: StoredVisualizationReadPolicy
): Promise<StoredVisualizationImage | null> {
  if (!STORAGE_BUCKET) {
    throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured; cannot download an image.');
  }

  const parts = path.split('/');
  if (
    parts.length !== 3 ||
    parts[0] !== 'visualizations' ||
    parts[1] !== policy.ownerId ||
    !parts[2]
  ) {
    throw new Error(`Unsupported visualization storage path: ${path}`);
  }

  const storageFile = getStorage(adminApp).bucket(STORAGE_BUCKET).file(path);
  const [exists] = await storageFile.exists();
  if (!exists) return null;

  // Inspect cheap metadata before buffering the object. This bounds memory and
  // rejects ownership/type drift before any body bytes leave Storage.
  const [metadata] = await storageFile.getMetadata();
  const declaredSize = metadataSizeInBytes(metadata.size);
  if (declaredSize === null || declaredSize === 0 || declaredSize > MAX_VISUALIZATION_EXPORT_BYTES) {
    throw new Error('Stored visualization size is missing or outside the export limit.');
  }

  const uploadedBy = metadata.metadata?.uploadedBy;
  if (
    (uploadedBy === undefined && !policy.allowMissingOwnerMetadata) ||
    (uploadedBy !== undefined && uploadedBy !== policy.ownerId)
  ) {
    throw new Error('Stored visualization owner metadata does not match the requested owner.');
  }

  const mimeType = metadata.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType !== policy.expectedMimeType) {
    throw new Error('Stored visualization MIME metadata does not match the requested media type.');
  }

  const contentEncoding = metadata.contentEncoding?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new Error('Stored visualization content encoding is not supported for export.');
  }

  // end is inclusive: request at most limit + 1 bytes so a metadata/body race
  // still cannot make this process buffer an unbounded object. Explicitly
  // disable transparent decompression so the metadata/body size check compares
  // the same stored representation.
  const [content] = await storageFile.download({
    start: 0,
    end: MAX_VISUALIZATION_EXPORT_BYTES,
    decompress: false,
  });
  if (content.byteLength > MAX_VISUALIZATION_EXPORT_BYTES || content.byteLength !== declaredSize) {
    throw new Error('Stored visualization body size does not match its bounded metadata.');
  }

  return {
    content,
    mimeType,
    uploadedBy: typeof uploadedBy === 'string' ? uploadedBy : undefined,
  };
}
