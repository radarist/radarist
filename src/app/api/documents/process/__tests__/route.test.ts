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

// Mock document processing service. `@/lib/document-reprocess` — which the
// route now delegates to — is deliberately left UNMOCKED so these tests still
// exercise the real source-selection decision (UX-036: this route used to call
// `processDocument` unconditionally, so URL documents always 422'd).
jest.mock('@/lib/document-processing-service', () => ({
  processDocument: jest.fn(),
  processDocumentFromContent: jest.fn(),
  processDocuments: jest.fn(),
  getDocumentsPendingProcessing: jest.fn(),
}));

// Mock document admin service (route now uses adminGetDocumentById)
jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn(),
}));

jest.mock('@/lib/tdm-policy', () => ({ checkTdmPolicy: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock('@/lib/firecrawl-fetch', () => ({ fetchUrlContentReceipted: jest.fn() }));

const { processDocument, processDocumentFromContent, getDocumentsPendingProcessing } = jest.requireMock(
  '@/lib/document-processing-service'
);
const { adminGetDocumentById: getDocumentById } = jest.requireMock('@/lib/document-admin');
const { fetchUrlContentReceipted } = jest.requireMock('@/lib/firecrawl-fetch');

/** A file-backed document: stored bytes exist, so the stored-file path applies. */
const FILE_DOC = { id: 'doc-1', title: 'Test Doc', type: 'pdf', storageUrl: 'documents/doc-1.pdf' };
/** A URL document: no stored bytes, only a source URL. */
const URL_DOC = {
  id: 'doc-1',
  title: 'Test URL Doc',
  type: 'url',
  storageUrl: '',
  originalUrl: 'https://example.com/a',
};

import { POST, GET } from '../route';

function createMockPostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/process', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createMockGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/process', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ============================================================================
// POST /api/documents/process
// ============================================================================

describe('POST /api/documents/process', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when neither documentId nor documentIds is provided', async () => {
    const res = await POST(createMockPostRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Either documentId or documentIds is required');
  });

  it('returns 400 when both documentId and documentIds are provided', async () => {
    const res = await POST(createMockPostRequest({ documentId: 'doc-1', documentIds: ['doc-2'] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Provide either documentId or documentIds, not both');
  });

  it('returns 404 when single document is not found', async () => {
    getDocumentById.mockResolvedValue(null);

    const res = await POST(createMockPostRequest({ documentId: 'nonexistent' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
  });

  it('processes single document successfully', async () => {
    getDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({
      success: true,
      documentId: 'doc-1',
      textLength: 5000,
      pageCount: 3,
      chunkCount: 10,
    });

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.result.documentId).toBe('doc-1');
    expect(json.result.textLength).toBe(5000);
    expect(json.result.chunkCount).toBe(10);
  });

  it('returns 422 when single document processing fails', async () => {
    getDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({
      success: false,
      documentId: 'doc-1',
      error: 'Text extraction failed',
      stage: 'extraction',
    });

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Text extraction failed');
    expect(json.stage).toBe('extraction');
  });

  /**
   * UX-036b regression. A URL document has `storageUrl: ''`. This route used to
   * call `processDocument` unconditionally, which downloaded nothing and
   * answered 422, leaving a URL document stuck after Retry reset a failed
   * document to `uploaded` and the row menu offered "Process".
   */
  it('processes a URL document from its source URL instead of the stored-file path', async () => {
    getDocumentById.mockResolvedValue(URL_DOC);
    fetchUrlContentReceipted.mockResolvedValue({
      success: true,
      content: 'Fetched article body',
      usedFirecrawl: false,
    });
    processDocumentFromContent.mockResolvedValue({
      success: true,
      documentId: 'doc-1',
      textLength: 20,
      chunkCount: 2,
    });

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.result.source).toBe('source-url');
    expect(processDocument).not.toHaveBeenCalled();
    expect(processDocumentFromContent).toHaveBeenCalledWith('doc-1', 'Fetched article body', expect.any(Object));
  });

  it('returns 400 with a nameable reason when a document has neither stored bytes nor a source URL', async () => {
    getDocumentById.mockResolvedValue({ id: 'doc-1', title: 'Orphan', type: 'pdf', storageUrl: '' });

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('no-source');
    expect(json.error).toContain('no stored file and no source URL');
  });

  /**
   * UX-036 — this route runs the pipeline INLINE in the HTTP request. It is a
   * programmatic/batch endpoint (the UI now uses the acknowledged
   * `/api/documents/retry` enqueue for both Process and Retry), but it must
   * still not become a second writer racing a live claimed worker run: both
   * paths call `replaceExisting`, so two concurrent runs delete and recreate
   * the same document's chunks.
   *
   * Refusal is keyed on the TIME-BOUNDED liveness check, not the raw status, so
   * a `processing` flag left behind by a dead worker cannot lock the endpoint
   * out forever.
   */
  describe('live-run guard', () => {
    it('refuses to run a second pass while a claimed run is still live', async () => {
      getDocumentById.mockResolvedValue({
        ...FILE_DOC,
        status: 'processing',
        processingRequestedAt: Date.now(),
      });

      const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.code).toBe('already-running');
      expect(processDocument).not.toHaveBeenCalled();
    });

    it('proceeds once the claimed run has gone stale', async () => {
      getDocumentById.mockResolvedValue({
        ...FILE_DOC,
        status: 'processing',
        // 16 minutes ago — past PROCESSING_STALE_MS, so the run is abandoned.
        processingRequestedAt: Date.now() - 16 * 60 * 1000,
      });
      processDocument.mockResolvedValue({
        success: true,
        documentId: 'doc-1',
        textLength: 10,
        chunkCount: 1,
        chunkIds: ['c1'],
        extractedText: 'recovered',
      });

      const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));

      expect(res.status).toBe(200);
      expect(processDocument).toHaveBeenCalledWith('doc-1', expect.any(Object));
    });
  });

  it('processes multiple documents successfully', async () => {
    // The batch branch now uses the SAME shared operation as the single
    // branch, so the batch exercises real source selection per document.
    getDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({ success: true, documentId: 'doc-1', textLength: 5000, chunkCount: 10 });

    const res = await POST(createMockPostRequest({ documentIds: ['doc-1', 'doc-2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.summary.total).toBe(2);
    expect(json.summary.successful).toBe(2);
    expect(json.summary.failed).toBe(0);
  });

  it('reports partial failures in batch processing', async () => {
    getDocumentById.mockResolvedValue(FILE_DOC);
    processDocument
      .mockResolvedValueOnce({ success: true, documentId: 'doc-1', textLength: 5000, chunkCount: 10 })
      .mockResolvedValueOnce({ success: false, documentId: 'doc-2', error: 'Corrupt file', stage: 'extraction' });

    const res = await POST(createMockPostRequest({ documentIds: ['doc-1', 'doc-2'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.summary.successful).toBe(1);
    expect(json.summary.failed).toBe(1);
    expect(json.message).toContain('1/2');
  });

  /**
   * UX-036b, batch edition. This branch used to call `processDocuments`, which
   * loops over the unconditional stored-file path — so a URL document in a
   * batch still failed with a download error after the single-document branch
   * was fixed.
   */
  it('processes a URL document inside a BATCH from its source URL', async () => {
    getDocumentById.mockResolvedValue(URL_DOC);
    fetchUrlContentReceipted.mockResolvedValue({ success: true, content: 'Fetched body', usedFirecrawl: false });
    processDocumentFromContent.mockResolvedValue({ success: true, documentId: 'doc-1', textLength: 12, chunkCount: 1 });

    const res = await POST(createMockPostRequest({ documentIds: ['doc-1'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.summary.successful).toBe(1);
    expect(json.results[0].source).toBe('source-url');
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('returns 400 when documentIds array is empty', async () => {
    const res = await POST(createMockPostRequest({ documentIds: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('documentIds array cannot be empty');
  });

  it('returns 400 when documentIds exceeds limit of 50', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `doc-${i}`);
    const res = await POST(createMockPostRequest({ documentIds: ids }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Maximum 50 documents can be processed at once');
  });

  it('passes chunk options through to processDocument', async () => {
    getDocumentById.mockResolvedValue({ id: 'doc-1', title: 'Test Doc' });
    processDocument.mockResolvedValue({
      success: true,
      documentId: 'doc-1',
      textLength: 5000,
      pageCount: 3,
      chunkCount: 20,
    });

    getDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({ success: true, documentId: 'doc-1', textLength: 1, chunkCount: 1 });

    await POST(
      createMockPostRequest({
        documentId: 'doc-1',
        chunkSize: 500,
        chunkOverlap: 100,
        replaceExisting: false,
      })
    );

    expect(processDocument).toHaveBeenCalledWith('doc-1', {
      chunkSize: 500,
      chunkOverlap: 100,
      replaceExisting: false,
    });
  });

  it('returns 500 on unexpected server error', async () => {
    getDocumentById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await POST(createMockPostRequest({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error during document processing');
  });
});

// ============================================================================
// GET /api/documents/process
// ============================================================================

describe('GET /api/documents/process', () => {
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

  it('returns pending documents', async () => {
    getDocumentsPendingProcessing.mockResolvedValue([
      { id: 'doc-1', title: 'Pending Doc', type: 'pdf', status: 'uploaded', fileSize: 1024, createdAt: 1700000000000 },
    ]);

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBe(1);
    expect(json.documents).toHaveLength(1);
    expect(json.documents[0].id).toBe('doc-1');
  });

  it('returns empty list when no pending documents', async () => {
    getDocumentsPendingProcessing.mockResolvedValue([]);

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBe(0);
    expect(json.documents).toHaveLength(0);
  });

  it('returns 500 on server error', async () => {
    getDocumentsPendingProcessing.mockRejectedValue(new Error('DB error'));

    const res = await GET(createMockGetRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error getting pending documents');
  });
});
