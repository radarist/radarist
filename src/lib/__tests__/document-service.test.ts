/**
 * Unit Tests for Document Service (Phase 2: Evidence Layer)
 *
 * Tests CRUD operations for the Document entity:
 * - getDocuments - Fetch with filtering
 * - getDocumentById - Single fetch by ID
 * - createDocument - Create new document record
 * - updateDocument - Update existing document
 * - deleteDocument - Delete document
 * - markDocumentProcessing/Processed/Failed - Status transitions
 * - searchDocuments - Text search
 * - getDocumentStats - Statistics
 */

import type { Document, DocumentStatus, DocumentType } from '../types';

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
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
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

// Mock document-chunk-service for delete operations
jest.mock('../document-chunk-service', () => ({
  deleteChunksForDocument: jest.fn().mockResolvedValue(0),
}));

// Mock document-storage-service for delete operations
jest.mock('../document-storage-service', () => ({
  deleteStoredDocument: jest.fn().mockResolvedValue(undefined),
  deleteStoredDocuments: jest.fn().mockResolvedValue(0),
}));

// Mock relations service for cascade deletion
jest.mock('@/lib/relations', () => ({
  deleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

// Mock entity-document-link-service for cascade deletion
jest.mock('@/lib/entity-document-link-service', () => ({
  deleteLinksForDocument: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

// Architectural regression guard: browser document deletion must never send
// directly to Inngest. The authenticated server delete boundary owns that.
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue(undefined) },
}));

// Import the service functions (after mocks are set up)
import {
  getDocuments,
  getDocumentById,
  getDocumentsByStatus,
  getPendingDocuments,
  getFailedDocuments,
  createDocument,
  updateDocument,
  markDocumentProcessing,
  markDocumentProcessed,
  markDocumentFailed,
  deleteDocument,
  deleteDocuments,
  searchDocuments,
  getDocumentsByTag,
  getDocumentStats,
  getDocumentByUrl,
  retryDocumentProcessing,
  // Phase 1: URL Document functions
  getDocumentByNormalizedUrl,
  createUrlDocument,
  markDocumentBlocked,
  startDocumentRefresh,
  completeDocumentRefresh,
  failDocumentRefresh,
  getDocumentsNeedingRefresh,
  getOrphanDocuments,
  updateLinkedEntityCount,
  // Phase 1.5: Graph sync functions
  markDocumentSynced,
  markDocumentSyncFailed,
  getDocumentsPendingSync,
} from '../document-service';

// Import the mocked module to get references to the mocks
import {
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
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
  updateDoc: updateDoc as jest.Mock,
  deleteDoc: deleteDoc as jest.Mock,
  writeBatch: writeBatch as jest.Mock,
  collection: collection as jest.Mock,
  doc: doc as jest.Mock,
  query: query as jest.Mock,
  where: where as jest.Mock,
  orderBy: orderBy as jest.Mock,
  limit: limit as jest.Mock,
  Timestamp: Timestamp as unknown as {
    now: jest.Mock;
    fromMillis: jest.Mock;
  },
};

const { fetchWithAuth } = jest.requireMock('@/lib/fetch-with-auth') as {
  fetchWithAuth: jest.Mock;
};

/**
 * Helper to create a mock document for testing
 */
function createMockDocument(overrides?: Partial<Document>): Document {
  return {
    id: 'doc-123',
    title: 'Test Document',
    type: 'pdf' as DocumentType,
    storageUrl: '/documents/test.pdf',
    status: 'uploaded' as DocumentStatus,
    tags: ['research', 'ai'],
    fileSize: 1024000,
    mimeType: 'application/pdf',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    uploadedBy: 'user-123',
    ...overrides,
  };
}

/**
 * Helper to create mock docs response
 */
function createMockDocsResponse(documents: Document[]) {
  return {
    docs: documents.map((d) => ({
      id: d.id,
      exists: () => true,
      data: () => ({
        ...d,
        createdAt: { toMillis: () => d.createdAt },
        updatedAt: { toMillis: () => d.updatedAt },
        processedAt: d.processedAt ? { toMillis: () => d.processedAt } : undefined,
      }),
    })),
    empty: documents.length === 0,
    size: documents.length,
  };
}

/**
 * Helper to create mock doc response
 */
function createMockDocResponse(document: Document | null) {
  if (!document) {
    return { exists: () => false };
  }
  return {
    exists: () => true,
    id: document.id,
    data: () => ({
      ...document,
      createdAt: { toMillis: () => document.createdAt },
      updatedAt: { toMillis: () => document.updatedAt },
      processedAt: document.processedAt ? { toMillis: () => document.processedAt } : undefined,
    }),
  };
}

describe('Document Service (Evidence Layer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set default behaviors for mocks
    firestoreMocks.getDocs.mockResolvedValue({ empty: true, docs: [], size: 0 });
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => false });
    firestoreMocks.addDoc.mockResolvedValue({ id: 'new-doc-id' });
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200 });
    firestoreMocks.writeBatch.mockReturnValue({
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    });
  });

  // ============================================================================
  // GET OPERATIONS
  // ============================================================================

  describe('getDocuments()', () => {
    it('should fetch all documents', async () => {
      const mockDoc1 = createMockDocument({ id: 'doc-1' });
      const mockDoc2 = createMockDocument({ id: 'doc-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1, mockDoc2]));

      const result = await getDocuments();

      expect(result).toHaveLength(2);
      expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
    });

    it('should filter by document type', async () => {
      // Mock returns only pdf docs (simulating Firestore where clause)
      const mockDoc1 = createMockDocument({ id: 'doc-1', type: 'pdf' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1]));

      const result = await getDocuments({ type: 'pdf' });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('pdf');
      expect(firestoreMocks.where).toHaveBeenCalledWith('type', '==', 'pdf');
    });

    it('should filter by status', async () => {
      // Mock returns only processed docs (simulating Firestore where clause)
      const mockDoc1 = createMockDocument({ id: 'doc-1', status: 'processed' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1]));

      const result = await getDocuments({ status: 'processed' });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('processed');
      expect(firestoreMocks.where).toHaveBeenCalledWith('status', '==', 'processed');
    });

    it('should filter by tags', async () => {
      const mockDoc1 = createMockDocument({ id: 'doc-1', tags: ['research', 'ai'] });
      const mockDoc2 = createMockDocument({ id: 'doc-2', tags: ['legal', 'compliance'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1, mockDoc2]));

      const result = await getDocuments({ tags: ['research'] });

      expect(result).toHaveLength(1);
      expect(result[0].tags).toContain('research');
    });

    it('should apply search filter', async () => {
      const mockDoc1 = createMockDocument({ id: 'doc-1', title: 'AI Research Paper' });
      const mockDoc2 = createMockDocument({ id: 'doc-2', title: 'Legal Document' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1, mockDoc2]));

      const result = await getDocuments({ search: 'research' });

      expect(result).toHaveLength(1);
      expect(result[0].title).toContain('Research');
    });

    it('should apply limit', async () => {
      // Mock returns limited docs (simulating Firestore limit clause)
      const docs = Array.from({ length: 10 }, (_, i) => createMockDocument({ id: `doc-${i}` }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(docs));

      const result = await getDocuments({ limit: 10 });

      expect(result).toHaveLength(10);
      expect(firestoreMocks.limit).toHaveBeenCalledWith(10);
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getDocuments()).rejects.toThrow();
    });
  });

  describe('getDocumentById()', () => {
    it('should fetch document by ID', async () => {
      const mockDoc = createMockDocument();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      const result = await getDocumentById('doc-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('doc-123');
      expect(firestoreMocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when document not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      const result = await getDocumentById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getDocumentById('doc-123')).rejects.toThrow();
    });

    it('round-trips the deep-research progress fields the research job writes (PRODUCT-003)', async () => {
      // The read mapper is an explicit whitelist, so a field the job writes but
      // this mapper omits is persisted and then permanently invisible — the
      // sheet's progress panel would render nothing no matter what was recorded.
      const progress = {
        interactionId: 'interaction-abc',
        providerStatus: 'in_progress',
        stepCount: 2,
        steps: [{ index: 0, type: 'plan' }, { index: 1 }],
        progressUnavailable: false,
        observedAt: '2026-07-30T10:00:00.000Z',
        observations: 4,
        observationsWithoutNewStep: 1,
        stalled: false,
        poll: { iteration: 4, max: 60, intervalSeconds: 15 },
        resumable: true,
      };
      const mockDoc = createMockDocument({
        deepResearchInteractionId: 'interaction-abc',
        deepResearchProgress: progress,
      } as Partial<Document>);
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      const result = await getDocumentById('doc-123');

      expect(result?.deepResearchInteractionId).toBe('interaction-abc');
      expect(result?.deepResearchProgress).toEqual(progress);
    });
  });

  describe('getDocumentsByStatus()', () => {
    it('should fetch documents with specific status', async () => {
      const mockDoc1 = createMockDocument({ id: 'doc-1', status: 'processed' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc1]));

      const result = await getDocumentsByStatus('processed');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('processed');
    });
  });

  describe('getPendingDocuments()', () => {
    it('should fetch uploaded documents', async () => {
      const mockDoc = createMockDocument({ status: 'uploaded' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await getPendingDocuments();

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('uploaded');
    });
  });

  describe('getFailedDocuments()', () => {
    it('should fetch failed documents', async () => {
      const mockDoc = createMockDocument({ status: 'failed', errorMessage: 'Processing error' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await getFailedDocuments();

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('failed');
    });
  });

  // ============================================================================
  // CREATE OPERATIONS
  // ============================================================================

  describe('createDocument()', () => {
    it('should create a new document', async () => {
      const mockCreatedDoc = createMockDocument({ id: 'new-doc-id' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockCreatedDoc));

      const result = await createDocument({
        title: 'New Document',
        type: 'pdf',
        storageUrl: '/documents/new.pdf',
        uploadedBy: 'user-123',
      });

      expect(result.title).toBe('Test Document'); // From mock
      expect(firestoreMocks.addDoc).toHaveBeenCalledTimes(1);
    });

    it('should set initial status to uploaded', async () => {
      const mockCreatedDoc = createMockDocument({ id: 'new-doc-id', status: 'uploaded' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockCreatedDoc));

      const result = await createDocument({
        title: 'New Document',
        type: 'pdf',
        storageUrl: '/documents/new.pdf',
        uploadedBy: 'user-123',
      });

      expect(result.status).toBe('uploaded');
    });

    it('should handle creation errors', async () => {
      firestoreMocks.addDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        createDocument({
          title: 'Test',
          type: 'pdf',
          storageUrl: '/test.pdf',
          uploadedBy: 'user-123',
        })
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // UPDATE OPERATIONS
  // ============================================================================

  describe('updateDocument()', () => {
    it('should update an existing document', async () => {
      await updateDocument('doc-123', { title: 'Updated Title' });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle update errors', async () => {
      firestoreMocks.updateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateDocument('doc-123', { title: 'Test' })).rejects.toThrow();
    });
  });

  describe('markDocumentProcessing()', () => {
    it('should set status to processing', async () => {
      await markDocumentProcessing('doc-123');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDocumentProcessed()', () => {
    it('should set status to processed with chunk count', async () => {
      await markDocumentProcessed('doc-123', 25, 10);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDocumentFailed()', () => {
    it('should set status to failed with error message', async () => {
      await markDocumentFailed('doc-123', 'Processing failed: invalid format');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // DELETE OPERATIONS
  // ============================================================================

  describe('deleteDocument()', () => {
    it('should delete a document by ID', async () => {
      await deleteDocument('doc-123');

      expect(fetchWithAuth).toHaveBeenCalledWith('/api/documents/doc-123', { method: 'DELETE' });
    });

    it('delegates the whole cascade instead of mutating browser-side prerequisites', async () => {
      const { deleteRelationsForEntity } = jest.requireMock('@/lib/relations');
      const { deleteLinksForDocument } = jest.requireMock('@/lib/entity-document-link-service');
      const { deleteChunksForDocument } = jest.requireMock('../document-chunk-service');
      const { deleteStoredDocument } = jest.requireMock('../document-storage-service');

      await deleteDocument('doc-456');

      expect(deleteRelationsForEntity).not.toHaveBeenCalled();
      expect(deleteLinksForDocument).not.toHaveBeenCalled();
      expect(deleteChunksForDocument).not.toHaveBeenCalled();
      expect(deleteStoredDocument).not.toHaveBeenCalled();
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('should handle deletion errors', async () => {
      fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(deleteDocument('doc-123')).rejects.toThrow('Document deletion failed (500)');
    });

    it('should handle non-existent document gracefully', async () => {
      fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 404 });

      await deleteDocument('non-existent-id');

      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('uses only the authenticated same-origin delete boundary, never the browser Inngest client', async () => {
      const { inngest } = jest.requireMock('@/lib/inngest/send-client');

      await deleteDocument('doc/del sync');

      expect(fetchWithAuth).toHaveBeenCalledWith('/api/documents/doc%2Fdel%20sync', {
        method: 'DELETE',
      });
      expect(inngest.send).not.toHaveBeenCalled();
    });
  });

  describe('deleteDocuments()', () => {
    it('should delete multiple documents', async () => {
      await deleteDocuments(['doc-1', 'doc-2', 'doc-3']);

      expect(fetchWithAuth).toHaveBeenCalledTimes(3);
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/documents/doc-1', { method: 'DELETE' });
    });

    it('should handle empty array', async () => {
      await deleteDocuments([]);

      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('should handle server deletion errors', async () => {
      fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(deleteDocuments(['doc-1', 'doc-2'])).rejects.toThrow('Document deletion failed (503)');
    });

    it('bounds concurrent authenticated delete requests', async () => {
      let active = 0;
      let maximumActive = 0;
      fetchWithAuth.mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { ok: true, status: 200 };
      });
      const ids = Array.from({ length: 24 }, (_, index) => `doc-${index}`);

      await deleteDocuments(ids);

      expect(maximumActive).toBeLessThanOrEqual(8);
      expect(fetchWithAuth).toHaveBeenCalledTimes(ids.length);
    });

  });

  // ============================================================================
  // SEARCH OPERATIONS
  // ============================================================================

  describe('searchDocuments()', () => {
    it('should search by title', async () => {
      const mockDoc = createMockDocument({ title: 'AI Research Paper', status: 'processed' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await searchDocuments('research');

      expect(result).toHaveLength(1);
    });

    it('should search by description', async () => {
      const mockDoc = createMockDocument({
        title: 'Document',
        description: 'AI research findings',
        status: 'processed',
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await searchDocuments('findings');

      expect(result).toHaveLength(1);
    });

    it('should return empty array when no matches', async () => {
      const mockDoc = createMockDocument({ title: 'Test Document', status: 'processed' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await searchDocuments('nonexistent');

      expect(result).toHaveLength(0);
    });
  });

  describe('getDocumentsByTag()', () => {
    it('should fetch documents with specific tag', async () => {
      const mockDoc = createMockDocument({ tags: ['research', 'ai'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await getDocumentsByTag('research');

      expect(result).toHaveLength(1);
      expect(result[0].tags).toContain('research');
    });
  });

  // ============================================================================
  // STATISTICS
  // ============================================================================

  describe('getDocumentStats()', () => {
    it('should return document statistics', async () => {
      const docs = [
        createMockDocument({ status: 'processed', type: 'pdf', chunkCount: 10 }),
        createMockDocument({ id: 'doc-2', status: 'processed', type: 'pdf', chunkCount: 15 }),
        createMockDocument({ id: 'doc-3', status: 'uploaded', type: 'url' }),
        createMockDocument({ id: 'doc-4', status: 'failed', type: 'docx' }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(docs));

      const result = await getDocumentStats();

      expect(result.total).toBe(4);
      expect(result.byStatus.processed).toBe(2);
      expect(result.byStatus.uploaded).toBe(1);
      expect(result.byStatus.failed).toBe(1);
      expect(result.byType.pdf).toBe(2);
      expect(result.totalChunks).toBe(25);
    });

    it('should handle empty collection', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getDocumentStats();

      expect(result.total).toBe(0);
      expect(result.totalChunks).toBe(0);
    });
  });

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  describe('getDocumentByUrl()', () => {
    it('should find document by original URL', async () => {
      const mockDoc = createMockDocument({ originalUrl: 'https://example.com/paper.pdf' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await getDocumentByUrl('https://example.com/paper.pdf');

      expect(result).not.toBeNull();
      expect(result?.originalUrl).toBe('https://example.com/paper.pdf');
    });

    it('should return null when URL not found', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getDocumentByUrl('https://nonexistent.com');

      expect(result).toBeNull();
    });
  });

  /**
   * UX-036. This used to be a client-SDK write of `{ status: 'uploaded',
   * errorMessage: undefined }` — no Inngest event, no API call, and nothing in
   * the product drains `uploaded` documents. Both call sites nevertheless
   * toasted "queued for reprocessing". It is now the ONE authenticated enqueue
   * and must (a) never write Firestore directly, (b) resolve only on an
   * acknowledged 202, and (c) reject with the server's reason otherwise.
   */
  describe('retryDocumentProcessing()', () => {
    it('posts to the authenticated retry endpoint and returns the acknowledged event ids', async () => {
      fetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ accepted: true, documentId: 'doc-123', eventIds: ['evt-1'] }),
      });

      const result = await retryDocumentProcessing('doc-123');

      expect(fetchWithAuth).toHaveBeenCalledWith('/api/documents/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: 'doc-123' }),
      });
      expect(result).toEqual({ documentId: 'doc-123', eventIds: ['evt-1'] });
    });

    it('never writes the document status directly', async () => {
      fetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ accepted: true, documentId: 'doc-123', eventIds: ['evt-1'] }),
      });

      await retryDocumentProcessing('doc-123');

      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });

    it('throws the server reason when the request is refused', async () => {
      fetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Processing is already running for this document.' }),
      });

      await expect(retryDocumentProcessing('doc-123')).rejects.toThrow(
        'Processing is already running for this document.'
      );
      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });

    it('throws when the response is 2xx but does not acknowledge acceptance', async () => {
      fetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'ok' }),
      });

      await expect(retryDocumentProcessing('doc-123')).rejects.toThrow(/Reprocessing request failed/);
    });
  });

  // ============================================================================
  // URL DOCUMENT FUNCTIONS (Knowledge Tab Sprint)
  // ============================================================================

  describe('getDocumentByNormalizedUrl()', () => {
    it('should find document by normalized URL', async () => {
      const mockDoc = createMockDocument({
        type: 'url' as DocumentType,
        originalUrl: 'https://www.example.com/page/',
        normalizedUrl: 'https://example.com/page',
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockDoc]));

      const result = await getDocumentByNormalizedUrl('https://WWW.Example.com/page/');

      expect(result).not.toBeNull();
    });

    it('should return null when normalized URL not found', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getDocumentByNormalizedUrl('https://nonexistent.com');

      expect(result).toBeNull();
    });
  });

  describe('createUrlDocument()', () => {
    it('should create a URL document with normalized URL and domain', async () => {
      // Mock no existing document
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const mockCreatedDoc = createMockDocument({
        id: 'new-url-doc',
        type: 'url' as DocumentType,
        originalUrl: 'https://www.example.com/article',
        normalizedUrl: 'https://example.com/article',
        domain: 'example.com',
        version: 1,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockCreatedDoc));

      const result = await createUrlDocument('https://www.example.com/article', 'Test Article', 'user-123');

      expect(result.type).toBe('url');
      expect(firestoreMocks.addDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw if URL already exists', async () => {
      const existingDoc = createMockDocument({
        type: 'url' as DocumentType,
        normalizedUrl: 'https://example.com/article',
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([existingDoc]));

      await expect(createUrlDocument('https://example.com/article', 'Test', 'user-123')).rejects.toThrow(
        'Document already exists'
      );
    });
  });

  describe('markDocumentBlocked()', () => {
    it('should set status to blocked with reason', async () => {
      await markDocumentBlocked('doc-123', 'Access forbidden (403)');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // REFRESH FUNCTIONS (Knowledge Tab Sprint)
  // ============================================================================

  describe('startDocumentRefresh()', () => {
    it('should set refreshInProgress flag and return true', async () => {
      const mockDoc = createMockDocument({
        type: 'url' as DocumentType,
        refreshInProgress: false,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      const result = await startDocumentRefresh('doc-123');

      expect(result).toBe(true);
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should return false if refresh already in progress', async () => {
      const mockDoc = createMockDocument({
        type: 'url' as DocumentType,
        refreshInProgress: true,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      const result = await startDocumentRefresh('doc-123');

      expect(result).toBe(false);
      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });

    it('should throw if document not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(startDocumentRefresh('nonexistent')).rejects.toThrow('Document not found');
    });

    it('should throw if document is not URL type', async () => {
      const mockDoc = createMockDocument({ type: 'pdf' as DocumentType });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await expect(startDocumentRefresh('doc-123')).rejects.toThrow('Cannot refresh non-URL document');
    });
  });

  describe('completeDocumentRefresh()', () => {
    it('should update version and hash when content changed', async () => {
      const mockDoc = createMockDocument({
        type: 'url' as DocumentType,
        version: 1,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await completeDocumentRefresh('doc-123', true, 'newHash456');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should only update lastFetchedAt when content unchanged', async () => {
      const mockDoc = createMockDocument({
        type: 'url' as DocumentType,
        version: 1,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await completeDocumentRefresh('doc-123', false);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw if document not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(completeDocumentRefresh('nonexistent', false)).rejects.toThrow('Document not found');
    });
  });

  describe('failDocumentRefresh()', () => {
    it('should clear refresh flag and set error', async () => {
      await failDocumentRefresh('doc-123', 'Network error');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDocumentsNeedingRefresh()', () => {
    it('should return URL documents not refreshed within maxAge', async () => {
      const staleDoc = createMockDocument({
        type: 'url' as DocumentType,
        status: 'processed' as DocumentStatus,
        lastFetchedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
        refreshInProgress: false,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([staleDoc]));

      const result = await getDocumentsNeedingRefresh(7 * 24 * 60 * 60 * 1000, 50);

      expect(result).toHaveLength(1);
    });

    it('should exclude documents with refresh in progress', async () => {
      const docInProgress = createMockDocument({
        type: 'url' as DocumentType,
        status: 'processed' as DocumentStatus,
        lastFetchedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        refreshInProgress: true,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([docInProgress]));

      const result = await getDocumentsNeedingRefresh();

      expect(result).toHaveLength(0);
    });

    it('should include documents never fetched', async () => {
      const neverFetched = createMockDocument({
        type: 'url' as DocumentType,
        status: 'processed' as DocumentStatus,
        lastFetchedAt: undefined,
        refreshInProgress: false,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([neverFetched]));

      const result = await getDocumentsNeedingRefresh();

      expect(result).toHaveLength(1);
    });
  });

  // ============================================================================
  // ORPHAN DETECTION (Knowledge Tab Sprint)
  // ============================================================================

  describe('getOrphanDocuments()', () => {
    it('should return documents with no linked entities', async () => {
      const orphanDoc = createMockDocument({
        status: 'processed' as DocumentStatus,
        linkedEntityCount: 0,
      });
      const linkedDoc = createMockDocument({
        id: 'doc-linked',
        status: 'processed' as DocumentStatus,
        linkedEntityCount: 3,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([orphanDoc, linkedDoc]));

      const result = await getOrphanDocuments();

      expect(result).toHaveLength(1);
      expect(result[0].linkedEntityCount).toBe(0);
    });

    it('should include documents with undefined linkedEntityCount', async () => {
      const undefinedCountDoc = createMockDocument({
        status: 'processed' as DocumentStatus,
        linkedEntityCount: undefined,
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([undefinedCountDoc]));

      const result = await getOrphanDocuments();

      expect(result).toHaveLength(1);
    });
  });

  describe('updateLinkedEntityCount()', () => {
    it('should increment linked entity count', async () => {
      const mockDoc = createMockDocument({ linkedEntityCount: 2 });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await updateLinkedEntityCount('doc-123', 1);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should decrement linked entity count', async () => {
      const mockDoc = createMockDocument({ linkedEntityCount: 2 });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await updateLinkedEntityCount('doc-123', -1);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should not go below zero', async () => {
      const mockDoc = createMockDocument({ linkedEntityCount: 0 });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockDoc));

      await updateLinkedEntityCount('doc-123', -1);

      // Should still call update but with count = 0
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle missing document gracefully', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      // Should not throw, just warn
      await updateLinkedEntityCount('nonexistent', 1);

      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // GRAPH SYNC STATUS (Knowledge Tab Sprint)
  // ============================================================================

  describe('markDocumentSynced()', () => {
    it('should set graphSyncStatus to synced', async () => {
      await markDocumentSynced('doc-123');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDocumentSyncFailed()', () => {
    it('should set graphSyncStatus to failed', async () => {
      await markDocumentSyncFailed('doc-123');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDocumentsPendingSync()', () => {
    it('should return documents with pending sync status', async () => {
      const pendingDoc = createMockDocument({ graphSyncStatus: 'pending' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([pendingDoc]));

      const result = await getDocumentsPendingSync();

      expect(result).toHaveLength(1);
    });

    it('should respect limit parameter', async () => {
      await getDocumentsPendingSync(10);

      expect(firestoreMocks.limit).toHaveBeenCalledWith(10);
    });
  });
});
