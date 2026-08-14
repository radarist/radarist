/**
 * @jest-environment node
 */

// ============================================================================
// Mocks (MUST be before imports)
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

const mockCreateDocument = jest.fn();
const mockUpdateDocument = jest.fn();
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminCreateDocument: (...args: unknown[]) => mockCreateDocument(...args),
  adminUpdateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
}));

const mockSafeSendEvent = jest.fn();
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  safeSendEvent: (...args: unknown[]) => mockSafeSendEvent(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import { SchemaType } from '@google/generative-ai';
import { DEEP_RESEARCH_TOOLS, executeCreateResearchDocument } from '../deep-research-tools';

// ============================================================================
// Tests
// ============================================================================

describe('Deep Research Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mocks
    mockCreateDocument.mockResolvedValue({ id: 'doc-123' });
    mockSafeSendEvent.mockResolvedValue(true);
  });

  // --------------------------------------------------------------------------
  // Tool declarations
  // --------------------------------------------------------------------------
  describe('DEEP_RESEARCH_TOOLS declarations', () => {
    it('should export exactly 1 tool', () => {
      expect(DEEP_RESEARCH_TOOLS).toHaveLength(1);
    });

    it('should define createResearchDocument tool', () => {
      const tool = DEEP_RESEARCH_TOOLS[0];
      expect(tool.name).toBe('createResearchDocument');
    });

    it('should require query parameter', () => {
      const tool = DEEP_RESEARCH_TOOLS[0];
      expect(tool.parameters?.required).toEqual(['query']);
    });

    it('should define tags as optional ARRAY parameter', () => {
      const tool = DEEP_RESEARCH_TOOLS[0];
      const props = tool.parameters?.properties as Record<string, { type: string; items?: { type: string } }>;
      expect(props).toHaveProperty('tags');
      expect(props.tags.type).toBe(SchemaType.ARRAY);
      expect(props.tags.items).toEqual({ type: SchemaType.STRING });
      // tags is not in required, confirming it is optional
      expect(tool.parameters?.required).not.toContain('tags');
    });
  });

  // --------------------------------------------------------------------------
  // executeCreateResearchDocument
  // --------------------------------------------------------------------------
  describe('executeCreateResearchDocument', () => {
    const userId = 'user-abc';
    const baseArgs = { query: 'Post-Quantum Cryptography adoption in finance' };

    it('should create document with correct fields in a truthful processing state (AI-021)', async () => {
      await executeCreateResearchDocument(baseArgs, userId);

      expect(mockCreateDocument).toHaveBeenCalledWith(
        {
          title: baseArgs.query,
          type: 'markdown',
          description: `Deep research: ${baseArgs.query}`,
          storageUrl: '',
          uploadedBy: userId,
          tags: ['deep-research'],
          mimeType: 'text/markdown',
          visibility: 'workspace',
        },
        { initialStatus: 'processing' }
      );
    });

    it('should send Inngest event with correct data', async () => {
      await executeCreateResearchDocument(baseArgs, userId);

      expect(mockSafeSendEvent).toHaveBeenCalledWith(
        {
          name: 'app/document.deep-research.requested',
          data: {
            query: baseArgs.query,
            documentId: 'doc-123',
            userId,
          },
        },
        { logPrefix: '[DeepResearch]' }
      );
    });

    it('should return documentId and message', async () => {
      const result = await executeCreateResearchDocument(baseArgs, userId);

      expect(result.documentId).toBe('doc-123');
      expect(result.message).toContain('deep research task');
      expect(result.message).toContain(baseArgs.query.substring(0, 80));
    });

    it('should pass tags to document and event when provided', async () => {
      const tags = ['quantum', 'cryptography', 'security'];
      await executeCreateResearchDocument({ ...baseArgs, tags }, userId);

      // Tags passed to document creation (with auto-added 'deep-research' tag)
      expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({ tags: ['quantum', 'cryptography', 'security', 'deep-research'] }), expect.any(Object));

      // Tags included in Inngest event data
      expect(mockSafeSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tags }),
        }),
        expect.any(Object)
      );
    });

    it('should always include deep-research tag even when no user tags provided', async () => {
      await executeCreateResearchDocument(baseArgs, userId);

      expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({ tags: ['deep-research'] }), expect.any(Object));
    });

    it('should not include tags in event data when not provided', async () => {
      await executeCreateResearchDocument(baseArgs, userId);

      const eventPayload = mockSafeSendEvent.mock.calls[0][0];
      expect(eventPayload.data).not.toHaveProperty('tags');
    });

    it('should throw if no userId is provided', async () => {
      await expect(executeCreateResearchDocument(baseArgs, '')).rejects.toThrow(
        'createResearchDocument requires an authenticated user'
      );
    });

    it('should reject an empty query BEFORE creating the document or dispatching (zero-cost validation)', async () => {
      await expect(executeCreateResearchDocument({ query: '   ' }, userId)).rejects.toThrow(
        'createResearchDocument requires a non-empty query'
      );

      expect(mockCreateDocument).not.toHaveBeenCalled();
      expect(mockSafeSendEvent).not.toHaveBeenCalled();
    });

    it('should attribute the document and event to the provided userId (MCP key-owner attribution)', async () => {
      await executeCreateResearchDocument(baseArgs, 'key-owner-001');

      expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: 'key-owner-001' }), expect.any(Object));
      expect(mockSafeSendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'key-owner-001' }) }),
        expect.any(Object)
      );
    });

    it('AI-021: marks the document failed and throws when the job dispatch is rejected', async () => {
      mockSafeSendEvent.mockResolvedValue(false);

      await expect(executeCreateResearchDocument(baseArgs, userId)).rejects.toThrow(/could not be started/i);

      expect(mockUpdateDocument).toHaveBeenCalledWith('doc-123', {
        status: 'failed',
        errorMessage: expect.stringMatching(/could not be started/i),
      });
    });

    it('AI-021: still throws honestly even if the failure-marking write also fails', async () => {
      mockSafeSendEvent.mockResolvedValue(false);
      mockUpdateDocument.mockRejectedValue(new Error('Firestore unavailable'));

      await expect(executeCreateResearchDocument(baseArgs, userId)).rejects.toThrow(/could not be started/i);
    });

    it('should truncate long queries in the message with ellipsis', async () => {
      const longQuery = 'A'.repeat(100);
      const result = await executeCreateResearchDocument({ query: longQuery }, userId);

      expect(result.message).toContain(longQuery.substring(0, 80));
      expect(result.message).toContain('...');
    });

    it('should not add ellipsis for short queries', async () => {
      const shortQuery = 'Short query';
      const result = await executeCreateResearchDocument({ query: shortQuery }, userId);

      expect(result.message).toContain(shortQuery);
      // Count ellipsis — none should appear from truncation
      // (the message does include "..." at the end for natural language, but not from truncation)
      expect(result.message).toContain(`"${shortQuery}"`);
    });

    it('should propagate errors from createDocument', async () => {
      mockCreateDocument.mockRejectedValue(new Error('Firestore write failed'));

      await expect(executeCreateResearchDocument(baseArgs, userId)).rejects.toThrow('Firestore write failed');
    });
  });
});
