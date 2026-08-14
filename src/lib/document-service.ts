/**
 * @file lib/document-service.ts
 * @description Service for managing documents in the Evidence Layer.
 * Provides CRUD operations for uploaded documents that serve as evidence sources.
 *
 * Documents are stored in Firestore with their files in Firebase Storage.
 * Chunks are extracted for semantic search (see document-chunk-service.ts).
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit as limitQuery,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { fuzzySearch } from '@/lib/fuzzy-search';
import type {
  Document,
  DocumentStatus,
  DocumentType,
  DocumentVisibility,
  GraphSyncStatus,
  CreateDocumentInput,
} from '@/lib/types';
import { normalizeUrl, extractDomain } from './utils/url-normalize';
import { mapWithBoundedConcurrency } from './bounded-concurrency';
import { fetchWithAuth } from './fetch-with-auth';
import { createLogger } from '@/lib/logger';
const log = createLogger('document-service');

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'documents';
const DOCUMENT_DELETE_CONCURRENCY = 8;

async function requestDocumentDelete(id: string): Promise<boolean> {
  const response = await fetchWithAuth(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Document deletion failed (${response.status})`);
  }
  return true;
}

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filter options for querying documents.
 */
export interface DocumentFilters {
  /** Filter by document type (pdf, docx, url, etc.) */
  type?: DocumentType;
  /** Filter by processing status */
  status?: DocumentStatus;
  /** Search in title and description */
  search?: string;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by uploader user ID */
  uploadedBy?: string;
  /** Maximum results to return */
  limit?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert Firestore document to Document type.
 */
function firestoreToDocument(docSnap: import('firebase/firestore').DocumentSnapshot): Document | null {
  if (!docSnap.exists()) return null;

  const data = docSnap.data();
  return {
    id: docSnap.id,
    title: data.title,
    type: data.type,
    storageUrl: data.storageUrl,
    originalUrl: data.originalUrl,
    status: data.status,
    processedAt: data.processedAt?.toMillis?.() ?? data.processedAt,
    chunkCount: data.chunkCount,
    errorMessage: data.errorMessage,
    description: data.description,
    tags: data.tags || [],
    fileSize: data.fileSize,
    mimeType: data.mimeType,
    pageCount: data.pageCount,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
    uploadedBy: data.uploadedBy,
    // Knowledge Tab Sprint fields
    workspaceId: data.workspaceId,
    domain: data.domain,
    normalizedUrl: data.normalizedUrl,
    lastFetchedAt: data.lastFetchedAt?.toMillis?.() ?? data.lastFetchedAt,
    fetchError: data.fetchError,
    version: data.version,
    contentHash: data.contentHash,
    refreshInProgress: data.refreshInProgress,
    processingRequestedAt: data.processingRequestedAt?.toMillis?.() ?? data.processingRequestedAt,
    visibility: data.visibility,
    aiSummary: data.aiSummary,
    aiTags: data.aiTags,
    linkedEntityCount: data.linkedEntityCount,
    graphSyncStatus: data.graphSyncStatus,
    lastSyncedAt: data.lastSyncedAt?.toMillis?.() ?? data.lastSyncedAt,
    // Content review (GRAPH-064) — written by document-admin; must round-trip
    // here or the UI cannot tell a reviewed source from an unreviewed draft.
    contentReviewedAt: data.contentReviewedAt?.toMillis?.() ?? data.contentReviewedAt,
    contentReviewedBy: data.contentReviewedBy,
    // Build-mission provenance (written by document-admin; must round-trip here
    // or the sheet's metrics table / source-run links render empty)
    sourceRunId: data.sourceRunId,
    sourceMissionId: data.sourceMissionId,
    structuredMetrics: data.structuredMetrics,
    // PRODUCT-003 — provider-backed deep-research plan/progress, written by the
    // research job. This mapper is an explicit whitelist, so a field absent
    // here is written and then permanently invisible: the sheet's progress
    // panel would render nothing no matter what the job recorded.
    deepResearchInteractionId: data.deepResearchInteractionId,
    deepResearchProgress: data.deepResearchProgress,
  };
}

/**
 * Convert Document to Firestore format for writing.
 */
function documentToFirestore(document: Partial<Document>): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (document.title !== undefined) data.title = document.title;
  if (document.type !== undefined) data.type = document.type;
  if (document.storageUrl !== undefined) data.storageUrl = document.storageUrl;
  if (document.originalUrl !== undefined) data.originalUrl = document.originalUrl;
  if (document.status !== undefined) data.status = document.status;
  if (document.processedAt !== undefined) {
    data.processedAt = Timestamp.fromMillis(document.processedAt);
  }
  if (document.chunkCount !== undefined) data.chunkCount = document.chunkCount;
  if (document.errorMessage !== undefined) data.errorMessage = document.errorMessage;
  if (document.description !== undefined) data.description = document.description;
  if (document.tags !== undefined) data.tags = document.tags;
  if (document.fileSize !== undefined) data.fileSize = document.fileSize;
  if (document.mimeType !== undefined) data.mimeType = document.mimeType;
  if (document.pageCount !== undefined) data.pageCount = document.pageCount;
  if (document.uploadedBy !== undefined) data.uploadedBy = document.uploadedBy;

