/**
 * @file lib/__tests__/document-processing-service.test.ts
 * @description Unit tests for the document processing service.
 *
 * Tests cover:
 * - Document processing pipeline (download → extract → chunk → store)
 * - Error handling at each stage
 * - Batch processing
 * - Status updates
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-07
 */

import { extractTextFromDocument } from '@/lib/document-extraction';
// `prepareChunksFromText` (pure helper) stays on the client service; the
// Firestore WRITE paths come from the admin-SDK twin (document-chunk-admin).
import { prepareChunksFromText } from '@/lib/document-chunk-service';
import {
  adminCreateChunks as createChunks,
  adminDeleteChunksForDocument as deleteChunksForDocument,
} from '@/lib/document-chunk-admin';
import {
  adminGetDocumentById as getDocumentById,
  adminUpdateDocument as updateDocument,
  adminGetDocuments as getDocuments,
} from '@/lib/document-admin';
import { adminGetDocumentContent as getDocumentContent } from '@/lib/document-storage-admin';
import type { Document, DocumentStatus } from '@/lib/types';

// Mock firebase-admin so the real module (which transitively imports jwks-rsa /
// jose ESM) is never loaded when the admin twins are pulled in.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

// Mock document-storage-admin (Storage READ twin the implementation actually uses)
jest.mock('@/lib/document-storage-admin', () => ({
  __esModule: true,
  adminGetDocumentContent: jest.fn(),
}));

// Mock document-extraction
jest.mock('@/lib/document-extraction', () => ({
  extractTextFromDocument: jest.fn(),
}));

// Mock document-chunk-service (pure `prepareChunksFromText` helper only)
jest.mock('@/lib/document-chunk-service', () => ({
  prepareChunksFromText: jest.fn(),
}));

// Mock document-chunk-admin (Firestore WRITE twins used by the service)
jest.mock('@/lib/document-chunk-admin', () => ({
  __esModule: true,
  adminCreateChunks: jest.fn(),
  adminDeleteChunksForDocument: jest.fn(),
}));

// Mock document-admin (Firestore read/update twins used by the service)
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn(),
  adminGetDocuments: jest.fn(),
}));

// Policy helpers are pure (no SDKs) and deliberately NOT mocked: the liveness
// tests below assert the real cross-module contract between what this service
// writes and what the UI/API then believe about the run.
import {
  PROCESSING_STALE_MS,
  isProcessingActive,
  isProcessingStalled,
  type ProcessingPolicyInput,
} from '@/lib/document-processing-policy';

// Import after mocking
import {
  processDocument,
  processDocumentFromContent,
  processDocuments,
  reprocessDocument,
  getDocumentsPendingProcessing,
  getDocumentsWithErrors,
} from '@/lib/document-processing-service';

