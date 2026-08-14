/**
 * Hybrid mission integration: deterministic AI and Firestore boundaries with
 * the registered production Inngest handlers and a real disposable Neo4j.
 */

import { randomUUID } from 'node:crypto';
import { checkHealth, closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';

type RegisteredHandler = (context: Record<string, unknown>) => Promise<unknown>;
type StepOperation = () => unknown | Promise<unknown>;

const TEST_NAMESPACE = `graph-015-${randomUUID()}`;
const MISSION_ID = `${TEST_NAMESPACE}-mission`;
const USER_ID = `${TEST_NAMESPACE}-user`;
const TARGET_ID = `${TEST_NAMESPACE}-technology`;
const SOURCE_URL = `https://example.com/${TEST_NAMESPACE}`;
const START_TIME = Date.parse('2026-07-12T12:00:00.000Z');
const RETRY_MISSION_ID = `${TEST_NAMESPACE}-retry-mission`;
const OTHER_MISSION_ID = `${TEST_NAMESPACE}-other-mission`;
const RETRY_EPISODE_ID = `${TEST_NAMESPACE}-retry-episode`;
const OTHER_EPISODE_ID = `${TEST_NAMESPACE}-other-episode`;
const CONCURRENT_MISSION_ID = `${TEST_NAMESPACE}-concurrent-mission`;
const CONCURRENT_EPISODE_ID = `${TEST_NAMESPACE}-concurrent-episode`;
const LEGACY_MISSION_ID = `${TEST_NAMESPACE}-legacy-mission`;
const LEGACY_EPISODE_ID = `${TEST_NAMESPACE}-legacy-episode`;
const LEGACY_PLACEMENT_ID = `${TEST_NAMESPACE}-legacy-placement`;
const PLACEMENT_MISSION_ID = `${TEST_NAMESPACE}-placement-mission`;
const LEGACY_FINALIZATION_MISSION_ID = `${TEST_NAMESPACE}-legacy-finalization-mission`;
const LEGACY_FINALIZATION_EPISODE_ID = `${TEST_NAMESPACE}-legacy-finalization-episode`;

const mockMissionState: Record<string, unknown> = {
  id: MISSION_ID,
  userId: USER_ID,
  agent: 'scout',
  prompt: 'Run the disposable GRAPH-015 mission proof',
  status: 'pending',
  progress: 0,
  enablePrelude: false,
  entities: [{ id: TARGET_ID, name: 'GRAPH-015 target', type: 'technology' }],
  createdAt: '2026-07-12T11:59:00.000Z',
};

jest.mock('../client', () => {
  const handlers = new Map<string, unknown>();
  const sentEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn(
        (config: { id: string }, trigger: unknown, handler: unknown) => {
          handlers.set(config.id, handler);
          return { config, trigger, handler };
        }
      ),
      send: jest.fn(async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
        sentEvents.push(event);
      }),
    },
    _handlers: handlers,
    _sentEvents: sentEvents,
  };
});

jest.mock('@/lib/firebase-admin', () => {
  const documents = new Map<string, Record<string, unknown>>();
  return {
    __esModule: true,
    db: {
      collection: jest.fn((collectionName: string) => ({
        doc: (id: string) => ({
          set: async (data: Record<string, unknown>) => {
            documents.set(`${collectionName}/${id}`, { ...data });
          },
        }),
      })),
    },
    _documents: documents,
  };
});

jest.mock('@/lib/missions', () => ({
  __esModule: true,
  updateMission: jest.fn(async (missionId: string, patch: Record<string, unknown>) => {
    if (missionId !== MISSION_ID) throw new Error(`Unexpected mission update: ${missionId}`);
    Object.assign(mockMissionState, patch);
  }),
  getMissionById: jest.fn(async (missionId: string) =>
    missionId === MISSION_ID ? { ...mockMissionState } : null
  ),
  appendSkillInvocation: jest.fn(async () => undefined),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(async () => undefined),
}));

// Import after mocks so both production handlers register in one deterministic
// in-memory Inngest registry. Graph modules and createAgentRun remain real.
import '../functions/run-agent-mission';
import '../functions/record-observation';

