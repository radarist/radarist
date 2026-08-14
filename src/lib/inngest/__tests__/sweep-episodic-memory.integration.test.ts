/**
 * Real-disposable proof for GRAPH-022 Episode identity and GRAPH-023 sweep
 * observation grouping. This suite never targets the protected Neo4j port.
 */

import { randomUUID } from 'node:crypto';
import { checkHealth, closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';

const TEST_NAMESPACE = `graph-022-023-${randomUUID()}`;
const USER_ID = `${TEST_NAMESPACE}-user`;

interface OwnedCensus {
  nodes: number;
  relationships: number;
}

interface OwnedFingerprint {
  nodes: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
}

async function cleanupOwnedFixture(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
        OR node.id STARTS WITH $namespace
     DETACH DELETE node`,
    { namespace: TEST_NAMESPACE }
  );
}

async function readOwnedCensus(): Promise<OwnedCensus> {
  const nodes = await runReadTransaction<{ nodes: number }>(
    `MATCH (node)
     WHERE node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
        OR node.id STARTS WITH $namespace
     RETURN count(node) AS nodes`,
    { namespace: TEST_NAMESPACE }
  );
  const relationships = await runReadTransaction<{ relationships: number }>(
    `MATCH (node)-[relationship]-()
     WHERE node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
        OR node.id STARTS WITH $namespace
     RETURN count(DISTINCT relationship) AS relationships`,
    { namespace: TEST_NAMESPACE }
  );
  return {
    nodes: nodes.records[0]?.nodes ?? 0,
    relationships: relationships.records[0]?.relationships ?? 0,
  };
}

async function readOwnedFingerprint(): Promise<OwnedFingerprint> {
  const result = await runReadTransaction<OwnedFingerprint>(
    `MATCH (node)
     WHERE node.missionId STARTS WITH $namespace
        OR node.sweepId STARTS WITH $namespace
        OR node.userId STARTS WITH $namespace
        OR node.entityId STARTS WITH $namespace
        OR node.id STARTS WITH $namespace
     WITH node ORDER BY node.id
     WITH collect({id: node.id, labels: labels(node), properties: properties(node)}) AS nodes
     OPTIONAL MATCH (start)-[relationship]->(end)
     WHERE start.missionId STARTS WITH $namespace
        OR start.sweepId STARTS WITH $namespace
        OR start.userId STARTS WITH $namespace
        OR start.entityId STARTS WITH $namespace
        OR start.id STARTS WITH $namespace
        OR end.missionId STARTS WITH $namespace
        OR end.sweepId STARTS WITH $namespace
        OR end.userId STARTS WITH $namespace
        OR end.entityId STARTS WITH $namespace
        OR end.id STARTS WITH $namespace
     WITH nodes, start, relationship, end
     ORDER BY type(relationship), start.id, end.id
     RETURN nodes,
            collect(CASE WHEN relationship IS NULL THEN null ELSE {
              type: type(relationship), startId: start.id, endId: end.id,
              properties: properties(relationship)
            } END) AS relationships`,
    { namespace: TEST_NAMESPACE }
  );
  return result.records[0] ?? { nodes: [], relationships: [] };
}

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS === '1' ? describe : describe.skip;

describeIntegration('sweep episodic memory (real disposable Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) throw new Error(`[Integration Tests] disposable Neo4j is not healthy: ${health.error}`);
    await runWriteTransaction(
      'CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (episode:Episode) REQUIRE episode.id IS UNIQUE'
    );
    await runWriteTransaction(
      'CREATE CONSTRAINT agent_observation_id IF NOT EXISTS FOR (observation:AgentObservation) REQUIRE observation.id IS UNIQUE'
    );
    await cleanupOwnedFixture();
  }, 60_000);

  afterAll(async () => {
    await cleanupOwnedFixture();
    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
    await closeDriver();
  }, 60_000);

  it('converges Episode identity across lost acknowledgements, concurrency, legacy rows, and conflicts', async () => {
    const {
      completeEpisode,
      createEpisode,
      createEpisodeId,
      abandonStaleEpisodes,
      EpisodeIdentityConflictError,
      EpisodeTerminalStateConflictError,
      failEpisode,
    } = await import('@/lib/graph/episodes');
    const { syncAgentRunToNeo4j } = await import('@/lib/graph/agent-run-sync');
    const missionId = `${TEST_NAMESPACE}-mission`;
    const params = { agentName: 'scout', missionId, userId: USER_ID, summary: 'Episode convergence proof' };
    const expectedId = createEpisodeId(missionId);

    try {
      const persistThenLoseAcknowledgement = async () => {
        await createEpisode(params);
        throw new Error('episode acknowledgement lost after commit');
      };
      await expect(persistThenLoseAcknowledgement()).rejects.toThrow('acknowledgement lost after commit');

      const replays = await Promise.all(Array.from({ length: 8 }, () => createEpisode(params)));
      expect(new Set(replays.map(({ id }) => id))).toEqual(new Set([expectedId]));

      const concurrentMissionId = `${TEST_NAMESPACE}-concurrent-first-mission`;
      const concurrentParams = {
        agentName: 'scout',
        missionId: concurrentMissionId,
        userId: USER_ID,
        summary: 'Concurrent first creation proof',
      };
      const concurrentFirstEpisodes = await Promise.all(
        Array.from({ length: 8 }, () => createEpisode(concurrentParams))
      );
      expect(new Set(concurrentFirstEpisodes.map(({ id }) => id))).toEqual(
        new Set([createEpisodeId(concurrentMissionId)])
      );
      const concurrentFirstCount = await runReadTransaction<{ count: number }>(
        'MATCH (episode:Episode {missionId: $missionId}) RETURN count(episode) AS count',
        { missionId: concurrentMissionId }
      );
      expect(concurrentFirstCount.records[0]?.count).toBe(1);

      await completeEpisode(expectedId, 'Completed once');
      const terminalBefore = await runReadTransaction<{
        count: number;
        status: string;
        summary: string;
        startedAt: string;
        endedAt: string;
      }>(
        `MATCH (episode:Episode {missionId: $missionId})
         RETURN count(episode) AS count, head(collect(episode.status)) AS status,
                head(collect(episode.summary)) AS summary,
                toString(head(collect(episode.startedAt))) AS startedAt,
                toString(head(collect(episode.endedAt))) AS endedAt`,
        { missionId }
      );
      await createEpisode(params);
      await completeEpisode(expectedId, 'Completed once');
      await expect(completeEpisode(expectedId, 'Must not overwrite terminal summary')).rejects.toBeInstanceOf(
        EpisodeTerminalStateConflictError
      );
      const terminalAfter = await runReadTransaction<{
        count: number;
        status: string;
        summary: string;
        startedAt: string;
        endedAt: string;
      }>(
        `MATCH (episode:Episode {missionId: $missionId})
         RETURN count(episode) AS count, head(collect(episode.status)) AS status,
                head(collect(episode.summary)) AS summary,
                toString(head(collect(episode.startedAt))) AS startedAt,
                toString(head(collect(episode.endedAt))) AS endedAt`,
        { missionId }
      );
      expect(terminalBefore.records[0]).toEqual({
        count: 1,
        status: 'completed',
        summary: 'Completed once',
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      });
      expect(terminalAfter.records[0]).toEqual(terminalBefore.records[0]);

      const terminalRaces = await Promise.all(
        Array.from({ length: 12 }, async (_, index) => {
          const raceMissionId = `${TEST_NAMESPACE}-terminal-race-${index}`;
          const raceEpisode = await createEpisode({
            agentName: 'scout',
            missionId: raceMissionId,
            userId: USER_ID,
            summary: 'Terminal race proof',
          });
          const outcomes = await Promise.allSettled([
            completeEpisode(raceEpisode.id, 'Race completed'),
            failEpisode(raceEpisode.id),
          ]);
          expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
          expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);

          const state = await runReadTransaction<{ status: 'completed' | 'failed'; summary: string }>(
            `MATCH (episode:Episode {id: $episodeId})
             RETURN episode.status AS status, episode.summary AS summary`,
            { episodeId: raceEpisode.id }
          );
          const terminal = state.records[0];
          expect(terminal?.status).toMatch(/^(completed|failed)$/);
          const exactReplays = Array.from({ length: 4 }, () =>
            terminal?.status === 'completed'
              ? completeEpisode(raceEpisode.id, 'Race completed')
              : failEpisode(raceEpisode.id)
          );
          await expect(Promise.all(exactReplays)).resolves.toEqual([undefined, undefined, undefined, undefined]);
          return terminal?.status;
        })
      );
      expect(terminalRaces).toHaveLength(12);

      const externalStale = await runReadTransaction<{ count: number }>(
        `MATCH (episode:Episode)
         WHERE NOT episode.id STARTS WITH $namespace
           AND episode.status = 'active'
           AND episode.endedAt IS NULL
           AND episode.startedAt < datetime() - duration({hours: 6})
         RETURN count(episode) AS count`,
        { namespace: TEST_NAMESPACE }
      );
      expect(externalStale.records[0]?.count).toBe(0);

      for (let index = 0; index < 12; index++) {
        const staleMissionId = `${TEST_NAMESPACE}-stale-race-${index}`;
        const staleEpisode = await createEpisode({
          agentName: 'scout',
          missionId: staleMissionId,
          userId: USER_ID,
          summary: 'Stale terminal race proof',
        });
        await runWriteTransaction(
          `MATCH (episode:Episode {id: $episodeId})
           SET episode.startedAt = datetime() - duration({hours: 12})`,
          { episodeId: staleEpisode.id }
        );

        const [completion, cleanup] = await Promise.allSettled([
          completeEpisode(staleEpisode.id, 'Completed before cleanup'),
          abandonStaleEpisodes(6),
        ]);
        expect(cleanup.status).toBe('fulfilled');
        const abandonedCount = cleanup.status === 'fulfilled' ? cleanup.value : -1;
        const finalState = await runReadTransaction<{ status: string; summary: string }>(
          `MATCH (episode:Episode {id: $episodeId})
           RETURN episode.status AS status, episode.summary AS summary`,
          { episodeId: staleEpisode.id }
        );
        if (completion.status === 'fulfilled') {
          expect(abandonedCount).toBe(0);
          expect(finalState.records[0]).toEqual({
            status: 'completed',
            summary: 'Completed before cleanup',
          });
        } else {
          expect(abandonedCount).toBe(1);
          expect(finalState.records[0]).toEqual({
            status: 'abandoned',
            summary: 'Stale terminal race proof',
          });
        }
      }

      await syncAgentRunToNeo4j({
        id: `${TEST_NAMESPACE}-run`,
        agentName: 'scout',
        action: 'Episode convergence proof',
        status: 'success',
        userId: USER_ID,
        createdAt: '2026-07-13T12:00:00.000Z',
        costUsd: 0,
        duration: 1,
        missionId,
      });
      const lineage = await runReadTransaction<{ edges: number }>(
        `OPTIONAL MATCH (:AgentRun {id: $runId})-[edge:EXECUTED_DURING]->(:Episode {missionId: $missionId})
         RETURN count(edge) AS edges`,
        { runId: `${TEST_NAMESPACE}-run`, missionId }
      );
      expect(lineage.records[0]?.edges).toBe(1);

      const legacyMissionId = `${TEST_NAMESPACE}-legacy-mission`;
      const legacyId = `${TEST_NAMESPACE}-legacy-episode`;
      await runWriteTransaction(
        `CREATE (:Episode {
           id: $legacyId, missionId: $legacyMissionId, userId: $userId,
           agentName: 'scout', summary: 'legacy', status: 'active',
           startedAt: datetime(), observationCount: 0
         })`,
        { legacyId, legacyMissionId, userId: USER_ID }
      );
      await expect(
        createEpisode({ agentName: 'scout', missionId: legacyMissionId, userId: USER_ID, summary: 'legacy' })
      ).resolves.toEqual({ id: legacyId });

      const conflictMissionId = `${TEST_NAMESPACE}-conflict-mission`;
      const conflicting = await Promise.allSettled([
        createEpisode({ agentName: 'scout', missionId: conflictMissionId, userId: USER_ID, summary: 'winner' }),
        createEpisode({
          agentName: 'linker',
          missionId: conflictMissionId,
          userId: `${TEST_NAMESPACE}-other-user`,
          summary: 'conflict',
        }),
      ]);
      expect(conflicting.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(conflicting.filter(({ status }) => status === 'rejected')).toHaveLength(1);

      const ambiguousMissionId = `${TEST_NAMESPACE}-ambiguous-mission`;
      await runWriteTransaction(
        `CREATE (:Episode {id: $first, missionId: $missionId, userId: $userId, agentName: 'scout'})
         CREATE (:Episode {id: $second, missionId: $missionId, userId: $userId, agentName: 'scout'})`,
        {
          first: `${TEST_NAMESPACE}-ambiguous-1`,
          second: `${TEST_NAMESPACE}-ambiguous-2`,
          missionId: ambiguousMissionId,
          userId: USER_ID,
        }
      );
      const ambiguousBefore = await readOwnedCensus();
      await expect(
        createEpisode({ agentName: 'scout', missionId: ambiguousMissionId, userId: USER_ID, summary: 'no write' })
      ).rejects.toBeInstanceOf(EpisodeIdentityConflictError);
      await expect(readOwnedCensus()).resolves.toEqual(ambiguousBefore);
    } finally {
      await cleanupOwnedFixture();
    }

    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
  }, 60_000);

  it('atomically groups only deterministic sweep observations and converges on replay', async () => {
    const { createEpisode, failEpisode } = await import('@/lib/graph/episodes');
    const { createSweepObservationId } = await import('@/lib/graph/observation-identity');
    const { recordAgentObservation } = await import('@/lib/graph/proactive-insights');
    const {
      recordSweepObservation,
      SweepObservationEpisodeUnavailableError,
      SweepObservationIdentityConflictError,
    } = await import('@/lib/graph/sweep-observations');
    const sweepId = `${TEST_NAMESPACE}-sweep`;
    const episode = await createEpisode({
      agentName: 'sweep-cycle',
      missionId: sweepId,
      userId: USER_ID,
      summary: 'Sweep observation convergence proof',
    });
    const firstTarget = `${TEST_NAMESPACE}-target-1`;
    const secondTarget = `${TEST_NAMESPACE}-target-2`;
    const ambiguousTarget = `${TEST_NAMESPACE}-ambiguous-target`;
    await runWriteTransaction(
      `CREATE (:Entity:Technology {id: $firstTarget, name: 'First', entityType: 'technology'})
       CREATE (:Entity:Technology {id: $secondTarget, name: 'Second', entityType: 'technology'})`,
      { firstTarget, secondTarget }
    );

    const buildInput = (gapIndex: number, entityId: string, entityName: string) => ({
      sweepId,
      episodeId: episode.id,
      gapIndex,
      title: `Sweep: ${entityName}`,
      summary: `Sweep cycle flagged ${entityName}`,
      confidence: 0.8,
      entityId,
      entityName,
      entityType: 'technology',
      timestamp: '2026-07-13T12:00:00.000Z',
    });
    const first = buildInput(0, firstTarget, 'First');
    const sameTargetOtherGap = buildInput(1, firstTarget, 'First');
    const second = buildInput(2, secondTarget, 'Second');

    try {
      const persistThenLoseAcknowledgement = async () => {
        await recordSweepObservation(first);
        throw new Error('sweep observation acknowledgement lost after commit');
      };
      await expect(persistThenLoseAcknowledgement()).rejects.toThrow('acknowledgement lost after commit');

      const sameObservationReplays = await Promise.all(
        Array.from({ length: 6 }, () => recordSweepObservation({ ...first, timestamp: new Date().toISOString() }))
      );
      expect(
        new Set(
          sameObservationReplays.map((result) =>
            result.status === 'recorded' ? result.observation.id : result.observationId
          )
        )
      ).toEqual(new Set([createSweepObservationId(first)]));

      const concurrentFirstCreation = await Promise.all(
        Array.from({ length: 6 }, () => recordSweepObservation(sameTargetOtherGap))
      );
      expect(
        new Set(
          concurrentFirstCreation.map((result) =>
            result.status === 'recorded' ? result.observation.id : result.observationId
          )
        )
      ).toEqual(new Set([createSweepObservationId(sameTargetOtherGap)]));
      await recordSweepObservation(second);
      const proof = await runReadTransaction<{
        episodes: number;
        observations: number;
        aboutEdges: number;
        containsEdges: number;
        observationCount: number;
      }>(
        `MATCH (episode:Episode {id: $episodeId})
         OPTIONAL MATCH (episode)-[contains:CONTAINS]->(observation:AgentObservation {sweepId: $sweepId})
         WITH episode, count(DISTINCT contains) AS containsEdges, count(DISTINCT observation) AS observations
         OPTIONAL MATCH (:AgentObservation {sweepId: $sweepId})-[about:ABOUT]->(:Entity)
         RETURN 1 AS episodes, observations, count(DISTINCT about) AS aboutEdges,
                containsEdges, episode.observationCount AS observationCount`,
        { episodeId: episode.id, sweepId }
      );
      expect(proof.records[0]).toEqual({
        episodes: 1,
        observations: 3,
        aboutEdges: 3,
        containsEdges: 3,
        observationCount: 3,
      });

      const replayFingerprint = proof.records[0];
      await Promise.all([first, sameTargetOtherGap, second].map((input) => recordSweepObservation(input)));
      const replayProof = await runReadTransaction<typeof replayFingerprint>(
        `MATCH (episode:Episode {id: $episodeId})
         OPTIONAL MATCH (episode)-[contains:CONTAINS]->(observation:AgentObservation {sweepId: $sweepId})
         WITH episode, count(DISTINCT contains) AS containsEdges, count(DISTINCT observation) AS observations
         OPTIONAL MATCH (:AgentObservation {sweepId: $sweepId})-[about:ABOUT]->(:Entity)
         RETURN 1 AS episodes, observations, count(DISTINCT about) AS aboutEdges,
                containsEdges, episode.observationCount AS observationCount`,
        { episodeId: episode.id, sweepId }
      );
      expect(replayProof.records[0]).toEqual(replayFingerprint);

      const missing = buildInput(3, `${TEST_NAMESPACE}-missing-target`, 'Missing');
      await expect(recordSweepObservation(missing)).resolves.toMatchObject({
        status: 'skipped',
        reason: 'target-unavailable',
      });
      const ambiguous = buildInput(4, ambiguousTarget, 'Ambiguous');
      await runWriteTransaction('DROP CONSTRAINT entity_id IF EXISTS');
      try {
        await runWriteTransaction(
          `CREATE (:Entity:Technology {id: $id, name: 'Ambiguous technology', entityType: 'technology'})
           CREATE (:Entity:Company {id: $id, name: 'Ambiguous company', entityType: 'company'})`,
          { id: ambiguousTarget }
        );
        await expect(recordSweepObservation(ambiguous)).resolves.toMatchObject({
          status: 'skipped',
          reason: 'target-unavailable',
        });
        const absent = await runReadTransaction<{ count: number }>(
          `OPTIONAL MATCH (observation:AgentObservation)
           WHERE observation.id IN $ids
           RETURN count(observation) AS count`,
          { ids: [createSweepObservationId(missing), createSweepObservationId(ambiguous)] }
        );
        expect(absent.records[0]?.count).toBe(0);
      } finally {
        await runWriteTransaction('MATCH (entity:Entity {id: $id}) DETACH DELETE entity', { id: ambiguousTarget });
        await runWriteTransaction(
          'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (entity:Entity) REQUIRE entity.id IS UNIQUE'
        );
      }

      await expect(recordSweepObservation({ ...first, summary: 'conflicting payload' })).rejects.toBeInstanceOf(
        SweepObservationIdentityConflictError
      );

      const wrongOwnerSweepId = `${TEST_NAMESPACE}-wrong-owner-sweep`;
      const wrongOwnerEpisode = await createEpisode({
        agentName: 'scout',
        missionId: wrongOwnerSweepId,
        userId: USER_ID,
        summary: 'Wrong owner',
      });
      const wrongOwnerBefore = await readOwnedFingerprint();
      await expect(
        recordSweepObservation({
          ...buildInput(5, firstTarget, 'First'),
          sweepId: wrongOwnerSweepId,
          episodeId: wrongOwnerEpisode.id,
        })
      ).rejects.toBeInstanceOf(SweepObservationEpisodeUnavailableError);
      await expect(readOwnedFingerprint()).resolves.toEqual(wrongOwnerBefore);

      const failedSweepId = `${TEST_NAMESPACE}-failed-sweep`;
      const failedEpisode = await createEpisode({
        agentName: 'sweep-cycle',
        missionId: failedSweepId,
        userId: USER_ID,
        summary: 'Failed lifecycle',
      });
      await failEpisode(failedEpisode.id);
      const failedBefore = await readOwnedFingerprint();
      await expect(
        recordSweepObservation({
          ...buildInput(6, firstTarget, 'First'),
          sweepId: failedSweepId,
          episodeId: failedEpisode.id,
        })
      ).rejects.toBeInstanceOf(SweepObservationEpisodeUnavailableError);
      await expect(readOwnedFingerprint()).resolves.toEqual(failedBefore);

      const aboutConflict = buildInput(7, firstTarget, 'First');
      await runWriteTransaction(
        `MATCH (wrongTarget:Entity {id: $wrongTarget})
         CREATE (observation:AgentObservation {
           id: $id, agentType: 'sweep-cycle', observationType: 'discovery',
           sweepId: $sweepId, gapIndex: $gapIndex, title: $title,
           summary: $summary, confidence: $confidence, entityId: $entityId,
           entityName: $entityName, entityType: $entityType, timestamp: $timestamp
         })-[:ABOUT]->(wrongTarget)`,
        { ...aboutConflict, id: createSweepObservationId(aboutConflict), wrongTarget: secondTarget }
      );
      const aboutConflictBefore = await readOwnedFingerprint();
      await expect(recordSweepObservation(aboutConflict)).rejects.toBeInstanceOf(
        SweepObservationIdentityConflictError
      );
      await expect(readOwnedFingerprint()).resolves.toEqual(aboutConflictBefore);

      const foreignSweepId = `${TEST_NAMESPACE}-foreign-sweep`;
      const foreignEpisode = await createEpisode({
        agentName: 'sweep-cycle',
        missionId: foreignSweepId,
        userId: USER_ID,
        summary: 'Foreign lifecycle',
      });
      const containsConflict = buildInput(8, secondTarget, 'Second');
      await runWriteTransaction(
        `MATCH (foreign:Episode {id: $foreignEpisodeId})
         CREATE (observation:AgentObservation {
           id: $id, agentType: 'sweep-cycle', observationType: 'discovery',
           sweepId: $sweepId, gapIndex: $gapIndex, title: $title,
           summary: $summary, confidence: $confidence, entityId: $entityId,
           entityName: $entityName, entityType: $entityType, timestamp: $timestamp
         })
         CREATE (foreign)-[:CONTAINS]->(observation)`,
        {
          ...containsConflict,
          id: createSweepObservationId(containsConflict),
          foreignEpisodeId: foreignEpisode.id,
        }
      );
      const containsConflictBefore = await readOwnedFingerprint();
      await expect(recordSweepObservation(containsConflict)).rejects.toBeInstanceOf(
        SweepObservationIdentityConflictError
      );
      await expect(readOwnedFingerprint()).resolves.toEqual(containsConflictBefore);

      const unrelated = await recordAgentObservation({
        agentType: 'emergence-detector',
        observationType: 'pattern',
        title: 'Unrelated observation',
        summary: 'This lifecycle has no Episode ownership',
        confidence: 0.7,
        entityId: firstTarget,
        entityName: 'First',
        entityType: 'technology',
        timestamp: '2026-07-13T12:00:00.000Z',
      });
      const unrelatedLink = await runReadTransaction<{ contains: number }>(
        `OPTIONAL MATCH (:Episode)-[contains:CONTAINS]->(:AgentObservation {id: $observationId})
         RETURN count(contains) AS contains`,
        { observationId: unrelated.id }
      );
      expect(unrelatedLink.records[0]?.contains).toBe(0);
    } finally {
      await cleanupOwnedFixture();
    }

    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
  }, 60_000);
});
