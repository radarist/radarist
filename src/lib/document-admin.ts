/**
 * @file document-admin.ts
 * @description Admin-SDK twin of the document service for SERVER-side callers
 * (`/api/documents/*` route handlers and the document / deep-research AI tools).
 *
 * Why this exists: `src/lib/document-service.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). It is fine in the browser
 * and in `"use client"` components, but its read/create/update paths return
 * `code: 'unavailable'` in stateless serverless functions — the same failure
 * mode observed in Inngest workers and that `signals-admin.ts` /
 * `companies-admin.ts` / `relations-admin.ts` already solve via the narrow
 * admin-helper pattern.
 *
 * This module reproduces the document Firestore CRUD semantics EXACTLY via the
 * Admin SDK, for the functions the named server call sites use:
 * - `adminCreateDocument`            ← createDocument
 *   (deep-research/route, upload/route, url/route, deep-research-tools)
 * - `adminGetDocumentById`           ← getDocumentById
 *   ([id]/route, process, refresh, reprocess-url, document-tools)
 * - `adminGetDocumentForDownload`    — owner-bound read for content retrieval
 *   (download route; SEC-015 — no client-SDK twin, this is server-only authz)
 * - `adminGetDocumentByNormalizedUrl`← getDocumentByNormalizedUrl (url/route)
 * - `adminUpdateDocument`            ← updateDocument (url/route, reprocess-url)
 * - `adminGetDocuments`             ← getDocuments (document-tools)
 *
 * Plus the two full-parity delete twins (`adminDeleteDocument` /
 * `adminDeleteDocuments`).
 *
 * The Firestore<->domain field mapping (`documentToFirestore` /
 * `firestoreToDocument`) is reproduced 1:1 here. The only mechanical difference
 * from the client service is that timestamps are written with the ADMIN
 * `Timestamp` (from `firebase-admin/firestore`) instead of the client one;
 * both expose `.toMillis()`, so admin-written docs read back identically from
 * the client `firestoreToDocument` and vice versa.
 *
 * IMPORTANT — no sync event on create. `document-service.createDocument` does
 * NOT fire any Inngest / graph-sync event itself; the `app/document.sync.requested`
 * event is fired separately by the API routes / Inngest functions
 * (`process-document.ts`, `run-document-deep-research.ts`, etc.). To preserve
 * EXACT behaviour, `adminCreateDocument` likewise fires nothing — callers keep
 * owning the sync trigger.
 *
 * Delete cleanup is server-owned: principal check, relations, entity-document
 * links, chunks, owner-bound Storage/Firestore fallback blobs, required durable
 * graph handoff, then a transaction-time ownership check and parent delete.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { adminDeleteLinksForDocument } from '@/lib/entity-document-link-delete-admin';
import { adminDeleteChunksForDocument } from '@/lib/document-chunk-admin';
import { adminDeleteStoredDocument } from '@/lib/document-storage-admin';
import { authorizeDocumentDownload, type DocumentDownloadRefusal } from '@/lib/document-download-policy';
import { fuzzySearch } from '@/lib/fuzzy-search';
import { normalizeUrl } from '@/lib/utils/url-normalize';
import { mapWithBoundedConcurrency } from '@/lib/bounded-concurrency';
import { createLogger } from '@/lib/logger';
import type { Document, DocumentStatus, DocumentType, CreateDocumentInput } from '@/lib/types';

const log = createLogger('document-admin');

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'documents';
const DELETION_LEASE_COLLECTION = 'documentDeletionLeases';
const DOCUMENT_DELETE_CONCURRENCY = 8;

/** Every destructive caller must declare whether it acts for a user or the system. */
export type DocumentDeletePrincipal = { kind: 'user'; uid: string } | { kind: 'system'; expectedOwnerUid?: string };

export const SYSTEM_DOCUMENT_DELETE_PRINCIPAL: DocumentDeletePrincipal = Object.freeze({ kind: 'system' });

interface DocumentDeletionLease {
  leaseId: string;
  documentId: string;
  ownerId: string | null;
  storagePath: string;
  createdAt: unknown;
}

interface AcquiredDocumentDeletion {
  lease: DocumentDeletionLease;
}

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filter options for querying documents. Mirrors `DocumentFilters` from
 * `document-service.ts` so `adminGetDocuments` is a drop-in.
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
 * Convert an Admin Firestore document snapshot to the `Document` type. Admin-SDK
 * mirror of `firestoreToDocument` from `document-service.ts` — same field set,
 * same `.toMillis?.()` millis coercion for timestamp fields.
 */
