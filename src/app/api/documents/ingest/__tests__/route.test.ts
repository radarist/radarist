/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock document extraction
jest.mock('@/lib/document-extraction', () => ({
  extractTextFromDocument: jest.fn(),
  validateFile: jest.fn(),
}));

// Mock auto-linker
jest.mock('@/lib/auto-linker', () => ({
  suggestRelations: jest.fn().mockResolvedValue({ entities: [] }),
}));

const { extractTextFromDocument, validateFile } =
  jest.requireMock('@/lib/document-extraction');
const { suggestRelations } = jest.requireMock('@/lib/auto-linker');

import { POST } from '../route';

// Helper: generate text of at least 50 chars for the minimum-length check
const LONG_TEXT = 'This is a sufficiently long document text that exceeds the fifty character minimum requirement for analysis by the auto-linker engine.';
const SHORT_TEXT = 'Too short';

function createFormDataRequest(file?: File): NextRequest {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  return new NextRequest('http://localhost:3000/api/documents/ingest', {
    method: 'POST',
    body: formData,
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ============================================================================
// POST /api/documents/ingest
// ============================================================================

describe('POST /api/documents/ingest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when no file provided', async () => {
    const res = await POST(createFormDataRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('No file provided');
  });

  it('returns 400 when file validation fails', async () => {
    validateFile.mockReturnValue({
      valid: false,
      error: 'File type not supported',
    });

    const file = new File(['content'], 'test.exe', {
      type: 'application/x-msdownload',
    });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('File type not supported');
    expect(validateFile).toHaveBeenCalledWith(file.size, file.type);
  });

  it('returns 422 when text extraction fails', async () => {
    validateFile.mockReturnValue({ valid: true });
    extractTextFromDocument.mockResolvedValue({
      success: false,
      error: 'Corrupt PDF file',
    });

    const file = new File(['corrupt data'], 'broken.pdf', {
      type: 'application/pdf',
    });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toBe('Corrupt PDF file');
  });

  it('returns 422 when extracted text is too short', async () => {
    validateFile.mockReturnValue({ valid: true });
    extractTextFromDocument.mockResolvedValue({
      success: true,
      text: SHORT_TEXT,
      pageCount: 1,
    });

    const file = new File(['tiny'], 'small.pdf', { type: 'application/pdf' });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toBe('Document contains too little text to analyze');
  });

  it('returns success with suggestions when extraction succeeds', async () => {
    validateFile.mockReturnValue({ valid: true });
    extractTextFromDocument.mockResolvedValue({
      success: true,
      text: LONG_TEXT,
      pageCount: 3,
    });
    suggestRelations.mockResolvedValue({
      entities: [
        { type: 'technology', name: 'React', confidence: 0.95 },
        { type: 'company', name: 'Meta', confidence: 0.88 },
      ],
    });

    const file = new File([LONG_TEXT], 'report.pdf', {
      type: 'application/pdf',
    });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.fileName).toBe('report.pdf');
    expect(json.mimeType).toBe('application/pdf');
    expect(json.pageCount).toBe(3);
    expect(json.textLength).toBe(LONG_TEXT.length);
    expect(json.suggestions.entities).toHaveLength(2);
    expect(suggestRelations).toHaveBeenCalledWith(
      LONG_TEXT,
      'signal',
      expect.stringMatching(/^doc-\d+$/)
    );
  });

  it('truncates extractedText preview to 2000 characters', async () => {
    const veryLongText = 'A'.repeat(5000);
    validateFile.mockReturnValue({ valid: true });
    extractTextFromDocument.mockResolvedValue({
      success: true,
      text: veryLongText,
      pageCount: 10,
    });

    const file = new File([veryLongText], 'long.pdf', {
      type: 'application/pdf',
    });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.extractedText).toHaveLength(2000);
    expect(json.textLength).toBe(5000);
  });

  it('returns 500 on unexpected server error', async () => {
    validateFile.mockReturnValue({ valid: true });
    extractTextFromDocument.mockRejectedValue(
      new Error('Unexpected crash')
    );

    const file = new File(['data'], 'crash.pdf', { type: 'application/pdf' });
    const res = await POST(createFormDataRequest(file));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe(
      'Internal server error during document processing'
    );
  });
});
