/**
 * @file lib/client-file-extraction.ts
 * @description Client-side helper for extracting text from files via the API.
 *
 * Provides a simple interface for the AI chat component to extract text
 * from uploaded files before sending to the AI for analysis.
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
const log = createLogger('client-file-extraction');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of file text extraction.
 */
export interface FileExtractionResult {
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

/**
 * Supported MIME types for text extraction.
 */
export const EXTRACTABLE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/plain',
  'text/markdown',
];

/**
 * File extension to MIME type mapping.
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a file type is extractable for text.
 *
 * @param file - File to check
 * @returns True if the file type can be extracted
 */
export function isExtractableFile(file: File): boolean {
  // Check by MIME type first
  if (EXTRACTABLE_MIME_TYPES.includes(file.type)) {
    return true;
  }

  // Fallback to extension check
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  return ext in EXTENSION_TO_MIME;
}

/**
 * Get the effective MIME type for a file.
 * Falls back to extension-based detection if the file.type is missing.
 *
 * @param file - File to check
 * @returns MIME type string or null if unknown
 */
export function getEffectiveMimeType(file: File): string | null {
  if (file.type && file.type !== 'application/octet-stream') {
    return file.type;
  }

  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  return EXTENSION_TO_MIME[ext] || null;
}

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

/**
 * Extract text from a file by calling the server-side extraction API.
 *
 * @param file - File to extract text from
 * @returns Extraction result with text content
 *
 * @example
 * ```typescript
 * const result = await extractFileText(myPdfFile);
 * if (result.success) {
 *   console.log('Extracted text:', result.text);
 *   if (result.suggestLibraryUpload) {
 *     console.log('Consider uploading to library for better handling');
 *   }
 * } else {
 *   console.error('Extraction failed:', result.error);
 * }
 * ```
 */
export async function extractFileText(file: File): Promise<FileExtractionResult> {
  // Validate file type first
  if (!isExtractableFile(file)) {
    const mimeType = getEffectiveMimeType(file);
    return {
      success: false,
      text: '',
      error: `Unsupported file type: ${mimeType || 'unknown'}. Supported types: PDF, DOCX, PPTX, XLSX, TXT, MD`,
    };
  }

  try {
    // Create form data with the file
    const formData = new FormData();
    formData.append('file', file);

    // Call the extraction API
    const response = await fetchWithAuth('/api/ai/extract-text', {
      method: 'POST',
      body: formData,
    });

    // Parse response
    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        text: '',
        error: data.error || `Extraction failed with status ${response.status}`,
      };
    }

    return {
      success: data.success,
      text: data.text || '',
      pageCount: data.pageCount,
      fileName: data.fileName,
      mimeType: data.mimeType,
      originalSize: data.originalSize,
      textSize: data.textSize,
      isLargeFile: data.isLargeFile,
      suggestLibraryUpload: data.suggestLibraryUpload,
      error: data.error,
    };
  } catch (error) {
    log.error('Failed to extract file text', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      text: '',
      error: error instanceof Error ? error.message : 'Failed to extract text from file',
    };
  }
}

/**
 * Extract text from multiple files.
 * Processes files in parallel for efficiency.
 *
 * @param files - Array of files to extract text from
 * @returns Array of extraction results (in same order as input files)
 */
export async function extractMultipleFiles(
  files: File[]
): Promise<FileExtractionResult[]> {
  return Promise.all(files.map(extractFileText));
}

/**
 * Check if a file exceeds the quick mode size limit (50KB of text).
 * This is a heuristic check based on file size - actual text size
 * may vary depending on file type and content.
 *
 * For more accurate results, use extractFileText and check suggestLibraryUpload.
 *
 * @param file - File to check
 * @returns True if the file is likely too large for quick mode
 */
export function isLikelyLargeFile(file: File): boolean {
  // Heuristic thresholds based on file type
  // Text files have ~1:1 ratio, documents compress text significantly
  const thresholds: Record<string, number> = {
    'text/plain': 50 * 1024, // 50KB
    'text/markdown': 50 * 1024, // 50KB
    'application/pdf': 500 * 1024, // 500KB (10:1 compression ratio estimate)
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 200 * 1024, // 200KB
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 500 * 1024, // 500KB
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 300 * 1024, // 300KB
  };

  const mimeType = getEffectiveMimeType(file);
  if (!mimeType) return false;

  const threshold = thresholds[mimeType] || 200 * 1024; // Default 200KB
  return file.size > threshold;
}

// ============================================================================
// EXPORT ALL
// ============================================================================

export default {
  extractFileText,
  extractMultipleFiles,
  isExtractableFile,
  isLikelyLargeFile,
  getEffectiveMimeType,
  EXTRACTABLE_MIME_TYPES,
  EXTENSION_TO_MIME,
};