function firestoreToDocument(docSnap: FirebaseFirestore.DocumentSnapshot): Document | null {
  if (!docSnap.exists) return null;

  const data = docSnap.data()!;
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
    // Content review (GRAPH-064)
    contentReviewedAt: data.contentReviewedAt?.toMillis?.() ?? data.contentReviewedAt,
    contentReviewedBy: data.contentReviewedBy,
    // Build-mission provenance (artifact outputs)
    sourceRunId: data.sourceRunId,
    sourceMissionId: data.sourceMissionId,
    structuredMetrics: data.structuredMetrics,
    // AI-038 — evidence verdict for generated research documents.
    researchEvidence: data.researchEvidence,
  };
}

/**
 * Convert a (partial) `Document` to Firestore write format. Admin-SDK mirror of
 * `documentToFirestore` from `document-service.ts`: copies only defined fields
 * (so update is non-destructive) and converts the millis timestamp fields to
 * the ADMIN `Timestamp`. Behaviour is identical to the client mapper apart from
 * the Timestamp implementation (both expose `.toMillis()`).
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
  // Content review (GRAPH-064) — drives what this document's graph mentions
  // may claim. Stored as plain millis so the graph projection can read it
  // without a Timestamp conversion.
  if (document.contentReviewedAt !== undefined) data.contentReviewedAt = document.contentReviewedAt;
  if (document.contentReviewedBy !== undefined) data.contentReviewedBy = document.contentReviewedBy;
  // Build-mission provenance (artifact outputs)
  if (document.sourceRunId !== undefined) data.sourceRunId = document.sourceRunId;
  if (document.sourceMissionId !== undefined) data.sourceMissionId = document.sourceMissionId;
  if (document.structuredMetrics !== undefined) data.structuredMetrics = document.structuredMetrics;
  // AI-038 — evidence verdict for generated research documents.
  if (document.researchEvidence !== undefined) data.researchEvidence = document.researchEvidence;

  return data;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all documents with optional filters. Admin-SDK mirror of `getDocuments`:
 * server-side `orderBy('createdAt','desc')` + at-most-one equality filter
 * (type > status > uploadedBy precedence), optional `limit`, then the same
 * in-memory fuzzy search / tag filter / type+status re-filter.
 */
