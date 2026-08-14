/**
 * Unit Tests for URL Document API Route
 *
 * Tests the POST /api/documents/url endpoint for:
 * - Input validation (URL required, format validation)
 * - Security validation (dangerous schemes, SSRF protection)
 * - Duplicate URL detection
 * - Content fetching (Firecrawl and fallback)
 * - Document creation
 * - Inngest event triggering
 * - Error handling
 *
 * @jest-environment node
 * @phase Phase 8: URL Document Processing
 */

import { NextRequest } from 'next/server';

// ============================================================================
// MOCKS - Must be defined before any imports that use them
// ============================================================================

// Prevent transitive firebase-admin/jwks-rsa load (parse error) from the
// admin twins the route + processing service import.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

// Mock the document-admin module (admin-SDK twin the route now imports).
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminCreateDocument: jest.fn(),
  adminGetDocumentByNormalizedUrl: jest.fn(),
  adminUpdateDocument: jest.fn(),
}));

// Mock the document-processing-service (pulls in firebase-admin transitively).
jest.mock('@/lib/document-processing-service', () => ({
  __esModule: true,
  processDocumentFromContent: jest.fn(),
}));

// Mock the URL normalize utilities
jest.mock('@/lib/utils/url-normalize', () => ({
  __esModule: true,
  normalizeUrl: jest.fn((url: string) => url.toLowerCase().replace(/\/$/, '')),
  extractDomain: jest.fn((url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }),
  isValidUrl: jest.fn((url: string) => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }),
}));

// Mock the inngest client module
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    send: jest.fn(),
  },
}));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// AUDIT-007. The TDM check is mocked, not merely allowed to run: checkTdmPolicy
// issues three real fetches (robots.txt + two ai.txt locations) BEFORE the
// content fetch, and every test here queues `mockFetch` responses positionally.
// Left unmocked it shifts the whole queue and the article fetch consumes the
// robots response. Same reason the refresh path's suite isolates it.
jest.mock('@/lib/tdm-policy', () => ({ checkTdmPolicy: jest.fn() }));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Import the mocked modules
import {
  adminCreateDocument as createDocument,
  adminGetDocumentByNormalizedUrl as getDocumentByNormalizedUrl,
  adminUpdateDocument as updateDocument,
} from '@/lib/document-admin';
import { inngest } from '@/lib/inngest/client';
import { normalizeUrl, extractDomain, isValidUrl } from '@/lib/utils/url-normalize';

// Import the route handler after mocks
import { POST } from '../route';

// Cast mocks for TypeScript
const mockCreateDocument = createDocument as jest.MockedFunction<typeof createDocument>;
const mockGetDocumentByNormalizedUrl = getDocumentByNormalizedUrl as jest.MockedFunction<
  typeof getDocumentByNormalizedUrl
>;
const mockUpdateDocument = updateDocument as jest.MockedFunction<typeof updateDocument>;
const mockInngestSend = inngest.send as jest.MockedFunction<typeof inngest.send>;
const _mockNormalizeUrl = normalizeUrl as jest.MockedFunction<typeof normalizeUrl>;
const mockExtractDomain = extractDomain as jest.MockedFunction<typeof extractDomain>;
const mockIsValidUrl = isValidUrl as jest.MockedFunction<typeof isValidUrl>;
const mockCheckTdmPolicy = jest.requireMock('@/lib/tdm-policy').checkTdmPolicy as jest.Mock;

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/url', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createMockDocument(overrides?: Record<string, unknown>) {
  return {
    id: 'doc-123',
    title: 'Test Document',
    type: 'url' as const,
    storageUrl: '',
    status: 'uploaded' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploadedBy: 'user-123',
    ...overrides,
  } as import('@/lib/types').Document;
}

// ============================================================================
// TESTS
// ============================================================================