  // Knowledge Tab Sprint fields
  if (document.workspaceId !== undefined) data.workspaceId = document.workspaceId;
  if (document.domain !== undefined) data.domain = document.domain;
  if (document.normalizedUrl !== undefined) data.normalizedUrl = document.normalizedUrl;
  if (document.lastFetchedAt !== undefined) {
    data.lastFetchedAt = Timestamp.fromMillis(document.lastFetchedAt);
  }
  if (document.fetchError !== undefined) data.fetchError = document.fetchError;
  if (document.version !== undefined) data.version = document.version;
  if (document.contentHash !== undefined) data.contentHash = document.contentHash;
  if (document.refreshInProgress !== undefined) data.refreshInProgress = document.refreshInProgress;
  if (document.processingRequestedAt !== undefined) {
    data.processingRequestedAt = Timestamp.fromMillis(document.processingRequestedAt);
  }
  if (document.visibility !== undefined) data.visibility = document.visibility;
  if (document.aiSummary !== undefined) data.aiSummary = document.aiSummary;
  if (document.aiTags !== undefined) data.aiTags = document.aiTags;
  if (document.linkedEntityCount !== undefined) data.linkedEntityCount = document.linkedEntityCount;
  if (document.graphSyncStatus !== undefined) data.graphSyncStatus = document.graphSyncStatus;
  if (document.lastSyncedAt !== undefined) {
    data.lastSyncedAt = Timestamp.fromMillis(document.lastSyncedAt);
  }

