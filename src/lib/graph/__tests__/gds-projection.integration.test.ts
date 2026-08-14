/**
 * Real-GDS proof that the default projection includes canonical Relation
 * predicates such as EVALUATES. This runs only in the guarded disposable
 * Neo4j integration lane.
 */

import { closeDriver, runReadTransaction, runWriteTransaction } from '../neo4j-client';
import { dropProjection, projectKnowledgeGraph } from '../gds-projections';

const TEST_PREFIX = 'gds-projection-integration-';
const GRAPH_NAME = `${TEST_PREFIX}graph`;
const SOURCE_ID = `${TEST_PREFIX}source`;
const TARGET_ID = `${TEST_PREFIX}target`;

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('canonical GDS projection (real Neo4j + GDS)', () => {
  beforeAll(async () => {
    await dropProjection(GRAPH_NAME).catch(() => undefined);
    await runWriteTransaction(
      `MERGE (source:Entity:Technology {id: $sourceId})
       SET source.name = 'GDS integration source', source.entityType = 'technology'
       MERGE (target:Entity:Technology {id: $targetId})
       SET target.name = 'GDS integration target', target.entityType = 'technology'
       MERGE (source)-[edge:EVALUATES {relationId: $relationId}]->(target)
       SET edge.claimStatus = 'curated', edge.t_observed = datetime(), edge.t_invalidated = null`,
      { sourceId: SOURCE_ID, targetId: TARGET_ID, relationId: `${TEST_PREFIX}relation` }
    );
  });

  afterAll(async () => {
    await dropProjection(GRAPH_NAME).catch(() => undefined);
    await runWriteTransaction('MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node', {
      prefix: TEST_PREFIX,
    });
    await closeDriver();
  });

  it('streams the EVALUATES fixture edge from the projected graph', async () => {
    const ids = await runReadTransaction<{ source: number; target: number }>(
      `MATCH (source:Technology {id: $sourceId})-[:EVALUATES]->(target:Technology {id: $targetId})
       RETURN id(source) AS source, id(target) AS target`,
      { sourceId: SOURCE_ID, targetId: TARGET_ID }
    );
    const source = ids.records[0]?.source;
    const target = ids.records[0]?.target;
    expect(source).toBeDefined();
    expect(target).toBeDefined();

    const stats = await projectKnowledgeGraph(GRAPH_NAME);
    expect(stats.relationshipCount).toBeGreaterThan(0);

    const projected = await runReadTransaction<{ c: number }>(
      `CALL gds.graph.relationships.stream($graphName)
       YIELD sourceNodeId, targetNodeId
       WHERE sourceNodeId = $source AND targetNodeId = $target
       RETURN count(*) AS c`,
      { graphName: GRAPH_NAME, source, target }
    );
    expect(projected.records[0]?.c).toBe(1);
  });
});
