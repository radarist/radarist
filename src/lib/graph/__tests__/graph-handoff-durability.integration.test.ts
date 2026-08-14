/** @jest-environment node */

/**
 * GRAPH-056 — durable version-aware Firestore-to-Neo4j recovery, proven against
 * a disposable Firestore emulator, a disposable Neo4j, and the real Inngest job
 * handlers driven in-process.
 *
 * Every step runs production code. The dispatch outage is a real outage: the
 * graph kill switch makes `requestEntityGraphSyncServer` fail exactly as an
 * unreachable queue would, and the anchor it leaves behind is the same document
 * a browser failure writes.
 *
 * Guarded, and fail-loud once selected: the suite skips when its lane is not
 * chosen, but throws rather than degrades if it is chosen and misconfigured.
 */

import { randomUUID } from 'node:crypto';

const TEST_PREFIX = `graph056-${randomUUID().slice(0, 8)}-`;
const DISPOSABLE_PROJECT_ID = 'demo-graph056-handoff';
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? DISPOSABLE_PROJECT_ID;

const neo4jTargetGuard = require('../../../../scripts/testing/neo4j-integration-target.cjs');

const mockEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];

jest.unmock('@/lib/inngest/functions/sync-entity-to-neo4j');
jest.unmock('@/lib/inngest/functions/sync-technology-to-neo4j');
jest.unmock('@/lib/inngest/functions/sync-document-to-neo4j');

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

// A projection sync must never turn this zero-spend contract into an embedding
// call merely because the machine running the acceptance has provider keys.
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: false, reason: 'graph056-zero-spend' })),
}));

// Document chunk embeddings are optional enrichment under H7. Force the
// keyless path so this acceptance proves missing vectors stay visible in the
// run result without preventing required graph topology from converging.
jest.mock('@/lib/ai/client', () => ({
  generateEmbeddings: jest.fn(async (texts: readonly string[]) => ({
    embeddings: new Map<number, number[]>(),
    failures: new Map(texts.map((_text, index) => [index, 'graph056-zero-spend'])),
  })),
}));

