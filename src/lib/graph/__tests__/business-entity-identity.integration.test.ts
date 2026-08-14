/** @jest-environment node */

/**
 * @file business-entity-identity.integration.test.ts
 * @description AI-026 real-Neo4j reproduction and proof.
 *
 * The defect was found live, not by a test: `recommendTechInvestments` returned
 * "[Unnamed Technology]" whose id was an `:AgentObservation`. Every existing
 * suite around graph-first retrieval was blind to it — the planner tests inject
 * fake dependencies, the exact-resolution tests re-declared the exclusion
 * vocabulary in a mock, and the one integration test that touched
 * `recommendTechnologyInvestments` passed only `strategyId`, which routes through
 * the ONE factor that was already label-protected.
 *
 * So this suite seeds the exact production shapes into a real graph and drives
 * the real reads:
 *
 *   (Technology)  <-[:ABOUT]-  (AgentObservation {entityType:'technology'})
 *   (PainPoint)   -[:SOLVES]-> (Technology)
 *   (OrgUnit)     -[:IMPACTS]-> (PainPoint)
 *
 * The observation sits exactly one untyped hop from the Technology, which is what
 * made `findConnected(painPointId, 'technology', { maxDepth: 2 })` return it: the
 * bare `ABOUT` edge carries no `t_invalidated` and no `claimStatus`, so it passes
 * every temporal filter, and `target.entityType IN ['technology']` matched the
 * copied property.
 *
 * Skipped unless the guarded disposable integration lane selects it
 * (`npm run test:integration:neo4j`); Jest setup rejects retained/default graph
 * targets before this suite loads.
 */

// Breaks the Firebase-init chain (`traversal` -> `service-factory` ->
// `firestore-fallback-service` -> `@/lib/firebase`). The lane runs
// RADARIST_GRAPH_RUNTIME_MODE=neo4j, so the fallback service is never
// instantiated; only its module-load side effect needs neutralizing.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

// Cache-free by construction: this suite mutates the graph between reads (the
// ambiguity twin, the bookkeeping-only bridge), so a memoized neighbour or path
// answer from an earlier fixture state would silently make an assertion vacuous.
// The pass-throughs keep `traversal.ts`'s getOrFetch contract intact.
jest.mock('@/lib/graph/query-cache', () => {
  const passThrough = () => ({
    getOrFetch: async <T>(_key: string, fetch: () => Promise<T>) => fetch(),
    invalidate: () => false,
    invalidatePattern: () => 0,
    clear: () => undefined,
  });
  return {
    invalidateCachesForEntity: jest.fn(),
    invalidateAllGraphCaches: jest.fn(),
    neighborsCache: passThrough(),
    pathCache: passThrough(),
    businessQueryCache: passThrough(),
    buildNeighborsCacheKey: (nodeId: string, options: object = {}) => `neighbors:${nodeId}:${JSON.stringify(options)}`,
    buildPathCacheKey: (sourceId: string, targetId: string, options: object = {}) =>
      `path:${sourceId}:${targetId}:${JSON.stringify(options)}`,
    buildBusinessQueryCacheKey: (queryType: string) => `biz:${queryType}`,
  };
});

// No provider key in this lane and no embedding is needed: the suite requests
// zero chunks, so semantic retrieval never runs and the proof costs nothing.
jest.mock('@/lib/ai/client', () => ({
  generateEmbedding: jest.fn(async () => []),
}));

import { randomUUID } from 'node:crypto';

import { checkHealth, closeDriver, initializeSchema, runReadTransaction, runWriteTransaction } from '../neo4j-client';
import { Neo4jGraphService } from '../neo4j-graph-service';
import { resolveExactGraphEntity, extractSubgraph } from '../subgraph-rag';
import { resolveEntityByIdOrName } from '../resolve-entity';
import { findConnected, getNeighbors, getEntity, getEntities, checkConnection, explainConnection } from '../traversal';
import {
  findSolutionsForPainPoint,
  recommendTechnologyInvestments,
  generateTechnologySummary,
} from '../business-queries';
import { INTERNAL_MEMORY_GRAPH_LABELS } from '../business-entity-identity';

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const MARKER = `ai026-${randomUUID()}`;
const id = (suffix: string) => `${MARKER}-${suffix}`;

const TECH_ID = id('technology');
const PAIN_ID = id('painpoint');
const ORG_ID = id('orgunit');
const OBSERVATION_ID = id('observation');
const PLACEHOLDER_ID = id('placeholder');
const TECH_NAME = `Kubernetes ${MARKER}`;

/**
 * Every internal-memory label, each seeded as a decoy carrying
 * `entityType:'technology'` and an `ABOUT` edge to the real Technology. One
 * example would prove one label; the row asks for every label that could
 * masquerade as a business entity.
 */
