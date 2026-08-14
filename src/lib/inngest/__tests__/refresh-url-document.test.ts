/**
 * Tests for refresh-url-document.ts
 * Knowledge Tab Sprint: URL Document Refresh
 *
 * Tests the Inngest jobs that refresh URL document content:
 * - refreshUrlDocumentJob - Main refresh function
 * - batchRefreshUrlDocumentsJob - Batch refresh function
 * - scheduledUrlRefreshJob - Scheduled cron refresh
 *
 * @jest-environment node
 */

// ============================================================================
// MOCKS - Must be defined before imports
// ============================================================================

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Mock the document-service module
// Post-T1.4: refresh-url-document.ts now imports from the narrow admin
// helper instead of the full document-service / document-chunk-service.
// Mock the helper module — same function names, same shapes.
jest.mock('@/lib/document-refresh-admin', () => ({
  __esModule: true,
  getDocumentById: jest.fn(),
  startDocumentRefresh: jest.fn(),
  completeDocumentRefresh: jest.fn(),
  failDocumentRefresh: jest.fn(),
  markDocumentBlocked: jest.fn(),
  getDocumentsNeedingRefresh: jest.fn(),
  archiveChunksForDocument: jest.fn(),
}));

// Mock the inngest client
jest.mock('../client', () => ({
  __esModule: true,
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      return {
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

import { inngest } from '../client';
import {
  refreshUrlDocumentJob,
  batchRefreshUrlDocumentsJob,
  scheduledUrlRefreshJob,
} from '../functions/refresh-url-document';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// Access mock functions via requireMock — single helper module post-T1.4.
const {
  getDocumentById: mockGetDocumentById,
  startDocumentRefresh: mockStartDocumentRefresh,
  completeDocumentRefresh: mockCompleteDocumentRefresh,
  failDocumentRefresh: mockFailDocumentRefresh,
  markDocumentBlocked: mockMarkDocumentBlocked,
  getDocumentsNeedingRefresh: mockGetDocumentsNeedingRefresh,
  archiveChunksForDocument: mockArchiveChunksForDocument,
} = jest.requireMock('@/lib/document-refresh-admin');

// Mock the TDM policy check — isolate this unit from real robots.txt/ai.txt
// network probes (the policy logic itself is covered by tdm-policy.test.ts).
// Default: allowed; individual tests override to exercise the opt-out path.
jest.mock('@/lib/tdm-policy', () => ({
  checkTdmPolicy: jest.fn().mockResolvedValue({ allowed: true }),
}));
const { checkTdmPolicy: mockCheckTdmPolicy } = jest.requireMock('@/lib/tdm-policy');

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Type helper for job execution
type ExecutableJob = {
  config: {
    id: string;
    retries: number;
    onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
  };
  trigger: { event?: string; cron?: string };
  execute: (data: Record<string, unknown>) => Promise<{
    result: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>;
};

// Helper to create mock document
function createMockDocument(overrides?: Record<string, unknown>) {
  return {
    id: 'doc-123',
    title: 'Test URL Document',
    type: 'url',
    storageUrl: '',
    status: 'processed',
    originalUrl: 'https://example.com/article',
    normalizedUrl: 'https://example.com/article',
    domain: 'example.com',
    version: 1,
    contentHash: 'abc123hash',
    refreshInProgress: false,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    uploadedBy: 'user-123',
    ...overrides,
  };
}

// Helper to create mock fetch response
function createMockResponse(options: {
  status?: number;
  statusText?: string;
  ok?: boolean;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
}) {
  const {
    status = 200,
    statusText = 'OK',
    ok = true,
    contentType = 'text/html; charset=utf-8',
    body = '<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>',
  } = options;

  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        return null;
      },
    },
    text: jest.fn().mockResolvedValue(body),
  };
}

describe('refresh-url-document', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (inngest.send as jest.Mock).mockResolvedValue({ ids: [] });
    mockStartDocumentRefresh.mockResolvedValue(true);
    mockCompleteDocumentRefresh.mockResolvedValue(undefined);
    mockFailDocumentRefresh.mockResolvedValue(undefined);
    mockMarkDocumentBlocked.mockResolvedValue(undefined);
    mockArchiveChunksForDocument.mockResolvedValue(5);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // refreshUrlDocumentJob
  // ==========================================================================

  describe('refreshUrlDocumentJob', () => {
    it('should be configured correctly', () => {
      const job = refreshUrlDocumentJob as unknown as ExecutableJob;

      expect(job.config.id).toBe('refresh-url-document');
      expect(job.config.retries).toBe(3);
      expect(job.trigger.event).toBe('app/document.refresh.requested');
    });

    it('should throw error when document not found', async () => {
      mockGetDocumentById.mockResolvedValue(null);

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;

      await expect(job.execute({ documentId: 'doc-missing' })).rejects.toThrow('Document doc-missing not found');
    });

    it('should throw error when document is not URL type', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument({ type: 'pdf' }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;

      await expect(job.execute({ documentId: 'doc-123' })).rejects.toThrow('is not a URL type');
    });

    it('should throw error when document has no originalUrl', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument({ originalUrl: undefined }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;

      await expect(job.execute({ documentId: 'doc-123' })).rejects.toThrow('has no original URL');
    });

    it('should skip when refresh already in progress', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockStartDocumentRefresh.mockResolvedValue(false);

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('Refresh already in progress');
    });

    it('should bypass concurrency check with force=true', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      // When force=true, startDocumentRefresh should NOT be called
      mockFetch.mockResolvedValue(
        createMockResponse({
          body: '<html><head><title>Test</title></head><body>Same content</body></html>',
        })
      );

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123', force: true });

      expect(mockStartDocumentRefresh).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should handle blocked URL with 403 status', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockResolvedValue(createMockResponse({ status: 403, statusText: 'Forbidden', ok: false }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(mockMarkDocumentBlocked).toHaveBeenCalledWith('doc-123', 'Access forbidden (403)');
    });

    it('should block ingestion when the site opts out via TDM (robots.txt/ai.txt)', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockCheckTdmPolicy.mockResolvedValueOnce({
        allowed: false,
        reason: 'TDM opt-out: robots.txt disallows this path for our agent',
      });

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(mockMarkDocumentBlocked).toHaveBeenCalledWith(
        'doc-123',
        'TDM opt-out: robots.txt disallows this path for our agent'
      );
      // The content fetch must be short-circuited — we never hit the network.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle blocked URL with 401 status', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockResolvedValue(createMockResponse({ status: 401, statusText: 'Unauthorized', ok: false }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
    });

    it('should handle blocked URL with 451 status', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockResolvedValue(
        createMockResponse({
          status: 451,
          statusText: 'Unavailable For Legal Reasons',
          ok: false,
        })
      );

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
    });

    it('should handle non-OK HTTP response', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockResolvedValue(createMockResponse({ status: 500, statusText: 'Internal Server Error', ok: false }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
      expect(mockFailDocumentRefresh).toHaveBeenCalled();
    });

    it('should handle unsupported content type', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockResolvedValue(createMockResponse({ contentType: 'application/pdf' }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported content type');
    });

    it('should handle fetch timeout (AbortError)', async () => {
      jest.useFakeTimers();
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      try {
        const job = refreshUrlDocumentJob as unknown as ExecutableJob;
        const { result } = await job.execute({ documentId: 'doc-123' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('timeout');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle fetch network error', async () => {
      jest.useFakeTimers();
      mockGetDocumentById.mockResolvedValue(createMockDocument());
      mockFetch.mockRejectedValue(new Error('Network error'));

      try {
        const job = refreshUrlDocumentJob as unknown as ExecutableJob;
        const { result } = await job.execute({ documentId: 'doc-123' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should detect content change, archive chunks, and trigger reprocessing', async () => {
      // Document has old hash, fetch returns new content with different hash
      mockGetDocumentById.mockResolvedValue(createMockDocument({ contentHash: 'old-hash-value' }));
      mockFetch.mockResolvedValue(
        createMockResponse({
          body: '<html><head><title>Updated Page</title></head><body><p>New content here</p></body></html>',
        })
      );
      mockArchiveChunksForDocument.mockResolvedValue(3);

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(true);
      expect(result.contentChanged).toBe(true);
      expect(result.archivedChunks).toBe(3);
      expect(result.newVersion).toBe(2);
      expect(mockArchiveChunksForDocument).toHaveBeenCalledWith('doc-123');
      expect(mockCompleteDocumentRefresh).toHaveBeenCalledWith('doc-123', true, expect.any(String));
      // The reprocess event MUST carry the fetched content + source: 'url' so
      // processDocumentJob takes the content path (processDocumentFromContent).
      // URL docs have no stored file (storageUrl '') — without these fields the
      // process job took the file-download path and marked the document failed.
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/document.process.requested',
        data: {
          documentId: 'doc-123',
          content: expect.stringContaining('New content here'),
          options: { source: 'url', replaceExisting: false },
        },
      });
    });

    it('should pass the extracted text (not raw HTML) as reprocessing content', async () => {
      mockGetDocumentById.mockResolvedValue(createMockDocument({ contentHash: 'old-hash-value' }));
      mockFetch.mockResolvedValue(
        createMockResponse({
          body: '<html><head><title>T</title><script>alert(1)</script></head><body><p>Visible text</p></body></html>',
        })
      );

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      await job.execute({ documentId: 'doc-123' });

      const processCall = (inngest.send as jest.Mock).mock.calls.find(
        ([evt]) => evt.name === 'app/document.process.requested'
      );
      expect(processCall).toBeDefined();
      const sentContent: string = processCall![0].data.content;
      expect(sentContent).toContain('Visible text');
      expect(sentContent).not.toContain('<p>');
      expect(sentContent).not.toContain('alert(1)');
    });

    it('should detect no content change and update without reprocessing', async () => {
      // Compute the hash for the content we will return from fetch
      const crypto = require('crypto');
      const bodyHtml = '<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>';
      // Extract text like the function does
      let text = bodyHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/&nbsp;/g, ' ');
      text = text.replace(/&amp;/g, '&');
      text = text.replace(/&lt;/g, '<');
      text = text.replace(/&gt;/g, '>');
      text = text.replace(/&quot;/g, '"');
      text = text.replace(/&#39;/g, "'");
      text = text.replace(/\s+/g, ' ').trim();
      const expectedHash = crypto.createHash('sha256').update(text).digest('hex');

      mockGetDocumentById.mockResolvedValue(createMockDocument({ contentHash: expectedHash }));
      mockFetch.mockResolvedValue(createMockResponse({ body: bodyHtml }));

      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentId: 'doc-123' });

      expect(result.success).toBe(true);
      expect(result.contentChanged).toBe(false);
      expect(mockArchiveChunksForDocument).not.toHaveBeenCalled();
      expect(mockCompleteDocumentRefresh).toHaveBeenCalledWith('doc-123', false);
    });

    it('should handle onFailure callback', async () => {
      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        await onFailure({
          error: new Error('Max retries exceeded'),
          // Inngest v3 onFailure payload: original event nested at event.data.event
          event: { data: { event: { data: { documentId: 'doc-123' } } } },
        });

        expect(mockFailDocumentRefresh).toHaveBeenCalledWith('doc-123', 'Max retries exceeded');
        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/document.refresh.failed',
          data: expect.objectContaining({
            documentId: 'doc-123',
            error: 'Max retries exceeded',
          }),
        });
      }
    });

    it('should handle onFailure when failDocumentRefresh throws', async () => {
      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;

      if (onFailure) {
        mockFailDocumentRefresh.mockRejectedValue(new Error('Cleanup error'));

        // Should not throw, cleanup error is ignored
        await expect(
          onFailure({
            error: new Error('Some failure'),
            // Inngest v3 onFailure payload: original event nested at event.data.event
            event: { data: { event: { data: { documentId: 'doc-123' } } } },
          })
        ).resolves.not.toThrow();

        // Should still send the failure event
        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/document.refresh.failed',
          data: expect.objectContaining({
            documentId: 'doc-123',
          }),
        });
      }
    });

    it('should handle onFailure with missing documentId', async () => {
      const job = refreshUrlDocumentJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;

      if (onFailure) {
        await onFailure({
          error: new Error('Unknown'),
          event: { data: {} },
        });

        // Must not attempt a Firestore write against a nonexistent doc id
        expect(mockFailDocumentRefresh).not.toHaveBeenCalled();
        expect(inngest.send).toHaveBeenCalledWith({
          name: 'app/document.refresh.failed',
          data: expect.objectContaining({
            documentId: 'unknown',
          }),
        });
      }
    });
  });

  // ==========================================================================
  // batchRefreshUrlDocumentsJob
  // ==========================================================================

  describe('batchRefreshUrlDocumentsJob', () => {
    it('should be configured correctly', () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;

      expect(job.config.id).toBe('batch-refresh-url-documents');
      expect(job.config.retries).toBe(1);
      expect(job.trigger.event).toBe('app/document.batch-refresh.requested');
    });

    it('should send individual refresh events for each document', async () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;
      const { result } = await job.execute({
        documentIds: ['doc-1', 'doc-2', 'doc-3'],
      });

      expect(result.success).toBe(true);
      expect(result.triggeredCount).toBe(3);
      expect(inngest.send).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'app/document.refresh.requested', data: { documentId: 'doc-1' } }),
          expect.objectContaining({ name: 'app/document.refresh.requested', data: { documentId: 'doc-2' } }),
          expect.objectContaining({ name: 'app/document.refresh.requested', data: { documentId: 'doc-3' } }),
        ])
      );
    });

    it('should return error when no document IDs provided', async () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;
      const { result } = await job.execute({ documentIds: [] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No document IDs provided');
    });

    it('should return error when documentIds is undefined', async () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;
      const { result } = await job.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No document IDs provided');
    });

    it('should recover documentIds count from the nested v3 failure envelope', async () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;
      expect(onFailure).toBeDefined();

      if (onFailure) {
        await onFailure({
          error: new Error('Batch failed'),
          // Inngest v3 onFailure payload: original event nested at
          // event.data.event. The pre-fix handler read event.data.documentIds
          // directly and always logged documentCount: 0.
          event: { data: { event: { data: { documentIds: ['doc-1', 'doc-2'] } } } },
        });

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Batch refresh URL documents final failure',
          expect.any(Error),
          expect.objectContaining({ documentCount: 2 })
        );
      }
    });

    it('should fall back to documentCount 0 when no original event is nested', async () => {
      const job = batchRefreshUrlDocumentsJob as unknown as ExecutableJob;
      const onFailure = job.config.onFailure;

      if (onFailure) {
        await onFailure({
          error: new Error('Batch failed'),
          // Flat payload (no nested event) — must not crash
          event: { data: { documentIds: ['doc-FLAT-IGNORED'] } },
        });

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Batch refresh URL documents final failure',
          expect.any(Error),
          expect.objectContaining({ documentCount: 0 })
        );
      }
    });
  });

  // ==========================================================================
  // scheduledUrlRefreshJob
  // ==========================================================================

  describe('scheduledUrlRefreshJob', () => {
    it('should be configured correctly', () => {
      const job = scheduledUrlRefreshJob as unknown as ExecutableJob;

      expect(job.config.id).toBe('scheduled-url-refresh');
      expect(job.config.retries).toBe(2);
      expect(job.trigger.cron).toBe('0 3 * * *');
    });

    it('should trigger batch refresh for stale documents', async () => {
      const staleDocuments = [createMockDocument({ id: 'doc-1' }), createMockDocument({ id: 'doc-2' })];
      mockGetDocumentsNeedingRefresh.mockResolvedValue(staleDocuments);

      const job = scheduledUrlRefreshJob as unknown as ExecutableJob;
      const { result } = await job.execute({});

      expect(result.success).toBe(true);
      expect(result.triggered).toBe(2);
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/document.batch-refresh.requested',
        data: {
          documentIds: ['doc-1', 'doc-2'],
        },
      });
    });

    it('should return 0 when no documents need refresh', async () => {
      mockGetDocumentsNeedingRefresh.mockResolvedValue([]);

      const job = scheduledUrlRefreshJob as unknown as ExecutableJob;
      const { result } = await job.execute({});

      expect(result.success).toBe(true);
      expect(result.refreshed).toBe(0);
      expect(inngest.send).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Utility function logic tests
  // ==========================================================================

  describe('utility functions', () => {
    describe('computeContentHash', () => {
      it('should compute consistent SHA-256 hash', () => {
        const crypto = require('crypto');
        const computeHash = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

        const hash1 = computeHash('test content');
        const hash2 = computeHash('test content');
        const hash3 = computeHash('different content');

        expect(hash1).toBe(hash2);
        expect(hash1).not.toBe(hash3);
        expect(hash1).toHaveLength(64);
      });
    });

    describe('extractTextFromHtml', () => {
      it('should strip script tags', () => {
        const html = '<p>Before</p><script>alert("xss");</script><p>After</p>';
        let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();

        expect(text).not.toContain('alert');
        expect(text).toContain('Before');
        expect(text).toContain('After');
      });

      it('should strip style tags', () => {
        const html = '<style>.test { color: red; }</style><p>Content</p>';
        let text = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();

        expect(text).toBe('Content');
      });

      it('should decode HTML entities', () => {
        let text = 'Hello &amp; World &lt;test&gt; &quot;quoted&quot; &#39;apos&#39;';
        text = text.replace(/&nbsp;/g, ' ');
        text = text.replace(/&amp;/g, '&');
        text = text.replace(/&lt;/g, '<');
        text = text.replace(/&gt;/g, '>');
        text = text.replace(/&quot;/g, '"');
        text = text.replace(/&#39;/g, "'");

        expect(text).toBe('Hello & World <test> "quoted" \'apos\'');
      });
    });

    describe('extractTitleFromHtml', () => {
      it('should extract title', () => {
        const html = '<html><head><title>My Page Title</title></head></html>';
        const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = match ? match[1].trim() : undefined;

        expect(title).toBe('My Page Title');
      });

      it('should return undefined when no title', () => {
        const html = '<html><head></head><body></body></html>';
        const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = match ? match[1].trim() : undefined;

        expect(title).toBeUndefined();
      });
    });
  });
});
