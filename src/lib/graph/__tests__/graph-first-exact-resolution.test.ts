jest.mock('../neo4j-client', () => ({ runReadTransaction: jest.fn() }));
jest.mock('@/lib/ai/client', () => ({ generateEmbedding: jest.fn() }));
// AI-026: only the semantic-search functions are stubbed. The identity
// vocabulary is NOT mocked any more — it used to be re-declared here, so
// deleting `AgentObservation` from the production list left this suite green.
jest.mock('../vector-search', () => ({
  searchEntitiesBySemantic: jest.fn(),
  isVectorIndexMissingError: jest.fn(() => false),
}));

import { runReadTransaction } from '../neo4j-client';
import { normalizeGraphRetrievalName, resolveExactGraphEntity } from '../subgraph-rag';
import { INTERNAL_MEMORY_ENTITY_TYPES, INTERNAL_MEMORY_GRAPH_LABELS } from '../business-entity-identity';

const mockedRead = runReadTransaction as jest.Mock;
const entity = (id: string, name: string, entityType = 'technology', label = 'Technology') => ({
  id,
  name,
  entityType,
  label,
  description: null,
});

describe('resolveExactGraphEntity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the indexed stable ID first and skips the name index on a hit', async () => {
    mockedRead.mockResolvedValueOnce({ records: [entity('tech-1', 'Kubernetes')] });

    const result = await resolveExactGraphEntity('tech-1');

    expect(result).toMatchObject({ status: 'resolved', matchedBy: 'stable-id', entity: { id: 'tech-1' } });
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead.mock.calls[0][0]).toContain('MATCH (n:Entity {id: $input})');
    // AI-026 — the REAL identity vocabulary is bound (no local re-declaration),
    // so removing a label from the production list fails this assertion.
    expect(mockedRead.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        internalMemoryLabels: expect.arrayContaining(['Agent', 'AgentObservation', 'User']),
        internalMemoryEntityTypes: expect.arrayContaining(['agent', 'memory', 'internal']),
        businessEntityLabels: expect.arrayContaining(['Technology', 'Company']),
        entityProjectionLabels: expect.arrayContaining(['Entity', 'Technology']),
      })
    );
    expect(mockedRead.mock.calls[0][1]).toMatchObject({
      internalMemoryLabels: INTERNAL_MEMORY_GRAPH_LABELS,
      internalMemoryEntityTypes: INTERNAL_MEMORY_ENTITY_TYPES,
    });
  });

  it('uses a bounded fulltext index lookup for normalized exact names with legacy label filtering', async () => {
    mockedRead
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [entity('tech-1', 'ATLAS')] });

    const result = await resolveExactGraphEntity('  Atlas  ', {
      candidateLimit: 5,
      entityTypes: ['technology'],
    });

    expect(result).toMatchObject({ status: 'resolved', matchedBy: 'normalized-name', entity: { id: 'tech-1' } });
    const [cypher, params] = mockedRead.mock.calls[1];
    expect(cypher).toContain("db.index.fulltext.queryNodes('entity_name_idx'");
    expect(cypher).toContain('LIMIT toInteger($scanLimit)');
    // AI-026 — the requested type is proven by its canonical label. The old
    // predicate accepted `n.entityType IN $entityTypes` as an ALTERNATIVE to the
    // label, which is what let a property-only match through.
    expect(cypher).toContain('ANY(identityLabel IN labels(n) WHERE identityLabel IN $entityLabels)');
    expect(cypher).toContain('NONE(identityLabel IN labels(n) WHERE NOT identityLabel IN $entityProjectionLabels)');
    // The property comparison survives ONLY inside the placeholder gate: it is
    // reachable exclusively for a node with no canonical label at all. The old
    // predicate offered it as a peer alternative to the label.
    expect(cypher.replace(/\s+/g, ' ')).toContain(
      'NONE(identityLabel IN labels(n) WHERE identityLabel IN $businessEntityLabels) ' +
        'AND ($entityTypes IS NULL OR n.entityType IN $entityTypes)'
    );
    expect(cypher).not.toMatch(/MATCH\s*\(n:Entity\)\s*WHERE\s*toLower/i);
    expect(params).toEqual(
      expect.objectContaining({
        fulltextQuery: '"Atlas"',
        scanLimit: 21,
        entityLabels: ['Technology'],
      })
    );
  });

  it('returns all normalized-name matches in deterministic order instead of choosing the first row', async () => {
    mockedRead.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({
      records: [entity('tech-z', 'Atlas', 'technology'), entity('company-z', ' ATLAS ', 'company', 'Company')],
    });

    const result = await resolveExactGraphEntity('atlas');

    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('expected ambiguity');
    expect(result.candidates.map((item) => item.id)).toEqual(['company-z', 'tech-z']);
    expect(result.entity).toBeNull();
  });

  it('fails closed when the bounded fulltext scan saturates, even with one exact row', async () => {
    mockedRead.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({
      records: [
        entity('exact', 'Atlas'),
        entity('near-1', 'Atlas Platform'),
        entity('near-2', 'Atlas Cloud'),
        entity('near-3', 'Atlas Data'),
        entity('near-4', 'Atlas Labs'),
      ],
    });

    const result = await resolveExactGraphEntity('Atlas', { candidateLimit: 1 });

    expect(result).toMatchObject({
      status: 'ambiguous',
      entity: null,
      candidatesTruncated: true,
      candidates: [{ id: 'exact' }],
    });
    expect(mockedRead.mock.calls[1][1].scanLimit).toBe(5);
  });

  it('normalizes Unicode compatibility forms, case, and repeated whitespace deterministically', () => {
    expect(normalizeGraphRetrievalName('  ＡTLAS\t Platform  ')).toBe('atlas platform');
  });
});
