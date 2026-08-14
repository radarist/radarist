/**
 * Real-Neo4j regression for Technology implicit-link ownership.
 *
 * Skipped by default. Run only through the guarded disposable Neo4j lane.
 */

const TEST_PREFIX = 'technology-link-ownership-test-';
const TECHNOLOGY_ID = `${TEST_PREFIX}technology`;

const mockTechnologyFixture: { current: Record<string, unknown> | null } = { current: null };

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockTechnologyFixture.current !== null,
          data: () => mockTechnologyFixture.current,
        })),
      })),
    })),
  },
}));

jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: true, dimensions: 768 })),
}));

jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
}));

// This acceptance owns company/use-case link preservation. The canonical tag
// projection has its own real-Neo4j concurrency suite; isolate it here so this
// fixture does not need to impersonate the full Firestore transaction API.
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  reconcileEntityTagConcepts: jest.fn(async () => ({
    tags: mockTechnologyFixture.current?.tags ?? [],
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

jest.mock('@/lib/graph', () => {
  const neo4jClient = jest.requireActual('@/lib/graph/neo4j-client');
  return {
    checkHealth: neo4jClient.checkHealth,
    runReadTransaction: neo4jClient.runReadTransaction,
    runWriteTransaction: neo4jClient.runWriteTransaction,
    deleteEntityFromGraph: jest.fn(),
  };
});

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn(
      (
        config: unknown,
        trigger: unknown,
        handler: (context: {
          event: { data: unknown };
          step: { run: (_name: string, fn: () => unknown) => Promise<unknown> };
        }) => Promise<unknown>
      ) => ({
        config,
        trigger,
        execute: (data: unknown) =>
          handler({
            event: { data },
            step: { run: async (_name: string, fn: () => unknown) => fn() },
          }),
      })
    ),
    send: jest.fn(async () => ({ ids: ['technology-link-ownership-completion'] })),
  },
  safeSendEvent: jest.fn(),
}));

import {
  checkHealth,
  closeDriver,
  runReadTransaction,
  runWriteTransaction,
} from '@/lib/graph/neo4j-client';
import { syncTechnologyToNeo4jJob } from '../sync-technology-to-neo4j';

interface ExecutableTechnologySync {
  execute(data: { operation: 'update'; technologyId: string }): Promise<{
    success: boolean;
    operation: string;
  }>;
}

const executableJob = syncTechnologyToNeo4jJob as unknown as ExecutableTechnologySync;
const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

const ids = {
  oldImplicitCompany: `${TEST_PREFIX}old-implicit-company`,
  newImplicitCompany: `${TEST_PREFIX}new-implicit-company`,
  explicitCompany: `${TEST_PREFIX}explicit-company`,
  assertedCompany: `${TEST_PREFIX}asserted-company`,
  oldImplicitUseCase: `${TEST_PREFIX}old-implicit-use-case`,
  newImplicitUseCase: `${TEST_PREFIX}new-implicit-use-case`,
  explicitUseCase: `${TEST_PREFIX}explicit-use-case`,
  assertedUseCase: `${TEST_PREFIX}asserted-use-case`,
  companyRelation: `${TEST_PREFIX}company-relation`,
  useCaseRelation: `${TEST_PREFIX}use-case-relation`,
  companyClaim: `${TEST_PREFIX}company-claim`,
  useCaseClaim: `${TEST_PREFIX}use-case-claim`,
};

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE coalesce(toString(node.id), '') STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

async function expectNoOwnedResidue(): Promise<void> {
  const result = await runReadTransaction<{ nodes: number; relationships: number }>(
    `OPTIONAL MATCH (node)
     WHERE coalesce(toString(node.id), '') STARTS WITH $prefix
     WITH count(node) AS nodes
     OPTIONAL MATCH ()-[relationship]->()
     WHERE coalesce(toString(relationship.relationId), '') STARTS WITH $prefix
        OR coalesce(toString(relationship.claimId), '') STARTS WITH $prefix
     RETURN nodes, count(relationship) AS relationships`,
    { prefix: TEST_PREFIX }
  );
  expect(result.records[0]).toEqual({ nodes: 0, relationships: 0 });
}

