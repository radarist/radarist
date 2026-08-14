/**
 * @file document-extraction.ts
 * @description Server-side document text extraction for PDF and DOCX files
 *
 * Supports:
 * - PDF files (using pdf-parse)
 * - DOCX files (using mammoth)
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import mammoth from 'mammoth';
import { createLogger } from '@/lib/logger';
const log = createLogger('document-extraction');

// pdf-parse is loaded via require() to avoid ESM bundling issues with Next.js/Turbopack
// The package doesn't have a proper ESM default export, so we use CommonJS require

let pdfParse: ((buffer: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>) | null =
  null;

function getPdfParser() {
  if (!pdfParse) {
    // Use require() for CommonJS module - this bypasses bundler ESM analysis

    pdfParse = require('pdf-parse');
  }
  return pdfParse;
}

/**
 * Result of document extraction
 */
export interface ExtractionResult {
  success: boolean;
  text: string;
  pageCount?: number;
  error?: string;
}

/**
 * Supported MIME types for document extraction
 */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
] as const;

/**
 * Maximum file size in bytes (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Extracts text from a PDF buffer
 */
async function extractFromPDF(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const parser = getPdfParser();
    if (!parser) throw new Error('PDF parser not available');
    const data = await parser(buffer);

    return {
      success: true,
      text: data.text,
      pageCount: data.numpages,
    };
  } catch (error) {
    log.error('PDF extraction error', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      text: '',
      error: `Failed to extract PDF: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extracts text from a DOCX buffer
 */
async function extractFromDOCX(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      success: true,
      text: result.value,
    };
  } catch (error) {
    log.error('DOCX extraction error', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      text: '',
      error: `Failed to extract DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extracts text from a PPTX buffer
 * Note: PPTX is basically a ZIP of XML files, mammoth doesn't support it directly
 * We'll extract what we can using a simple approach
 */
async function extractFromPPTX(buffer: Buffer): Promise<ExtractionResult> {
  try {
    // For PPTX, we'll use a simpler regex approach to extract text from XML
    // This is a fallback since mammoth doesn't support PPTX
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);

    const textParts: string[] = [];

    // Look for slide XML files
    const slideFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
    );

    for (const slideName of slideFiles.sort()) {
      const slideContent = await zip.files[slideName].async('string');
      // Extract text content from XML tags
      const textMatches = slideContent.match(/<a:t>([^<]*)<\/a:t>/g);
      if (textMatches) {
        const slideText = textMatches.map((match) => match.replace(/<\/?a:t>/g, '')).join(' ');
        textParts.push(slideText);
      }
    }

    return {
      success: true,
      text: textParts.join('\n\n'),
      pageCount: slideFiles.length,
    };
  } catch (error) {
    log.error('PPTX extraction error', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      text: '',
      error: `Failed to extract PPTX: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Main extraction function - routes to appropriate extractor based on MIME type
 *
 * @param buffer - File buffer
 * @param mimeType - MIME type of the file
 * @returns Extraction result with text content
 */
export async function extractTextFromDocument(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
  switch (mimeType) {
    case 'application/pdf':
      return extractFromPDF(buffer);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractFromDOCX(buffer);

    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return extractFromPPTX(buffer);

    default:
      return {
        success: false,
        text: '',
        error: `Unsupported file type: ${mimeType}`,
      };
  }
}

/**
 * Validates file before extraction
 */
export function validateFile(size: number, mimeType: string): { valid: boolean; error?: string } {
  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    };
  }

  if (!(SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return {
      valid: false,
      error: `Unsupported file type: ${mimeType}. Supported types: PDF, DOCX, PPTX`,
    };
  }

  return { valid: true };
}
