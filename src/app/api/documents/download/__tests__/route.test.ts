/**
 * @jest-environment node
 *
 * Route regressions for `GET /api/documents/download`, including the SEC-015
 * ownership control: the order of operations (authenticate → validate →
 * authorize → read), the single indistinguishable refusal, and the header
 * sanitization the served filename always needed.
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

// Mock document services (admin twins — source uses admin SDK access)
jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentForDownload: jest.fn(),
}));

jest.mock('@/lib/document-storage-admin', () => ({
  adminGetOwnedDocumentContent: jest.fn(),
}));

const { adminGetDocumentForDownload: getDocumentForDownload } = jest.requireMock('@/lib/document-admin');
const { adminGetOwnedDocumentContent: getOwnedDocumentContent } = jest.requireMock('@/lib/document-storage-admin');

import { GET } from '../route';

function createMockRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/documents/download');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

/** An authorized owner whose document points at `storageUrl`. */
function authorizeOwner(document: Record<string, unknown>, ownerId = 'test-user-123') {
  getDocumentForDownload.mockResolvedValue({ authorized: true, ownerId, document });
}

describe('GET /api/documents/download', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest({ id: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Authentication required');
  });

  it('does not forward the raw token-verification failure, or look anything up', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Firebase ID token has invalid signature. See https://firebase.google.com/docs/auth/admin/…',
    });

    const res = await GET(createMockRequest({ id: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Authentication required');
    expect(json.error).not.toMatch(/signature|firebase/i);
    // Authentication precedes any document lookup or content access.
    expect(getDocumentForDownload).not.toHaveBeenCalled();
    expect(getOwnedDocumentContent).not.toHaveBeenCalled();
  });

  it('returns 400 when document ID is missing', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Document ID is required');
    expect(getDocumentForDownload).not.toHaveBeenCalled();
    expect(getOwnedDocumentContent).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only id as missing', async () => {
    const res = await GET(createMockRequest({ id: '   ' }));

    expect(res.status).toBe(400);
    expect(getDocumentForDownload).not.toHaveBeenCalled();
  });

  it('authorizes against the verified uid, never a query parameter', async () => {
    getDocumentForDownload.mockResolvedValue({ authorized: false, reason: 'not-owner' });

    await GET(createMockRequest({ id: 'doc-1', uid: 'someone-else' }));

    expect(getDocumentForDownload).toHaveBeenCalledWith('doc-1', 'test-user-123');
  });

  // The three refusal reasons must be indistinguishable at the HTTP boundary,
  // otherwise the route is an existence oracle for other users' documents.
  it.each([['not-found'], ['not-owner'], ['ownerless']])(
    'answers a %s refusal with the same bounded 404 and reads no content',
    async (reason) => {
      getDocumentForDownload.mockResolvedValue({ authorized: false, reason });

      const res = await GET(createMockRequest({ id: 'doc-1' }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json).toEqual({ error: 'Document not found' });
      expect(getOwnedDocumentContent).not.toHaveBeenCalled();
    }
  );

  it('returns 404 when document content is not found in storage', async () => {
    authorizeOwner({ id: 'doc-1', title: 'Test Document', storageUrl: 'documents/123-abc-test.pdf' });
    getOwnedDocumentContent.mockResolvedValue(null);

    const res = await GET(createMockRequest({ id: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Document file not found in storage');
  });

  it('returns file download with correct headers on success', async () => {
    const mockContent = Buffer.from('PDF file content here');
    authorizeOwner({ id: 'doc-1', title: 'Test Document', storageUrl: 'documents/1234-abcd-report.pdf' });
    getOwnedDocumentContent.mockResolvedValue({
      content: mockContent,
      mimeType: 'application/pdf',
    });

    const res = await GET(createMockRequest({ id: 'doc-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('report.pdf');
    expect(res.headers.get('Content-Length')).toBe(String(mockContent.length));
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(mockContent)).toBe(true);
  });

  it('reads content through the owner-bound reader, bound to the document owner', async () => {
    authorizeOwner({ id: 'doc-1', title: 'Owned', storageUrl: 'documents/test-user-123/f.pdf' });
    getOwnedDocumentContent.mockResolvedValue({ content: Buffer.from('x'), mimeType: 'application/pdf' });

    await GET(createMockRequest({ id: 'doc-1' }));

    expect(getOwnedDocumentContent).toHaveBeenCalledWith('documents/test-user-123/f.pdf', 'test-user-123');
  });

  it('appends correct file extension based on MIME type', async () => {
    const mockContent = Buffer.from('DOCX content');
    authorizeOwner({ id: 'doc-2', title: 'My Report', storageUrl: 'documents/5678-efgh-myfile' });
    getOwnedDocumentContent.mockResolvedValue({
      content: mockContent,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const res = await GET(createMockRequest({ id: 'doc-2' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('.docx');
  });

  it('cannot be made to emit a broken-out or split Content-Disposition header', async () => {
    authorizeOwner({
      id: 'doc-3',
      // A title is caller-authored free text and reached the header verbatim.
      title: 'Quarterly "Revenue"\r\nSet-Cookie: a=b',
      storageUrl: '',
    });
    getOwnedDocumentContent.mockResolvedValue({ content: Buffer.from('md'), mimeType: 'text/markdown' });

    const res = await GET(createMockRequest({ id: 'doc-3' }));

    expect(res.status).toBe(200);
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toBe('attachment; filename="Quarterly-Revenue-Set-Cookie-a-b.md"');
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('returns 500 on unexpected server error', async () => {
    getDocumentForDownload.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest({ id: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error during document download');
  });
});
