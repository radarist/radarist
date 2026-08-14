/**
 * @file lib/document-chunk-service.ts
 * @description Service for managing document chunks in the Evidence Layer.
 * Chunks are paragraphs/sections extracted from documents for semantic search.
 *
 * Note: Embeddings are stored in Neo4j, NOT in Firestore.
 * This service handles the Firestore side (content + metadata).
 * For vector search, see the Neo4j vector-search service (Phase 2 Neo4j tasks).
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
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit as limitQuery,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { fuzzySearchWithScores } from '@/lib/fuzzy-search';
import { filterActiveChunks, isActiveChunk } from '@/lib/document-chunk-activity';
import type { DocumentChunk, CreateDocumentChunkInput } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('document-chunk-service');

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'documentChunks';

/**
 * Default chunk size in characters for text splitting.
 * Optimized for embedding models (typically 512-1024 tokens).
 */
export const DEFAULT_CHUNK_SIZE = 1000;

/**
 * Overlap between chunks to maintain context.
 */
export const DEFAULT_CHUNK_OVERLAP = 200;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert Firestore document to DocumentChunk type.
 */
function firestoreToChunk(docSnap: import('firebase/firestore').DocumentSnapshot): DocumentChunk | null {
  if (!docSnap.exists()) return null;

  const data = docSnap.data();
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
 * Convert DocumentChunk to Firestore format for writing.
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
  // `archived` is ALWAYS persisted (UX-060). Copying it only when defined left
  // every normally-produced chunk without the field, and Firestore inequality
  // filters skip documents whose field is missing — see document-chunk-activity.ts.
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
 * Get all chunks for a document.
 *
 * @param documentId - Parent document ID
 * @returns Array of chunks ordered by index
 */
export async function getChunksForDocument(documentId: string): Promise<DocumentChunk[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('documentId', '==', documentId), orderBy('chunkIndex', 'asc'));

    const snapshot = await getDocs(q);
    return snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
  } catch (error) {
    log.error('Error getting chunks for document', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}

/**
 * Get a chunk by ID.
 *
 * @param id - Chunk ID
 * @returns DocumentChunk or null if not found
 */
export async function getChunkById(id: string): Promise<DocumentChunk | null> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);
    return firestoreToChunk(docSnap);
  } catch (error) {
    log.error('Error getting chunk', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get multiple chunks by IDs.
 * Useful for retrieving chunks from search results.
 *
 * @param ids - Array of chunk IDs
 * @returns Array of chunks (in order of input IDs)
 */
export async function getChunksByIds(ids: string[]): Promise<DocumentChunk[]> {
  if (ids.length === 0) return [];

  try {
    const chunks: DocumentChunk[] = [];

    // Firestore doesn't support IN queries > 30 items, so we batch
    const batchSize = 30;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      const batchPromises = batchIds.map((id) => getChunkById(id));
      const batchResults = await Promise.all(batchPromises);
      chunks.push(...batchResults.filter((c): c is DocumentChunk => c !== null));
    }

    // Maintain order of input IDs
    const chunkMap = new Map(chunks.map((c) => [c.id, c]));
    return ids.map((id) => chunkMap.get(id)).filter((c): c is DocumentChunk => c !== undefined);
  } catch (error) {
    log.error('Error getting chunks by IDs', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Get chunk count for a document.
 *
 * @param documentId - Parent document ID
 * @returns Number of chunks
 */
export async function getChunkCountForDocument(documentId: string): Promise<number> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('documentId', '==', documentId));
    const snapshot = await getDocs(q);
    return snapshot.size;
  } catch (error) {
    log.error('Error getting chunk count', error instanceof Error ? error : new Error(String(error)), { documentId });
    throw error;
  }
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create a single chunk.
 *
 * @param input - Chunk data
 * @returns Created chunk with generated ID
 */
export async function createChunk(input: CreateDocumentChunkInput): Promise<DocumentChunk> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const docData = {
      ...chunkToFirestore(input),
      createdAt: Timestamp.now(),
    };

    const docRef = await addDoc(collectionRef, docData);

    const created = await getChunkById(docRef.id);
    if (!created) {
      throw new Error('Failed to retrieve created chunk');
    }

    return created;
  } catch (error) {
    log.error('Error creating chunk', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Create multiple chunks in batch.
 * More efficient than creating one at a time.
 *
 * @param chunks - Array of chunk data
 * @returns Array of created chunk IDs
 */
export async function createChunks(chunks: CreateDocumentChunkInput[]): Promise<string[]> {
  if (chunks.length === 0) return [];

  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const now = Timestamp.now();
    const chunkIds: string[] = [];

    // Firestore batches are limited to 500 operations
    const batchSize = 500;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = writeBatch(db);
      const batchChunks = chunks.slice(i, i + batchSize);

      for (const chunk of batchChunks) {
        const newDocRef = doc(collectionRef);
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
 * Delete a chunk.
 *
 * @param id - Chunk ID
 */
export async function deleteChunk(id: string): Promise<void> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    await deleteDoc(docRef);
  } catch (error) {
    log.error('Error deleting chunk', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Delete all chunks for a document.
 * Use when deleting a document or reprocessing it.
 *
 * @param documentId - Parent document ID
 * @returns Number of chunks deleted
 */
export async function deleteChunksForDocument(documentId: string): Promise<number> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('documentId', '==', documentId));
    const snapshot = await getDocs(q);

    if (snapshot.empty) return 0;

    // Delete in batches of 500
    const batchSize = 500;
    const docs = snapshot.docs;
    let deleted = 0;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = writeBatch(db);
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

// ============================================================================
// TEXT PROCESSING UTILITIES
// ============================================================================

/**
 * Split text into chunks with overlap.
 * Uses paragraph boundaries when possible.
 *
 * @param text - Full text to split
 * @param options - Chunking options
 * @returns Array of text chunks with metadata
 */
export function splitTextIntoChunks(
  text: string,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
    preserveParagraphs?: boolean;
  }
): Array<{ content: string; startChar: number; endChar: number }> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const preserveParagraphs = options?.preserveParagraphs ?? true;

  const chunks: Array<{ content: string; startChar: number; endChar: number }> = [];

  if (preserveParagraphs) {
    // Split by paragraphs first, then combine
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';
    let startChar = 0;
    let currentStart = 0;

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length + 2 <= chunkSize) {
        // Add paragraph to current chunk
        if (currentChunk) {
          currentChunk += '\n\n';
        }
        currentChunk += paragraph;
      } else {
        // Save current chunk and start new one
        if (currentChunk) {
          chunks.push({
            content: currentChunk.trim(),
            startChar: currentStart,
            endChar: startChar - 2, // Exclude the \n\n
          });
        }
        currentStart = startChar;
        currentChunk = paragraph;
      }
      startChar += paragraph.length + 2; // Account for \n\n
    }

    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push({
        content: currentChunk.trim(),
        startChar: currentStart,
        endChar: text.length,
      });
    }
  } else {
    // Simple character-based splitting with overlap
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push({
        content: text.slice(start, end).trim(),
        startChar: start,
        endChar: end,
      });
      start = end - chunkOverlap;
      if (start >= text.length - chunkOverlap) break;
    }
  }

  return chunks;
}

