/**
 * Unit Tests for Document Chunk Service (Phase 2: Evidence Layer)
 *
 * Tests CRUD operations and utilities for DocumentChunk:
 * - getChunksForDocument - Fetch all chunks for a document
 * - getChunkById - Single fetch by ID
 * - getChunksByIds - Batch fetch by IDs
 * - createChunk - Create single chunk
 * - createChunks - Batch create chunks
 * - deleteChunk - Delete single chunk
 * - deleteChunksForDocument - Delete all chunks for document
 * - splitTextIntoChunks - Text chunking utility
 * - estimateTokenCount - Token estimation
 * - prepareChunksFromText - Prepare chunks from text
 * - prepareChunksFromPages - Prepare chunks from PDF pages
 */

import type { DocumentChunk, CreateDocumentChunkInput } from '../types';

// Mock firebase module
jest.mock('../firebase', () => ({
  db: {},
}));

// Mock firebase/firestore module with jest.fn() in factory
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  addDoc: jest.fn(),
  deleteDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  writeBatch: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

// Import the service functions (after mocks are set up)
import {
  getChunksForDocument,
  getChunkById,
  getChunksByIds,
  getChunkCountForDocument,
  createChunk,
  createChunks,
  deleteChunk,
  deleteChunksForDocument,
  splitTextIntoChunks,
  estimateTokenCount,
  prepareChunksFromText,
  prepareChunksFromPages,
  searchChunksSimple,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  // Knowledge Tab Sprint functions
  getActiveChunksForDocument,
  getChunksForDocumentVersion,
  archiveChunksForDocument,
  createVersionedChunks,
  cleanupArchivedChunks,
  updateChunkEmbedding,
  getChunksNeedingEmbeddings,
} from '../document-chunk-service';

