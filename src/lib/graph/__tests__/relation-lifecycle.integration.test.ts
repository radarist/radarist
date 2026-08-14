/**
 * Real-Neo4j proof for the mutable Relation lifecycle.
 *
 * Skipped by default. Run only through the guarded disposable integration
 * lane with a disposable Neo4j target.
 */

import {
  checkHealth,
  closeDriver,
  getSession,
  runReadTransaction,
  runWriteTransaction,
} from '../neo4j-client';
import { bulkRejectAssertions, materializeAssertionAsEdge, updateAssertionStatus } from '../assertions';
import { applyConfidenceFeedback } from '../confidence-calibration';
import { currentEdgePredicate } from '../current-edge-filter';
import { relationNeedsReplay } from '../projection-reconciliation';
import {
  deleteAssertionByRelationId,
  syncRelationAsAssertion,
  syncRelationAsEdge,
  type SyncRelationAsAssertionInput,
} from '../relation-assertion-sync';

const TEST_PREFIX = 'relation-lifecycle-test-';
const RELATION_ID = `${TEST_PREFIX}relation`;

const entity = (suffix: string) => ({
  id: `${TEST_PREFIX}${suffix}`,
  type: 'technology',
  name: `Lifecycle ${suffix}`,
});

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(
    `MATCH ()-[r]->()
     WHERE r.relationId STARTS WITH $prefix
     DELETE r`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(
    `MATCH (claim:Assertion)
     WHERE claim.relationId STARTS WITH $prefix
     OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
     WITH claim, collect(DISTINCT evidence) AS evidenceNodes
     FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)
     DETACH DELETE claim`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(
    `MATCH (evidence:Evidence)
     WHERE evidence.assertionId STARTS WITH $prefix
     DETACH DELETE evidence`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(
    `MATCH (n)
     WHERE n.id STARTS WITH $prefix
     DETACH DELETE n`,
    { prefix: TEST_PREFIX }
  );
}

async function expectNoOwnedResidue(): Promise<void> {
  const nodes = await runReadTransaction<{ count: number }>(
    `MATCH (node)
     WHERE coalesce(toString(node.id), '') STARTS WITH $prefix
        OR coalesce(toString(node.relationId), '') STARTS WITH $prefix
        OR coalesce(toString(node.assertionId), '') STARTS WITH $prefix
     RETURN count(node) AS count`,
    { prefix: TEST_PREFIX }
  );
  const relationships = await runReadTransaction<{ count: number }>(
    `MATCH ()-[edge]->()
     WHERE coalesce(toString(edge.relationId), '') STARTS WITH $prefix
     RETURN count(edge) AS count`,
    { prefix: TEST_PREFIX }
  );

  expect(nodes.records[0]?.count).toBe(0);
  expect(relationships.records[0]?.count).toBe(0);
}

async function projectionRows(): Promise<
  Array<{
    sourceId: string;
    targetId: string;
    predicate: string;
    claimId: string | null;
    claimStatus: string;
    invalidatedAt: string | null;
    correlationId: string | null;
    sourceCorrelationId: string | null;
    sourceFingerprint: string | null;
  }>
> {
  const result = await runReadTransaction<{
    sourceId: string;
    targetId: string;
    predicate: string;
    claimId: string | null;
    claimStatus: string;
    invalidatedAt: string | null;
    correlationId: string | null;
    sourceCorrelationId: string | null;
    sourceFingerprint: string | null;
  }>(
    `MATCH (source)-[edge]->(target)
     WHERE edge.relationId = $relationId
     RETURN source.id AS sourceId,
            target.id AS targetId,
            type(edge) AS predicate,
            edge.claimId AS claimId,
            edge.claimStatus AS claimStatus,
            edge.t_invalidated AS invalidatedAt,
            edge.correlationId AS correlationId,
            edge.sourceCorrelationId AS sourceCorrelationId,
            edge.sourceFingerprint AS sourceFingerprint`,
    { relationId: RELATION_ID }
  );
  return result.records;
}

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('mutable relation lifecycle (real Neo4j)', () => {
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

  it('keeps one correlated projection across create/update and removes it on delete', async () => {
    const relationId = `${TEST_PREFIX}correlated-relation`;
    const createCorrelationId = 'corr_00000000-0000-4000-8000-000000000001';
    const updateCorrelationId = 'corr_00000000-0000-4000-8000-000000000002';
    const createSourceFingerprint = 'a'.repeat(64);
    const updateSourceFingerprint = 'b'.repeat(64);
    const input: SyncRelationAsAssertionInput = {
      relationId,
      correlationId: createCorrelationId,
      sourceCorrelationId: createCorrelationId,
      sourceFingerprint: createSourceFingerprint,
      subject: entity('correlated-source'),
      object: entity('correlated-target'),
      predicate: 'USES',
      confidence: 90,
      assertedBy: 'agent:linker',
      claimStatus: 'curated',
      sourceRelationType: 'uses',
    };

    const created = await syncRelationAsAssertion(input);
    const createdState = await runReadTransaction<{
      claimCount: number;
      edgeCount: number;
      claimCorrelationId: string | null;
      edgeCorrelationIds: string[];
      claimSourceCorrelationId: string | null;
      claimSourceFingerprint: string | null;
      edgeSourceCorrelationIds: string[];
      edgeSourceFingerprints: string[];
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})
       OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
       RETURN count(DISTINCT claim) AS claimCount,
              count(DISTINCT edge) AS edgeCount,
              head(collect(DISTINCT claim.correlationId)) AS claimCorrelationId,
              collect(DISTINCT edge.correlationId) AS edgeCorrelationIds,
              head(collect(DISTINCT claim.sourceCorrelationId)) AS claimSourceCorrelationId,
              head(collect(DISTINCT claim.sourceFingerprint)) AS claimSourceFingerprint,
              collect(DISTINCT edge.sourceCorrelationId) AS edgeSourceCorrelationIds,
              collect(DISTINCT edge.sourceFingerprint) AS edgeSourceFingerprints`,
      { relationId }
    );
    expect(createdState.records[0]).toEqual({
      claimCount: 1,
      edgeCount: 1,
      claimCorrelationId: createCorrelationId,
      edgeCorrelationIds: [createCorrelationId],
      claimSourceCorrelationId: createCorrelationId,
      claimSourceFingerprint: createSourceFingerprint,
      edgeSourceCorrelationIds: [createCorrelationId],
      edgeSourceFingerprints: [createSourceFingerprint],
    });

    const updated = await syncRelationAsAssertion({
      ...input,
      correlationId: updateCorrelationId,
      sourceCorrelationId: updateCorrelationId,
      sourceFingerprint: updateSourceFingerprint,
      confidence: 93,
    });
    expect(updated.claimId).toBe(created.claimId);
    const updatedState = await runReadTransaction<{
      claimCount: number;
      edgeCount: number;
      claimCorrelationId: string | null;
      edgeCorrelationIds: string[];
      claimSourceCorrelationId: string | null;
      claimSourceFingerprint: string | null;
      edgeSourceCorrelationIds: string[];
      edgeSourceFingerprints: string[];
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})
       OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
       RETURN count(DISTINCT claim) AS claimCount,
              count(DISTINCT edge) AS edgeCount,
              head(collect(DISTINCT claim.correlationId)) AS claimCorrelationId,
              collect(DISTINCT edge.correlationId) AS edgeCorrelationIds,
              head(collect(DISTINCT claim.sourceCorrelationId)) AS claimSourceCorrelationId,
              head(collect(DISTINCT claim.sourceFingerprint)) AS claimSourceFingerprint,
              collect(DISTINCT edge.sourceCorrelationId) AS edgeSourceCorrelationIds,
              collect(DISTINCT edge.sourceFingerprint) AS edgeSourceFingerprints`,
      { relationId }
    );
    expect(updatedState.records[0]).toEqual({
      claimCount: 1,
      edgeCount: 1,
      claimCorrelationId: updateCorrelationId,
      edgeCorrelationIds: [updateCorrelationId],
      claimSourceCorrelationId: updateCorrelationId,
      claimSourceFingerprint: updateSourceFingerprint,
      edgeSourceCorrelationIds: [updateCorrelationId],
      edgeSourceFingerprints: [updateSourceFingerprint],
    });

    const feedbackCorrelationId = 'corr_00000000-0000-4000-8000-000000000003';
    await applyConfidenceFeedback(relationId, 'up', feedbackCorrelationId);
    const feedbackState = await runReadTransaction<{
      claimCorrelationId: string | null;
      edgeCorrelationIds: string[];
      claimSourceCorrelationId: string | null;
      claimSourceFingerprint: string | null;
      edgeSourceCorrelationIds: string[];
      edgeSourceFingerprints: string[];
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})
       MATCH ()-[edge {relationId: $relationId}]->()
       RETURN claim.correlationId AS claimCorrelationId,
              collect(DISTINCT edge.correlationId) AS edgeCorrelationIds,
              claim.sourceCorrelationId AS claimSourceCorrelationId,
              claim.sourceFingerprint AS claimSourceFingerprint,
              collect(DISTINCT edge.sourceCorrelationId) AS edgeSourceCorrelationIds,
              collect(DISTINCT edge.sourceFingerprint) AS edgeSourceFingerprints`,
      { relationId }
    );
    expect(feedbackState.records[0]).toEqual({
      claimCorrelationId: feedbackCorrelationId,
      edgeCorrelationIds: [feedbackCorrelationId],
      claimSourceCorrelationId: updateCorrelationId,
      claimSourceFingerprint: updateSourceFingerprint,
      edgeSourceCorrelationIds: [updateCorrelationId],
      edgeSourceFingerprints: [updateSourceFingerprint],
    });
    expect(
      relationNeedsReplay(
        {
          sourceSnapshot: input.subject,
          targetSnapshot: input.object,
          relationType: 'uses',
          confidence: 93,
          aiSuggested: true,
          claimStatus: 'curated',
          sourceCorrelationId: updateCorrelationId,
          sourceFingerprint: updateSourceFingerprint,
        },
        {
          relationId,
          activeEdge: true,
          assertionStatus: 'curated',
          assertionCount: 1,
          activeEdgeCount: 1,
          edgeSourceId: input.subject.id,
          edgeTargetId: input.object.id,
          edgePredicate: 'USES',
          edgeSourceCorrelationId: updateCorrelationId,
          edgeSourceFingerprint: updateSourceFingerprint,
          assertionSourceId: input.subject.id,
          assertionTargetId: input.object.id,
          assertionPredicate: 'USES',
          assertionSourceCorrelationId: updateCorrelationId,
          assertionSourceFingerprint: updateSourceFingerprint,
        }
      )
    ).toBe(false);

    expect(await deleteAssertionByRelationId(relationId)).toBe(1);
    const deletedState = await runReadTransaction<{ claimCount: number; edgeCount: number }>(
      `OPTIONAL MATCH (claim:Assertion {relationId: $relationId})
       OPTIONAL MATCH ()-[edge {relationId: $relationId}]->()
       RETURN count(DISTINCT claim) AS claimCount, count(DISTINCT edge) AS edgeCount`,
      { relationId }
    );
    expect(deletedState.records[0]).toEqual({ claimCount: 0, edgeCount: 0 });
  }, 60_000);

  it('keeps exactly one honest projection across rewrite, rejection, replay, and Class A/B transitions', async () => {
    const initial: SyncRelationAsAssertionInput = {
      relationId: RELATION_ID,
      subject: entity('source-a'),
      object: entity('target-a'),
      predicate: 'USES',
      confidence: 90,
      assertedBy: 'agent:linker',
      reasoningSummary: 'Human reviewed primary evidence',
      claimStatus: 'curated',
      sourceRelationType: 'uses',
      evidence: [
        {
          sourceKey: `${RELATION_ID}:entity-field`,
          sourceType: 'entity_field',
          snippet: 'The source entity description names the target dependency.',
          entityId: `${TEST_PREFIX}source-a`,
          entityType: 'technology',
          entityField: 'description',
        },
      ],
    };

    const created = await syncRelationAsAssertion(initial);
    expect(created.materializationSkipped).not.toBe(true);
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: initial.subject.id,
        targetId: initial.object.id,
        predicate: 'USES',
        claimId: created.claimId,
        claimStatus: 'curated',
        invalidatedAt: null,
      }),
    ]);
    const storedEvidence = await runReadTransaction<{
      sourceType: string;
      entityId: string;
      entityType: string;
      entityField: string;
      corroborationNudge: number;
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})-[:SUPPORTED_BY]->(evidence:Evidence)
       RETURN evidence.sourceType AS sourceType,
              evidence.entityId AS entityId,
              evidence.entityType AS entityType,
              evidence.entityField AS entityField,
              claim.corroborationNudge AS corroborationNudge`,
      { relationId: RELATION_ID }
    );
    expect(storedEvidence.records).toEqual([
      {
        sourceType: 'entity_field',
        entityId: `${TEST_PREFIX}source-a`,
        entityType: 'technology',
        entityField: 'description',
        corroborationNudge: 0,
      },
    ]);

    const rewritten: SyncRelationAsAssertionInput = {
      ...initial,
      subject: entity('source-b'),
      object: entity('target-b'),
      predicate: 'SUPPORTS',
      assertedBy: 'user:reviewer',
      sourceRelationType: 'supports',
    };
    const rewriteResult = await syncRelationAsAssertion(rewritten);
    expect(rewriteResult.claimId).toBe(created.claimId);
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: rewritten.subject.id,
        targetId: rewritten.object.id,
        predicate: 'SUPPORTS',
        claimId: created.claimId,
      }),
    ]);

    const structure = await runReadTransaction<{
      subjectId: string;
      objectId: string;
      predicate: string;
      assertedBy: string;
      subjects: number;
      objects: number;
      predicates: number;
      asserters: number;
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})
       OPTIONAL MATCH (claim)-[subjectRel:ABOUT_SUBJECT]->()
       OPTIONAL MATCH (claim)-[objectRel:ABOUT_OBJECT]->()
       OPTIONAL MATCH (claim)-[predicateRel:HAS_PREDICATE]->()
       OPTIONAL MATCH (claim)-[asserterRel:ASSERTED_BY]->()
       RETURN claim.subjectId AS subjectId,
              claim.objectId AS objectId,
              claim.predicate AS predicate,
              claim.assertedBy AS assertedBy,
              count(DISTINCT subjectRel) AS subjects,
              count(DISTINCT objectRel) AS objects,
              count(DISTINCT predicateRel) AS predicates,
              count(DISTINCT asserterRel) AS asserters`,
      { relationId: RELATION_ID }
    );
    expect(structure.records[0]).toEqual({
      subjectId: rewritten.subject.id,
      objectId: rewritten.object.id,
      predicate: 'SUPPORTS',
      assertedBy: 'user:reviewer',
      subjects: 1,
      objects: 1,
      predicates: 1,
      asserters: 1,
    });

    // Seed corruption that MERGE alone cannot repair: duplicate structural
    // bindings plus an exact duplicate live projection. A replay must collapse
    // every role/current projection back to one.
    await runWriteTransaction(
      `MATCH (claim:Assertion {relationId: $relationId})
       MATCH (subject:Entity {id: $subjectId})
       MATCH (object:Entity {id: $objectId})
       MATCH (predicate:RelationType {name: $predicate})
       MATCH (asserter:User {id: $assertedBy})
       CREATE (claim)-[:ABOUT_SUBJECT]->(subject)
       CREATE (claim)-[:ABOUT_OBJECT]->(object)
       CREATE (claim)-[:HAS_PREDICATE]->(predicate)
       CREATE (claim)-[:ASSERTED_BY]->(asserter)
       CREATE (subject)-[:SUPPORTS {
         relationId: $relationId, claimId: claim.id, claimStatus: 'curated',
         confidence: 90, t_observed: $now, t_valid: $now
       }]->(object)`,
      {
        relationId: RELATION_ID,
        subjectId: rewritten.subject.id,
        objectId: rewritten.object.id,
        predicate: rewritten.predicate,
        assertedBy: rewritten.assertedBy,
        now: new Date().toISOString(),
      }
    );
    expect(await projectionRows()).toHaveLength(2);
    await syncRelationAsAssertion(rewritten);
    expect(await projectionRows()).toHaveLength(1);
    const repairedStructure = await runReadTransaction<{
      subjects: number;
      objects: number;
      predicates: number;
      asserters: number;
    }>(
      `MATCH (claim:Assertion {relationId: $relationId})
       RETURN size([(claim)-[:ABOUT_SUBJECT]->() | 1]) AS subjects,
              size([(claim)-[:ABOUT_OBJECT]->() | 1]) AS objects,
              size([(claim)-[:HAS_PREDICATE]->() | 1]) AS predicates,
              size([(claim)-[:ASSERTED_BY]->() | 1]) AS asserters`,
      { relationId: RELATION_ID }
    );
    expect(repairedStructure.records[0]).toEqual({ subjects: 1, objects: 1, predicates: 1, asserters: 1 });

    // Hold the Assertion write lock while materialization reads the old
    // snapshot, then commit a topology rewrite. The first guarded write must
    // refuse its stale parameters and the retry must project only the fresh
    // topology.
    const raceSubject = entity('race-source');
    const raceObject = entity('race-target');
    await runWriteTransaction(
      `MERGE (subject:Entity {id: $subjectId}) SET subject.entityType = $type, subject.name = $subjectName
       MERGE (object:Entity {id: $objectId}) SET object.entityType = $type, object.name = $objectName`,
      {
        subjectId: raceSubject.id,
        subjectName: raceSubject.name,
        objectId: raceObject.id,
        objectName: raceObject.name,
        type: 'technology',
      }
    );
    const lockSession = getSession('WRITE');
    const lockTx = lockSession.beginTransaction();
    try {
      await lockTx.run(
        `MATCH (claim:Assertion {id: $claimId})
         SET claim.updatedAt = claim.updatedAt`,
        { claimId: created.claimId }
      );
      const racedMaterialization = materializeAssertionAsEdge(created.claimId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await lockTx.run(
        `MATCH (claim:Assertion {id: $claimId})
         SET claim.subjectId = $subjectId,
             claim.objectId = $objectId,
             claim.predicate = 'ENABLES'`,
        { claimId: created.claimId, subjectId: raceSubject.id, objectId: raceObject.id }
      );
      await lockTx.commit();
      await expect(racedMaterialization).resolves.toEqual(expect.objectContaining({ edgeType: 'ENABLES' }));
    } finally {
      if (lockTx.isOpen()) await lockTx.rollback();
      await lockSession.close();
    }
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: raceSubject.id,
        targetId: raceObject.id,
        predicate: 'ENABLES',
        claimId: created.claimId,
      }),
    ]);

    // Restore full structural consistency through the authoritative sync path
    // before exercising rejection and class transitions.
    const racedRewrite: SyncRelationAsAssertionInput = {
      ...rewritten,
      subject: raceSubject,
      object: raceObject,
      predicate: 'ENABLES',
      sourceRelationType: 'enables',
    };
    await syncRelationAsAssertion(racedRewrite);

    // Exercise the lock ordering directly: whichever transaction wins first,
    // the final state must be rejected with no live projection.
    await Promise.all([
      updateAssertionStatus(created.claimId, 'rejected', 'user:reviewer'),
      materializeAssertionAsEdge(created.claimId),
    ]);
    const rejected = await projectionRows();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual(
      expect.objectContaining({ claimStatus: 'rejected', invalidatedAt: expect.any(String) })
    );
    const firstInvalidatedAt = rejected[0].invalidatedAt;

    await updateAssertionStatus(created.claimId, 'rejected', 'user:reviewer');
    expect((await projectionRows())[0].invalidatedAt).toBe(firstInvalidatedAt);
    await expect(materializeAssertionAsEdge(created.claimId)).resolves.toBeNull();
    expect((await projectionRows()).filter((edge) => edge.invalidatedAt === null)).toHaveLength(0);

    expect(await deleteAssertionByRelationId(RELATION_ID)).toBe(1);
    const direct: SyncRelationAsAssertionInput = {
      ...rewritten,
      correlationId: 'corr_00000000-0000-4000-8000-000000000003',
      sourceCorrelationId: 'corr_00000000-0000-4000-8000-000000000003',
      sourceFingerprint: 'c'.repeat(64),
      subject: entity('direct-source'),
      object: entity('direct-target'),
      predicate: 'PARTNER',
      assertedBy: 'user:reviewer',
      sourceRelationType: 'partner',
    };
    await syncRelationAsEdge(direct);
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: direct.subject.id,
        targetId: direct.object.id,
        predicate: 'PARTNER',
        claimId: null,
        correlationId: direct.correlationId,
        sourceCorrelationId: direct.sourceCorrelationId,
        sourceFingerprint: direct.sourceFingerprint,
      }),
    ]);

    const directRewrite: SyncRelationAsAssertionInput = {
      ...direct,
      correlationId: 'corr_00000000-0000-4000-8000-000000000004',
      sourceCorrelationId: 'corr_00000000-0000-4000-8000-000000000004',
      sourceFingerprint: 'd'.repeat(64),
      subject: entity('direct-source-2'),
      object: entity('direct-target-2'),
      predicate: 'ENABLES',
      sourceRelationType: 'enables',
    };
    await syncRelationAsEdge(directRewrite);
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: directRewrite.subject.id,
        targetId: directRewrite.object.id,
        predicate: 'ENABLES',
        claimId: null,
        correlationId: directRewrite.correlationId,
        sourceCorrelationId: directRewrite.sourceCorrelationId,
        sourceFingerprint: directRewrite.sourceFingerprint,
      }),
    ]);

    await runWriteTransaction(
      `MATCH (source:Entity {id: $sourceId}), (target:Entity {id: $targetId})
       CREATE (source)-[:ENABLES {
         relationId: $relationId, claimStatus: 'curated', confidence: 90,
         t_observed: $now, t_valid: $now
       }]->(target)`,
      {
        relationId: RELATION_ID,
        sourceId: directRewrite.subject.id,
        targetId: directRewrite.object.id,
        now: new Date().toISOString(),
      }
    );
    expect(await projectionRows()).toHaveLength(2);
    await syncRelationAsEdge(directRewrite);
    expect(await projectionRows()).toHaveLength(1);

    const assertionAgain = await syncRelationAsAssertion({
      ...directRewrite,
      assertedBy: 'agent:linker',
      claimStatus: 'curated',
    });
    expect(await projectionRows()).toEqual([
      expect.objectContaining({
        sourceId: directRewrite.subject.id,
        targetId: directRewrite.object.id,
        predicate: 'ENABLES',
        claimId: assertionAgain.claimId,
        claimStatus: 'curated',
        invalidatedAt: null,
      }),
    ]);
  }, 60_000);

  it('bulk rejection invalidates every projection and current-fact queries hide rejected and historical edges', async () => {
    const relationIds = [`${TEST_PREFIX}bulk-a`, `${TEST_PREFIX}bulk-b`];
    const created = await Promise.all(
      relationIds.map((relationId, index) =>
        syncRelationAsAssertion({
          relationId,
          subject: entity(`bulk-source-${index}`),
          object: entity(`bulk-target-${index}`),
          predicate: 'USES',
          confidence: 90,
          assertedBy: 'agent:linker',
          claimStatus: 'curated',
          sourceRelationType: 'uses',
        })
      )
    );
    const claimIds = created.map((result) => result.claimId);

    await bulkRejectAssertions(claimIds);
    const rejected = await runReadTransaction<{
      claimId: string;
      claimStatus: string;
      invalidatedAt: string | null;
    }>(
      `MATCH ()-[edge]->()
       WHERE edge.claimId IN $claimIds
       RETURN edge.claimId AS claimId, edge.claimStatus AS claimStatus,
              edge.t_invalidated AS invalidatedAt
       ORDER BY claimId`,
      { claimIds }
    );
    expect(rejected.records).toHaveLength(2);
    expect(rejected.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimStatus: 'rejected', invalidatedAt: expect.any(String) }),
        expect.objectContaining({ claimStatus: 'rejected', invalidatedAt: expect.any(String) }),
      ])
    );
    const firstInvalidations = new Map(rejected.records.map((edge) => [edge.claimId, edge.invalidatedAt]));

    await bulkRejectAssertions(claimIds);
    const replay = await runReadTransaction<{ claimId: string; invalidatedAt: string | null }>(
      `MATCH ()-[edge]->()
       WHERE edge.claimId IN $claimIds
       RETURN edge.claimId AS claimId, edge.t_invalidated AS invalidatedAt`,
      { claimIds }
    );
    for (const edge of replay.records) expect(edge.invalidatedAt).toBe(firstInvalidations.get(edge.claimId));

    const liveRelationId = `${TEST_PREFIX}visibility-live`;
    const historicalRelationId = `${TEST_PREFIX}visibility-historical`;
    await syncRelationAsEdge({
      relationId: liveRelationId,
      subject: entity('visibility-live-source'),
      object: entity('visibility-live-target'),
      predicate: 'SUPPORTS',
      confidence: 90,
      assertedBy: 'user:reviewer',
      sourceRelationType: 'supports',
    });
    await syncRelationAsEdge({
      relationId: historicalRelationId,
      subject: entity('visibility-old-source'),
      object: entity('visibility-old-target'),
      predicate: 'SUPPORTS',
      confidence: 90,
      assertedBy: 'user:reviewer',
      sourceRelationType: 'supports',
    });
    await runWriteTransaction(
      `MATCH ()-[edge {relationId: $relationId}]->()
       SET edge.t_invalidated = $invalidatedAt`,
      { relationId: historicalRelationId, invalidatedAt: new Date().toISOString() }
    );

    const current = await runReadTransaction<{ relationId: string }>(
      `MATCH ()-[edge]->()
       WHERE (edge.claimId IN $claimIds OR edge.relationId IN $relationIds)
         AND ${currentEdgePredicate('edge')}
       RETURN edge.relationId AS relationId`,
      { claimIds, relationIds: [liveRelationId, historicalRelationId] }
    );
    expect(current.records).toEqual([{ relationId: liveRelationId }]);
  }, 60_000);
});