// REAL admin Firestore against the disposable emulator (established pattern:
// report-trust-acceptance) — generated throwaway RSA credential;
// FIRESTORE_EMULATOR_HOST routes all traffic to the emulator.
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? 'demo-graph056-handoff';
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
        clientEmail: `acceptance@${projectId}.iam.gserviceaccount.com`,
        privateKey,
      }),
    },
    `graph056-handoff-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { __esModule: true, adminApp, db: firestore, adminAuth: {} };
});

// Real production job handlers, driven synchronously in-process.
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (
      config: unknown,
      trigger: unknown,
      handler: (input: { event: unknown; step: unknown }) => Promise<unknown>
    ) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { data, id: 'graph056-handoff-event' },
          step: {
            run: async <T>(_name: string, callback: () => T | Promise<T>) => await callback(),
            sleep: async () => undefined,
          },
        }),
    }),
    send: async (
      input:
        | { id?: string; name: string; data: Record<string, unknown> }
        | Array<{ id?: string; name: string; data: Record<string, unknown> }>
    ) => {
      const events = Array.isArray(input) ? input : [input];
      mockEvents.push(...events);
      return { ids: events.map((event, index) => event.id ?? `graph056-accepted-${index}`) };
    },
  },
  safeSendEvent: jest.fn(async () => true),
}));

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: {
    send: async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
      mockEvents.push(event);
      return { ids: [event.id ?? 'graph056-accepted'] };
    },
  },
}));

import { db } from '@/lib/firebase-admin';
import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import { syncUnifiedEntityToNeo4jJob } from '@/lib/inngest/functions/sync-entity-to-neo4j';
import {
  batchSyncTechnologiesJob,
  syncTechnologyToNeo4jJob,
} from '@/lib/inngest/functions/sync-technology-to-neo4j';
import { syncDocumentToNeo4jJob } from '@/lib/inngest/functions/sync-document-to-neo4j';
import { runProjectionReconciliationCycle } from '@/lib/graph/projection-reconciliation-runner';
import { requestEntityGraphSyncServer } from '@/lib/entity-sync-server';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import { createEntitySourceFingerprint } from '@/lib/entity-source-version';
import {
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  entityGraphSyncOutboxDocumentId,
  parseEntityGraphSyncOutboxRecord,
} from '@/lib/entity-graph-sync-outbox';
import {
  clearConvergedEntityGraphSyncAnchor,
  readEntityGraphSyncAnchor,
  recordEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-admin';

const runAcceptance =
  process.env.GRAPH_HANDOFF_DURABILITY_DISPOSABLE === 'true' &&
  process.env.NEO4J_INTEGRATION_TESTS === '1' &&
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
  process.env.FIRESTORE_EMULATOR_HOST.length > 0;

const describeAcceptance = runAcceptance ? describe : describe.skip;

const COMPANY_ID = `${TEST_PREFIX}company-1`;
const TECHNOLOGY_SINGLE_ID = `${TEST_PREFIX}technology-single`;
const TECHNOLOGY_BATCH_ID = `${TEST_PREFIX}technology-batch`;
const DOCUMENT_ID = `${TEST_PREFIX}document-1`;
const DOCUMENT_CHUNK_ID = `${TEST_PREFIX}document-chunk-1`;
const anchorId = entityGraphSyncOutboxDocumentId('company', COMPANY_ID);
const technologySingleAnchorId = entityGraphSyncOutboxDocumentId('technology', TECHNOLOGY_SINGLE_ID);
const technologyBatchAnchorId = entityGraphSyncOutboxDocumentId('technology', TECHNOLOGY_BATCH_ID);
const documentAnchorId = entityGraphSyncOutboxDocumentId('document', DOCUMENT_ID);

/** Exact owned documents — what makes the residue assertion meaningful. */
const FIRESTORE_FIXTURES: Array<[string, string]> = [
  ['companies', COMPANY_ID],
  ['technologies', TECHNOLOGY_SINGLE_ID],
  ['technologies', TECHNOLOGY_BATCH_ID],
  ['documents', DOCUMENT_ID],
  ['documentChunks', DOCUMENT_CHUNK_ID],
  [ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, anchorId],
  [ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, technologySingleAnchorId],
  [ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, technologyBatchAnchorId],
  [ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, documentAnchorId],
];

function assertDisposableTargets(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(firestoreHost)) {
    throw new Error(`GRAPH-056 acceptance requires a loopback Firestore emulator, got ${firestoreHost}`);
  }
  if (PROJECT_ID !== DISPOSABLE_PROJECT_ID) {
    throw new Error(`GRAPH-056 acceptance requires Firebase project ${DISPOSABLE_PROJECT_ID}, got ${PROJECT_ID}`);
  }
  neo4jTargetGuard.assertDisposableNeo4jIntegrationTarget(process.env);
}

async function cleanupFirestore(): Promise<void> {
  const batch = db.batch();
  for (const [collection, id] of FIRESTORE_FIXTURES) {
    batch.delete(db.collection(collection).doc(id));
  }
  const cursorSnapshot = await db.collection('graphReconciliationCursors').get();
  for (const cursor of cursorSnapshot.docs) batch.delete(cursor.ref);
  await batch.commit();
}

async function cleanupNeo4j(): Promise<void> {
  await runWriteTransaction('MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node', {
    prefix: TEST_PREFIX,
  });
}

async function ownedFirestoreCount(): Promise<number> {
  const snapshots = await Promise.all(
    FIRESTORE_FIXTURES.map(([collection, id]) => db.collection(collection).doc(id).get())
  );
  return snapshots.filter((snapshot) => snapshot.exists).length;
}

async function recoveryMetadataCount(): Promise<number> {
  const [anchors, cursors] = await Promise.all([
    db.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).get(),
    db.collection('graphReconciliationCursors').get(),
  ]);
  return anchors.size + cursors.size;
}

async function ownedNeo4jCount(): Promise<number> {
  const result = await runReadTransaction<{ total: number }>(
    'MATCH (node) WHERE node.id STARTS WITH $prefix RETURN count(node) AS total',
    { prefix: TEST_PREFIX }
  );
  const total = result.records[0]?.total ?? 0;
  return typeof total === 'number' ? total : Number((total as { toNumber(): number }).toNumber());
}

async function projectedFingerprint(label = 'Company', id = COMPANY_ID): Promise<string | null> {
  const result = await runReadTransaction<{ sourceFingerprint: unknown }>(
    `MATCH (node:${label} {id: $id}) RETURN node.sourceFingerprint AS sourceFingerprint`,
    { id }
  );
  const value = result.records[0]?.sourceFingerprint;
  return typeof value === 'string' ? value : null;
}

async function readSourceDoc(collection: string, id: string): Promise<Record<string, unknown>> {
  const snapshot = await db.collection(collection).doc(id).get();
  if (!snapshot.exists) throw new Error(`${collection}/${id} fixture missing`);
  return snapshot.data() as Record<string, unknown>;
}

async function readProjectedNode(label: string, id: string): Promise<Record<string, unknown> | null> {
  const result = await runReadTransaction<Record<string, unknown>>(
    `MATCH (node:${label} {id: $id}) RETURN properties(node) AS properties`,
    { id }
  );
  const properties = result.records[0]?.properties;
  return properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : null;
}

/** Commit an entity, then fail its graph handoff exactly as an outage would. */
async function commitWithFailedHandoff(name: string, updatedAt = Date.now()): Promise<EntitySyncDispatchError> {
  await db
    .collection('companies')
    .doc(COMPANY_ID)
    .set({ id: COMPANY_ID, name, slug: COMPANY_ID, status: 'Watching', tags: [], createdAt: 1, updatedAt });

  const previous = process.env.GRAPH_SYNC_ENABLED;
  process.env.GRAPH_SYNC_ENABLED = 'false';
  try {
    await requestEntityGraphSyncServer('company', COMPANY_ID, 'update');
    throw new Error('expected the graph handoff to fail while sync is disabled');
  } catch (error) {
    if (!(error instanceof EntitySyncDispatchError)) throw error;
    return error;
  } finally {
    if (previous === undefined) delete process.env.GRAPH_SYNC_ENABLED;
    else process.env.GRAPH_SYNC_ENABLED = previous;
  }
}

async function replayPendingEntityEvents(): Promise<number> {
  const pending = mockEvents.filter(
    (event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityId === COMPANY_ID
  );
  for (const event of pending) {
    await unifiedJob.execute(event.data);
  }
  return pending.length;
}

const unifiedJob = syncUnifiedEntityToNeo4jJob as unknown as {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
};
const technologyJob = syncTechnologyToNeo4jJob as unknown as {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
};
const technologyBatchJob = batchSyncTechnologiesJob as unknown as {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
};
const documentJob = syncDocumentToNeo4jJob as unknown as {
  execute(data: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function expectQuietReconciliation(kind: string, id: string): Promise<void> {
  mockEvents.length = 0;
  const first = await runProjectionReconciliationCycle();
  expect(first.repairPlan.operations.filter((operation) => operation.kind === kind && operation.id === id)).toEqual(
    []
  );
  expect(mockEvents.filter((event) => event.data.entityId === id || event.data.technologyId === id || event.data.documentId === id)).toEqual([]);

  mockEvents.length = 0;
  const second = await runProjectionReconciliationCycle();
  expect(second.repairPlan.operations.filter((operation) => operation.kind === kind && operation.id === id)).toEqual(
    []
  );
  expect(mockEvents.filter((event) => event.data.entityId === id || event.data.technologyId === id || event.data.documentId === id)).toEqual([]);
}

describeAcceptance('GRAPH-056 durable version-aware graph handoff recovery', () => {
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

  it('retains a durable recovery anchor when dispatch fails, and converges on replay', async () => {
    // 1 — dispatch outage against a committed mutation.
    const dispatchError = await commitWithFailedHandoff('Acme Committed');
    expect(dispatchError.entityId).toBe(COMPANY_ID);
    expect(dispatchError.message).toContain('committed');

    // 2 — the anchor is a durable Firestore value, not session state.
    const stored = await db.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).doc(anchorId).get();
    expect(stored.exists).toBe(true);

    // 3 — reload: a fresh reader reconstructs the pending operation.
    const reconstructed = parseEntityGraphSyncOutboxRecord(stored.id, stored.data());
    expect(reconstructed).toMatchObject({
      entityType: 'company',
      entityId: COMPANY_ID,
      operation: 'update',
      status: 'pending',
      attempt: 0,
    });

    // Nothing reached Neo4j — the outage was real.
    expect(await ownedNeo4jCount()).toBe(0);

    // 4/5 — reconciliation detects the drift and the replayed event converges.
    await runProjectionReconciliationCycle();
    expect(await replayPendingEntityEvents()).toBeGreaterThan(0);

    expect(await projectedFingerprint()).toBe(
      await createEntitySourceFingerprint('company', COMPANY_ID, await readSourceDoc('companies', COMPANY_ID))
    );

    // The worker settled the anchor once the projection matched the source.
    expect(await readEntityGraphSyncAnchor('company', COMPANY_ID)).toBeNull();

    // 5 — a second cycle is a no-op: replay converges rather than oscillating.
    mockEvents.length = 0;
    await runProjectionReconciliationCycle();
    expect(
      mockEvents.filter(
        (event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityId === COMPANY_ID
      )
    ).toEqual([]);
  }, 120_000);

  it('detects a stale projection that entity-ID reconciliation reported as healthy', async () => {
    // The exact regression: the node exists, so an existence check sees nothing
    // wrong while Neo4j holds superseded content.
    await commitWithFailedHandoff('Acme Original');
    await runProjectionReconciliationCycle();
    await replayPendingEntityEvents();
    const convergedFingerprint = await projectedFingerprint();
    expect(convergedFingerprint).not.toBeNull();

    // Edit the source without any successful handoff.
    await db.collection('companies').doc(COMPANY_ID).update({ name: 'Acme Renamed', updatedAt: Date.now() });

    const report = await runProjectionReconciliationCycle();
    expect(report.entities.companies.missing).toBe(0);
    expect(report.entities.companies.stale).toBeGreaterThan(0);
    expect(report.repairPlan.operations).toContainEqual(
      expect.objectContaining({ kind: 'companies', id: COMPANY_ID, reason: 'stale-source-version' })
    );

    await replayPendingEntityEvents();
    const repaired = await projectedFingerprint();
    expect(repaired).not.toBe(convergedFingerprint);
    expect(repaired).toBe(
      await createEntitySourceFingerprint('company', COMPANY_ID, await readSourceDoc('companies', COMPANY_ID))
    );
  }, 120_000);

  it('does not let a delayed v1 completion clear a same-millisecond v2 debt', async () => {
    const fixedMillis = 1_752_000_000_000;
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(fixedMillis);
    try {
      await commitWithFailedHandoff('Acme v1', fixedMillis);
      const v1Anchor = await readEntityGraphSyncAnchor('company', COMPANY_ID);
      expect(v1Anchor).not.toBeNull();

      // A second mutation in the exact same millisecond replaces the anchor.
      // Only the random generation may distinguish the debts.
      await commitWithFailedHandoff('Acme v2', fixedMillis);
      const v2Anchor = await readEntityGraphSyncAnchor('company', COMPANY_ID);
      expect(v2Anchor).not.toBeNull();
      expect(v2Anchor?.updatedAt).toBe(v1Anchor?.updatedAt);
      expect(v2Anchor?.generation).not.toBe(v1Anchor?.generation);

      await expect(
        clearConvergedEntityGraphSyncAnchor('company', COMPANY_ID, v1Anchor!.generation)
      ).resolves.toBe('superseded');

      expect(await readEntityGraphSyncAnchor('company', COMPANY_ID)).toMatchObject({
        generation: v2Anchor?.generation,
        updatedAt: fixedMillis,
      });

      await expect(
        clearConvergedEntityGraphSyncAnchor('company', COMPANY_ID, v2Anchor!.generation)
      ).resolves.toBe('cleared');
      expect(await readEntityGraphSyncAnchor('company', COMPANY_ID)).toBeNull();
    } finally {
      dateNow.mockRestore();
    }
  }, 120_000);

  it('never resurrects an entity whose source was deleted before the replay ran', async () => {
    await commitWithFailedHandoff('Acme Doomed');
    await runProjectionReconciliationCycle();
    const queued = mockEvents.filter(
      (event) => event.name === 'app/unified-entity.sync.requested' && event.data.entityId === COMPANY_ID
    );
    expect(queued.length).toBeGreaterThan(0);

    // The entity is deleted while its replay is still in flight.
    await db.collection('companies').doc(COMPANY_ID).delete();

    await replayPendingEntityEvents();

    // No node was created from the stale event...
    expect(await ownedNeo4jCount()).toBe(0);
    // ...and the anchor was retired rather than reporting a pending sync for an
    // entity that no longer exists.
    expect(await readEntityGraphSyncAnchor('company', COMPANY_ID)).toBeNull();
  }, 120_000);

  it('stamps and settles the dedicated Technology single-item projection from a fresh source read', async () => {
    const technology = {
      id: TECHNOLOGY_SINGLE_ID,
      name: 'Authoritative single technology',
      slug: TECHNOLOGY_SINGLE_ID,
      description: 'Loaded from Firestore by the dedicated writer.',
      category: 'Tool',
      tags: [],
      linkedCompanies: [],
      linkedUseCases: [],
      approvalStatus: 'approved',
      createdBy: 'graph056-acceptance',
      createdAt: 10,
      updatedAt: 20,
    };
    await db.collection('technologies').doc(TECHNOLOGY_SINGLE_ID).set(technology);
    await recordEntityGraphSyncAnchor({
      entityType: 'technology',
      entityId: TECHNOLOGY_SINGLE_ID,
      operation: 'create',
      error: new Error('simulated rejected handoff'),
    });

    const result = await technologyJob.execute({
      operation: 'create',
      technologyId: TECHNOLOGY_SINGLE_ID,
      // A stale inline body must not be an alternate source of truth.
      technologyData: { ...technology, name: 'STALE EVENT TECHNOLOGY' },
    });
    expect(result).toMatchObject({ success: true });

    const expected = await createEntitySourceFingerprint(
      'technology',
      TECHNOLOGY_SINGLE_ID,
      await readSourceDoc('technologies', TECHNOLOGY_SINGLE_ID)
    );
    expect(await projectedFingerprint('Technology', TECHNOLOGY_SINGLE_ID)).toBe(expected);
    expect(await readProjectedNode('Technology', TECHNOLOGY_SINGLE_ID)).toMatchObject({
      name: 'Authoritative single technology',
      sourceFingerprint: expected,
    });
    expect(await readEntityGraphSyncAnchor('technology', TECHNOLOGY_SINGLE_ID)).toBeNull();
    await expectQuietReconciliation('technologies', TECHNOLOGY_SINGLE_ID);
  }, 120_000);

  it('stamps and settles the dedicated Technology batch projection from Firestore, not batch payload fields', async () => {
    const technology = {
      id: TECHNOLOGY_BATCH_ID,
      name: 'Authoritative batch technology',
      slug: TECHNOLOGY_BATCH_ID,
      description: 'The batch payload may carry only an identifier.',
      category: 'Methodology',
      tags: [],
      linkedCompanies: [],
      linkedUseCases: [],
      approvalStatus: 'approved',
      createdBy: 'graph056-acceptance',
      createdAt: 30,
      updatedAt: 40,
    };
    await db.collection('technologies').doc(TECHNOLOGY_BATCH_ID).set(technology);
    await recordEntityGraphSyncAnchor({
      entityType: 'technology',
      entityId: TECHNOLOGY_BATCH_ID,
      operation: 'update',
      error: new Error('simulated rejected batch handoff'),
    });

    const result = await technologyBatchJob.execute({
      technologies: [{ id: TECHNOLOGY_BATCH_ID, name: 'STALE BATCH PAYLOAD' }],
      options: { batchSize: 1 },
    });
    expect(result).toMatchObject({ success: true, created: 1, failed: 0 });

    const delegated = mockEvents.filter(
      (event) =>
        event.name === 'app/technology.sync.requested' && event.data.technologyId === TECHNOLOGY_BATCH_ID
    );
    expect(delegated).toHaveLength(1);
    await technologyJob.execute(delegated[0].data);

    const expected = await createEntitySourceFingerprint(
      'technology',
      TECHNOLOGY_BATCH_ID,
      await readSourceDoc('technologies', TECHNOLOGY_BATCH_ID)
    );
    expect(await projectedFingerprint('Technology', TECHNOLOGY_BATCH_ID)).toBe(expected);
    expect(await readProjectedNode('Technology', TECHNOLOGY_BATCH_ID)).toMatchObject({
      name: 'Authoritative batch technology',
      sourceFingerprint: expected,
    });
    expect(await readEntityGraphSyncAnchor('technology', TECHNOLOGY_BATCH_ID)).toBeNull();
    await expectQuietReconciliation('technologies', TECHNOLOGY_BATCH_ID);
  }, 120_000);

  it('ignores stale Document event fields and converges required topology without an optional embedding', async () => {
    const document = {
      id: DOCUMENT_ID,
      title: 'Authoritative research document',
      type: 'research',
      domain: 'quantum-chemistry',
      version: 3,
      workspaceId: 'graph056-acceptance',
      linkedEntityCount: 2,
      status: 'processed',
      createdAt: 50,
      updatedAt: 60,
    };
    await db.collection('documents').doc(DOCUMENT_ID).set(document);
    await db.collection('documentChunks').doc(DOCUMENT_CHUNK_ID).set({
      documentId: DOCUMENT_ID,
      content: 'Keyless chunk content still belongs in the graph.',
      metadata: { startChar: 0, endChar: 49 },
      chunkIndex: 0,
      tokenCount: 9,
      createdAt: 55,
    });
    await recordEntityGraphSyncAnchor({
      entityType: 'document',
      entityId: DOCUMENT_ID,
      operation: 'update',
      error: new Error('simulated rejected document handoff'),
    });

    const result = await documentJob.execute({
      operation: 'update',
      documentId: DOCUMENT_ID,
      documentData: {
        ...document,
        title: 'STALE INLINE DOCUMENT',
        version: 1,
        updatedAt: 1,
      },
    });
    expect(result).toMatchObject({
      success: false,
      operation: 'updated',
      chunksCreated: 1,
      chunksEmbeddingFailed: 1,
      chunksFailed: 0,
    });

    const expected = await createEntitySourceFingerprint(
      'document',
      DOCUMENT_ID,
      await readSourceDoc('documents', DOCUMENT_ID)
    );
    expect(await projectedFingerprint('Document', DOCUMENT_ID)).toBe(expected);
    expect(await readProjectedNode('Document', DOCUMENT_ID)).toMatchObject({
      title: 'Authoritative research document',
      version: 3,
      sourceFingerprint: expected,
    });
    expect(await readProjectedNode('Chunk', DOCUMENT_CHUNK_ID)).toMatchObject({
      content: 'Keyless chunk content still belongs in the graph.',
    });
    const contains = await runReadTransaction<{ total: number }>(
      `MATCH (:Document {id: $documentId})-[:CONTAINS]->(:Chunk {id: $chunkId})
       RETURN count(*) AS total`,
      { documentId: DOCUMENT_ID, chunkId: DOCUMENT_CHUNK_ID }
    );
    expect(Number(contains.records[0]?.total ?? 0)).toBe(1);
    expect(await readEntityGraphSyncAnchor('document', DOCUMENT_ID)).toBeNull();
    await expectQuietReconciliation('documents', DOCUMENT_ID);
  }, 120_000);

  it('leaves zero residue in Firestore and Neo4j', async () => {
    await commitWithFailedHandoff('Acme Residue');
    await runProjectionReconciliationCycle();
    await replayPendingEntityEvents();
    expect(await ownedNeo4jCount()).toBeGreaterThan(0);

    await cleanupFirestore();
    await cleanupNeo4j();

    expect(await ownedFirestoreCount()).toBe(0);
    expect(await recoveryMetadataCount()).toBe(0);
    expect(await ownedNeo4jCount()).toBe(0);
  }, 120_000);
});
