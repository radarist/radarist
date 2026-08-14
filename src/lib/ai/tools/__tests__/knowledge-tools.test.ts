/**
 * @file knowledge-tools.test.ts
 * @description Tests for executeGetEntityContext.
 *
 * M8 regression: the depth>1 branch called
 * `findConnected(entityId, undefined, { maxDepth })` — the generated Cypher
 * referenced `$targetType` but the driver received `undefined`, so EVERY
 * depth-2 (the default!) call threw ParameterMissing, a bare catch swallowed
 * it, and the tool silently degraded to 1-hop context.
 */

jest.mock('@/lib/graph', () => ({
  searchChunksByText: jest.fn(),
  findSimilarDocuments: jest.fn(),
  fetchDocumentsForEntity: jest.fn(),
  getNeighbors: jest.fn(),
  findConnected: jest.fn(),
  findPath: jest.fn(),
  getEntity: jest.fn(),
  // AI-026: NOT stubbed — the reported entity type must come from the real
  // canonical-label derivation, not a mock's opinion.
  businessEntityGraphType: jest.requireActual('@/lib/graph/business-entity-identity')
    .businessEntityGraphType,
}));
jest.mock('@/lib/graph/service-factory', () => ({
  getGraphMode: jest.fn(async () => ({ mode: 'neo4j' })),
}));
jest.mock('@/lib/concept-admin', () => ({
  adminGetConcepts: jest.fn(),
  adminGetConceptById: jest.fn(),
}));
jest.mock('@/lib/entity-links', () => ({
  getEntityUrl: jest.fn(() => '/library'),
}));

import * as graph from '@/lib/graph';
import { executeGetEntityContext } from '../knowledge-tools';

const mockGetEntity = graph.getEntity as jest.Mock;
const mockGetNeighbors = graph.getNeighbors as jest.Mock;
const mockFindConnected = graph.findConnected as jest.Mock;
const mockFindSimilarDocuments = graph.findSimilarDocuments as jest.Mock;
const mockFetchDocumentsForEntity = graph.fetchDocumentsForEntity as jest.Mock;

const node = (id: string, name: string, entityType = 'technology') => ({
  id,
  labels: ['Entity'],
  properties: { name, entityType },
});

describe('executeGetEntityContext (M8 — depth>1 must not silently degrade to 1-hop)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEntity.mockResolvedValue(node('tech-1', 'Kubernetes'));
    mockFindSimilarDocuments.mockResolvedValue([]);
    mockFetchDocumentsForEntity.mockResolvedValue([]);
    // Real-seam behavior: findConnected REQUIRES a target type. Calling it
    // with undefined reproduces the driver's ParameterMissing error.
    mockFindConnected.mockImplementation(async (_id: string, targetType: unknown) => {
      if (targetType === undefined) {
        throw new Error('Expected parameter(s): targetType');
      }
      return [];
    });
    // Depth-aware neighbor traversal: 1-hop returns the direct neighbor,
    // depth-2 additionally reaches the 2-hop node.
    mockGetNeighbors.mockImplementation(async (_id: string, options?: { depth?: number }) => {
      if ((options?.depth ?? 1) > 1) {
        return [node('tech-2', 'Docker'), node('org-9', 'Platform Team', 'orgUnit')];
      }
      return [node('tech-2', 'Docker')];
    });
  });

  it('returns the extended (2-hop) network for the default depth of 2', async () => {
    const result = await executeGetEntityContext({ entityId: 'tech-1' });

    expect(result.success).toBe(true);
    const targetIds = result.data!.relationships.map((r) => r.targetId);
    expect(targetIds).toContain('tech-2');
    // The 2-hop entity must be present — pre-fix it silently vanished
    expect(targetIds).toContain('org-9');
    const extended = result.data!.relationships.find((r) => r.targetId === 'org-9');
    expect(extended?.distance).toBe(2);
  });

  it('never calls findConnected with an undefined targetType', async () => {
    await executeGetEntityContext({ entityId: 'tech-1', depth: 3 });

    for (const call of mockFindConnected.mock.calls) {
      expect(call[1]).toBeDefined();
    }
  });

  it('depth 1 skips the extended-network traversal', async () => {
    const result = await executeGetEntityContext({ entityId: 'tech-1', depth: 1 });

    expect(result.success).toBe(true);
    const targetIds = result.data!.relationships.map((r) => r.targetId);
    expect(targetIds).toEqual(['tech-2']);
  });

  it('deduplicates entities already present from the direct-neighbor pass', async () => {
    const result = await executeGetEntityContext({ entityId: 'tech-1', depth: 2 });

    const dockerEntries = result.data!.relationships.filter((r) => r.targetId === 'tech-2');
    expect(dockerEntries).toHaveLength(1);
  });
});

