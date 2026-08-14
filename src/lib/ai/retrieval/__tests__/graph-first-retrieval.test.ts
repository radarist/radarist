jest.mock('@/lib/ai/client', () => ({ generateEmbedding: jest.fn() }));

import { GraphUnavailableError } from '@/lib/graph/errors';
import { retrieveGraphFirst } from '../graph-first-retrieval';

type Dependencies = NonNullable<Parameters<typeof retrieveGraphFirst>[2]>;

const exactMiss = {
  status: 'not-found' as const,
  matchedBy: null,
  entity: null,
  candidates: [] as [],
  candidatesTruncated: false as const,
};

const exactEntity = (id = 'tech-1', name = 'Kubernetes') => ({
  id,
  name,
  entityType: 'technology',
  label: 'Technology',
  description: 'Container orchestration',
});

const context = (partial = false) => ({
  center: { id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: 'Container orchestration' },
  neighbors: [],
  chunks: [],
  claims: [],
  temporal: [],
  ...(partial
    ? {
        partial: true,
        diagnostics: [
          { stage: 'chunks.semantic' as const, code: 'unavailable' as const, message: 'Vector index unavailable.' },
        ],
      }
    : {}),
});

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    resolveExact: jest.fn().mockResolvedValue(exactMiss),
    searchSemantic: jest.fn().mockResolvedValue({ results: [], degraded: false, unavailable: false }),
    extractContext: jest.fn().mockResolvedValue(context()),
    ...overrides,
  };
}

