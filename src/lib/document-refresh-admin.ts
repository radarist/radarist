/**
 * @file lib/document-refresh-admin.ts
 * @description Narrow server-only admin-SDK helper for the URL-document refresh
 * Inngest function (T1.4 of firebase-admin migration plan v2.4).
 *
 * Replaces the static imports of `@/lib/document-service` + `@/lib/document-chunk-service`
 * in `src/lib/inngest/functions/refresh-url-document.ts:29-39`. Those modules
 * load the Firebase client SDK at module init (`client SDK firebase/firestore`
 * imports at the top), so just loading the Inngest function threw
 * `code: 'unavailable'` in the worker.
 *
 * Scope: only the 7 functions the refresh job uses:
 *   document-service:
 *     - getDocumentById
 *     - startDocumentRefresh
 *     - completeDocumentRefresh
 *     - failDocumentRefresh
 *     - markDocumentBlocked
 *     - getDocumentsNeedingRefresh
 *   document-chunk-service:
 *     - archiveChunksForDocument
 *
 * Track 2 Tier 2 will split the full `document-service.ts` (29 named exports)
 * and `document-chunk-service.ts`. This helper can then be inlined or deleted.
 *
 * Skips (vs full document-service):
 *   - Neo4j graph sync (Type B; document-service does it via update side-effects)
 *   - Storage tier 1 mirror in document-storage-service (Track 2 Tier 2.5)
 *
 * The Inngest function already wraps each call in step.run with its own error
 * handling, so this helper deliberately throws on missing docs rather than
 * silently returning null — preserves the prior contract.
 */
import 'server-only';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { isRefreshActive } from '@/lib/document-refresh-policy';
import { isActiveChunk } from '@/lib/document-chunk-activity';
import type { Document, DocumentStatus } from '@/lib/types';

const log = createLogger('document-refresh-admin');
const DOCUMENTS_COLLECTION = 'documents';
const CHUNKS_COLLECTION = 'documentChunks';

type DocumentSnapshot = FirebaseFirestore.DocumentSnapshot;

/** Admin Timestamp values expose `toMillis()`; raw numbers pass through. */
function timestampToMillis(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return undefined;
}

/** Mirror of `firestoreToDocument` from document-service.ts:80 but admin SDK. */
function snapToDocument(snap: DocumentSnapshot): Document | null {
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data) return null;
  return {
    id: snap.id,
    title: data.title,
    type: data.type,
    storageUrl: data.storageUrl,
    originalUrl: data.originalUrl,
    status: data.status,
    processedAt: timestampToMillis(data.processedAt),
    chunkCount: data.chunkCount,
    errorMessage: data.errorMessage,
    description: data.description,
    tags: data.tags || [],
    fileSize: data.fileSize,
    mimeType: data.mimeType,
    pageCount: data.pageCount,
    createdAt: timestampToMillis(data.createdAt) ?? 0,
    updatedAt: timestampToMillis(data.updatedAt) ?? 0,
    contentHash: data.contentHash,
    refreshInProgress: data.refreshInProgress,
    lastFetchedAt: timestampToMillis(data.lastFetchedAt),
    fetchError: data.fetchError,
    version: data.version,
    graphSyncStatus: data.graphSyncStatus,
    linkedEntityCount: data.linkedEntityCount,
  } as Document;
}

async function updateDocument(id: string, updates: Partial<Document>): Promise<void> {
  // Strip undefined — Firestore admin rejects them just like the client SDK.
  const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  await db
    .collection(DOCUMENTS_COLLECTION)
    .doc(id)
    .update({ ...clean, updatedAt: Date.now() });
}