const DECOY_LABELS = INTERNAL_MEMORY_GRAPH_LABELS;
const decoyId = (label: string) => id(`decoy-${label}`);

async function cleanup(): Promise<void> {
  await runWriteTransaction('MATCH (node) WHERE node.testMarker = $marker DETACH DELETE node', { marker: MARKER });
}

async function seed(): Promise<void> {
  await runWriteTransaction(
    `CREATE (tech:Entity:Technology {
       id: $techId, entityType: 'technology', name: $techName, testMarker: $marker
     })
     CREATE (pain:Entity:PainPoint {
       id: $painId, entityType: 'painPoint', name: 'Latency ' + $marker, severity: 'high', testMarker: $marker
     })
     CREATE (org:Entity:OrgUnit {
       id: $orgId, entityType: 'orgUnit', name: 'Platform ' + $marker, testMarker: $marker
     })
     // The endpoint placeholder relation/assertion sync legitimately mints: a
     // bare (:Entity) with only entityType, no specific label.
     CREATE (placeholder:Entity {
       id: $placeholderId, entityType: 'technology', name: 'Pending ' + $marker, testMarker: $marker
     })
     CREATE (org)-[:IMPACTS {
       relationId: $marker + '-org-pain', confidence: 90, effectiveConfidence: 90,
       claimStatus: 'curated', t_observed: $now, t_valid: $now, testMarker: $marker
     }]->(pain)
     CREATE (pain)-[:SOLVES {
       relationId: $marker + '-pain-tech', confidence: 90, effectiveConfidence: 90,
       claimStatus: 'curated', t_observed: $now, t_valid: $now, testMarker: $marker
     }]->(tech)
     CREATE (tech)-[:USES {
       relationId: $marker + '-tech-placeholder', confidence: 90, effectiveConfidence: 90,
       claimStatus: 'curated', t_observed: $now, t_valid: $now, testMarker: $marker
     }]->(placeholder)`,
    {
      techId: TECH_ID,
      techName: TECH_NAME,
      painId: PAIN_ID,
      orgId: ORG_ID,
      placeholderId: PLACEHOLDER_ID,
      marker: MARKER,
      now: new Date().toISOString(),
    }
  );

  // The reproduction: `recordAgentObservation` (proactive-insights.ts) copies the
  // observed entity's `entityType` onto its own node, and stores `entityName` /
  // `title` — never `name`, which is why the model rendered it "[Unnamed
  // Technology]". `ensure-edges.ts` attaches a bare `ABOUT` edge.
  await runWriteTransaction(
    `MATCH (tech:Technology {id: $techId})
     CREATE (obs:AgentObservation {
       id: $observationId, agentType: 'interest-watch', observationType: 'update',
       title: 'Watched ' + $techName, summary: 'changed', confidence: 70,
       entityId: $techId, entityName: $techName, entityType: 'technology',
       timestamp: timestamp(), memoryLane: 'episodic', testMarker: $marker
     })
     CREATE (obs)-[:ABOUT {testMarker: $marker}]->(tech)`,
    { techId: TECH_ID, techName: TECH_NAME, observationId: OBSERVATION_ID, marker: MARKER }
  );

  for (const label of DECOY_LABELS) {
    // Labels cannot be parameter-bound in a pattern; every value here comes from
    // the frozen in-repo vocabulary, never from input.
    await runWriteTransaction(
      `MATCH (tech:Technology {id: $techId})
       CREATE (decoy:\`${label}\` {
         id: $decoyId, entityType: 'technology', entityName: $techName,
         title: 'Decoy ' + $techName, testMarker: $marker
       })
       CREATE (decoy)-[:ABOUT {testMarker: $marker}]->(tech)`,
      { techId: TECH_ID, techName: TECH_NAME, decoyId: decoyId(label), marker: MARKER }
    );
  }
}

