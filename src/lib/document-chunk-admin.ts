/**
 * @file lib/document-chunk-admin.ts
 * @description Admin-SDK twin of the document-chunk READ functions for
 * SERVER-side callers (the document AI tools in `ai/tools/document-tools.ts`).
 *
 * Why this exists: `src/lib/document-chunk-service.ts` is a client-SDK service
 * module (it uses `firebase/firestore` + `@/lib/firebase`). It is fine in the
 * browser and in `"use client"` components, but its read paths return
 * `code: 'unavailable'` (the production `a540` failure) in stateless serverless
 * functions — the same failure mode observed in Inngest workers and
 * that `document-admin.ts` already solves via the narrow admin-helper pattern.
 *
 * This module reproduces the chunk READ + WRITE semantics EXACTLY via the Admin
 * SDK, for the functions the document AI tools and the server-side document
 * processing service use:
 * - `adminGetChunksForDocument`    ← getChunksForDocument
 * - `adminGetChunkById`            ← getChunkById
 * - `adminSearchChunksSimple`      ← searchChunksSimple
 * - `adminCreateChunks`            ← createChunks
 * - `adminDeleteChunksForDocument` ← deleteChunksForDocument
 *
 * The Firestore<->domain field mapping (`firestoreToChunk` / `chunkToFirestore`)
 * and the `COLLECTION_NAME` constant are reproduced 1:1 here so output is
 * byte-identical to the client service. The only mechanical differences are the
 * Admin-SDK query surface (`db.collection().where().orderBy().get()` /
 * `db.collection().doc(id).get()`) in place of the client modular helpers, and
 * the ADMIN `Timestamp` (from `firebase-admin/firestore`) in place of the client
 * one. Both timestamp implementations expose `.toMillis()`, so admin-written /
 * admin-read chunks are identical to client-written / client-read chunks.
 *
 * Scope: the READ paths + the two WRITE paths the server-side processing service
 * needs (`createChunks` / `deleteChunksForDocument`). The pure text-processing
 * helpers (`prepareChunksFromText` etc. — no Firestore) and the versioning /
 * single-chunk / embedding-update helpers are not server crash sites, so they
 * stay on their existing path (the client `document-chunk-service`).
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { filterActiveChunks } from '@/lib/document-chunk-activity';
import { fuzzySearchWithScores } from '@/lib/fuzzy-search';
import type { DocumentChunk, CreateDocumentChunkInput } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('document-chunk-admin');

// ============================================================================
// ERRORS
// ============================================================================

/**
 * Thrown when a caller attempts to persist an empty/zero-length embedding
 * vector. Writing `[]` over a previously-good vector silently poisons the
 * vector search index, so this path fails loudly instead (H7/H8 guard).
 */