// ============================================================================
// Task 13 / A3 — getEntityContext grounds documents via the graph
//
// The tool declaration promises "documents that mention/cite the entity",
// but the executor previously used name-vector similarity only — the
// graph's 1700+ MENTIONS edges were never read. Graph enumeration
// (fetchDocumentsForEntity) now runs first; vector fills remaining slots.
// ============================================================================

describe('executeGetEntityContext — document grounding (Task 13 / A3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEntity.mockResolvedValue(node('tech-1', 'Kubernetes'));
    mockFindConnected.mockResolvedValue([]);
    mockGetNeighbors.mockResolvedValue([]);
  });

  it('grounds documents from the graph first, tagged source:graph with mentionCount', async () => {
    mockFetchDocumentsForEntity.mockResolvedValue([
      { documentId: 'doc-1', title: 'Doc One', type: 'article', mentionCount: 4, snippets: ['snippet a'] },
    ]);
    mockFindSimilarDocuments.mockResolvedValue([]);

    const result = await executeGetEntityContext({ entityId: 'tech-1' });

    expect(result.success).toBe(true);
    expect(result.data!.documents).toHaveLength(1);
    expect(result.data!.documents[0]).toMatchObject({
      documentId: 'doc-1',
      title: 'Doc One',
      type: 'article',
      source: 'graph',
      mentionCount: 4,
    });
    expect(mockFetchDocumentsForEntity).toHaveBeenCalledWith('tech-1', expect.objectContaining({ limit: 5 }));
  });

  it('fills remaining slots from vector fallback, deduped by documentId and tagged source:vector', async () => {
    mockFetchDocumentsForEntity.mockResolvedValue([
      { documentId: 'doc-1', title: 'Doc One', type: 'article', mentionCount: 2, snippets: [] },
    ]);
    mockFindSimilarDocuments.mockResolvedValue([
      {
        documentId: 'doc-1',
        title: 'Doc One (vector dup)',
        type: 'article',
        avgScore: 0.9,
        maxScore: 0.9,
        matchingChunks: 1,
        topChunks: [{ content: 'dup snippet', score: 0.9, chunkIndex: 0 }],
      },
      {
        documentId: 'doc-2',
        title: 'Doc Two',
        type: 'report',
        avgScore: 0.8,
        maxScore: 0.8,
        matchingChunks: 1,
        topChunks: [{ content: 'vector-only snippet', score: 0.8, chunkIndex: 0 }],
      },
    ]);

    const result = await executeGetEntityContext({ entityId: 'tech-1' });

    expect(result.data!.documents.map((d) => d.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(result.data!.documents[0].source).toBe('graph');
    expect(result.data!.documents[1].source).toBe('vector');
  });

  it('falls back to vector-only when graph enumeration throws', async () => {
    mockFetchDocumentsForEntity.mockRejectedValue(new Error('neo4j down'));
    mockFindSimilarDocuments.mockResolvedValue([
      {
        documentId: 'doc-9',
        title: 'Vector Doc',
        type: 'article',
        avgScore: 0.7,
        maxScore: 0.7,
        matchingChunks: 1,
        topChunks: [{ content: 'vec only', score: 0.7, chunkIndex: 0 }],
      },
    ]);

    const result = await executeGetEntityContext({ entityId: 'tech-1' });

    expect(result.success).toBe(true);
    expect(result.data!.documents).toHaveLength(1);
    expect(result.data!.documents[0]).toMatchObject({ documentId: 'doc-9', source: 'vector' });
  });

  it('caps documents at 5 total', async () => {
    mockFetchDocumentsForEntity.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        documentId: `graph-doc-${i}`,
        title: `Graph Doc ${i}`,
        type: 'article',
        mentionCount: 1,
        snippets: [],
      }))
    );
    mockFindSimilarDocuments.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        documentId: `vector-doc-${i}`,
        title: `Vector Doc ${i}`,
        type: 'article',
        avgScore: 0.7,
        maxScore: 0.7,
        matchingChunks: 1,
        topChunks: [],
      }))
    );

    const result = await executeGetEntityContext({ entityId: 'tech-1' });

    expect(result.data!.documents).toHaveLength(5);
  });
});