describeIntegration('AI-026 — an internal-memory node never resolves as a business entity (real Neo4j)', () => {
  const service = new Neo4jGraphService();

  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(
        `[Integration Tests] NEO4J_INTEGRATION_TESTS is set but Neo4j is not healthy: ${health.error ?? 'unknown'}`
      );
    }
    // A freshly provisioned disposable graph has no schema. `resolveExactGraphEntity`
    // reads the schema-owned `entity_name_idx` fulltext index by design (an indexed
    // bounded candidate read rather than a label scan), so without this the
    // normalized-name lane would throw rather than be exercised.
    await initializeSchema();
    await cleanup();
    await seed();
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await closeDriver();
  }, 60_000);

  it('seeded the reproduction: the observation IS reachable and DOES claim to be a technology', async () => {
    // Guard against a vacuous proof. If this fails, the assertions below prove
    // nothing, because the shape they are supposed to refuse is not present.
    const seeded = await runReadTransaction<{ labels: string[]; entityType: string; name: string | null }>(
      `MATCH (obs {id: $observationId})-[:ABOUT]->(tech:Technology {id: $techId})
       RETURN labels(obs) AS labels, obs.entityType AS entityType, obs.name AS name`,
      { observationId: OBSERVATION_ID, techId: TECH_ID }
    );
    expect(seeded.records).toHaveLength(1);
    expect(seeded.records[0].labels).toEqual(['AgentObservation']);
    expect(seeded.records[0].entityType).toBe('technology');
    expect(seeded.records[0].name).toBeNull();

    const hops = await runReadTransaction<{ hops: number }>(
      `MATCH path = (pain:PainPoint {id: $painId})-[*..2]-(obs {id: $observationId})
       RETURN length(path) AS hops ORDER BY hops LIMIT 1`,
      { painId: PAIN_ID, observationId: OBSERVATION_ID }
    );
    expect(hops.records[0]?.hops).toBe(2);
  });

  it('findConnected refuses every decoy while still returning the real Technology', async () => {
    const connected = await findConnected(PAIN_ID, 'technology', { maxDepth: 2 });
    const ids = connected.map((node) => node.id);

    expect(ids).toContain(TECH_ID);
    expect(ids).not.toContain(OBSERVATION_ID);
    for (const label of DECOY_LABELS) {
      expect(ids).not.toContain(decoyId(label));
    }
  });

  it('recommendTechInvestments closes the exact live-turn path (Factor 2, via orgUnitId)', async () => {
    // Deliberately orgUnitId, NOT strategyId: the strategy factor already rode
    // the GRAPH-062 allow-list, so a strategyId proof would pass before and
    // after the fix. This is the factor the live turn actually used.
    const recommendations = await recommendTechnologyInvestments({ orgUnitId: ORG_ID, limit: 25 });
    const ids = recommendations.map((item) => item.technology.id);

    expect(ids).toContain(TECH_ID);
    expect(ids).not.toContain(OBSERVATION_ID);
    for (const label of DECOY_LABELS) {
      expect(ids).not.toContain(decoyId(label));
    }
    // And nothing unnamed survives — "[Unnamed Technology]" was the symptom.
    for (const recommendation of recommendations) {
      expect(String(recommendation.technology.properties.name ?? '')).not.toBe('');
    }
  });

  it('findSolutionsForPainPoint returns only label-proven technologies', async () => {
    const solutions = await findSolutionsForPainPoint(PAIN_ID, { maxDepth: 2 });
    const ids = solutions.map((solution) => solution.technology.id);

    expect(ids).toContain(TECH_ID);
    expect(ids).not.toContain(OBSERVATION_ID);
  });

  it('getNeighbors excludes bookkeeping neighbours, typed or untyped', async () => {
    const typed = await getNeighbors(TECH_ID, { entityTypes: ['technology'], limit: 50 });
    expect(typed.map((node) => node.id)).not.toContain(OBSERVATION_ID);

    // The widest leak: no entityTypes at all — every decoy came back.
    const untyped = await getNeighbors(TECH_ID, { depth: 2, limit: 50 });
    const untypedIds = untyped.map((node) => node.id);
    expect(untypedIds).not.toContain(OBSERVATION_ID);
    for (const label of DECOY_LABELS) {
      expect(untypedIds).not.toContain(decoyId(label));
    }
    // Still finds the real business neighbourhood.
    expect(untypedIds).toContain(PAIN_ID);
  });

  it('authoritative-ID retrieval refuses an internal-memory id', async () => {
    expect(await getEntity(OBSERVATION_ID)).toBeNull();
    for (const label of DECOY_LABELS) {
      expect(await getEntity(decoyId(label))).toBeNull();
    }
    expect((await getEntity(TECH_ID))?.id).toBe(TECH_ID);

    const batch = await getEntities([TECH_ID, OBSERVATION_ID, PAIN_ID]);
    expect(batch.map((node) => node.id).sort()).toEqual([PAIN_ID, TECH_ID].sort());
  });

  it('deterministic resolution refuses an internal-memory id and name', async () => {
    const byObservationId = await resolveExactGraphEntity(OBSERVATION_ID);
    expect(byObservationId.status).toBe('not-found');
    expect(byObservationId.entity).toBeNull();

    // The observation's `entityName` and `title` both carry the technology's
    // name, so a name lookup must still resolve to the Technology alone.
    const byName = await resolveExactGraphEntity(TECH_NAME);
    expect(byName.status).toBe('resolved');
    expect(byName.entity?.id).toBe(TECH_ID);
    expect(byName.matchedBy).toBe('normalized-name');

    const byIdOrName = await resolveEntityByIdOrName(OBSERVATION_ID);
    expect(byIdOrName.match).toBeNull();
  });

  it('resolves a stable id ahead of a name, and refuses genuine ambiguity', async () => {
    const byId = await resolveExactGraphEntity(TECH_ID);
    expect(byId.status).toBe('resolved');
    expect(byId.matchedBy).toBe('stable-id');

    const twinId = id('twin-company');
    try {
      await runWriteTransaction(
        `CREATE (:Entity:Company {id: $twinId, entityType: 'company', name: $techName, testMarker: $marker})`,
        { twinId, techName: TECH_NAME, marker: MARKER }
      );

      const ambiguous = await resolveExactGraphEntity(TECH_NAME);
      expect(ambiguous.status).toBe('ambiguous');
      expect(ambiguous.entity).toBeNull();
      expect(ambiguous.candidates.map((candidate) => candidate.id).sort()).toEqual([TECH_ID, twinId].sort());

      // A type-scoped resolution disambiguates by canonical label, not property.
      const scoped = await resolveExactGraphEntity(TECH_NAME, { entityTypes: ['technology'] });
      expect(scoped.status).toBe('resolved');
      expect(scoped.entity?.id).toBe(TECH_ID);
    } finally {
      await runWriteTransaction('MATCH (n {id: $twinId}) DETACH DELETE n', { twinId });
    }
  });

  it('keeps the bounded one-hop business neighbourhood, minus the decoys', async () => {
    const context = await extractSubgraph(TECH_ID, { neighbors: 25, chunks: 0, claims: 5 });

    expect(context).not.toBeNull();
    expect(context?.center.id).toBe(TECH_ID);
    expect(context?.center.label).toBe('Technology');

    const neighborIds = (context?.neighbors ?? []).map((neighbor) => neighbor.entity.id);
    expect(neighborIds).toContain(PAIN_ID);
    expect(neighborIds).not.toContain(OBSERVATION_ID);
    for (const label of DECOY_LABELS) {
      expect(neighborIds).not.toContain(decoyId(label));
    }
    // Direction and predicate survive the narrowing.
    const painNeighbor = context?.neighbors.find((neighbor) => neighbor.entity.id === PAIN_ID);
    expect(painNeighbor?.relation).toBe('SOLVES');
    expect(painNeighbor?.direction).toBe('in');
  });

  it('refuses to resolve the subgraph center for an internal-memory id', async () => {
    expect(await extractSubgraph(OBSERVATION_ID)).toBeNull();
  });

  it('keeps the label-less endpoint placeholder reachable', async () => {
    // The mirror-image failure a bare canonical-label allow-list would cause:
    // relation/assertion sync mints these when a relation arrives before its
    // endpoint's own projection, and they are real entities.
    expect((await getEntity(PLACEHOLDER_ID))?.id).toBe(PLACEHOLDER_ID);
    const connected = await findConnected(TECH_ID, 'technology', { maxDepth: 1 });
    expect(connected.map((node) => node.id)).toContain(PLACEHOLDER_ID);
  });

  it('paths and connection checks cannot route through a bookkeeping node', async () => {
    // Two technologies joined ONLY through the observation: a path may not exist.
    const otherTechId = id('other-technology');
    try {
      await runWriteTransaction(
        `MATCH (obs:AgentObservation {id: $observationId})
         CREATE (other:Entity:Technology {
           id: $otherTechId, entityType: 'technology', name: 'Other ' + $marker, testMarker: $marker
         })
         CREATE (obs)-[:ABOUT {testMarker: $marker}]->(other)`,
        { observationId: OBSERVATION_ID, otherTechId, marker: MARKER }
      );

      const bookkeepingOnly = await runReadTransaction<{ hops: number }>(
        `MATCH path = (a {id: $techId})-[*..2]-(b {id: $otherTechId}) RETURN length(path) AS hops LIMIT 1`,
        { techId: TECH_ID, otherTechId }
      );
      expect(bookkeepingOnly.records).toHaveLength(1);

      const connection = await checkConnection(TECH_ID, otherTechId, 2);
      expect(connection.connected).toBe(false);
      expect(await service.areConnected(TECH_ID, otherTechId, 2)).toBe(false);

      const explanation = await explainConnection(TECH_ID, otherTechId, { maxDepth: 2 });
      expect(explanation.connected).toBe(false);
    } finally {
      await runWriteTransaction('MATCH (n {id: $otherTechId}) DETACH DELETE n', { otherTechId });
    }
  });

  it('explainConnection reports an internal-memory endpoint as unfindable, not as unconnected', async () => {
    const explanation = await explainConnection(TECH_ID, OBSERVATION_ID, { maxDepth: 2 });
    expect(explanation.connected).toBe(false);
    expect(explanation.explanation).toContain('Cannot find');
  });

  it('technology summary refuses an internal-memory id', async () => {
    const summary = await generateTechnologySummary(OBSERVATION_ID);
    expect(summary.technology).toBeNull();
    expect(summary.impact.technology.properties.name).toBe('Unknown');
  });

});
