jest.mock('@/lib/firebase-admin', () => {
  const documents = new Map<string, Record<string, unknown>>();
  const transactionUpdate = jest.fn();
  const runTransaction = jest.fn();
  const ref = (collection: string, id: string): { collection: string; id: string; get: jest.Mock } => ({
    collection,
    id,
    get: jest.fn(async () => {
      const data = documents.get(`${collection}/${id}`);
      return {
        id,
        ref: ref(collection, id),
        exists: data !== undefined,
        data: () => data,
      };
    }),
  });

  return {
    db: {
      collection: jest.fn((collection: string) => ({
        doc: jest.fn((id: string) => ref(collection, id)),
      })),
      runTransaction,
    },
    __test: { documents, transactionUpdate, runTransaction },
  };
});

jest.mock('@/lib/concept-admin', () => ({
  adminBulkGetOrCreateConcepts: jest.fn(),
}));

jest.mock('../neo4j-client', () => ({
  runWriteTransaction: jest.fn(),
}));

import type { Concept } from '@/lib/types';
import {
  buildEntityTagConceptProjection,
  ENTITY_TAG_CONCEPT_MAX_LENGTH,
  ENTITY_TAG_CONCEPT_MAX_TAGS,
  normalizeBoundedEntityTags,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
  reconcileEntityTagConcepts,
} from '../entity-tag-concept-projection';

const firebaseAdminMock = jest.requireMock<{
  __test: {
    documents: Map<string, Record<string, unknown>>;
    transactionUpdate: jest.Mock;
    runTransaction: jest.Mock;
  };
}>('@/lib/firebase-admin');
const mockDocuments = firebaseAdminMock.__test.documents;
const mockTransactionUpdate = firebaseAdminMock.__test.transactionUpdate;
const mockRunTransaction = firebaseAdminMock.__test.runTransaction;
const mockAdminBulkGetOrCreateConcepts = jest.requireMock<{
  adminBulkGetOrCreateConcepts: jest.Mock;
}>('@/lib/concept-admin').adminBulkGetOrCreateConcepts;
const mockRunWriteTransaction = jest.requireMock<{
  runWriteTransaction: jest.Mock;
}>('../neo4j-client').runWriteTransaction;

