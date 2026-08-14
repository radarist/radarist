/**
 * @file subgraph-rag.test.ts
 * @description Unit tests for extractSubgraph + extractSubgraphForQuery.
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

jest.mock('../vector-search', () => ({
  GRAPH_RETRIEVAL_EXCLUDED_LABELS: [
    'Agent',
    'AgentRun',
    'AgentObservation',
    'Episode',
    'Observation',
    'Session',
    'User',
    'Mission',
    'ProactiveInsight',
    'CuriosityGap',
  ],
  GRAPH_RETRIEVAL_EXCLUDED_ENTITY_TYPES: [
    'agent',
    'agentrun',
    'agent_run',
    'agentobservation',
    'agent_observation',
    'episode',
    'observation',
    'session',
    'user',
    'mission',
    'memory',
    'internal',
  ],
  searchEntitiesBySemantic: jest.fn(),
  isVectorIndexMissingError: jest.fn((error: unknown) => /no such.*index/i.test(String(error))),
}));

import * as neo4jClient from '../neo4j-client';
import * as aiClient from '@/lib/ai/client';
import * as vectorSearch from '../vector-search';
import { extractSubgraph, extractSubgraphForQuery, fetchDocumentsForEntity } from '../subgraph-rag';
import { GraphUnavailableError } from '../errors';

const mockedRead = neo4jClient.runReadTransaction as jest.Mock;
const mockedEmbed = aiClient.generateEmbedding as jest.Mock;
const mockedSearch = vectorSearch.searchEntitiesBySemantic as jest.Mock;

describe('extractSubgraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
  });

  it('returns null when the focus entity is not found', async () => {
    mockedRead.mockResolvedValueOnce({ records: [] });
    const result = await extractSubgraph('missing-entity');
    expect(result).toBeNull();
  });

  it('returns center + neighbors + chunks + claims + temporal in one call', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: 'Container orchestration' }],
        });
      if (cypher.includes('<-[:MENTIONS]-(c:Chunk)'))
        return Promise.resolve({
          records: [
            {
              id: 'chunk-mentions-1',
              content: 'Literal mention of Kubernetes in the text.',
              documentId: 'doc-2',
              documentTitle: 'Docs with Mentions',
              score: 1.0,
            },
          ],
        });
      if (cypher.includes('CALL db.index.vector.queryNodes'))
        return Promise.resolve({
          records: [
            {
              id: 'chunk-1',
              content: 'Kubernetes is an open-source system...',
              documentId: 'doc-1',
              documentTitle: 'K8s Primer',
              score: 0.85,
            },
          ],
        });
      if (cypher.includes('MATCH (c:Assertion)') && cypher.includes('$entityId'))
        return Promise.resolve({
          records: [
            {
              id: 'claim-1',
              predicate: 'USES',
              subjectName: 'Kubernetes',
              objectName: 'Docker',
              statement: 'Kubernetes uses Docker',
              confidence: 0.9,
              status: 'curated',
            },
          ],
        });
      if (cypher.includes('r.t_observed IS NOT NULL'))
        return Promise.resolve({
          records: [
            {
              relation: 'USES',
              connectedId: 'tech-2',
              connectedName: 'Docker',
              direction: 'out',
              t_observed: '2026-04-17T10:00:00Z',
            },
          ],
        });
      // neighbors (default)
      return Promise.resolve({
        records: [
          {
            id: 'tech-2',
            label: 'Technology',
            name: 'Docker',
            description: 'Containerization',
            relation: 'USES',
            direction: 'out',
            confidence: 0.9,
            claimId: null,
          },
        ],
      });
    });

    const result = await extractSubgraph('tech-1');

    expect(result).not.toBeNull();
    expect(result?.center.id).toBe('tech-1');
    expect(result?.center.name).toBe('Kubernetes');
    expect(result?.neighbors).toHaveLength(1);
    expect(result?.neighbors[0].entity.name).toBe('Docker');
    expect(result?.neighbors[0].relation).toBe('USES');
    // Hybrid retrieval returns both: MENTIONS (score=1.0) + vector (0.85)
    expect(result?.chunks).toHaveLength(2);
    expect(result?.chunks[0].score).toBe(1.0);
    expect(result?.chunks[0].id).toBe('chunk-mentions-1');
    expect(result?.chunks[1].score).toBe(0.85);
    expect(result?.claims).toHaveLength(1);
    expect(result?.claims[0].statement).toBe('Kubernetes uses Docker');
    expect(result?.temporal).toHaveLength(1);
  });

  it('skips chunk fetch when center has no name+description text', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: '', description: null }],
        });
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraph('tech-1');
    expect(result?.chunks).toEqual([]);
    expect(mockedEmbed).not.toHaveBeenCalled();
  });

  it('reuses a precomputed query embedding for grounded chunk search', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity')) {
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: null }],
        });
      }
      return Promise.resolve({ records: [] });
    });

    await extractSubgraph('tech-1', { queryEmbedding: Promise.resolve([0.2, 0.3]) });

    expect(mockedEmbed).not.toHaveBeenCalled();
    const vectorCall = mockedRead.mock.calls.find(([cypher]) => String(cypher).includes('chunk_embedding'));
    expect(vectorCall?.[1].embedding).toEqual([0.2, 0.3]);
  });

  it('surfaces a known lane outage as typed partial context without exposing provider details', async () => {
    mockedEmbed.mockRejectedValueOnce(new Error('HTTP 429 token=private-provider-token'));
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity')) {
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: null }],
        });
      }
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraph('tech-1');

    expect(result?.partial).toBe(true);
    expect(result?.diagnostics).toEqual([
      {
        stage: 'chunks.semantic',
        code: 'unavailable',
        message: 'The embedding provider is temporarily unavailable.',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-provider-token');
  });

  it('keeps exact graph context and mention evidence when embedding configuration is unavailable', async () => {
    mockedEmbed.mockRejectedValueOnce(
      new Error('Google AI API key not found. Set GEMINI_API_KEY=private-provider-key')
    );
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity')) {
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: null }],
        });
      }
      if (cypher.includes('<-[:MENTIONS]-(c:Chunk)')) {
        return Promise.resolve({
          records: [
            {
              id: 'chunk-mention',
              content: 'Kubernetes is governed by CNCF.',
              documentId: 'doc-1',
              documentTitle: 'Platform Brief',
              chunkIndex: 0,
              score: 1,
              provenance: 'entity-mention',
            },
          ],
        });
      }
      if (cypher.includes('MATCH (c:Assertion)')) {
        return Promise.resolve({
          records: [
            {
              id: 'claim-1',
              predicate: 'GOVERNS',
              subjectName: 'CNCF',
              objectName: 'Kubernetes',
              statement: 'CNCF governs Kubernetes.',
              confidence: 0.9,
              status: 'curated',
            },
          ],
        });
      }
      if (cypher.includes('MATCH (center:Entity {id: $entityId})-[r]-(other)')) {
        return Promise.resolve({
          records: [
            {
              id: 'company-1',
              label: 'Company',
              name: 'CNCF',
              description: null,
              relation: 'GOVERNS',
              relationPath: ['GOVERNS'],
              direction: 'in',
              distance: 1,
              confidence: 0.9,
              claimId: 'claim-1',
              segments: [],
            },
          ],
        });
      }
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraph('tech-1');

    expect(result).toMatchObject({
      center: { id: 'tech-1' },
      partial: true,
      neighbors: [{ entity: { id: 'company-1' }, claimId: 'claim-1' }],
      chunks: [{ id: 'chunk-mention', provenance: 'entity-mention' }],
      claims: [{ id: 'claim-1' }],
      diagnostics: [
        {
          stage: 'chunks.semantic',
          code: 'unavailable',
          message: 'The embedding provider is temporarily unavailable.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-key');
  });

  it('does not let retryable message text disguise a programmer defect as partial availability', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity')) {
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: null }],
        });
      }
      if (cypher.includes('MATCH (center:Entity {id: $entityId})-[r]-(other)')) {
        return Promise.reject(new TypeError('connection projection invalid'));
      }
      return Promise.resolve({ records: [] });
    });

    await expect(extractSubgraph('tech-1')).rejects.toThrow('connection projection invalid');
  });
});

describe('extractSubgraphForQuery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
  });

  it('returns null when no entity resolves above the threshold', async () => {
    mockedSearch.mockResolvedValueOnce({ results: [], degraded: false });
    const result = await extractSubgraphForQuery('nothing matches');
    expect(result).toBeNull();
  });

  it('resolves the top entity via semantic search, then builds the subgraph', async () => {
    mockedSearch.mockResolvedValueOnce({
      results: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: 'K8s', score: 0.92 }],
      degraded: false,
    });
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'Kubernetes', description: 'K8s' }],
        });
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraphForQuery('container orchestrator');
    expect(result?.center.id).toBe('tech-1');
    expect(mockedSearch).toHaveBeenCalledWith('container orchestrator', 'all', expect.objectContaining({ limit: 1 }));
  });

  it('returns null when the resolved entity is below the minScore threshold', async () => {
    mockedSearch.mockResolvedValueOnce({ results: [], degraded: false });
    const result = await extractSubgraphForQuery('q', { resolveMinScore: 0.9 });
    expect(result).toBeNull();
    expect(mockedSearch).toHaveBeenCalledWith('q', 'all', expect.objectContaining({ minScore: 0.9 }));
  });

  // ---- AUDIT-020 honesty guard ----
  // Translating driver errors into GraphUnavailableError woke up a catch in
  // vector-search that had never fired for the Neo4j backend. Left alone, a
  // total outage would have arrived here as `{ results: [], degraded: true }`
  // and been returned as `null` — the SAME value this function returns for "no
  // entity matched". An outage would have been indistinguishable from an empty
  // search result for every caller downstream. It must fail loud.
  it('throws — not returns null — when the graph backend is unreachable', async () => {
    mockedSearch.mockResolvedValueOnce({
      results: [],
      degraded: true,
      degradedReason: 'technology_embedding unavailable: ECONNREFUSED',
      unavailable: true,
    });

    await expect(extractSubgraphForQuery('anything')).rejects.toBeInstanceOf(GraphUnavailableError);
  });

  it('still returns null for a merely-missing vector index — that is a real empty, not an outage', async () => {
    mockedSearch.mockResolvedValueOnce({
      results: [],
      degraded: true,
      degradedReason: 'technology_embedding unavailable: no such index',
      unavailable: false,
    });

    // A fresh graph with no embeddings backfilled genuinely has no matches.
    // Throwing here would break the demo on first boot.
    await expect(extractSubgraphForQuery('anything')).resolves.toBeNull();
  });
});

// ============================================================================
// ROBUSTNESS / EDGE CASES (Phase 3 P2)
// ============================================================================

describe('extractSubgraph — robustness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbed.mockResolvedValue(new Array(768).fill(0.01));
  });

  it('returns an empty neighbors list without crashing for a 0-relation entity', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-iso', label: 'Technology', name: 'Isolated', description: 'Standalone' }],
        });
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraph('tech-iso');
    expect(result).not.toBeNull();
    expect(result?.neighbors).toEqual([]);
    expect(result?.chunks).toEqual([]);
    expect(result?.claims).toEqual([]);
    expect(result?.temporal).toEqual([]);
  });

  it('respects the neighbors limit option via Cypher LIMIT param', async () => {
    mockedRead.mockImplementation((cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: 'orch' }],
        });
      if (cypher.includes('MATCH (center:Entity {id: $entityId})-[r]-(other)')) {
        // neighbors query — assert limit param was passed
        expect(params?.limit).toBe(3);
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    await extractSubgraph('tech-1', { neighbors: 3 });
  });

  it('fetchNeighbors projects + orders confidence via COALESCE(r.effectiveConfidence, r.confidence), 0 default kept (B0)', async () => {
    let neighborsCypher = '';
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: 'orch' }],
        });
      if (cypher.includes('MATCH (center:Entity {id: $entityId})-[r]-(other)')) {
        neighborsCypher = cypher;
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    await extractSubgraph('tech-1');

    expect(neighborsCypher).toContain('COALESCE(r.effectiveConfidence, r.confidence) AS confidence');
    expect(neighborsCypher).toContain('ORDER BY coalesce(r.effectiveConfidence, r.confidence, 0) DESC');
    expect(neighborsCypher).toContain('r.t_invalidated IS NULL');
    expect(neighborsCypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
  });

  it('fetchClaims projects confidence via COALESCE(c.effectiveConfidence, c.confidence) (B0)', async () => {
    let claimsCypher = '';
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: 'orch' }],
        });
      if (cypher.includes('MATCH (c:Assertion)') && cypher.includes('$entityId')) {
        claimsCypher = cypher;
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    await extractSubgraph('tech-1');

    expect(claimsCypher).toContain('COALESCE(c.effectiveConfidence, c.confidence) AS confidence');
    expect(claimsCypher).toContain("coalesce(c.status, 'proposed') <> 'rejected'");
  });

  it('fetchTemporal compares t_observed string-vs-string, never string-vs-datetime() (M9)', async () => {
    // t_observed is WRITTEN as toString(datetime()) — an ISO STRING. Comparing a
    // string to a Cypher datetime() yields NULL, so 0 edges ever matched. The
    // reader must compare against an ISO-string cutoff (mirrors
    // temporal-queries.ts getChangedSince's `r.t_observed > $since` pattern).
    let temporalCypher = '';
    let temporalParams: Record<string, unknown> | undefined;
    mockedRead.mockImplementation((cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: 'orch' }],
        });
      if (cypher.includes('r.t_observed IS NOT NULL')) {
        temporalCypher = cypher;
        temporalParams = params;
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    await extractSubgraph('tech-1', { temporalDays: 30 });

    expect(temporalCypher).toContain('r.t_observed > $since');
    expect(temporalCypher).toContain('r.t_invalidated IS NULL');
    expect(temporalCypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    // The broken pattern: string t_observed > datetime() - duration(...) → NULL
    expect(temporalCypher).not.toContain('datetime() - duration');
    // Cutoff computed in JS as an ISO string, 30 days back
    expect(typeof temporalParams?.since).toBe('string');
    expect(temporalParams?.since as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('merges MENTIONS and vector chunks with MENTIONS winning on ties', async () => {
    mockedRead.mockImplementation((cypher: string) => {
      if (cypher.includes('MATCH (n:Entity'))
        return Promise.resolve({
          records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: 'orch' }],
        });
      if (cypher.includes('<-[:MENTIONS]-(c:Chunk)'))
        return Promise.resolve({
          records: [{ id: 'chunk-dup', content: 'literal', documentId: 'd1', documentTitle: null, score: 1.0 }],
        });
      if (cypher.includes('CALL db.index.vector.queryNodes'))
        return Promise.resolve({
          records: [
            { id: 'chunk-dup', content: 'literal', documentId: 'd1', documentTitle: null, score: 0.72 },
            { id: 'chunk-unique', content: 'semantic only', documentId: 'd2', documentTitle: null, score: 0.81 },
          ],
        });
      return Promise.resolve({ records: [] });
    });

    const result = await extractSubgraph('tech-1', { chunks: 5 });
    expect(result?.chunks).toHaveLength(2);
    // Dedup winner: MENTIONS (1.0) wins over vector (0.72) for chunk-dup
    const dup = result?.chunks.find((c) => c.id === 'chunk-dup');
    expect(dup?.score).toBe(1.0);
    // Chunks sorted by score desc
    expect(result?.chunks[0].id).toBe('chunk-dup');
    expect(result?.chunks[1].id).toBe('chunk-unique');
  });
});

// ============================================================================
// fetchDocumentsForEntity (Task 13 — A3 doc-grounding enumeration)
// ============================================================================

describe('fetchDocumentsForEntity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enumerates distinct documents via chunk MENTIONS + typed doc edges', async () => {
    let capturedCypher = '';
    let capturedParams: Record<string, unknown> | undefined;
    mockedRead.mockImplementation((cypher: string, params?: Record<string, unknown>) => {
      capturedCypher = cypher;
      capturedParams = params;
      return Promise.resolve({
        records: [
          { documentId: 'doc-1', title: 'Doc One', type: 'article', mentionCount: 3, snippets: ['a snippet'] },
          { documentId: 'doc-2', title: 'Doc Two', type: 'report', mentionCount: 1, snippets: [] },
        ],
      });
    });

    const result = await fetchDocumentsForEntity('tech-1');

    expect(capturedCypher).toContain('MENTIONS|DOCUMENTED_BY|HAS_EVIDENCE');
    expect(capturedParams).toEqual({ entityId: 'tech-1', limit: 5 });
    expect(result).toHaveLength(2);
    expect(result[0].documentId).toBe('doc-1');
    expect(result[0].mentionCount).toBe(3);
    expect(result[0].snippets).toEqual(['a snippet']);
    expect(result[1].documentId).toBe('doc-2');
  });

  it('passes a custom limit', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    mockedRead.mockImplementation((_cypher: string, params?: Record<string, unknown>) => {
      capturedParams = params;
      return Promise.resolve({ records: [] });
    });

    await fetchDocumentsForEntity('tech-1', { limit: 2 });

    expect(capturedParams).toEqual({ entityId: 'tech-1', limit: 2 });
  });

  it('truncates snippets to 280 chars', async () => {
    const longSnippet = 'x'.repeat(400);
    mockedRead.mockResolvedValueOnce({
      records: [{ documentId: 'doc-1', title: 'Doc', type: 'article', mentionCount: 2, snippets: [longSnippet] }],
    });

    const result = await fetchDocumentsForEntity('tech-1');

    expect(result[0].snippets[0]).toHaveLength(280);
    expect(result[0].snippets[0]).toBe(longSnippet.slice(0, 280));
  });

  it('logs and rethrows on a read failure', async () => {
    const boom = new Error('neo4j down');
    mockedRead.mockRejectedValueOnce(boom);

    await expect(fetchDocumentsForEntity('tech-1')).rejects.toThrow('neo4j down');
  });
});
