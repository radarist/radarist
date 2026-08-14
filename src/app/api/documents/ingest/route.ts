/**
 * @file route.ts
 * @description API endpoint for document ingestion and entity extraction
 *
 * POST /api/documents/ingest
 * - Accepts multipart/form-data with a file
 * - Extracts text from PDF, DOCX, or PPTX
 * - Uses AI to identify entities (technologies, companies, use cases)
 * - Returns suggested entities for user review
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/ingest');
import { extractTextFromDocument, validateFile } from '@/lib/document-extraction';
import { suggestRelations } from '@/lib/auto-linker';

/**
 * POST handler for document ingestion
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file
    const validation = validateFile(file.size, file.type);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text from document
    const extraction = await extractTextFromDocument(buffer, file.type);

    if (!extraction.success) {
      return NextResponse.json({ error: extraction.error || 'Failed to extract text from document' }, { status: 422 });
    }

    if (!extraction.text || extraction.text.trim().length < 50) {
      return NextResponse.json({ error: 'Document contains too little text to analyze' }, { status: 422 });
    }

    // Use auto-linker to suggest entities from extracted text
    // We use "signal" as the source type since this is an import operation
    const suggestions = await suggestRelations(extraction.text, 'signal', `doc-${Date.now()}`);

    return NextResponse.json({
      success: true,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      pageCount: extraction.pageCount,
      textLength: extraction.text.length,
      extractedText: extraction.text.substring(0, 2000), // Preview only
      suggestions,
    });
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error during document processing' }, { status: 500 });
  }
}
