/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks (hoisted before imports)
// ---------------------------------------------------------------------------
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
}));

jest.mock('@/lib/document-admin', () => ({
  adminCreateDocument: jest.fn(),
  adminUpdateDocument: jest.fn(),
}));

jest.mock('@/lib/inngest/client', () => ({
  safeSendEvent: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
const { POST } = require('../route');
const { getAuthenticatedUser } = require('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { adminCreateDocument: createDocument, adminUpdateDocument: updateDocument } =
  require('@/lib/document-admin') as {
    adminCreateDocument: jest.Mock;
    adminUpdateDocument: jest.Mock;
  };
const { safeSendEvent } = require('@/lib/inngest/client') as {
  safeSendEvent: jest.Mock;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/deep-research', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const MOCK_USER = {
  authenticated: true,
  uid: 'user-abc-123',
  email: 'researcher@example.com',
};

const MOCK_DOCUMENT = { id: 'doc-deep-001' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/documents/deep-research', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default happy-path mocks
    getAuthenticatedUser.mockResolvedValue(MOCK_USER);
    createDocument.mockResolvedValue(MOCK_DOCUMENT);
    safeSendEvent.mockResolvedValue(true);
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  it('returns 401 if not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Token expired',
    });

    const res = await POST(createRequest({ query: 'AI trends 2026' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Token expired');
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  it('returns 400 if query is missing', async () => {
    const res = await POST(createRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(json.details.query).toBeDefined();
  });

  it('returns 400 if query is too short (< 3 chars)', async () => {
    const res = await POST(createRequest({ query: 'ab' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details.query).toBeDefined();
  });

  it('returns 400 if query is too long (> 2000 chars)', async () => {
    const res = await POST(createRequest({ query: 'x'.repeat(2001) }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details.query).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------
  it('returns 200 with documentId on success', async () => {
    const res = await POST(createRequest({ query: 'Future of quantum computing' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      documentId: 'doc-deep-001',
      status: 'processing',
      message: expect.stringContaining('Deep research started'),
    });
  });

  it('creates document with correct fields', async () => {
    const query = 'Enterprise AI adoption trends';

    await POST(createRequest({ query }));

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith(
      {
        title: query,
        type: 'markdown',
        description: `Deep research: ${query}`,
        storageUrl: '',
        uploadedBy: MOCK_USER.uid,
        tags: ['deep-research'],
        mimeType: 'text/markdown',
        visibility: 'workspace',
      },
      { initialStatus: 'processing' }
    );
  });

  it('sends Inngest event with correct data', async () => {
    const query = 'Sustainable energy startups';

    await POST(createRequest({ query }));

    expect(safeSendEvent).toHaveBeenCalledTimes(1);
    expect(safeSendEvent).toHaveBeenCalledWith(
      {
        name: 'app/document.deep-research.requested',
        data: {
          query,
          documentId: MOCK_DOCUMENT.id,
          userId: MOCK_USER.uid,
        },
      },
      { logPrefix: '[DeepResearch]' }
    );
  });

  // -------------------------------------------------------------------------
  // Tags handling
  // -------------------------------------------------------------------------
  it('passes tags to document and event when provided', async () => {
    const query = 'Robotics in healthcare';
    const tags = ['robotics', 'healthcare'];

    await POST(createRequest({ query, tags }));

    // Document should receive the tags array (with auto-added 'deep-research' tag)
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ tags: ['robotics', 'healthcare', 'deep-research'] }), expect.any(Object));

    // Event data should include tags
    expect(safeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags }),
      }),
      expect.any(Object)
    );
  });

  it('omits tags from event data when not provided', async () => {
    const query = 'Edge computing overview';

    await POST(createRequest({ query }));

    const eventCall = safeSendEvent.mock.calls[0][0];
    expect(eventCall.data).not.toHaveProperty('tags');

    // Document should get 'deep-research' tag even when no user tags provided
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ tags: ['deep-research'] }), expect.any(Object));
  });

  // -------------------------------------------------------------------------
  // Dispatch failure (AI-021: honest failed state, never a fake success)
  // -------------------------------------------------------------------------
  it('returns 502 and marks the document failed when the job dispatch is rejected', async () => {
    safeSendEvent.mockResolvedValueOnce(false);

    const res = await POST(createRequest({ query: 'Blockchain regulations 2026' }));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.status).toBe('failed');
    expect(json.documentId).toBe(MOCK_DOCUMENT.id);
    expect(json.error).toMatch(/could not be started/i);
    expect(updateDocument).toHaveBeenCalledWith(MOCK_DOCUMENT.id, {
      status: 'failed',
      errorMessage: expect.stringMatching(/could not be started/i),
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  it('returns 500 on unexpected error from createDocument', async () => {
    createDocument.mockRejectedValueOnce(new Error('Firestore write failed'));

    const res = await POST(createRequest({ query: 'Crash test query' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error starting deep research');
  });
});
