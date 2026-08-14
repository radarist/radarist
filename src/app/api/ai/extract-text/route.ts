/**
 * @file api/ai/extract-text/route.ts
 * @description API endpoint for extracting text from files for AI chat context.
 *
 * POST /api/ai/extract-text
 * - Accepts multipart/form-data with a file
 * - Validates file size (max 50KB of extracted text for quick mode)
 * - Supports PDF, DOCX, PPTX, XLSX, TXT, MD
 * - Returns extracted text for inline AI context
 *
 * This is the "Quick Mode" extraction for small files that can be passed
 * directly to the AI as context.
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { NextRequest, NextResponse } from 'next/server';
import { extractTextFromDocument, SUPPORTED_MIME_TYPES as DOCUMENT_MIME_TYPES } from '@/lib/document-extraction';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/ai/extract-text');

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum file size for upload (10MB raw file).
 */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Maximum extracted text size for quick mode (50KB).
 * Larger texts should use the full library integration.
 */
const MAX_TEXT_SIZE = 50 * 1024;

/**
 * Supported MIME types for text extraction.
 * Includes document types + plain text formats.
 */
const SUPPORTED_MIME_TYPES = [
  ...DOCUMENT_MIME_TYPES,
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
];

/**
 * File extension to MIME type mapping for fallback detection.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
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
 * Get MIME type from file extension as fallback.
 */
function getMimeTypeFromExtension(fileName: string): string | null {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  return EXTENSION_TO_MIME[ext] || null;
}

/**
 * Extract text from plain text files (TXT, MD).
 */
async function extractFromPlainText(buffer: Buffer): Promise<{
  success: boolean;
  text: string;
  error?: string;
}> {
  try {
    const text = buffer.toString('utf-8');
    return { success: true, text };
  } catch (error) {
    return {
      success: false,
      text: '',
      error: `Failed to read text file: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extract text from XLSX (Excel) files.
 *
 * Uses ExcelJS (MIT) rather than SheetJS — SheetJS dropped npm distribution
 * and its last published version has unpatched prototype-pollution + ReDoS
 * advisories. The maintained dependency policy is documented in SECURITY.md.
 */
async function extractFromXLSX(buffer: Buffer): Promise<{
  success: boolean;
  text: string;
  pageCount?: number;
  error?: string;
}> {
  try {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled @types/node uses an older Buffer signature; pass the
    // underlying ArrayBuffer slice to side-step the type mismatch.
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await workbook.xlsx.load(ab as ArrayBuffer);

    const textParts: string[] = [];
    let sheetCount = 0;

    workbook.eachSheet((sheet) => {
      sheetCount++;
      const rows: string[] = [];

      sheet.eachRow({ includeEmpty: false }, (row) => {
        // row.values is 1-indexed in exceljs; drop the leading undefined slot.
        const values = (row.values as Array<unknown>).slice(1);
        const cells = values.map((v) => {
          if (v == null) return '';
          if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
            return String((v as { text: unknown }).text ?? '');
          }
          if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
            return String((v as { result: unknown }).result ?? '');
          }
          return String(v);
        });
        rows.push(cells.join(','));
      });

      if (rows.length > 0) {
        textParts.push(`## Sheet: ${sheet.name}\n${rows.join('\n')}`);
      }
    });

    return {
      success: true,
      text: textParts.join('\n\n'),
      pageCount: sheetCount,
    };
  } catch (error) {
    log.error('XLSX extraction failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      text: '',
      error: `Failed to extract XLSX: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Main extraction function - routes to appropriate extractor.
 */
async function extractText(
  buffer: Buffer,
  mimeType: string
): Promise<{
  success: boolean;
  text: string;
  pageCount?: number;
  error?: string;
}> {
  // Handle plain text files
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return extractFromPlainText(buffer);
  }

  // Handle XLSX files
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return extractFromXLSX(buffer);
  }

  // Handle other document types (PDF, DOCX, PPTX)
  return extractTextFromDocument(buffer, mimeType);
}

// ============================================================================
// API HANDLER
// ============================================================================

/**
 * POST handler for text extraction.
 *
 * Expected form data:
 * - file: The document file (required)
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const formData = await request.formData();

    // Extract file
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    // Validate file size (raw upload)
    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        {
          success: false,
          error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE / (1024 * 1024)}MB`,
        },
        { status: 400 }
      );
    }

    // Determine MIME type (with fallback to extension)
    let mimeType = file.type;
    if (!mimeType || mimeType === 'application/octet-stream') {
      const inferred = getMimeTypeFromExtension(file.name);
      if (inferred) {
        mimeType = inferred;
      }
    }

    // Validate MIME type
    if (!SUPPORTED_MIME_TYPES.includes(mimeType as (typeof SUPPORTED_MIME_TYPES)[number])) {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported file type: ${mimeType || 'unknown'}. Supported types: PDF, DOCX, PPTX, XLSX, TXT, MD`,
        },
        { status: 400 }
      );
    }

    // Convert to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text
    log.info('Extracting text from file', { fileName: file.name, mimeType, fileSize: file.size });
    const result = await extractText(buffer, mimeType);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || 'Extraction failed' }, { status: 500 });
    }

    // Check extracted text size for quick mode
    const textSize = Buffer.byteLength(result.text, 'utf-8');
    const isLargeFile = textSize > MAX_TEXT_SIZE;

    log.info('Text extraction complete', { fileName: file.name, textSize, isLargeFile });

    return NextResponse.json({
      success: true,
      text: result.text,
      pageCount: result.pageCount,
      fileName: file.name,
      mimeType,
      originalSize: file.size,
      textSize,
      isLargeFile,
      // Suggest library upload for large files
      suggestLibraryUpload: isLargeFile,
    });
  } catch (error) {
    log.error('Text extraction failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error during text extraction',
      },
      { status: 500 }
    );
  }
}

/**
 * GET handler for extraction configuration.
 * Returns supported file types and size limits.
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  return NextResponse.json({
    maxUploadSize: MAX_UPLOAD_SIZE,
    maxUploadSizeMB: MAX_UPLOAD_SIZE / (1024 * 1024),
    maxTextSize: MAX_TEXT_SIZE,
    maxTextSizeKB: MAX_TEXT_SIZE / 1024,
    supportedTypes: SUPPORTED_MIME_TYPES,
    supportedExtensions: Object.keys(EXTENSION_TO_MIME).map((ext) => ext.slice(1)),
  });
}
