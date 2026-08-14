/**
 * Unit Tests for useDocumentIngest Hook
 *
 * Tests document upload and entity extraction hook:
 * - File validation (size limit, extension check)
 * - Upload flow with progress states
 * - Successful processing result
 * - Error handling (API errors, network errors)
 * - Reset state
 * - Constants (SUPPORTED_EXTENSIONS, MAX_FILE_SIZE)
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// Suppress console.error during expected error paths
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});
afterAll(() => {
  console.error = originalConsoleError;
});

// Import after mocks
import {
  useDocumentIngest,
  SUPPORTED_EXTENSIONS,
  MAX_FILE_SIZE,
} from '../useDocumentIngest';

// ============================================================================
// HELPERS
// ============================================================================

function createMockFile(
  name: string,
  size: number,
  type = 'application/pdf'
): File {
  // Create a file with the specified size
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

function createSuccessResponse(overrides = {}) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      fileName: 'test.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
      pageCount: 5,
      textLength: 5000,
      extractedText: 'Extracted text content...',
      suggestions: [
        {
          sourceId: 'doc-1',
          targetId: 'tech-1',
          relationType: 'mentions',
          confidence: 0.85,
        },
      ],
      ...overrides,
    }),
  };
}

function createErrorResponse(error = 'Processing failed', status = 500) {
  return {
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({ error }),
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('useDocumentIngest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe('constants', () => {
    it('should export supported file extensions', () => {
      expect(SUPPORTED_EXTENSIONS).toContain('.pdf');
      expect(SUPPORTED_EXTENSIONS).toContain('.docx');
      expect(SUPPORTED_EXTENSIONS).toContain('.pptx');
    });

    it('should export MAX_FILE_SIZE as 10MB', () => {
      expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
    });
  });

  // --------------------------------------------------------------------------
  // Initial state
  // --------------------------------------------------------------------------

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const { result } = renderHook(() => useDocumentIngest());

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.progress).toBe(0);
      expect(result.current.status).toBe('');
      expect(result.current.error).toBeNull();
      expect(result.current.result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // validateFile
  // --------------------------------------------------------------------------

  describe('validateFile', () => {
    it('should return null for valid PDF file', () => {
      const { result } = renderHook(() => useDocumentIngest());
      const file = createMockFile('doc.pdf', 1024);

      const error = result.current.validateFile(file);

      expect(error).toBeNull();
    });

    it('should return null for valid DOCX file', () => {
      const { result } = renderHook(() => useDocumentIngest());
      const file = createMockFile('doc.docx', 1024, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      const error = result.current.validateFile(file);

      expect(error).toBeNull();
    });

    it('should reject files exceeding MAX_FILE_SIZE', () => {
      const { result } = renderHook(() => useDocumentIngest());
      const oversizedFile = createMockFile('large.pdf', MAX_FILE_SIZE + 1);

      const error = result.current.validateFile(oversizedFile);

      expect(error).not.toBeNull();
      expect(error).toContain('File too large');
      expect(error).toContain('10MB');
    });

    it('should reject unsupported file types', () => {
      const { result } = renderHook(() => useDocumentIngest());
      const txtFile = createMockFile('readme.txt', 1024, 'text/plain');

      const error = result.current.validateFile(txtFile);

      expect(error).not.toBeNull();
      expect(error).toContain('Unsupported file type');
    });

    it('should reject files with no extension', () => {
      const { result } = renderHook(() => useDocumentIngest());
      const noExtFile = createMockFile('readme', 1024);

      const error = result.current.validateFile(noExtFile);

      expect(error).not.toBeNull();
      expect(error).toContain('Unsupported file type');
    });
  });

  // --------------------------------------------------------------------------
  // processDocument - success flow
  // --------------------------------------------------------------------------

  describe('processDocument - success', () => {
    it('should process a valid document successfully', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse());
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('test.pdf', 1024));
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.progress).toBe(100);
      expect(result.current.status).toBe('Complete!');
      expect(result.current.error).toBeNull();
      expect(result.current.result).not.toBeNull();
      expect(result.current.result!.fileName).toBe('test.pdf');
      expect(result.current.result!.suggestions).toHaveLength(1);
    });

    it('should call fetch with FormData', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse());
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('report.pdf', 2048));
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/documents/ingest', {
        method: 'POST',
        body: expect.any(FormData),
      });
    });
  });

  // --------------------------------------------------------------------------
  // processDocument - validation errors
  // --------------------------------------------------------------------------

  describe('processDocument - validation errors', () => {
    it('should set error for oversized file without calling fetch', async () => {
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(
          createMockFile('huge.pdf', MAX_FILE_SIZE + 1)
        );
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.error).toContain('File too large');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should set error for unsupported file type without calling fetch', async () => {
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(
          createMockFile('image.png', 1024, 'image/png')
        );
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.error).toContain('Unsupported file type');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // processDocument - API errors
  // --------------------------------------------------------------------------

  describe('processDocument - API errors', () => {
    it('should handle API error response', async () => {
      mockFetch.mockResolvedValue(createErrorResponse('Invalid document format'));
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('bad.pdf', 1024));
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.progress).toBe(0);
      expect(result.current.error).toBe('Invalid document format');
      expect(result.current.result).toBeNull();
    });

    it('should handle network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('doc.pdf', 1024));
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.error).toBe('Network error');
      expect(result.current.result).toBeNull();
    });

    it('should handle non-Error thrown values', async () => {
      mockFetch.mockRejectedValue('string error');
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('doc.pdf', 1024));
      });

      expect(result.current.error).toBe('Failed to process document');
    });
  });

  // --------------------------------------------------------------------------
  // reset
  // --------------------------------------------------------------------------

  describe('reset', () => {
    it('should reset all state to initial values', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse());
      const { result } = renderHook(() => useDocumentIngest());

      // First process a document
      await act(async () => {
        await result.current.processDocument(createMockFile('test.pdf', 1024));
      });
      expect(result.current.result).not.toBeNull();

      // Then reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.isProcessing).toBe(false);
      expect(result.current.progress).toBe(0);
      expect(result.current.status).toBe('');
      expect(result.current.error).toBeNull();
      expect(result.current.result).toBeNull();
    });

    it('should reset error state', async () => {
      mockFetch.mockRejectedValue(new Error('Failed'));
      const { result } = renderHook(() => useDocumentIngest());

      await act(async () => {
        await result.current.processDocument(createMockFile('doc.pdf', 1024));
      });
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.error).toBeNull();
    });
  });
});
