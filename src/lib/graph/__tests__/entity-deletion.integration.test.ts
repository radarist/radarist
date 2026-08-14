/**
 * Real-Neo4j proofs for type-safe graph endpoint deletion.
 *
 * Skipped by default. Run only through the guarded disposable Neo4j lane.
 */

import { deleteAssertion, deleteEntityFromGraph } from '../assertions';
import { closeDriver, runReadTransaction, runWriteTransaction } from '../neo4j-client';
import { Neo4jGraphService } from '../neo4j-graph-service';

const TEST_PREFIX = 'entity-deletion-test-';
const SHARED_ID = `${TEST_PREFIX}shared-id`;
const TECHNOLOGY_ASSERTION_ID = `${TEST_PREFIX}technology-assertion`;
const DOCUMENT_ASSERTION_ID = `${TEST_PREFIX}document-assertion`;
const LEGACY_ASSERTION_ID = `${TEST_PREFIX}legacy-assertion`;

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

describeIntegration('type-safe graph endpoint deletion (disposable Neo4j)', () => {
  beforeEach(cleanupFixtures);
  afterEach(cleanupFixtures);
  afterAll(closeDriver);

  it('preserves a different endpoint type and its assertion topology when scalar IDs collide', async () => {
    await runWriteTransaction(
      `CREATE (technology:Entity:Technology {
         id: $sharedId, entityType: 'technology', name: 'Collision technology'
       })
       CREATE (document:Document {id: $sharedId, title: 'Collision document'})
       CREATE (technologyTarget:Entity:Company {
         id: $technologyTargetId, entityType: 'company', name: 'Technology target'
       })
       CREATE (documentTarget:Entity:Company {
         id: $documentTargetId, entityType: 'company', name: 'Document target'
       })
       CREATE (chunk:Chunk {id: $chunkId})
       CREATE (document)-[:CONTAINS]->(chunk)

       CREATE (technologyAssertion:Assertion {
         id: $technologyAssertionId,
         subjectId: $sharedId,
         subjectType: 'technology',
         objectId: $technologyTargetId,
         objectType: 'company'
       })
       CREATE (technologyEvidence:Evidence {id: $technologyEvidenceId})
       CREATE (technologyAssertion)-[:ABOUT_SUBJECT]->(technology)
       CREATE (technologyAssertion)-[:ABOUT_OBJECT]->(technologyTarget)
       CREATE (technologyAssertion)-[:SUPPORTED_BY]->(technologyEvidence)
       CREATE (technology)-[:SUPPORTS {claimId: $technologyAssertionId}]->(technologyTarget)

       CREATE (documentAssertion:Assertion {
         id: $documentAssertionId,
         subjectId: $sharedId,
         subjectType: 'document',
         objectId: $documentTargetId,
         objectType: 'company'
       })
       CREATE (documentEvidence:Evidence {id: $documentEvidenceId})
       CREATE (documentAssertion)-[:ABOUT_SUBJECT]->(document)
       CREATE (documentAssertion)-[:ABOUT_OBJECT]->(documentTarget)
       CREATE (documentAssertion)-[:SUPPORTED_BY]->(documentEvidence)
       CREATE (document)-[:MENTIONS {claimId: $documentAssertionId}]->(documentTarget)`,
      {
        sharedId: SHARED_ID,
        technologyTargetId: `${TEST_PREFIX}technology-target`,
        documentTargetId: `${TEST_PREFIX}document-target`,
        chunkId: `${TEST_PREFIX}chunk`,
        technologyAssertionId: TECHNOLOGY_ASSERTION_ID,
        technologyEvidenceId: `${TEST_PREFIX}technology-evidence`,
        documentAssertionId: DOCUMENT_ASSERTION_ID,
        documentEvidenceId: `${TEST_PREFIX}document-evidence`,
      }
    );

    await expect(deleteEntityFromGraph(SHARED_ID, 'technology')).resolves.toMatchObject({
      assertionsDeleted: 1,
      evidenceDeleted: 1,
      projectionsDeleted: 1,
      chunksDeleted: 0,
      endpointsDeleted: 1,
    });

    const result = await runReadTransaction<{
      technologyCount: number;
      technologyAssertionCount: number;
      technologyProjectionCount: number;
      documentCount: number;
      documentAssertionCount: number;
      documentEvidenceCount: number;
      documentProjectionCount: number;
      documentChunkCount: number;
    }>(
      `OPTIONAL MATCH (technology:Technology {id: $sharedId})
       WITH count(technology) AS technologyCount
       OPTIONAL MATCH (technologyAssertion:Assertion {id: $technologyAssertionId})
       WITH technologyCount, count(technologyAssertion) AS technologyAssertionCount
       OPTIONAL MATCH ()-[technologyProjection {claimId: $technologyAssertionId}]->()
       WITH technologyCount, technologyAssertionCount,
            count(technologyProjection) AS technologyProjectionCount
       OPTIONAL MATCH (document:Document {id: $sharedId})
       WITH technologyCount, technologyAssertionCount, technologyProjectionCount,
            count(document) AS documentCount
       OPTIONAL MATCH (documentAssertion:Assertion {id: $documentAssertionId})
       OPTIONAL MATCH (documentAssertion)-[:SUPPORTED_BY]->(documentEvidence:Evidence)
       OPTIONAL MATCH ()-[documentProjection {claimId: $documentAssertionId}]->()
       OPTIONAL MATCH (:Document {id: $sharedId})-[:CONTAINS]->(documentChunk:Chunk)
       RETURN technologyCount,
              technologyAssertionCount,
              technologyProjectionCount,
              documentCount,
              count(DISTINCT documentAssertion) AS documentAssertionCount,
              count(DISTINCT documentEvidence) AS documentEvidenceCount,
              count(DISTINCT documentProjection) AS documentProjectionCount,
              count(DISTINCT documentChunk) AS documentChunkCount`,
      {
        sharedId: SHARED_ID,
        technologyAssertionId: TECHNOLOGY_ASSERTION_ID,
        documentAssertionId: DOCUMENT_ASSERTION_ID,
      }
    );

    expect(result.records[0]).toEqual({
      technologyCount: 0,
      technologyAssertionCount: 0,
      technologyProjectionCount: 0,
      documentCount: 1,
      documentAssertionCount: 1,
      documentEvidenceCount: 1,
      documentProjectionCount: 1,
      documentChunkCount: 1,
    });
  });

  it('deletes a relation-writer placeholder using its validated Entity.entityType', async () => {
    const placeholderId = `${TEST_PREFIX}placeholder-company`;
    const assertionId = `${TEST_PREFIX}placeholder-assertion`;
    await runWriteTransaction(
      `CREATE (placeholder:Entity {id: $placeholderId, entityType: 'company'})
       CREATE (target:Entity:Technology {id: $targetId, entityType: 'technology'})
       CREATE (assertion:Assertion {
         id: $assertionId,
         subjectId: $placeholderId,
         subjectType: 'company',
         objectId: $targetId,
         objectType: 'technology'
       })
       CREATE (assertion)-[:ABOUT_SUBJECT]->(placeholder)
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)
       CREATE (placeholder)-[:SUPPORTS {claimId: $assertionId}]->(target)`,
      {
        placeholderId,
        targetId: `${TEST_PREFIX}placeholder-target`,
        assertionId,
      }
    );

    await expect(deleteEntityFromGraph(placeholderId, 'company')).resolves.toMatchObject({
      assertionsDeleted: 1,
      projectionsDeleted: 1,
      endpointsDeleted: 1,
    });

    const result = await runReadTransaction<{ leftovers: number }>(
      `OPTIONAL MATCH (endpoint {id: $placeholderId})
       OPTIONAL MATCH (assertion:Assertion {id: $assertionId})
       OPTIONAL MATCH ()-[projection {claimId: $assertionId}]->()
       RETURN count(DISTINCT endpoint) + count(DISTINCT assertion) +
              count(DISTINCT projection) AS leftovers`,
      { placeholderId, assertionId }
    );
    expect(result.records[0]?.leftovers).toBe(0);
  });

  it('deletes an Assertion structurally attached to a typed endpoint when its scalar topology is stale', async () => {
    const endpointId = `${TEST_PREFIX}structural-endpoint`;
    const assertionId = `${TEST_PREFIX}structural-truth-assertion`;
    await runWriteTransaction(
      `CREATE (endpoint:Entity:Company {id: $endpointId, entityType: 'company'})
       CREATE (target:Entity:Technology {id: $targetId, entityType: 'technology'})
       CREATE (assertion:Assertion {
         id: $assertionId,
         subjectId: 'stale-id',
         subjectType: 'technology',
         objectId: $targetId,
         objectType: 'technology'
       })
       CREATE (evidence:Evidence {id: $evidenceId})
       CREATE (assertion)-[:ABOUT_SUBJECT]->(endpoint)
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)
       CREATE (assertion)-[:SUPPORTED_BY]->(evidence)
       CREATE (endpoint)-[:SUPPORTS {claimId: $assertionId}]->(target)`,
      {
        endpointId,
        targetId: `${TEST_PREFIX}structural-target`,
        assertionId,
        evidenceId: `${TEST_PREFIX}structural-evidence`,
      }
    );

    await expect(deleteEntityFromGraph(endpointId, 'company')).resolves.toMatchObject({
      assertionsDeleted: 1,
      evidenceDeleted: 1,
      projectionsDeleted: 1,
      endpointsDeleted: 1,
    });

    const result = await runReadTransaction<{ leftovers: number }>(
      `OPTIONAL MATCH (node)
       WHERE node.id IN [$endpointId, $assertionId, $evidenceId]
       OPTIONAL MATCH ()-[projection {claimId: $assertionId}]->()
       RETURN count(DISTINCT node) + count(DISTINCT projection) AS leftovers`,
      {
        endpointId,
        assertionId,
        evidenceId: `${TEST_PREFIX}structural-evidence`,
      }
    );
    expect(result.records[0]?.leftovers).toBe(0);

    await expect(deleteEntityFromGraph(endpointId, 'company')).resolves.toEqual({
      assertionsDeleted: 0,
      evidenceDeleted: 0,
      projectionsDeleted: 0,
      chunksDeleted: 0,
      endpointsDeleted: 0,
      verificationResultsDeleted: 0,
      edgeVerificationResultsDeleted: 0,
    });
  });

  it('deletes a scalar-linked Assertion when generic deletion finds its structural role edge missing', async () => {
    const endpointId = `${TEST_PREFIX}scalar-endpoint`;
    const assertionId = `${TEST_PREFIX}scalar-truth-assertion`;
    await runWriteTransaction(
      `CREATE (endpoint:Entity:Company {id: $endpointId, entityType: 'company'})
       CREATE (target:Entity:Technology {id: $targetId, entityType: 'technology'})
       CREATE (assertion:Assertion {
         id: $assertionId,
         subjectId: $endpointId,
         subjectType: 'company',
         objectId: $targetId,
         objectType: 'technology'
       })
       CREATE (evidence:Evidence {id: $evidenceId})
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)
       CREATE (assertion)-[:SUPPORTED_BY]->(evidence)
       CREATE (endpoint)-[:SUPPORTS {claimId: $assertionId}]->(target)`,
      {
        endpointId,
        targetId: `${TEST_PREFIX}scalar-target`,
        assertionId,
        evidenceId: `${TEST_PREFIX}scalar-evidence`,
      }
    );

    await expect(new Neo4jGraphService().deleteNode(endpointId)).resolves.toBe(true);

    const result = await runReadTransaction<{ leftovers: number }>(
      `OPTIONAL MATCH (node)
       WHERE node.id IN [$endpointId, $assertionId, $evidenceId]
       OPTIONAL MATCH ()-[projection {claimId: $assertionId}]->()
       RETURN count(DISTINCT node) + count(DISTINCT projection) AS leftovers`,
      {
        endpointId,
        assertionId,
        evidenceId: `${TEST_PREFIX}scalar-evidence`,
      }
    );
    expect(result.records[0]?.leftovers).toBe(0);
  });

  it('fails closed when the requested type itself has duplicate endpoint candidates', async () => {
    const duplicateId = `${TEST_PREFIX}duplicate-company`;
    const assertionId = `${TEST_PREFIX}duplicate-company-assertion`;
    await runWriteTransaction(
      `CREATE (typed:Company {id: $duplicateId})
       CREATE (placeholder:Entity {id: $duplicateId, entityType: 'company'})
       CREATE (target:Entity:Technology {id: $targetId, entityType: 'technology'})
       CREATE (assertion:Assertion {
         id: $assertionId,
         subjectId: $duplicateId,
         subjectType: 'company',
         objectId: $targetId,
         objectType: 'technology'
       })
       CREATE (assertion)-[:ABOUT_SUBJECT]->(typed)
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)`,
      {
        duplicateId,
        targetId: `${TEST_PREFIX}duplicate-company-target`,
        assertionId,
      }
    );

    await expect(deleteEntityFromGraph(duplicateId, 'company')).rejects.toThrow(
      `Ambiguous graph endpoint: multiple company nodes share id ${duplicateId}`
    );

    const result = await runReadTransaction<{ endpointCount: number; assertionCount: number }>(
      `MATCH (endpoint {id: $duplicateId})
       WITH count(endpoint) AS endpointCount
       MATCH (assertion:Assertion {id: $assertionId})
       RETURN endpointCount, count(assertion) AS assertionCount`,
      { duplicateId, assertionId }
    );
    expect(result.records[0]).toEqual({ endpointCount: 2, assertionCount: 1 });
  });

  it('removes evidence and projections when deleting a legacy assertion directly', async () => {
    await runWriteTransaction(
      `CREATE (source:Entity:Technology {id: $sourceId, entityType: 'technology'})
       CREATE (target:Entity:Company {id: $targetId, entityType: 'company'})
       CREATE (assertion:Assertion {id: $assertionId})
       CREATE (evidence:Evidence {id: $evidenceId})
       CREATE (assertion)-[:ABOUT_SUBJECT]->(source)
       CREATE (assertion)-[:ABOUT_OBJECT]->(target)
       CREATE (assertion)-[:SUPPORTED_BY]->(evidence)
       CREATE (source)-[:SUPPORTS {claimId: $assertionId}]->(target)`,
      {
        sourceId: `${TEST_PREFIX}legacy-source`,
        targetId: `${TEST_PREFIX}legacy-target`,
        assertionId: LEGACY_ASSERTION_ID,
        evidenceId: `${TEST_PREFIX}legacy-evidence`,
      }
    );

    await deleteAssertion(LEGACY_ASSERTION_ID);

    const result = await runReadTransaction<{ leftovers: number }>(
      `OPTIONAL MATCH (assertion:Assertion {id: $assertionId})
       OPTIONAL MATCH (evidence:Evidence {id: $evidenceId})
       OPTIONAL MATCH ()-[projection {claimId: $assertionId}]->()
       RETURN count(DISTINCT assertion) + count(DISTINCT evidence) +
              count(DISTINCT projection) AS leftovers`,
      {
        assertionId: LEGACY_ASSERTION_ID,
        evidenceId: `${TEST_PREFIX}legacy-evidence`,
      }
    );

    expect(result.records[0]?.leftovers).toBe(0);
  });
});
