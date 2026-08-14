/**
 * Unit Tests for Document Refresh API Route
 *
 * Tests the POST /api/documents/refresh endpoint for:
 * - Request validation (documentId required)
 * - Document existence validation
 * - Document type validation (URL only)
 * - Concurrency guard (refreshInProgress check)
 * - Force flag bypass
 * - Inngest event triggering
 * - Error handling
 *
 * @jest-environment node
 * @phase Knowledge Tab Sprint
 */

import { NextRequest } from 'next/server';
import type { Document } from '@/lib/types';

// ============================================================================
// MOCKS - Must be defined before any imports that use them
// ============================================================================

// Mock the document-admin module (route migrated to admin SDK)
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminGetDocumentById: jest.fn(),
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

// Import the mocked modules
import { adminGetDocumentById } from '@/lib/document-admin';
import { inngest } from '@/lib/inngest/client';

// Import the route handler after mocks
import { POST } from '../route';

// Cast mocks for TypeScript
const mockGetDocumentById = adminGetDocumentById as jest.MockedFunction<typeof adminGetDocumentById>;
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
    name: 'Test Document',
    type: 'url',
    status: 'processed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceUrl: 'https://example.com/article',
    contentHash: 'abc123',
    version: 1,
    refreshInProgress: false,
    linkedEntityCount: 3,
    ...overrides,
  } as Document;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Document Refresh API Route (Knowledge Tab Sprint)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocumentById.mockResolvedValue(null);
    mockInngestSend.mockResolvedValue({ ids: [] });
  });

  // --------------------------------------------------------------------------
  // Input Validation
  // --------------------------------------------------------------------------

  describe('Input Validation', () => {
    it('should return 400 when documentId is missing', async () => {
      const request = createMockRequest({});

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('documentId is required');
    });

    it('should return 400 when documentId is empty string', async () => {
      const request = createMockRequest({ documentId: '' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('documentId is required');
    });

    it('should return 400 when documentId is null', async () => {
      const request = createMockRequest({ documentId: null });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('documentId is required');
    });
  });

  // --------------------------------------------------------------------------
  // Document Existence Validation
  // --------------------------------------------------------------------------

  describe('Document Existence Validation', () => {
    it('should return 404 when document not found', async () => {
      mockGetDocumentById.mockResolvedValueOnce(null);

      const request = createMockRequest({ documentId: 'nonexistent-doc' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain('not found');
      expect(mockGetDocumentById).toHaveBeenCalledWith('nonexistent-doc');
    });

    it('should call getDocumentById with the provided documentId', async () => {
      mockGetDocumentById.mockResolvedValueOnce(createMockDocument());

      const request = createMockRequest({ documentId: 'doc-123' });
      await POST(request);

      expect(mockGetDocumentById).toHaveBeenCalledWith('doc-123');
    });
  });

  // --------------------------------------------------------------------------
  // Document Type Validation
  // --------------------------------------------------------------------------

  describe('Document Type Validation', () => {
    it('should return 400 when document is not URL type (PDF)', async () => {
      const pdfDocument = createMockDocument({ type: 'pdf' });
      mockGetDocumentById.mockResolvedValueOnce(pdfDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Only URL documents can be refreshed');
    });

    it('should return 400 when document is not URL type (file)', async () => {
      const fileDocument = createMockDocument({ type: 'text' });
      mockGetDocumentById.mockResolvedValueOnce(fileDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Only URL documents can be refreshed');
    });

    it('should accept URL type documents', async () => {
      const urlDocument = createMockDocument({ type: 'url' });
      mockGetDocumentById.mockResolvedValueOnce(urlDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Concurrency Guard
  // --------------------------------------------------------------------------

  describe('Concurrency Guard', () => {
    it('should return 409 when refresh is already in progress', async () => {
      const inProgressDocument = createMockDocument({ refreshInProgress: true });
      mockGetDocumentById.mockResolvedValueOnce(inProgressDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error).toContain('already in progress');
      expect(data.skipped).toBe(true);
    });

    it('should not call inngest.send when refresh is in progress', async () => {
      const inProgressDocument = createMockDocument({ refreshInProgress: true });
      mockGetDocumentById.mockResolvedValueOnce(inProgressDocument);

      const request = createMockRequest({ documentId: 'doc-123' });
      await POST(request);

      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should proceed when refreshInProgress is STALE (crashed run self-heals)', async () => {
      // A refresh flag left behind by a crashed worker: refreshInProgress is
      // true but the doc hasn't been touched for longer than REFRESH_STALE_MS.
      // The time-bounded guard (isRefreshActive) must let the refresh through
      // instead of returning 409 forever — this was the user-visible
      // "Refresh URL does nothing" break.
      const staleDocument = createMockDocument({
        refreshInProgress: true,
        updatedAt: Date.now() - 16 * 60 * 1000, // 16 min > 15-min staleness window
      });
      mockGetDocumentById.mockResolvedValueOnce(staleDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockInngestSend).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/document.refresh.requested' }));
    });

    it('should still 409 when the in-progress flag is fresh (recently touched)', async () => {
      const freshDocument = createMockDocument({
        refreshInProgress: true,
        updatedAt: Date.now() - 60 * 1000, // 1 min ago — genuinely running
      });
      mockGetDocumentById.mockResolvedValueOnce(freshDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);

      expect(response.status).toBe(409);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should bypass concurrency check when force=true', async () => {
      const inProgressDocument = createMockDocument({ refreshInProgress: true });
      mockGetDocumentById.mockResolvedValueOnce(inProgressDocument);

      const request = createMockRequest({ documentId: 'doc-123', force: true });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockInngestSend).toHaveBeenCalled();
    });

    it('should proceed when refreshInProgress is false', async () => {
      const idleDocument = createMockDocument({ refreshInProgress: false });
      mockGetDocumentById.mockResolvedValueOnce(idleDocument);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Inngest Event Triggering
  // --------------------------------------------------------------------------

  describe('Inngest Event Triggering', () => {
    it('should send correct event to Inngest', async () => {
      const document = createMockDocument();
      mockGetDocumentById.mockResolvedValueOnce(document);

      const request = createMockRequest({ documentId: 'doc-123' });
      await POST(request);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.refresh.requested',
        data: {
          documentId: 'doc-123',
          force: false,
        },
      });
    });

    it('should pass force flag to Inngest event', async () => {
      const document = createMockDocument();
      mockGetDocumentById.mockResolvedValueOnce(document);

      const request = createMockRequest({ documentId: 'doc-123', force: true });
      await POST(request);

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.refresh.requested',
        data: {
          documentId: 'doc-123',
          force: true,
        },
      });
    });

    it('should default force to false when not provided', async () => {
      const document = createMockDocument();
      mockGetDocumentById.mockResolvedValueOnce(document);

      const request = createMockRequest({ documentId: 'doc-123' });
      await POST(request);

      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            force: false,
          }),
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Success Response
  // --------------------------------------------------------------------------

  describe('Success Response', () => {
    it('should return 200 with success response', async () => {
      const document = createMockDocument();
      mockGetDocumentById.mockResolvedValueOnce(document);

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('Document refresh triggered');
      expect(data.documentId).toBe('doc-123');
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('should return 500 when getDocumentById throws', async () => {
      mockGetDocumentById.mockRejectedValueOnce(new Error('Database error'));

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
    });

    it('should return 500 when inngest.send throws', async () => {
      const document = createMockDocument();
      mockGetDocumentById.mockResolvedValueOnce(document);
      mockInngestSend.mockRejectedValueOnce(new Error('Inngest error'));

      const request = createMockRequest({ documentId: 'doc-123' });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
    });

    it('should return 500 when request body is invalid JSON', async () => {
      const request = new NextRequest('http://localhost:3000/api/documents/refresh', {
        method: 'POST',
        body: 'not-valid-json',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Internal server error');
    });
  });
});
