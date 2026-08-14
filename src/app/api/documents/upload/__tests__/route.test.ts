/**
 * @file route.test.ts
 * @description Unit tests for POST/GET /api/documents/upload
 *
 * @jest-environment node
 */

import { POST, GET } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {},
  adminAuth: {},
  adminApp: {},
}));

jest.mock('@/lib/document-storage-service', () => ({
  validateFile: jest.fn(),
  ALLOWED_MIME_TYPES: {
    'application/pdf': 'pdf',
    'text/plain': 'text',
  } as Record<string, string>,
  MAX_FILE_SIZE: 10 * 1024 * 1024,
}));

jest.mock('@/lib/document-storage-admin', () => ({
  adminUploadDocument: jest.fn(),
}));

jest.mock('@/lib/document-admin', () => ({
  adminCreateDocument: jest.fn(),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));

jest.mock('@/lib/document-processing-service', () => ({
  processDocument: jest.fn(),
}));

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { validateFile } = jest.requireMock('@/lib/document-storage-service');
const { adminUploadDocument: uploadDocument } = jest.requireMock('@/lib/document-storage-admin');
const { adminCreateDocument: createDocument } = jest.requireMock('@/lib/document-admin');

function createFormDataRequest(formData: FormData, url = 'http://localhost/api/documents/upload'): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: formData,
  });
}

function createGetRequest(url = 'http://localhost/api/documents/upload'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('POST /api/documents/upload', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const formData = new FormData();
    formData.append('file', new File(['content'], 'test.pdf', { type: 'application/pdf' }));
    formData.append('userId', 'user-1');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when no file provided', async () => {
    const formData = new FormData();
    formData.append('userId', 'user-1');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('No file provided');
  });

  it('uses the authenticated uid as owner and IGNORES a body-supplied userId (no spoofing)', async () => {
    validateFile.mockReturnValue({ valid: true, documentType: 'pdf' });
    uploadDocument.mockResolvedValue({
      success: true,
      storageUrl: 'gs://bucket/doc.pdf',
      downloadUrl: 'https://storage.example.com/doc.pdf',
      size: 1234,
      mimeType: 'application/pdf',
    });
    createDocument.mockResolvedValue({
      id: 'doc-123',
      title: 'test.pdf',
      type: 'pdf',
      status: 'uploaded',
      storageUrl: 'gs://bucket/doc.pdf',
      fileSize: 1234,
      mimeType: 'application/pdf',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const formData = new FormData();
    formData.append('file', new File(['content'], 'test.pdf', { type: 'application/pdf' }));
    // Attacker tries to own the doc as someone else:
    formData.append('userId', 'victim-user');

    const res = await POST(createFormDataRequest(formData));
    expect(res.status).toBe(200);
    // Owner must be the authenticated session uid, not the body value.
    expect(uploadDocument).toHaveBeenCalledWith(expect.anything(), 'test.pdf', 'application/pdf', 'test-user-123');
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: 'test-user-123' }));
  });

  it('returns 400 when file validation fails', async () => {
    validateFile.mockReturnValue({
      valid: false,
      error: 'File too large',
    });

    const formData = new FormData();
    formData.append('file', new File(['content'], 'huge.pdf', { type: 'application/pdf' }));
    formData.append('userId', 'user-1');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('File too large');
    expect(validateFile).toHaveBeenCalledWith(expect.any(Number), 'application/pdf');
  });

  it('returns 500 when upload fails', async () => {
    validateFile.mockReturnValue({ valid: true, documentType: 'pdf' });
    uploadDocument.mockResolvedValue({
      success: false,
      error: 'Storage unavailable',
    });

    const formData = new FormData();
    formData.append('file', new File(['content'], 'test.pdf', { type: 'application/pdf' }));
    formData.append('userId', 'user-1');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Storage unavailable');
  });

  it('uploads document and returns success', async () => {
    validateFile.mockReturnValue({ valid: true, documentType: 'pdf' });
    uploadDocument.mockResolvedValue({
      success: true,
      storageUrl: 'gs://bucket/doc.pdf',
      downloadUrl: 'https://storage.example.com/doc.pdf',
      size: 1234,
      mimeType: 'application/pdf',
    });
    createDocument.mockResolvedValue({
      id: 'doc-123',
      title: 'test.pdf',
      type: 'pdf',
      status: 'uploaded',
      storageUrl: 'gs://bucket/doc.pdf',
      fileSize: 1234,
      mimeType: 'application/pdf',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const formData = new FormData();
    formData.append('file', new File(['content'], 'test.pdf', { type: 'application/pdf' }));
    formData.append('userId', 'user-1');
    formData.append('title', 'My Document');
    formData.append('tags', 'ai, test, report');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.document.id).toBe('doc-123');
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My Document',
        type: 'pdf',
        storageUrl: 'gs://bucket/doc.pdf',
        tags: ['ai', 'test', 'report'],
        uploadedBy: 'test-user-123',
      })
    );
  });

  it('returns 500 when an unexpected error occurs', async () => {
    validateFile.mockReturnValue({ valid: true, documentType: 'pdf' });
    uploadDocument.mockRejectedValue(new Error('Network error'));

    const formData = new FormData();
    formData.append('file', new File(['content'], 'test.pdf', { type: 'application/pdf' }));
    formData.append('userId', 'user-1');

    const res = await POST(createFormDataRequest(formData));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error during document upload');
  });
});

describe('GET /api/documents/upload', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns upload configuration with allowed types and max size', async () => {
    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.maxFileSize).toBe(10 * 1024 * 1024);
    expect(json.maxFileSizeMB).toBe(10);
    expect(json.allowedTypes).toEqual(expect.arrayContaining(['application/pdf', 'text/plain']));
    expect(json.allowedExtensions).toEqual(expect.arrayContaining(['pdf', 'txt', 'md']));
  });
});
