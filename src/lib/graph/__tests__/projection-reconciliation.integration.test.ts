/** @jest-environment node */

/**
 * Two-cycle convergence proof using a real Firestore emulator and a real,
 * guarded disposable Neo4j. The ordinary Neo4j lane skips this suite unless
 * FIRESTORE_EMULATOR_HOST is also present.
 */

const TEST_PREFIX = 'graph033-reconcile-int-';
const DISPOSABLE_PROJECT_ID = 'demo-graph033-reconcile';
const PROJECT_ID =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
  process.env.GCLOUD_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  '';
const mockEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
const neo4jTargetGuard = require('../../../../scripts/testing/neo4j-integration-target.cjs') as {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): unknown;
};

interface MockFunctionHandler {
  (context: {
    event: { data: Record<string, unknown>; id: string };
    step: {
      run: <T>(_name: string, callback: () => T | Promise<T>) => Promise<T>;
      sleep: (_name: string, _duration: string) => Promise<void>;
    };
  }): Promise<unknown>;
}

jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/graph/query-cache', () => ({ invalidateCachesForEntity: jest.fn() }));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'integration-test' })),
}));
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-graph033-reconcile';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const adminApp = initializeApp(
    {
      projectId,
      credential: cert({ projectId, clientEmail: `graph033@${projectId}.iam.gserviceaccount.com`, privateKey }),
    },
    `graph033-reconciliation-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { adminApp, db: firestore, adminAuth: {} };
});
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: unknown, trigger: unknown, handler: MockFunctionHandler) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { data, id: 'graph033-reconcile-int-event' },
          step: {
            run: async <T,>(_name: string, callback: () => T | Promise<T>) => await callback(),
            sleep: async () => undefined,
          },
        }),
    }),
    send: async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
      mockEvents.push(event);
      return { ids: [event.id ?? 'graph033-reconcile-int-accepted'] };
    },
  },
  safeSendEvent: jest.fn(async () => true),
}));

import { db } from '@/lib/firebase-admin';
import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import { syncUnifiedEntityToNeo4jJob } from '@/lib/inngest/functions/sync-entity-to-neo4j';
import { syncRelationToNeo4jJob } from '@/lib/inngest/functions/sync-relation-to-neo4j';
import { syncEntityDocumentLinkToNeo4jJob } from '@/lib/inngest/functions/sync-entity-document-link-to-neo4j';
import { RECONCILIATION_KINDS } from '../projection-reconciliation';
import { runProjectionReconciliationCycle } from '../projection-reconciliation-runner';

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<unknown>;
}

const unifiedJob = syncUnifiedEntityToNeo4jJob as unknown as ExecutableJob;
const relationJob = syncRelationToNeo4jJob as unknown as ExecutableJob;
const documentLinkJob = syncEntityDocumentLinkToNeo4jJob as unknown as ExecutableJob;
const describeIntegration =
  process.env.NEO4J_INTEGRATION_TESTS === '1' && process.env.FIRESTORE_EMULATOR_HOST
    ? describe
    : describe.skip;

const IDS = {
  company: `${TEST_PREFIX}company`,
  document: `${TEST_PREFIX}document`,
  approved: `${TEST_PREFIX}signal-approved`,
  detected: `${TEST_PREFIX}signal-detected`,
  referenced: `${TEST_PREFIX}signal-referenced`,
  relation: `${TEST_PREFIX}relation`,
  link: `${TEST_PREFIX}link`,
};

const FIRESTORE_FIXTURES = [
  ['companies', IDS.company],
  ['documents', IDS.document],
  ['signals', IDS.approved],
  ['signals', IDS.detected],
  ['signals', IDS.referenced],
  ['relations', IDS.relation],
  ['entityDocumentLinks', IDS.link],
] as const;

function assertDisposableTargets(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(firestoreHost)) {
    throw new Error(`GRAPH-033 integration requires a loopback Firestore emulator, got ${firestoreHost}`);
  }
  if (PROJECT_ID !== DISPOSABLE_PROJECT_ID) {
    throw new Error(`GRAPH-033 integration requires Firebase project ${DISPOSABLE_PROJECT_ID}, got ${PROJECT_ID}`);
  }
  if (process.env.GRAPH_RECONCILIATION_INTEGRATION_DISPOSABLE !== 'true') {
    throw new Error('GRAPH-033 integration requires GRAPH_RECONCILIATION_INTEGRATION_DISPOSABLE=true');
  }
  neo4jTargetGuard.assertDisposableNeo4jIntegrationTarget(process.env);
}

async function cleanupFirestore(): Promise<void> {
  const batch = db.batch();
  for (const [collection, id] of FIRESTORE_FIXTURES) batch.delete(db.collection(collection).doc(id));
  for (const kind of RECONCILIATION_KINDS) {
    batch.delete(db.collection('graphReconciliationCursors').doc(kind));
  }
  await batch.commit();
}

async function cleanupNeo4j(): Promise<void> {
  await runWriteTransaction(
    `MATCH ()-[edge]->()
     WHERE edge.relationId STARTS WITH $prefix OR edge.linkId STARTS WITH $prefix
     DELETE edge`,
    { prefix: TEST_PREFIX }
  );
  await runWriteTransaction(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix OR node.relationId STARTS WITH $prefix
     DETACH DELETE node`,
    { prefix: TEST_PREFIX }
  );
}