/**
 * Estimate token count for text.
 * Uses a simple heuristic (4 chars ≈ 1 token).
 *
 * @param text - Text to estimate
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
  // Simple heuristic: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

// ============================================================================
// CHUNK PREPARATION FOR EMBEDDING
// ============================================================================

/**
 * Prepare chunks from document text.
 * Creates chunk objects ready for batch insertion.
 *
 * @param documentId - Parent document ID
 * @param text - Full document text
 * @param options - Chunking options
 * @returns Array of chunk input objects
 */
export function prepareChunksFromText(
  documentId: string,
  text: string,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
  }
): CreateDocumentChunkInput[] {
  const textChunks = splitTextIntoChunks(text, options);

  return textChunks.map((chunk, index) => ({
    documentId,
    content: chunk.content,
    metadata: {
      startChar: chunk.startChar,
      endChar: chunk.endChar,
    },
    chunkIndex: index,
    tokenCount: estimateTokenCount(chunk.content),
  }));
}

/**
 * Prepare chunks from PDF pages.
 * Preserves page metadata.
 *
 * @param documentId - Parent document ID
 * @param pages - Array of page objects with text and page number
 * @param options - Chunking options
 * @returns Array of chunk input objects
 */
export function prepareChunksFromPages(
  documentId: string,
  pages: Array<{ text: string; pageNumber: number }>,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
  }
): CreateDocumentChunkInput[] {
  const allChunks: CreateDocumentChunkInput[] = [];
  let globalIndex = 0;
  let globalStartChar = 0;

  for (const page of pages) {
    const pageChunks = splitTextIntoChunks(page.text, options);

    for (const chunk of pageChunks) {
      allChunks.push({
        documentId,
        content: chunk.content,
        metadata: {
          page: page.pageNumber,
          startChar: globalStartChar + chunk.startChar,
          endChar: globalStartChar + chunk.endChar,
        },
        chunkIndex: globalIndex++,
        tokenCount: estimateTokenCount(chunk.content),
      });
    }

    globalStartChar += page.text.length + 1; // Account for page separator
  }

  return allChunks;
}