export async function adminGetDocuments(filters?: DocumentFilters): Promise<Document[]> {
  try {
    let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME).orderBy('createdAt', 'desc');

    // Apply Firestore filters (limited to one equality predicate per query,
    // matching the client service's precedence).
    if (filters?.type) {
      q = q.where('type', '==', filters.type);
    } else if (filters?.status) {
      q = q.where('status', '==', filters.status);
    } else if (filters?.uploadedBy) {
      q = q.where('uploadedBy', '==', filters.uploadedBy);
    }

    if (filters?.limit) {
      q = q.limit(filters.limit);
    }

    const snapshot = await q.get();
    let documents = snapshot.docs.map(firestoreToDocument).filter((d): d is Document => d !== null);

    // Apply client-side filters for complex queries.
    if (filters?.search) {
      documents = fuzzySearch(documents, filters.search, {
        keys: ['title', 'description'] as (keyof Document)[],
        threshold: 0.2,
      });
    }

    if (filters?.tags && filters.tags.length > 0) {
      documents = documents.filter((d) => filters.tags!.some((tag) => d.tags?.includes(tag)));
    }

    // Re-apply status filter if type was the primary filter.
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
 * Get a document by ID, or null if not found. Admin-SDK mirror of
 * `getDocumentById`.
 */
export async function adminGetDocumentById(id: string): Promise<Document | null> {
  try {
    const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
    return firestoreToDocument(docSnap);
  } catch (error) {
    log.error('Error getting document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Read a document for a caller who intends to retrieve its CONTENT — SEC-015.
 *
 * The only owner-aware document read. `adminGetDocumentById` stays the
 * unauthenticated repository primitive (Inngest workers and other system
 * contexts carry their own authority); every caller that is about to hand bytes
 * to a browser must come through here so the ownership comparison cannot be
 * forgotten at one call site again.
 *
 * Absent, foreign, and ownerless records are reported as three distinguishable
 * REASONS to the server (for logs and tests) and, by contract, as one
 * indistinguishable refusal to the client. Nothing about the document is
 * returned on refusal, so a caller cannot leak metadata it was denied.
 *
 * @param id - Document ID
 * @param callerUid - The uid from the VERIFIED ID token, never a request body
 */
export async function adminGetDocumentForDownload(
  id: string,
  callerUid: string
): Promise<
  { authorized: true; document: Document; ownerId: string } | { authorized: false; reason: DocumentDownloadRefusal }
> {
  const document = await adminGetDocumentById(id);
  const decision = authorizeDocumentDownload(document, callerUid);
  if (!decision.authorized) {
    // Reason only. No uid, owner, title, or storage path: a refusal log must
    // not become the disclosure the refusal just prevented.
    log.warn('Refused document content read', { id, reason: decision.reason });
    return { authorized: false, reason: decision.reason };
  }
  // `authorizeDocumentDownload` answers `not-found` for a null document, so an
  // authorized decision proves the read returned one. TypeScript cannot carry
  // that correlation across the two values, hence the assertion.
  return { authorized: true, document: document!, ownerId: decision.ownerId };
}

/**
 * Get the document produced by a given build-mission run, or null. Used by the
 * publish step for idempotent re-publish/Iterate (update-not-duplicate).
 */
export async function adminGetDocumentBySourceRunId(runId: string): Promise<Document | null> {
  try {
    const snapshot = await db.collection(COLLECTION_NAME).where('sourceRunId', '==', runId).limit(1).get();
    if (snapshot.empty) return null;
    return firestoreToDocument(snapshot.docs[0]);
  } catch (error) {
    log.error('Error getting document by sourceRunId', error instanceof Error ? error : new Error(String(error)), {
      runId,
    });
    throw error;
  }
}

/**
 * Check if a document exists by normalized URL. Admin-SDK mirror of
 * `getDocumentByNormalizedUrl`: normalizes the URL, then equality-queries the
 * `normalizedUrl` field, returning the first match or null.
 */
export async function adminGetDocumentByNormalizedUrl(url: string): Promise<Document | null> {
  try {
    const normalized = normalizeUrl(url);
    const snapshot = await db.collection(COLLECTION_NAME).where('normalizedUrl', '==', normalized).limit(1).get();

    if (snapshot.empty) return null;
    return firestoreToDocument(snapshot.docs[0]);
  } catch (error) {
    log.error('Error checking document by normalized URL', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create a new document record. Admin-SDK mirror of `createDocument`: maps the
 * input via `documentToFirestore`, stamps `status: 'uploaded'` and
 * `createdAt`/`updatedAt`, auto-IDs via `collection().add()` (documents are NOT
 * entity-factory entities — no slug), then re-reads to return the full record.
 *
 * No sync event is fired here — see the module header. The client service does
 * not fire one either; callers own the `app/document.sync.requested` trigger.
 *
 * Server-only extension over the client mirror: `options.initialStatus` lets a
 * GENERATED-document flow (deep research) create its record in a truthful
 * `processing` state atomically, instead of claiming `uploaded` while nothing
 * exists in Storage yet. Omitting it preserves the client-exact behavior.
 *
 * @throws Error if the created document cannot be re-read (same as client).
 */
export async function adminCreateDocument(
  input: CreateDocumentInput,
  options?: { initialStatus?: DocumentStatus }
): Promise<Document> {
  try {
    const now = Timestamp.now();
    const docData = {
      ...documentToFirestore(input),
      status: (options?.initialStatus ?? 'uploaded') as DocumentStatus,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db.collection(COLLECTION_NAME).add(docData);

    const created = await adminGetDocumentById(docRef.id);
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
 * Update a document. Admin-SDK mirror of `updateDocument`: maps the partial via
 * `documentToFirestore` (only defined fields), bumps `updatedAt`, and writes
 * via `.update()`.
 */
/**
 * Outcome of an attempt to claim a document for processing.
 *
 * `claimed` is the ONLY value that means an enqueue may proceed. The other two
 * carry the state the transaction actually observed, so the caller can answer
 * with the true reason rather than a guess.
 */
export type DocumentProcessingClaim =
  | { claimed: true; previousStatus: DocumentStatus; previousRequestedAt: number }
  | { claimed: false; reason: 'not-found' }
  | {
      claimed: false;
      reason: 'not-claimable';
      currentStatus: DocumentStatus;
      currentRequestedAt: number;
    };

/**
 * ATOMICALLY claim a document for a processing run.
 *
 * UX-036: the retry route originally read the document, evaluated the
 * retryability policy, and only then wrote `status: 'processing'` — three
 * separate operations. Two clicks inside that window both observed the
 * pre-retry status, both passed the guard, and both enqueued a run. Neither
 * the table item nor the sheet button disables itself fast enough to prevent
 * it, so the guard has to be a compare-and-set, not a comment.
 *
 * The re-read and the check happen INSIDE the transaction, so a concurrent
 * claim loses deterministically.
 *
 * @param id - Document ID
 * @param canClaim - The retryability policy, applied to the transactional read
 * @param requestedAt - The accepted-run stamp to write
 */
export async function adminClaimDocumentForProcessing(
  id: string,
  canClaim: (document: Document) => boolean,
  requestedAt: number
): Promise<DocumentProcessingClaim> {
  const documentRef = db.collection(COLLECTION_NAME).doc(id);
  const leaseRef = db.collection(DELETION_LEASE_COLLECTION).doc(id);

  return db.runTransaction<DocumentProcessingClaim>(async (transaction) => {
    const lease = await transaction.get(leaseRef);
    if (lease.exists) {
      throw new Error(`Document deletion is already in progress: ${id}`);
    }

    const snapshot = await transaction.get(documentRef);
    const document = firestoreToDocument(snapshot);
    if (!document) return { claimed: false, reason: 'not-found' };

    if (!canClaim(document)) {
      return {
        claimed: false,
        reason: 'not-claimable',
        currentStatus: document.status,
        currentRequestedAt: document.processingRequestedAt ?? 0,
      };
    }

    transaction.update(documentRef, {
      status: 'processing',
      processingRequestedAt: Timestamp.fromMillis(requestedAt),
      // '' rather than undefined: the mappers skip undefined, which is exactly
      // why the old client-side retry never cleared the stale failure text.
      errorMessage: '',
      fetchError: '',
      updatedAt: Timestamp.now(),
    });

    return {
      claimed: true,
      previousStatus: document.status,
      previousRequestedAt: document.processingRequestedAt ?? 0,
    };
  });
}

export async function adminUpdateDocument(
  id: string,
  updates: Partial<Omit<Document, 'id' | 'createdAt'>>
): Promise<void> {
  try {
    const updateData = {
      ...documentToFirestore(updates),
      updatedAt: Timestamp.now(),
    };

    const documentRef = db.collection(COLLECTION_NAME).doc(id);
    const leaseRef = db.collection(DELETION_LEASE_COLLECTION).doc(id);
    await db.runTransaction(async (transaction) => {
      const lease = await transaction.get(leaseRef);
      if (lease.exists) {
        throw new Error(`Document deletion is already in progress: ${id}`);
      }
      transaction.update(documentRef, updateData);
    });
    log.info('Updated document', { id });
  } catch (error) {
    log.error('Error updating document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

export interface DocumentContentReviewResult {
  documentId: string;
  reviewed: boolean;
  reviewedAt: number | null;
  reviewedBy: string | null;
  /** Whether the graph re-derivation was handed off durably. */
  graphSyncDispatched: boolean;
}

/**
 * Record (or withdraw) a human review of a document's CONTENT — GRAPH-064.
 *
 * This is the only promotion path for a machine-generated source: until a human
 * vouches for the text, every `(:Chunk)-[:MENTIONS]->(:Entity)` edge derived
 * from it stays explicitly unverified and cannot satisfy a curated-path read.
 * Setting the review flips those edges to curated on the next document sync;
 * withdrawing it demotes them again by exactly the same derivation.
 *
 * The Firestore write is authoritative and the graph re-derivation is a durable
 * handoff, so a failed dispatch throws rather than reporting a promotion the
 * graph never received.
 *
 * @throws Error when the document does not exist or the sync handoff is refused.
 */
export async function markDocumentContentReviewed(
  id: string,
  reviewedBy: string,
  options?: { reviewed?: boolean }
): Promise<DocumentContentReviewResult> {
  const reviewed = options?.reviewed !== false;
  if (!id?.trim()) throw new Error('Document content review requires a document id');
  if (reviewed && !reviewedBy?.trim()) {
    throw new Error('Document content review requires the reviewing user');
  }

  const existing = await adminGetDocumentById(id);
  if (!existing) {
    throw new Error(`Cannot review a document that does not exist: ${id}`);
  }

  const reviewedAt = reviewed ? Date.now() : null;
  const documentRef = db.collection(COLLECTION_NAME).doc(id);
  const leaseRef = db.collection(DELETION_LEASE_COLLECTION).doc(id);
  await db.runTransaction(async (transaction) => {
    const [current, lease] = await Promise.all([transaction.get(documentRef), transaction.get(leaseRef)]);
    if (lease.exists) {
      throw new Error(`Document deletion is already in progress: ${id}`);
    }
    if (!current.exists) {
      throw new Error(`Cannot review a document that does not exist: ${id}`);
    }
    transaction.update(documentRef, {
      contentReviewedAt: reviewed ? reviewedAt : FieldValue.delete(),
      contentReviewedBy: reviewed ? reviewedBy.trim() : FieldValue.delete(),
      updatedAt: Timestamp.now(),
    });
  });

  // The graph carries the trust consequence of this review; a review that never
  // reaches the graph is a promotion the reader would never see.
  const { inngest } = await import('@/lib/inngest/client');
  const accepted = await inngest.send({
    name: 'app/document.sync.requested',
    data: { documentId: id, operation: 'update' },
  });
  if (!accepted.ids?.length) {
    throw new Error(`Document content review was stored but its graph re-derivation was not accepted: ${id}`);
  }

  log.info('Recorded document content review', { id, reviewed, reviewedBy: reviewed ? reviewedBy : null });
  return {
    documentId: id,
    reviewed,
    reviewedAt,
    reviewedBy: reviewed ? reviewedBy.trim() : null,
    graphSyncDispatched: true,
  };
}

function storedIdentity(data: Record<string, unknown>): { ownerId: string | null; storagePath: string } {
  return {
    ownerId: typeof data.uploadedBy === 'string' && data.uploadedBy.length > 0 ? data.uploadedBy : null,
    storagePath: typeof data.storageUrl === 'string' ? data.storageUrl : '',
  };
}

function parseDeletionLease(snapshot: FirebaseFirestore.DocumentSnapshot): DocumentDeletionLease | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Record<string, unknown>;
  if (
    typeof data.leaseId !== 'string' ||
    typeof data.documentId !== 'string' ||
    (data.ownerId !== null && typeof data.ownerId !== 'string') ||
    typeof data.storagePath !== 'string'
  ) {
    throw new Error(`Malformed document deletion lease: ${snapshot.id}`);
  }
  return {
    leaseId: data.leaseId,
    documentId: data.documentId,
    ownerId: data.ownerId,
    storagePath: data.storagePath,
    createdAt: data.createdAt,
  };
}

function authorizeDeletionIdentity(
  identity: { ownerId: string | null; storagePath: string },
  principal: DocumentDeletePrincipal
): boolean {
  if (principal.kind === 'user') return identity.ownerId === principal.uid;
  if (principal.expectedOwnerUid && identity.ownerId !== principal.expectedOwnerUid) {
    throw new Error('Document owner does not match the system deletion context');
  }
  if (identity.storagePath && (!identity.ownerId || !principal.expectedOwnerUid)) {
    throw new Error('Cannot delete stored content without an authoritative expected owner');
  }
  return true;
}

/**
 * Atomically bind a deletion to one immutable owner/storage identity. Browser
 * rules consult the lease document, while canonical Admin updates read it in
 * their own transaction. A concurrent mutation therefore either commits first
 * and is observed here, or is refused after this transaction commits.
 *
 * Failed cascades deliberately retain the lease. Retrying the same authorized
 * deletion resumes it idempotently; unlocking after a partial cascade would
 * permit the identity to move while dependencies were already gone.
 */
async function acquireDocumentDeletion(
  id: string,
  principal: DocumentDeletePrincipal
): Promise<AcquiredDocumentDeletion | null> {
  const documentRef = db.collection(COLLECTION_NAME).doc(id);
  const leaseRef = db.collection(DELETION_LEASE_COLLECTION).doc(id);

  return db.runTransaction(async (transaction) => {
    const [documentSnapshot, leaseSnapshot] = await Promise.all([
      transaction.get(documentRef),
      transaction.get(leaseRef),
    ]);
    if (!documentSnapshot.exists) {
      if (leaseSnapshot.exists) transaction.delete(leaseRef);
      return null;
    }

    const data = documentSnapshot.data() as Record<string, unknown>;
    const identity = storedIdentity(data);
    if (!authorizeDeletionIdentity(identity, principal)) return null;

    const existingLease = parseDeletionLease(leaseSnapshot);
    if (existingLease) {
      if (
        existingLease.documentId !== id ||
        existingLease.ownerId !== identity.ownerId ||
        existingLease.storagePath !== identity.storagePath
      ) {
        throw new Error(`Document identity changed while deletion was leased: ${id}`);
      }
      return { lease: existingLease };
    }

    const lease: DocumentDeletionLease = {
      leaseId: randomUUID(),
      documentId: id,
      ownerId: identity.ownerId,
      storagePath: identity.storagePath,
      createdAt: Timestamp.now(),
    };
    transaction.set(leaseRef, lease);
    return { lease };
  });
}

/**
 * Delete a document and all associated resources through one principal-bound
 * server boundary.
 *
 * User callers get the same `false` outcome for absent, foreign, and ownerless
 * records. A server-only lease transaction binds the owner and storage identity
 * before any cascade starts; client rules and canonical Admin updates refuse
 * mutation until the final parent transaction removes both records. Required
 * cascade and storage cleanup must finish before the parent is removed.
 *
 * Graph deletion is handed to Inngest and acknowledgement is required before
 * the parent disappears. The worker independently refuses to delete while the
 * source still exists, so an early delivery retries rather than racing the
 * Firestore transaction.
 */
export async function adminDeleteDocument(id: string, principal: DocumentDeletePrincipal): Promise<boolean> {
  try {
    const acquired = await acquireDocumentDeletion(id, principal);
    if (!acquired) {
      log.warn('Document not found for deletion', { id });
      return false;
    }
    const { lease } = acquired;
    const authoritativeOwner = lease.ownerId;
    const authoritativeStoragePath = lease.storagePath;

    // Clean up relations first (cascade delete) — mirrors the client service.
    const relationsDeleted = await adminDeleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for document', { relationsDeleted, id });
    }

    const linksDeleted = await adminDeleteLinksForDocument(id);
    if (linksDeleted > 0) {
      log.info('Cleaned up entity-document links for document', { linksDeleted, id });
    }

    const chunksDeleted = await adminDeleteChunksForDocument(id);
    log.info('Deleted chunks for document', { chunksDeleted, id });

    if (authoritativeStoragePath) {
      // acquireDocumentDeletion already required an independently supplied
      // owner for stored system content and exact user ownership for user calls.
      await adminDeleteStoredDocument(authoritativeStoragePath, authoritativeOwner!);
    }

    // The accepted event is the durable graph-cleanup handoff. It must exist
    // before the Firestore source (the only otherwise-retryable anchor) is gone.
    const { inngest } = await import('@/lib/inngest/client');
    const accepted = await inngest.send({
      name: 'app/document.sync.requested',
      data: { documentId: id, operation: 'delete' },
    });
    if (!accepted.ids?.length) {
      throw new Error('Inngest accepted no document-delete event');
    }

    const documentRef = db.collection(COLLECTION_NAME).doc(id);
    const leaseRef = db.collection(DELETION_LEASE_COLLECTION).doc(id);
    const deleted = await db.runTransaction(async (transaction) => {
      const [current, leaseSnapshot] = await Promise.all([transaction.get(documentRef), transaction.get(leaseRef)]);
      const currentLease = parseDeletionLease(leaseSnapshot);
      if (!currentLease || currentLease.leaseId !== lease.leaseId) {
        throw new Error(`Document deletion lease changed before commit: ${id}`);
      }
      if (!current.exists) {
        transaction.delete(leaseRef);
        return false;
      }
      const identity = storedIdentity(current.data() as Record<string, unknown>);
      if (identity.ownerId !== authoritativeOwner || identity.storagePath !== authoritativeStoragePath) {
        throw new Error(`Document identity changed while deletion was leased: ${id}`);
      }
      transaction.delete(documentRef);
      transaction.delete(leaseRef);
      return true;
    });

    if (!deleted) return false;
    log.info('Deleted document', { id });
    return true;
  } catch (error) {
    log.error('Error deleting document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Delete multiple documents and all associated resources, then the document
 * records (batched at 500). No-ops on an empty input.
 */
export async function adminDeleteDocuments(ids: string[], principal: DocumentDeletePrincipal): Promise<void> {
  if (ids.length === 0) return;

  try {
    await mapWithBoundedConcurrency(ids, DOCUMENT_DELETE_CONCURRENCY, (id) => adminDeleteDocument(id, principal));
    log.info('Deleted documents', { count: ids.length });
  } catch (error) {
    log.error('Error bulk deleting documents', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
