/**
 * @jest-environment node
 *
 * GRAPH-030 — real-Neo4j proof that a mission's graph lineage converges on the
 * canonical terminal outcome.
 *
 * The reproduced mismatch: `run-agent-mission` writes the Reflection and finalizes
 * the Episode BEFORE it writes the AgentRun and the Mission. When a later step
 * fails permanently, `onFailure` persists a `failed` Mission while Neo4j still
 * holds a `completed` Episode and `AgentReflection.success = true` — the retained
 * TEST-027 evidence.
 *
 * Firestore and Neo4j are separate systems with no shared transaction, so the
 * repair is an idempotent, downgrade-only pass. Unit tests pin its Cypher SHAPE;
 * only a real database proves the transaction actually converges, preserves the
 * first `endedAt`, and refuses to manufacture a success.
 *
 * Fail-closed: runs ONLY against a loopback, non-default-port, disposable Neo4j
 * clone (`scripts/testing/run-neo4j-integration`), and teardown proves zero
 * residue.
 */

import { randomUUID } from 'node:crypto';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  isDisposableNeo4jIntegrationSuiteEnabled,
} from '../../../../scripts/testing/run-neo4j-integration';
import { closeDriver, runReadTransaction, runWriteTransaction } from '../neo4j-client';
import { createEpisode, finalizeMissionEpisode, getEpisode } from '../episodes';
import { createReflection } from '../agent-reflections';
import { LINEAGE_RECONCILIATION_VERSION, reconcileMissionLineageOutcome } from '../mission-lineage-parity';

const TEST_MARKER = `graph030-parity-${randomUUID()}`;
const describeIntegration = isDisposableNeo4jIntegrationSuiteEnabled() ? describe : describe.skip;

const owned: string[] = [];

function missionId(suffix: string): string {
  const id = `${TEST_MARKER}-${suffix}`;
  owned.push(id);
  return id;
}

interface EpisodeRow {
  status: string | null;
  missionOutcome: string | null;
  endedAt: string | null;
  reconciledFrom: string | null;
  version: string | null;
}

async function readEpisodeRow(mission: string): Promise<EpisodeRow | undefined> {
  const result = await runReadTransaction<EpisodeRow>(
    `MATCH (e:Episode {missionId: $mission})
     RETURN e.status AS status,
            e.missionOutcome AS missionOutcome,
            toString(e.endedAt) AS endedAt,
            e.outcomeReconciledFrom AS reconciledFrom,
            e.outcomeReconciliationVersion AS version`,
    { mission }
  );
  return result.records[0];
}

async function readReflectionRow(
  mission: string
): Promise<{ success: boolean | null; outcome: string | null; count: number } | undefined> {
  const result = await runReadTransaction<{ success: boolean | null; outcome: string | null; count: number }>(
    `MATCH (r:AgentReflection {missionId: $mission})
     WITH collect(r) AS refs
     RETURN size(refs) AS count,
            CASE WHEN size(refs) = 0 THEN null ELSE head(refs).success END AS success,
            CASE WHEN size(refs) = 0 THEN null ELSE head(refs).outcome END AS outcome`,
    { mission }
  );
  return result.records[0];
}