// ============================================================================
// SEARCH HELPERS (Firestore-based, not semantic)
// ============================================================================

/**
 * Simple text search in chunks (not semantic).
 * Uses fuzzy matching for better search results.
 * For semantic search, use the Neo4j vector search service.
 *
 * @param searchQuery - Text to search for
 * @param documentId - Optional document ID to limit search
 * @param limit - Maximum results
 * @returns Array of matching chunks
 */
export async function searchChunksSimple(
  searchQuery: string,
  documentId?: string,
  limit = 20
): Promise<DocumentChunk[]> {
  try {
    let chunks: DocumentChunk[];

    if (documentId) {
      chunks = await getChunksForDocument(documentId);
    } else {
      // Get all chunks (limited) - not efficient for large datasets
      const collectionRef = collection(db, COLLECTION_NAME);
      const q = query(collectionRef, limitQuery(1000));
      const snapshot = await getDocs(q);
      chunks = snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
    }

    // UX-060: search must never return a SUPERSEDED generation as if it were
    // current — see the admin twin for why this became reachable.
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
// VERSIONING & ARCHIVING (Knowledge Tab Sprint)
// ============================================================================

/**
 * Get only active (non-archived) chunks for a document.
 * Use this for new searches; archived chunks are preserved for citation integrity.
 *
 * @param documentId - Parent document ID
 * @returns Array of active chunks ordered by index
 * @phase Knowledge Tab Sprint
 */
export async function getActiveChunksForDocument(documentId: string): Promise<DocumentChunk[]> {
  // UX-060: this used a `where('archived', '!=', true)` filter, which drops
  // every chunk whose `archived` field is MISSING — i.e. every chunk the
  // processing pipeline had ever written. The Preview dialog therefore
  // reported "No extracted text yet" for documents with real content while
  // the sheet's Chunks tab listed those same chunks.
  //
  // The document-scoped read is bounded (chunks belong to exactly one
  // document), so filtering in memory through the shared predicate is both
  // correct for legacy data and cheaper than maintaining a second composite
  // index. It also reuses the index `getChunksForDocument` already needs.
  const allChunks = await getChunksForDocument(documentId);
  return filterActiveChunks(allChunks);
}

/**
 * Get chunks for a specific document version.
 * Useful for displaying cited content from older versions.
 *
 * @param documentId - Parent document ID
 * @param version - Document version number
 * @returns Array of chunks for that version
 * @phase Knowledge Tab Sprint
 */
export async function getChunksForDocumentVersion(documentId: string, version: number): Promise<DocumentChunk[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(
      collectionRef,
      where('documentId', '==', documentId),
      where('documentVersion', '==', version),
      orderBy('chunkIndex', 'asc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);
  } catch (error) {
    log.error('Error getting chunks for version', error instanceof Error ? error : new Error(String(error)), {
      version,
    });
    throw error;
  }
}

/**
 * Archive all chunks for a document.
 * Called before creating new chunks when document is refreshed.
 * Preserves old chunks for citation integrity.
 *
 * @param documentId - Parent document ID
 * @returns Number of chunks archived
 * @phase Knowledge Tab Sprint
 */
export async function archiveChunksForDocument(documentId: string): Promise<number> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    // UX-060: `where('archived', '!=', true)` skipped every chunk missing the
    // field, so a refresh archived NOTHING and appended a new generation next
    // to the stale one. Read the document's chunks and apply the shared
    // predicate instead — see document-chunk-activity.ts.
    const q = query(collectionRef, where('documentId', '==', documentId));

    const snapshot = await getDocs(q);
    const docs = snapshot.docs.filter((docSnap) => isActiveChunk(docSnap.data() as { archived?: boolean }));
    if (docs.length === 0) return 0;

    // Update in batches of 500
    const batchSize = 500;
    let archived = 0;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = writeBatch(db);
      const batchDocs = docs.slice(i, i + batchSize);

      for (const docSnap of batchDocs) {
        batch.update(docSnap.ref, { archived: true });
      }

      await batch.commit();
      archived += batchDocs.length;
    }

    log.info('Archived chunks for document', { archived, documentId });
    return archived;
  } catch (error) {
    log.error('Error archiving chunks', error instanceof Error ? error : new Error(String(error)), { documentId });
    throw error;
  }
}

