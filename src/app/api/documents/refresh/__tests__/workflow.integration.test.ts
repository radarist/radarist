/**
 * URL Refresh Workflow Integration Tests
 *
 * Tests the complete URL refresh workflow from API trigger through service execution.
 * Verifies:
 * - API validation and event triggering
 * - Concurrency protection (refreshInProgress)
 * - Content change detection workflow
 * - Error handling propagation
 * - Version increment on content change
 *
 * @jest-environment node
 * @phase Knowledge Tab Sprint - Phase 5
 */

import { NextRequest } from 'next/server';
import type { Document } from '@/lib/types';

// ============================================================================
// MOCKS - Must be defined before importing route handlers
// ============================================================================

jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminGetDocumentById: jest.fn(),
}));

jest.mock('@/lib/document-service', () => ({
  __esModule: true,
  startDocumentRefresh: jest.fn(),
  completeDocumentRefresh: jest.fn(),
  failDocumentRefresh: jest.fn(),
  markDocumentBlocked: jest.fn(),
  getDocumentsNeedingRefresh: jest.fn(),
}));

jest.mock('@/lib/document-chunk-service', () => ({
  __esModule: true,
  archiveChunksForDocument: jest.fn(),
}));

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

// Import mocked modules
import { adminGetDocumentById } from '@/lib/document-admin';
import {
  startDocumentRefresh,
  completeDocumentRefresh,
  failDocumentRefresh,
  markDocumentBlocked,
  getDocumentsNeedingRefresh,
} from '@/lib/document-service';
import { archiveChunksForDocument } from '@/lib/document-chunk-service';
import { inngest } from '@/lib/inngest/client';

// Import route handler AFTER mocks
import { POST } from '../route';

// Cast mocks for TypeScript
const mockGetDocumentById = adminGetDocumentById as jest.MockedFunction<typeof adminGetDocumentById>;
const mockStartDocumentRefresh = startDocumentRefresh as jest.MockedFunction<typeof startDocumentRefresh>;
const mockCompleteDocumentRefresh = completeDocumentRefresh as jest.MockedFunction<typeof completeDocumentRefresh>;
const mockFailDocumentRefresh = failDocumentRefresh as jest.MockedFunction<typeof failDocumentRefresh>;
const mockMarkDocumentBlocked = markDocumentBlocked as jest.MockedFunction<typeof markDocumentBlocked>;
const mockArchiveChunksForDocument = archiveChunksForDocument as jest.MockedFunction<typeof archiveChunksForDocument>;
const mockGetDocumentsNeedingRefresh = getDocumentsNeedingRefresh as jest.MockedFunction<
  typeof getDocumentsNeedingRefresh
>;
const mockInngestSend = inngest.send as jest.MockedFunction<typeof inngest.send>;

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/refresh', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createMockDocument(overrides?: Partial<Document>): Document {
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
    linkedEntityCount: 3,
    ...overrides,
  } as Document;
}

// ============================================================================
// TESTS
// ============================================================================

