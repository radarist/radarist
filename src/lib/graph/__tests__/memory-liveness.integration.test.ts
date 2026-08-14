/**
 * GRAPH-032 disposable proof. The global integration guard rejects the
 * protected/default Neo4j target before this file loads.
 *
 * @jest-environment node
 */

import { randomUUID } from 'node:crypto';
import {
  checkHealth,
  closeDriver,
  runReadTransaction,
  runWriteTransaction,
} from '../neo4j-client';
import { createEpisode, completeEpisode, getEpisodeWithObservations } from '../episodes';
import { recordObservation } from '../observations';
import { recordSweepObservation } from '../sweep-observations';
import { recordAgentObservation } from '../proactive-insights';
import { syncAgentRunToNeo4j, type AgentRunSyncParams } from '../agent-run-sync';
import { readGraphMemoryLiveness } from '../memory-liveness';

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS === '1' ? describe : describe.skip;
const NAMESPACE = `graph-032-${randomUUID()}`;
const USER_ID = `${NAMESPACE}-user`;
const OWNED_CONSTRAINTS = [
  'graph032_entity_id',
  'graph032_episode_id',
  'graph032_observation_id',
  'graph032_agent_observation_id',
  'graph032_agent_run_id',
] as const;

interface Census {
  nodes: number;
  relationships: number;
}

