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
  SUPPORTED_MIME_TYPES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
}));

const { extractTextFromDocument } = jest.requireMock('@/lib/document-extraction');

import { POST, GET } from '../route';

function createMockGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/ai/extract-text', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createMockFormDataRequest(
  fileName: string,
  content: string | Uint8Array,
  mimeType: string
): NextRequest {
  const fileContent = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  const blob = new Blob([fileContent], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  const formData = new FormData();
  formData.append('file', file);

  return new NextRequest('http://localhost:3000/api/ai/extract-text', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
    body: formData,
  });
}

function createMockEmptyFormDataRequest(): NextRequest {
  const formData = new FormData();
  return new NextRequest('http://localhost:3000/api/ai/extract-text', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
    body: formData,
  });
}

// ============================================================================
// GET /api/ai/extract-text
// ============================================================================

describe('GET /api/ai/extract-text', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns extraction configuration', async () => {
    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.maxUploadSize).toBe(10 * 1024 * 1024);
    expect(json.maxUploadSizeMB).toBe(10);
    expect(json.maxTextSize).toBe(50 * 1024);
    expect(json.maxTextSizeKB).toBe(50);
    expect(json.supportedTypes).toBeDefined();
    expect(Array.isArray(json.supportedTypes)).toBe(true);
    expect(json.supportedExtensions).toBeDefined();
    expect(json.supportedExtensions).toContain('pdf');
    expect(json.supportedExtensions).toContain('txt');
  });
});

// ============================================================================
// POST /api/ai/extract-text
// ============================================================================

describe('POST /api/ai/extract-text', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockFormDataRequest('test.txt', 'Hello', 'text/plain'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when no file is provided', async () => {
    const res = await POST(createMockEmptyFormDataRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('No file provided');
  });

  it('extracts text from plain text file successfully', async () => {
    const textContent = 'Hello, this is a test document.';
    const res = await POST(createMockFormDataRequest('test.txt', textContent, 'text/plain'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.text).toBe(textContent);
    expect(json.fileName).toBe('test.txt');
    expect(json.mimeType).toBe('text/plain');
    expect(json.textSize).toBeGreaterThan(0);
    expect(json.isLargeFile).toBe(false);
  });

  it('extracts text from markdown file successfully', async () => {
    const mdContent = '# Title\n\nSome markdown content.';
    const res = await POST(createMockFormDataRequest('readme.md', mdContent, 'text/markdown'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.text).toBe(mdContent);
    expect(json.mimeType).toBe('text/markdown');
  });

  it('returns 400 for unsupported file type', async () => {
    const res = await POST(
      createMockFormDataRequest('data.json', '{"key": "value"}', 'application/json')
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Unsupported file type');
  });

  it('delegates PDF extraction to extractTextFromDocument', async () => {
    extractTextFromDocument.mockResolvedValue({
      success: true,
      text: 'PDF content extracted',
      pageCount: 5,
    });

    const res = await POST(
      createMockFormDataRequest('report.pdf', 'fake-pdf-bytes', 'application/pdf')
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.text).toBe('PDF content extracted');
    expect(json.pageCount).toBe(5);
    expect(extractTextFromDocument).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when extraction fails', async () => {
    extractTextFromDocument.mockResolvedValue({
      success: false,
      text: '',
      error: 'Failed to parse PDF',
    });

    const res = await POST(
      createMockFormDataRequest('corrupt.pdf', 'bad-data', 'application/pdf')
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Failed to parse PDF');
  });

  it('indicates large file when extracted text exceeds 50KB', async () => {
    // Create a large text (> 50KB)
    const largeText = 'x'.repeat(60 * 1024);
    const res = await POST(createMockFormDataRequest('large.txt', largeText, 'text/plain'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.isLargeFile).toBe(true);
    expect(json.suggestLibraryUpload).toBe(true);
  });

  it('infers MIME type from extension when type is application/octet-stream', async () => {
    extractTextFromDocument.mockResolvedValue({
      success: true,
      text: 'DOCX content',
      pageCount: 1,
    });

    // Create a file with octet-stream mime but .docx extension
    const blob = new Blob([Buffer.from('fake-docx')], { type: 'application/octet-stream' });
    const file = new File([blob], 'document.docx', { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', file);

    const req = new NextRequest('http://localhost:3000/api/ai/extract-text', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: formData,
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Should have inferred the DOCX mime type
    expect(json.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });
});