describe('URL Document API Route (Phase 8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTdmPolicy.mockResolvedValue({ allowed: true });
    mockGetDocumentByNormalizedUrl.mockResolvedValue(null);
    mockCreateDocument.mockResolvedValue(createMockDocument());
    mockUpdateDocument.mockResolvedValue(undefined);
    mockInngestSend.mockResolvedValue({ ids: [] });
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '<html><head><title>Test Page</title></head><body>Content</body></html>',
    });

    // Environment variable for Firecrawl (not set by default)
    delete process.env.FIRECRAWL_API_KEY;
  });

  afterEach(() => {
    delete process.env.FIRECRAWL_API_KEY;
  });

  // --------------------------------------------------------------------------
  // Input Validation
  // --------------------------------------------------------------------------

  describe('Input Validation', () => {
    it('should return 400 when URL is missing', async () => {
      const request = createMockRequest({});

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid request');
    });

    it('should return 400 when URL is empty string', async () => {
      const request = createMockRequest({ url: '' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid request');
    });

    it('should return 400 when URL format is invalid', async () => {
      mockIsValidUrl.mockReturnValueOnce(false);

      const request = createMockRequest({ url: 'not-a-valid-url' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid URL format');
    });

    it('should accept valid optional fields', async () => {
      const request = createMockRequest({
        url: 'https://example.com/article',
        title: 'Custom Title',
        description: 'Custom description',
        tags: ['tag1', 'tag2'],
      });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Security Validation
  // --------------------------------------------------------------------------

  describe('Security Validation', () => {
    it('should block javascript: scheme URLs', async () => {
      // Note: URL constructor throws for javascript: scheme, so format validation fails first
      const request = createMockRequest({ url: 'javascript:alert(1)' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      // Either format error or security error is acceptable
      expect(data.error).toMatch(/Invalid URL|not allowed/);
    });

    it('should block data: scheme URLs', async () => {
      // data: URLs pass URL constructor but fail security check
      mockIsValidUrl.mockReturnValueOnce(true);
      const request = createMockRequest({ url: 'data:text/html,<h1>Test</h1>' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('not allowed');
    });

    it('should block file: scheme URLs', async () => {
      mockIsValidUrl.mockReturnValueOnce(true);
      const request = createMockRequest({ url: 'file:///etc/passwd' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('not allowed');
    });

    it('should block vbscript: scheme URLs', async () => {
      // vbscript: URLs typically fail URL parsing
      const request = createMockRequest({ url: 'vbscript:msgbox("test")' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      // Either format error or security error is acceptable
      expect(data.error).toMatch(/Invalid URL|not allowed/);
    });

    it('should block ftp: scheme URLs', async () => {
      mockIsValidUrl.mockReturnValueOnce(true);
      const request = createMockRequest({ url: 'ftp://ftp.example.com/file' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('HTTP and HTTPS URLs');
    });

    it('should block localhost URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://localhost/admin' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block 127.0.0.1 URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://127.0.0.1:8080/api' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block 192.168.x.x URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://192.168.1.1/router' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block 10.x.x.x URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://10.0.0.1/internal' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block 172.16.x.x URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://172.16.0.1/internal' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block 0.0.0.0 URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://0.0.0.0/api' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should block .local domain URLs (SSRF protection)', async () => {
      const request = createMockRequest({ url: 'http://server.local/api' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Internal URLs');
    });

    it('should accept valid HTTPS URLs', async () => {
      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it('should accept valid HTTP URLs', async () => {
      const request = createMockRequest({ url: 'http://example.com/article' });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Duplicate URL Detection
  // --------------------------------------------------------------------------

  // AUDIT-007 — the TDM opt-out was wired into the scheduled refresh job only,
  // so the background task honored the site's rights reservation while the
  // button the user just pressed ignored it. CHANGELOG and RESPONSIBLE-AI both
  // claimed the ingestion path was covered. It was not.
  describe('TDM opt-out (DSM Art 4(3))', () => {
    it('refuses ingestion with 403 when the site reserves its rights', async () => {
      mockCheckTdmPolicy.mockResolvedValue({
        allowed: false,
        reason: 'TDM opt-out: ai.txt reserves this content from text/data mining (DSM Art 4(3))',
      });

      const response = await POST(createMockRequest({ url: 'https://example.com/article' }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.tdmBlocked).toBe(true);
      expect(body.error).toMatch(/TDM opt-out/);
    });

    it('does not fetch the page or create a document when refused', async () => {
      mockCheckTdmPolicy.mockResolvedValue({ allowed: false, reason: 'TDM opt-out' });

      await POST(createMockRequest({ url: 'https://example.com/article' }));

      // The whole point of the gate. A rights check that runs AFTER the copy
      // has been made is not a gate — it is a log line.
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockCreateDocument).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('ingests normally when the site has no reservation', async () => {
      mockCheckTdmPolicy.mockResolvedValue({ allowed: true });

      const response = await POST(createMockRequest({ url: 'https://example.com/article' }));

      expect(response.status).toBe(201);
      expect(mockCheckTdmPolicy).toHaveBeenCalledWith('https://example.com/article');
      expect(mockCreateDocument).toHaveBeenCalled();
    });
  });

  describe('Duplicate URL Detection', () => {
    it('should return 409 when duplicate URL exists', async () => {
      const existingDoc = createMockDocument({ id: 'existing-123', title: 'Existing Doc' });
      mockGetDocumentByNormalizedUrl.mockResolvedValueOnce(existingDoc);

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toContain('already exists');
      expect(data.existingId).toBe('existing-123');
      expect(data.existingTitle).toBe('Existing Doc');
    });

    it('should call getDocumentByNormalizedUrl with the provided URL', async () => {
      const request = createMockRequest({ url: 'https://example.com/article' });
      await POST(request);

      expect(mockGetDocumentByNormalizedUrl).toHaveBeenCalledWith('https://example.com/article');
    });

    it('should proceed when no duplicate exists', async () => {
      mockGetDocumentByNormalizedUrl.mockResolvedValueOnce(null);

      const request = createMockRequest({ url: 'https://example.com/new-article' });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Content Fetching
  // --------------------------------------------------------------------------

  describe('Content Fetching', () => {
    describe('Basic Fetch (no Firecrawl)', () => {
      it('should fetch URL content using basic fetch when Firecrawl not configured', async () => {
        const request = createMockRequest({ url: 'https://example.com/article' });
        await POST(request);

        expect(mockFetch).toHaveBeenCalledWith(
          'https://example.com/article',
          expect.objectContaining({
            headers: expect.objectContaining({
              'User-Agent': expect.stringContaining('Radarist'),
            }),
          })
        );
      });

      it('should extract title from HTML', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => '<html><head><title>Page Title</title></head><body>Content</body></html>',
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        const response = await POST(request);

        expect(response.status).toBe(201);
        // Verify createDocument was called with the extracted title
        expect(mockCreateDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Page Title',
          })
        );
      });

      it('should use domain as fallback title when HTML has no title', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => '<html><body>Content without title</body></html>',
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        const response = await POST(request);

        expect(response.status).toBe(201);
        // Verify createDocument was called with domain-based fallback title
        expect(mockCreateDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            title: expect.stringContaining('example.com'),
          })
        );
      });

      it('should use override title when provided', async () => {
        const request = createMockRequest({
          url: 'https://example.com/article',
          title: 'My Custom Title',
        });
        const response = await POST(request);

        expect(response.status).toBe(201);
        // The mock createDocument receives the override title
        expect(mockCreateDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'My Custom Title',
          })
        );
      });

      it('should return 400 when fetch fails', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        });

        const request = createMockRequest({ url: 'https://example.com/nonexistent' });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toContain('404');
      });

      it('should return 400 when fetch throws network error', async () => {
        jest.useFakeTimers();
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        try {
          const request = createMockRequest({ url: 'https://example.com/article' });

          const response = await POST(request);
          const data = await response.json();

          expect(response.status).toBe(400);
          expect(data.error).toContain('Network error');
          expect(jest.getTimerCount()).toBe(0);
        } finally {
          jest.useRealTimers();
        }
      });

      it('should return 400 when fetch times out', async () => {
        jest.useFakeTimers();
        const abortError = new Error('Abort');
        abortError.name = 'AbortError';
        mockFetch.mockRejectedValueOnce(abortError);

        try {
          const request = createMockRequest({ url: 'https://slow-server.com/article' });

          const response = await POST(request);
          const data = await response.json();

          expect(response.status).toBe(400);
          expect(data.error).toContain('timeout');
          expect(jest.getTimerCount()).toBe(0);
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('Firecrawl Integration', () => {
      beforeEach(() => {
        process.env.FIRECRAWL_API_KEY = 'test-api-key';
      });

      it('should use Firecrawl when API key is configured', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              markdown: '# Article Content',
              metadata: { title: 'Firecrawl Title' },
            },
          }),
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        await POST(request);

        expect(mockFetch).toHaveBeenCalledWith(
          'https://api.firecrawl.dev/v1/scrape',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: 'Bearer test-api-key',
            }),
          })
        );
      });

      it('should fall back to basic fetch when Firecrawl fails', async () => {
        // First call (Firecrawl) fails
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
        });
        // Second call (basic fetch) succeeds
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => '<html><title>Fallback Title</title><body>Content</body></html>',
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        const response = await POST(request);

        expect(response.status).toBe(201);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should fall back to basic fetch when Firecrawl throws', async () => {
        // First call (Firecrawl) throws
        mockFetch.mockRejectedValueOnce(new Error('Firecrawl error'));
        // Second call (basic fetch) succeeds
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => '<html><title>Fallback Title</title><body>Content</body></html>',
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        const response = await POST(request);

        expect(response.status).toBe(201);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should send correct Firecrawl request body', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: { markdown: 'Content', metadata: { title: 'Title' } },
          }),
        });

        const request = createMockRequest({ url: 'https://example.com/article' });
        await POST(request);

        const firecrawlCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(firecrawlCall[1].body);

        expect(requestBody).toEqual({
          url: 'https://example.com/article',
          formats: ['markdown'],
          onlyMainContent: true,
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // Document Creation
  // --------------------------------------------------------------------------

  describe('Document Creation', () => {
    it('should create document with correct parameters', async () => {
      const request = createMockRequest({
        url: 'https://example.com/article',
        description: 'Test description',
        tags: ['tag1', 'tag2'],
      });

      await POST(request);

      expect(mockCreateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'url',
          originalUrl: 'https://example.com/article',
          description: 'Test description',
          tags: ['tag1', 'tag2'],
        })
      );
    });

    it('should update document with URL-specific fields', async () => {
      const request = createMockRequest({ url: 'https://example.com/article' });

      await POST(request);

      expect(mockUpdateDocument).toHaveBeenCalledWith(
        'doc-123',
        expect.objectContaining({
          normalizedUrl: expect.any(String),
          domain: expect.any(String),
          version: 1,
        })
      );
    });

    it('should extract domain from URL', async () => {
      const request = createMockRequest({ url: 'https://subdomain.example.com/path/article' });

      await POST(request);

      expect(mockExtractDomain).toHaveBeenCalledWith('https://subdomain.example.com/path/article');
    });
  });

  // --------------------------------------------------------------------------
  // Inngest Event Triggering
  // --------------------------------------------------------------------------

  describe('Inngest Event Triggering', () => {
    it('should send document.process.requested event', async () => {
      const request = createMockRequest({ url: 'https://example.com/article' });
      await POST(request);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.process.requested',
        data: expect.objectContaining({
          documentId: 'doc-123',
          content: expect.any(String),
          options: { source: 'url' },
        }),
      });
    });

    it('should include fetched content in event', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body>Test Content</body></html>',
      });

      const request = createMockRequest({ url: 'https://example.com/article' });
      await POST(request);

      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.stringContaining('Test Content'),
          }),
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Success Response
  // --------------------------------------------------------------------------

  describe('Success Response', () => {
    it('should return 201 with success response', async () => {
      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.document).toBeDefined();
      expect(data.document.id).toBe('doc-123');
      expect(data.document.status).toBe('processing');
    });

    it('should return document with domain', async () => {
      mockExtractDomain.mockReturnValueOnce('example.com');

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(data.document.domain).toBe('example.com');
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('should return 500 when createDocument throws', async () => {
      mockCreateDocument.mockRejectedValueOnce(new Error('Database error'));

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to process URL');
    });

    it('should return 500 when updateDocument throws', async () => {
      mockUpdateDocument.mockRejectedValueOnce(new Error('Update failed'));

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to process URL');
    });

    it('should return 201 gracefully when inngest.send throws (non-critical)', async () => {
      mockInngestSend.mockRejectedValueOnce(new Error('Inngest error'));

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);

      // The route creates the document successfully and handles inngest failure gracefully
      expect(response.status).toBe(201);
    });

    it('should return 500 when request body is invalid JSON', async () => {
      const request = new NextRequest('http://localhost:3000/api/documents/url', {
        method: 'POST',
        body: 'not-valid-json',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to process URL');
    });

    it('should include error details in 500 response', async () => {
      mockCreateDocument.mockRejectedValueOnce(new Error('Specific error message'));

      const request = createMockRequest({ url: 'https://example.com/article' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.details).toBe('Specific error message');
    });
  });
});