async function cleanup(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $namespace
        OR node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.correlationId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
     DETACH DELETE node`,
    { namespace: NAMESPACE }
  );
}

async function census(): Promise<Census> {
  const nodes = await runReadTransaction<{ nodes: number }>(
    `MATCH (node)
     WHERE node.id STARTS WITH $namespace
        OR node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.correlationId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
     RETURN count(node) AS nodes`,
    { namespace: NAMESPACE }
  );
  const relationships = await runReadTransaction<{ relationships: number }>(
    `MATCH (start)-[relationship]-(end)
     WHERE start.id STARTS WITH $namespace
        OR start.missionId STARTS WITH $namespace
        OR start.sweepId STARTS WITH $namespace
        OR start.correlationId STARTS WITH $namespace
        OR start.userId STARTS WITH $namespace
        OR start.entityId STARTS WITH $namespace
        OR end.id STARTS WITH $namespace
        OR end.missionId STARTS WITH $namespace
        OR end.sweepId STARTS WITH $namespace
        OR end.correlationId STARTS WITH $namespace
        OR end.userId STARTS WITH $namespace
        OR end.entityId STARTS WITH $namespace
     RETURN count(DISTINCT relationship) AS relationships`,
    { namespace: NAMESPACE }
  );
  return {
    nodes: nodes.records[0]?.nodes ?? 0,
    relationships: relationships.records[0]?.relationships ?? 0,
  };
}

async function fingerprint(): Promise<Record<string, unknown>> {
  const result = await runReadTransaction<Record<string, unknown>>(
    `MATCH (node)
     WHERE node.id STARTS WITH $namespace
        OR node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.correlationId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
     WITH node ORDER BY node.id
     WITH collect({id: node.id, labels: labels(node), properties: properties(node)}) AS nodes
     OPTIONAL MATCH (start)-[relationship]->(end)
     WHERE start.id STARTS WITH $namespace
        OR start.missionId STARTS WITH $namespace
        OR start.sweepId STARTS WITH $namespace
        OR start.correlationId STARTS WITH $namespace
        OR start.userId STARTS WITH $namespace
        OR start.entityId STARTS WITH $namespace
        OR end.id STARTS WITH $namespace
        OR end.missionId STARTS WITH $namespace
        OR end.sweepId STARTS WITH $namespace
        OR end.correlationId STARTS WITH $namespace
        OR end.userId STARTS WITH $namespace
        OR end.entityId STARTS WITH $namespace
     WITH nodes, start, relationship, end
     ORDER BY type(relationship), start.id, end.id
     RETURN nodes,
            collect(CASE WHEN relationship IS NULL THEN null ELSE {
              type: type(relationship), startId: start.id, endId: end.id,
              properties: properties(relationship)
            } END) AS relationships`,
    { namespace: NAMESPACE }
  );
  return result.records[0] ?? { nodes: [], relationships: [] };
}

async function relationshipCounts(): Promise<Record<string, number>> {
  const result = await runReadTransaction<{ type: string; count: number }>(
    `MATCH (start)-[relationship]->(end)
     WHERE (start.id STARTS WITH $namespace
        OR start.missionId STARTS WITH $namespace
        OR start.sweepId STARTS WITH $namespace
        OR start.correlationId STARTS WITH $namespace
        OR start.userId STARTS WITH $namespace
        OR start.entityId STARTS WITH $namespace)
       AND (end.id STARTS WITH $namespace
        OR end.missionId STARTS WITH $namespace
        OR end.sweepId STARTS WITH $namespace
        OR end.correlationId STARTS WITH $namespace
        OR end.userId STARTS WITH $namespace
        OR end.entityId STARTS WITH $namespace)
     RETURN type(relationship) AS type, count(relationship) AS count
     ORDER BY type`,
    { namespace: NAMESPACE }
  );
  return Object.fromEntries(result.records.map((row) => [row.type, row.count]));
}

const missionRun: AgentRunSyncParams = {
  id: `${NAMESPACE}-run-mission`,
  missionId: `${NAMESPACE}-mission`,
  agentName: 'scout',
  action: 'Mission memory proof',
  status: 'success',
  userId: USER_ID,
  createdAt: '2026-07-14T10:00:00.000Z',
  costUsd: 0.1,
  duration: 1_000,
};

const sweepRun: AgentRunSyncParams = {
  id: `${NAMESPACE}-run-sweep`,
  sweepId: `${NAMESPACE}-sweep`,
  agentName: 'sweep-cycle',
  action: 'Sweep memory proof',
  status: 'success',
  userId: USER_ID,
  createdAt: '2026-07-14T10:01:00.000Z',
  costUsd: 0,
  duration: 500,
};

describeIntegration('graph memory liveness (real disposable Neo4j)', () => {
  beforeAll(async () => {
    expect(process.env.NEO4J_INTEGRATION_DISPOSABLE).toBe('true');
    const health = await checkHealth();
    if (!health.healthy) throw new Error(`[GRAPH-032] disposable Neo4j is not healthy: ${health.error}`);
    for (const statement of [
      'CREATE CONSTRAINT graph032_entity_id IF NOT EXISTS FOR (node:Entity) REQUIRE node.id IS UNIQUE',
      'CREATE CONSTRAINT graph032_episode_id IF NOT EXISTS FOR (node:Episode) REQUIRE node.id IS UNIQUE',
      'CREATE CONSTRAINT graph032_observation_id IF NOT EXISTS FOR (node:Observation) REQUIRE node.id IS UNIQUE',
      'CREATE CONSTRAINT graph032_agent_observation_id IF NOT EXISTS FOR (node:AgentObservation) REQUIRE node.id IS UNIQUE',
      'CREATE CONSTRAINT graph032_agent_run_id IF NOT EXISTS FOR (node:AgentRun) REQUIRE node.id IS UNIQUE',
    ]) {
      await runWriteTransaction(statement);
    }
    await cleanup();
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanup();
      await expect(census()).resolves.toEqual({ nodes: 0, relationships: 0 });
    } finally {
      try {
        for (const constraint of OWNED_CONSTRAINTS) {
          await runWriteTransaction(`DROP CONSTRAINT ${constraint} IF EXISTS`);
        }
      } finally {
        await closeDriver();
      }
    }
  }, 60_000);

  it('writes, retrieves, replays, correlates, and cleans supported mission and proactive memory', async () => {
    const missionTarget = `${NAMESPACE}-technology-mission`;
    const sweepTarget = `${NAMESPACE}-technology-sweep`;
    const legacyMissionId = `${NAMESPACE}-legacy-mission`;
    const legacyRunId = `${NAMESPACE}-run-legacy`;

    try {

    await runWriteTransaction(
      `CREATE (:Entity:Technology {id: $missionTarget, name: 'Mission target', entityType: 'technology'})
       CREATE (:Entity:Technology {id: $sweepTarget, name: 'Sweep target', entityType: 'technology'})`,
      { missionTarget, sweepTarget }
    );

    // A correlated run may arrive before its Episode. Projection fails closed
    // so no orphan is written; an exact later replay creates and links it.
    await syncAgentRunToNeo4j(missionRun);
    const beforeEpisode = await runReadTransaction<{ runs: number; links: number }>(
      `OPTIONAL MATCH (run:AgentRun {id: $runId})
       OPTIONAL MATCH (run)-[link:EXECUTED_DURING]->()
       RETURN count(DISTINCT run) AS runs, count(link) AS links`,
      { runId: missionRun.id }
    );
    expect(beforeEpisode.records[0]).toEqual({ runs: 0, links: 0 });

    const missionEpisode = await createEpisode({
      agentName: 'scout',
      missionId: missionRun.missionId!,
      userId: USER_ID,
      summary: 'Mission memory proof',
    });
    const missionObservationInput = {
      missionId: missionRun.missionId!,
      entityId: missionTarget,
      sourceUrl: 'https://example.com/graph-032-mission',
      verdict: 'confirming' as const,
      agentType: 'scout' as const,
      observedAt: '2026-07-14T10:00:30.000Z',
    };
    const missionObservation = await recordObservation(missionObservationInput);
    const { addObservationToEpisode } = await import('../episodes');
    await addObservationToEpisode(missionEpisode.id, missionObservation.id);
    await syncAgentRunToNeo4j(missionRun);
    const afterEpisode = await runReadTransaction<{ runs: number; links: number }>(
      `OPTIONAL MATCH (run:AgentRun {id: $runId})
       OPTIONAL MATCH (run)-[link:EXECUTED_DURING]->(episode:Episode {id: $episodeId})
       RETURN count(DISTINCT run) AS runs, count(link) AS links`,
      { runId: missionRun.id, episodeId: missionEpisode.id }
    );
    expect(afterEpisode.records[0]).toEqual({ runs: 1, links: 1 });
    await completeEpisode(missionEpisode.id, 'Mission complete');

    const sweepEpisode = await createEpisode({
      agentName: 'sweep-cycle',
      missionId: sweepRun.sweepId!,
      userId: USER_ID,
      summary: 'Sweep memory proof',
    });
    const sweepObservationInput = {
      sweepId: sweepRun.sweepId!,
      episodeId: sweepEpisode.id,
      gapIndex: 0,
      title: 'Sweep target needs evidence',
      summary: 'Sweep found a stale evidence gap',
      confidence: 0.8,
      entityId: sweepTarget,
      entityName: 'Sweep target',
      entityType: 'technology',
      timestamp: '2026-07-14T10:01:30.000Z',
    };
    const sweepObservation = await recordSweepObservation(sweepObservationInput);
    expect(sweepObservation.status).toBe('recorded');
    await syncAgentRunToNeo4j(sweepRun);
    await completeEpisode(sweepEpisode.id, 'Sweep complete');

    // Standalone proactive observations are valid insight substrate but are not
    // allowed to inflate the Episode-owned sweep denominator.
    await recordAgentObservation({
      agentType: 'community-watch',
      observationType: 'pattern',
      title: 'Standalone graph signal',
      summary: 'No Episode ownership by design',
      confidence: 0.7,
      entityId: sweepTarget,
      entityName: 'Sweep target',
      entityType: 'technology',
      timestamp: '2026-07-14T10:02:00.000Z',
    });
    await syncAgentRunToNeo4j({
      ...missionRun,
      id: `${NAMESPACE}-run-standalone`,
      missionId: undefined,
      action: 'Standalone run',
    });

    // A matching pre-contract node can gain correlation metadata and lineage,
    // but its immutable execution payload cannot be rewritten.
    const legacyEpisode = await createEpisode({
      agentName: 'scout',
      missionId: legacyMissionId,
      userId: USER_ID,
      summary: 'Legacy enrichment owner',
    });
    const legacyRun: AgentRunSyncParams = {
      ...missionRun,
      id: legacyRunId,
      missionId: legacyMissionId,
      action: 'Legacy exact payload',
      createdAt: '2026-07-14T10:03:00.000Z',
    };
    await runWriteTransaction(
      `CREATE (:AgentRun {
        id: $id, agentName: $agentName, action: $action, status: $status,
        userId: $userId, createdAt: $createdAt, costUsd: $costUsd, duration: $duration
      })`,
      { ...legacyRun }
    );
    await syncAgentRunToNeo4j(legacyRun);
    const enriched = await runReadTransaction<{
      correlationId: string;
      memoryLane: string;
      links: number;
      action: string;
    }>(
      `MATCH (run:AgentRun {id: $runId})
       OPTIONAL MATCH (run)-[link:EXECUTED_DURING]->(episode:Episode {id: $episodeId})
       RETURN run.correlationId AS correlationId, run.memoryLane AS memoryLane,
              run.action AS action, count(link) AS links`,
      { runId: legacyRunId, episodeId: legacyEpisode.id }
    );
    expect(enriched.records[0]).toEqual({
      correlationId: legacyMissionId,
      memoryLane: 'mission',
      links: 1,
      action: 'Legacy exact payload',
    });
    await syncAgentRunToNeo4j({ ...legacyRun, action: 'Conflicting replay must not win' });
    const conflictProof = await runReadTransaction<{ action: string; links: number }>(
      `MATCH (run:AgentRun {id: $runId})
       OPTIONAL MATCH (run)-[link:EXECUTED_DURING]->(:Episode {id: $episodeId})
       RETURN run.action AS action, count(link) AS links`,
      { runId: legacyRunId, episodeId: legacyEpisode.id }
    );
    expect(conflictProof.records[0]).toEqual({ action: 'Legacy exact payload', links: 1 });

    const missionRetrieved = await getEpisodeWithObservations(missionEpisode.id);
    const sweepRetrieved = await getEpisodeWithObservations(sweepEpisode.id);
    expect(missionRetrieved?.observations).toEqual([
      expect.objectContaining({ id: missionObservation.id, correlationId: missionRun.missionId }),
    ]);
    expect(sweepRetrieved?.observations).toEqual([
      expect.objectContaining({ correlationId: sweepRun.sweepId, provenanceKind: 'sweep-gap' }),
    ]);

    const liveness = await readGraphMemoryLiveness();
    expect(liveness).toEqual({
      mission: expect.objectContaining({ total: 1, eligible: 1, alive: true }),
      proactiveSweep: expect.objectContaining({ total: 2, eligible: 1, alive: true }),
      agentRuns: expect.objectContaining({ total: 4, eligible: 3, linked: 3, alive: true }),
    });

    const conflictingRunId = `${NAMESPACE}-run-conflicting-episode-provenance`;
    const conflictingEpisodeId = `${NAMESPACE}-episode-conflicting-provenance`;
    const conflictingCorrelationId = `${NAMESPACE}-conflicting-provenance-mission`;
    await runWriteTransaction(
      `CREATE (episode:Episode {
         id: $episodeId, missionId: $correlationId, userId: $userId,
         agentName: 'scout', memoryLane: 'proactive-sweep',
         correlationId: $wrongCorrelationId
       })
       CREATE (run:AgentRun {
         id: $runId, agentName: 'scout', action: 'Conflicting Episode provenance',
         status: 'success', userId: $userId,
         createdAt: '2026-07-14T10:04:00.000Z', costUsd: 0, duration: 1,
         correlationId: $correlationId, correlationKind: 'mission',
         missionId: $correlationId, memoryLane: 'mission'
       })
       CREATE (run)-[:EXECUTED_DURING]->(episode)`,
      {
        episodeId: conflictingEpisodeId,
        runId: conflictingRunId,
        correlationId: conflictingCorrelationId,
        wrongCorrelationId: `${conflictingCorrelationId}-wrong`,
        userId: USER_ID,
      }
    );
    expect((await readGraphMemoryLiveness()).agentRuns).toEqual(
      expect.objectContaining({ total: 5, eligible: 4, linked: 3, alive: false })
    );
    await runWriteTransaction(
      `MATCH (node) WHERE node.id IN [$runId, $episodeId] DETACH DELETE node`,
      { runId: conflictingRunId, episodeId: conflictingEpisodeId }
    );

    expect(await relationshipCounts()).toEqual({
      ABOUT: 2,
      CONTAINS: 2,
      EXECUTED_DURING: 3,
      OBSERVES: 1,
    });

    const stable = await fingerprint();
    await createEpisode({
      agentName: 'scout',
      missionId: missionRun.missionId!,
      userId: USER_ID,
      summary: 'Mission memory proof',
    });
    await recordObservation({ ...missionObservationInput, observedAt: '2026-07-14T11:00:00.000Z' });
    await addObservationToEpisode(missionEpisode.id, missionObservation.id);
    await recordSweepObservation(sweepObservationInput);
    await Promise.all([
      syncAgentRunToNeo4j(missionRun),
      syncAgentRunToNeo4j(sweepRun),
      syncAgentRunToNeo4j(legacyRun),
    ]);
    await completeEpisode(missionEpisode.id, 'Mission complete');
    await completeEpisode(sweepEpisode.id, 'Sweep complete');
    await expect(fingerprint()).resolves.toEqual(stable);
    } finally {
      await cleanup();
      await expect(census()).resolves.toEqual({ nodes: 0, relationships: 0 });
    }
  }, 60_000);
});