describeIntegration('GRAPH-030 mission lineage parity (real Neo4j)', () => {
  beforeAll(() => {
    // Refuses anything but an isolated disposable clone.
    assertDisposableNeo4jIntegrationSuiteTarget();
  });

  afterAll(async () => {
    for (const mission of owned) {
      await runWriteTransaction(`MATCH (n) WHERE n.missionId = $mission DETACH DELETE n`, { mission }).catch(
        () => undefined
      );
    }
    // Zero residue: nothing this suite created survives.
    const residue = await runReadTransaction<{ remaining: number }>(
      `MATCH (n) WHERE n.missionId STARTS WITH $marker RETURN count(n) AS remaining`,
      { marker: TEST_MARKER }
    );
    expect(residue.records[0]?.remaining ?? 0).toBe(0);
    await closeDriver();
  });

  it('drives a completed Episode and a success reflection to the failed canonical outcome', async () => {
    const mission = missionId('divergent');
    const episode = await createEpisode({
      agentName: 'creator',
      missionId: mission,
      userId: 'user-graph030',
      summary: 'initial',
    });
    // The main handler's optimistic writes land FIRST — the real ordering.
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: mission,
      userId: 'user-graph030',
      agentName: 'creator',
      status: 'completed',
      summary: 'delivered',
      legacySummary: 'delivered',
      missionOutcome: 'success',
    });
    await createReflection({
      agentName: 'creator',
      missionId: mission,
      learnings: 'went well',
      toolsUsed: [],
      success: true,
      outcome: 'success',
    });

    const beforeEpisode = await readEpisodeRow(mission);
    expect(beforeEpisode?.status).toBe('completed');
    const firstEndedAt = beforeEpisode?.endedAt;
    expect(typeof firstEndedAt).toBe('string');

    // Then a later step fails permanently and onFailure persists a failed Mission.
    const reconciliation = await reconcileMissionLineageOutcome({
      missionId: mission,
      outcome: 'failed',
      reason: 'agent-run-persistence-failed',
    });

    expect(reconciliation).toEqual({
      outcome: 'failed',
      episode: 'corrected',
      reflectionsCorrected: 1,
      reflectionsInspected: 1,
    });

    const afterEpisode = await readEpisodeRow(mission);
    expect(afterEpisode?.status).toBe('failed');
    expect(afterEpisode?.missionOutcome).toBe('failed');
    // The FIRST terminal instant is the real end of work and must survive.
    expect(afterEpisode?.endedAt).toBe(firstEndedAt);
    // The correction is auditable, not silent.
    expect(afterEpisode?.reconciledFrom).toBe('completed');
    expect(afterEpisode?.version).toBe(LINEAGE_RECONCILIATION_VERSION);

    const afterReflection = await readReflectionRow(mission);
    expect(afterReflection?.success).toBe(false);
    expect(afterReflection?.outcome).toBe('failed');
    // Never destructive: the reflection the agent generated is corrected, not deleted.
    expect(afterReflection?.count).toBe(1);
  });

  it('is idempotent — a replayed reconciliation reports already-consistent', async () => {
    const mission = missionId('replay');
    const episode = await createEpisode({
      agentName: 'scout',
      missionId: mission,
      userId: 'user-graph030',
      summary: 'initial',
    });
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: mission,
      userId: 'user-graph030',
      agentName: 'scout',
      status: 'completed',
      summary: 'delivered',
      legacySummary: 'delivered',
      missionOutcome: 'success',
    });

    const first = await reconcileMissionLineageOutcome({ missionId: mission, outcome: 'failed' });
    expect(first.episode).toBe('corrected');
    const afterFirst = await readEpisodeRow(mission);

    const second = await reconcileMissionLineageOutcome({ missionId: mission, outcome: 'failed' });
    expect(second.episode).toBe('already-consistent');
    expect(second.reflectionsCorrected).toBe(0);

    // Byte-identical: a retried onFailure cannot churn the graph.
    expect(await readEpisodeRow(mission)).toEqual(afterFirst);
  });

  it('refuses to upgrade failed lineage into a success claim', async () => {
    const mission = missionId('refuse-upgrade');
    const episode = await createEpisode({
      agentName: 'scout',
      missionId: mission,
      userId: 'user-graph030',
      summary: 'initial',
    });
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: mission,
      userId: 'user-graph030',
      agentName: 'scout',
      status: 'failed',
      summary: 'failed',
      legacySummary: 'failed',
      missionOutcome: 'failed',
    });

    const result = await reconcileMissionLineageOutcome({ missionId: mission, outcome: 'success' });
    expect(result.episode).toBe('refused-upgrade');

    // The graph is untouched — a repair pass can never manufacture a green run.
    const after = await readEpisodeRow(mission);
    expect(after?.status).toBe('failed');
    expect(after?.missionOutcome).toBe('failed');
    expect(after?.version).toBeNull();
  });

  it('reports no-lineage for a mission with no Episode, without creating one', async () => {
    const mission = missionId('no-lineage');
    const result = await reconcileMissionLineageOutcome({ missionId: mission, outcome: 'failed' });
    expect(result.episode).toBe('no-lineage');
    expect(await readEpisodeRow(mission)).toBeUndefined();
  });

  it('gives one mission exactly one reflection however often the step retries', async () => {
    const mission = missionId('reflection-identity');
    // The pre-fix writer used CREATE with a random id, so a step that stored the
    // node and then failed before returning duplicated it on retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createReflection({
        agentName: 'scout',
        missionId: mission,
        learnings: `attempt ${attempt}`,
        toolsUsed: [],
        success: true,
        outcome: 'success',
      });
    }
    const row = await readReflectionRow(mission);
    expect(row?.count).toBe(1);
  });

  it('stamps the canonical outcome on an Episode finalized before the field existed', async () => {
    const mission = missionId('legacy-stamp');
    const episode = await createEpisode({
      agentName: 'scout',
      missionId: mission,
      userId: 'user-graph030',
      summary: 'legacy',
    });
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: mission,
      userId: 'user-graph030',
      agentName: 'scout',
      status: 'completed',
      summary: 'legacy',
      legacySummary: 'legacy',
      // No missionOutcome — the pre-GRAPH-030 call shape.
    });
    expect((await readEpisodeRow(mission))?.missionOutcome).toBeNull();

    // A replay WITH the outcome converges it, without claiming a status transition.
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: mission,
      userId: 'user-graph030',
      agentName: 'scout',
      status: 'completed',
      summary: 'legacy',
      legacySummary: 'legacy',
      missionOutcome: 'success',
    });
    const after = await readEpisodeRow(mission);
    expect(after?.missionOutcome).toBe('success');
    expect(after?.status).toBe('completed');
    // Not a correction: the reconciliation marker stays absent.
    expect(after?.version).toBeNull();
    expect(await getEpisode(episode.id)).not.toBeNull();
  });
});
