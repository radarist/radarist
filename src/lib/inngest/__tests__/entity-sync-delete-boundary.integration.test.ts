/**
 * Disposable real-Neo4j proof for the entity worker's source-of-truth boundary.
 * Skipped unless the guarded graph integration lane is explicitly enabled.
 */

const TEST_PREFIX = 'entity-sync-boundary-test-';
const mockFirestoreFixtures = new Map<string, Record<string, unknown>>();
const mockSleepHook: { current: (() => void | Promise<void>) | null } = { current: null };
const mockStepSleep = jest.fn(async () => {
  await mockSleepHook.current?.();
});

// The global Jest setup stubs this worker for broad unit suites; this guarded
// integration file exercises the real handler against disposable Neo4j.
jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => ({
      doc: jest.fn((id: string) => ({
        get: jest.fn(async () => {
          const fixture = mockFirestoreFixtures.get(`${collectionName}/${id}`);
          return { id, exists: fixture !== undefined, data: () => fixture };
        }),
        update: jest.fn(async (updates: Record<string, unknown>) => {
          const key = `${collectionName}/${id}`;
          const fixture = mockFirestoreFixtures.get(key);
          if (!fixture) throw new Error(`Missing integration fixture ${key}`);
          mockFirestoreFixtures.set(key, { ...fixture, ...updates });
        }),
      })),
    })),
  },
}));
jest.mock('@/lib/graph/query-cache', () => ({ invalidateCachesForEntity: jest.fn() }));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'integration-test' })),
}));
// GRAPH-054 owns the tag/Concept projection and its real Firestore contract.
// This source-boundary suite keeps that collaborator neutral so it can prove
// entity handoff replay against its deliberately small Firestore fixture.
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  captureEntityTagConceptIdsFromNeo4j: jest.fn(async () => []),
  reconcileEntityTagConcepts: jest.fn(async () => ({
    tags: [],
    concepts: [],
    conceptIds: [],
    addedConceptIds: [],
    removedConceptIds: [],
    conceptIdsChanged: false,
  })),
  reconcileConceptEntityCounts: jest.fn(async () => []),
  projectEntityTagConceptsToNeo4j: jest.fn(async () => ({ relationshipsCreated: 0 })),
}));
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { data },
          step: {
            run: async (_name: string, fn: () => unknown) => await fn(),
            sleep: mockStepSleep,
          },
        }),
    })),
    send: jest.fn().mockResolvedValue({ ids: ['integration-completion'] }),
  },
}));

import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
} from '../../../../scripts/testing/run-neo4j-integration';
import { syncUnifiedEntityToNeo4jJob } from '../functions/sync-entity-to-neo4j';
import { syncTechnologyToNeo4jJob } from '../functions/sync-technology-to-neo4j';
import { syncEntityDocumentLinkToNeo4jJob } from '../functions/sync-entity-document-link-to-neo4j';

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const unifiedJob = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;
const technologyJob = syncTechnologyToNeo4jJob as unknown as ExecutableJob;
const entityDocumentLinkJob = syncEntityDocumentLinkToNeo4jJob as unknown as ExecutableJob;
const describeIntegration = isDisposableNeo4jIntegrationSuiteEnabled() ? describe : describe.skip;

async function cleanup(): Promise<void> {
  assertDisposableNeo4jIntegrationSuiteTarget();
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

async function nodeCount(id: string): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    'MATCH (node {id: $id}) RETURN count(node) AS count',
    { id }
  );
  return result.records[0]?.count ?? 0;
}

async function companyProjection(id: string): Promise<{
  count: number;
  names: string[];
  descriptions: string[];
  relationships: number;
}> {
  const result = await runReadTransaction<{
    count: number;
    names: string[];
    descriptions: string[];
    relationships: number;
  }>(
    `MATCH (company:Company {id: $id})
     OPTIONAL MATCH (company)-[relationship]-()
     RETURN count(DISTINCT company) AS count,
            collect(DISTINCT company.name) AS names,
            collect(DISTINCT company.description) AS descriptions,
            count(relationship) AS relationships`,
    { id }
  );
  return result.records[0] ?? { count: 0, names: [], descriptions: [], relationships: 0 };
}

async function linkProjectionCount(linkId: string): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    'MATCH ()-[relationship {linkId: $linkId}]->() RETURN count(relationship) AS count',
    { linkId }
  );
  return result.records[0]?.count ?? 0;
}

