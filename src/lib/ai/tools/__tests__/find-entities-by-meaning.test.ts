/**
 * @file find-entities-by-meaning.test.ts
 * @description Tests for the findEntitiesByMeaning AI tool (P5-C, H8).
 *
 * The tool is a thin honest boundary over
 * `searchEntitiesBySemantic` (src/lib/graph/vector-search.ts): it executes
 * the vector query for the user's natural-language text, maps the label
 * filter, passes the degraded flag through instead of masking an absent
 * index as "no matches", and reports a missing Gemini key as an error.
 */

jest.mock('@/lib/graph', () => ({
  searchChunksByText: jest.fn(),
  findSimilarDocuments: jest.fn(),
  getNeighbors: jest.fn(),
  findConnected: jest.fn(),
  findPath: jest.fn(),
  getEntity: jest.fn(),
  searchEntitiesBySemantic: jest.fn(),
}));
jest.mock('@/lib/concept-admin', () => ({
  adminGetConcepts: jest.fn(),
  adminGetConceptById: jest.fn(),
}));
jest.mock('@/lib/entity-links', () => ({
  getEntityUrl: jest.fn(() => '/library'),
}));

import * as graph from '@/lib/graph';
import { executeFindEntitiesByMeaning, KNOWLEDGE_TOOLS } from '../knowledge-tools';

const mockedSemanticSearch = (graph as unknown as { searchEntitiesBySemantic: jest.Mock }).searchEntitiesBySemantic;

describe('findEntitiesByMeaning tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSemanticSearch.mockResolvedValue({ results: [], degraded: false });
  });

  it('is declared in KNOWLEDGE_TOOLS with a required query parameter', () => {
    const decl = KNOWLEDGE_TOOLS.find((t) => t.name === 'findEntitiesByMeaning');
    expect(decl).toBeDefined();
    expect(decl?.parameters?.required).toContain('query');
  });

  it('executes the semantic vector query for the given text', async () => {
    mockedSemanticSearch.mockResolvedValue({
      results: [
        { id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: 'Container orchestration', score: 0.91 },
      ],
      degraded: false,
    });

    const result = await executeFindEntitiesByMeaning({ query: 'container orchestration platforms' });

    expect(result.success).toBe(true);
    expect(mockedSemanticSearch).toHaveBeenCalledWith(
      'container orchestration platforms',
      'all',
      expect.objectContaining({ limit: expect.any(Number), minScore: expect.any(Number) })
    );
    expect(result.data?.matches).toHaveLength(1);
    expect(result.data?.matches[0]).toMatchObject({ id: 'tech-1', label: 'Technology', score: 0.91 });
    expect(result.data?.degraded).toBe(false);
  });

  it('maps the entityType filter to the graph label', async () => {
    await executeFindEntitiesByMeaning({ query: 'ai research labs', entityType: 'company', limit: 5 });

    expect(mockedSemanticSearch).toHaveBeenCalledWith(
      'ai research labs',
      'Company',
      expect.objectContaining({ limit: 5 })
    );
  });

  it('rejects an unknown entityType instead of silently searching everything', async () => {
    const result = await executeFindEntitiesByMeaning({ query: 'x', entityType: 'radar' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entityType/i);
    expect(mockedSemanticSearch).not.toHaveBeenCalled();
  });

  it('requires a query', async () => {
    const result = await executeFindEntitiesByMeaning({});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/i);
    expect(mockedSemanticSearch).not.toHaveBeenCalled();
  });

  it('passes the degraded flag through when the vector index is absent (honest degradation)', async () => {
    mockedSemanticSearch.mockResolvedValue({
      results: [],
      degraded: true,
      degradedReason: 'technology_embedding unavailable: There is no such vector schema index',
    });

    const result = await executeFindEntitiesByMeaning({ query: 'q' });

    expect(result.success).toBe(true);
    expect(result.data?.matches).toEqual([]);
    expect(result.data?.degraded).toBe(true);
    expect(result.data?.degradedReason).toContain('technology_embedding');
  });

  it('reports a missing Gemini key as an honest error, not an empty result', async () => {
    mockedSemanticSearch.mockRejectedValue(
      new Error('Google AI API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY')
    );

    const result = await executeFindEntitiesByMeaning({ query: 'q' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/API key/i);
  });

  // AUDIT-020. Note the contrast with the missing-index case directly above,
  // which is CORRECTLY a `success: true, degraded: true` empty. A dead backend
  // is not an empty result set — nothing was searched — and handing the model
  // `success: true, matches: []` invites it to tell the user "I found no
  // matching entities", which is a fabrication.
  it('reports an unreachable graph backend as an error, not as zero matches', async () => {
    mockedSemanticSearch.mockResolvedValue({
      results: [],
      degraded: true,
      degradedReason: 'technology_embedding unavailable: ECONNREFUSED',
      unavailable: true,
    });

    const result = await executeFindEntitiesByMeaning({ query: 'q' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.data).toBeUndefined();
  });
});