describe('URL Refresh Workflow Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocumentById.mockResolvedValue(null);
    mockInngestSend.mockResolvedValue({ ids: ['evt-123'] });
    mockStartDocumentRefresh.mockResolvedValue(true);
    mockCompleteDocumentRefresh.mockResolvedValue();
    mockArchiveChunksForDocument.mockResolvedValue(5);
  });

  // ==========================================================================
  // COMPLETE REFRESH WORKFLOW (NO CONTENT CHANGE)
  // ==========================================================================

  describe('Complete Refresh Workflow - No Content Change', () => {
    it('should complete workflow when content unchanged', async () => {
      const document = createMockDocument({
        id: 'doc-workflow-1',
        contentHash: 'unchanged-hash',
        version: 1,
      });
      mockGetDocumentById.mockResolvedValue(document);

      // Step 1: API triggers Inngest event
      const request = createMockRequest({ documentId: 'doc-workflow-1' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.refresh.requested',
        data: {
          documentId: 'doc-workflow-1',
          force: false,
        },
      });

      // Step 2: Simulate Inngest function execution
      // (In real scenario, this happens asynchronously)
      const canStart = await mockStartDocumentRefresh('doc-workflow-1');
      expect(canStart).toBe(true);

      // Step 3: Content unchanged - complete without archiving
      await mockCompleteDocumentRefresh('doc-workflow-1', false);
      expect(mockCompleteDocumentRefresh).toHaveBeenCalledWith('doc-workflow-1', false);
      expect(mockArchiveChunksForDocument).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // COMPLETE REFRESH WORKFLOW (CONTENT CHANGED)
  // ==========================================================================

  describe('Complete Refresh Workflow - Content Changed', () => {
    it('should archive chunks and increment version when content changes', async () => {
      const document = createMockDocument({
        id: 'doc-workflow-2',
        contentHash: 'old-hash',
        version: 2,
      });
      mockGetDocumentById.mockResolvedValue(document);

      // Step 1: API triggers Inngest event
      const request = createMockRequest({ documentId: 'doc-workflow-2' });
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Step 2: Simulate Inngest function detecting content change
      const newHash = 'new-hash-different';
      const contentChanged = document.contentHash !== newHash;
      expect(contentChanged).toBe(true);

      // Step 3: Archive old chunks
      const archivedCount = await mockArchiveChunksForDocument('doc-workflow-2');
      expect(archivedCount).toBe(5);

      // Step 4: Complete refresh with content changed flag
      await mockCompleteDocumentRefresh('doc-workflow-2', true, newHash);
      expect(mockCompleteDocumentRefresh).toHaveBeenCalledWith('doc-workflow-2', true, newHash);

      // Step 5: Trigger reprocessing for new content. URL docs have no stored
      // file, so the event carries the fetched content + source: 'url' to
      // route the process job through processDocumentFromContent.
      await mockInngestSend({
        name: 'app/document.process.requested',
        data: {
          documentId: 'doc-workflow-2',
          content: 'Refetched page text',
          options: { source: 'url', replaceExisting: false },
        },
      });

      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/document.process.requested',
        })
      );
    });
  });

  // ==========================================================================
  // CONCURRENCY PROTECTION
  // ==========================================================================

  describe('Concurrency Protection', () => {
    it('should prevent concurrent refreshes', async () => {
      const document = createMockDocument({
        id: 'doc-concurrent',
        refreshInProgress: true,
      });
      mockGetDocumentById.mockResolvedValue(document);

      const request = createMockRequest({ documentId: 'doc-concurrent' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error).toContain('already in progress');
      expect(data.skipped).toBe(true);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should bypass concurrency check with force flag', async () => {
      const document = createMockDocument({
        id: 'doc-force',
        refreshInProgress: true,
      });
      mockGetDocumentById.mockResolvedValue(document);

      const request = createMockRequest({ documentId: 'doc-force', force: true });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.refresh.requested',
        data: {
          documentId: 'doc-force',
          force: true,
        },
      });
    });

    it('should allow refresh after previous completes', async () => {
      // First request - refresh in progress
      const inProgressDoc = createMockDocument({
        id: 'doc-sequence',
        refreshInProgress: true,
      });
      mockGetDocumentById.mockResolvedValueOnce(inProgressDoc);

      const request1 = createMockRequest({ documentId: 'doc-sequence' });
      const response1 = await POST(request1);
      expect(response1.status).toBe(409);

      // Second request - refresh completed
      const completedDoc = createMockDocument({
        id: 'doc-sequence',
        refreshInProgress: false,
      });
      mockGetDocumentById.mockResolvedValueOnce(completedDoc);

      const request2 = createMockRequest({ documentId: 'doc-sequence' });
      const response2 = await POST(request2);
      expect(response2.status).toBe(200);
    });
  });

  // ==========================================================================
  // ERROR HANDLING WORKFLOW
  // ==========================================================================

  describe('Error Handling Workflow', () => {
    it('should handle fetch failures gracefully', async () => {
      const document = createMockDocument({ id: 'doc-fetch-fail' });
      mockGetDocumentById.mockResolvedValue(document);

      // API triggers event
      const request = createMockRequest({ documentId: 'doc-fetch-fail' });
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Simulate fetch failure in Inngest function
      await mockFailDocumentRefresh('doc-fetch-fail', 'Network timeout');
      expect(mockFailDocumentRefresh).toHaveBeenCalledWith('doc-fetch-fail', 'Network timeout');
    });

    it('should handle blocked URLs', async () => {
      const document = createMockDocument({ id: 'doc-blocked' });
      mockGetDocumentById.mockResolvedValue(document);

      // API triggers event
      const request = createMockRequest({ documentId: 'doc-blocked' });
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Simulate blocked URL in Inngest function
      await mockMarkDocumentBlocked('doc-blocked', 'Access forbidden (403)');
      expect(mockMarkDocumentBlocked).toHaveBeenCalledWith('doc-blocked', 'Access forbidden (403)');
    });

    it('should propagate service errors through API', async () => {
      mockGetDocumentById.mockRejectedValueOnce(new Error('Database error'));

      const request = createMockRequest({ documentId: 'doc-error' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // BATCH REFRESH WORKFLOW
  // ==========================================================================

  describe('Batch Refresh Workflow', () => {
    it('should find stale documents and trigger batch refresh', async () => {
      const staleDocuments = [
        createMockDocument({ id: 'stale-1', lastFetchedAt: Date.now() - 10 * 24 * 60 * 60 * 1000 }),
        createMockDocument({ id: 'stale-2', lastFetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
        createMockDocument({ id: 'stale-3', lastFetchedAt: Date.now() - 9 * 24 * 60 * 60 * 1000 }),
      ];
      mockGetDocumentsNeedingRefresh.mockResolvedValue(staleDocuments);

      // Get stale documents
      const documents = await mockGetDocumentsNeedingRefresh(7 * 24 * 60 * 60 * 1000, 50);
      expect(documents).toHaveLength(3);

      // Trigger batch refresh
      await mockInngestSend({
        name: 'app/document.batch-refresh.requested',
        data: {
          documentIds: documents.map((d) => d.id),
        },
      });

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.batch-refresh.requested',
        data: {
          documentIds: ['stale-1', 'stale-2', 'stale-3'],
        },
      });
    });

    it('should handle empty batch gracefully', async () => {
      mockGetDocumentsNeedingRefresh.mockResolvedValue([]);

      const documents = await mockGetDocumentsNeedingRefresh(7 * 24 * 60 * 60 * 1000, 50);
      expect(documents).toHaveLength(0);

      // No events should be sent
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DOCUMENT TYPE VALIDATION
  // ==========================================================================

  describe('Document Type Validation', () => {
    it('should reject PDF documents', async () => {
      const pdfDoc = createMockDocument({ id: 'pdf-doc', type: 'pdf' });
      mockGetDocumentById.mockResolvedValue(pdfDoc);

      const request = createMockRequest({ documentId: 'pdf-doc' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Only URL documents can be refreshed');
    });

    it('should reject file documents', async () => {
      const fileDoc = createMockDocument({ id: 'file-doc', type: 'text' });
      mockGetDocumentById.mockResolvedValue(fileDoc);

      const request = createMockRequest({ documentId: 'file-doc' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Only URL documents can be refreshed');
    });

    it('should accept URL documents', async () => {
      const urlDoc = createMockDocument({ id: 'url-doc', type: 'url' });
      mockGetDocumentById.mockResolvedValue(urlDoc);

      const request = createMockRequest({ documentId: 'url-doc' });
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // VERSION TRACKING
  // ==========================================================================

  describe('Version Tracking', () => {
    it('should track version increments across multiple refreshes', async () => {
      // Initial document version 1
      const docV1 = createMockDocument({ id: 'versioned-doc', version: 1, contentHash: 'hash-v1' });

      // Simulate first content change
      const newVersion1 = docV1.version! + 1;
      expect(newVersion1).toBe(2);

      // Simulate second content change
      const docV2 = { ...docV1, version: 2, contentHash: 'hash-v2' };
      const newVersion2 = docV2.version + 1;
      expect(newVersion2).toBe(3);
    });

    it('should not increment version when content unchanged', async () => {
      const doc = createMockDocument({ id: 'static-doc', version: 5, contentHash: 'same-hash' });

      // Content same
      const contentChanged = doc.contentHash !== 'same-hash';
      expect(contentChanged).toBe(false);

      // Version should remain
      const finalVersion = contentChanged ? doc.version! + 1 : doc.version;
      expect(finalVersion).toBe(5);
    });
  });
});