// Import the mocked module to get references to the mocks
import {
  getDocs,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore';

// Re-export as typed mocks for use in tests
const firestoreMocks = {
  getDocs: getDocs as jest.Mock,
  getDoc: getDoc as jest.Mock,
  addDoc: addDoc as jest.Mock,
  deleteDoc: deleteDoc as jest.Mock,
  updateDoc: updateDoc as jest.Mock,
  writeBatch: writeBatch as jest.Mock,
  collection: collection as jest.Mock,
  doc: doc as jest.Mock,
  query: query as jest.Mock,
  where: where as jest.Mock,
  orderBy: orderBy as jest.Mock,
  limit: limit as jest.Mock,
  Timestamp: Timestamp as unknown as { now: jest.Mock; fromMillis: jest.Mock },
};

/**
 * Helper to create a mock chunk for testing
 */
function createMockChunk(overrides?: Partial<DocumentChunk>): DocumentChunk {
  return {
    id: 'chunk-123',
    documentId: 'doc-456',
    content: 'This is the content of the chunk. It contains sample text for testing purposes.',
    metadata: {
      startChar: 0,
      endChar: 81,
    },
    chunkIndex: 0,
    tokenCount: 20,
    createdAt: Date.now(),
    // Knowledge Tab Sprint fields
    documentVersion: overrides?.documentVersion,
    archived: overrides?.archived,
    embedding: overrides?.embedding,
    embeddingModel: overrides?.embeddingModel,
    embeddedAt: overrides?.embeddedAt,
    ...overrides,
  };
}

/**
 * Helper to create mock docs response
 */
function createMockDocsResponse(chunks: DocumentChunk[]) {
  return {
    docs: chunks.map((c) => ({
      id: c.id,
      exists: () => true,
      data: () => ({
        ...c,
        createdAt: { toMillis: () => c.createdAt },
        embeddedAt: c.embeddedAt ? { toMillis: () => c.embeddedAt } : undefined,
      }),
      ref: { id: c.id },
    })),
    empty: chunks.length === 0,
    size: chunks.length,
  };
}

/**
 * Helper to create mock doc response
 */
function createMockDocResponse(chunk: DocumentChunk | null) {
  if (!chunk) {
    return { exists: () => false };
  }
  return {
    exists: () => true,
    id: chunk.id,
    data: () => ({
      ...chunk,
      createdAt: { toMillis: () => chunk.createdAt },
    }),
  };
}

describe('Document Chunk Service (Evidence Layer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set default behaviors for mocks
    firestoreMocks.getDocs.mockResolvedValue({ empty: true, docs: [], size: 0 });
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => false });
    firestoreMocks.addDoc.mockResolvedValue({ id: 'new-chunk-id' });
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.doc.mockReturnValue({ id: 'new-chunk-id' });
    firestoreMocks.writeBatch.mockReturnValue({
      set: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    });
  });

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  describe('Constants', () => {
    it('should have default chunk size of 1000', () => {
      expect(DEFAULT_CHUNK_SIZE).toBe(1000);
    });

    it('should have default overlap of 200', () => {
      expect(DEFAULT_CHUNK_OVERLAP).toBe(200);
    });
  });

  // ============================================================================
  // GET OPERATIONS
  // ============================================================================

  describe('getChunksForDocument()', () => {
    it('should fetch all chunks for a document', async () => {
      const mockChunk1 = createMockChunk({ id: 'chunk-1', chunkIndex: 0 });
      const mockChunk2 = createMockChunk({ id: 'chunk-2', chunkIndex: 1 });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockChunk1, mockChunk2]));

      const result = await getChunksForDocument('doc-456');

      expect(result).toHaveLength(2);
      expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no chunks exist', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getChunksForDocument('doc-empty');

      expect(result).toHaveLength(0);
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getChunksForDocument('doc-456')).rejects.toThrow();
    });
  });

  describe('getChunkById()', () => {
    it('should fetch chunk by ID', async () => {
      const mockChunk = createMockChunk();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockChunk));

      const result = await getChunkById('chunk-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('chunk-123');
      expect(firestoreMocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when chunk not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      const result = await getChunkById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getChunksByIds()', () => {
    it('should fetch multiple chunks by IDs', async () => {
      const mockChunk1 = createMockChunk({ id: 'chunk-1' });
      const mockChunk2 = createMockChunk({ id: 'chunk-2' });

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(mockChunk1))
        .mockResolvedValueOnce(createMockDocResponse(mockChunk2));

      const result = await getChunksByIds(['chunk-1', 'chunk-2']);

      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty input', async () => {
      const result = await getChunksByIds([]);

      expect(result).toHaveLength(0);
      expect(firestoreMocks.getDoc).not.toHaveBeenCalled();
    });

    it('should maintain order of input IDs', async () => {
      const mockChunk1 = createMockChunk({ id: 'chunk-1' });
      const mockChunk2 = createMockChunk({ id: 'chunk-2' });

      // Return in reverse order
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(mockChunk1))
        .mockResolvedValueOnce(createMockDocResponse(mockChunk2));

      const result = await getChunksByIds(['chunk-1', 'chunk-2']);

      expect(result[0].id).toBe('chunk-1');
      expect(result[1].id).toBe('chunk-2');
    });

    it('should filter out non-existent chunks', async () => {
      const mockChunk1 = createMockChunk({ id: 'chunk-1' });

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(mockChunk1))
        .mockResolvedValueOnce(createMockDocResponse(null));

      const result = await getChunksByIds(['chunk-1', 'nonexistent']);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-1');
    });
  });

  describe('getChunkCountForDocument()', () => {
    it('should return chunk count', async () => {
      const chunks = [
        createMockChunk({ id: 'chunk-1' }),
        createMockChunk({ id: 'chunk-2' }),
        createMockChunk({ id: 'chunk-3' }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      const result = await getChunkCountForDocument('doc-456');

      expect(result).toBe(3);
    });

    it('should return 0 for no chunks', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getChunkCountForDocument('doc-empty');

      expect(result).toBe(0);
    });
  });

  // ============================================================================
  // CREATE OPERATIONS
  // ============================================================================

  describe('createChunk()', () => {
    it('should create a single chunk', async () => {
      const mockCreatedChunk = createMockChunk({ id: 'new-chunk-id' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockCreatedChunk));

      const result = await createChunk({
        documentId: 'doc-456',
        content: 'Test content',
        metadata: { startChar: 0, endChar: 12 },
        chunkIndex: 0,
        tokenCount: 3,
      });

      expect(result.documentId).toBe('doc-456');
      expect(firestoreMocks.addDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle creation errors', async () => {
      firestoreMocks.addDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        createChunk({
          documentId: 'doc-456',
          content: 'Test',
          metadata: { startChar: 0, endChar: 4 },
          chunkIndex: 0,
        })
      ).rejects.toThrow();
    });
  });

  describe('createChunks()', () => {
    it('should create multiple chunks in batch', async () => {
      const chunkInputs: CreateDocumentChunkInput[] = [
        { documentId: 'doc-456', content: 'Chunk 1', metadata: { startChar: 0, endChar: 7 }, chunkIndex: 0 },
        { documentId: 'doc-456', content: 'Chunk 2', metadata: { startChar: 8, endChar: 15 }, chunkIndex: 1 },
      ];

      const result = await createChunks(chunkInputs);

      expect(result).toHaveLength(2);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should return empty array for empty input', async () => {
      const result = await createChunks([]);

      expect(result).toHaveLength(0);
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
    });

    it('should handle batch errors', async () => {
      firestoreMocks.writeBatch.mockReturnValueOnce({
        set: jest.fn(),
        commit: jest.fn().mockRejectedValue(new Error('Batch failed')),
      });

      await expect(
        createChunks([
          { documentId: 'doc-456', content: 'Test', metadata: { startChar: 0, endChar: 4 }, chunkIndex: 0 },
        ])
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // DELETE OPERATIONS
  // ============================================================================

  describe('deleteChunk()', () => {
    it('should delete a chunk by ID', async () => {
      await deleteChunk('chunk-123');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle deletion errors', async () => {
      firestoreMocks.deleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteChunk('chunk-123')).rejects.toThrow();
    });
  });

  describe('deleteChunksForDocument()', () => {
    it('should delete all chunks for a document', async () => {
      const chunks = [
        createMockChunk({ id: 'chunk-1' }),
        createMockChunk({ id: 'chunk-2' }),
        createMockChunk({ id: 'chunk-3' }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      const result = await deleteChunksForDocument('doc-456');

      expect(result).toBe(3);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should return 0 for document with no chunks', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await deleteChunksForDocument('doc-empty');

      expect(result).toBe(0);
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // TEXT PROCESSING UTILITIES
  // ============================================================================

  describe('splitTextIntoChunks()', () => {
    it('should split text into chunks by paragraphs', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

      const result = splitTextIntoChunks(text);

      expect(result).toHaveLength(1); // All fit in one chunk with default size
      expect(result[0].content).toContain('First paragraph');
    });

    it('should respect chunk size limit', () => {
      const text = 'A'.repeat(500) + '\n\n' + 'B'.repeat(500) + '\n\n' + 'C'.repeat(500);

      const result = splitTextIntoChunks(text, { chunkSize: 600 });

      expect(result.length).toBeGreaterThan(1);
    });

    it('should use character-based splitting when preserveParagraphs is false', () => {
      const text = 'This is a long text without paragraph breaks. '.repeat(50);

      const result = splitTextIntoChunks(text, {
        chunkSize: 200,
        chunkOverlap: 50,
        preserveParagraphs: false,
      });

      expect(result.length).toBeGreaterThan(1);
      result.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(200);
      });
    });

    it('should track start and end positions', () => {
      const text = 'First.\n\nSecond.\n\nThird.';

      const result = splitTextIntoChunks(text, { chunkSize: 5000 });

      expect(result[0].startChar).toBe(0);
      expect(result[0].endChar).toBeGreaterThan(0);
    });

    it('should handle empty text', () => {
      const result = splitTextIntoChunks('');

      expect(result).toHaveLength(0);
    });

    it('should handle single paragraph text', () => {
      const text = 'This is a single paragraph without any breaks.';

      const result = splitTextIntoChunks(text);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(text);
    });
  });

  describe('estimateTokenCount()', () => {
    it('should estimate tokens based on character count', () => {
      const text = 'Hello World'; // 11 characters

      const result = estimateTokenCount(text);

      // ~4 chars per token, so 11/4 ≈ 3
      expect(result).toBe(3);
    });

    it('should handle empty text', () => {
      const result = estimateTokenCount('');

      expect(result).toBe(0);
    });

    it('should round up token estimates', () => {
      const text = 'Hi'; // 2 characters

      const result = estimateTokenCount(text);

      expect(result).toBe(1); // ceil(2/4) = 1
    });
  });

  describe('prepareChunksFromText()', () => {
    it('should prepare chunk objects from text', () => {
      const text = 'Test document content for chunking.';

      const result = prepareChunksFromText('doc-123', text);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].documentId).toBe('doc-123');
      expect(result[0].chunkIndex).toBe(0);
      expect(result[0].tokenCount).toBeDefined();
    });

    it('should assign sequential chunk indexes', () => {
      const text = 'A'.repeat(500) + '\n\n' + 'B'.repeat(500) + '\n\n' + 'C'.repeat(500);

      const result = prepareChunksFromText('doc-123', text, { chunkSize: 600 });

      result.forEach((chunk, index) => {
        expect(chunk.chunkIndex).toBe(index);
      });
    });

    it('should include metadata with positions', () => {
      const text = 'Short text for testing.';

      const result = prepareChunksFromText('doc-123', text);

      expect(result[0].metadata.startChar).toBeDefined();
      expect(result[0].metadata.endChar).toBeDefined();
    });
  });

  describe('prepareChunksFromPages()', () => {
    it('should prepare chunks from PDF pages', () => {
      const pages = [
        { text: 'Page 1 content here.', pageNumber: 1 },
        { text: 'Page 2 content here.', pageNumber: 2 },
      ];

      const result = prepareChunksFromPages('doc-123', pages);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].metadata.page).toBe(1);
    });

    it('should track global chunk index across pages', () => {
      const pages = [
        { text: 'A'.repeat(1500), pageNumber: 1 }, // Will create multiple chunks
        { text: 'B'.repeat(500), pageNumber: 2 },
      ];

      const result = prepareChunksFromPages('doc-123', pages, { chunkSize: 600 });

      // All chunks should have sequential indexes
      const indexes = result.map((c) => c.chunkIndex);
      expect(indexes).toEqual([...Array(result.length).keys()]);
    });

    it('should preserve page number in metadata', () => {
      const pages = [
        { text: 'Content on page 5.', pageNumber: 5 },
        { text: 'Content on page 6.', pageNumber: 6 },
      ];

      const result = prepareChunksFromPages('doc-123', pages);

      expect(result[0].metadata.page).toBe(5);
    });

    it('should handle empty pages', () => {
      const pages = [
        { text: '', pageNumber: 1 },
        { text: 'Some content.', pageNumber: 2 },
      ];

      const result = prepareChunksFromPages('doc-123', pages);

      // Should only have chunks for non-empty pages
      expect(result.every((c) => c.content.length > 0)).toBe(true);
    });
  });

  // ============================================================================
  // SEARCH OPERATIONS
  // ============================================================================

  describe('searchChunksSimple()', () => {
    it('should search chunks by text content', async () => {
      const mockChunk1 = createMockChunk({ id: 'chunk-1', content: 'React is a JavaScript library.' });
      const mockChunk2 = createMockChunk({ id: 'chunk-2', content: 'Vue is also popular.' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockChunk1, mockChunk2]));

      const result = await searchChunksSimple('React', 'doc-123');

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('React');
    });

    it('should be case insensitive', async () => {
      const mockChunk = createMockChunk({ content: 'REACT is great' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockChunk]));

      const result = await searchChunksSimple('react', 'doc-123');

      expect(result).toHaveLength(1);
    });

    it('should limit results', async () => {
      const chunks = Array.from({ length: 50 }, (_, i) =>
        createMockChunk({ id: `chunk-${i}`, content: `Content ${i} with keyword` })
      );
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      const result = await searchChunksSimple('keyword', 'doc-123', 10);

      expect(result).toHaveLength(10);
    });

    it('should return empty array when no matches', async () => {
      const mockChunk = createMockChunk({ content: 'Some other content' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockChunk]));

      const result = await searchChunksSimple('nonexistent', 'doc-123');

      expect(result).toHaveLength(0);
    });
  });

  // ============================================================================
  // KNOWLEDGE TAB SPRINT: VERSIONING & ARCHIVING
  // ============================================================================

  describe('getActiveChunksForDocument() (Knowledge Tab Sprint)', () => {
    it('should return only non-archived chunks', async () => {
      const activeChunk = createMockChunk({ id: 'chunk-1', archived: false });
      const archivedChunk = createMockChunk({ id: 'chunk-2', archived: true });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([activeChunk, archivedChunk]));

      const result = await getActiveChunksForDocument('doc-456');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-1');
    });

    /**
     * UX-060 regression. The reader used `where('archived','!=',true)`, and a
     * Firestore inequality filter matches only documents where the field
     * EXISTS — while the chunk pipeline never wrote it. Every real chunk was
     * therefore invisible and the Preview dialog reported "No extracted text"
     * for documents with content. A missing flag MUST read as active.
     */
    it('treats a chunk with NO archived field as active', async () => {
      const legacyChunk = createMockChunk({ id: 'chunk-legacy' });
      delete (legacyChunk as { archived?: boolean }).archived;
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([legacyChunk]));

      const result = await getActiveChunksForDocument('doc-456');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-legacy');
    });

    it('should issue a single document-scoped query (no archived inequality filter)', async () => {
      const activeChunk = createMockChunk({ id: 'chunk-1', archived: false });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([activeChunk]));

      const result = await getActiveChunksForDocument('doc-456');

      expect(result).toHaveLength(1);
      expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
      expect(firestoreMocks.where).not.toHaveBeenCalledWith('archived', '!=', true);
    });

    it('should return empty array when every chunk is archived', async () => {
      const archivedChunk = createMockChunk({ id: 'chunk-1', archived: true });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([archivedChunk]));

      const result = await getActiveChunksForDocument('doc-456');

      expect(result).toHaveLength(0);
    });
  });

  describe('getChunksForDocumentVersion() (Knowledge Tab Sprint)', () => {
    it('should return chunks for a specific version', async () => {
      const v1Chunk = createMockChunk({ id: 'chunk-1', documentVersion: 1 });
      const _v2Chunk = createMockChunk({ id: 'chunk-2', documentVersion: 2 });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([v1Chunk]));

      const result = await getChunksForDocumentVersion('doc-456', 1);

      expect(result).toHaveLength(1);
      expect(result[0].documentVersion).toBe(1);
    });

    it('should return empty array when version not found', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getChunksForDocumentVersion('doc-456', 99);

      expect(result).toHaveLength(0);
    });

    it('should handle query errors', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getChunksForDocumentVersion('doc-456', 1)).rejects.toThrow();
    });
  });

  describe('archiveChunksForDocument() (Knowledge Tab Sprint)', () => {
    it('should archive all active chunks', async () => {
      const chunks = [
        createMockChunk({ id: 'chunk-1', archived: false }),
        createMockChunk({ id: 'chunk-2', archived: false }),
        createMockChunk({ id: 'chunk-3', archived: false }),
      ];
      const mockDocsWithRefs = {
        docs: chunks.map((c) => ({
          id: c.id,
          exists: () => true,
          data: () => ({
            ...c,
            createdAt: { toMillis: () => c.createdAt },
          }),
          ref: { id: c.id },
        })),
        empty: false,
        size: 3,
      };
      firestoreMocks.getDocs.mockResolvedValueOnce(mockDocsWithRefs);

      const result = await archiveChunksForDocument('doc-456');

      expect(result).toBe(3);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    /**
     * UX-060 regression: `archiveChunksForDocument` filtered with
     * `where('archived','!=',true)`, which skipped chunks missing the field —
     * i.e. every chunk the pipeline wrote. A URL refresh therefore archived
     * NOTHING and appended a new generation next to the stale one.
     */
    it('archives chunks that have no archived field', async () => {
      const legacyChunk = createMockChunk({ id: 'chunk-legacy' });
      delete (legacyChunk as { archived?: boolean }).archived;
      firestoreMocks.getDocs.mockResolvedValueOnce({
        docs: [
          {
            id: legacyChunk.id,
            exists: () => true,
            data: () => ({ ...legacyChunk, createdAt: { toMillis: () => legacyChunk.createdAt } }),
            ref: { id: legacyChunk.id },
          },
        ],
        empty: false,
        size: 1,
      });

      const result = await archiveChunksForDocument('doc-456');

      expect(result).toBe(1);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should return 0 when no chunks to archive', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce({ empty: true, docs: [], size: 0 });

      const result = await archiveChunksForDocument('doc-456');

      expect(result).toBe(0);
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
    });

    it('should handle archive errors', async () => {
      const chunks = [createMockChunk({ id: 'chunk-1', archived: false })];
      const mockDocsWithRefs = {
        docs: chunks.map((c) => ({
          id: c.id,
          exists: () => true,
          data: () => c,
          ref: { id: c.id },
        })),
        empty: false,
        size: 1,
      };
      firestoreMocks.getDocs.mockResolvedValueOnce(mockDocsWithRefs);
      firestoreMocks.writeBatch.mockReturnValueOnce({
        update: jest.fn(),
        commit: jest.fn().mockRejectedValue(new Error('Batch failed')),
      });

      await expect(archiveChunksForDocument('doc-456')).rejects.toThrow();
    });
  });

  describe('createVersionedChunks() (Knowledge Tab Sprint)', () => {
    it('should create chunks with version information', async () => {
      const chunkInputs = [
        { documentId: 'doc-456', content: 'Chunk 1', metadata: { startChar: 0, endChar: 7 }, chunkIndex: 0 },
        { documentId: 'doc-456', content: 'Chunk 2', metadata: { startChar: 8, endChar: 15 }, chunkIndex: 1 },
      ];

      const result = await createVersionedChunks(chunkInputs, 2);

      expect(result).toHaveLength(2);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should return empty array for empty input', async () => {
      const result = await createVersionedChunks([], 1);

      expect(result).toHaveLength(0);
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
    });

    it('should set documentVersion and archived=false', async () => {
      const chunkInputs = [
        { documentId: 'doc-456', content: 'Test', metadata: { startChar: 0, endChar: 4 }, chunkIndex: 0 },
      ];
      const mockBatch = {
        set: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
      };
      firestoreMocks.writeBatch.mockReturnValueOnce(mockBatch);

      await createVersionedChunks(chunkInputs, 3);

      // Verify set was called with version info
      expect(mockBatch.set).toHaveBeenCalledTimes(1);
      const setCall = mockBatch.set.mock.calls[0][1];
      expect(setCall.documentVersion).toBe(3);
      expect(setCall.archived).toBe(false);
    });
  });

  describe('cleanupArchivedChunks() (Knowledge Tab Sprint)', () => {
    it('should delete chunks from old versions beyond retention limit', async () => {
      // Create archived chunks from versions 1, 2, 3, 4 (current version 5 is not archived)
      // The function only considers archived chunks for cleanup
      const chunks = [
        createMockChunk({ id: 'v1-chunk', documentVersion: 1, archived: true }),
        createMockChunk({ id: 'v2-chunk', documentVersion: 2, archived: true }),
        createMockChunk({ id: 'v3-chunk', documentVersion: 3, archived: true }),
        createMockChunk({ id: 'v4-chunk', documentVersion: 4, archived: true }),
        createMockChunk({ id: 'v5-chunk', documentVersion: 5, archived: true }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      // Keep 3 archived versions (5, 4, 3), delete versions 1 and 2
      const result = await cleanupArchivedChunks('doc-456', 3);

      expect(result).toBe(2); // Deleted v1 and v2 chunks
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should return 0 when no archived chunks', async () => {
      const chunks = [createMockChunk({ id: 'chunk-1', archived: false })];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      const result = await cleanupArchivedChunks('doc-456');

      expect(result).toBe(0);
    });

    it('should return 0 when all versions within retention limit', async () => {
      const chunks = [
        createMockChunk({ id: 'v1-chunk', documentVersion: 1, archived: true }),
        createMockChunk({ id: 'v2-chunk', documentVersion: 2, archived: true }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      // Keep 3 versions, we only have 2
      const result = await cleanupArchivedChunks('doc-456', 3);

      expect(result).toBe(0);
    });

    it('should use default retention of 3 versions', async () => {
      const chunks = [
        createMockChunk({ id: 'v1-chunk', documentVersion: 1, archived: true }),
        createMockChunk({ id: 'v2-chunk', documentVersion: 2, archived: true }),
        createMockChunk({ id: 'v3-chunk', documentVersion: 3, archived: true }),
        createMockChunk({ id: 'v4-chunk', documentVersion: 4, archived: true }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks));

      // Default: keep 3 versions (4, 3, 2), delete version 1
      const result = await cleanupArchivedChunks('doc-456');

      expect(result).toBe(1); // Only v1 deleted
    });
  });

  describe('updateChunkEmbedding() (Knowledge Tab Sprint)', () => {
    it('should update chunk with embedding data', async () => {
      const embedding = Array(768).fill(0.1);
      firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);

      await updateChunkEmbedding('chunk-123', embedding);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          embedding,
          embeddingModel: 'text-embedding-004',
        })
      );
    });

    it('should use custom model name', async () => {
      const embedding = Array(768).fill(0.1);
      firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);

      await updateChunkEmbedding('chunk-123', embedding, 'custom-model');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          embeddingModel: 'custom-model',
        })
      );
    });

    it('should handle update errors', async () => {
      firestoreMocks.updateDoc.mockRejectedValueOnce(new Error('Update failed'));

      await expect(
        updateChunkEmbedding('chunk-123', [0.1, 0.2])
      ).rejects.toThrow();
    });
  });

  describe('getChunksNeedingEmbeddings() (Knowledge Tab Sprint)', () => {
    it('should return chunks without embeddings', async () => {
      const chunkWithEmbedding = createMockChunk({
        id: 'chunk-1',
        embedding: Array(768).fill(0.1),
        archived: false,
      });
      const chunkWithoutEmbedding = createMockChunk({
        id: 'chunk-2',
        embedding: undefined,
        archived: false,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([chunkWithEmbedding, chunkWithoutEmbedding])
      );

      const result = await getChunksNeedingEmbeddings('doc-456');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-2');
    });

    it('should filter out archived chunks', async () => {
      const archivedChunk = createMockChunk({
        id: 'chunk-1',
        embedding: undefined,
        archived: true,
      });
      const activeChunk = createMockChunk({
        id: 'chunk-2',
        embedding: undefined,
        archived: false,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([archivedChunk, activeChunk])
      );

      const result = await getChunksNeedingEmbeddings('doc-456');

      // UX-060: the archived chunk used to leak through — the query claimed to
      // filter (`archived != true`) but the mocked snapshot returned both and
      // no client-side filter existed, so archived generations were queued for
      // embedding. The shared predicate now excludes it.
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-2');
    });

    it('keeps chunks with NO archived field (they are the current generation)', async () => {
      const legacyChunk = createMockChunk({ id: 'chunk-legacy', embedding: undefined });
      delete (legacyChunk as { archived?: boolean }).archived;
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([legacyChunk]));

      const result = await getChunksNeedingEmbeddings('doc-456');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('chunk-legacy');
    });

    it('should respect limit parameter', async () => {
      const chunks = Array.from({ length: 200 }, (_, i) =>
        createMockChunk({ id: `chunk-${i}`, embedding: undefined, archived: false })
      );
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(chunks.slice(0, 50)));

      const result = await getChunksNeedingEmbeddings('doc-456', 50);

      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('should return chunks with empty embedding arrays', async () => {
      const chunkWithEmptyEmbedding = createMockChunk({
        id: 'chunk-1',
        embedding: [],
        archived: false,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([chunkWithEmptyEmbedding])
      );

      const result = await getChunksNeedingEmbeddings('doc-456');

      expect(result).toHaveLength(1);
    });

    it('should work without documentId filter', async () => {
      const chunk = createMockChunk({ id: 'chunk-1', embedding: undefined, archived: false });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([chunk]));

      const result = await getChunksNeedingEmbeddings();

      expect(result).toHaveLength(1);
    });
  });
});