/**
 * Create versioned chunks for a document.
 * Sets documentVersion and archived=false for new chunks.
 *
 * @param chunks - Array of chunk data
 * @param documentVersion - Version number of the document
 * @returns Array of created chunk IDs
 * @phase Knowledge Tab Sprint
 */
export async function createVersionedChunks(
  chunks: CreateDocumentChunkInput[],
  documentVersion: number
): Promise<string[]> {
  if (chunks.length === 0) return [];

  // Add version info to each chunk
  const versionedChunks = chunks.map((chunk) => ({
    ...chunk,
    documentVersion,
    archived: false,
  }));

  return createChunks(versionedChunks);
}

/**
 * Clean up old archived chunks beyond a retention limit.
 * Keeps the most recent N versions and deletes older ones.
 *
 * @param documentId - Parent document ID
 * @param versionsToKeep - Number of versions to retain (default: 3)
 * @returns Number of chunks deleted
 * @phase Knowledge Tab Sprint
 */
export async function cleanupArchivedChunks(documentId: string, versionsToKeep = 3): Promise<number> {
  try {
    const allChunks = await getChunksForDocument(documentId);
    const archivedChunks = allChunks.filter((c) => c.archived);

    if (archivedChunks.length === 0) return 0;

    // Get unique versions and sort descending
    const versions = [...new Set(archivedChunks.map((c) => c.documentVersion ?? 0))].sort((a, b) => b - a);

    // Keep the most recent versions, delete older ones
    const versionsToDelete = versions.slice(versionsToKeep);
    if (versionsToDelete.length === 0) return 0;

    const chunksToDelete = archivedChunks.filter((c) => versionsToDelete.includes(c.documentVersion ?? 0));

    if (chunksToDelete.length === 0) return 0;

    // Delete in batches
    const batchSize = 500;
    let deleted = 0;

    for (let i = 0; i < chunksToDelete.length; i += batchSize) {
      const batch = writeBatch(db);
      const batchChunks = chunksToDelete.slice(i, i + batchSize);

      for (const chunk of batchChunks) {
        const docRef = doc(db, COLLECTION_NAME, chunk.id);
        batch.delete(docRef);
      }

      await batch.commit();
      deleted += batchChunks.length;
    }

    log.info('Cleaned up archived chunks', {
      deleted,
      documentId,
      keptVersions: versions.slice(0, versionsToKeep).join(', '),
    });
    return deleted;
  } catch (error) {
    log.error('Error cleaning up archived chunks', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}

/**
 * Update a chunk with embedding data.
 *
 * @param id - Chunk ID
 * @param embedding - 768-dimensional embedding vector
 * @param model - Model used to generate embedding
 * @phase Knowledge Tab Sprint
 */
export async function updateChunkEmbedding(
  id: string,
  embedding: number[],
  model = 'text-embedding-004'
): Promise<void> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    await updateDoc(docRef, {
      embedding,
      embeddingModel: model,
      embeddedAt: Timestamp.now(),
    });
  } catch (error) {
    log.error('Error updating embedding for chunk', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get chunks that need embeddings generated.
 *
 * @param documentId - Optional document ID to limit scope
 * @param limit - Maximum results
 * @returns Array of chunks without embeddings
 * @phase Knowledge Tab Sprint
 */
export async function getChunksNeedingEmbeddings(documentId?: string, limit = 100): Promise<DocumentChunk[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    let q;

    // UX-060: the archived filter must NOT run in the query — an inequality
    // filter drops chunks whose `archived` field is missing, which is exactly
    // the shape a chunk that has never been embedded has. Fetch the page, then
    // apply the shared predicate (see document-chunk-activity.ts).
    if (documentId) {
      q = query(collectionRef, where('documentId', '==', documentId), limitQuery(limit));
    } else {
      q = query(collectionRef, limitQuery(limit));
    }

    const snapshot = await getDocs(q);
    const chunks = snapshot.docs.map(firestoreToChunk).filter((c): c is DocumentChunk => c !== null);

    // Filter to the current generation, then to chunks without embeddings
    return filterActiveChunks(chunks).filter((c) => !c.embedding || c.embedding.length === 0);
  } catch (error) {
    log.error('Error getting chunks needing embeddings', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