describeIntegration('entity sync source boundary (disposable Neo4j)', () => {
  beforeAll(() => {
    assertDisposableNeo4jIntegrationSuiteTarget();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFirestoreFixtures.clear();
    mockSleepHook.current = null;
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(closeDriver);

  it('converges replayed Company create and update handoffs without duplicate graph state', async () => {
    const id = `${TEST_PREFIX}write-convergence-company`;
    const sourceKey = `companies/${id}`;
    mockFirestoreFixtures.set(sourceKey, {
      id,
      name: 'Committed Company v1',
      description: 'First authoritative Firestore state.',
      tags: [],
      createdAt: 100,
      updatedAt: 100,
    });

    await unifiedJob.execute({ operation: 'create', entityType: 'company', entityId: id });
    await unifiedJob.execute({ operation: 'create', entityType: 'company', entityId: id });
    expect(await companyProjection(id)).toEqual({
      count: 1,
      names: ['Committed Company v1'],
      descriptions: ['First authoritative Firestore state.'],
      relationships: 0,
    });

    mockFirestoreFixtures.set(sourceKey, {
      id,
      name: 'Committed Company v2',
      description: 'Updated authoritative Firestore state.',
      tags: [],
      createdAt: 100,
      updatedAt: 200,
    });
    await unifiedJob.execute({ operation: 'update', entityType: 'company', entityId: id });
    await unifiedJob.execute({ operation: 'update', entityType: 'company', entityId: id });

    expect(await companyProjection(id)).toEqual({
      count: 1,
      names: ['Committed Company v2'],
      descriptions: ['Updated authoritative Firestore state.'],
      relationships: 0,
    });
  });

  it('retains the graph projection while source deletion failed, then converges on a fresh attempt', async () => {
    const id = `${TEST_PREFIX}company`;
    const sourceKey = `companies/${id}`;
    mockFirestoreFixtures.set(sourceKey, {
      id,
      name: 'Retained source company',
      description: 'The graph node must remain while Firestore still owns this entity.',
      createdAt: 100,
      updatedAt: 100,
    });

    await unifiedJob.execute({ operation: 'create', entityType: 'company', entityId: id });
    expect(await nodeCount(id)).toBe(1);

    await expect(
      unifiedJob.execute({ operation: 'delete', entityType: 'company', entityId: id })
    ).rejects.toThrow('while its Firestore source still exists');
    expect(await nodeCount(id)).toBe(1);

    mockFirestoreFixtures.delete(sourceKey);
    await unifiedJob.execute({ operation: 'delete', entityType: 'company', entityId: id });
    expect(await nodeCount(id)).toBe(0);

    const delayedOldUpdate = await unifiedJob.execute({
      operation: 'update',
      entityType: 'company',
      entityId: id,
    });
    expect(delayedOldUpdate).toMatchObject({ success: true, skipped: true });
    expect(await nodeCount(id)).toBe(0);
  });

  it('waits through delayed source removal before deleting a technology projection', async () => {
    const id = `${TEST_PREFIX}technology`;
    const propertyPlacementId = `${TEST_PREFIX}placement-property`;
    const edgePlacementId = `${TEST_PREFIX}placement-edge`;
    const unrelatedPlacementId = `${TEST_PREFIX}placement-unrelated`;
    const sourceKey = `technologies/${id}`;
    mockFirestoreFixtures.set(sourceKey, {
      id,
      name: 'Delayed deletion technology',
      slug: 'delayed-deletion-technology',
      description: 'Disposable worker-boundary fixture.',
      createdBy: 'integration-test',
      createdAt: 100,
      updatedAt: 100,
    });

    await technologyJob.execute({ operation: 'create', technologyId: id });
    expect(await nodeCount(id)).toBe(1);

    // Exercise both ownership recovery paths: canonical technologyId property
    // and a legacy/partial PLACES-only projection. An unrelated placement is
    // the cross-fixture mutation guard.
    await runWriteTransaction(
      `MATCH (technology {id: $technologyId})
       CREATE (:RadarPlacement {id: $propertyPlacementId, technologyId: $technologyId})
       CREATE (edgePlacement:RadarPlacement {id: $edgePlacementId})-[:PLACES]->(technology)
       CREATE (:RadarPlacement {id: $unrelatedPlacementId, technologyId: 'other-technology'})`,
      { technologyId: id, propertyPlacementId, edgePlacementId, unrelatedPlacementId }
    );

    mockSleepHook.current = () => {
      mockFirestoreFixtures.delete(sourceKey);
      mockSleepHook.current = null;
    };
    await technologyJob.execute({ operation: 'delete', technologyId: id });

    expect(mockStepSleep).toHaveBeenCalledWith('wait-for-source-delete-0', '1s');
    expect(await nodeCount(id)).toBe(0);
    expect(await nodeCount(propertyPlacementId)).toBe(0);
    expect(await nodeCount(edgePlacementId)).toBe(0);
    expect(await nodeCount(unrelatedPlacementId)).toBe(1);
  });

  it('atomically replaces duplicate and stale same-link projections with the authoritative edge', async () => {
    const linkId = `${TEST_PREFIX}document-link`;
    const currentEntityId = `${TEST_PREFIX}link-company`;
    const currentDocumentId = `${TEST_PREFIX}link-document`;
    const staleEntityId = `${TEST_PREFIX}stale-technology`;
    const staleDocumentId = `${TEST_PREFIX}stale-document`;
    const sourceKey = `entityDocumentLinks/${linkId}`;
    mockFirestoreFixtures.set(sourceKey, {
      workspaceId: 'default',
      entityType: 'company',
      entityId: currentEntityId,
      documentId: currentDocumentId,
      relationshipType: 'evidence',
      relevance: 'high',
      tags: ['authoritative'],
      note: 'Current source',
      aiSuggested: false,
      createdAt: 100,
      createdBy: 'integration-test',
      updatedAt: 200,
      graphSyncStatus: 'pending',
    });

    await runWriteTransaction(
      `CREATE (currentEntity:Company {id: $currentEntityId})
       CREATE (currentDocument:Document {id: $currentDocumentId})
       CREATE (staleEntity:Technology {id: $staleEntityId})
       CREATE (staleDocument:Document {id: $staleDocumentId})
       CREATE (staleEntity)-[:DOCUMENTED_BY {linkId: $linkId, createdAt: 10}]->(staleDocument)
       CREATE (currentEntity)-[:DOCUMENTED_BY {linkId: $linkId, createdAt: 20}]->(currentDocument)
       CREATE (currentEntity)-[:DOCUMENTED_BY {linkId: $linkId, createdAt: 30}]->(currentDocument)`,
      { linkId, currentEntityId, currentDocumentId, staleEntityId, staleDocumentId }
    );
    expect(await linkProjectionCount(linkId)).toBe(3);

    await entityDocumentLinkJob.execute({ operation: 'update', linkId });

    const projection = await runReadTransaction<{
      count: number;
      relationshipTypes: string[];
      sourceIds: string[];
      targetIds: string[];
      relevances: string[];
      tags: string[][];
      notes: string[];
      createdAts: number[];
    }>(
      `MATCH (source)-[relationship {linkId: $linkId}]->(target)
       RETURN count(relationship) AS count,
              collect(type(relationship)) AS relationshipTypes,
              collect(source.id) AS sourceIds,
              collect(target.id) AS targetIds,
              collect(relationship.relevance) AS relevances,
              collect(relationship.tags) AS tags,
              collect(relationship.note) AS notes,
              collect(relationship.createdAt) AS createdAts`,
      { linkId }
    );
    expect(projection.records[0]).toMatchObject({
      count: 1,
      relationshipTypes: ['HAS_EVIDENCE'],
      sourceIds: [currentEntityId],
      targetIds: [currentDocumentId],
      relevances: ['high'],
      tags: [['authoritative']],
      notes: ['Current source'],
    });
    expect([10, 20, 30]).toContain(projection.records[0]?.createdAts[0]);

    mockFirestoreFixtures.delete(sourceKey);
    const delayedUpdate = await entityDocumentLinkJob.execute({ operation: 'update', linkId });
    expect(delayedUpdate).toMatchObject({ success: true, skipped: true });
    expect(await linkProjectionCount(linkId)).toBe(1);

    await entityDocumentLinkJob.execute({
      operation: 'delete',
      linkId,
      entityId: currentEntityId,
      documentId: currentDocumentId,
      entityType: 'company',
      relationshipType: 'evidence',
    });
    expect(await linkProjectionCount(linkId)).toBe(0);
  });
});