describe('retrieveGraphFirst', () => {
  it('resolves a stable ID without semantic fallback and expands exactly one hop', async () => {
    const deps = dependencies({
      resolveExact: jest.fn().mockResolvedValue({
        status: 'resolved',
        matchedBy: 'stable-id',
        entity: exactEntity(),
        candidates: [],
        candidatesTruncated: false,
      }),
    });
    const embedding = Promise.resolve([0.1, 0.2]);

    const result = await retrieveGraphFirst(
      'tech-1',
      { maxResults: 500, getQueryEmbedding: () => embedding },
      deps
    );

    expect(result.status).toBe('complete');
    expect(result.resolution).toMatchObject({ status: 'resolved', method: 'stable-id', entity: { id: 'tech-1' } });
    expect(deps.searchSemantic).not.toHaveBeenCalled();
    expect(deps.extractContext).toHaveBeenCalledWith(
      'tech-1',
      expect.objectContaining({ neighbors: 25, chunks: 10, claims: 20, queryEmbedding: embedding })
    );
    expect(result.bounds.neighborhoodHops).toBe(1);
  });

  it('returns deterministic exact-name ambiguity without semantic fallback or traversal', async () => {
    const deps = dependencies({
      resolveExact: jest.fn().mockResolvedValue({
        status: 'ambiguous',
        matchedBy: 'normalized-name',
        entity: null,
        candidates: [exactEntity('tech-z', 'Atlas'), exactEntity('tech-a', 'ATLAS')],
        candidatesTruncated: false,
      }),
    });

    const result = await retrieveGraphFirst(' Atlas ', {}, deps);

    expect(result.status).toBe('ambiguous');
    expect(result.resolution.entity).toBeNull();
    expect(result.resolution.candidates.map((item) => item.id)).toEqual(['tech-a', 'tech-z']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ stage: 'exact-resolution', code: 'exact-name-ambiguous' }),
    ]);
    expect(deps.searchSemantic).not.toHaveBeenCalled();
    expect(deps.extractContext).not.toHaveBeenCalled();
  });

  it('uses one request-scoped embedding across semantic resolution and grounded chunks', async () => {
    const embedProvider = jest.fn().mockResolvedValue([0.3, 0.4]);
    let embedding: Promise<number[]> | undefined;
    const getQueryEmbedding = () => (embedding ??= embedProvider());
    let semanticEmbedding: number[] | Promise<number[]> | undefined;
    let contextEmbedding: number[] | Promise<number[]> | undefined;
    const deps = dependencies({
      searchSemantic: jest.fn(async (_query, _label, options) => {
        if (!options?.queryEmbedding) throw new Error('expected shared semantic embedding');
        semanticEmbedding = options.queryEmbedding;
        await semanticEmbedding;
        return {
          results: [
            { id: 'tech-1', label: 'Technology' as const, name: 'Kubernetes', description: null, score: 0.91 },
            { id: 'tech-2', label: 'Technology' as const, name: 'Nomad', description: null, score: 0.7 },
          ],
          degraded: false,
          unavailable: false,
        };
      }),
      extractContext: jest.fn(async (_id, options) => {
        if (!options?.queryEmbedding) throw new Error('expected shared context embedding');
        contextEmbedding = options.queryEmbedding;
        await contextEmbedding;
        return context();
      }),
    });

    const result = await retrieveGraphFirst(
      'container platforms',
      { entityTypes: ['technology'], getQueryEmbedding },
      deps
    );

    expect(result.resolution).toMatchObject({ status: 'resolved', method: 'semantic', entity: { id: 'tech-1' } });
    expect(semanticEmbedding).toBe(contextEmbedding);
    expect(embedProvider).toHaveBeenCalledTimes(1);
  });

  it('queries only requested indexed labels so Signal results cannot crowd out a multi-type scope', async () => {
    const embedding = Promise.resolve([0.3, 0.4]);
    const searchSemantic = jest.fn(async (_query, label, options) => {
      expect(options?.queryEmbedding).toBe(embedding);
      if (label === 'all') {
        return {
          results: Array.from({ length: 8 }, (_, index) => ({
            id: `signal-${index}`,
            label: 'Signal' as const,
            name: `Signal ${index}`,
            description: null,
            score: 0.99 - index / 100,
          })),
          degraded: false,
          unavailable: false,
        };
      }
      return {
        results:
          label === 'Technology'
            ? [{ id: 'tech-1', label, name: 'Kubernetes', description: null, score: 0.93 }]
            : [{ id: 'company-1', label, name: 'CNCF', description: null, score: 0.72 }],
        degraded: false,
        unavailable: false,
      };
    });
    const deps = dependencies({ searchSemantic });

    const result = await retrieveGraphFirst(
      'container platform',
      { entityTypes: ['technology', 'company'], getQueryEmbedding: () => embedding },
      deps
    );

    expect(searchSemantic.mock.calls.map((call) => call[1])).toEqual(['Technology', 'Company']);
    expect(searchSemantic).not.toHaveBeenCalledWith('container platform', 'all', expect.anything());
    expect(result.resolution).toMatchObject({ status: 'resolved', entity: { id: 'tech-1' } });
    expect(deps.extractContext).toHaveBeenCalledTimes(1);
  });

  it('does not guess when semantic candidates fall within the winner margin', async () => {
    const deps = dependencies({
      searchSemantic: jest.fn().mockResolvedValue({
        results: [
          { id: 'tech-b', label: 'Technology', name: 'Beta', description: null, score: 0.9 },
          { id: 'tech-a', label: 'Technology', name: 'Alpha', description: null, score: 0.85 },
        ],
        degraded: false,
        unavailable: false,
      }),
    });

    const result = await retrieveGraphFirst(
      'platform',
      { entityTypes: ['technology'], getQueryEmbedding: () => Promise.resolve([0.1]) },
      deps
    );

    expect(result.status).toBe('ambiguous');
    expect(result.resolution.entity).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ stage: 'semantic-resolution', code: 'semantic-ambiguous' }),
    ]);
    expect(deps.extractContext).not.toHaveBeenCalled();
  });

  it('classifies a thrown semantic GraphUnavailableError as unavailable', async () => {
    const deps = dependencies({
      searchSemantic: jest.fn().mockRejectedValue(new GraphUnavailableError('query', 'neo4j', 'ECONNREFUSED')),
    });

    const result = await retrieveGraphFirst(
      'platform',
      { entityTypes: ['technology'], getQueryEmbedding: () => Promise.resolve([0.1]) },
      deps
    );

    expect(result.status).toBe('unavailable');
    expect(result.resolution.status).toBe('unavailable');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ stage: 'semantic-resolution', code: 'graph-unavailable' }),
    ]);
  });

  it('reports a missing exact-name index as partial and skips unsafe fallback selection', async () => {
    const deps = dependencies({
      resolveExact: jest.fn().mockRejectedValue(new Error('There is no such fulltext schema index: entity_name_idx')),
    });

    const result = await retrieveGraphFirst('Atlas', {}, deps);

    expect(result.status).toBe('partial');
    expect(result.resolution.status).toBe('not-found');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ stage: 'exact-resolution', code: 'exact-index-unavailable' }),
    ]);
    expect(deps.searchSemantic).not.toHaveBeenCalled();
  });

  it('does not let index-like message text disguise an exact-resolution programmer defect', async () => {
    const deps = dependencies({
      resolveExact: jest.fn().mockRejectedValue(new TypeError('no such index connection projection invalid')),
    });

    await expect(retrieveGraphFirst('Atlas', {}, deps)).rejects.toThrow(
      'no such index connection projection invalid'
    );
  });

  it('does not auto-select an unscoped semantic candidate from partial type coverage', async () => {
    const deps = dependencies({
      searchSemantic: jest.fn().mockResolvedValue({
        results: [
          { id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: null, score: 0.95 },
        ],
        degraded: false,
        unavailable: false,
      }),
    });

    const result = await retrieveGraphFirst(
      'container platform',
      { getQueryEmbedding: () => Promise.resolve([0.1]) },
      deps
    );

    expect(result.status).toBe('partial');
    expect(result.resolution).toMatchObject({ status: 'ambiguous', entity: null });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'semantic-resolution', code: 'semantic-scope-incomplete' }),
      ])
    );
    expect(deps.extractContext).not.toHaveBeenCalled();
  });

  it('keeps a resolved entity while surfacing partial neighborhood diagnostics', async () => {
    const deps = dependencies({
      resolveExact: jest.fn().mockResolvedValue({
        status: 'resolved',
        matchedBy: 'normalized-name',
        entity: exactEntity(),
        candidates: [],
        candidatesTruncated: false,
      }),
      extractContext: jest.fn().mockResolvedValue(context(true)),
    });

    const result = await retrieveGraphFirst(
      'Kubernetes',
      { getQueryEmbedding: () => Promise.resolve([0.1]) },
      deps
    );

    expect(result.status).toBe('partial');
    expect(result.resolution.status).toBe('resolved');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ stage: 'business-neighborhood.chunks.semantic', code: 'context-partial' }),
    ]);
  });

  it('rethrows unexpected semantic defects instead of presenting a degraded answer', async () => {
    const deps = dependencies({
      searchSemantic: jest.fn().mockRejectedValue(new TypeError('connection projection invalid')),
    });
    await expect(
      retrieveGraphFirst(
        'platform',
        { entityTypes: ['technology'], getQueryEmbedding: () => Promise.resolve([0.1]) },
        deps
      )
    ).rejects.toThrow('connection projection invalid');
  });
});
