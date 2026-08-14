/**
 * Real-Neo4j proof for radar graph deletion. Skipped unless the guarded
 * disposable integration lane explicitly enables NEO4J_INTEGRATION_TESTS.
 */

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      async execute(eventData: Record<string, unknown>) {
        const step = { run: async <T>(_name: string, fn: () => Promise<T>) => await fn() };
        return await handler({ event: { data: eventData }, step });
      },
    })),
    send: jest.fn().mockResolvedValue({ ids: ['integration-completion'] }),
  },
}));

// The graph barrel exposes an optional Firestore fallback service. This proof
// exercises only the real Neo4j boundary, so keep the browser Firebase SDK out
// of the Node integration process.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { deleteRadarFromNeo4jJob } from '../functions/delete-radar-from-neo4j';

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;
const PREFIX = 'radar-delete-integration-';

async function cleanup(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: PREFIX }
  );
}

describeIntegration('radar graph deletion (disposable Neo4j)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(closeDriver);

  it('removes graph-only placements and owned assertion topology, then replays idempotently', async () => {
    const radarId = `${PREFIX}radar`;
    const placementId = `${PREFIX}placement`;
    const assertionId = `${PREFIX}assertion`;
    const evidenceId = `${PREFIX}evidence`;
    const unrelatedRadarId = `${PREFIX}unrelated-radar`;
    const unrelatedPlacementId = `${PREFIX}unrelated-placement`;

    await runWriteTransaction(
      `CREATE (radar:Radar {id: $radarId})
       CREATE (placement:RadarPlacement {id: $placementId, radarId: $radarId})
       CREATE (technology:Entity:Technology {
         id: $technologyId, entityType: 'technology', name: 'Disposable technology'
       })
       CREATE (target:Entity:Company {
         id: $targetId, entityType: 'company', name: 'Disposable target'
       })
       CREATE (assertion:Assertion {
         id: $assertionId,
         subjectId: $placementId,
         subjectType: 'radarPlacement',
         objectId: $targetId,
         objectType: 'company'
       })
       CREATE (evidence:Evidence {id: $evidenceId})
       CREATE (placement)-[:ON_RADAR]->(radar)
       CREATE (placement)-[:PLACES]->(technology)
       CREATE (assertion)-[:ABOUT_SUBJECT]->(placement)
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)
       CREATE (assertion)-[:SUPPORTED_BY]->(evidence)
       CREATE (placement)-[:SUPPORTS {claimId: $assertionId}]->(target)

       CREATE (unrelatedRadar:Radar {id: $unrelatedRadarId})
       CREATE (unrelatedPlacement:RadarPlacement {
         id: $unrelatedPlacementId, radarId: $unrelatedRadarId
       })
       CREATE (unrelatedPlacement)-[:ON_RADAR]->(unrelatedRadar)`,
      {
        radarId,
        placementId,
        technologyId: `${PREFIX}technology`,
        targetId: `${PREFIX}target`,
        assertionId,
        evidenceId,
        unrelatedRadarId,
        unrelatedPlacementId,
      }
    );

    const job = deleteRadarFromNeo4jJob as unknown as {
      execute: (data: Record<string, unknown>) => Promise<{
        placementsDeleted: number;
        radarNodesDeleted: number;
      }>;
    };

    // cascade=false means Firestore reported no placements. The fixture is
    // deliberately Neo4j-only drift and must still be removed.
    await expect(job.execute({ radarId, cascade: false })).resolves.toMatchObject({
      placementsDeleted: 1,
      radarNodesDeleted: 1,
    });

    const census = await runReadTransaction<{
      deletedNodes: number;
      deletedProjections: number;
      unrelatedNodes: number;
    }>(
      `RETURN
         count { MATCH (node) WHERE node.id IN $deletedIds } AS deletedNodes,
         count { MATCH ()-[projection]->() WHERE projection.claimId = $assertionId } AS deletedProjections,
         count { MATCH (node) WHERE node.id IN $unrelatedIds } AS unrelatedNodes`,
      {
        deletedIds: [radarId, placementId, assertionId, evidenceId],
        assertionId,
        unrelatedIds: [unrelatedRadarId, unrelatedPlacementId],
      }
    );

    expect(census.records[0]).toEqual({ deletedNodes: 0, deletedProjections: 0, unrelatedNodes: 2 });
    await expect(job.execute({ radarId, cascade: false })).resolves.toMatchObject({
      placementsDeleted: 0,
      radarNodesDeleted: 0,
    });
  });
});
