/**
 * Unit Tests for Document & Evidence Layer AI Tools
 *
 * Tests the document tool definitions and execution handlers:
 * - Tool definitions schema validation
 * - executeSearchDocuments
 * - executeListDocuments
 * - executeGetDocumentDetails
 * - executeCaptureEvidence
 * - executeGetChunkContent
 *
 * @phase Phase 2: Evidence Layer
 * @jest-environment node
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

// Guard against the real firebase-admin / jwks-rsa chain loading transitively
// through any admin helper module under automock.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

// Mock the exact server-side admin helpers imported by document-tools.
jest.mock('@/lib/document-admin');
jest.mock('@/lib/document-chunk-admin');
jest.mock('@/lib/relations-admin');

// Import functions under test
import {
  DOCUMENT_TOOLS,
  executeSearchDocuments,
  executeListDocuments,
  executeGetDocumentDetails,
  executeCaptureEvidence,
  executeGetChunkContent,
} from '../tools/document-tools';

// Import mocked modules - these will be Jest mocks
import * as documentAdmin from '@/lib/document-admin';
import * as documentChunkAdmin from '@/lib/document-chunk-admin';
import * as relationsAdmin from '@/lib/relations-admin';

// Type assertions for mocked functions
const mockGetDocuments = documentAdmin.adminGetDocuments as jest.Mock;
const mockGetDocumentById = documentAdmin.adminGetDocumentById as jest.Mock;
const mockGetChunksForDocument = documentChunkAdmin.adminGetChunksForDocument as jest.Mock;
const mockGetChunkById = documentChunkAdmin.adminGetChunkById as jest.Mock;
const mockSearchChunksSimple = documentChunkAdmin.adminSearchChunksSimple as jest.Mock;
const mockCreateRelation = relationsAdmin.adminCreateRelation as jest.Mock;

// ============================================================================
// Mock Data
// ============================================================================

const mockDocument = {
  id: 'doc-123',
  title: 'React Performance Guide',
  type: 'pdf' as const,
  status: 'processed' as const,
  chunkCount: 15,
  description: 'A comprehensive guide to React performance optimization',
  tags: ['react', 'performance', 'frontend'],
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now(),
  fileSize: 1024000,
  mimeType: 'application/pdf',
  storageUrl: '/documents/react-perf.pdf',
  uploadedBy: 'user-456',
};

const mockChunk = {
  id: 'chunk-001',
  documentId: 'doc-123',
  content: 'React components should be optimized for performance using memoization...',
  metadata: {
    page: 5,
    section: 'Performance Optimization',
    startChar: 1000,
    endChar: 1500,
  },
  chunkIndex: 5,
  tokenCount: 125,
  createdAt: Date.now(),
};

const mockChunks = [
  mockChunk,
  {
    id: 'chunk-002',
    documentId: 'doc-123',
    content: 'useMemo and useCallback are essential hooks for preventing unnecessary re-renders...',
    metadata: { page: 6, startChar: 1500, endChar: 2000 },
    chunkIndex: 6,
    tokenCount: 118,
    createdAt: Date.now(),
  },
  {
    id: 'chunk-003',
    documentId: 'doc-123',
    content: 'Virtual DOM diffing can be optimized by using keys correctly...',
    metadata: { page: 7, startChar: 2000, endChar: 2500 },
    chunkIndex: 7,
    tokenCount: 95,
    createdAt: Date.now(),
  },
];

const mockRelation = {
  id: 'rel-001',
  relationType: 'supports',
  sourceSnapshot: {
    id: 'doc-123',
    type: 'document',
    name: 'React Performance Guide',
    snapshotAt: Date.now(),
  },
  targetSnapshot: {
    id: 'tech-001',
    type: 'technology',
    name: 'React',
    snapshotAt: Date.now(),
  },
  notes: 'Evidence captured via AI Assistant',
  aiSuggested: true,
  confidence: 85,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ============================================================================
// Tests
// ============================================================================

describe('Document AI Tools Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Tool Definitions', () => {
    it('should export DOCUMENT_TOOLS array with 6 tools', () => {
      expect(DOCUMENT_TOOLS).toBeDefined();
      expect(Array.isArray(DOCUMENT_TOOLS)).toBe(true);
      // 6th tool: linkDocumentToEntity (AI-023 explicit Document→entity link).
      expect(DOCUMENT_TOOLS).toHaveLength(6);
    });

    it('should have searchDocuments tool with correct schema', () => {
      const searchTool = DOCUMENT_TOOLS.find((t) => t.name === 'searchDocuments');
      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toContain('Search through uploaded document content');
      expect(searchTool?.parameters?.properties).toHaveProperty('query');
      expect(searchTool?.parameters?.properties).toHaveProperty('documentId');
      expect(searchTool?.parameters?.properties).toHaveProperty('limit');
      expect(searchTool?.parameters?.required).toContain('query');
    });

    it('should have listDocuments tool with correct schema', () => {
      const listTool = DOCUMENT_TOOLS.find((t) => t.name === 'listDocuments');
      expect(listTool).toBeDefined();
      expect(listTool?.description).toContain('List documents');
      expect(listTool?.parameters?.properties).toHaveProperty('type');
      expect(listTool?.parameters?.properties).toHaveProperty('status');
      expect(listTool?.parameters?.properties).toHaveProperty('search');
      expect(listTool?.parameters?.properties).toHaveProperty('tags');
      expect(listTool?.parameters?.properties).toHaveProperty('limit');
    });

    it('should have getDocumentDetails tool with correct schema', () => {
      const detailsTool = DOCUMENT_TOOLS.find((t) => t.name === 'getDocumentDetails');
      expect(detailsTool).toBeDefined();
      expect(detailsTool?.description).toContain('Get full details about a specific document');
      expect(detailsTool?.parameters?.properties).toHaveProperty('documentId');
      expect(detailsTool?.parameters?.properties).toHaveProperty('includeChunks');
      expect(detailsTool?.parameters?.properties).toHaveProperty('chunkLimit');
      expect(detailsTool?.parameters?.required).toContain('documentId');
    });

    it('should have captureEvidence tool with correct schema', () => {
      const captureTool = DOCUMENT_TOOLS.find((t) => t.name === 'captureEvidence');
      expect(captureTool).toBeDefined();
      expect(captureTool?.description).toContain('Link a document or specific chunk as evidence');
      expect(captureTool?.parameters?.properties).toHaveProperty('documentId');
      expect(captureTool?.parameters?.properties).toHaveProperty('chunkId');
      expect(captureTool?.parameters?.properties).toHaveProperty('targetEntityId');
      expect(captureTool?.parameters?.properties).toHaveProperty('targetEntityType');
      expect(captureTool?.parameters?.properties).toHaveProperty('notes');
      expect(captureTool?.parameters?.properties).toHaveProperty('evidenceType');
      expect(captureTool?.parameters?.required).toContain('documentId');
      expect(captureTool?.parameters?.required).toContain('targetEntityId');
      expect(captureTool?.parameters?.required).toContain('targetEntityType');
    });

    it('should have getChunkContent tool with correct schema', () => {
      const chunkTool = DOCUMENT_TOOLS.find((t) => t.name === 'getChunkContent');
      expect(chunkTool).toBeDefined();
      expect(chunkTool?.description).toContain('Get the full text content');
      expect(chunkTool?.parameters?.properties).toHaveProperty('chunkId');
      expect(chunkTool?.parameters?.required).toContain('chunkId');
    });
  });

  describe('executeSearchDocuments', () => {
    beforeEach(() => {
      mockSearchChunksSimple.mockResolvedValue(mockChunks);
      mockGetDocumentById.mockResolvedValue(mockDocument);
    });

    it('should search document chunks and return results', async () => {
      const result = await executeSearchDocuments({ query: 'performance optimization' });

      expect(result.success).toBe(true);
      expect(result.data?.results).toBeDefined();
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results[0]).toHaveProperty('chunkId');
      expect(result.data?.results[0]).toHaveProperty('documentTitle');
      expect(result.data?.results[0]).toHaveProperty('content');
      expect(mockSearchChunksSimple).toHaveBeenCalledWith('performance optimization', undefined, 10);
    });

    it('should limit search results', async () => {
      const result = await executeSearchDocuments({ query: 'react', limit: 2 });

      expect(result.success).toBe(true);
      expect(mockSearchChunksSimple).toHaveBeenCalledWith('react', undefined, 2);
    });

    it('should filter by documentId when provided', async () => {
      const result = await executeSearchDocuments({ query: 'test', documentId: 'doc-123' });

      expect(result.success).toBe(true);
      expect(mockSearchChunksSimple).toHaveBeenCalledWith('test', 'doc-123', 10);
    });

    it('should handle empty search results', async () => {
      mockSearchChunksSimple.mockResolvedValue([]);

      const result = await executeSearchDocuments({ query: 'nonexistent' });

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(0);
    });

    it('should handle search errors gracefully', async () => {
      mockSearchChunksSimple.mockRejectedValue(new Error('Search index unavailable'));

      const result = await executeSearchDocuments({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Search index unavailable');
    });

    it('should truncate long content in results', async () => {
      const longChunk = {
        ...mockChunk,
        content: 'A'.repeat(600), // More than 500 chars
      };
      mockSearchChunksSimple.mockResolvedValue([longChunk]);

      const result = await executeSearchDocuments({ query: 'test' });

      expect(result.success).toBe(true);
      if (result.data?.results[0]?.content) {
        expect(result.data.results[0].content.length).toBeLessThanOrEqual(503); // 500 + '...'
      }
    });
  });

  describe('executeListDocuments', () => {
    beforeEach(() => {
      mockGetDocuments.mockResolvedValue([mockDocument]);
    });

    it('should list documents without filters', async () => {
      const result = await executeListDocuments({});

      expect(result.success).toBe(true);
      expect(result.data?.documents).toBeDefined();
      expect(result.data?.documents.length).toBeGreaterThanOrEqual(0);
      expect(mockGetDocuments).toHaveBeenCalledWith({
        type: undefined,
        status: undefined,
        search: undefined,
        tags: undefined,
        limit: 20,
      });
    });

    it('should filter by document type', async () => {
      const result = await executeListDocuments({ type: 'pdf' });

      expect(result.success).toBe(true);
      expect(mockGetDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pdf',
        })
      );
    });

    it('should filter by status', async () => {
      const result = await executeListDocuments({ status: 'processed' });

      expect(result.success).toBe(true);
      expect(mockGetDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'processed',
        })
      );
    });

    it('should handle empty document list', async () => {
      mockGetDocuments.mockResolvedValue([]);

      const result = await executeListDocuments({});

      expect(result.success).toBe(true);
      expect(result.data?.documents).toHaveLength(0);
    });

    it('should handle list errors gracefully', async () => {
      mockGetDocuments.mockRejectedValue(new Error('Database connection failed'));

      const result = await executeListDocuments({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database connection failed');
    });
  });

  describe('executeGetDocumentDetails', () => {
    beforeEach(() => {
      mockGetDocumentById.mockResolvedValue(mockDocument);
      mockGetChunksForDocument.mockResolvedValue(mockChunks);
    });

    it('should get document with chunks', async () => {
      const result = await executeGetDocumentDetails({ documentId: 'doc-123' });

      expect(result.success).toBe(true);
      expect(result.data?.document).toBeDefined();
      expect(result.data?.document.id).toBe('doc-123');
      expect(result.data?.chunks).toBeDefined();
      expect(mockGetDocumentById).toHaveBeenCalledWith('doc-123');
      expect(mockGetChunksForDocument).toHaveBeenCalledWith('doc-123');
    });

    it('should exclude chunks when includeChunks is false', async () => {
      const result = await executeGetDocumentDetails({
        documentId: 'doc-123',
        includeChunks: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.document).toBeDefined();
      expect(result.data?.chunks).toHaveLength(0);
      expect(mockGetChunksForDocument).not.toHaveBeenCalled();
    });

    it('should return error for non-existent document', async () => {
      mockGetDocumentById.mockResolvedValue(null);

      const result = await executeGetDocumentDetails({ documentId: 'doc-999' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Document not found');
    });

    it('should handle database errors gracefully', async () => {
      mockGetDocumentById.mockRejectedValue(new Error('Database error'));

      const result = await executeGetDocumentDetails({ documentId: 'doc-123' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('should limit chunks when chunkLimit is specified', async () => {
      const result = await executeGetDocumentDetails({
        documentId: 'doc-123',
        chunkLimit: 1,
      });

      expect(result.success).toBe(true);
      expect(result.data?.chunks.length).toBeLessThanOrEqual(1);
    });
  });

  describe('executeCaptureEvidence', () => {
    beforeEach(() => {
      mockGetDocumentById.mockResolvedValue(mockDocument);
      mockGetChunkById.mockResolvedValue(mockChunk);
      mockCreateRelation.mockResolvedValue(mockRelation);
    });

    it('should create evidence relation between document and entity', async () => {
      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
      });

      expect(result.success).toBe(true);
      expect(result.data?.relationId).toBeDefined();
      expect(result.data?.documentTitle).toBe('React Performance Guide');
      expect(mockCreateRelation).toHaveBeenCalledWith(
        expect.objectContaining({
          relationType: 'supports',
          sourceSnapshot: expect.objectContaining({
            id: 'doc-123',
            type: 'document',
          }),
          targetSnapshot: expect.objectContaining({
            id: 'tech-001',
            type: 'technology',
          }),
        })
      );
    });

    it('should return error for non-existent document', async () => {
      mockGetDocumentById.mockResolvedValue(null);

      const result = await executeCaptureEvidence({
        documentId: 'doc-999',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Document not found');
    });

    it('should support different evidence types', async () => {
      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
        evidenceType: 'contradicts',
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceType).toBe('contradicts');
      expect(mockCreateRelation).toHaveBeenCalledWith(
        expect.objectContaining({
          relationType: 'contradicts',
        })
      );
    });

    it('should include chunkId in result when specified', async () => {
      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        chunkId: 'chunk-001',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
      });

      expect(result.success).toBe(true);
      expect(result.data?.chunkId).toBe('chunk-001');
    });

    it('should return error for non-existent chunk', async () => {
      mockGetChunkById.mockResolvedValue(null);

      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        chunkId: 'chunk-999',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chunk not found');
    });

    it('should return error for chunk from different document', async () => {
      mockGetChunkById.mockResolvedValue({
        ...mockChunk,
        documentId: 'doc-456', // Different document
      });

      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        chunkId: 'chunk-001',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not belong to document');
    });

    it('should include notes in relation when provided', async () => {
      const result = await executeCaptureEvidence({
        documentId: 'doc-123',
        targetEntityId: 'tech-001',
        targetEntityType: 'technology',
        notes: 'Supports performance claims',
      });

      expect(result.success).toBe(true);
      expect(mockCreateRelation).toHaveBeenCalledWith(
        expect.objectContaining({
          notes: expect.stringContaining('Supports performance claims'),
        })
      );
    });
  });

  describe('executeGetChunkContent', () => {
    beforeEach(() => {
      mockGetChunkById.mockResolvedValue(mockChunk);
      mockGetDocumentById.mockResolvedValue(mockDocument);
    });

    it('should get full chunk content', async () => {
      const result = await executeGetChunkContent({ chunkId: 'chunk-001' });

      expect(result.success).toBe(true);
      expect(result.data?.chunkId).toBe('chunk-001');
      expect(result.data?.content).toBe(mockChunk.content);
      expect(result.data?.documentTitle).toBe('React Performance Guide');
      expect(result.data?.page).toBe(5);
      expect(result.data?.section).toBe('Performance Optimization');
      expect(mockGetChunkById).toHaveBeenCalledWith('chunk-001');
    });

    it('should return error for non-existent chunk', async () => {
      mockGetChunkById.mockResolvedValue(null);

      const result = await executeGetChunkContent({ chunkId: 'chunk-999' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chunk not found');
    });

    it('should handle database errors gracefully', async () => {
      mockGetChunkById.mockRejectedValue(new Error('Chunk service unavailable'));

      const result = await executeGetChunkContent({ chunkId: 'chunk-001' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chunk service unavailable');
    });
  });
});
