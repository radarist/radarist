/**
 * @file lib/inngest/__tests__/process-document.test.ts
 * @description Unit tests for the document processing Inngest jobs.
 *
 * Tests cover:
 * - Single document processing job
 * - Batch document processing job
 * - Error handling and retries
 * - Event sending (completion/failure)
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { Document, DocumentStatus } from '@/lib/types';

/** Shape returned by the mocked inngest.createFunction */
interface MockedInngestFn {
  config: Record<string, unknown> & {
    onFailure?: (args: unknown) => Promise<void>;
  };
  trigger: Record<string, unknown>;
  handler: (...args: unknown[]) => Promise<unknown>;
}

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Mock Inngest client - must be before imports
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: jest.fn(),
    createFunction: jest.fn().mockImplementation((config, trigger, handler) => ({
      config,
      trigger,
      handler,
    })),
  },
}));

// Mock dependencies
jest.mock('@/lib/document-processing-service', () => ({
  processDocument: jest.fn(),
}));

jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminGetDocumentById: jest.fn(),
}));

// Import after mocking to get mocked versions
import { processDocumentJob, batchProcessDocumentsJob } from '@/lib/inngest/functions/process-document';
import { processDocument } from '@/lib/document-processing-service';
import { adminGetDocumentById } from '@/lib/document-admin';
import { inngest } from '@/lib/inngest/client';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

