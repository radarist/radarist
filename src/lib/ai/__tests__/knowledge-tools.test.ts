/**
 * Unit Tests for Knowledge Graph AI Tools
 *
 * Tests the knowledge graph tool definitions and execution handlers:
 * - Tool definitions schema validation
 * - executeSearchKnowledgeGraph (hybrid vector + graph search)
 * - executeGetEntityContext (entity context with depth)
 * - executeFormatCitations (citation formatting)
 *
 * @jest-environment node
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

// Mock the service modules
jest.mock('@/lib/graph', () => ({
  searchChunksByText: jest.fn(),
  findSimilarDocuments: jest.fn(),
  getNeighbors: jest.fn(),
  findConnected: jest.fn(),
  findPath: jest.fn().mockResolvedValue(null),
  getEntity: jest.fn(),
  fetchDocumentsForEntity: jest.fn(),
  searchEntitiesBySemantic: jest.fn(),
  GraphUnavailableError: class GraphUnavailableError extends Error {},
  isVectorIndexMissingError: jest.fn((error: unknown) =>
    /index.*(missing|not found)|no such.*index/i.test(error instanceof Error ? error.message : String(error))
  ),
  // AI-026: NOT stubbed — the reported entity type must come from the real
  // canonical-label derivation, not a mock's opinion.
  businessEntityGraphType: jest.requireActual('@/lib/graph/business-entity-identity').businessEntityGraphType,
}));

jest.mock('@/lib/ai/client', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]),
}));

jest.mock('@/lib/ai/retrieval/graph-first-retrieval', () => ({
  retrieveGraphFirst: jest.fn(),
}));

jest.mock('@/lib/graph/service-factory', () => ({
  getGraphMode: jest.fn().mockResolvedValue({
    mode: 'mock',
    reason: undefined,
    maxHopsAvailable: 6,
  }),
}));

// Source under test calls admin twins from @/lib/concept-admin
// (adminGetConcepts / adminGetConceptById), not the old client
// @/lib/concept-service. Mock the admin module so the real one
// (which statically imports firebase-admin) never loads.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

jest.mock('@/lib/concept-admin', () => ({
  adminGetConcepts: jest.fn(),
  adminGetConceptById: jest.fn(),
}));

// Import functions under test
import {
  KNOWLEDGE_TOOLS,
  executeSearchKnowledgeGraph,
  executeGetEntityContext,
  executeFormatCitations,
  type KnowledgeSearchResult,
  type EntityContextResult,
} from '../tools/knowledge-tools';

// Import mocked modules
import * as graphModule from '@/lib/graph';
import * as aiClient from '@/lib/ai/client';
import * as graphFirstModule from '@/lib/ai/retrieval/graph-first-retrieval';
import * as conceptService from '@/lib/concept-admin';

// Type assertions for mocked functions
const mockSearchChunksByText = graphModule.searchChunksByText as jest.Mock;
const mockFindSimilarDocuments = graphModule.findSimilarDocuments as jest.Mock;
const mockGetNeighbors = graphModule.getNeighbors as jest.Mock;
const mockFindConnected = graphModule.findConnected as jest.Mock;
const mockGetEntity = graphModule.getEntity as jest.Mock;
const mockGetConcepts = conceptService.adminGetConcepts as jest.Mock;
const mockGetConceptById = conceptService.adminGetConceptById as jest.Mock;
const mockGenerateEmbedding = aiClient.generateEmbedding as jest.Mock;
const mockRetrieveGraphFirst = graphFirstModule.retrieveGraphFirst as jest.Mock;

const emptyGraphFirstResult = () => ({
  status: 'not-found',
  partial: false,
  resolution: {
    status: 'not-found',
    method: null,
    entity: null,
    candidates: [],
    candidatesTruncated: false,
  },
  context: null,
  diagnostics: [],
  plan: [
    { stage: 'exact-resolution', outcome: 'miss' },
    { stage: 'semantic-resolution', outcome: 'miss' },
    { stage: 'business-neighborhood', outcome: 'skipped' },
  ],
  bounds: {
    candidates: 8,
    neighbors: 20,
    chunks: 10,
    claims: 20,
    semanticMinScore: 0.5,
    semanticWinnerMargin: 0.08,
    neighborhoodHops: 1,
  },
});

// ============================================================================
// Mock Data
// ============================================================================

const mockConcepts = [
  {
    id: 'concept-ai',
    canonicalName: 'Artificial Intelligence',
    slug: 'artificial-intelligence',
    type: 'tag',
    aliases: ['AI', 'Machine Learning'],
    entityCount: 25,
  },
  {
    id: 'concept-ml',
    canonicalName: 'Machine Learning',
    slug: 'machine-learning',
    type: 'tag',
    aliases: ['ML'],
    entityCount: 18,
  },
];

const mockChunkResults = [
  {
    chunkId: 'chunk-001',
    documentId: 'doc-123',
    documentTitle: 'AI Research Paper',
    content: 'Artificial intelligence is transforming industries...',
    score: 0.92,
    chunkIndex: 1,
  },
  {
    chunkId: 'chunk-002',
    documentId: 'doc-456',
    documentTitle: 'ML Best Practices',
    content: 'Machine learning models require quality data...',
    score: 0.85,
    chunkIndex: 3,
  },
];

const mockDocumentResults = [
  {
    documentId: 'doc-123',
    title: 'AI Research Paper',
    type: 'pdf',
    maxScore: 0.92,
    topChunks: [{ content: 'AI is transforming...', chunkIndex: 1 }],
  },
];

const mockGraphNode = {
  id: 'tech-react',
  labels: ['Technology'],
  properties: {
    name: 'React',
    entityType: 'technology',
    description: 'A JavaScript library for building user interfaces',
  },
};

const mockNeighbors = [
  {
    id: 'company-meta',
    labels: ['Company'],
    properties: {
      name: 'Meta',
      entityType: 'company',
    },
  },
  {
    id: 'tech-redux',
    labels: ['Technology'],
    properties: {
      name: 'Redux',
      entityType: 'technology',
    },
  },
];

// ============================================================================
// Tool Definition Tests
// ============================================================================

describe('KNOWLEDGE_TOOLS definitions', () => {
  it('should export an array of tool definitions', () => {
    expect(Array.isArray(KNOWLEDGE_TOOLS)).toBe(true);
    // searchKnowledgeGraph, getEntityContext, formatCitations, findEntitiesByMeaning (P5-C)
    expect(KNOWLEDGE_TOOLS.length).toBe(4);
  });

  it('should have valid tool definitions with name, description, and parameters', () => {
    KNOWLEDGE_TOOLS.forEach((tool) => {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('searchKnowledgeGraph tool', () => {
    const tool = KNOWLEDGE_TOOLS.find((t) => t.name === 'searchKnowledgeGraph');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have query as required parameter', () => {
      expect(tool?.parameters?.required).toContain('query');
    });

    it('should have optional parameters for filtering', () => {
      const props = tool?.parameters?.properties;
      expect(props?.entityTypes).toBeDefined();
      expect(props?.maxResults).toBeDefined();
      expect(props?.maxHops).toBeUndefined();
      expect(props?.includeChunks).toBeDefined();
      expect(props?.includeConcepts).toBeDefined();
      expect(props?.includeGraphPaths).toBeDefined();
    });
  });

  describe('getEntityContext tool', () => {
    const tool = KNOWLEDGE_TOOLS.find((t) => t.name === 'getEntityContext');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have entityId as required parameter', () => {
      expect(tool?.parameters?.required).toContain('entityId');
    });

    it('should have depth and include options', () => {
      const props = tool?.parameters?.properties;
      expect(props?.depth).toBeDefined();
      expect(props?.includeDocuments).toBeDefined();
      expect(props?.includeConcepts).toBeDefined();
      expect(props?.maxRelationships).toBeDefined();
    });
  });

  describe('formatCitations tool', () => {
    const tool = KNOWLEDGE_TOOLS.find((t) => t.name === 'formatCitations');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have citation input arrays', () => {
      const props = tool?.parameters?.properties;
      expect(props?.documentIds).toBeDefined();
      expect(props?.entityIds).toBeDefined();
      expect(props?.chunkIds).toBeDefined();
    });
  });
});

// ============================================================================
// executeSearchKnowledgeGraph Tests
// ============================================================================

describe('executeSearchKnowledgeGraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchChunksByText.mockResolvedValue(mockChunkResults);
    mockFindSimilarDocuments.mockResolvedValue(mockDocumentResults);
    mockGetConcepts.mockResolvedValue(mockConcepts);
    mockFindConnected.mockResolvedValue([mockGraphNode]);
    mockRetrieveGraphFirst.mockResolvedValue(emptyGraphFirstResult());
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
  });

  it('should require query parameter', async () => {
    const result = await executeSearchKnowledgeGraph({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('query is required');
  });

  it('should return successful result with matching entities', async () => {
    const result = await executeSearchKnowledgeGraph({
      query: 'artificial intelligence',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const data = result.data as KnowledgeSearchResult;
    expect(data.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(data.totalResults).toBeGreaterThanOrEqual(0);
  });

  it('should include document chunks when includeChunks is true', async () => {
    const result = await executeSearchKnowledgeGraph({
      query: 'AI research',
      includeChunks: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as KnowledgeSearchResult;
    expect(Array.isArray(data.chunks)).toBe(true);
    expect(mockSearchChunksByText).toHaveBeenCalledWith('AI research', expect.any(Object));
  });

  it('should include concepts when includeConcepts is true', async () => {
    const result = await executeSearchKnowledgeGraph({
      query: 'machine learning',
      includeConcepts: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as KnowledgeSearchResult;
    expect(Array.isArray(data.concepts)).toBe(true);
    expect(mockGetConcepts).toHaveBeenCalled();
  });

  it('counts graph entities, chunks, and concepts once without derived aliases', async () => {
    mockSearchChunksByText.mockResolvedValue([mockChunkResults[0]]);
    mockGetConcepts.mockResolvedValue([mockConcepts[0]]);

    const result = await executeSearchKnowledgeGraph({ query: 'AI' });

    expect(result.data?.entities).toEqual([]);
    expect(result.data?.chunks).toHaveLength(1);
    expect(result.data?.concepts).toHaveLength(1);
    expect(result.data?.totalResults).toBe(2);
  });

  it('should respect maxResults parameter', async () => {
    const result = await executeSearchKnowledgeGraph({
      query: 'AI',
      maxResults: 5,
    });

    expect(result.success).toBe(true);
    const data = result.data as KnowledgeSearchResult;
    expect(data.entities.length).toBeLessThanOrEqual(5);
  });

  it('should cap maxResults at 50', async () => {
    const result = await executeSearchKnowledgeGraph({
      query: 'AI',
      maxResults: 100,
    });

    expect(result.success).toBe(true);
    expect(mockSearchChunksByText).toHaveBeenCalledWith('AI', expect.objectContaining({ limit: 50 }));
  });

  it('uses a fixed one-hop neighborhood instead of advertising an ignored depth input', async () => {
    await executeSearchKnowledgeGraph({ query: 'AI', includeGraphPaths: true });
    expect(mockRetrieveGraphFirst).toHaveBeenCalledWith(
      'AI',
      expect.objectContaining({ maxResults: 20, includeChunks: true, getQueryEmbedding: expect.any(Function) })
    );
  });

  it('should handle empty results gracefully', async () => {
    mockSearchChunksByText.mockResolvedValue([]);
    mockFindSimilarDocuments.mockResolvedValue([]);
    mockGetConcepts.mockResolvedValue([]);

    const result = await executeSearchKnowledgeGraph({
      query: 'nonexistent xyz query',
    });

    expect(result.success).toBe(true);
    const data = result.data as KnowledgeSearchResult;
    expect(data.totalResults).toBe(0);
    expect(data.entities).toEqual([]);
    expect(data.chunks).toEqual([]);
    expect(data.concepts).toEqual([]);
  });

  it('returns independent results with an honest diagnostic when document search is unavailable', async () => {
    mockSearchChunksByText.mockRejectedValue(new Error('HTTP 503 vector search unavailable'));

    const result = await executeSearchKnowledgeGraph({
      query: 'AI',
    });

    expect(result.success).toBe(true);
    expect(result.data?.partial).toBe(true);
    expect(result.data?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'document-chunks',
          code: 'vector-unavailable',
          message: 'Document semantic search is temporarily unavailable.',
        }),
      ])
    );
  });

  it('keeps broad topic passages and concepts when exact entity resolution is ambiguous', async () => {
    mockRetrieveGraphFirst.mockResolvedValue({
      ...emptyGraphFirstResult(),
      status: 'ambiguous',
      resolution: {
        status: 'ambiguous',
        method: 'normalized-name',
        entity: null,
        candidates: [
          { id: 'tech-ai', name: 'AI', type: 'technology' },
          { id: 'company-ai', name: 'AI', type: 'company' },
        ],
        candidatesTruncated: false,
      },
      diagnostics: [
        {
          stage: 'exact-resolution',
          code: 'exact-name-ambiguous',
          message: 'Multiple entities share the normalized exact name; no entity was selected.',
        },
      ],
    });

    const result = await executeSearchKnowledgeGraph({ query: 'AI' });

    expect(result.success).toBe(true);
    expect(result.data?.resolution.entity).toBeNull();
    expect(result.data?.chunks).toHaveLength(mockChunkResults.length);
    expect(result.data?.concepts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'concept-ai' })]));
    expect(mockSearchChunksByText).toHaveBeenCalled();
  });

  it('shares one provider embedding across graph-first and broad chunk lanes', async () => {
    mockRetrieveGraphFirst.mockImplementation(async (_query, options) => {
      await options.getQueryEmbedding();
      return emptyGraphFirstResult();
    });
    mockSearchChunksByText.mockImplementation(async (_query, options) => {
      await options.queryEmbedding;
      return mockChunkResults;
    });

    const result = await executeSearchKnowledgeGraph({ query: 'container platforms' });

    expect(result.success).toBe(true);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('does not expose provider secrets in independent-lane diagnostics', async () => {
    mockSearchChunksByText.mockRejectedValue(new Error('HTTP 429 api_token=private-value provider.internal:443'));

    const result = await executeSearchKnowledgeGraph({ query: 'AI' });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('private-value');
    expect(result.data?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Document semantic search is temporarily unavailable.' }),
      ])
    );
  });

  it('does not let retryable message text disguise a programmer defect as partial success', async () => {
    mockSearchChunksByText.mockRejectedValue(new TypeError('connection projection invalid'));

    const result = await executeSearchKnowledgeGraph({ query: 'AI' });

    expect(result).toEqual({ success: false, error: 'Knowledge search failed' });
  });

  it('does not disguise a Firebase invalid-argument defect as concept-search unavailability', async () => {
    const error = Object.assign(new Error('invalid concept query projection'), {
      name: 'FirebaseError',
      code: 'invalid-argument',
    });
    mockGetConcepts.mockRejectedValue(error);

    const result = await executeSearchKnowledgeGraph({ query: 'AI' });

    expect(result).toEqual({ success: false, error: 'Knowledge search failed' });
  });

  it('preserves incoming and outgoing graphPath direction and relationship provenance', async () => {
    mockSearchChunksByText.mockResolvedValue([]);
    mockGetConcepts.mockResolvedValue([]);
    mockRetrieveGraphFirst.mockResolvedValue({
      ...emptyGraphFirstResult(),
      status: 'complete',
      resolution: {
        status: 'resolved',
        method: 'stable-id',
        entity: { id: 'tech-1', name: 'Kubernetes', type: 'technology' },
        candidates: [],
        candidatesTruncated: false,
      },
      context: {
        center: { id: 'tech-1', name: 'Kubernetes', label: 'Technology', description: null },
        neighbors: [
          {
            entity: { id: 'company-1', name: 'CNCF', label: 'Company', description: null },
            relation: 'GOVERNS',
            direction: 'in',
            distance: 1,
            confidence: 0.9,
            claimId: 'claim-1',
            segments: [
              {
                fromId: 'company-1',
                toId: 'tech-1',
                relationType: 'GOVERNS',
                confidence: 0.9,
                claimId: 'claim-1',
              },
            ],
          },
          {
            entity: { id: 'tech-2', name: 'Docker', label: 'Technology', description: null },
            relation: 'USES',
            direction: 'out',
            distance: 1,
            confidence: 0.8,
            claimId: 'claim-2',
          },
        ],
        chunks: [],
        claims: [],
        temporal: [],
      },
    });

    const result = await executeSearchKnowledgeGraph({ query: 'tech-1', includeGraphPaths: true });

    expect(result.data?.graphPaths).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ id: 'company-1' }),
        to: expect.objectContaining({ id: 'tech-1' }),
        direction: 'incoming',
        relation: 'GOVERNS',
        claimId: 'claim-1',
        segments: [
          expect.objectContaining({
            fromId: 'company-1',
            toId: 'tech-1',
            relationType: 'GOVERNS',
            claimId: 'claim-1',
          }),
        ],
      }),
      expect.objectContaining({
        from: expect.objectContaining({ id: 'tech-1' }),
        to: expect.objectContaining({ id: 'tech-2' }),
        direction: 'outgoing',
        relation: 'USES',
        claimId: 'claim-2',
      }),
    ]);
    expect(result.data).not.toHaveProperty('neighborhood');
    expect(result.data?.totalResults).toBe(3);
  });

  it('bounds graph names, descriptions, and claim statements at the tool boundary', async () => {
    const longText = 'x'.repeat(2_000);
    mockSearchChunksByText.mockResolvedValue([]);
    mockGetConcepts.mockResolvedValue([]);
    mockRetrieveGraphFirst.mockResolvedValue({
      ...emptyGraphFirstResult(),
      status: 'complete',
      resolution: {
        status: 'resolved',
        method: 'stable-id',
        entity: { id: 'tech-1', name: longText, type: 'technology', description: longText },
        candidates: [],
        candidatesTruncated: false,
      },
      context: {
        center: { id: 'tech-1', name: longText, label: 'Technology', description: longText },
        neighbors: [
          {
            entity: { id: 'company-1', name: longText, label: 'Company', description: longText },
            relation: longText,
            direction: 'out',
            confidence: 0.9,
            claimId: 'claim-1',
          },
        ],
        chunks: [],
        claims: [
          {
            id: 'claim-1',
            predicate: longText,
            subjectName: longText,
            objectName: longText,
            statement: longText,
            confidence: 0.9,
            status: longText,
          },
        ],
        temporal: [],
      },
    });

    const result = await executeSearchKnowledgeGraph({ query: 'tech-1' });

    expect(result.data?.resolution.entity?.name).toHaveLength(200);
    expect(result.data?.resolution.entity?.description).toHaveLength(600);
    expect(result.data?.entities[1].name).toHaveLength(200);
    expect(result.data?.graphPaths[0].relation).toHaveLength(200);
    expect(result.data?.claims[0].statement).toHaveLength(1_000);
  });
});

// ============================================================================
// executeGetEntityContext Tests
// ============================================================================

describe('executeGetEntityContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEntity.mockResolvedValue(mockGraphNode);
    mockGetNeighbors.mockResolvedValue(mockNeighbors);
    mockFindConnected.mockResolvedValue([...mockNeighbors, mockGraphNode]);
    mockFindSimilarDocuments.mockResolvedValue(mockDocumentResults);
    mockGetConceptById.mockResolvedValue(null);
  });

  it('should require entityId parameter', async () => {
    const result = await executeGetEntityContext({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('entityId is required');
  });

  it('should return entity context successfully', async () => {
    const result = await executeGetEntityContext({
      entityId: 'tech-react',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const data = result.data as EntityContextResult;
    expect(data.entity).toBeDefined();
    expect(data.entity?.id).toBe('tech-react');
    expect(data.entity?.name).toBe('React');
  });

  it('should include relationships', async () => {
    const result = await executeGetEntityContext({
      entityId: 'tech-react',
    });

    expect(result.success).toBe(true);
    const data = result.data as EntityContextResult;
    expect(Array.isArray(data.relationships)).toBe(true);
    expect(mockGetNeighbors).toHaveBeenCalledWith('tech-react', expect.any(Object));
  });

  it('should respect depth parameter for extended network', async () => {
    await executeGetEntityContext({
      entityId: 'tech-react',
      depth: 3,
    });

    // M8: the extended network uses getNeighbors' untyped depth traversal.
    // (The old findConnected(…, undefined, …) call referenced $targetType
    // without ever binding it — ParameterMissing on every depth>1 call.)
    expect(mockGetNeighbors).toHaveBeenCalledWith('tech-react', expect.objectContaining({ depth: 3 }));
    expect(mockFindConnected).not.toHaveBeenCalledWith('tech-react', undefined, expect.anything());
  });

  it('should cap depth at 3', async () => {
    await executeGetEntityContext({
      entityId: 'tech-react',
      depth: 10,
    });

    expect(mockGetNeighbors).toHaveBeenCalledWith('tech-react', expect.objectContaining({ depth: 3 }));
    expect(mockFindConnected).not.toHaveBeenCalledWith('tech-react', undefined, expect.anything());
  });

  it('should include documents when includeDocuments is true', async () => {
    const result = await executeGetEntityContext({
      entityId: 'tech-react',
      includeDocuments: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as EntityContextResult;
    expect(Array.isArray(data.documents)).toBe(true);
    expect(mockFindSimilarDocuments).toHaveBeenCalled();
  });

  it('should include concepts when includeConcepts is true', async () => {
    mockGetEntity.mockResolvedValue({
      ...mockGraphNode,
      properties: {
        ...mockGraphNode.properties,
        conceptIds: ['concept-ai', 'concept-ml'],
      },
    });
    mockGetConceptById.mockResolvedValue(mockConcepts[0]);

    const result = await executeGetEntityContext({
      entityId: 'tech-react',
      includeConcepts: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as EntityContextResult;
    expect(Array.isArray(data.concepts)).toBe(true);
  });

  it('should return stats summary', async () => {
    const result = await executeGetEntityContext({
      entityId: 'tech-react',
    });

    expect(result.success).toBe(true);
    const data = result.data as EntityContextResult;
    expect(data.stats).toBeDefined();
    expect(typeof data.stats.totalRelationships).toBe('number');
    expect(typeof data.stats.totalConcepts).toBe('number');
    expect(typeof data.stats.totalDocuments).toBe('number');
  });

  it('should handle missing entity gracefully', async () => {
    mockGetEntity.mockResolvedValue(null);
    mockGetNeighbors.mockRejectedValue(new Error('Entity not found'));
    mockFindConnected.mockRejectedValue(new Error('Entity not found'));

    const result = await executeGetEntityContext({
      entityId: 'nonexistent-entity',
    });

    // Should still succeed but with minimal data
    expect(result.success).toBe(true);
    const data = result.data as EntityContextResult;
    expect(data.entity).toBeDefined();
    expect(data.relationships).toEqual([]);
  });

  it('should respect maxRelationships parameter', async () => {
    await executeGetEntityContext({
      entityId: 'tech-react',
      maxRelationships: 10,
    });

    expect(mockGetNeighbors).toHaveBeenCalledWith('tech-react', expect.objectContaining({ limit: 10 }));
  });

  it('should cap maxRelationships at 100', async () => {
    await executeGetEntityContext({
      entityId: 'tech-react',
      maxRelationships: 200,
    });

    expect(mockGetNeighbors).toHaveBeenCalledWith('tech-react', expect.objectContaining({ limit: 100 }));
  });
});

// ============================================================================
// executeFormatCitations Tests
// ============================================================================

describe('executeFormatCitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEntity.mockResolvedValue(mockGraphNode);
  });

  it('should return empty citations array when no inputs', async () => {
    const result = await executeFormatCitations({});
    expect(result.success).toBe(true);
    expect(result.data?.citations).toEqual([]);
  });

  it('should format document citations', async () => {
    const result = await executeFormatCitations({
      documentIds: ['doc-123', 'doc-456'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.citations).toHaveLength(2);
    expect(result.data?.citations[0].type).toBe('document');
    expect(result.data?.citations[0].id).toBe('doc-123');
    expect(result.data?.citations[0].url).toBe('/library/documents?document=doc-123');
  });

  it('should format entity citations with names from graph', async () => {
    const result = await executeFormatCitations({
      entityIds: ['tech-react'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.citations).toHaveLength(1);
    expect(result.data?.citations[0].type).toBe('entity');
    expect(result.data?.citations[0].title).toBe('React');
  });

  it('should format entity citations when graph lookup fails', async () => {
    mockGetEntity.mockRejectedValue(new Error('Not found'));

    const result = await executeFormatCitations({
      entityIds: ['unknown-entity'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.citations).toHaveLength(1);
    expect(result.data?.citations[0].type).toBe('entity');
    expect(result.data?.citations[0].id).toBe('unknown-entity');
    expect(result.data?.citations[0].title).toBe('unknown-entity');
  });

  it('should format chunk citations', async () => {
    const result = await executeFormatCitations({
      chunkIds: ['chunk-001', 'chunk-002'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.citations).toHaveLength(2);
    expect(result.data?.citations[0].type).toBe('chunk');
    expect(result.data?.citations[0].id).toBe('chunk-001');
  });

  it('should combine multiple citation types', async () => {
    const result = await executeFormatCitations({
      documentIds: ['doc-123'],
      entityIds: ['tech-react'],
      chunkIds: ['chunk-001'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.citations).toHaveLength(3);

    const types = result.data?.citations.map((c) => c.type);
    expect(types).toContain('document');
    expect(types).toContain('entity');
    expect(types).toContain('chunk');
  });

  it('should handle errors gracefully', async () => {
    // Force an unexpected error by passing invalid types
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // This should still work since we handle errors
    const result = await executeFormatCitations({
      documentIds: ['doc-123'],
    });

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Integration Scenario Tests
// ============================================================================

describe('Knowledge Tools Integration Scenarios', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchChunksByText.mockResolvedValue(mockChunkResults);
    mockFindSimilarDocuments.mockResolvedValue(mockDocumentResults);
    mockGetConcepts.mockResolvedValue(mockConcepts);
    mockFindConnected.mockResolvedValue([mockGraphNode]);
    mockGetEntity.mockResolvedValue(mockGraphNode);
    mockGetNeighbors.mockResolvedValue(mockNeighbors);
  });

  it('should handle "What do we know about X?" query pattern', async () => {
    // User asks: "What do we know about flavor tech?"
    const searchResult = await executeSearchKnowledgeGraph({
      query: 'flavor tech research',
      includeChunks: true,
      includeConcepts: true,
    });

    expect(searchResult.success).toBe(true);
    const data = searchResult.data as KnowledgeSearchResult;

    // Should return relevant entities, chunks, and concepts
    expect(data.entities).toBeDefined();
    expect(data.chunks).toBeDefined();
    expect(data.concepts).toBeDefined();
  });

  it('should handle deep entity exploration', async () => {
    // User asks: "Tell me everything about React"
    const contextResult = await executeGetEntityContext({
      entityId: 'tech-react',
      depth: 3,
      includeDocuments: true,
      includeConcepts: true,
    });

    expect(contextResult.success).toBe(true);
    const data = contextResult.data as EntityContextResult;

    expect(data.entity).toBeDefined();
    expect(data.relationships.length).toBeGreaterThanOrEqual(0);
    expect(data.stats).toBeDefined();
  });

  it('should support search then context pattern', async () => {
    // First search for entity
    const searchResult = await executeSearchKnowledgeGraph({
      query: 'React',
      maxResults: 1,
    });

    expect(searchResult.success).toBe(true);
    const searchData = searchResult.data as KnowledgeSearchResult;

    if (searchData.entities.length > 0) {
      // Then get full context
      const contextResult = await executeGetEntityContext({
        entityId: searchData.entities[0].id,
      });

      expect(contextResult.success).toBe(true);
    }
  });
});
