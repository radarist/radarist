/**
 * @file semantic-entity-search.test.ts
 * @description Unit tests for searchEntitiesBySemantic.
 *
 * P5-C contract: the function returns `{ results, degraded, degradedReason? }`.
 * A missing vector index or an unavailable graph backend must NOT throw and
 * must NOT be masked as "no matches" — it degrades honestly with a flag so
 * tool boundaries can surface it. Unexpected errors still throw.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

jest.mock('@/lib/ai/client', () => ({
  generateEmbedding: jest.fn(),
}));

jest.mock('@/lib/ai/constants', () => ({
  TaskType: { RETRIEVAL_QUERY: 'RETRIEVAL_QUERY', RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT' },
}));

import * as neo4jClient from '../neo4j-client';
import * as aiClient from '@/lib/ai/client';
import { searchEntitiesBySemantic } from '../vector-search';
import { GraphUnavailableError } from '../errors';

const mockedRead = neo4jClient.runReadTransaction as jest.Mock;
const mockedEmbed = aiClient.generateEmbedding as jest.Mock;

describe('searchEntitiesBySemantic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
  });

  it('embeds the query once (RETRIEVAL_QUERY) then queries all indexes for label=all', async () => {
    mockedRead
      .mockResolvedValueOnce({
        records: [{ id: 'tech-1', name: 'K8s', description: 'Container orchestration', score: 0.9 }],
      })
      .mockResolvedValueOnce({
        records: [{ id: 'co-1', name: 'OpenAI', description: 'AI lab', score: 0.88 }],
      })
      .mockResolvedValueOnce({
        records: [{ id: 'sig-1', name: 'K8s hype', description: 'Signal re containers', score: 0.82 }],
      });

    const { results, degraded } = await searchEntitiesBySemantic('container platforms', 'all', { limit: 5 });

    expect(mockedEmbed).toHaveBeenCalledTimes(1);
    expect(mockedEmbed).toHaveBeenCalledWith('container platforms', { taskType: 'RETRIEVAL_QUERY' });
    expect(mockedRead).toHaveBeenCalledTimes(3);

    // The vector query runs with the generated query embedding
    for (const [, params] of mockedRead.mock.calls) {
      expect(params.embedding).toEqual(new Array(768).fill(0.01));
    }

    expect(degraded).toBe(false);
    expect(results).toHaveLength(3);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results.map((r) => r.label).sort()).toEqual(['Company', 'Signal', 'Technology']);
  });

  it('only queries the Technology index when label=Technology', async () => {
    mockedRead.mockResolvedValue({
      records: [{ id: 'tech-1', name: 'K8s', description: 'Container orchestration', score: 0.9 }],
    });

    const { results } = await searchEntitiesBySemantic('container platforms', 'Technology');

    expect(mockedRead).toHaveBeenCalledTimes(1);
    const [, params] = mockedRead.mock.calls[0];
    expect(params.indexName).toBe('technology_embedding');
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Technology');
  });

  it('uses a caller-supplied query embedding without a second provider call', async () => {
    mockedRead.mockResolvedValue({ records: [] });

    await searchEntitiesBySemantic('container platforms', 'Technology', {
      queryEmbedding: Promise.resolve([0.4, 0.5]),
    });

    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedRead.mock.calls[0][1].embedding).toEqual([0.4, 0.5]);
  });

  it('only queries the Company index when label=Company', async () => {
    mockedRead.mockResolvedValue({
      records: [{ id: 'co-1', name: 'OpenAI', description: 'AI lab', score: 0.88 }],
    });

    const { results } = await searchEntitiesBySemantic('ai companies', 'Company');

    expect(mockedRead).toHaveBeenCalledTimes(1);
    const [, params] = mockedRead.mock.calls[0];
    expect(params.indexName).toBe('company_embedding');
    expect(results[0].label).toBe('Company');
  });

  it('respects minScore option by filtering at the Cypher level', async () => {
    mockedRead.mockResolvedValue({ records: [] });
    await searchEntitiesBySemantic('x', 'Technology', { minScore: 0.75 });
    const [, params] = mockedRead.mock.calls[0];
    expect(params.minScore).toBe(0.75);
  });

  it('merges results across labels and truncates to the requested limit', async () => {
    mockedRead
      .mockResolvedValueOnce({
        records: [
          { id: 't1', name: 'T1', description: null, score: 0.95 },
          { id: 't2', name: 'T2', description: null, score: 0.85 },
          { id: 't3', name: 'T3', description: null, score: 0.75 },
        ],
      })
      .mockResolvedValueOnce({
        records: [
          { id: 'c1', name: 'C1', description: null, score: 0.9 },
          { id: 'c2', name: 'C2', description: null, score: 0.8 },
        ],
      })
      .mockResolvedValueOnce({ records: [] });

    const { results } = await searchEntitiesBySemantic('q', 'all', { limit: 3 });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.score)).toEqual([0.95, 0.9, 0.85]);
  });

  // ==========================================================================
  // P5-C: honest graceful degradation
  // ==========================================================================

  it('degrades (not throws, not silent-empty) when a vector index is missing', async () => {
    // Neo4j's error when db.index.vector.queryNodes targets an absent index
    mockedRead.mockRejectedValue(new Error('There is no such vector schema index: technology_embedding'));

    const result = await searchEntitiesBySemantic('container platforms', 'Technology');

    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('technology_embedding');
    // A missing index is a real empty — there are genuinely no results to be
    // had until the backfill runs. It must NOT be conflated with an outage.
    expect(result.unavailable).toBe(false);
  });

  it('keeps healthy-index results and still flags degradation when only one index is missing', async () => {
    mockedRead
      .mockRejectedValueOnce(new Error('There is no such vector schema index: technology_embedding'))
      .mockResolvedValueOnce({
        records: [{ id: 'co-1', name: 'OpenAI', description: 'AI lab', score: 0.88 }],
      })
      .mockResolvedValueOnce({ records: [] });

    const result = await searchEntitiesBySemantic('q', 'all');

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('co-1');
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('technology_embedding');
  });

  it('degrades honestly when the graph backend is unavailable (GraphUnavailableError)', async () => {
    mockedRead.mockRejectedValue(new GraphUnavailableError('query', 'firestore-fallback'));

    const result = await searchEntitiesBySemantic('q', 'all');

    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBeTruthy();
    // AUDIT-020: the flag that stops a caller rendering this empty list as
    // "no matches found". Without it, an outage reads exactly like a miss.
    expect(result.unavailable).toBe(true);
  });

  it('still throws on unexpected infrastructure errors (no blanket catch)', async () => {
    mockedRead.mockRejectedValue(new Error('connection reset by peer'));

    await expect(searchEntitiesBySemantic('q', 'Technology')).rejects.toThrow('connection reset by peer');
  });

  it('does not let index-like message text disguise a programmer defect as degradation', async () => {
    mockedRead.mockRejectedValue(new TypeError('no such index connection projection invalid'));

    await expect(searchEntitiesBySemantic('q', 'Technology')).rejects.toThrow(
      'no such index connection projection invalid'
    );
  });
});