describe('document-processing-service', () => {
  const mockGetDocumentContent = jest.mocked(getDocumentContent);
  const mockExtractText = jest.mocked(extractTextFromDocument);
  const mockPrepareChunks = jest.mocked(prepareChunksFromText);
  const mockCreateChunks = jest.mocked(createChunks);
  const mockDeleteChunks = jest.mocked(deleteChunksForDocument);
  const mockGetDocById = jest.mocked(getDocumentById);
  const mockUpdateDoc = jest.mocked(updateDocument);
  const mockGetDocs = jest.mocked(getDocuments);

  // Sample document
  const mockDocument: Document = {
    id: 'doc-123',
    title: 'Test Document',
    type: 'pdf',
    status: 'pending' as DocumentStatus,
    storageUrl: 'documents/user-1/test.pdf',
    fileSize: 1024,
    mimeType: 'application/pdf',
    uploadedBy: 'user-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Sample file content
  const mockFileContent = Buffer.from('This is test PDF content for processing.');
  const mockExtractedText = `
    Introduction

    This is a sample document with multiple paragraphs that will be chunked.

    Section 1: Overview

    The document processing service handles the extraction of text from various file formats
    including PDF, DOCX, and plain text files.

    Section 2: Implementation

    The implementation uses Firebase Storage for file storage and Firestore for metadata.
  `.trim();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    // getDocumentContent returns { content: Buffer, mimeType: string }
    mockGetDocumentContent.mockResolvedValue({
      content: mockFileContent,
      mimeType: 'application/pdf',
    });
    mockGetDocById.mockResolvedValue(mockDocument);
    mockUpdateDoc.mockResolvedValue();
    mockDeleteChunks.mockResolvedValue(0);
    mockExtractText.mockResolvedValue({
      success: true,
      text: mockExtractedText,
      pageCount: 3,
    });
    mockPrepareChunks.mockReturnValue([
      {
        documentId: 'doc-123',
        content: 'Chunk 1 content',
        metadata: { startChar: 0, endChar: 100 },
        chunkIndex: 0,
        tokenCount: 25,
      },
      {
        documentId: 'doc-123',
        content: 'Chunk 2 content',
        metadata: { startChar: 100, endChar: 200 },
        chunkIndex: 1,
        tokenCount: 25,
      },
    ]);
    mockCreateChunks.mockResolvedValue(['chunk-1', 'chunk-2']);
  });

  describe('processDocument', () => {
    it('should process a document successfully', async () => {
      const result = await processDocument('doc-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.documentId).toBe('doc-123');
        expect(result.textLength).toBe(mockExtractedText.length);
        expect(result.pageCount).toBe(3);
        expect(result.chunkCount).toBe(2);
        expect(result.chunkIds).toEqual(['chunk-1', 'chunk-2']);
      }
    });

    it('should update status to processing then processed', async () => {
      await processDocument('doc-123');

      // UX-036: the run-start write also carries the liveness stamp, so an
      // abandoned run reads as STALLED instead of "processing" forever. See
      // the `processing-run liveness` block for the contract it satisfies.
      expect(mockUpdateDoc).toHaveBeenCalledWith('doc-123', {
        status: 'processing',
        processingRequestedAt: expect.any(Number),
      });
      // UX-036: a successful pass also CLEARS the stored failure reason. The
      // Firestore mappers skip `undefined`, so `errorMessage` must be written
      // as '' or a healthy document keeps rendering its previous failure text.
      expect(mockUpdateDoc).toHaveBeenCalledWith('doc-123', {
        status: 'processed',
        processedAt: expect.any(Number),
        chunkCount: 2,
        pageCount: 3,
        errorMessage: '',
      });
    });

    it('should stamp chunkCount on the document (file path parity with URL path)', async () => {
      // Regression pin: the file path historically omitted chunkCount (only
      // processDocumentFromContent wrote it), leaving every PDF/DOCX showing
      // "—" in the documents table despite chunks existing in Firestore.
      await processDocument('doc-123');

      const processedUpdate = mockUpdateDoc.mock.calls.find(([, update]) => update.status === 'processed');
      expect(processedUpdate).toBeDefined();
      expect(processedUpdate![1].chunkCount).toBe(2);
    });

    it('should delete existing chunks by default', async () => {
      await processDocument('doc-123');

      expect(mockDeleteChunks).toHaveBeenCalledWith('doc-123');
    });

    it('should not delete existing chunks when replaceExisting is false', async () => {
      await processDocument('doc-123', { replaceExisting: false });

      expect(mockDeleteChunks).not.toHaveBeenCalled();
    });

    it('should use custom chunk size and overlap', async () => {
      await processDocument('doc-123', { chunkSize: 500, chunkOverlap: 100 });

      expect(mockPrepareChunks).toHaveBeenCalledWith('doc-123', mockExtractedText, {
        chunkSize: 500,
        chunkOverlap: 100,
      });
    });

    it('should return error when document not found', async () => {
      mockGetDocById.mockResolvedValue(null);

      const result = await processDocument('doc-missing');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
        expect(result.stage).toBe('download');
      }
    });

    it('should return error when download fails', async () => {
      mockGetDocumentContent.mockResolvedValue(null);

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.stage).toBe('download');
        // UX-036: the reason is persisted alongside the status. The pipeline
        // never wrote `errorMessage`, so the detail sheet's "Processing
        // failed" panel — gated on it — could never appear.
        expect(mockUpdateDoc).toHaveBeenCalledWith('doc-123', {
          status: 'failed',
          errorMessage: expect.stringMatching(/\(stage: \w+\)$/),
        });
      }
    });

    it('should return error when extraction fails', async () => {
      mockExtractText.mockResolvedValue({
        success: false,
        text: '',
        error: 'Corrupted PDF',
      });

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Corrupted PDF');
        expect(result.stage).toBe('extraction');
        // UX-036: the reason is persisted alongside the status. The pipeline
        // never wrote `errorMessage`, so the detail sheet's "Processing
        // failed" panel — gated on it — could never appear.
        expect(mockUpdateDoc).toHaveBeenCalledWith('doc-123', {
          status: 'failed',
          errorMessage: expect.stringMatching(/\(stage: \w+\)$/),
        });
      }
    });

    it('should return error when text is too short', async () => {
      mockExtractText.mockResolvedValue({
        success: true,
        text: 'Short',
      });

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('too little text');
        expect(result.stage).toBe('extraction');
      }
    });

    it('should handle plain text files directly', async () => {
      const textDoc = { ...mockDocument, mimeType: 'text/plain' };
      mockGetDocById.mockResolvedValue(textDoc);

      // For plain text, extractTextFromDocument isn't called
      // The buffer is converted directly
      const textContent = 'Plain text content that is long enough to process';
      mockGetDocumentContent.mockResolvedValue({
        content: Buffer.from(textContent),
        mimeType: 'text/plain',
      });

      const result = await processDocument('doc-123');

      // Plain text extraction happens in the service, not via extractTextFromDocument
      expect(result.success).toBe(true);
    });

    it('should handle markdown files directly', async () => {
      const mdDoc = { ...mockDocument, mimeType: 'text/markdown' };
      mockGetDocById.mockResolvedValue(mdDoc);

      const mdContent = '# Markdown content\n\nThis is long enough to process';
      mockGetDocumentContent.mockResolvedValue({
        content: Buffer.from(mdContent),
        mimeType: 'text/markdown',
      });

      const result = await processDocument('doc-123');

      expect(result.success).toBe(true);
    });

    it('should handle chunk creation errors', async () => {
      mockCreateChunks.mockRejectedValue(new Error('Firestore error'));

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.stage).toBe('storage');
        // UX-036: the reason is persisted alongside the status. The pipeline
        // never wrote `errorMessage`, so the detail sheet's "Processing
        // failed" panel — gated on it — could never appear.
        expect(mockUpdateDoc).toHaveBeenCalledWith('doc-123', {
          status: 'failed',
          errorMessage: expect.stringMatching(/\(stage: \w+\)$/),
        });
      }
    });
  });

  describe('processDocuments', () => {
    it('should process multiple documents', async () => {
      const doc2 = { ...mockDocument, id: 'doc-456' };
      mockGetDocById.mockImplementation(async (id) => {
        if (id === 'doc-123') return mockDocument;
        if (id === 'doc-456') return doc2;
        return null;
      });

      const results = await processDocuments(['doc-123', 'doc-456']);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('should continue processing even if one fails', async () => {
      mockGetDocById.mockImplementation(async (id) => {
        if (id === 'doc-123') return null; // Will fail
        if (id === 'doc-456') return mockDocument;
        return null;
      });

      const results = await processDocuments(['doc-123', 'doc-456']);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });

    it('should return empty array for empty input', async () => {
      const results = await processDocuments([]);

      expect(results).toHaveLength(0);
    });
  });

  describe('reprocessDocument', () => {
    it('should delete existing chunks and process again', async () => {
      const result = await reprocessDocument('doc-123');

      expect(mockDeleteChunks).toHaveBeenCalledWith('doc-123');
      expect(result.success).toBe(true);
    });

    it('should pass through options except replaceExisting', async () => {
      await reprocessDocument('doc-123', { chunkSize: 500 });

      expect(mockPrepareChunks).toHaveBeenCalledWith('doc-123', mockExtractedText, {
        chunkSize: 500,
        chunkOverlap: 200,
      });
    });
  });

  describe('getDocumentsPendingProcessing', () => {
    it('should return documents with uploaded status', async () => {
      const uploadedDocs = [mockDocument];
      mockGetDocs.mockResolvedValue(uploadedDocs);

      const result = await getDocumentsPendingProcessing();

      expect(mockGetDocs).toHaveBeenCalledWith({ status: 'uploaded' });
      expect(result).toEqual(uploadedDocs);
    });
  });

  describe('getDocumentsWithErrors', () => {
    it('should return documents with failed status', async () => {
      const failedDocs = [{ ...mockDocument, status: 'failed' as DocumentStatus }];
      mockGetDocs.mockResolvedValue(failedDocs);

      const result = await getDocumentsWithErrors();

      expect(mockGetDocs).toHaveBeenCalledWith({ status: 'failed' });
      expect(result).toEqual(failedDocs);
    });
  });

  describe('edge cases', () => {
    it('should handle empty extracted text', async () => {
      mockExtractText.mockResolvedValue({
        success: true,
        text: '',
      });

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('too little text');
      }
    });

    it('should handle whitespace-only text', async () => {
      mockExtractText.mockResolvedValue({
        success: true,
        text: '   \n\n   \t   ',
      });

      const result = await processDocument('doc-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('too little text');
      }
    });

    it('should include extracted text in successful result', async () => {
      const result = await processDocument('doc-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractedText).toBe(mockExtractedText);
      }
    });

    it('should handle status update failure gracefully in outer catch block', async () => {
      // Simulate a scenario where the initial "processing" status update throws
      // This goes through the main catch block which should still return a proper error
      mockUpdateDoc.mockRejectedValue(new Error('Update failed'));

      const result = await processDocument('doc-123');

      // Should return error result via the catch block, not throw uncaught exception
      expect(result.success).toBe(false);
      if (!result.success) {
        // When error happens during status updates or other operations,
        // the catch block sets stage to 'storage' as a generic failure
        expect(result.error).toContain('Update failed');
        expect(result.stage).toBe('storage');
      }
    });
  });

  /**
   * UX-036 — a `processing` status is only trustworthy while it is BOUNDED.
   *
   * `document-processing-policy.ts` deliberately reports a `processing`
   * document with NO `processingRequestedAt` stamp as ACTIVE forever, because
   * the recovery action (re-enqueue) is destructive and an unstamped run may
   * belong to another pipeline. That safe default turns into a trap for any run
   * this module starts: the two writes below were the ONLY producers of a
   * `processing` status that carried no stamp, so a run that died mid-flight
   * (dev-server restart, aborted request, container kill) left the document
   * permanently "Processing" with BOTH Retry and Process hidden in the UI —
   * unrecoverable, which is the exact state UX-036 exists to remove.
   *
   * These assert the cross-module invariant rather than mere field presence:
   * whatever this service writes when it starts a run must eventually read as
   * STALLED, so the operator gets the recovery action back.
   */
  describe('processing-run liveness (UX-036)', () => {
    /** The document state a caller would read back after the run began. */
    const startedRunState = (): ProcessingPolicyInput => {
      const started = mockUpdateDoc.mock.calls.find(([, update]) => update.status === 'processing');
      // The service must mark the document processing before doing any work.
      expect(started).toBeDefined();
      return started![1] as ProcessingPolicyInput;
    };

    it('stamps the accepted-run instant so a dead stored-file run becomes recoverable', async () => {
      const before = Date.now();
      await processDocument('doc-123');

      const state = startedRunState();
      expect(state.processingRequestedAt).toBeGreaterThanOrEqual(before);
      // Live while the window holds…
      expect(isProcessingActive(state, before)).toBe(true);
      // …and recoverable once it lapses, never "active forever".
      expect(isProcessingStalled(state, before + PROCESSING_STALE_MS + 1)).toBe(true);
    });

    it('stamps the accepted-run instant for the content/URL path too', async () => {
      const before = Date.now();
      await processDocumentFromContent('doc-123', mockExtractedText);

      const state = startedRunState();
      expect(state.processingRequestedAt).toBeGreaterThanOrEqual(before);
      expect(isProcessingStalled(state, before + PROCESSING_STALE_MS + 1)).toBe(true);
    });
  });
});