describe('process-document Inngest jobs', () => {
  const mockProcessDocument = jest.mocked(processDocument);
  const mockGetDocById = jest.mocked(adminGetDocumentById);
  const mockInngestSend = jest.mocked(inngest.send);

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

  beforeEach(() => {
    jest.clearAllMocks();
    mockInngestSend.mockResolvedValue({ ids: ['event-1'] });
  });

  describe('processDocumentJob', () => {
    // Helper to simulate step.run
    const createMockStep = () => ({
      run: jest.fn().mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn()),
    });

    it('should have correct configuration', () => {
      expect((processDocumentJob as unknown as MockedInngestFn).config).toMatchObject({
        id: 'process-document',
        name: 'Process Document',
        retries: 3,
      });
    });

    it('should trigger on document.process.requested event', () => {
      expect((processDocumentJob as unknown as MockedInngestFn).trigger).toEqual({
        event: 'app/document.process.requested',
      });
    });

    it('should process document successfully', async () => {
      mockGetDocById.mockResolvedValue(mockDocument);
      mockProcessDocument.mockResolvedValue({
        success: true,
        documentId: 'doc-123',
        extractedText: 'Test content',
        textLength: 12,
        pageCount: 1,
        chunkCount: 1,
        chunkIds: ['chunk-1'],
      });

      const mockStep = createMockStep();
      const event = {
        data: { documentId: 'doc-123' },
      };

      const result = await (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(result).toEqual({
        success: true,
        documentId: 'doc-123',
        textLength: 12,
        pageCount: 1,
        chunkCount: 1,
      });
    });

    it('should send completion event on success', async () => {
      mockGetDocById.mockResolvedValue(mockDocument);
      mockProcessDocument.mockResolvedValue({
        success: true,
        documentId: 'doc-123',
        extractedText: 'Test content',
        textLength: 12,
        pageCount: 1,
        chunkCount: 1,
        chunkIds: ['chunk-1'],
      });

      const mockStep = createMockStep();
      const event = {
        data: { documentId: 'doc-123' },
      };

      await (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.process.completed',
        data: expect.objectContaining({
          documentId: 'doc-123',
          textLength: 12,
          pageCount: 1,
          chunkCount: 1,
          processedAt: expect.any(Number),
        }),
      });
    });

    it('should return error result when document not found', async () => {
      mockGetDocById.mockResolvedValue(null);

      const mockStep = createMockStep();
      const event = {
        data: { documentId: 'doc-missing' },
      };

      await expect(
        (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any)
      ).rejects.toThrow('Document doc-missing not found');
    });

    it('should handle processing failure', async () => {
      mockGetDocById.mockResolvedValue(mockDocument);
      mockProcessDocument.mockResolvedValue({
        success: false,
        documentId: 'doc-123',
        error: 'Corrupted PDF',
        stage: 'extraction',
      });

      const mockStep = createMockStep();
      const event = {
        data: { documentId: 'doc-123' },
      };

      const result = await (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(result).toEqual({
        success: false,
        documentId: 'doc-123',
        error: 'Corrupted PDF',
        stage: 'extraction',
      });
    });

    it('should send failure event when processing fails', async () => {
      mockGetDocById.mockResolvedValue(mockDocument);
      mockProcessDocument.mockResolvedValue({
        success: false,
        documentId: 'doc-123',
        error: 'Corrupted PDF',
        stage: 'extraction',
      });

      const mockStep = createMockStep();
      const event = {
        data: { documentId: 'doc-123' },
      };

      await (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.process.failed',
        data: expect.objectContaining({
          documentId: 'doc-123',
          error: 'Corrupted PDF',
          stage: 'extraction',
          failedAt: expect.any(Number),
        }),
      });
    });

    it('should pass processing options to processDocument', async () => {
      mockGetDocById.mockResolvedValue(mockDocument);
      mockProcessDocument.mockResolvedValue({
        success: true,
        documentId: 'doc-123',
        extractedText: 'Test content',
        textLength: 12,
        chunkCount: 1,
        chunkIds: ['chunk-1'],
      });

      const mockStep = createMockStep();
      const event = {
        data: {
          documentId: 'doc-123',
          options: {
            chunkSize: 500,
            chunkOverlap: 100,
            replaceExisting: false,
          },
        },
      };

      await (processDocumentJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(mockProcessDocument).toHaveBeenCalledWith('doc-123', {
        chunkSize: 500,
        chunkOverlap: 100,
        replaceExisting: false,
      });
    });
  });

  describe('batchProcessDocumentsJob', () => {
    const createMockStep = () => ({
      run: jest.fn().mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn()),
    });

    it('should have correct configuration', () => {
      expect((batchProcessDocumentsJob as unknown as MockedInngestFn).config).toMatchObject({
        id: 'batch-process-documents',
        name: 'Batch Process Documents',
        retries: 2,
      });
    });

    it('should trigger on batch-process.requested event', () => {
      expect((batchProcessDocumentsJob as unknown as MockedInngestFn).trigger).toEqual({
        event: 'app/document.batch-process.requested',
      });
    });

    it('should return error for empty documentIds', async () => {
      const mockStep = createMockStep();
      const event = {
        data: { documentIds: [] },
      };

      const result = await (batchProcessDocumentsJob as unknown as MockedInngestFn).handler({
        event,
        step: mockStep,
      } as any);

      expect(result).toEqual({
        success: false,
        error: 'No document IDs provided',
      });
    });

    it('should process multiple documents', async () => {
      mockProcessDocument
        .mockResolvedValueOnce({
          success: true,
          documentId: 'doc-1',
          extractedText: 'Content 1',
          textLength: 10,
          chunkCount: 1,
          chunkIds: ['chunk-1'],
        })
        .mockResolvedValueOnce({
          success: true,
          documentId: 'doc-2',
          extractedText: 'Content 2',
          textLength: 10,
          chunkCount: 1,
          chunkIds: ['chunk-2'],
        });

      const mockStep = createMockStep();
      const event = {
        data: { documentIds: ['doc-1', 'doc-2'] },
      };

      const result = await (batchProcessDocumentsJob as unknown as MockedInngestFn).handler({
        event,
        step: mockStep,
      } as any);

      expect(result).toEqual({
        success: true,
        total: 2,
        successful: 2,
        failed: 0,
        results: [
          { documentId: 'doc-1', success: true },
          { documentId: 'doc-2', success: true },
        ],
      });
    });

    it('should continue processing even if one fails', async () => {
      mockProcessDocument
        .mockResolvedValueOnce({
          success: false,
          documentId: 'doc-1',
          error: 'Corrupted file',
          stage: 'extraction',
        })
        .mockResolvedValueOnce({
          success: true,
          documentId: 'doc-2',
          extractedText: 'Content 2',
          textLength: 10,
          chunkCount: 1,
          chunkIds: ['chunk-2'],
        });

      const mockStep = createMockStep();
      const event = {
        data: { documentIds: ['doc-1', 'doc-2'] },
      };

      const result = await (batchProcessDocumentsJob as unknown as MockedInngestFn).handler({
        event,
        step: mockStep,
      } as any);

      expect(result).toEqual({
        success: false,
        total: 2,
        successful: 1,
        failed: 1,
        results: [
          { documentId: 'doc-1', success: false, error: 'Corrupted file' },
          { documentId: 'doc-2', success: true },
        ],
      });
    });

    it('should handle thrown exceptions in batch processing', async () => {
      mockProcessDocument.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
        success: true,
        documentId: 'doc-2',
        extractedText: 'Content 2',
        textLength: 10,
        chunkCount: 1,
        chunkIds: ['chunk-2'],
      });

      const mockStep = createMockStep();
      const event = {
        data: { documentIds: ['doc-1', 'doc-2'] },
      };

      const result = await (batchProcessDocumentsJob as unknown as MockedInngestFn).handler({
        event,
        step: mockStep,
      } as any);

      expect(result).toEqual({
        success: false,
        total: 2,
        successful: 1,
        failed: 1,
        results: [
          { documentId: 'doc-1', success: false, error: 'Network error' },
          { documentId: 'doc-2', success: true },
        ],
      });
    });

    it('should pass options to all documents', async () => {
      mockProcessDocument.mockResolvedValue({
        success: true,
        documentId: 'doc-1',
        extractedText: 'Content',
        textLength: 7,
        chunkCount: 1,
        chunkIds: ['chunk-1'],
      });

      const mockStep = createMockStep();
      const event = {
        data: {
          documentIds: ['doc-1', 'doc-2'],
          options: { chunkSize: 500 },
        },
      };

      await (batchProcessDocumentsJob as unknown as MockedInngestFn).handler({ event, step: mockStep } as any);

      expect(mockProcessDocument).toHaveBeenCalledTimes(2);
      expect(mockProcessDocument).toHaveBeenNthCalledWith(1, 'doc-1', { chunkSize: 500 });
      expect(mockProcessDocument).toHaveBeenNthCalledWith(2, 'doc-2', { chunkSize: 500 });
    });
  });

  describe('onFailure handlers', () => {
    it('processDocumentJob should send failure event on final failure', async () => {
      const error = new Error('Final failure after retries');
      // Inngest v3 onFailure payload: original event nested at event.data.event
      const event = { data: { event: { data: { documentId: 'doc-123' } } } };

      await (processDocumentJob as unknown as MockedInngestFn).config.onFailure!({ error, event } as any);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.process.failed',
        data: expect.objectContaining({
          documentId: 'doc-123',
          error: 'Final failure after retries',
          failedAt: expect.any(Number),
        }),
      });
    });

    it('batchProcessDocumentsJob should log failure', async () => {
      const error = new Error('Batch processing failed');
      // Inngest v3 onFailure payload: original event nested at event.data.event
      const event = { data: { event: { data: { documentIds: ['doc-1', 'doc-2'] } } } };

      await (batchProcessDocumentsJob as unknown as MockedInngestFn).config.onFailure!({ error, event } as any);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Batch process documents final failure',
        expect.any(Error),
        expect.objectContaining({ documentCount: 2 })
      );
    });
  });
});