async function ownedFirestoreCount(): Promise<number> {
  const refs = [
    ...FIRESTORE_FIXTURES.map(([collection, id]) => db.collection(collection).doc(id)),
    ...RECONCILIATION_KINDS.map((kind) => db.collection('graphReconciliationCursors').doc(kind)),
  ];
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));
  return snapshots.filter((snapshot) => snapshot.exists).length;
}

async function ownedNeo4jCount(): Promise<number> {
  const nodes = await graphCount(
    `MATCH (node)
     WHERE node.id STARTS WITH $prefix OR node.relationId STARTS WITH $prefix
     RETURN count(node) AS count`,
    { prefix: TEST_PREFIX }
  );
  const edges = await graphCount(
    `MATCH ()-[edge]->()
     WHERE edge.relationId STARTS WITH $prefix OR edge.linkId STARTS WITH $prefix
     RETURN count(edge) AS count`,
    { prefix: TEST_PREFIX }
  );
  return nodes + edges;
}

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  await Promise.all([
    db.collection('companies').doc(IDS.company).set({
      id: IDS.company,
      name: 'GRAPH-033 company',
      description: 'Disposable reconciliation endpoint.',
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('documents').doc(IDS.document).set({
      id: IDS.document,
      title: 'GRAPH-033 document',
      type: 'text',
      status: 'processed',
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('signals').doc(IDS.approved).set({
      id: IDS.approved,
      title: 'Approved projection',
      status: 'Approved',
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('signals').doc(IDS.detected).set({
      id: IDS.detected,
      title: 'Inbox-only projection',
      status: 'Detected',
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('signals').doc(IDS.referenced).set({
      id: IDS.referenced,
      title: 'Reference-retained projection',
      status: 'Rejected',
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('relations').doc(IDS.relation).set({
      id: IDS.relation,
      sourceSnapshot: { id: IDS.referenced, type: 'signal', name: 'Reference-retained projection' },
      targetSnapshot: { id: IDS.company, type: 'company', name: 'GRAPH-033 company' },
      relationType: 'uses',
      confidence: 90,
      claimStatus: 'curated',
      aiSuggested: false,
      evidenceRefs: [],
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('entityDocumentLinks').doc(IDS.link).set({
      id: IDS.link,
      workspaceId: 'default',
      entityType: 'signal',
      entityId: IDS.referenced,
      documentId: IDS.document,
      relationshipType: 'documentation',
      tags: [],
      relevance: 'high',
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  await runWriteTransaction(
    `CREATE (:Company:Entity {id: $companyId, name: 'GRAPH-033 company'})
     CREATE (:Document {id: $documentId, title: 'GRAPH-033 document'})
     CREATE (:Signal:Entity {id: $detectedId, title: 'Inbox-only projection', status: 'Detected'})`,
    { companyId: IDS.company, documentId: IDS.document, detectedId: IDS.detected }
  );
}

async function graphCount(cypher: string, params: Record<string, unknown>): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(cypher, params);
  return Number(result.records[0]?.count ?? 0);
}

describeIntegration('GRAPH-033 projection reconciliation (emulator + disposable Neo4j)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    assertDisposableTargets();
    await cleanupFirestore();
    await cleanupNeo4j();
  });

  afterEach(async () => {
    mockEvents.length = 0;
    await cleanupFirestore();
    await cleanupNeo4j();
  });

  afterAll(async () => {
    await closeDriver();
    await db.terminate();
  });

  it('converges Signal policy, a retained relation, and a document link in two cycles', async () => {
    await seedFixtures();
    mockEvents.length = 0;

    const first = await runProjectionReconciliationCycle();
    expect(first.errors).toEqual([]);
    expect(first.entities.signals).toMatchObject({ source: 3, firestore: 2, excluded: 1, missing: 2 });
    expect(first.relations.missing).toBe(1);
    expect(first.documentLinks.missing).toBe(1);

    const replayEvents = [...mockEvents];
    expect(
      replayEvents
        .filter((event) => event.name === 'app/unified-entity.sync.requested')
        .map((event) => event.data.entityId)
        .sort()
    ).toEqual([IDS.approved, IDS.detected, IDS.referenced].sort());
    expect(replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'app/relation.sync.requested', data: { operation: 'update', relationId: IDS.relation } }),
        expect.objectContaining({
          name: 'app/entity-document-link.sync.requested',
          data: { operation: 'update', linkId: IDS.link },
        }),
      ])
    );

    for (const event of replayEvents.filter((candidate) => candidate.name === 'app/unified-entity.sync.requested')) {
      await unifiedJob.execute(event.data);
    }
    await relationJob.execute(
      replayEvents.find((event) => event.name === 'app/relation.sync.requested')!.data
    );
    await documentLinkJob.execute(
      replayEvents.find((event) => event.name === 'app/entity-document-link.sync.requested')!.data
    );

    mockEvents.length = 0;
    const second = await runProjectionReconciliationCycle();
    expect(second.errors).toEqual([]);
    expect(second.syncsTriggered).toBe(0);
    expect(second.entities.signals).toMatchObject({ firestore: 2, neo4j: 2, missing: 0, stale: 0 });
    expect(second.relations).toMatchObject({ firestore: 1, neo4j: 1, missing: 0, stale: 0 });
    expect(second.documentLinks).toMatchObject({ firestore: 1, neo4j: 1, missing: 0, stale: 0, orphaned: 0 });
    expect(mockEvents).toEqual([]);

    expect(
      await graphCount('MATCH (signal:Signal) WHERE signal.id STARTS WITH $prefix RETURN count(signal) AS count', {
        prefix: TEST_PREFIX,
      })
    ).toBe(2);
    expect(
      await graphCount('MATCH ()-[edge {relationId: $relationId}]->() RETURN count(edge) AS count', {
        relationId: IDS.relation,
      })
    ).toBe(1);
    expect(
      await graphCount('MATCH ()-[edge {linkId: $linkId}]->() RETURN count(edge) AS count', { linkId: IDS.link })
    ).toBe(1);

    await cleanupFirestore();
    await cleanupNeo4j();
    expect(await ownedFirestoreCount()).toBe(0);
    expect(await ownedNeo4jCount()).toBe(0);
  });
});
