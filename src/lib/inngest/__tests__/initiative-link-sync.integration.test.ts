/** Guarded real-Neo4j acceptance for authoritative Initiative structural links. */

const TEST_PREFIX = 'graph053-initiative-links-';
const mockFirestoreFixtures = new Map<string, Map<string, Record<string, unknown>>>();

function mockSetFirestoreFixture(
  collectionName: string,
  documentId: string,
  data: Record<string, unknown>
): void {
  const collection = mockFirestoreFixtures.get(collectionName) ?? new Map();
  collection.set(documentId, data);
  mockFirestoreFixtures.set(collectionName, collection);
}

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => ({
      doc: jest.fn((documentId: string) => ({
        get: jest.fn(async () => {
          const fixture = mockFirestoreFixtures.get(collectionName)?.get(documentId);
          return {
            exists: fixture !== undefined,
            id: documentId,
            data: () => fixture,
          };
        }),
      })),
      where: jest.fn((field: string, operator: string, value: string) => ({
        limit: jest.fn((limit: number) => ({
          get: jest.fn(async () => {
            if (operator !== 'array-contains') throw new Error(`Unexpected operator ${operator}`);
            const docs = [...(mockFirestoreFixtures.get(collectionName)?.entries() ?? [])]
              .filter(([, fixture]) => {
                const fieldValue = fixture[field];
                return Array.isArray(fieldValue) && fieldValue.includes(value);
              })
              .slice(0, limit)
              .map(([id, fixture]) => ({ id, data: () => fixture }));
            return { size: docs.length, docs };
          }),
        })),
      })),
    })),
  },
}));
jest.mock('@/lib/graph/query-cache', () => ({ invalidateCachesForEntity: jest.fn() }));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'integration-test' })),
}));
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  reconcileEntityTagConcepts: jest.fn(async () => ({
    tags: [],
    concepts: [],
    conceptIds: [],
    addedConceptIds: [],
    removedConceptIds: [],
    conceptIdsChanged: false,
  })),
  projectEntityTagConceptsToNeo4j: jest.fn(async () => ({ relationshipsCreated: 0 })),
  captureEntityTagConceptIdsFromNeo4j: jest.fn(async () => []),
  reconcileConceptEntityCounts: jest.fn(async () => []),
}));
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { id: 'graph053-initiative-links-event', data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn().mockResolvedValue({ ids: ['graph053-initiative-links-accepted'] }),
  },
}));

import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { INITIATIVE_LINK_PROJECTION_OWNER } from '@/lib/graph/initiative-link-projection';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
} from '../../../../scripts/testing/run-neo4j-integration';
import { syncUnifiedEntityToNeo4jJob } from '../functions/sync-entity-to-neo4j';
import { inngest } from '../client';

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<{
    success: boolean;
    implicitRelationshipFailures?: number;
    implicitRelationshipMissingTargets?: { strategyIds: string[]; painPointIds: string[] };
  }>;
}

const job = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;
const describeIntegration = isDisposableNeo4jIntegrationSuiteEnabled() ? describe : describe.skip;

const ids = {
  initiative: `${TEST_PREFIX}initiative`,
  strategy1: `${TEST_PREFIX}strategy-1`,
  strategy2: `${TEST_PREFIX}strategy-2`,
  pain1: `${TEST_PREFIX}pain-1`,
  pain2: `${TEST_PREFIX}pain-2`,
  missingStrategy: `${TEST_PREFIX}missing-strategy`,
  missingPain: `${TEST_PREFIX}missing-pain`,
};

async function cleanup(): Promise<void> {
  assertDisposableNeo4jIntegrationSuiteTarget();
  await runWriteTransaction('MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node', {
    prefix: TEST_PREFIX,
  });
}

async function project(): Promise<Awaited<ReturnType<ExecutableJob['execute']>>> {
  return job.execute({ operation: 'update', entityType: 'initiative', entityId: ids.initiative });
}

async function edgeRows(): Promise<
  Array<{ sourceId: string; targetId: string; type: string; owner: string | null; relationId: string | null; claimId: string | null }>
> {
  const result = await runReadTransaction<{
    sourceId: string;
    targetId: string;
    type: string;
    owner: string | null;
    relationId: string | null;
    claimId: string | null;
  }>(
    `MATCH (source)-[edge:IMPLEMENTS|DRIVES]->(target)
     WHERE source.id STARTS WITH $prefix AND target.id STARTS WITH $prefix
     RETURN source.id AS sourceId, target.id AS targetId, type(edge) AS type,
            edge.projectionOwner AS owner, edge.relationId AS relationId, edge.claimId AS claimId
     ORDER BY type, sourceId, targetId, owner`,
    { prefix: TEST_PREFIX }
  );
  return result.records;
}