function concept(id: string, name = id): Concept {
  return {
    id,
    canonicalName: name,
    slug: id.replace(/^concept-/, ''),
    type: 'tag',
    aliases: [name],
    entityCount: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('entity tag Concept projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocuments.clear();
    mockRunWriteTransaction.mockImplementation(async (query: string, params?: { conceptIds?: string[] }) => ({
      records: query.includes('entityCountProjectionRevision')
        ? (params?.conceptIds ?? []).map((conceptId, index) => ({
            conceptId,
            entityCount: 1,
            projectionRevision: 1_000 + index,
            reconciledAt: 10,
          }))
        : query.includes('staleConceptIds')
          ? [{ staleConceptIds: [] }]
          : [],
      summary: { counters: { relationshipsCreated: 0 } },
    }));
    mockRunTransaction.mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => {
      return callback({
        get: async (ref: { collection: string; id: string }) => {
          const data = mockDocuments.get(`${ref.collection}/${ref.id}`);
          return {
            id: ref.id,
            ref,
            exists: data !== undefined,
            data: () => data,
          };
        },
        update: (ref: { collection: string; id: string }, updates: Record<string, unknown>) => {
          mockTransactionUpdate(ref, updates);
          const key = `${ref.collection}/${ref.id}`;
          mockDocuments.set(key, { ...(mockDocuments.get(key) ?? {}), ...updates });
        },
      });
    });
  });

  it('bounds, trims, and de-duplicates legacy tag input', () => {
    const tags = Array.from({ length: ENTITY_TAG_CONCEPT_MAX_TAGS + 3 }, (_, index) => `tag-${index}`);
    const result = normalizeBoundedEntityTags([
      '  quantum  ',
      'quantum',
      '',
      42,
      'x'.repeat(ENTITY_TAG_CONCEPT_MAX_LENGTH + 1),
      ...tags,
    ]);

    expect(result).toHaveLength(ENTITY_TAG_CONCEPT_MAX_TAGS);
    expect(result[0]).toBe('quantum');
    expect(result).not.toContain('x'.repeat(ENTITY_TAG_CONCEPT_MAX_LENGTH + 1));
  });

  it('derives an exact add/remove plan without touching shared Concept nodes', () => {
    const projection = buildEntityTagConceptProjection(
      ['AI', 'Quantum'],
      [concept('concept-ai'), concept('concept-quantum')],
      ['concept-ai', 'concept-legacy']
    );

    expect(projection.conceptIds).toEqual(['concept-ai', 'concept-quantum']);
    expect(projection.addedConceptIds).toEqual(['concept-quantum']);
    expect(projection.removedConceptIds).toEqual(['concept-legacy']);
    expect(projection.conceptIdsChanged).toBe(true);
  });

  it('transactionally converges derived conceptIds without changing business updatedAt', async () => {
    mockDocuments.set('companies/company-1', {
      tags: ['AI', 'Quantum'],
      conceptIds: ['concept-ai', 'concept-legacy'],
    });
    mockDocuments.set('concepts/concept-ai', {});
    mockDocuments.set('concepts/concept-quantum', {});
    mockDocuments.set('concepts/concept-legacy', {});
    mockAdminBulkGetOrCreateConcepts.mockResolvedValue([
      concept('concept-ai', 'Artificial Intelligence'),
      concept('concept-quantum', 'Quantum'),
    ]);

    const first = await reconcileEntityTagConcepts('company-1', 'company');

    expect(first).toMatchObject({
      conceptIds: ['concept-ai', 'concept-quantum'],
      addedConceptIds: ['concept-quantum'],
      removedConceptIds: ['concept-legacy'],
    });
    expect(mockTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'companies', id: 'company-1' }),
      { conceptIds: ['concept-ai', 'concept-quantum'] }
    );
    expect(mockTransactionUpdate).toHaveBeenCalledTimes(1);

    mockTransactionUpdate.mockClear();
    const replay = await reconcileEntityTagConcepts('company-1', 'company');

    expect(replay?.conceptIdsChanged).toBe(false);
    expect(mockTransactionUpdate).not.toHaveBeenCalled();
  });

  it('returns null without creating Concepts when the authoritative entity is absent', async () => {
    await expect(reconcileEntityTagConcepts('missing', 'company')).resolves.toBeNull();
    expect(mockAdminBulkGetOrCreateConcepts).not.toHaveBeenCalled();
  });

  it('upserts Concepts before reconciling only implicit HAS_CONCEPT edges', async () => {
    await projectEntityTagConceptsToNeo4j('company-1', {
      tags: ['AI'],
      concepts: [concept('concept-ai')],
      conceptIds: ['concept-ai'],
      addedConceptIds: ['concept-ai'],
      removedConceptIds: [],
      conceptIdsChanged: true,
    });

    expect(mockRunWriteTransaction).toHaveBeenCalledTimes(5);
    expect(mockRunWriteTransaction.mock.calls[0][0]).toContain('MERGE (c:Concept');
    expect(mockRunWriteTransaction.mock.calls[1][0]).toContain('r.relationId IS NULL');
    expect(mockRunWriteTransaction.mock.calls[1][0]).toContain('r.claimId IS NULL');
    expect(mockRunWriteTransaction.mock.calls[2][0]).toContain('r.projectionOwner IS NULL');
    expect(mockRunWriteTransaction.mock.calls[3][0]).toContain('MERGE (entity)-[r:HAS_CONCEPT');
    expect(mockRunWriteTransaction.mock.calls[4][0]).toContain('count(DISTINCT entity) AS entityCount');
  });

  it('removes stale implicit links when tags become empty without deleting Concepts', async () => {
    await projectEntityTagConceptsToNeo4j('company-1', {
      tags: [],
      concepts: [],
      conceptIds: [],
      addedConceptIds: [],
      removedConceptIds: ['concept-ai'],
      conceptIdsChanged: true,
    });

    expect(mockRunWriteTransaction).toHaveBeenCalledTimes(2);
    expect(mockRunWriteTransaction.mock.calls[0][0]).toContain('DELETE edge');
    expect(mockRunWriteTransaction.mock.calls[0][0]).not.toContain('DELETE c');
  });

  it('keeps the newest topology receipt when Firestore applies count writes out of order', async () => {
    mockDocuments.set('concepts/concept-ai', {
      entityCount: 0,
      entityCountProjectionRevision: 0,
    });
    mockRunWriteTransaction
      .mockResolvedValueOnce({
        records: [{ conceptId: 'concept-ai', entityCount: 2, projectionRevision: 20, reconciledAt: 20 }],
        summary: { counters: {} },
      })
      .mockResolvedValueOnce({
        records: [{ conceptId: 'concept-ai', entityCount: 1, projectionRevision: 10, reconciledAt: 10 }],
        summary: { counters: {} },
      });

    await reconcileConceptEntityCounts(['concept-ai']);
    await reconcileConceptEntityCounts(['concept-ai']);

    expect(mockDocuments.get('concepts/concept-ai')).toMatchObject({
      entityCount: 2,
      entityCountProjectionRevision: 20,
    });
  });
});