describeIntegration('Technology link ownership (disposable Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(`[Integration Tests] disposable Neo4j is not healthy: ${health.error ?? 'unknown error'}`);
    }
    await cleanupFixtures();
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupFixtures();
      await expectNoOwnedResidue();
    } finally {
      await closeDriver();
    }
  }, 60_000);

  it('replaces implicit links without deleting relation- or assertion-owned edges', async () => {
    await runWriteTransaction(
      `CREATE (technology:Entity:Technology {
         id: $technologyId, entityType: 'technology', name: 'Ownership technology'
       })
       CREATE (oldImplicitCompany:Entity:Company {id: $oldImplicitCompany, entityType: 'company'})
       CREATE (newImplicitCompany:Entity:Company {id: $newImplicitCompany, entityType: 'company'})
       CREATE (explicitCompany:Entity:Company {id: $explicitCompany, entityType: 'company'})
       CREATE (assertedCompany:Entity:Company {id: $assertedCompany, entityType: 'company'})
       CREATE (oldImplicitUseCase:Entity:UseCase {id: $oldImplicitUseCase, entityType: 'useCase'})
       CREATE (newImplicitUseCase:Entity:UseCase {id: $newImplicitUseCase, entityType: 'useCase'})
       CREATE (explicitUseCase:Entity:UseCase {id: $explicitUseCase, entityType: 'useCase'})
       CREATE (assertedUseCase:Entity:UseCase {id: $assertedUseCase, entityType: 'useCase'})
       CREATE (companyClaim:Assertion {id: $companyClaim})
       CREATE (useCaseClaim:Assertion {id: $useCaseClaim})

       CREATE (technology)-[:DEVELOPED_BY]->(oldImplicitCompany)
       CREATE (technology)-[:DEVELOPED_BY {relationId: $companyRelation}]->(explicitCompany)
       CREATE (technology)-[:DEVELOPED_BY {claimId: $companyClaim}]->(assertedCompany)
       CREATE (companyClaim)-[:ABOUT_SUBJECT]->(technology)
       CREATE (companyClaim)-[:ABOUT_OBJECT]->(assertedCompany)

       CREATE (technology)-[:ENABLES]->(oldImplicitUseCase)
       CREATE (technology)-[:ENABLES {relationId: $useCaseRelation}]->(explicitUseCase)
       CREATE (technology)-[:ENABLES {claimId: $useCaseClaim}]->(assertedUseCase)
       CREATE (useCaseClaim)-[:ABOUT_SUBJECT]->(technology)
       CREATE (useCaseClaim)-[:ABOUT_OBJECT]->(assertedUseCase)`,
      { technologyId: TECHNOLOGY_ID, ...ids }
    );

    mockTechnologyFixture.current = {
      id: TECHNOLOGY_ID,
      name: 'Ownership technology after research',
      slug: 'ownership-technology',
      description: 'Routine research updates must not erase curated graph relations.',
      category: 'platform',
      tags: ['research-updated'],
      linkedCompanies: [ids.newImplicitCompany],
      linkedUseCases: [ids.newImplicitUseCase],
      approvalStatus: 'pending',
      createdBy: 'test-user',
      createdAt: 1,
      updatedAt: 2,
    };

    await expect(
      executableJob.execute({ operation: 'update', technologyId: TECHNOLOGY_ID })
    ).resolves.toMatchObject({ success: true, operation: 'updated' });

    const result = await runReadTransaction<{
      oldImplicitCompanies: number;
      newImplicitCompanies: number;
      explicitCompanies: number;
      assertedCompanies: number;
      oldImplicitUseCases: number;
      newImplicitUseCases: number;
      explicitUseCases: number;
      assertedUseCases: number;
      assertionCount: number;
    }>(
      `MATCH (technology:Technology {id: $technologyId})
       OPTIONAL MATCH (technology)-[relationship]->(target)
       WITH technology,
            sum(CASE WHEN type(relationship) = 'DEVELOPED_BY' AND target.id = $oldImplicitCompany
                     AND relationship.relationId IS NULL AND relationship.claimId IS NULL THEN 1 ELSE 0 END)
              AS oldImplicitCompanies,
            sum(CASE WHEN type(relationship) = 'DEVELOPED_BY' AND target.id = $newImplicitCompany
                     AND relationship.relationId IS NULL AND relationship.claimId IS NULL THEN 1 ELSE 0 END)
              AS newImplicitCompanies,
            sum(CASE WHEN relationship.relationId = $companyRelation THEN 1 ELSE 0 END) AS explicitCompanies,
            sum(CASE WHEN relationship.claimId = $companyClaim THEN 1 ELSE 0 END) AS assertedCompanies,
            sum(CASE WHEN type(relationship) = 'ENABLES' AND target.id = $oldImplicitUseCase
                     AND relationship.relationId IS NULL AND relationship.claimId IS NULL THEN 1 ELSE 0 END)
              AS oldImplicitUseCases,
            sum(CASE WHEN type(relationship) = 'ENABLES' AND target.id = $newImplicitUseCase
                     AND relationship.relationId IS NULL AND relationship.claimId IS NULL THEN 1 ELSE 0 END)
              AS newImplicitUseCases,
            sum(CASE WHEN relationship.relationId = $useCaseRelation THEN 1 ELSE 0 END) AS explicitUseCases,
            sum(CASE WHEN relationship.claimId = $useCaseClaim THEN 1 ELSE 0 END) AS assertedUseCases
       OPTIONAL MATCH (assertion:Assertion)
       WHERE assertion.id IN [$companyClaim, $useCaseClaim]
       RETURN oldImplicitCompanies, newImplicitCompanies, explicitCompanies, assertedCompanies,
              oldImplicitUseCases, newImplicitUseCases, explicitUseCases, assertedUseCases,
              count(assertion) AS assertionCount`,
      { technologyId: TECHNOLOGY_ID, ...ids }
    );

    expect(result.records[0]).toEqual({
      oldImplicitCompanies: 0,
      newImplicitCompanies: 1,
      explicitCompanies: 1,
      assertedCompanies: 1,
      oldImplicitUseCases: 0,
      newImplicitUseCases: 1,
      explicitUseCases: 1,
      assertedUseCases: 1,
      assertionCount: 2,
    });
  }, 60_000);
});