const SCOUT_RESULT = [
  'Disposable mission completed with a reproducible source bundle and enough text for clean-result recovery rules.',
  'The graph target is supported by the cited source, so the mission emits one confirming observation.',
  '```json',
  JSON.stringify({
    queries: ['graph memory proof', 'episodic mission lineage', 'agent run provenance'],
    sources: [
      {
        id: 1,
        title: 'GRAPH-015 deterministic source',
        url: SOURCE_URL,
        fetched_via: 'exa',
        tool_call_id: `${TEST_NAMESPACE}-tool-call`,
        admiralty: 'A1',
        date_accessed: '2026-07-12',
      },
    ],
    findings: ['The disposable mission persistence path is connected [1].'],
    unresolved: [],
  }),
  '```',
].join('\n');

const ORCHESTRATOR_RESULT = {
  success: true,
  result: SCOUT_RESULT,
  costUsd: 0.01,
  tokenUsage: { input: 100, output: 50 },
  errors: undefined,
};

interface OwnedCensus {
  nodes: number;
  relationships: number;
}

interface MissionProof {
  episodeCount: number;
  episodeIds: string[];
  episodeStatuses: string[];
  episodeSummaries: string[];
  episodeEndedAt: string[];
  episodeFinalizationVersions: string[];
  observationCounts: number[];
  observationCount: number;
  observationIds: string[];
  runCount: number;
  targetCount: number;
  containsEdges: number;
  executedDuringEdges: number;
  observesEdges: number;
}

interface ObservationRetryProof {
  observationCount: number;
  observationIds: string[];
  verdicts: string[];
  observesEdges: number;
  containsEdges: number;
  episodeObservationCount: number;
}

function getInngestHarness(): {
  handlers: Map<string, unknown>;
  sentEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }>;
} {
  const harnessModule = jest.requireMock('../client') as {
    _handlers: Map<string, unknown>;
    _sentEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }>;
  };
  return { handlers: harnessModule._handlers, sentEvents: harnessModule._sentEvents };
}

function getFirestoreDocuments(): Map<string, Record<string, unknown>> {
  return (jest.requireMock('@/lib/firebase-admin') as {
    _documents: Map<string, Record<string, unknown>>;
  })._documents;
}

function getHandler(id: 'run-agent-mission' | 'record-observation'): RegisteredHandler {
  const handler = getInngestHarness().handlers.get(id);
  if (typeof handler !== 'function') throw new Error(`Inngest handler did not register: ${id}`);
  return handler as RegisteredHandler;
}

function createMemoizedStep(options: { mission?: boolean } = {}) {
  const cache = new Map<string, unknown>();
  const executed: string[] = [];
  const run = jest.fn(async (name: string, operation: StepOperation): Promise<unknown> => {
    if (cache.has(name)) return cache.get(name);

    let result: unknown;
    if (options.mission) {
      switch (name) {
        case 'capture-start-time':
          result = START_TIME;
          break;
        case 'capture-end-time':
          result = START_TIME + 1_000;
          break;
        case 'skill-activation-prelude':
          result = { block: '', totalCostUsd: 0 };
          break;
        case 'mcp-preflight':
          // This suite owns the real Neo4j boundary, not an HTTP/MCP runtime.
          // Preserve the production step and replay contract while supplying
          // the same successful memoized receipt as the dedicated OPS-004
          // preflight acceptances.
          result = { ok: true, baseUrl: 'http://127.0.0.1:9002/api/mcp', checked: [] };
          break;
        case 'execute-orchestrator':
          result = ORCHESTRATOR_RESULT;
          break;
        case 'recover-partial-on-failure':
        case 'revise-on-l1-fail':
          result = null;
          break;
        case 'evaluate-quality':
        case 'evaluate-quality-llm':
        case 'create-reflection':
        case 'advance-chain':
          result = undefined;
          break;
        default:
          result = await operation();
      }
    } else {
      result = await operation();
    }

    cache.set(name, result);
    executed.push(name);
    return result;
  });

  return {
    step: {
      run,
      sleep: jest.fn(async () => undefined),
      sendEvent: jest.fn(async () => undefined),
    },
    executed,
  };
}

function agentRunDocuments(): Array<Record<string, unknown>> {
  return Array.from(getFirestoreDocuments().entries())
    .filter(([path]) => path.startsWith('agentRuns/'))
    .map(([, document]) => document);
}