  return data;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all documents with optional filters.
 *
 * @param filters - Optional filters to apply
 * @returns Array of documents matching filters
 *
 * @example
 * ```typescript
 * // Get all PDF documents
 * const pdfs = await getDocuments({ type: 'pdf' });
 *
 * // Get processed documents with search
 * const docs = await getDocuments({
 *   status: 'processed',
 *   search: 'react',
 *   limit: 20
 * });
 * ```
 */
export async function getDocuments(filters?: DocumentFilters): Promise<Document[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    let q = query(collectionRef, orderBy('createdAt', 'desc'));

    // Apply Firestore filters (limited to one inequality per query)
    if (filters?.type) {
      q = query(q, where('type', '==', filters.type));
    } else if (filters?.status) {
      q = query(q, where('status', '==', filters.status));
    } else if (filters?.uploadedBy) {
      q = query(q, where('uploadedBy', '==', filters.uploadedBy));
    }

    if (filters?.limit) {
      q = query(q, limitQuery(filters.limit));
    }

    const snapshot = await getDocs(q);
    let documents = snapshot.docs.map(firestoreToDocument).filter((d): d is Document => d !== null);

    // Apply client-side filters for complex queries
    if (filters?.search) {
      // Use fuzzy search for better matching (supports partial matches, hyphenated terms)
      documents = fuzzySearch(documents, filters.search, {
        keys: ['title', 'description'] as (keyof Document)[],
        threshold: 0.2,
      });
    }

    if (filters?.tags && filters.tags.length > 0) {
      documents = documents.filter((d) => filters.tags!.some((tag) => d.tags?.includes(tag)));
    }

    // Re-apply status filter if type was the primary filter
    if (filters?.type && filters?.status) {
      documents = documents.filter((d) => d.status === filters.status);
    }

    return documents;
  } catch (error) {
    log.error('Error getting documents', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Get a document by ID.
 *
 * @param id - Document ID
 * @returns Document or null if not found
 */
export async function getDocumentById(id: string): Promise<Document | null> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);
    return firestoreToDocument(docSnap);
  } catch (error) {
    log.error('Error getting document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get documents by status.
 *
 * @param status - Document status to filter by
 * @param limit - Maximum results
 * @returns Array of documents with the specified status
 */
export async function getDocumentsByStatus(status: DocumentStatus, limit?: number): Promise<Document[]> {
  return getDocuments({ status, limit });
}

/**
 * Get documents pending processing.
 * Useful for the processing queue.
 *
 * @param limit - Maximum results
 * @returns Array of documents with 'uploaded' status
 */
export async function getPendingDocuments(limit = 50): Promise<Document[]> {
  return getDocuments({ status: 'uploaded', limit });
}

/**
 * Get failed documents for retry.
 *
 * @param limit - Maximum results
 * @returns Array of documents with 'failed' status
 */
export async function getFailedDocuments(limit = 50): Promise<Document[]> {
  return getDocuments({ status: 'failed', limit });
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create a new document record.
 * Note: This creates the Firestore record. File upload to Storage is separate.
 *
 * @param input - Document data
 * @returns Created document with generated ID
 *
 * @example
 * ```typescript
 * const doc = await createDocument({
 *   title: 'React Performance Guide',
 *   type: 'pdf',
 *   storageUrl: '/documents/react-perf.pdf',
 *   uploadedBy: 'user-123',
 * });
 * ```
 */
export async function createDocument(input: CreateDocumentInput): Promise<Document> {
  try {
    const now = Timestamp.now();
    const docData = {
      ...documentToFirestore(input),
      status: 'uploaded' as DocumentStatus,
      createdAt: now,
      updatedAt: now,
    };

    const collectionRef = collection(db, COLLECTION_NAME);
    const docRef = await addDoc(collectionRef, docData);

    const created = await getDocumentById(docRef.id);
    if (!created) {
      throw new Error('Failed to retrieve created document');
    }

    log.info('Created document', { id: created.id, title: created.title });
    return created;
  } catch (error) {
    log.error('Error creating document', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Update a document.
 *
 * @param id - Document ID
 * @param updates - Fields to update
 */
export async function updateDocument(id: string, updates: Partial<Omit<Document, 'id' | 'createdAt'>>): Promise<void> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const updateData = {
      ...documentToFirestore(updates),
      updatedAt: Timestamp.now(),
    };

    await updateDoc(docRef, updateData);
    log.info('Updated document', { id });
  } catch (error) {
    log.error('Error updating document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Mark a document as processing.
 *
 * @param id - Document ID
 */
export async function markDocumentProcessing(id: string): Promise<void> {
  await updateDocument(id, { status: 'processing' });
}

/**
 * Mark a document as processed with chunk count.
 *
 * @param id - Document ID
 * @param chunkCount - Number of chunks extracted
 * @param pageCount - Optional page count (for PDFs)
 */
export async function markDocumentProcessed(id: string, chunkCount: number, pageCount?: number): Promise<void> {
  await updateDocument(id, {
    status: 'processed',
    chunkCount,
    pageCount,
    processedAt: Date.now(),
    errorMessage: undefined, // Clear any previous error
  });
}

/**
 * Mark a document as failed with error message.
 *
 * @param id - Document ID
 * @param errorMessage - Error description
 */
export async function markDocumentFailed(id: string, errorMessage: string): Promise<void> {
  await updateDocument(id, {
    status: 'failed',
    errorMessage,
  });
}

/**
 * Delete a document and all associated resources.
 * Cleans up: relations, entity-document links, chunks, storage file, and document record.
 *
 * @param id - Document ID
 */
export async function deleteDocument(id: string): Promise<void> {
  try {
    const deleted = await requestDocumentDelete(id);
    if (!deleted) {
      log.warn('Document not found for deletion', { id });
      return;
    }
    log.info('Deleted document', { id });
  } catch (error) {
    log.error('Error deleting document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Delete multiple documents and their associated resources.
 * Cleans up: relations, entity-document links, chunks, storage files, and document records.
 *
 * @param ids - Array of document IDs to delete
 */
export async function deleteDocuments(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  try {
    // Each server call owns the complete, ordered cascade and graph handoff.
    await mapWithBoundedConcurrency(ids, DOCUMENT_DELETE_CONCURRENCY, requestDocumentDelete);
    log.info('Deleted documents', { count: ids.length });
  } catch (error) {
    log.error('Error bulk deleting documents', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// SEARCH OPERATIONS
// ============================================================================

/**
 * Search documents by title and description.
 * Simple text search (not semantic - for semantic search, use chunks).
 *
 * @param searchQuery - Search string
 * @param limit - Maximum results
 * @returns Array of matching documents
 */
export async function searchDocuments(searchQuery: string, limit = 20): Promise<Document[]> {
  return getDocuments({ search: searchQuery, status: 'processed', limit });
}

/**
 * Get documents by tag.
 *
 * @param tag - Tag to search for
 * @param limit - Maximum results
 * @returns Array of documents with the tag
 */
export async function getDocumentsByTag(tag: string, limit = 50): Promise<Document[]> {
  return getDocuments({ tags: [tag], limit });
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get document statistics.
 *
 * @returns Document counts by status and type
 */
export async function getDocumentStats(): Promise<{
  total: number;
  byStatus: Record<DocumentStatus, number>;
  byType: Record<DocumentType, number>;
  totalChunks: number;
}> {
  try {
    const documents = await getDocuments();

    const byStatus: Record<DocumentStatus, number> = {
      uploaded: 0,
      processing: 0,
      processed: 0,
      failed: 0,
      blocked: 0,
    };

    const byType: Record<DocumentType, number> = {
      pdf: 0,
      docx: 0,
      pptx: 0,
      url: 0,
      transcript: 0,
      markdown: 0,
      text: 0,
      'deep-research': 0,
    };

    let totalChunks = 0;

    for (const doc of documents) {
      byStatus[doc.status]++;
      byType[doc.type]++;
      totalChunks += doc.chunkCount || 0;
    }

    return {
      total: documents.length,
      byStatus,
      byType,
      totalChunks,
    };
  } catch (error) {
    log.error('Error getting document stats', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a document exists by URL.
 * Useful for preventing duplicate imports.
 *
 * @param originalUrl - URL to check
 * @returns Document if exists, null otherwise
 */
export async function getDocumentByUrl(originalUrl: string): Promise<Document | null> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('originalUrl', '==', originalUrl), limitQuery(1));
    const snapshot = await getDocs(q);

    if (snapshot.empty) return null;
    return firestoreToDocument(snapshot.docs[0]);
  } catch (error) {
    log.error('Error checking document by URL', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Result of an accepted reprocessing request.
 */
export interface DocumentRetryAcceptance {
  documentId: string;
  /** Inngest event ids the queue acknowledged — proof the work was scheduled. */
  eventIds: string[];
}

/**
 * Request (re)processing for a document through the ONE authenticated enqueue.
 *
 * UX-036: this used to be a direct client-SDK write of `status: 'uploaded'`
 * plus `errorMessage: undefined`. Neither did what the callers claimed:
 *  - nothing in the product drains `uploaded` documents, so no processing ever
 *    happened while both call sites toasted "queued for reprocessing";
 *  - `documentToFirestore` skips `undefined`, so the stale failure text was
 *    never cleared either.
 *
 * It now posts to `/api/documents/retry`, which enqueues the work, stamps the
 * accepted state, and answers 202 only once the queue has acknowledged the
 * event. Anything else THROWS with the server's reason so the caller's error
 * toast reports the real failure instead of a fictional success.
 *
 * @param id - Document ID
 * @returns The acknowledged event ids
 * @throws Error carrying the server's message when the request is refused
 */
export async function retryDocumentProcessing(id: string): Promise<DocumentRetryAcceptance> {
  const response = await fetchWithAuth('/api/documents/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: id }),
  });

  let payload: { accepted?: boolean; eventIds?: string[]; error?: string } = {};
  try {
    payload = await response.json();
  } catch {
    // Fall through to the status-based message below.
  }

  if (!response.ok || !payload.accepted) {
    const reason = payload.error ?? `Reprocessing request failed (HTTP ${response.status})`;
    log.warn('Document reprocessing request refused', { id, status: response.status, reason });
    throw new Error(reason);
  }

  const eventIds = payload.eventIds ?? [];
  log.info('Queued document reprocessing', { id, eventIds });
  return { documentId: id, eventIds };
}

// ============================================================================
// URL DOCUMENT FUNCTIONS (Knowledge Tab Sprint)
// ============================================================================

/**
 * Check if a document exists by normalized URL.
 * This is the preferred method for duplicate detection as it handles
 * URL variations (www/non-www, trailing slashes, tracking params).
 *
 * @param url - URL to check (will be normalized)
 * @returns Document if exists, null otherwise
 * @phase Knowledge Tab Sprint
 */
export async function getDocumentByNormalizedUrl(url: string): Promise<Document | null> {
  try {
    const normalized = normalizeUrl(url);
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('normalizedUrl', '==', normalized), limitQuery(1));
    const snapshot = await getDocs(q);

    if (snapshot.empty) return null;
    return firestoreToDocument(snapshot.docs[0]);
  } catch (error) {
    log.error('Error checking document by normalized URL', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Create a URL document with normalized URL and domain extraction.
 *
 * @param url - Original URL
 * @param title - Document title
 * @param uploadedBy - User ID
 * @param options - Additional options
 * @returns Created document
 * @throws Error if URL already exists (based on normalized URL)
 * @phase Knowledge Tab Sprint
 */
export async function createUrlDocument(
  url: string,
  title: string,
  uploadedBy: string,
  options?: {
    description?: string;
    tags?: string[];
    visibility?: DocumentVisibility;
    workspaceId?: string;
  }
): Promise<Document> {
  // Check for existing document with same normalized URL
  const existing = await getDocumentByNormalizedUrl(url);
  if (existing) {
    throw new Error(`Document already exists for URL: ${url} (ID: ${existing.id})`);
  }

  const normalized = normalizeUrl(url);
  const domain = extractDomain(url);

  const input: CreateDocumentInput = {
    title,
    type: 'url',
    storageUrl: '', // Will be populated after fetching
    originalUrl: url,
    uploadedBy,
    description: options?.description,
    tags: options?.tags,
  };

  // Create the base document
  const docData = {
    ...documentToFirestore(input),
    status: 'uploaded' as DocumentStatus,
    normalizedUrl: normalized,
    domain,
    version: 1,
    visibility: options?.visibility || 'workspace',
    workspaceId: options?.workspaceId || 'default',
    graphSyncStatus: 'pending' as GraphSyncStatus,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  const collectionRef = collection(db, COLLECTION_NAME);
  const docRef = await addDoc(collectionRef, docData);

  const created = await getDocumentById(docRef.id);
  if (!created) {
    throw new Error('Failed to retrieve created URL document');
  }

  log.info('Created URL document', { id: created.id, domain });
  return created;
}

/**
 * Mark a URL document as blocked (paywall, robots.txt, etc.).
 *
 * @param id - Document ID
 * @param reason - Reason for blocking
 * @phase Knowledge Tab Sprint
 */
export async function markDocumentBlocked(id: string, reason: string): Promise<void> {
  await updateDocument(id, {
    status: 'blocked',
    fetchError: reason,
  });
  log.info('Marked document as blocked', { id, reason });
}

// ============================================================================
// REFRESH FUNCTIONS (Knowledge Tab Sprint)
// ============================================================================

/**
 * Start a refresh operation for a URL document.
 * Sets refreshInProgress flag to prevent concurrent refreshes.
 *
 * @param id - Document ID
 * @returns true if refresh can proceed, false if already in progress
 * @phase Knowledge Tab Sprint
 */
export async function startDocumentRefresh(id: string): Promise<boolean> {
  const document = await getDocumentById(id);
  if (!document) {
    throw new Error(`Document not found: ${id}`);
  }

  if (document.type !== 'url') {
    throw new Error(`Cannot refresh non-URL document: ${id}`);
  }

  if (document.refreshInProgress) {
    log.info('Refresh already in progress for document', { id });
    return false;
  }

  await updateDocument(id, {
    refreshInProgress: true,
  });

  log.info('Started refresh for document', { id });
  return true;
}

/**
 * Complete a refresh operation for a URL document.
 * Updates version, hash, and clears refresh flag.
 *
 * @param id - Document ID
 * @param contentChanged - Whether the content has changed
 * @param contentHash - New content hash (if content changed)
 * @phase Knowledge Tab Sprint
 */
export async function completeDocumentRefresh(
  id: string,
  contentChanged: boolean,
  contentHash?: string
): Promise<void> {
  const document = await getDocumentById(id);
  if (!document) {
    throw new Error(`Document not found: ${id}`);
  }

  const updates: Partial<Document> = {
    refreshInProgress: false,
    lastFetchedAt: Date.now(),
    fetchError: undefined,
  };

  if (contentChanged) {
    updates.version = (document.version || 1) + 1;
    updates.contentHash = contentHash;
    updates.status = 'uploaded'; // Trigger reprocessing
    updates.graphSyncStatus = 'pending';
    log.info('Content changed, bumping version', { id, version: updates.version });
  }

  await updateDocument(id, updates);
  log.info('Completed document refresh', { id, contentChanged });
}

/**
 * Fail a refresh operation for a URL document.
 * Clears refresh flag and records error.
 *
 * @param id - Document ID
 * @param error - Error message
 * @phase Knowledge Tab Sprint
 */
export async function failDocumentRefresh(id: string, error: string): Promise<void> {
  await updateDocument(id, {
    refreshInProgress: false,
    fetchError: error,
  });
  log.info('Failed refresh for document', { id, error });
}

/**
 * Get documents that need refreshing (URL documents not refreshed recently).
 *
 * @param maxAgeMs - Maximum age in milliseconds since last fetch (default: 7 days)
 * @param limit - Maximum results
 * @returns Array of documents needing refresh
 * @phase Knowledge Tab Sprint
 */
export async function getDocumentsNeedingRefresh(
  maxAgeMs = 7 * 24 * 60 * 60 * 1000, // 7 days
  limit = 50
): Promise<Document[]> {
  try {
    const documents = await getDocuments({ type: 'url', status: 'processed', limit: 500 });
    const now = Date.now();
    const cutoff = now - maxAgeMs;

    return documents
      .filter((doc) => {
        // Skip if refresh is in progress
        if (doc.refreshInProgress) return false;
        // Include if never fetched or fetched before cutoff
        return !doc.lastFetchedAt || doc.lastFetchedAt < cutoff;
      })
      .slice(0, limit);
  } catch (error) {
    log.error('Error getting documents needing refresh', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// ORPHAN DETECTION (Knowledge Tab Sprint)
// ============================================================================

/**
 * Get orphan documents (not linked to any entity).
 *
 * @param limit - Maximum results
 * @returns Array of orphan documents
 * @phase Knowledge Tab Sprint
 */
export async function getOrphanDocuments(limit = 100): Promise<Document[]> {
  try {
    const documents = await getDocuments({ status: 'processed', limit: 500 });
    return documents.filter((doc) => !doc.linkedEntityCount || doc.linkedEntityCount === 0).slice(0, limit);
  } catch (error) {
    log.error('Error getting orphan documents', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Update the linked entity count for a document.
 * Called when EntityDocumentLinks are created/deleted.
 *
 * @param id - Document ID
 * @param delta - Change in count (+1 for link, -1 for unlink)
 * @phase Knowledge Tab Sprint
 */
export async function updateLinkedEntityCount(id: string, delta: number): Promise<void> {
  const document = await getDocumentById(id);
  if (!document) {
    log.warn('Cannot update linked count for missing document', { id });
    return;
  }

  const newCount = Math.max(0, (document.linkedEntityCount || 0) + delta);
  await updateDocument(id, { linkedEntityCount: newCount });
}

// ============================================================================
// GRAPH SYNC STATUS (Knowledge Tab Sprint)
// ============================================================================

/**
 * Mark a document as synced to Neo4j.
 *
 * @param id - Document ID
 * @phase Knowledge Tab Sprint
 */
export async function markDocumentSynced(id: string): Promise<void> {
  await updateDocument(id, {
    graphSyncStatus: 'synced',
    lastSyncedAt: Date.now(),
  });
}

/**
 * Mark a document sync as failed.
 *
 * @param id - Document ID
 * @phase Knowledge Tab Sprint
 */
export async function markDocumentSyncFailed(id: string): Promise<void> {
  await updateDocument(id, {
    graphSyncStatus: 'failed',
  });
}

/**
 * Get documents pending sync to Neo4j.
 *
 * @param limit - Maximum results
 * @returns Array of documents pending sync
 * @phase Knowledge Tab Sprint
 */
export async function getDocumentsPendingSync(limit = 100): Promise<Document[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('graphSyncStatus', '==', 'pending'), limitQuery(limit));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(firestoreToDocument).filter((d): d is Document => d !== null);
  } catch (error) {
    log.error('Error getting documents pending sync', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
