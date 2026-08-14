/**
 * Unit Tests for Document Storage Service
 *
 * Tests file upload, download URL generation, metadata retrieval,
 * and deletion for both Firebase Storage and Firestore fallback.
 *
 * Covers:
 * - validateFile - size and MIME type validation
 * - MAX_FILE_SIZE / ALLOWED_MIME_TYPES constants
 * - uploadDocument - Storage upload with Firestore fallback
 * - getDocumentDownloadUrl - URL retrieval with fallback
 * - getDocumentMetadata - metadata fetch
 * - deleteStoredDocument - single delete from both backends
 * - deleteStoredDocuments - batch delete with success count
 * - getDocumentContent - content retrieval from fallback and Storage
 */

// ---------------------------------------------------------------------------
// Mocks must be declared before imports
// ---------------------------------------------------------------------------

const mockRef = jest.fn();
const mockUploadBytes = jest.fn();
const mockGetDownloadURL = jest.fn();
const mockDeleteObject = jest.fn();
const mockGetMetadata = jest.fn();

jest.mock('firebase/storage', () => ({
  ref: (...args: unknown[]) => mockRef(...args),
  uploadBytes: (...args: unknown[]) => mockUploadBytes(...args),
  getDownloadURL: (...args: unknown[]) => mockGetDownloadURL(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  getMetadata: (...args: unknown[]) => mockGetMetadata(...args),
}));

const mockCollection = jest.fn();
const mockDoc = jest.fn();
const mockSetDoc = jest.fn();
const mockGetDoc = jest.fn();
const mockDeleteDoc = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => mockCollection(...args),
  doc: (...args: unknown[]) => mockDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
}));

jest.mock('@/lib/firebase', () => ({
  db: {},
  storage: {},
}));

// Mock global fetch for getDocumentContent
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  validateFile,
  uploadDocument,
  getDocumentDownloadUrl,
  getDocumentMetadata,
  deleteStoredDocument,
  deleteStoredDocuments,
  getDocumentContent,
} from '../document-storage-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDocSnapshot(data: Record<string, unknown> | null) {
  return {
    exists: () => data !== null,
    data: () => data,
  };
}