async function cleanupOwnedFixture(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.missionId STARTS WITH $namespace OR
           node.userId STARTS WITH $namespace OR
           node.id STARTS WITH $namespace
     DETACH DELETE node`,
    { namespace: TEST_NAMESPACE }
  );
}

async function readOwnedCensus(): Promise<OwnedCensus> {
  const result = await runReadTransaction<OwnedCensus>(
    `MATCH (node)
     WHERE node.missionId STARTS WITH $namespace OR
           node.userId STARTS WITH $namespace OR
           node.id STARTS WITH $namespace
     WITH collect(node) AS owned
     UNWIND CASE WHEN size(owned) = 0 THEN [null] ELSE owned END AS fixture
     OPTIONAL MATCH (fixture)-[relationship]-()
     RETURN size(owned) AS nodes, count(DISTINCT relationship) AS relationships`,
    { namespace: TEST_NAMESPACE }
  );
  return result.records[0] ?? { nodes: 0, relationships: 0 };
}

async function readMissionProof(runId: string): Promise<MissionProof> {
  const nodes = await runReadTransaction<Omit<MissionProof, 'containsEdges' | 'executedDuringEdges' | 'observesEdges'>>(
    `OPTIONAL MATCH (episode:Episode {missionId: $missionId})
     WITH collect(episode) AS episodes
     OPTIONAL MATCH (observation:Observation {missionId: $missionId})
     WITH episodes, collect(observation) AS observations
     OPTIONAL MATCH (run:AgentRun {id: $runId})
     WITH episodes, observations, collect(run) AS runs
     OPTIONAL MATCH (target:Technology {id: $targetId})
     WITH episodes, observations, runs, collect(target) AS targets
     RETURN size(episodes) AS episodeCount,
            [episode IN episodes | episode.id] AS episodeIds,
            [episode IN episodes | episode.status] AS episodeStatuses,
            [episode IN episodes | episode.summary] AS episodeSummaries,
            [episode IN episodes | toString(episode.endedAt)] AS episodeEndedAt,
            [episode IN episodes | episode.missionResultFinalizationVersion] AS episodeFinalizationVersions,
            [episode IN episodes | episode.observationCount] AS observationCounts,
            size(observations) AS observationCount,
            [observation IN observations | observation.id] AS observationIds,
            size(runs) AS runCount,
            size(targets) AS targetCount`,
    { missionId: MISSION_ID, runId, targetId: TARGET_ID }
  );
  const edges = await runReadTransaction<Pick<MissionProof, 'containsEdges' | 'executedDuringEdges' | 'observesEdges'>>(
    `OPTIONAL MATCH (:Episode {missionId: $missionId})-[contains:CONTAINS]->(:Observation {missionId: $missionId})
     WITH count(DISTINCT contains) AS containsEdges
     OPTIONAL MATCH (:AgentRun {id: $runId})-[executed:EXECUTED_DURING]->(:Episode {missionId: $missionId})
     WITH containsEdges, count(DISTINCT executed) AS executedDuringEdges
     OPTIONAL MATCH (:Observation {missionId: $missionId})-[observes:OBSERVES]->(:Technology {id: $targetId})
     RETURN containsEdges, executedDuringEdges, count(DISTINCT observes) AS observesEdges`,
    { missionId: MISSION_ID, runId, targetId: TARGET_ID }
  );
  if (!nodes.records[0] || !edges.records[0]) throw new Error('Mission graph proof returned no census row');
  return { ...nodes.records[0], ...edges.records[0] };
}

async function waitForMissionProof(runId: string): Promise<MissionProof> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const proof = await readMissionProof(runId);
    if (proof.executedDuringEdges === 1 && proof.containsEdges === 1) return proof;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readMissionProof(runId);
}

async function readObservationRetryProof(missionId: string, episodeId: string): Promise<ObservationRetryProof> {
  const result = await runReadTransaction<ObservationRetryProof>(
    `MATCH (episode:Episode {id: $episodeId})
     OPTIONAL MATCH (observation:Observation {missionId: $missionId})
     WITH episode, collect(observation) AS observations
     OPTIONAL MATCH (candidate:Observation {missionId: $missionId})-[observes:OBSERVES]->(:Entity {id: $targetId})
     WITH episode, observations, count(DISTINCT observes) AS observesEdges
     OPTIONAL MATCH (episode)-[contains:CONTAINS]->(:Observation {missionId: $missionId})
     RETURN size(observations) AS observationCount,
            [observation IN observations | observation.id] AS observationIds,
            [observation IN observations | observation.verdict] AS verdicts,
            observesEdges,
            count(DISTINCT contains) AS containsEdges,
            episode.observationCount AS episodeObservationCount`,
    { missionId, episodeId, targetId: TARGET_ID }
  );
  const proof = result.records[0];
  if (!proof) throw new Error(`Observation retry proof returned no row for ${missionId}`);
  return proof;
}

async function waitForAgentRunLineage(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await runReadTransaction<{ edges: number }>(
      `OPTIONAL MATCH (:AgentRun {id: $runId})-[edge:EXECUTED_DURING]->(:Episode {missionId: $missionId})
       RETURN count(DISTINCT edge) AS edges`,
      { runId, missionId: MISSION_ID }
    );
    if (result.records[0]?.edges === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`AgentRun ${runId} did not link to mission ${MISSION_ID}`);
}

async function settleOwnedAgentRunSyncs(): Promise<void> {
  const runIds = agentRunDocuments()
    .map((document) => document.id)
    .filter((id): id is string => typeof id === 'string');
  await Promise.all(
    runIds.map(async (runId) => {
      try {
        await waitForAgentRunLineage(runId);
      } catch {
        // A failed non-blocking sync is a valid negative outcome. The bounded
        // wait still lets its dynamic import/write settle before cleanup.
      }
    })
  );
}

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS === '1' ? describe : describe.skip;

describeIntegration('mission episodic memory (real disposable Neo4j)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) throw new Error(`[Integration Tests] disposable Neo4j is not healthy: ${health.error}`);
    await runWriteTransaction(
      'CREATE CONSTRAINT observation_id IF NOT EXISTS FOR (observation:Observation) REQUIRE observation.id IS UNIQUE'
    );
    await cleanupOwnedFixture();
    getFirestoreDocuments().clear();
    getInngestHarness().sentEvents.length = 0;
  }, 60_000);

  afterAll(async () => {
    await settleOwnedAgentRunSyncs();
    await cleanupOwnedFixture();
    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
    getFirestoreDocuments().clear();
    await closeDriver();
  }, 60_000);

  it('runs and replays one mission through Episode, observation, and AgentRun lineage with zero residue', async () => {
    const baseline = await readOwnedCensus();
    const missionStep = createMemoizedStep({ mission: true });
    const observationStep = createMemoizedStep();
    let proof: MissionProof | undefined;
    let emittedObservation: { id?: string; name: string; data: Record<string, unknown> } | undefined;
    let runDocument: Record<string, unknown> | undefined;

    try {
      await runWriteTransaction(
        `CREATE (:Entity:Technology {id: $targetId, name: 'GRAPH-015 disposable target', entityType: 'technology'})`,
        { targetId: TARGET_ID }
      );

      const missionContext = {
        event: {
          data: {
            missionId: MISSION_ID,
            userId: USER_ID,
            prompt: mockMissionState.prompt,
            agent: 'scout',
          },
        },
        step: missionStep.step,
      };
      const firstMissionResult = await getHandler('run-agent-mission')(missionContext);
      const replayedMissionResult = await getHandler('run-agent-mission')(missionContext);
      expect(firstMissionResult).toMatchObject({ missionId: MISSION_ID, success: true, duration: 1_000 });
      expect(replayedMissionResult).toEqual(firstMissionResult);

      const runs = agentRunDocuments();
      expect(runs).toHaveLength(1);
      runDocument = runs[0];
      expect(runDocument).toMatchObject({
        id: expect.stringMatching(/^run-/),
        missionId: MISSION_ID,
        userId: USER_ID,
        agentName: 'scout',
        status: 'success',
        duration: 1_000,
      });
      await waitForAgentRunLineage(String(runDocument.id));

      const observationEvents = getInngestHarness().sentEvents.filter(
        (event) => event.name === 'app/entity.observation.recorded'
      );
      if (observationEvents.length !== 1) {
        const { parseScoutBundle } = await import('@/lib/scout-bundle-parser');
        throw new Error(
          `Mission emitted ${observationEvents.length} observations: ${JSON.stringify({
            executed: missionStep.executed,
            sentEvents: getInngestHarness().sentEvents,
            entities: mockMissionState.entities,
            parsedBundle: parseScoutBundle(SCOUT_RESULT),
          })}`
        );
      }
      expect(observationEvents).toHaveLength(1);
      emittedObservation = observationEvents[0];
      expect(emittedObservation.id).toMatch(/^obs-mission-v1-[a-f0-9]{64}$/);
      expect(emittedObservation.data).toMatchObject({
        observationId: emittedObservation.id,
        entityId: TARGET_ID,
        sourceUrl: SOURCE_URL,
        verdict: 'confirming',
        agentType: 'scout',
        missionId: MISSION_ID,
        observedAt: new Date(START_TIME + 1_000).toISOString(),
      });

      const observationContext = {
        event: { id: emittedObservation.id, data: emittedObservation.data },
        step: observationStep.step,
      };
      const firstObservationResult = await getHandler('record-observation')(observationContext);
      const replayedObservationResult = await getHandler('record-observation')(observationContext);
      expect(firstObservationResult).toMatchObject({ recorded: true, episodeLinked: true });
      expect(replayedObservationResult).toEqual(firstObservationResult);

      proof = await waitForMissionProof(String(runDocument.id));
    } finally {
      await settleOwnedAgentRunSyncs();
      await cleanupOwnedFixture();
      getFirestoreDocuments().clear();
    }

    expect(baseline).toEqual({ nodes: 0, relationships: 0 });
    expect(missionStep.executed).toEqual(
      expect.arrayContaining([
        'create-episode',
        'complete-episode',
        'finalize-episode',
        'write-agent-run',
        'emit-scout-observations',
        'mcp-preflight',
      ])
    );
    for (const stepName of [
      'create-episode',
      'complete-episode',
      'finalize-episode',
      'write-agent-run',
      'emit-scout-observations',
      'mcp-preflight',
    ]) {
      expect(missionStep.executed.filter((name) => name === stepName)).toHaveLength(1);
    }
    expect(missionStep.executed.indexOf('complete-episode')).toBeLessThan(
      missionStep.executed.indexOf('evaluate-quality')
    );
    expect(missionStep.executed.indexOf('mcp-preflight')).toBeLessThan(
      missionStep.executed.indexOf('skill-activation-prelude')
    );
    expect(missionStep.executed.indexOf('mcp-preflight')).toBeLessThan(
      missionStep.executed.indexOf('execute-orchestrator')
    );
    expect(missionStep.executed.indexOf('revise-on-l1-fail')).toBeLessThan(
      missionStep.executed.indexOf('finalize-episode')
    );
    expect(missionStep.executed.indexOf('create-reflection')).toBeLessThan(
      missionStep.executed.indexOf('finalize-episode')
    );
    expect(missionStep.executed.indexOf('finalize-episode')).toBeLessThan(
      missionStep.executed.indexOf('write-agent-run')
    );
    expect(observationStep.executed).toEqual(['write-observation', 'link-observation-to-episode']);
    expect(proof).toEqual({
      episodeCount: 1,
      episodeIds: [expect.stringMatching(/^ep-/)],
      episodeStatuses: ['completed'],
      episodeSummaries: [SCOUT_RESULT.slice(0, 500)],
      episodeEndedAt: [expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)],
      episodeFinalizationVersions: ['mission-result-v1'],
      observationCounts: [1],
      observationCount: 1,
      observationIds: [expect.stringMatching(/^obs-/)],
      runCount: 1,
      targetCount: 1,
      containsEdges: 1,
      executedDuringEdges: 1,
      observesEdges: 1,
    });
    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
  }, 60_000);

  it('corrects one unmarked legacy terminal Episode, then freezes canonical history', async () => {
    const { EpisodeTerminalStateConflictError, finalizeMissionEpisode } = await import('@/lib/graph/episodes');
    const canonicalSummary = 'Canonical promoted mission result';
    const legacyEndedAt = '2026-01-01T00:00:00.000Z';

    try {
      await runWriteTransaction(
        `CREATE (:Episode {
           id: $episodeId,
           missionId: $missionId,
           userId: $userId,
           agentName: 'creator',
           summary: 'Premature pre-quality result',
           status: 'completed',
           startedAt: datetime('2025-12-31T23:59:00.000Z'),
           endedAt: datetime($legacyEndedAt),
           observationCount: 0
         })`,
        {
          episodeId: LEGACY_FINALIZATION_EPISODE_ID,
          missionId: LEGACY_FINALIZATION_MISSION_ID,
          userId: USER_ID,
          legacyEndedAt,
        }
      );

      const finalization = {
        episodeId: LEGACY_FINALIZATION_EPISODE_ID,
        missionId: LEGACY_FINALIZATION_MISSION_ID,
        userId: USER_ID,
        agentName: 'creator',
        status: 'completed' as const,
        summary: canonicalSummary,
        legacySummary: 'Premature pre-quality result',
      };

      await expect(
        finalizeMissionEpisode({ ...finalization, legacySummary: 'Wrong preliminary result' })
      ).rejects.toBeInstanceOf(EpisodeTerminalStateConflictError);
      const beforeCorrection = await runReadTransaction<{
        summary: string;
        endedAt: string;
        finalizationVersion: string | null;
      }>(
        `MATCH (episode:Episode {id: $episodeId})
         RETURN episode.summary AS summary,
                toString(episode.endedAt) AS endedAt,
                episode.missionResultFinalizationVersion AS finalizationVersion`,
        { episodeId: LEGACY_FINALIZATION_EPISODE_ID }
      );
      expect(beforeCorrection.records[0]).toMatchObject({
        summary: 'Premature pre-quality result',
        finalizationVersion: null,
      });
      expect(Date.parse(beforeCorrection.records[0]?.endedAt ?? '')).toBe(Date.parse(legacyEndedAt));

      await finalizeMissionEpisode(finalization);
      const afterCorrection = await runReadTransaction<{
        status: string;
        summary: string;
        endedAt: string;
        finalizationVersion: string;
      }>(
        `MATCH (episode:Episode {id: $episodeId})
         RETURN episode.status AS status,
                episode.summary AS summary,
                toString(episode.endedAt) AS endedAt,
                episode.missionResultFinalizationVersion AS finalizationVersion`,
        { episodeId: LEGACY_FINALIZATION_EPISODE_ID }
      );
      const canonical = afterCorrection.records[0];
      expect(canonical).toMatchObject({
        status: 'completed',
        summary: canonicalSummary,
        finalizationVersion: 'mission-result-v1',
      });
      expect(canonical?.endedAt).not.toBe(legacyEndedAt);

      await finalizeMissionEpisode(finalization);
      const afterReplay = await runReadTransaction<{ endedAt: string }>(
        `MATCH (episode:Episode {id: $episodeId})
         RETURN toString(episode.endedAt) AS endedAt`,
        { episodeId: LEGACY_FINALIZATION_EPISODE_ID }
      );
      expect(afterReplay.records[0]?.endedAt).toBe(canonical?.endedAt);

      await expect(
        finalizeMissionEpisode({ ...finalization, summary: 'Conflicting later result' })
      ).rejects.toBeInstanceOf(EpisodeTerminalStateConflictError);
      await expect(
        finalizeMissionEpisode({ ...finalization, status: 'failed' })
      ).rejects.toBeInstanceOf(EpisodeTerminalStateConflictError);

      const afterConflicts = await runReadTransaction<{
        status: string;
        summary: string;
        endedAt: string;
      }>(
        `MATCH (episode:Episode {id: $episodeId})
         RETURN episode.status AS status,
                episode.summary AS summary,
                toString(episode.endedAt) AS endedAt`,
        { episodeId: LEGACY_FINALIZATION_EPISODE_ID }
      );
      expect(afterConflicts.records[0]).toEqual({
        status: 'completed',
        summary: canonicalSummary,
        endedAt: canonical?.endedAt,
      });
    } finally {
      await cleanupOwnedFixture();
    }
  }, 60_000);

  it('converges after lost write/link acknowledgements and concurrent redelivery', async () => {
    const { recordObservation } = await import('@/lib/graph/observations');
    const { addObservationToEpisode } = await import('@/lib/graph/episodes');
    const { createMissionObservationId } = await import('@/lib/graph/observation-identity');
    const observedAt = '2026-07-13T10:00:00.000Z';
    const retryInput = {
      entityId: TARGET_ID,
      sourceUrl: SOURCE_URL,
      verdict: 'confirming' as const,
      agentType: 'scout' as const,
      missionId: RETRY_MISSION_ID,
      observedAt,
    };
    const otherInput = { ...retryInput, missionId: OTHER_MISSION_ID };
    const concurrentInput = { ...retryInput, missionId: CONCURRENT_MISSION_ID };
    const legacyInput = { ...retryInput, missionId: LEGACY_MISSION_ID };
    const retryId = createMissionObservationId(retryInput);
    const otherId = createMissionObservationId(otherInput);
    const concurrentId = createMissionObservationId(concurrentInput);
    const legacyRandomId = `${TEST_NAMESPACE}-legacy-random-observation`;

    try {
      // Exercise the upgrade window before the new constraint is installed.
      // The target-node write lock serializes first creation on an existing
      // graph, then the canonical constraint is applied below.
      await runWriteTransaction('DROP CONSTRAINT observation_id IF EXISTS');
      await runWriteTransaction(
        `CREATE (:Entity:Technology {id: $targetId, name: 'GRAPH-020 disposable target', entityType: 'technology'})
         CREATE (:Episode {
           id: $retryEpisodeId, missionId: $retryMissionId, userId: $userId,
           agentName: 'scout', summary: 'retry proof', status: 'completed',
           startedAt: datetime(), observationCount: 0
         })
         CREATE (:Episode {
           id: $otherEpisodeId, missionId: $otherMissionId, userId: $userId,
           agentName: 'scout', summary: 'mission separation proof', status: 'completed',
           startedAt: datetime(), observationCount: 0
         })
         CREATE (:Episode {
           id: $concurrentEpisodeId, missionId: $concurrentMissionId, userId: $userId,
           agentName: 'scout', summary: 'concurrent first-create proof', status: 'completed',
           startedAt: datetime(), observationCount: 0
         })
         CREATE (:Episode {
           id: $legacyEpisodeId, missionId: $legacyMissionId, userId: $userId,
           agentName: 'scout', summary: 'legacy adoption proof', status: 'completed',
           startedAt: datetime(), observationCount: 0
         })`,
        {
          targetId: TARGET_ID,
          retryEpisodeId: RETRY_EPISODE_ID,
          retryMissionId: RETRY_MISSION_ID,
          otherEpisodeId: OTHER_EPISODE_ID,
          otherMissionId: OTHER_MISSION_ID,
          concurrentEpisodeId: CONCURRENT_EPISODE_ID,
          concurrentMissionId: CONCURRENT_MISSION_ID,
          legacyEpisodeId: LEGACY_EPISODE_ID,
          legacyMissionId: LEGACY_MISSION_ID,
          userId: USER_ID,
        }
      );

      const concurrentWrites = await Promise.all(
        Array.from({ length: 4 }, () => recordObservation(concurrentInput))
      );
      expect(new Set(concurrentWrites.map((observation) => observation.id))).toEqual(new Set([concurrentId]));
      await Promise.all(
        Array.from({ length: 4 }, () => addObservationToEpisode(CONCURRENT_EPISODE_ID, concurrentId))
      );
      await expect(readObservationRetryProof(CONCURRENT_MISSION_ID, CONCURRENT_EPISODE_ID)).resolves.toEqual({
        observationCount: 1,
        observationIds: [concurrentId],
        verdicts: ['confirming'],
        observesEdges: 1,
        containsEdges: 1,
        episodeObservationCount: 1,
      });

      await runWriteTransaction(
        `MATCH (target:Entity {id: $targetId})
         CREATE (legacy:Observation {
           id: $legacyRandomId,
           missionId: $legacyMissionId,
           entityId: $targetId,
           sourceUrl: $sourceUrl,
           verdict: 'confirming',
           agentType: 'scout',
           observedAt: $observedAt,
           createdAt: $observedAt
         })
         MERGE (legacy)-[:OBSERVES]->(target)`,
        {
          targetId: TARGET_ID,
          legacyRandomId,
          legacyMissionId: LEGACY_MISSION_ID,
          sourceUrl: SOURCE_URL,
          observedAt,
        }
      );
      const adoptedLegacy = await recordObservation(legacyInput);
      expect(adoptedLegacy.id).toBe(legacyRandomId);
      await addObservationToEpisode(LEGACY_EPISODE_ID, adoptedLegacy.id);
      await expect(readObservationRetryProof(LEGACY_MISSION_ID, LEGACY_EPISODE_ID)).resolves.toEqual({
        observationCount: 1,
        observationIds: [legacyRandomId],
        verdicts: ['confirming'],
        observesEdges: 1,
        containsEdges: 1,
        episodeObservationCount: 1,
      });

      await runWriteTransaction(
        'CREATE CONSTRAINT observation_id IF NOT EXISTS FOR (observation:Observation) REQUIRE observation.id IS UNIQUE'
      );
      await runWriteTransaction('CREATE (:RadarPlacement {id: $id})', { id: LEGACY_PLACEMENT_ID });
      const placementObservation = await recordObservation({
        ...retryInput,
        missionId: PLACEMENT_MISSION_ID,
        entityId: LEGACY_PLACEMENT_ID,
      });
      const placementProof = await runReadTransaction<{ edges: number }>(
        `OPTIONAL MATCH (:Observation {id: $observationId})-[edge:OBSERVES]->(:RadarPlacement {id: $targetId})
         RETURN count(edge) AS edges`,
        { observationId: placementObservation.id, targetId: LEGACY_PLACEMENT_ID }
      );
      expect(placementProof.records[0]?.edges).toBe(1);

      const persistThenLoseAcknowledgement = async () => {
        await recordObservation(retryInput);
        throw new Error('graph acknowledgement lost after commit');
      };
      await expect(persistThenLoseAcknowledgement()).rejects.toThrow('acknowledgement lost after commit');

      const replays = await Promise.all(Array.from({ length: 4 }, () => recordObservation(retryInput)));
      expect(new Set(replays.map((observation) => observation.id))).toEqual(new Set([retryId]));
      expect(new Set(replays.map((observation) => observation.observedAt))).toEqual(new Set([observedAt]));

      const linkThenLoseAcknowledgement = async () => {
        await addObservationToEpisode(RETRY_EPISODE_ID, retryId);
        throw new Error('link acknowledgement lost after commit');
      };
      await expect(linkThenLoseAcknowledgement()).rejects.toThrow('link acknowledgement lost after commit');
      await Promise.all(
        Array.from({ length: 4 }, () => addObservationToEpisode(RETRY_EPISODE_ID, retryId))
      );

      await expect(recordObservation({ ...retryInput, verdict: 'contradicting' })).rejects.toThrow(
        'identity conflict'
      );

      await recordObservation(otherInput);
      await addObservationToEpisode(OTHER_EPISODE_ID, otherId);
      expect(otherId).not.toBe(retryId);

      const missingInput = {
        ...retryInput,
        missionId: `${TEST_NAMESPACE}-missing-target-mission`,
        entityId: `${TEST_NAMESPACE}-missing-target`,
      };
      const missingId = createMissionObservationId(missingInput);
      await expect(recordObservation(missingInput)).rejects.toThrow('target is missing/non-unique');
      const missing = await runReadTransaction<{ count: number }>(
        'OPTIONAL MATCH (observation:Observation {id: $missingId}) RETURN count(observation) AS count',
        { missingId }
      );
      expect(missing.records[0]?.count).toBe(0);

      await expect(readObservationRetryProof(RETRY_MISSION_ID, RETRY_EPISODE_ID)).resolves.toEqual({
        observationCount: 1,
        observationIds: [retryId],
        verdicts: ['confirming'],
        observesEdges: 1,
        containsEdges: 1,
        episodeObservationCount: 1,
      });
      await expect(readObservationRetryProof(OTHER_MISSION_ID, OTHER_EPISODE_ID)).resolves.toEqual({
        observationCount: 1,
        observationIds: [otherId],
        verdicts: ['confirming'],
        observesEdges: 1,
        containsEdges: 1,
        episodeObservationCount: 1,
      });
      const schema = await runReadTransaction<{ count: number }>(
        "SHOW CONSTRAINTS YIELD name WHERE name = 'observation_id' RETURN count(*) AS count"
      );
      expect(schema.records[0]?.count).toBe(1);
    } finally {
      await cleanupOwnedFixture();
    }

    await expect(readOwnedCensus()).resolves.toEqual({ nodes: 0, relationships: 0 });
  }, 60_000);
});
