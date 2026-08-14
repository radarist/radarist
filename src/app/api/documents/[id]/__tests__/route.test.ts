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

// Mock firebase-admin so the real SDK (and jwks-rsa via auth-utils) never loads.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

// Mock admin document service (source calls adminGetDocumentById from @/lib/document-admin)
jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminDeleteDocument: jest.fn(),
}));

const { adminGetDocumentById: getDocumentById, adminDeleteDocument: deleteDocument } =
  jest.requireMock('@/lib/document-admin');

import { DELETE, GET } from '../route';

function createMockRequest(method: 'GET' | 'DELETE' = 'GET'): NextRequest {
  const url = new URL('http://localhost:3000/api/documents/doc-1');
  return new NextRequest(url, {
    method,
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/documents/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 404 when document not found', async () => {
    getDocumentById.mockResolvedValue(null);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'nonexistent-doc' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Document not found');
  });

  it('returns 200 with all document fields on success', async () => {
    const mockDocument = {
      id: 'doc-1',
      title: 'Architecture Overview',
      type: 'pdf',
      status: 'processed',
      storageUrl: 'documents/123-abc-architecture.pdf',
      description: 'High-level architecture document',
      tags: ['architecture', 'overview'],
      fileSize: 204800,
      mimeType: 'application/pdf',
      pageCount: 12,
      chunkCount: 8,
      errorMessage: null,
      processedAt: '2026-01-20T10:00:00.000Z',
      createdAt: '2026-01-19T09:00:00.000Z',
      updatedAt: '2026-01-20T10:00:00.000Z',
    };
    getDocumentById.mockResolvedValue(mockDocument);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: 'doc-1',
      title: 'Architecture Overview',
      type: 'pdf',
      status: 'processed',
      storageUrl: 'documents/123-abc-architecture.pdf',
      description: 'High-level architecture document',
      tags: ['architecture', 'overview'],
      fileSize: 204800,
      mimeType: 'application/pdf',
      pageCount: 12,
      chunkCount: 8,
      errorMessage: null,
      processedAt: '2026-01-20T10:00:00.000Z',
      createdAt: '2026-01-19T09:00:00.000Z',
      updatedAt: '2026-01-20T10:00:00.000Z',
    });
  });

  /**
   * UX-036: a `processing` status is only trustworthy alongside the instant its
   * run was accepted. `document-processing-policy.ts` reports an UNSTAMPED
   * `processing` document as active forever (deliberately — the recovery action
   * is destructive), so a projection that shipped `status` while dropping
   * `processingRequestedAt` left every consumer of this route unable to tell a
   * live run from one abandoned by a dead worker.
   */
  it('exposes the accepted-run stamp alongside a processing status', async () => {
    const requestedAt = 1_800_000_000_000;
    getDocumentById.mockResolvedValue({
      id: 'doc-live',
      title: 'In flight',
      type: 'pdf',
      status: 'processing',
      storageUrl: 'documents/doc-live.pdf',
      processingRequestedAt: requestedAt,
    });

    const res = await GET(createMockRequest(), { params: Promise.resolve({ id: 'doc-live' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('processing');
    expect(json.processingRequestedAt).toBe(requestedAt);
  });

  it('returns 500 on server error', async () => {
    getDocumentById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });
});

describe('DELETE /api/documents/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects unauthenticated deletes before reading the document', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const response = await DELETE(createMockRequest('DELETE'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(401);
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it.each(['absent', 'foreign', 'ownerless legacy', 'ownership-raced'])(
    'returns the same 404 for an %s document',
    async () => {
      deleteDocument.mockResolvedValueOnce(false);

      const response = await DELETE(createMockRequest('DELETE'), {
        params: Promise.resolve({ id: 'doc-1' }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Document not found' });
      expect(getDocumentById).not.toHaveBeenCalled();
      expect(deleteDocument).toHaveBeenCalledWith('doc-1', { kind: 'user', uid: 'test-user-123' });
    }
  );

  it('deletes an owned document through the ordered admin boundary', async () => {
    deleteDocument.mockResolvedValueOnce(true);

    const response = await DELETE(createMockRequest('DELETE'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(getDocumentById).not.toHaveBeenCalled();
    expect(deleteDocument).toHaveBeenCalledWith('doc-1', { kind: 'user', uid: 'test-user-123' });
  });

  it('does not expose an internal deletion failure', async () => {
    deleteDocument.mockRejectedValueOnce(new Error('neo4j.internal: secret detail'));

    const response = await DELETE(createMockRequest('DELETE'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Document deletion failed' });
  });
});