describeIntegration('Initiative structural link sync (real Neo4j)', () => {
  beforeAll(async () => {
    assertDisposableNeo4jIntegrationSuiteTarget();
    mockFirestoreFixtures.clear();
    await cleanup();
    await runWriteTransaction(
      `CREATE (:Entity:Strategy {id: $strategy1})
       CREATE (:Entity:Strategy {id: $strategy2})
       CREATE (:Entity:PainPoint {id: $pain1})
       CREATE (:Entity:PainPoint {id: $pain2})`,
      ids
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDriver();
  }, 60_000);

  it('converges add/change/remove/replay while retaining explicit edges and reporting missing targets', async () => {
    mockSetFirestoreFixture('initiatives', ids.initiative, {
      id: ids.initiative,
      name: 'Initiative projection acceptance',
      linkedStrategyIds: [ids.strategy1, ids.missingStrategy, ids.strategy1],
      linkedPainPointIds: [ids.pain1, ids.missingPain, ids.pain1],
      createdAt: 100,
      updatedAt: 200,
    });

    (inngest.send as jest.Mock).mockClear();
    await expect(project()).rejects.toThrow('graph targets are not ready');
    expect(inngest.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/entity.sync.completed',
        data: expect.objectContaining({ entityId: ids.initiative }),
      })
    );
    expect(await edgeRows()).toEqual([
      {
        sourceId: ids.pain1,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.strategy1,
        type: 'IMPLEMENTS',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
    ]);

    // Target arrival must durably replay the dependent Initiative. This is the
    // real blank-workspace order: a user can author the Initiative before its
    // referenced Strategy/Pain Point reach Neo4j, without needing to touch the
    // Initiative again after those targets arrive.
    mockSetFirestoreFixture('strategies', ids.missingStrategy, {
      id: ids.missingStrategy,
      name: 'Late strategy',
      tags: [],
      createdAt: 210,
      updatedAt: 210,
    });
    mockSetFirestoreFixture('painPoints', ids.missingPain, {
      id: ids.missingPain,
      title: 'Late pain point',
      tags: [],
      createdAt: 220,
      updatedAt: 220,
    });
    (inngest.send as jest.Mock).mockClear();
    await job.execute({ operation: 'create', entityType: 'strategy', entityId: ids.missingStrategy });
    await job.execute({ operation: 'create', entityType: 'painPoint', entityId: ids.missingPain });

    const replayEvents = (inngest.send as jest.Mock).mock.calls
      .map(([event]) => event)
      .filter((event) => event?.name === 'app/unified-entity.sync.requested');
    expect(replayEvents).toHaveLength(2);
    expect(replayEvents.map((event) => event.data)).toEqual([
      { operation: 'update', entityType: 'initiative', entityId: ids.initiative },
      { operation: 'update', entityType: 'initiative', entityId: ids.initiative },
    ]);

    (inngest.send as jest.Mock).mockClear();
    for (const event of replayEvents) {
      await expect(job.execute(event.data)).resolves.toMatchObject({
        success: true,
        implicitRelationshipFailures: 0,
      });
    }
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/entity.sync.completed',
        data: expect.objectContaining({ entityId: ids.initiative }),
      })
    );
    expect(await edgeRows()).toEqual([
      {
        sourceId: ids.missingPain,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.pain1,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.missingStrategy,
        type: 'IMPLEMENTS',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.strategy1,
        type: 'IMPLEMENTS',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
    ]);

    await runWriteTransaction(
      `MATCH (initiative:Initiative {id: $initiative})
       MATCH (strategy2:Strategy {id: $strategy2})
       MATCH (pain2:PainPoint {id: $pain2})
       CREATE (initiative)-[:IMPLEMENTS {relationId: $relationId}]->(strategy2)
       CREATE (pain2)-[:DRIVES {claimId: $claimId}]->(initiative)`,
      { ...ids, relationId: `${TEST_PREFIX}curated`, claimId: `${TEST_PREFIX}asserted` }
    );

    mockSetFirestoreFixture('initiatives', ids.initiative, {
      id: ids.initiative,
      name: 'Initiative projection acceptance',
      linkedStrategyIds: [ids.strategy2],
      linkedPainPointIds: [ids.pain2],
      createdAt: 100,
      updatedAt: 300,
    });
    await expect(project()).resolves.toMatchObject({ success: true, implicitRelationshipFailures: 0 });
    await expect(project()).resolves.toMatchObject({ success: true, implicitRelationshipFailures: 0 });

    expect(await edgeRows()).toEqual([
      {
        sourceId: ids.pain2,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.pain2,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: null,
        relationId: null,
        claimId: `${TEST_PREFIX}asserted`,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.strategy2,
        type: 'IMPLEMENTS',
        owner: INITIATIVE_LINK_PROJECTION_OWNER,
        relationId: null,
        claimId: null,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.strategy2,
        type: 'IMPLEMENTS',
        owner: null,
        relationId: `${TEST_PREFIX}curated`,
        claimId: null,
      },
    ]);

    mockSetFirestoreFixture('initiatives', ids.initiative, {
      id: ids.initiative,
      name: 'Initiative projection acceptance',
      linkedStrategyIds: [],
      linkedPainPointIds: [],
      createdAt: 100,
      updatedAt: 400,
    });
    await expect(project()).resolves.toMatchObject({ success: true, implicitRelationshipFailures: 0 });
    expect(await edgeRows()).toEqual([
      {
        sourceId: ids.pain2,
        targetId: ids.initiative,
        type: 'DRIVES',
        owner: null,
        relationId: null,
        claimId: `${TEST_PREFIX}asserted`,
      },
      {
        sourceId: ids.initiative,
        targetId: ids.strategy2,
        type: 'IMPLEMENTS',
        owner: null,
        relationId: `${TEST_PREFIX}curated`,
        claimId: null,
      },
    ]);
  }, 60_000);
});