/** Build a minimal Buffer with a given byte length. */
function makeBuffer(size: number): Buffer {
  return Buffer.alloc(size, 'a');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('document-storage-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: Firestore fallback doc not found (used in many paths)
    mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('MAX_FILE_SIZE', () => {
    it('should be 50MB in bytes', () => {
      expect(MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    });
  });

  describe('ALLOWED_MIME_TYPES', () => {
    it('should include application/pdf mapped to pdf', () => {
      expect(ALLOWED_MIME_TYPES['application/pdf']).toBe('pdf');
    });

    it('should include docx MIME type mapped to docx', () => {
      expect(
        ALLOWED_MIME_TYPES[
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ]
      ).toBe('docx');
    });

    it('should include pptx MIME type', () => {
      expect(
        ALLOWED_MIME_TYPES[
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ]
      ).toBe('pptx');
    });

    it('should include text/plain mapped to text', () => {
      expect(ALLOWED_MIME_TYPES['text/plain']).toBe('text');
    });

    it('should include text/markdown mapped to markdown', () => {
      expect(ALLOWED_MIME_TYPES['text/markdown']).toBe('markdown');
    });

    it('should have exactly 5 entries', () => {
      expect(Object.keys(ALLOWED_MIME_TYPES)).toHaveLength(5);
    });
  });

  // =========================================================================
  // validateFile
  // =========================================================================

  describe('validateFile', () => {
    it('should accept a valid PDF file', () => {
      const result = validateFile(1024, 'application/pdf');
      expect(result).toEqual({ valid: true, documentType: 'pdf' });
    });

    it('should accept a valid DOCX file', () => {
      const result = validateFile(
        5000,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(result).toEqual({ valid: true, documentType: 'docx' });
    });

    it('should accept a valid text/plain file', () => {
      const result = validateFile(100, 'text/plain');
      expect(result).toEqual({ valid: true, documentType: 'text' });
    });

    it('should accept a file exactly at the size limit', () => {
      const result = validateFile(MAX_FILE_SIZE, 'application/pdf');
      expect(result).toEqual({ valid: true, documentType: 'pdf' });
    });

    it('should reject a file exceeding MAX_FILE_SIZE', () => {
      const result = validateFile(MAX_FILE_SIZE + 1, 'application/pdf');
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('File size exceeds maximum'),
      });
    });

    it('should reject an unsupported MIME type', () => {
      const result = validateFile(1024, 'image/png');
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('Unsupported file type: image/png'),
      });
    });

    it('should reject an empty MIME type', () => {
      const result = validateFile(1024, '');
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('Unsupported file type'),
      });
    });
  });

  // =========================================================================
  // uploadDocument
  // =========================================================================

  describe('uploadDocument', () => {
    it('should return validation error for oversized file', async () => {
      const buf = makeBuffer(MAX_FILE_SIZE + 1);
      const result = await uploadDocument(buf, 'big.pdf', 'application/pdf', 'user1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('File size exceeds maximum');
      }
    });

    it('should return validation error for unsupported MIME type', async () => {
      const buf = makeBuffer(100);
      const result = await uploadDocument(buf, 'pic.png', 'image/png', 'user1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unsupported file type');
      }
    });

    it('should upload successfully via Firebase Storage', async () => {
      const buf = makeBuffer(500);
      const fakeSnapshotRef = { ref: 'mock-ref' };
      mockRef.mockReturnValue('storage-ref');
      mockUploadBytes.mockResolvedValue({ ref: fakeSnapshotRef });
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/doc.pdf');

      const result = await uploadDocument(buf, 'report.pdf', 'application/pdf', 'user1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.downloadUrl).toBe('https://storage.example.com/doc.pdf');
        expect(result.mimeType).toBe('application/pdf');
        expect(result.size).toBe(500);
        expect(result.path).toContain('documents/user1/');
      }

      expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    });

    it('should fall back to Firestore when Storage upload fails for small file', async () => {
      const buf = makeBuffer(500);
      mockRef.mockReturnValue('storage-ref');
      mockUploadBytes.mockRejectedValue(new Error('storage/unknown'));

      // Firestore fallback succeeds
      mockSetDoc.mockResolvedValue(undefined);

      const result = await uploadDocument(buf, 'small.txt', 'text/plain', 'user1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.downloadUrl).toContain('data:text/plain;base64,');
        expect(result.size).toBe(500);
      }
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return error when both Storage and Firestore fallback fail', async () => {
      // File too large for Firestore fallback (> 900KB) and Storage fails
      const buf = makeBuffer(950 * 1024);
      mockRef.mockReturnValue('storage-ref');
      mockUploadBytes.mockRejectedValue(new Error('storage/unknown'));

      const result = await uploadDocument(buf, 'large.pdf', 'application/pdf', 'user1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Firebase Storage is not enabled');
      }
    });

    it('should return generic error message when Storage fails with unknown error', async () => {
      const buf = makeBuffer(950 * 1024);
      mockRef.mockReturnValue('storage-ref');
      mockUploadBytes.mockRejectedValue(new Error('Network timeout'));

      const result = await uploadDocument(buf, 'doc.pdf', 'application/pdf', 'user1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Network timeout');
      }
    });

    it('should sanitize file name in storage path', async () => {
      const buf = makeBuffer(100);
      mockRef.mockReturnValue('storage-ref');
      mockUploadBytes.mockResolvedValue({ ref: 'snap-ref' });
      mockGetDownloadURL.mockResolvedValue('https://example.com/file');

      const result = await uploadDocument(
        buf,
        'my report (final).pdf',
        'application/pdf',
        'user1'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Spaces and parens should be replaced with underscores
        expect(result.path).not.toContain(' ');
        expect(result.path).not.toContain('(');
        expect(result.path).toContain('my_report__final_.pdf');
      }
    });
  });

  // =========================================================================
  // getDocumentDownloadUrl
  // =========================================================================

  describe('getDocumentDownloadUrl', () => {
    it('should return download URL from Firebase Storage', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/doc.pdf');

      const url = await getDocumentDownloadUrl('documents/user1/file.pdf');

      expect(url).toBe('https://storage.example.com/doc.pdf');
      expect(mockRef).toHaveBeenCalled();
    });

    it('should fall back to Firestore when Storage fails', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockRejectedValue(new Error('not found'));

      // Firestore fallback has the document
      mockGetDoc.mockResolvedValue(
        createMockDocSnapshot({
          content: Buffer.from('hello').toString('base64'),
          mimeType: 'text/plain',
          size: 5,
        })
      );

      const url = await getDocumentDownloadUrl('documents/user1/file.txt');

      expect(url).toContain('data:text/plain;base64,');
    });

    it('should return null when neither Storage nor Firestore has the file', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockRejectedValue(new Error('not found'));
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));

      const url = await getDocumentDownloadUrl('documents/user1/missing.pdf');

      expect(url).toBeNull();
    });
  });

  // =========================================================================
  // getDocumentMetadata
  // =========================================================================

  describe('getDocumentMetadata', () => {
    it('should return metadata from Firebase Storage', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetMetadata.mockResolvedValue({
        size: 1024,
        contentType: 'application/pdf',
        customMetadata: {
          uploadedAt: '2026-01-07T10:00:00Z',
          originalName: 'report.pdf',
        },
      });

      const meta = await getDocumentMetadata('documents/user1/report.pdf');

      expect(meta).toEqual({
        size: 1024,
        mimeType: 'application/pdf',
        uploadedAt: '2026-01-07T10:00:00Z',
        originalName: 'report.pdf',
      });
    });

    it('should use default mimeType when contentType is null', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetMetadata.mockResolvedValue({
        size: 512,
        contentType: null,
        customMetadata: {},
      });

      const meta = await getDocumentMetadata('documents/user1/unknown');

      expect(meta).not.toBeNull();
      expect(meta!.mimeType).toBe('application/octet-stream');
    });

    it('should return null when getMetadata throws', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockGetMetadata.mockRejectedValue(new Error('storage error'));

      const meta = await getDocumentMetadata('documents/user1/missing.pdf');

      expect(meta).toBeNull();
    });
  });

  // =========================================================================
  // deleteStoredDocument
  // =========================================================================

  describe('deleteStoredDocument', () => {
    it('should delete from both Firebase Storage and Firestore fallback', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject.mockResolvedValue(undefined);
      mockGetDoc.mockResolvedValue(createMockDocSnapshot({ content: 'unused' }));
      mockDeleteDoc.mockResolvedValue(undefined);

      await expect(deleteStoredDocument('documents/user1/file.pdf')).resolves.toBe(true);

      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should not throw when Storage delete fails but Firestore succeeds', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject.mockRejectedValue(new Error('not found'));
      mockGetDoc.mockResolvedValue(createMockDocSnapshot({ content: 'unused' }));
      mockDeleteDoc.mockResolvedValue(undefined);

      await expect(
        deleteStoredDocument('documents/user1/file.pdf')
      ).resolves.toBe(true);

      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should not throw when Firestore delete fails but Storage succeeds', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject.mockResolvedValue(undefined);
      mockGetDoc.mockResolvedValue(createMockDocSnapshot({ content: 'unused' }));
      mockDeleteDoc.mockRejectedValue(new Error('doc not found'));

      await expect(
        deleteStoredDocument('documents/user1/file.pdf')
      ).resolves.toBe(true);

      expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    });

    it('should warn when neither backend deletes successfully', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject.mockRejectedValue(new Error('fail'));
      mockGetDoc.mockResolvedValue(createMockDocSnapshot({ content: 'unused' }));
      mockDeleteDoc.mockRejectedValue(new Error('fail'));

      await expect(deleteStoredDocument('documents/user1/ghost.pdf')).resolves.toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[document-storage-service]'),
        expect.stringContaining('Could not delete'),
        expect.any(Object)
      );
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // deleteStoredDocuments
  // =========================================================================

  describe('deleteStoredDocuments', () => {
    it('should return 0 for empty array', async () => {
      const count = await deleteStoredDocuments([]);
      expect(count).toBe(0);
    });

    it('should count successful deletions', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject.mockResolvedValue(undefined);
      mockDeleteDoc.mockResolvedValue(undefined);

      const count = await deleteStoredDocuments([
        'documents/user1/a.pdf',
        'documents/user1/b.pdf',
        'documents/user1/c.pdf',
      ]);

      expect(count).toBe(3);
    });

    it('should count only confirmed deletions', async () => {
      mockRef.mockReturnValue('storage-ref');
      mockDeleteObject
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('fail'));

      const count = await deleteStoredDocuments([
        'documents/user1/a.pdf',
        'documents/user1/b.pdf',
      ]);

      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // getDocumentContent
  // =========================================================================

  describe('getDocumentContent', () => {
    it('should return content from Firestore fallback when available', async () => {
      const base64 = Buffer.from('PDF content here').toString('base64');
      mockGetDoc.mockResolvedValue(
        createMockDocSnapshot({
          content: base64,
          mimeType: 'application/pdf',
          size: 16,
        })
      );

      const result = await getDocumentContent('documents/user1/file.pdf');

      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe('application/pdf');
      expect(result!.content.toString()).toBe('PDF content here');
      // Should NOT have called fetch since Firestore had the content
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch from Storage URL when Firestore fallback has no content', async () => {
      // Firestore fallback returns null
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));

      // getDocumentDownloadUrl path: Storage succeeds
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/doc.pdf');

      // fetch call
      const pdfBytes = Buffer.from('fetched PDF content');
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(pdfBytes.buffer.slice(
          pdfBytes.byteOffset,
          pdfBytes.byteOffset + pdfBytes.byteLength
        )),
        headers: {
          get: (name: string) =>
            name === 'content-type' ? 'application/pdf' : null,
        },
      });

      const result = await getDocumentContent('documents/user1/file.pdf');

      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe('application/pdf');
      expect(mockFetch).toHaveBeenCalledWith('https://storage.example.com/doc.pdf');
    });

    it('should return null when fetch response is not ok', async () => {
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/doc.pdf');

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await getDocumentContent('documents/user1/missing.pdf');

      expect(result).toBeNull();
    });

    it('should return null when download URL is null', async () => {
      // Firestore fallback: not found
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));
      // Storage also fails
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockRejectedValue(new Error('not found'));

      const result = await getDocumentContent('documents/user1/gone.pdf');

      expect(result).toBeNull();
    });

    it('should return null when fetch throws', async () => {
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/doc.pdf');
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await getDocumentContent('documents/user1/file.pdf');

      expect(result).toBeNull();
    });

    it('should use default content-type when header is missing', async () => {
      mockGetDoc.mockResolvedValue(createMockDocSnapshot(null));
      mockRef.mockReturnValue('storage-ref');
      mockGetDownloadURL.mockResolvedValue('https://storage.example.com/file');

      const fileBytes = Buffer.from('binary content');
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength
        )),
        headers: {
          get: () => null,
        },
      });

      const result = await getDocumentContent('documents/user1/file');

      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe('application/octet-stream');
    });
  });
});
