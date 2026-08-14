/** @jest-environment node */

/**
 * GRAPH-040 cross-store convergence proof.
 *
 * This suite is intentionally fail-closed. It runs only against the exact
 * Firestore emulator project and a non-default, loopback, disposable Neo4j
 * instance. Every fixture is namespaced and teardown proves zero residue.
 */

import { randomUUID } from 'node:crypto';

const DISPOSABLE_PROJECT_ID = 'demo-graph040-agent-runs';
const DISPOSABLE_NEO4J_DATABASE = 'neo4j';
const DISPOSABLE_CONFIRMATION = 'true';
const TEST_PREFIX = `graph040-${randomUUID()}-`;
const CURSOR_COLLECTION = 'graphReconciliationCursors';
const CURSOR_ID = 'agentRuns';
const REVERSE_CURSOR_ID = 'agentRunsReverse';
const MALFORMED_REVERSE_CURSOR_ID = 'agentRunsMalformedReverse';
const SOURCE_PAGE_SIZE = 100;

const projectIds = [
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  process.env.GCLOUD_PROJECT,
  process.env.GOOGLE_CLOUD_PROJECT,
].filter((value): value is string => Boolean(value));

const neo4jTargetGuard = require('../../../../scripts/testing/neo4j-integration-target.cjs') as {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): unknown;
};

jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>(
    'firebase-admin/firestore'
  );
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-graph040-agent-runs';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const adminApp = initializeApp(
    {
      projectId,
      credential: cert({
        projectId,
        clientEmail: `graph040@${projectId}.iam.gserviceaccount.com`,
        privateKey,
      }),
    },
    `graph040-agent-run-reconciliation-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { adminApp, db: firestore, adminAuth: {} };
});

import { db } from '@/lib/firebase-admin';
import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import { readGraphMemoryLiveness } from '@/lib/graph/memory-liveness';
import { reconcileAgentRuns } from '@/lib/graph/projection-reconciliation-runner';

const describeIntegration =
  process.env.NEO4J_INTEGRATION_TESTS === '1' && process.env.FIRESTORE_EMULATOR_HOST
    ? describe
    : describe.skip;

const idAt = (index: number): string => `${TEST_PREFIX}${String(index).padStart(3, '0')}`;

const IDS = {
  missingNode: idAt(0),
  missingEdge: idAt(1),
  exact: idAt(2),
  payloadConflict: idAt(3),
  ownerConflict: idAt(4),
  topologyConflict: idAt(5),
  preContract: idAt(6),
  missingEpisode: idAt(7),
  ambiguousEpisode: idAt(8),
  standalone: idAt(9),
  malformedDualOwner: idAt(10),
  duplicateEdges: idAt(11),
  wrongLabelTarget: idAt(12),
  sweepMissingNode: idAt(13),
  provenanceConflict: idAt(14),
  nonStringEpisodeId: idAt(15),
  lastFirstPage: idAt(SOURCE_PAGE_SIZE - 1),
  lastSource: idAt(SOURCE_PAGE_SIZE),
  graphOnly: `${TEST_PREFIX}graph-only`,
  unrelatedCompany: `${TEST_PREFIX}unrelated-company`,
} as const;

interface SourceRun {
  id: string;
  userId: string;
  agentName: string;
  action: string;
  status: 'success';
  createdAt: string;
  tokenUsage: { input: number; output: number };
  costUsd: number;
  duration: number;
  missionId?: string;
  sweepId?: string;
}

interface GraphFingerprint {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function assertDisposableTargets(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST?.trim() ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(firestoreHost)) {
    throw new Error(`GRAPH-040 integration requires a loopback Firestore emulator, got ${firestoreHost}`);
  }
  if (projectIds.length === 0 || projectIds.some((projectId) => projectId !== DISPOSABLE_PROJECT_ID)) {
    throw new Error(
      `GRAPH-040 integration requires every configured Firebase project to be ${DISPOSABLE_PROJECT_ID}, got ${
        projectIds.join(',') || '<unset>'
      }`
    );
  }
  if (process.env.AGENT_RUN_RECONCILIATION_INTEGRATION_DISPOSABLE !== DISPOSABLE_CONFIRMATION) {
    throw new Error(
      'GRAPH-040 integration requires AGENT_RUN_RECONCILIATION_INTEGRATION_DISPOSABLE=true'
    );
  }
  if (process.env.NEO4J_DATABASE?.trim() !== DISPOSABLE_NEO4J_DATABASE) {
    throw new Error(
      `GRAPH-040 integration requires explicit NEO4J_DATABASE=${DISPOSABLE_NEO4J_DATABASE}`
    );
  }
  neo4jTargetGuard.assertDisposableNeo4jIntegrationTarget(process.env);
}

function sourceRun(id: string, missionId?: string): SourceRun {
  return {
    id,
    userId: `${TEST_PREFIX}user`,
    agentName: 'scout',
    action: `Research ${id}`,
    status: 'success',
    createdAt: '2026-07-14T12:00:00.000Z',
    tokenUsage: { input: 10, output: 5 },
    costUsd: 0.01,
    duration: 25,
    ...(missionId ? { missionId } : {}),
  };
}

function sourceSweepRun(id: string, sweepId: string): SourceRun {
  return { ...sourceRun(id), sweepId };
}

function missionIdFor(runId: string): string {
  return `${runId}-mission`;
}

function graphProperties(run: SourceRun): Record<string, unknown> {
  const correlationId = run.missionId ?? run.sweepId;
  return {
    id: run.id,
    userId: run.userId,
    agentName: run.agentName,
    action: run.action,
    status: run.status,
    createdAt: run.createdAt,
    costUsd: run.costUsd,
    // A graph row described as exact must include the current canonical cost
    // provenance. Omitting this now correctly classifies the row as healable
    // pre-contract state rather than exact/missing-edge state.
    costState: 'settled',
    duration: run.duration,
    ...(correlationId
      ? {
          correlationId,
          correlationKind: run.missionId ? 'mission' : 'sweep',
          memoryLane: run.missionId ? 'mission' : 'proactive-sweep',
          ...(run.missionId ? { missionId: correlationId } : { sweepId: correlationId }),
        }
      : {}),
  };
}

const coreRuns = [
  sourceRun(IDS.missingNode, missionIdFor(IDS.missingNode)),
  sourceRun(IDS.missingEdge, missionIdFor(IDS.missingEdge)),
  sourceRun(IDS.exact, missionIdFor(IDS.exact)),
  sourceRun(IDS.payloadConflict, missionIdFor(IDS.payloadConflict)),
  sourceRun(IDS.ownerConflict, missionIdFor(IDS.ownerConflict)),
  sourceRun(IDS.topologyConflict, missionIdFor(IDS.topologyConflict)),
  sourceRun(IDS.preContract, missionIdFor(IDS.preContract)),
  sourceRun(IDS.missingEpisode, missionIdFor(IDS.missingEpisode)),
  sourceRun(IDS.ambiguousEpisode, missionIdFor(IDS.ambiguousEpisode)),
  sourceRun(IDS.standalone),
  sourceRun(IDS.duplicateEdges, missionIdFor(IDS.duplicateEdges)),
  sourceRun(IDS.wrongLabelTarget, missionIdFor(IDS.wrongLabelTarget)),
  sourceSweepRun(IDS.sweepMissingNode, `${IDS.sweepMissingNode}-sweep`),
  sourceRun(IDS.provenanceConflict, missionIdFor(IDS.provenanceConflict)),
  sourceRun(IDS.nonStringEpisodeId, missionIdFor(IDS.nonStringEpisodeId)),
] as const;

const coreById = new Map(coreRuns.map((run) => [run.id, run]));

const sourceRuns: SourceRun[] = [
  ...coreRuns,
  {
    ...sourceRun(IDS.malformedDualOwner, missionIdFor(IDS.malformedDualOwner)),
    sweepId: `${IDS.malformedDualOwner}-sweep`,
  },
  ...Array.from({ length: SOURCE_PAGE_SIZE - coreRuns.length }, (_, offset) =>
    sourceRun(idAt(offset + coreRuns.length + 1))
  ),
];

async function cleanupFirestore(): Promise<void> {
  const refs = [
    ...sourceRuns.map((run) => db.collection('agentRuns').doc(run.id)),
    db.collection('companies').doc(IDS.unrelatedCompany),
    db.collection(CURSOR_COLLECTION).doc(CURSOR_ID),
    db.collection(CURSOR_COLLECTION).doc(REVERSE_CURSOR_ID),
    db.collection(CURSOR_COLLECTION).doc(MALFORMED_REVERSE_CURSOR_ID),
  ];
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(offset, offset + 400)) batch.delete(ref);
    await batch.commit();
  }
}

async function cleanupNeo4j(): Promise<void> {
  await runWriteTransaction(
    `MATCH (node)
     WHERE toString(node.id) STARTS WITH $prefix
        OR toString(node.userId) STARTS WITH $prefix
        OR toString(node.missionId) STARTS WITH $prefix
        OR toString(node.correlationId) STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

