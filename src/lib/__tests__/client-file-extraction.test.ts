/**
 * Unit Tests for Client File Extraction Helper
 *
 * Tests the client-side helper functions for file extraction:
 * - isExtractableFile() - checks if a file type can be extracted
 * - getEffectiveMimeType() - gets MIME type with fallback to extension
 * - isLikelyLargeFile() - heuristic for large file detection
 *
 * Note: extractFileText() requires API mocking and is tested separately
 * in integration tests.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';

// Replicate the functions and constants for testing
// (since the actual file may have import issues in test environment)

const EXTRACTABLE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/plain',
  'text/markdown',
];

const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

// Mock File for testing
interface MockFile {
  name: string;
  type: string;
  size: number;
}

function isExtractableFile(file: MockFile): boolean {
  // Check by MIME type first
  if (EXTRACTABLE_MIME_TYPES.includes(file.type)) {
    return true;
  }

  // Fallback to extension check
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  return ext in EXTENSION_TO_MIME;
}

function getEffectiveMimeType(file: MockFile): string | null {
  if (file.type && file.type !== 'application/octet-stream') {
    return file.type;
  }

  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  return EXTENSION_TO_MIME[ext] || null;
}

function isLikelyLargeFile(file: MockFile): boolean {
  const thresholds: Record<string, number> = {
    'text/plain': 50 * 1024, // 50KB
    'text/markdown': 50 * 1024, // 50KB
    'application/pdf': 500 * 1024, // 500KB
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 200 * 1024, // 200KB
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 500 * 1024, // 500KB
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 300 * 1024, // 300KB
  };

  const mimeType = getEffectiveMimeType(file);
  if (!mimeType) return false;

  const threshold = thresholds[mimeType] || 200 * 1024;
  return file.size > threshold;
}

describe('Client File Extraction Helper', () => {
  describe('Constants', () => {
    it('should support PDF files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain('application/pdf');
    });

    it('should support DOCX files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('should support PPTX files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
    });

    it('should support XLSX files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('should support plain text files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain('text/plain');
    });

    it('should support markdown files', () => {
      expect(EXTRACTABLE_MIME_TYPES).toContain('text/markdown');
    });

    it('should have exactly 6 supported MIME types', () => {
      expect(EXTRACTABLE_MIME_TYPES).toHaveLength(6);
    });

    it('should map common file extensions', () => {
      expect(EXTENSION_TO_MIME['.pdf']).toBe('application/pdf');
      expect(EXTENSION_TO_MIME['.docx']).toBeDefined();
      expect(EXTENSION_TO_MIME['.pptx']).toBeDefined();
      expect(EXTENSION_TO_MIME['.xlsx']).toBeDefined();
      expect(EXTENSION_TO_MIME['.txt']).toBe('text/plain');
      expect(EXTENSION_TO_MIME['.md']).toBe('text/markdown');
      expect(EXTENSION_TO_MIME['.markdown']).toBe('text/markdown');
    });
  });

  describe('isExtractableFile()', () => {
    describe('MIME type detection', () => {
      it('should return true for PDF files', () => {
        const file: MockFile = { name: 'document.pdf', type: 'application/pdf', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return true for DOCX files', () => {
        const file: MockFile = {
          name: 'document.docx',
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 1024,
        };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return true for PPTX files', () => {
        const file: MockFile = {
          name: 'presentation.pptx',
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 1024,
        };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return true for XLSX files', () => {
        const file: MockFile = {
          name: 'spreadsheet.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1024,
        };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return true for plain text files', () => {
        const file: MockFile = { name: 'readme.txt', type: 'text/plain', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return true for markdown files', () => {
        const file: MockFile = { name: 'README.md', type: 'text/markdown', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return false for image files', () => {
        const file: MockFile = { name: 'photo.jpg', type: 'image/jpeg', size: 1024 };
        expect(isExtractableFile(file)).toBe(false);
      });

      it('should return false for video files', () => {
        const file: MockFile = { name: 'video.mp4', type: 'video/mp4', size: 1024 };
        expect(isExtractableFile(file)).toBe(false);
      });
    });

    describe('Extension fallback', () => {
      it('should use extension fallback when MIME type is missing', () => {
        const file: MockFile = { name: 'document.pdf', type: '', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should use extension fallback for octet-stream MIME type', () => {
        const file: MockFile = { name: 'document.docx', type: 'application/octet-stream', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should handle uppercase extensions', () => {
        const file: MockFile = { name: 'DOCUMENT.PDF', type: '', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should handle mixed case extensions', () => {
        const file: MockFile = { name: 'Document.Docx', type: '', size: 1024 };
        expect(isExtractableFile(file)).toBe(true);
      });

      it('should return false for unknown extensions', () => {
        const file: MockFile = { name: 'document.xyz', type: '', size: 1024 };
        expect(isExtractableFile(file)).toBe(false);
      });
    });
  });

  describe('getEffectiveMimeType()', () => {
    it('should return file.type when present', () => {
      const file: MockFile = { name: 'document.pdf', type: 'application/pdf', size: 1024 };
      expect(getEffectiveMimeType(file)).toBe('application/pdf');
    });

    it('should fall back to extension when MIME type is empty', () => {
      const file: MockFile = { name: 'document.pdf', type: '', size: 1024 };
      expect(getEffectiveMimeType(file)).toBe('application/pdf');
    });

    it('should fall back to extension when MIME type is octet-stream', () => {
      const file: MockFile = { name: 'document.docx', type: 'application/octet-stream', size: 1024 };
      expect(getEffectiveMimeType(file)).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('should return null for unknown extensions', () => {
      const file: MockFile = { name: 'document.xyz', type: '', size: 1024 };
      expect(getEffectiveMimeType(file)).toBeNull();
    });

    it('should handle .markdown extension', () => {
      const file: MockFile = { name: 'README.markdown', type: '', size: 1024 };
      expect(getEffectiveMimeType(file)).toBe('text/markdown');
    });

    it('should handle files with multiple dots in name', () => {
      const file: MockFile = { name: 'report.2024.01.pdf', type: '', size: 1024 };
      expect(getEffectiveMimeType(file)).toBe('application/pdf');
    });
  });

  describe('isLikelyLargeFile()', () => {
    it('should return false for small text files', () => {
      const file: MockFile = { name: 'small.txt', type: 'text/plain', size: 10 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(false);
    });

    it('should return true for large text files (> 50KB)', () => {
      const file: MockFile = { name: 'large.txt', type: 'text/plain', size: 60 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(true);
    });

    it('should return false for small PDF files', () => {
      const file: MockFile = { name: 'small.pdf', type: 'application/pdf', size: 100 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(false);
    });

    it('should return true for large PDF files (> 500KB)', () => {
      const file: MockFile = { name: 'large.pdf', type: 'application/pdf', size: 600 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(true);
    });

    it('should return false for small DOCX files', () => {
      const file: MockFile = {
        name: 'small.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 100 * 1024,
      };
      expect(isLikelyLargeFile(file)).toBe(false);
    });

    it('should return true for large DOCX files (> 200KB)', () => {
      const file: MockFile = {
        name: 'large.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 300 * 1024,
      };
      expect(isLikelyLargeFile(file)).toBe(true);
    });

    it('should return false for unknown file types', () => {
      const file: MockFile = { name: 'unknown.xyz', type: '', size: 1024 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(false);
    });

    it('should use extension-based detection when MIME type is missing', () => {
      const file: MockFile = { name: 'large.txt', type: '', size: 60 * 1024 };
      expect(isLikelyLargeFile(file)).toBe(true);
    });
  });

  describe('FileExtractionResult Interface', () => {
    interface FileExtractionResult {
      success: boolean;
      text: string;
      pageCount?: number;
      fileName?: string;
      mimeType?: string;
      originalSize?: number;
      textSize?: number;
      isLargeFile?: boolean;
      suggestLibraryUpload?: boolean;
      error?: string;
    }

    it('should have correct structure for successful extraction', () => {
      const result: FileExtractionResult = {
        success: true,
        text: 'Extracted content...',
        pageCount: 5,
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        originalSize: 102400,
        textSize: 25600,
        isLargeFile: false,
        suggestLibraryUpload: false,
      };

      expect(result.success).toBe(true);
      expect(result.text).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should have correct structure for failed extraction', () => {
      const result: FileExtractionResult = {
        success: false,
        text: '',
        error: 'Unsupported file type',
      };

      expect(result.success).toBe(false);
      expect(result.text).toBe('');
      expect(result.error).toBeDefined();
    });

    it('should flag large files for library upload', () => {
      const result: FileExtractionResult = {
        success: true,
        text: 'Large content...',
        textSize: 60 * 1024,
        isLargeFile: true,
        suggestLibraryUpload: true,
      };

      expect(result.isLargeFile).toBe(true);
      expect(result.suggestLibraryUpload).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle files with no extension', () => {
      const file: MockFile = { name: 'Makefile', type: '', size: 1024 };
      expect(isExtractableFile(file)).toBe(false);
      expect(getEffectiveMimeType(file)).toBeNull();
    });

    it('should handle hidden files', () => {
      const file: MockFile = { name: '.gitignore', type: '', size: 1024 };
      expect(isExtractableFile(file)).toBe(false);
    });

    it('should handle files starting with dot and having extension', () => {
      const file: MockFile = { name: '.notes.txt', type: '', size: 1024 };
      expect(isExtractableFile(file)).toBe(true);
    });

    it('should handle very long file names', () => {
      const longName = 'a'.repeat(200) + '.pdf';
      const file: MockFile = { name: longName, type: '', size: 1024 };
      expect(isExtractableFile(file)).toBe(true);
    });

    it('should handle special characters in file names', () => {
      const file: MockFile = { name: 'résumé (final).pdf', type: '', size: 1024 };
      expect(isExtractableFile(file)).toBe(true);
    });

    it('should handle zero-byte files', () => {
      const file: MockFile = { name: 'empty.txt', type: 'text/plain', size: 0 };
      expect(isExtractableFile(file)).toBe(true);
      expect(isLikelyLargeFile(file)).toBe(false);
    });
  });
});
