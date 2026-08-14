/**
 * Real-Neo4j proof for Signal alignment projection.
 *
 * Skipped by default. Run only through the guarded disposable integration
 * lane with a disposable Neo4j target.
 */

const mockSignalFixture: { current: Record<string, unknown> | null } = { current: null };

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockSignalFixture.current !== null,
          data: () => mockSignalFixture.current,
        })),
      })),
      where: jest.fn(() => ({
        get: jest.fn(async () => ({ docs: [] })),
      })),
    })),
  },
}));

jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
}));

jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'integration-test' })),
}));

// Alignment projection is the contract under test. Tag-to-Concept convergence
// is exercised separately against real Neo4j, so keep this fixture independent
// from the Firestore transaction surface that mapper owns.
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  reconcileEntityTagConcepts: jest.fn(async () => ({
    tags: [],
    concepts: [],
    conceptIds: [],
    addedConceptIds: [],
    removedConceptIds: [],
    conceptIdsChanged: false,
  })),
  projectEntityTagConceptsToNeo4j: jest.fn(async () => ({
    relationshipsCreated: 0,
    countReceipts: [],
  })),
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
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

import {
  checkHealth,
  closeDriver,
  runReadTransaction,
  runWriteTransaction,
} from '@/lib/graph/neo4j-client';
import { syncUnifiedEntityToNeo4jJob } from '../functions/sync-entity-to-neo4j';

const TEST_PREFIX = 'graph035-signal-alignment-test-';
const SIGNAL_ID = `${TEST_PREFIX}signal`;
const STRATEGY_ID = `${TEST_PREFIX}strategy`;

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<{ success: boolean }>;
}

const job = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(
    `MATCH (n)
     WHERE n.id STARTS WITH $prefix
     DETACH DELETE n`,
    { prefix: TEST_PREFIX }
  );
}

async function createStrategy(): Promise<void> {
  await runWriteTransaction(
    `CREATE (:Entity:Strategy {id: $strategyId, name: 'Alignment integration strategy'})`,
    { strategyId: STRATEGY_ID }
  );
}

async function projectSignal(alignmentScore: number): Promise<void> {
  mockSignalFixture.current = {
    id: SIGNAL_ID,
    title: 'Alignment integration signal',
    type: 'news',
    status: 'Approved',
    alignmentScore,
    alignedStrategies: [STRATEGY_ID],
    linkedEntities: { technologies: [], companies: [], useCases: [] },
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  };

  const result = await job.execute({
    operation: 'update',
    entityType: 'signal',
    entityId: SIGNAL_ID,
  });
  expect(result.success).toBe(true);
}

async function expectProjectedScore(expected: number): Promise<void> {
  const result = await runReadTransaction<{
    nodeScore: number;
    properties: string;
    edgeScore: number;
  }>(
    `MATCH (signal:Signal {id: $signalId})-[edge:ALIGNS_WITH]->(strategy:Strategy {id: $strategyId})
     RETURN signal.alignmentScore AS nodeScore,
            signal.properties AS properties,
            edge.alignmentScore AS edgeScore`,
    { signalId: SIGNAL_ID, strategyId: STRATEGY_ID }
  );

  expect(result.records).toHaveLength(1);
  expect(result.records[0].nodeScore).toBe(expected);
  expect(result.records[0].edgeScore).toBe(expected);
  const properties = JSON.parse(result.records[0].properties) as Record<string, unknown>;
  expect(properties.alignmentScore).toBe(expected);
  expect(properties.alignedStrategies).toEqual([STRATEGY_ID]);
  expect(properties.linkedEntities).toEqual({ technologies: [], companies: [], useCases: [] });
}

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('Signal alignment sync (real Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(`[Integration Tests] disposable Neo4j is not healthy: ${health.error ?? 'unknown error'}`);
    }
    await cleanupFixtures();
    await createStrategy();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await closeDriver();
  }, 60_000);

  it('projects nonzero and zero scores onto the node, one-pass JSON, and field-derived edge', async () => {
    await projectSignal(84);
    await expectProjectedScore(84);

    await projectSignal(0);
    await expectProjectedScore(0);
  });
});