async function ownedFirestoreCount(): Promise<number> {
  const snapshots = await Promise.all([
    ...sourceRuns.map((run) => db.collection('agentRuns').doc(run.id).get()),
    db.collection('companies').doc(IDS.unrelatedCompany).get(),
    db.collection(CURSOR_COLLECTION).doc(CURSOR_ID).get(),
    db.collection(CURSOR_COLLECTION).doc(REVERSE_CURSOR_ID).get(),
    db.collection(CURSOR_COLLECTION).doc(MALFORMED_REVERSE_CURSOR_ID).get(),
  ]);
  return snapshots.filter((snapshot) => snapshot.exists).length;
}

async function ownedNeo4jCount(): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    `MATCH (node)
     WHERE toString(node.id) STARTS WITH $prefix
        OR toString(node.userId) STARTS WITH $prefix
        OR toString(node.missionId) STARTS WITH $prefix
        OR toString(node.correlationId) STARTS WITH $prefix
     RETURN count(node) AS count`,
    { prefix: TEST_PREFIX }
  );
  return Number(result.records[0]?.count ?? 0);
}

async function readFingerprint(ids: readonly string[]): Promise<GraphFingerprint> {
  const result = await runReadTransaction<GraphFingerprint>(
    `MATCH (run:AgentRun)
     WHERE run.id IN $ids
     WITH run ORDER BY run.id
     WITH collect({id: run.id, nodeProperties: properties(run)}) AS nodes
     OPTIONAL MATCH (start:AgentRun)-[edge:EXECUTED_DURING]->(owner)
     WHERE start.id IN $ids
     WITH nodes, start, edge, owner ORDER BY start.id, owner.id, elementId(edge)
     RETURN nodes,
            collect(CASE WHEN edge IS NULL THEN null ELSE {
              startId: start.id, ownerId: owner.id, ownerLabels: labels(owner),
              edgeProperties: properties(edge)
            } END) AS edges`,
    { ids: [...ids] }
  );
  return result.records[0] ?? { nodes: [], edges: [] };
}

async function readEpisodeFingerprint(missionIds: readonly string[]): Promise<GraphFingerprint> {
  const result = await runReadTransaction<GraphFingerprint>(
    `MATCH (episode:Episode)
     WHERE episode.missionId IN $missionIds
     WITH episode ORDER BY episode.missionId, toString(episode.id), elementId(episode)
     WITH collect({
       elementId: elementId(episode), labels: labels(episode),
       nodeProperties: properties(episode)
     }) AS nodes
     OPTIONAL MATCH (run:AgentRun)-[edge:EXECUTED_DURING]->(owner:Episode)
     WHERE owner.missionId IN $missionIds
     WITH nodes, run, edge, owner
     ORDER BY run.id, owner.missionId, toString(owner.id), elementId(edge)
     RETURN nodes,
            collect(CASE WHEN edge IS NULL THEN null ELSE {
              startId: run.id, ownerId: owner.id, ownerLabels: labels(owner),
              edgeProperties: properties(edge)
            } END) AS edges`,
    { missionIds: [...missionIds] }
  );
  return result.records[0] ?? { nodes: [], edges: [] };
}