export class EmptyEmbeddingError extends Error {
  public readonly chunkId: string;
  constructor(chunkId: string) {
    super(`Refusing to persist empty embedding vector for chunk ${chunkId}`);
    this.name = 'EmptyEmbeddingError';
    this.chunkId = chunkId;
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'documentChunks';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert an Admin Firestore document snapshot to the `DocumentChunk` type.
 * Admin-SDK mirror of `firestoreToChunk` from `document-chunk-service.ts` —
 * same field set, same `.toMillis?.()` millis coercion for timestamp fields.
 */
function firestoreToChunk(docSnap: FirebaseFirestore.DocumentSnapshot): DocumentChunk | null {
  if (!docSnap.exists) return null;

  const data = docSnap.data()!;
  return {
    id: docSnap.id,
    documentId: data.documentId,
    content: data.content,
    metadata: {
      page: data.metadata?.page,
      section: data.metadata?.section,
      startChar: data.metadata?.startChar ?? 0,
      endChar: data.metadata?.endChar ?? 0,
    },
    chunkIndex: data.chunkIndex,
    tokenCount: data.tokenCount,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    // Knowledge Tab Sprint fields
    documentVersion: data.documentVersion,
    archived: data.archived,
    embedding: data.embedding,
    embeddingModel: data.embeddingModel,
    embeddedAt: data.embeddedAt?.toMillis?.() ?? data.embeddedAt,
  };
}

/**
 * Convert a `CreateDocumentChunkInput` to Firestore write format. Admin-SDK
 * mirror of `chunkToFirestore` from `document-chunk-service.ts`: copies the base
 * fields and only the defined optional (Knowledge Tab Sprint) fields, converting
 * `embeddedAt` millis to the ADMIN `Timestamp`. Behaviour is identical to the
 * client mapper apart from the Timestamp implementation (both expose
 * `.toMillis()`).
 */
function chunkToFirestore(chunk: CreateDocumentChunkInput): Record<string, unknown> {
  const data: Record<string, unknown> = {
    documentId: chunk.documentId,
    content: chunk.content,
    metadata: chunk.metadata,
    chunkIndex: chunk.chunkIndex,
    tokenCount: chunk.tokenCount,
  };

  // Knowledge Tab Sprint fields
  if (chunk.documentVersion !== undefined) data.documentVersion = chunk.documentVersion;
  // `archived` is ALWAYS persisted (UX-060) — mirrors the client mapper. See
  // document-chunk-activity.ts for why a missing flag broke every reader.
  data.archived = chunk.archived ?? false;
  if (chunk.embedding !== undefined) data.embedding = chunk.embedding;
  if (chunk.embeddingModel !== undefined) data.embeddingModel = chunk.embeddingModel;
  if (chunk.embeddedAt !== undefined) data.embeddedAt = Timestamp.fromMillis(chunk.embeddedAt);

  return data;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all chunks for a document. Admin-SDK mirror of `getChunksForDocument`:
 * equality-query on `documentId` + `orderBy('chunkIndex','asc')`.
 *
 * @param documentId - Parent document ID
 * @returns Array of chunks ordered by index
 */
export async function adminGetChunksForDocument(documentId: string): Promise<DocumentChunk[]> {
  try {
    const snapshot = await db
      .collection(COLLECTION_NAME)
      .where('documentId', '==', documentId)
      .orderBy('chunkIndex', 'asc')
      .get();

    return snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
  } catch (error) {
    log.error('Error getting chunks for document', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}

/**
 * How many chunk documents one bounded active-chunk read may fetch.
 *
 * The active-generation filter CANNOT be pushed into Firestore: chunks written
 * before `document-chunk-activity.ts` omit the `archived` field entirely, and an
 * `!=` / `==` filter matches only documents where the field EXISTS — the exact
 * bug that hid real content from the Preview dialog (UX-060). So the read stays
 * document-scoped and ordered, and the generation filter runs in memory.
 *
 * 64 is derived, not arbitrary. A caller needs enough ACTIVE chunks to fill its
 * byte budget: `BUILD_CONTEXT_MAX_ITEM_BYTES` (4 KB) at the default 1 KB chunk
 * size is ~5 chunks. `cleanupArchivedChunks` keeps 3 archived generations, so up
 * to 4 generations can interleave under the `chunkIndex` ordering → ~20 chunk
 * documents to reach those 5. 64 leaves >3x headroom while keeping the read
 * bounded for a thousand-chunk book.
 */
export const ADMIN_ACTIVE_CHUNK_READ_LIMIT = 64;

/**
 * Get the CURRENT-generation chunks for a document. Admin-SDK counterpart of
 * `getActiveChunksForDocument`, with an explicit read bound.
 *
 * Shares {@link filterActiveChunks} with the client service and every other
 * reader, so "which chunks are current" keeps exactly one definition.
 *
 * @param documentId - Parent document ID
 * @param options - `maxChunks` caps the chunk documents fetched before
 *   filtering (default {@link ADMIN_ACTIVE_CHUNK_READ_LIMIT}). A document with
 *   more archived chunks than this ahead of its active ones reads as SHORT
 *   rather than complete; callers must surface that as truncation, never as
 *   "no content".
 * @returns Active chunks ordered by index
 */
export async function adminGetActiveChunksForDocument(
  documentId: string,
  options?: { maxChunks?: number }
): Promise<DocumentChunk[]> {
  const maxChunks = options?.maxChunks ?? ADMIN_ACTIVE_CHUNK_READ_LIMIT;
  try {
    const snapshot = await db
      .collection(COLLECTION_NAME)
      .where('documentId', '==', documentId)
      .orderBy('chunkIndex', 'asc')
      .limit(maxChunks)
      .get();

    const chunks = snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
    return filterActiveChunks(chunks);
  } catch (error) {
    log.error('Error getting active chunks for document', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}

/**
 * Get a chunk by ID. Admin-SDK mirror of `getChunkById`.
 *
 * @param id - Chunk ID
 * @returns DocumentChunk or null if not found
 */
export async function adminGetChunkById(id: string): Promise<DocumentChunk | null> {
  try {
    const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
    return firestoreToChunk(docSnap);
  } catch (error) {
    log.error('Error getting chunk', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

// ============================================================================
// SEARCH HELPERS (Firestore-based, not semantic)
// ============================================================================

/**
 * Simple text search in chunks (not semantic). Admin-SDK mirror of
 * `searchChunksSimple`: when a `documentId` is supplied it reads that document's
 * chunks (via `adminGetChunksForDocument`); otherwise it reads up to 1000 chunks
 * from the collection, then applies the same fuzzy match. For semantic search,
 * use the Neo4j vector search service.
 *
 * @param searchQuery - Text to search for
 * @param documentId - Optional document ID to limit search
 * @param limit - Maximum results
 * @returns Array of matching chunks
 */
export async function adminSearchChunksSimple(
  searchQuery: string,
  documentId?: string,
  limit = 20
): Promise<DocumentChunk[]> {
  try {
    let chunks: DocumentChunk[];

    if (documentId) {
      chunks = await adminGetChunksForDocument(documentId);
    } else {
      // Get all chunks (limited) - not efficient for large datasets
      const snapshot = await db.collection(COLLECTION_NAME).limit(1000).get();
      chunks = snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
    }

    // UX-060: search must never return a SUPERSEDED generation as if it were
    // current. This was harmless while `archiveChunksForDocument` archived
    // nothing; now that archiving works, a refreshed document really does hold
    // old chunks, and quoting them back as evidence would be a false citation.
    chunks = filterActiveChunks(chunks);

    // Use fuzzy search for better matching (supports partial matches, similar terms)
    const results = fuzzySearchWithScores(chunks, searchQuery, {
      keys: ['content'] as (keyof DocumentChunk)[],
      threshold: 0.15, // Lower threshold for document content to catch more relevant chunks
      limit,
    });

    return results.map((r) => r.item);
  } catch (error) {
    log.error('Error in simple search', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create multiple chunks in batch. Admin-SDK mirror of `createChunks`:
 * stamps a single `createdAt` (`Timestamp.now()`) on every chunk, generates an
 * auto-ID per chunk via `db.collection().doc()`, batches at 500 ops (the
 * Firestore batch limit), and returns the generated IDs in input order. No-ops
 * (returns `[]`) on an empty input, identical to the client service.
 *
 * @param chunks - Array of chunk data
 * @returns Array of created chunk IDs
 */
export async function adminCreateChunks(chunks: CreateDocumentChunkInput[]): Promise<string[]> {
  if (chunks.length === 0) return [];

  try {
    const collectionRef = db.collection(COLLECTION_NAME);
    const now = Timestamp.now();
    const chunkIds: string[] = [];

    // Firestore batches are limited to 500 operations
    const batchSize = 500;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = db.batch();
      const batchChunks = chunks.slice(i, i + batchSize);

      for (const chunk of batchChunks) {
        const newDocRef = collectionRef.doc();
        batch.set(newDocRef, {
          ...chunkToFirestore(chunk),
          createdAt: now,
        });
        chunkIds.push(newDocRef.id);
      }

      await batch.commit();
    }

    log.info('Created chunks', { count: chunkIds.length });
    return chunkIds;
  } catch (error) {
    log.error('Error creating chunks', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Persist a freshly generated embedding back to the Firestore chunk. Admin-SDK
 * mirror of `updateChunkEmbedding` from `document-chunk-service.ts`, wired for
 * the Neo4j document-sync worker (H7): without this write-back EVERY document
 * re-sync regenerated embeddings for ALL chunks. Refuses empty vectors — see
 * {@link EmptyEmbeddingError}.
 *
 * @param id - Chunk ID
 * @param embedding - Non-empty embedding vector
 * @param model - Embedding model identifier stored alongside the vector
 */
export async function adminUpdateChunkEmbedding(id: string, embedding: number[], model: string): Promise<void> {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new EmptyEmbeddingError(id);
  }

  try {
    await db.collection(COLLECTION_NAME).doc(id).update({
      embedding,
      embeddingModel: model,
      embeddedAt: Timestamp.now(),
    });
  } catch (error) {
    log.error('Error updating embedding for chunk (admin)', error instanceof Error ? error : new Error(String(error)), {
      id,
    });
    throw error;
  }
}

/**
 * Delete all chunks for a document. Admin-SDK mirror of `deleteChunksForDocument`:
 * equality-query on `documentId`, returns 0 when empty, otherwise batched deletes
 * (500 per batch) and returns the number of chunks removed.
 *
 * @param documentId - Parent document ID
 * @returns Number of chunks deleted
 */
export async function adminDeleteChunksForDocument(documentId: string): Promise<number> {
  try {
    const snapshot = await db.collection(COLLECTION_NAME).where('documentId', '==', documentId).get();

    if (snapshot.empty) return 0;

    // Delete in batches of 500
    const batchSize = 500;
    const docs = snapshot.docs;
    let deleted = 0;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const batchDocs = docs.slice(i, i + batchSize);

      for (const docSnap of batchDocs) {
        batch.delete(docSnap.ref);
      }

      await batch.commit();
      deleted += batchDocs.length;
    }

    log.info('Deleted chunks for document', { deleted, documentId });
    return deleted;
  } catch (error) {
    log.error('Error deleting chunks', error instanceof Error ? error : new Error(String(error)), { documentId });
    throw error;
  }
}