export async function getDocumentById(id: string): Promise<Document | null> {
  try {
    const snap = await db.collection(DOCUMENTS_COLLECTION).doc(id).get();
    return snapToDocument(snap);
  } catch (error) {
    log.error('Error getting document', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

export async function startDocumentRefresh(id: string): Promise<boolean> {
  const document = await getDocumentById(id);
  if (!document) throw new Error(`Document not found: ${id}`);
  if (document.type !== 'url') throw new Error(`Cannot refresh non-URL document: ${id}`);
  // Time-bounded guard: a stuck flag from a crashed run (older than
  // REFRESH_STALE_MS) is treated as inactive so the refresh can self-heal.
  if (isRefreshActive(document)) {
    log.info('Refresh already in progress for document', { id });
    return false;
  }
  if (document.refreshInProgress) {
    log.warn('Stale refreshInProgress flag detected; re-arming guard', { id, updatedAt: document.updatedAt });
  }
  await updateDocument(id, { refreshInProgress: true });
  log.info('Started refresh for document', { id });
  return true;
}

export async function completeDocumentRefresh(
  id: string,
  contentChanged: boolean,
  contentHash?: string
): Promise<void> {
  const document = await getDocumentById(id);
  if (!document) throw new Error(`Document not found: ${id}`);

  const updates: Partial<Document> = {
    refreshInProgress: false,
    lastFetchedAt: Date.now(),
    fetchError: undefined,
  };
  if (contentChanged) {
    updates.version = (document.version || 1) + 1;
    updates.contentHash = contentHash;
    updates.status = 'uploaded' as DocumentStatus;
    updates.graphSyncStatus = 'pending';
    log.info('Content changed, bumping version', { id, version: updates.version });
  }
  await updateDocument(id, updates);
  log.info('Completed document refresh', { id, contentChanged });
}

export async function failDocumentRefresh(id: string, error: string): Promise<void> {
  await updateDocument(id, { refreshInProgress: false, fetchError: error });
  log.info('Failed refresh for document', { id, error });
}

export async function markDocumentBlocked(id: string, reason: string): Promise<void> {
  await updateDocument(id, { status: 'blocked' as DocumentStatus, fetchError: reason });
  log.info('Marked document as blocked', { id, reason });
}

/**
 * Query for URL documents in 'processed' state that haven't been fetched
 * inside the maxAgeMs window. Mirrors `getDocumentsNeedingRefresh` from
 * document-service.ts:834 — pulls a fixed window then filters in memory
 * to avoid a composite index requirement.
 */
export async function getDocumentsNeedingRefresh(maxAgeMs = 7 * 24 * 60 * 60 * 1000, limit = 50): Promise<Document[]> {
  try {
    const snap = await db
      .collection(DOCUMENTS_COLLECTION)
      .where('type', '==', 'url')
      .where('status', '==', 'processed')
      .limit(500)
      .get();

    const cutoff = Date.now() - maxAgeMs;
    const docs: Document[] = [];
    for (const docSnap of snap.docs) {
      const doc = snapToDocument(docSnap);
      if (!doc) continue;
      if (doc.refreshInProgress) continue;
      if (doc.lastFetchedAt && doc.lastFetchedAt >= cutoff) continue;
      docs.push(doc);
      if (docs.length >= limit) break;
    }
    return docs;
  } catch (error) {
    log.error('Error getting documents needing refresh', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Mark all non-archived chunks belonging to a document as archived. Batches
 * writes at 500 per commit to respect Firestore's batch-size limit.
 */
export async function archiveChunksForDocument(documentId: string): Promise<number> {
  try {
    // UX-060: this previously filtered with `where('archived', '!=', true)`
    // and claimed "the same semantics: include chunks where archived is
    // undefined OR false". Firestore does NOT do that — an inequality filter
    // matches only documents where the field EXISTS, and the chunk pipeline
    // never wrote it. The refresh job therefore archived ZERO chunks and then
    // appended a fresh generation alongside the stale one. Read the
    // document's chunks and apply the shared predicate instead.
    const snap = await db.collection(CHUNKS_COLLECTION).where('documentId', '==', documentId).get();
    const docs = snap.docs.filter((chunkSnap) => isActiveChunk(chunkSnap.data() as { archived?: boolean }));
    if (docs.length === 0) return 0;

    const BATCH_SIZE = 500;
    let archived = 0;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const slice = docs.slice(i, i + BATCH_SIZE);
      for (const chunkSnap of slice) {
        batch.update(chunkSnap.ref, { archived: true });
      }
      await batch.commit();
      archived += slice.length;
    }
    log.info('Archived chunks for document', { archived, documentId });
    return archived;
  } catch (error) {
    log.error('Error archiving chunks', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}