async function readUnrelatedCompanyFingerprint(): Promise<Record<string, unknown> | null> {
  const result = await runReadTransaction<Record<string, unknown>>(
    `OPTIONAL MATCH (company:Company {id: $id})
     RETURN CASE WHEN company IS NULL THEN null ELSE properties(company) END AS properties`,
    { id: IDS.unrelatedCompany }
  );
  return (result.records[0]?.properties as Record<string, unknown> | null | undefined) ?? null;
}

async function seedFirestore(): Promise<void> {
  const refs: Array<[FirebaseFirestore.DocumentReference, Record<string, unknown>]> = [
    ...sourceRuns.map(
      (run): [FirebaseFirestore.DocumentReference, Record<string, unknown>] => [
        db.collection('agentRuns').doc(run.id),
        { ...run },
      ]
    ),
    [
      db.collection('companies').doc(IDS.unrelatedCompany),
      {
        id: IDS.unrelatedCompany,
        name: 'Unrelated sentinel',
        description: 'Must not be touched by AgentRun reconciliation.',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  ];
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    for (const [ref, data] of refs.slice(offset, offset + 400)) batch.set(ref, data);
    await batch.commit();
  }
}

async function seedNeo4j(): Promise<void> {
  const correlatedRuns = coreRuns.filter(
    (run) =>
      (run.missionId ?? run.sweepId) &&
      run.id !== IDS.missingEpisode &&
      run.id !== IDS.ambiguousEpisode
  );
  const episodes = correlatedRuns.map((run) => ({
    id: run.id === IDS.nonStringEpisodeId ? 43 : `${run.id}-episode`,
    missionId: run.missionId ?? run.sweepId,
    correlationId:
      run.id === IDS.provenanceConflict
        ? `${run.id}-conflicting-correlation`
        : run.missionId ?? run.sweepId,
    memoryLane:
      run.id === IDS.provenanceConflict
        ? 'proactive-sweep'
        : run.missionId
          ? 'mission'
          : 'proactive-sweep',
    userId: run.userId,
    agentName: run.agentName,
  }));
  const topologyRun = coreById.get(IDS.topologyConflict)!;
  const wrongOwner = {
    id: `${IDS.topologyConflict}-wrong-episode`,
    missionId: `${IDS.topologyConflict}-wrong-mission`,
    userId: topologyRun.userId,
    agentName: topologyRun.agentName,
  };
  const ambiguousRun = coreById.get(IDS.ambiguousEpisode)!;
  const ambiguousOwners = [1, 2].map((index) => ({
    id: `${IDS.ambiguousEpisode}-episode-${index}`,
    missionId: ambiguousRun.missionId,
    correlationId: ambiguousRun.missionId,
    memoryLane: 'mission',
    userId: ambiguousRun.userId,
    agentName: ambiguousRun.agentName,
  }));
  const graphOnly = sourceRun(IDS.graphOnly, missionIdFor(IDS.graphOnly));

  await runWriteTransaction(
    `UNWIND $episodes AS row
       CREATE (:Episode {
         id: row.id, missionId: row.missionId, userId: row.userId,
         correlationId: row.correlationId, memoryLane: row.memoryLane,
         agentName: row.agentName, status: 'completed', summary: 'GRAPH-040 fixture',
         startedAt: datetime('2026-07-14T11:00:00.000Z'),
         endedAt: datetime('2026-07-14T12:00:00.000Z'), observationCount: 0
       })
     WITH count(*) AS ignored
     UNWIND $ambiguousOwners AS ambiguousOwner
       CREATE (:Episode {
         id: ambiguousOwner.id, missionId: ambiguousOwner.missionId,
         correlationId: ambiguousOwner.correlationId, memoryLane: ambiguousOwner.memoryLane,
         userId: ambiguousOwner.userId, agentName: ambiguousOwner.agentName,
         status: 'completed', summary: 'Ambiguous GRAPH-040 owner',
         startedAt: datetime('2026-07-14T11:00:00.000Z'),
         endedAt: datetime('2026-07-14T12:00:00.000Z'), observationCount: 0
       })
     WITH count(*) AS ambiguousCount
     CREATE (:Episode {
       id: $wrongOwner.id, missionId: $wrongOwner.missionId, userId: $wrongOwner.userId,
       correlationId: $wrongOwner.missionId, memoryLane: 'mission',
       agentName: $wrongOwner.agentName, status: 'completed', summary: 'Wrong topology owner',
       startedAt: datetime('2026-07-14T11:00:00.000Z'),
       endedAt: datetime('2026-07-14T12:00:00.000Z'), observationCount: 0
     })
     CREATE (:Episode {
       id: $graphOnlyEpisode.id, missionId: $graphOnlyEpisode.missionId,
       correlationId: $graphOnlyEpisode.missionId, memoryLane: 'mission',
       userId: $graphOnlyEpisode.userId, agentName: $graphOnlyEpisode.agentName,
       status: 'completed', summary: 'Graph-only owner',
       startedAt: datetime('2026-07-14T11:00:00.000Z'),
       endedAt: datetime('2026-07-14T12:00:00.000Z'), observationCount: 0
     })`,
    {
      episodes,
      ambiguousOwners,
      wrongOwner,
      graphOnlyEpisode: {
        id: `${IDS.graphOnly}-episode`,
        missionId: graphOnly.missionId,
        userId: graphOnly.userId,
        agentName: graphOnly.agentName,
      },
    }
  );

  const graphRows = [
    { id: IDS.missingEdge, properties: graphProperties(coreById.get(IDS.missingEdge)!) },
    { id: IDS.exact, properties: graphProperties(coreById.get(IDS.exact)!) },
    {
      id: IDS.payloadConflict,
      properties: { ...graphProperties(coreById.get(IDS.payloadConflict)!), action: 'Conflicting graph action' },
    },
    {
      id: IDS.ownerConflict,
      properties: {
        ...graphProperties(coreById.get(IDS.ownerConflict)!),
        correlationId: `${IDS.ownerConflict}-other-mission`,
        missionId: `${IDS.ownerConflict}-other-mission`,
      },
    },
    { id: IDS.topologyConflict, properties: graphProperties(topologyRun) },
    {
      id: IDS.preContract,
      properties: Object.fromEntries(
        Object.entries(graphProperties(coreById.get(IDS.preContract)!)).filter(
          ([key]) => !['correlationId', 'correlationKind', 'memoryLane', 'missionId'].includes(key)
        )
      ),
    },
    { id: IDS.duplicateEdges, properties: graphProperties(coreById.get(IDS.duplicateEdges)!) },
    {
      id: IDS.wrongLabelTarget,
      properties: graphProperties(coreById.get(IDS.wrongLabelTarget)!),
    },
    { id: IDS.graphOnly, properties: graphProperties(graphOnly) },
  ];

  await runWriteTransaction(
    `UNWIND $rows AS row
       CREATE (run:AgentRun)
       SET run = row.properties
     WITH count(*) AS ignored
     UNWIND $linked AS row
       MATCH (run:AgentRun {id: row.runId})
       MATCH (episode:Episode {id: row.episodeId})
       CREATE (run)-[:EXECUTED_DURING]->(episode)
     WITH count(*) AS alsoIgnored
     CREATE (legacyOwner:LegacyAgentRunOwner {
       id: $wrongLabelOwner.id, missionId: $wrongLabelOwner.missionId,
       userId: $wrongLabelOwner.userId, agentName: $wrongLabelOwner.agentName
     })
     WITH alsoIgnored, legacyOwner
     MATCH (wrongLabelRun:AgentRun {id: $wrongLabelRunId})
     CREATE (wrongLabelRun)-[:EXECUTED_DURING]->(legacyOwner)
     CREATE (:AgentRun {
       userId: $malformedMissingIdUser, marker: 'missing AgentRun id'
     })
     CREATE (:AgentRun {
       id: 42, userId: $malformedNumericIdUser, marker: 'numeric AgentRun id'
     })
     CREATE (:Company:Entity {
       id: $unrelatedCompany, name: 'Unrelated sentinel', marker: 'unchanged'
     })`,
    {
      rows: graphRows,
      linked: [
        { runId: IDS.exact, episodeId: `${IDS.exact}-episode` },
        { runId: IDS.payloadConflict, episodeId: `${IDS.payloadConflict}-episode` },
        { runId: IDS.topologyConflict, episodeId: wrongOwner.id },
        { runId: IDS.duplicateEdges, episodeId: `${IDS.duplicateEdges}-episode` },
        { runId: IDS.duplicateEdges, episodeId: `${IDS.duplicateEdges}-episode` },
        { runId: IDS.graphOnly, episodeId: `${IDS.graphOnly}-episode` },
      ],
      wrongLabelOwner: {
        id: `${IDS.wrongLabelTarget}-legacy-owner`,
        missionId: missionIdFor(IDS.wrongLabelTarget),
        userId: coreById.get(IDS.wrongLabelTarget)!.userId,
        agentName: coreById.get(IDS.wrongLabelTarget)!.agentName,
      },
      wrongLabelRunId: IDS.wrongLabelTarget,
      malformedMissingIdUser: `${TEST_PREFIX}malformed-missing-id-user`,
      malformedNumericIdUser: `${TEST_PREFIX}malformed-numeric-id-user`,
      unrelatedCompany: IDS.unrelatedCompany,
    }
  );
}

function outcomes(report: Awaited<ReturnType<typeof reconcileAgentRuns>>): Map<string, string> {
  return new Map(report.classifications.map((entry) => [entry.id, entry.outcome]));
}

describeIntegration('GRAPH-040 AgentRun reconciliation (emulator + disposable Neo4j)', () => {
  jest.setTimeout(90_000);

  beforeAll(async () => {
    assertDisposableTargets();
    await cleanupFirestore();
    await cleanupNeo4j();
  });

  afterEach(async () => {
    await cleanupFirestore();
    await cleanupNeo4j();
  });

  afterAll(async () => {
    await closeDriver();
    await db.terminate();
  });

  it('converges compatible drift, reports conflicts, advances fairly, and leaves zero residue', async () => {
    const livenessBaseline = await readGraphMemoryLiveness();
    await seedFirestore();
    await seedNeo4j();

    const protectedGraphIds = [
      IDS.payloadConflict,
      IDS.ownerConflict,
      IDS.topologyConflict,
      IDS.duplicateEdges,
      IDS.wrongLabelTarget,
      IDS.missingEpisode,
      IDS.ambiguousEpisode,
      IDS.provenanceConflict,
      IDS.nonStringEpisodeId,
      IDS.graphOnly,
    ];
    const protectedBefore = await readFingerprint(protectedGraphIds);
    const rejectedEpisodeMissionIds = [
      missionIdFor(IDS.provenanceConflict),
      missionIdFor(IDS.nonStringEpisodeId),
    ];
    const rejectedEpisodesBefore = await readEpisodeFingerprint(rejectedEpisodeMissionIds);
    const unrelatedFirestoreBefore = (await db.collection('companies').doc(IDS.unrelatedCompany).get()).data();
    const unrelatedGraphBefore = await readUnrelatedCompanyFingerprint();
    const seededLiveness = await readGraphMemoryLiveness();

    // Standalone, malformed-ID, and pre-contract rows remain visible in total
    // inventory but cannot enter the correlated denominator until compatible
    // authoritative state heals.
    expect(seededLiveness.agentRuns.total - livenessBaseline.agentRuns.total).toBe(11);
    expect(seededLiveness.agentRuns.eligible - livenessBaseline.agentRuns.eligible).toBe(8);

    const first = await reconcileAgentRuns();
    expect(first.source).toMatchObject({
      scanned: SOURCE_PAGE_SIZE,
      cursorBefore: null,
      cursorAfter: IDS.lastFirstPage,
      cycle: 0,
      wrapped: false,
      errors: [],
    });
    expect(Object.fromEntries(outcomes(first))).toMatchObject({
      [IDS.missingNode]: 'missing-node',
      [IDS.missingEdge]: 'missing-edge',
      [IDS.exact]: 'exact',
      [IDS.payloadConflict]: 'payload-conflict',
      [IDS.ownerConflict]: 'owner-conflict',
      [IDS.topologyConflict]: 'topology-conflict',
      [IDS.preContract]: 'pre-contract',
      [IDS.missingEpisode]: 'topology-conflict',
      [IDS.ambiguousEpisode]: 'topology-conflict',
      [IDS.standalone]: 'standalone',
      [IDS.malformedDualOwner]: 'malformed-source',
      [IDS.duplicateEdges]: 'topology-conflict',
      [IDS.wrongLabelTarget]: 'topology-conflict',
      [IDS.sweepMissingNode]: 'missing-node',
      [IDS.provenanceConflict]: 'owner-conflict',
      [IDS.nonStringEpisodeId]: 'owner-conflict',
    });
    expect(first.classifications.find((entry) => entry.id === IDS.malformedDualOwner)?.reason).toMatch(
      /both|mission.*sweep|dual/i
    );
    expect(first.classifications.find((entry) => entry.id === IDS.missingEpisode)?.reason).toBe(
      'missing-episode'
    );
    expect(first.classifications.find((entry) => entry.id === IDS.ambiguousEpisode)?.reason).toBe(
      'ambiguous-episode'
    );
    expect(first.classifications.find((entry) => entry.id === IDS.provenanceConflict)?.reason).toBe(
      'owner-conflict'
    );
    expect(first.classifications.find((entry) => entry.id === IDS.nonStringEpisodeId)?.reason).toBe(
      'owner-conflict'
    );
    expect(first.repairs).toMatchObject({ attempted: 4, applied: 4, created: 2, healed: 2, conflict: 0 });
    expect(first.reverse).toMatchObject({
      scanned: 11,
      cursorBefore: null,
      cursorAfter: IDS.graphOnly,
      cycle: 0,
      wrapped: false,
      errors: [],
      graphOnlyIds: expect.arrayContaining([IDS.graphOnly]),
    });
    expect(first.malformedGraph).toMatchObject({
      scanned: 2,
      cursorBefore: null,
      cycle: 0,
      wrapped: false,
      errors: [],
    });
    expect(first.malformedGraph.elementIds).toHaveLength(2);
    expect(first.categories['malformed-graph']).toMatchObject({ count: 2 });
    expect(
      first.classifications
        .filter((entry) => entry.outcome === 'malformed-graph')
        .map((entry) => entry.reason)
        .sort()
    ).toEqual(['missing-id', 'non-string-id']);
    expect(first.classifications.find((entry) => entry.id === IDS.missingEpisode)?.projectorResult).toBeUndefined();
    expect(first.classifications.find((entry) => entry.id === IDS.ambiguousEpisode)?.projectorResult).toBeUndefined();
    expect(
      first.classifications.find((entry) => entry.id === IDS.provenanceConflict)?.projectorResult
    ).toBeUndefined();
    expect(
      first.classifications.find((entry) => entry.id === IDS.nonStringEpisodeId)?.projectorResult
    ).toBeUndefined();

    const livenessAfterFirst = await readGraphMemoryLiveness();
    expect(livenessAfterFirst.agentRuns.total - seededLiveness.agentRuns.total).toBe(2);
    expect(livenessAfterFirst.agentRuns.eligible - seededLiveness.agentRuns.eligible).toBe(3);
    expect(await readFingerprint(protectedGraphIds)).toEqual(protectedBefore);
    expect(await readFingerprint([IDS.provenanceConflict, IDS.nonStringEpisodeId])).toEqual({
      nodes: [],
      edges: [],
    });
    expect(
      (
        await readFingerprint([
          IDS.missingEpisode,
          IDS.ambiguousEpisode,
          IDS.provenanceConflict,
          IDS.nonStringEpisodeId,
        ])
      ).nodes
    ).toEqual([]);
    expect(await readEpisodeFingerprint(rejectedEpisodeMissionIds)).toEqual(rejectedEpisodesBefore);
    expect((await db.collection('companies').doc(IDS.unrelatedCompany).get()).data()).toEqual(
      unrelatedFirestoreBefore
    );
    expect(await readUnrelatedCompanyFingerprint()).toEqual(unrelatedGraphBefore);
    expect(await readFingerprint([IDS.sweepMissingNode])).toEqual({
      nodes: [
        expect.objectContaining({
          id: IDS.sweepMissingNode,
          nodeProperties: expect.objectContaining({
            correlationId: `${IDS.sweepMissingNode}-sweep`,
            correlationKind: 'sweep',
            sweepId: `${IDS.sweepMissingNode}-sweep`,
            memoryLane: 'proactive-sweep',
          }),
        }),
      ],
      edges: [
        expect.objectContaining({
          startId: IDS.sweepMissingNode,
          ownerId: `${IDS.sweepMissingNode}-episode`,
          ownerLabels: expect.arrayContaining(['Episode']),
        }),
      ],
    });

    const second = await reconcileAgentRuns();
    expect(second.source).toMatchObject({
      scanned: 1,
      cursorBefore: IDS.lastFirstPage,
      cursorAfter: IDS.lastSource,
      cycle: 0,
      wrapped: false,
      errors: [],
    });
    expect(second.repairs.applied).toBe(0);
    expect(second.reverse).toMatchObject({
      scanned: 11,
      cursorBefore: IDS.graphOnly,
      cursorAfter: IDS.graphOnly,
      cycle: 1,
      wrapped: true,
      errors: [],
    });
    expect(second.malformedGraph).toMatchObject({
      scanned: 2,
      cursorBefore: first.malformedGraph.cursorAfter,
      cursorAfter: first.malformedGraph.cursorAfter,
      cycle: 1,
      wrapped: true,
      errors: [],
    });
    expect((await readGraphMemoryLiveness()).agentRuns.eligible).toBe(livenessAfterFirst.agentRuns.eligible);

    const third = await reconcileAgentRuns();
    expect(third.source).toMatchObject({
      scanned: SOURCE_PAGE_SIZE,
      cursorBefore: IDS.lastSource,
      cursorAfter: IDS.lastFirstPage,
      cycle: 1,
      wrapped: true,
      errors: [],
    });
    expect(third.repairs.applied).toBe(0);
    expect(third.reverse).toMatchObject({
      scanned: 11,
      cursorBefore: IDS.graphOnly,
      cursorAfter: IDS.graphOnly,
      cycle: 2,
      wrapped: true,
      errors: [],
    });
    expect(third.malformedGraph).toMatchObject({
      scanned: 2,
      cursorBefore: first.malformedGraph.cursorAfter,
      cursorAfter: first.malformedGraph.cursorAfter,
      cycle: 2,
      wrapped: true,
      errors: [],
    });
    expect(outcomes(third).get(IDS.missingNode)).toBe('exact');
    expect(outcomes(third).get(IDS.missingEdge)).toBe('exact');
    expect(outcomes(third).get(IDS.preContract)).toBe('exact');
    expect(outcomes(third).get(IDS.sweepMissingNode)).toBe('exact');
    expect(outcomes(third).get(IDS.provenanceConflict)).toBe('owner-conflict');
    expect(outcomes(third).get(IDS.nonStringEpisodeId)).toBe('owner-conflict');
    expect(await readEpisodeFingerprint(rejectedEpisodeMissionIds)).toEqual(rejectedEpisodesBefore);
    expect((await readGraphMemoryLiveness()).agentRuns.eligible).toBe(livenessAfterFirst.agentRuns.eligible);

    await cleanupFirestore();
    await cleanupNeo4j();
    expect(await ownedFirestoreCount()).toBe(0);
    expect(await ownedNeo4jCount()).toBe(0);
    expect(await readGraphMemoryLiveness()).toEqual(livenessBaseline);
  });
});
