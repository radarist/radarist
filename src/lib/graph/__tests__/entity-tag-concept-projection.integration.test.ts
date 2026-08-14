/** Guarded real-Neo4j acceptance for organic tag-to-Concept projection. */

const mockConceptDocuments = new Map<string, Record<string, unknown>>();
let mockTransactionTail: Promise<void> = Promise.resolve();

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => ({
      doc: jest.fn((documentId: string) => ({ collectionName, documentId })),
    })),
    runTransaction: jest.fn(
      async (
        callback: (transaction: {
          get: (ref: { collectionName: string; documentId: string }) => Promise<unknown>;
          update: (
            ref: { collectionName: string; documentId: string },
            updates: Record<string, unknown>
          ) => void;
        }) => Promise<unknown>
      ) => {
        const prior = mockTransactionTail;
        let release!: () => void;
        mockTransactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        try {
          return await callback({
            get: async (ref) => {
              const data = mockConceptDocuments.get(`${ref.collectionName}/${ref.documentId}`);
              return {
                exists: data !== undefined,
                data: () => data,
              };
            },
            update: (ref, updates) => {
              const key = `${ref.collectionName}/${ref.documentId}`;
              mockConceptDocuments.set(key, {
                ...(mockConceptDocuments.get(key) ?? {}),
                ...updates,
              });
            },
          });
        } finally {
          release();
        }
      }
    ),
  },
}));
jest.mock('@/lib/concept-admin', () => ({
  adminBulkGetOrCreateConcepts: jest.fn(),
}));

import type { Concept } from '@/lib/types';
import { closeDriver, runReadTransaction, runWriteTransaction } from '../neo4j-client';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
} from '../../../../scripts/testing/run-neo4j-integration';
import {
  buildEntityTagConceptProjection,
  captureEntityTagConceptIdsFromNeo4j,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
} from '../entity-tag-concept-projection';

const TEST_PREFIX = 'graph054-tag-concepts-';
const describeIntegration = isDisposableNeo4jIntegrationSuiteEnabled() ? describe : describe.skip;

const ids = {
  company: `${TEST_PREFIX}company`,
  technology: `${TEST_PREFIX}technology`,
  ai: `${TEST_PREFIX}concept-ai`,
  quantum: `${TEST_PREFIX}concept-quantum`,
  chemistry: `${TEST_PREFIX}concept-chemistry`,
  curated: `${TEST_PREFIX}curated-edge`,
};

