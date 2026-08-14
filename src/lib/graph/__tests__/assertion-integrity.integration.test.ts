/**
 * Real-Neo4j regression for GRAPH-024's scheduled diagnostic boundary.
 * Skipped by default; run only through the guarded disposable integration lane.
 */

import { countAssertionStructuralDrift } from '../assertion-integrity';
import { checkHealth, closeDriver, runReadTransaction, runWriteTransaction } from '../neo4j-client';

const TEST_MARKER = 'graph024-assertion-integrity-test';
const TEST_PREFIX = `${TEST_MARKER}-`;
const PREDICATE = 'GRAPH024_TEST_PREDICATE';
const STATUSES = ['curated', 'proposed', 'rejected'] as const;

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(`MATCH ()-[r]->() WHERE r.testMarker = $marker DELETE r`, { marker: TEST_MARKER });
  await runWriteTransaction(`MATCH (n) WHERE n.testMarker = $marker DETACH DELETE n`, { marker: TEST_MARKER });
}

async function relationshipFingerprint(): Promise<Array<Record<string, unknown>>> {
  const result = await runReadTransaction<Record<string, unknown>>(
    `MATCH (source)-[relationship]->(target)
     WHERE relationship.testMarker = $marker
     RETURN coalesce(source.id, source.name) AS source,
            type(relationship) AS type,
            coalesce(target.id, target.name) AS target,
            properties(relationship) AS properties
     ORDER BY source, type, target`,
    { marker: TEST_MARKER }
  );
  return result.records;
}

describeIntegration('Assertion integrity diagnostic (real Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(`[Integration Tests] disposable Neo4j is not healthy: ${health.error ?? 'unknown error'}`);
    }
    await cleanupFixtures();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await closeDriver();
  }, 60_000);

  it('preserves id-less predicate metadata and every owned edge across repeated diagnostics', async () => {
    const baselineDrift = await countAssertionStructuralDrift();

    await runWriteTransaction(
      `CREATE (predicate:RelationType {name: $predicate, testMarker: $marker})
       CREATE (actor:Agent {id: $actorId, testMarker: $marker})
       WITH predicate, actor
       UNWIND $statuses AS status
       CREATE (subject:Entity {id: $prefix + status + '-subject', testMarker: $marker})
       CREATE (object:Entity {id: $prefix + status + '-object', testMarker: $marker})
       CREATE (assertion:Assertion {
         id: $prefix + status + '-assertion',
         relationId: $prefix + status + '-relation',
         subjectId: subject.id,
         objectId: object.id,
         predicate: $predicate,
         assertedBy: actor.id,
         status: status,
         testMarker: $marker
       })
       CREATE (evidence:Evidence {
         id: $prefix + status + '-evidence',
         assertionId: assertion.id,
         sourceType: 'url',
         testMarker: $marker
       })
       CREATE (assertion)-[:ABOUT_SUBJECT {testMarker: $marker}]->(subject)
       CREATE (assertion)-[:ABOUT_OBJECT {testMarker: $marker}]->(object)
       CREATE (assertion)-[:HAS_PREDICATE {testMarker: $marker}]->(predicate)
       CREATE (assertion)-[:ASSERTED_BY {testMarker: $marker}]->(actor)
       CREATE (assertion)-[:SUPPORTED_BY {testMarker: $marker}]->(evidence)
       CREATE (subject)-[:RELATED_TO {
         claimId: assertion.id,
         claimStatus: status,
         t_invalidated: CASE WHEN status = 'rejected' THEN '2026-07-13T00:00:00.000Z' ELSE null END,
         testMarker: $marker
       }]->(object)`,
      {
        predicate: PREDICATE,
        marker: TEST_MARKER,
        actorId: `${TEST_PREFIX}actor`,
        prefix: TEST_PREFIX,
        statuses: [...STATUSES],
      }
    );

    const predicateIdentity = await runReadTransaction<{ id: string | null; name: string }>(
      `MATCH (predicate:RelationType {name: $predicate})
       RETURN predicate.id AS id, predicate.name AS name`,
      { predicate: PREDICATE }
    );
    expect(predicateIdentity.records).toEqual([{ id: null, name: PREDICATE }]);
    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift);

    const before = await relationshipFingerprint();
    expect(before).toHaveLength(18);

    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift);
    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift);
    expect(await relationshipFingerprint()).toEqual(before);

    await runWriteTransaction(
      `MATCH (:Assertion {id: $assertionId})-[predicate:HAS_PREDICATE]->(:RelationType {name: $predicate})
       DELETE predicate`,
      { assertionId: `${TEST_PREFIX}proposed-assertion`, predicate: PREDICATE }
    );
    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift + 1);
    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift + 1);
  }, 60_000);

  it('counts a missing scalar and null role key as drift instead of treating them as equal', async () => {
    const baselineDrift = await countAssertionStructuralDrift();
    const assertionId = `${TEST_PREFIX}null-key-assertion`;
    await runWriteTransaction(
      `MERGE (predicate:RelationType {name: $predicate})
       SET predicate.testMarker = $marker
       MERGE (actor:Agent {id: $actorId})
       SET actor.testMarker = $marker
       CREATE (subject:Entity {testMarker: $marker})
       CREATE (object:Entity {id: $objectId, testMarker: $marker})
       CREATE (assertion:Assertion {
         id: $assertionId,
         objectId: $objectId,
         predicate: $predicate,
         assertedBy: $actorId,
         testMarker: $marker
       })
       CREATE (assertion)-[:ABOUT_SUBJECT {testMarker: $marker}]->(subject)
       CREATE (assertion)-[:ABOUT_OBJECT {testMarker: $marker}]->(object)
       CREATE (assertion)-[:HAS_PREDICATE {testMarker: $marker}]->(predicate)
       CREATE (assertion)-[:ASSERTED_BY {testMarker: $marker}]->(actor)`,
      {
        predicate: PREDICATE,
        actorId: `${TEST_PREFIX}actor`,
        objectId: `${TEST_PREFIX}null-key-object`,
        assertionId,
        marker: TEST_MARKER,
      }
    );

    await expect(countAssertionStructuralDrift()).resolves.toBe(baselineDrift + 1);
  }, 60_000);
});
