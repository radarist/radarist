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

// Mock document admin service (route now uses admin SDK helpers)
jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn(),
}));

// Mock document processing service. The route now delegates to
// `@/lib/document-reprocess`, which is deliberately left UNMOCKED so these
// tests keep exercising the real TDM gate + fetch + process decision — the
// only type-correct implementation in the tree, which used to live inline in
// this route and had zero callers (UX-036).
jest.mock('@/lib/document-processing-service', () => ({
  processDocument: jest.fn(),
  processDocumentFromContent: jest.fn(),
}));

// AUDIT-007. Mocked rather than left to run: checkTdmPolicy issues three real
// fetches (robots.txt + two ai.txt locations) BEFORE the content fetch, and the
// tests below queue `mockFetch` responses positionally — unmocked it shifts the
// queue and the article fetch consumes the robots response.
jest.mock('@/lib/tdm-policy', () => ({ checkTdmPolicy: jest.fn() }));

const { adminGetDocumentById: getDocumentById, adminUpdateDocument: updateDocument } =
  jest.requireMock('@/lib/document-admin');
const { processDocumentFromContent } = jest.requireMock('@/lib/document-processing-service');
const { checkTdmPolicy } = jest.requireMock('@/lib/tdm-policy');

// Save original env and fetch
const originalEnv = process.env;
const originalFetch = global.fetch;

// Mock global fetch for URL content fetching
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { POST } from '../route';

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/reprocess-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

function createMockDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-123',
    title: 'Test Document',
    type: 'url',
    status: 'processed',
    originalUrl: 'https://example.com/article',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// POST /api/documents/reprocess-url
// ============================================================================

describe('POST /api/documents/reprocess-url', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkTdmPolicy.mockResolvedValue({ allowed: true });
    // Ensure Firecrawl path is skipped - test the basic fetch path
    delete process.env.FIRECRAWL_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  // --------------------------------------------------------------------------
  // Input Validation
  // --------------------------------------------------------------------------

  it('returns 400 when documentId is missing', async () => {
    const res = await POST(createMockRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('documentId is required');
  });

  // --------------------------------------------------------------------------
  // Document Existence
  // --------------------------------------------------------------------------

  it('returns 404 when document not found', async () => {
    getDocumentById.mockResolvedValue(null);

    const res = await POST(createMockRequest({ documentId: 'nonexistent' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
    expect(getDocumentById).toHaveBeenCalledWith('nonexistent');
  });

  // --------------------------------------------------------------------------
  // Document Type Validation
  // --------------------------------------------------------------------------

  it('returns 400 when document type is not url', async () => {
    getDocumentById.mockResolvedValue(createMockDocument({ type: 'pdf' }));

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Only URL documents');
  });

  it('returns 400 when document has no originalUrl', async () => {
    getDocumentById.mockResolvedValue(createMockDocument({ originalUrl: undefined }));

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Document does not have an original URL stored');
  });

  // --------------------------------------------------------------------------
  // Success
  // --------------------------------------------------------------------------

  it('returns 200 on successful reprocess', async () => {
    getDocumentById.mockResolvedValue(createMockDocument());

    // Mock the global fetch for URL content fetching
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest
        .fn()
        .mockResolvedValue(
          '<html><head><title>Test Article</title></head><body><p>Article content here</p></body></html>'
        ),
    });

    processDocumentFromContent.mockResolvedValueOnce({
      success: true,
      chunkCount: 5,
      textLength: 1200,
    });

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.document.id).toBe('doc-123');
    expect(json.document.title).toBe('Test Document');
    expect(json.document.status).toBe('processed');
    expect(json.document.chunkCount).toBe(5);
    expect(json.document.textLength).toBe(1200);
    expect(json.message).toBe('Document reprocessed successfully');
    expect(processDocumentFromContent).toHaveBeenCalledWith('doc-123', expect.any(String), { replaceExisting: true });
  });

  // --------------------------------------------------------------------------
  // URL Fetch Failure
  // --------------------------------------------------------------------------

  it('returns 400 when URL fetch fails', async () => {
    getDocumentById.mockResolvedValue(createMockDocument());

    // Mock fetch to return a failed HTTP response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Failed to fetch URL content');
    expect(json.documentId).toBe('doc-123');
    // UX-036: the REASON is persisted, not just the status. The old write was
    // `{ status: 'failed' }` alone, so the detail sheet's failure panel (gated
    // on `errorMessage`) stayed permanently empty.
    expect(updateDocument).toHaveBeenCalledWith('doc-123', {
      status: 'failed',
      errorMessage: expect.stringContaining('Failed to fetch URL content'),
      fetchError: expect.any(String),
    });
  });

  // --------------------------------------------------------------------------
  // Processing Failure
  // --------------------------------------------------------------------------

  it('returns 422 on processing failure', async () => {
    getDocumentById.mockResolvedValue(createMockDocument());

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: jest.fn().mockResolvedValue('<html><body>Content</body></html>'),
    });

    processDocumentFromContent.mockResolvedValueOnce({
      success: false,
      error: 'Chunking failed',
      stage: 'chunking',
    });

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    // 422, not 500: the request was well-formed and the content was fetched —
    // it could not be processed. Same code `/api/documents/process` returns for
    // the same condition, now that both share one operation.
    expect(res.status).toBe(422);
    expect(json.error).toContain('Chunking failed');
    expect(json.documentId).toBe('doc-123');
    expect(json.code).toBe('processing-failed');
    expect(json.stage).toBe('chunking');
  });

  // --------------------------------------------------------------------------
  // Unexpected Error
  // --------------------------------------------------------------------------

  it('returns 500 on unexpected error', async () => {
    getDocumentById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to reprocess document');
    expect(json.details).toBe('Firestore unavailable');
  });

  // --------------------------------------------------------------------------
  // TDM opt-out (AUDIT-007)
  //
  // Reprocess is a genuine RE-fetch, and a site can reserve its rights after we
  // first ingested a page — so the gate applies here too, not just on first
  // ingest. Having already ingested the page once is not a licence to do it
  // again.
  // --------------------------------------------------------------------------

  it('returns 403 and does not re-fetch when the site now reserves its rights', async () => {
    getDocumentById.mockResolvedValue(createMockDocument());
    checkTdmPolicy.mockResolvedValueOnce({
      allowed: false,
      reason: 'TDM opt-out: ai.txt reserves this content from text/data mining (DSM Art 4(3))',
    });

    const res = await POST(createMockRequest({ documentId: 'doc-123' }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.tdmBlocked).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(processDocumentFromContent).not.toHaveBeenCalled();
  });

  it('marks the document blocked — not failed — and persists the reason', async () => {
    getDocumentById.mockResolvedValue(createMockDocument());
    checkTdmPolicy.mockResolvedValueOnce({ allowed: false, reason: 'TDM opt-out: ai.txt reserves this content' });

    await POST(createMockRequest({ documentId: 'doc-123' }));

    // The route's generic fetch-failure path writes `status: 'failed'`, which
    // would mislabel a deliberate, permanent rights reservation as a transient
    // network error — and drop the reason entirely.
    expect(updateDocument).toHaveBeenCalledWith('doc-123', {
      status: 'blocked',
      fetchError: 'TDM opt-out: ai.txt reserves this content',
      // The reason is mirrored onto `errorMessage` so the one panel that
      // explains an unusable document can render it (nothing read `fetchError`).
      errorMessage: 'TDM opt-out: ai.txt reserves this content',
    });
  });
});