function concept(id: string, canonicalName: string): Concept {
  return {
    id,
    slug: id.replace(`${TEST_PREFIX}concept-`, ''),
    canonicalName,
    type: 'tag',
    aliases: [canonicalName],
    entityCount: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

const concepts = {
  ai: concept(ids.ai, 'Artificial Intelligence'),
  quantum: concept(ids.quantum, 'Quantum Computing'),
  chemistry: concept(ids.chemistry, 'Chemistry'),
};

async function cleanup(): Promise<void> {
  assertDisposableNeo4jIntegrationSuiteTarget();
  await runWriteTransaction('MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node', {
    prefix: TEST_PREFIX,
  });
}

async function links(): Promise<
  Array<{ sourceId: string; conceptId: string; owner: string | null; relationId: string | null }>
> {
  const result = await runReadTransaction<{
    sourceId: string;
    conceptId: string;
    owner: string | null;
    relationId: string | null;
  }>(
    `MATCH (source:Entity)-[edge:HAS_CONCEPT]->(concept:Concept)
     WHERE source.id STARTS WITH $prefix
     RETURN source.id AS sourceId, concept.id AS conceptId,
            edge.projectionOwner AS owner, edge.relationId AS relationId
     ORDER BY sourceId, conceptId, relationId`,
    { prefix: TEST_PREFIX }
  );
  return result.records;
}

async function graphCounts(): Promise<
  Array<{ conceptId: string; entityCount: number; projectionRevision: number }>
> {
  const result = await runReadTransaction<{
    conceptId: string;
    entityCount: number;
    projectionRevision: number;
  }>(
    `MATCH (concept:Concept)
     WHERE concept.id IN $conceptIds
     RETURN concept.id AS conceptId,
            concept.entityCount AS entityCount,
            concept.entityCountProjectionRevision AS projectionRevision
     ORDER BY conceptId`,
    { conceptIds: [ids.ai, ids.quantum, ids.chemistry] }
  );
  return result.records;
}

function firestoreCount(conceptId: string): { entityCount: unknown; projectionRevision: unknown } {
  const document = mockConceptDocuments.get(`concepts/${conceptId}`) ?? {};
  return {
    entityCount: document.entityCount,
    projectionRevision: document.entityCountProjectionRevision,
  };
}

describeIntegration('GRAPH-054 tag Concept projection (real Neo4j)', () => {
  beforeAll(async () => {
    assertDisposableNeo4jIntegrationSuiteTarget();
    // The projection relies on the production Concept identity constraint for
    // concurrent MERGE convergence. A bare disposable database has no schema,
    // so install the exact manifest constraint before racing two projections.
    await runWriteTransaction(
      'CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (concept:Concept) REQUIRE concept.id IS UNIQUE'
    );
    mockConceptDocuments.clear();
    for (const item of Object.values(concepts)) {
      mockConceptDocuments.set(`concepts/${item.id}`, { ...item });
    }
    await cleanup();
    await runWriteTransaction(
      `CREATE (:Entity:Company {id: $company, name: 'Company'})
       CREATE (:Entity:Technology {id: $technology, name: 'Technology'})`,
      ids
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDriver();
  }, 60_000);

  it('creates useful shared paths and converges removal/replay without touching explicit edges or shared Concepts', async () => {
    await Promise.all([
      projectEntityTagConceptsToNeo4j(
        ids.company,
        buildEntityTagConceptProjection(['AI', 'Quantum'], [concepts.ai, concepts.quantum], [])
      ),
      projectEntityTagConceptsToNeo4j(
        ids.technology,
        buildEntityTagConceptProjection(['AI', 'Chemistry'], [concepts.ai, concepts.chemistry], [])
      ),
    ]);

    const sharedPath = await runReadTransaction<{ companyId: string; technologyId: string; conceptId: string }>(
      `MATCH (company:Company {id: $company})-[:HAS_CONCEPT]->(concept:Concept)<-[:HAS_CONCEPT]-(technology:Technology {id: $technology})
       RETURN company.id AS companyId, technology.id AS technologyId, concept.id AS conceptId`,
      ids
    );
    expect(sharedPath.records).toEqual([
      { companyId: ids.company, technologyId: ids.technology, conceptId: ids.ai },
    ]);
    expect(await graphCounts()).toEqual([
      expect.objectContaining({ conceptId: ids.ai, entityCount: 2 }),
      expect.objectContaining({ conceptId: ids.chemistry, entityCount: 1 }),
      expect.objectContaining({ conceptId: ids.quantum, entityCount: 1 }),
    ]);
    for (const { conceptId, entityCount, projectionRevision } of await graphCounts()) {
      expect(firestoreCount(conceptId)).toEqual({ entityCount, projectionRevision });
    }

    await runWriteTransaction(
      `MATCH (company:Company {id: $company}), (chemistry:Concept {id: $chemistry})
       CREATE (company)-[:HAS_CONCEPT {relationId: $curated}]->(chemistry)`,
      ids
    );
    await reconcileConceptEntityCounts([ids.chemistry]);

    const quantumOnly = buildEntityTagConceptProjection(
      ['Quantum'],
      [concepts.quantum],
      [ids.ai, ids.quantum]
    );
    await projectEntityTagConceptsToNeo4j(ids.company, quantumOnly);
    await projectEntityTagConceptsToNeo4j(ids.company, quantumOnly);

    expect(await links()).toEqual([
      { sourceId: ids.company, conceptId: ids.chemistry, owner: null, relationId: ids.curated },
      { sourceId: ids.company, conceptId: ids.quantum, owner: 'entity-tags-v1', relationId: null },
      { sourceId: ids.technology, conceptId: ids.ai, owner: 'entity-tags-v1', relationId: null },
      { sourceId: ids.technology, conceptId: ids.chemistry, owner: 'entity-tags-v1', relationId: null },
    ]);
    expect((await graphCounts()).find((row) => row.conceptId === ids.chemistry)).toMatchObject({
      entityCount: 2,
    });
    expect(firestoreCount(ids.chemistry).entityCount).toBe(2);

    await projectEntityTagConceptsToNeo4j(
      ids.company,
      buildEntityTagConceptProjection([], [], [ids.quantum])
    );

    expect(await links()).toEqual([
      { sourceId: ids.company, conceptId: ids.chemistry, owner: null, relationId: ids.curated },
      { sourceId: ids.technology, conceptId: ids.ai, owner: 'entity-tags-v1', relationId: null },
      { sourceId: ids.technology, conceptId: ids.chemistry, owner: 'entity-tags-v1', relationId: null },
    ]);

    // Generic/Technology deletion paths capture all affected Concepts before
    // DETACH DELETE, then repair both count stores from the surviving graph.
    const captured = await captureEntityTagConceptIdsFromNeo4j(ids.company);
    await runWriteTransaction('MATCH (entity:Entity {id: $entityId}) DETACH DELETE entity', {
      entityId: ids.company,
    });
    await reconcileConceptEntityCounts(captured);
    expect((await graphCounts()).find((row) => row.conceptId === ids.chemistry)).toMatchObject({
      entityCount: 1,
    });
    expect(firestoreCount(ids.chemistry).entityCount).toBe(1);

    const conceptCount = await runReadTransaction<{ count: number }>(
      `MATCH (concept:Concept)
       WHERE concept.id IN $conceptIds
       RETURN count(concept) AS count`,
      { conceptIds: [ids.ai, ids.quantum, ids.chemistry] }
    );
    expect(conceptCount.records).toEqual([{ count: 3 }]);
  }, 60_000);
});
