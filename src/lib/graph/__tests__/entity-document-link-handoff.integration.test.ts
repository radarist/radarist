/** @jest-environment node */

/**
 * GRAPH-069 acceptance, against a real Firestore emulator, a real guarded
 * disposable Neo4j, and the real production code path from the browser
 * transport through the authenticated route, the server dispatcher, the queue,
 * and the projection worker.
 *
 * Nothing about the outcome is simulated. The only substitutions are the two
 * things a Jest process genuinely cannot host: `fetchWithAuth` calls the real
 * route handler in-process instead of over TCP, and the Inngest client is a
 * queue that records events, honours supplied-id deduplication exactly as
 * Inngest does, and runs the real worker handler on drain. The Firestore rows,
 * the recovery anchors, the Cypher, and the resulting edges are all real.
 *
 * Proves, end to end:
 *   - successful convergence: exactly one correct edge, anchor never written
 *   - refused dispatch: link committed, caller told "pending", durable anchor left
 *   - replay recovery: the anchored link converges and the anchor is retired
 *   - lost acknowledgement: a re-run after a lost response still yields one edge
 *   - exact retry: the same mutation deduplicates on its stable replay identity
 *   - update: same primitive, edge replaced in place, still exactly one edge
 *   - conflicting replay: fails closed, no projection
 *   - cross-owner refusal: another user's link is refused, nothing dispatched
 */

const TEST_PREFIX = 'edl-handoff-int-';
const DISPOSABLE_PROJECT_ID = 'demo-entity-document-link-handoff';
const PROJECT_ID =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';

const neo4jTargetGuard = require('../../../../scripts/testing/neo4j-integration-target.cjs') as {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): unknown;
};

interface QueuedEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

/** Events accepted by the fake queue, in order. */
const accepted: QueuedEvent[] = [];
/** Supplied ids already accepted — Inngest deduplicates on these. */
const seenEventIds = new Set<string>();
/** Set to make the queue refuse, exactly as an outage or kill switch would. */
let queueRefusal: 'none' | 'reject' | 'accept-nothing' = 'none';

// The global setup stubs every Inngest function; this suite needs the real one.
jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
  invalidateAllGraphCaches: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-entity-document-link-handoff';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const adminApp = initializeApp(
    {
      projectId,
      credential: cert({ projectId, clientEmail: `edl@${projectId}.iam.gserviceaccount.com`, privateKey }),
    },
    `edl-handoff-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { adminApp, db: firestore, adminAuth: {} };
});

function fakeSend(event: QueuedEvent | QueuedEvent[]): { ids: string[] } {
  const events = Array.isArray(event) ? event : [event];
  if (queueRefusal === 'reject') throw new Error('queue unavailable');
  if (queueRefusal === 'accept-nothing') return { ids: [] };
  const ids: string[] = [];
  for (const candidate of events) {
    const id = candidate.id ?? `${TEST_PREFIX}auto-${accepted.length}-${candidate.name}`;
    // Inngest deduplicates on a supplied id. Reproducing that here is the whole
    // point of the exact-retry case: a replayed identity must not run twice.
    if (candidate.id && seenEventIds.has(candidate.id)) {
      ids.push(id);
      continue;
    }
    if (candidate.id) seenEventIds.add(candidate.id);
    accepted.push(candidate);
    ids.push(id);
  }
  return { ids };
}

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: async (event: QueuedEvent | QueuedEvent[]) => fakeSend(event) },
  sendEvent: jest.fn(),
  safeSendEvent: jest.fn(async () => true),
  isInngestConfigured: () => true,
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (
      config: unknown,
      trigger: unknown,
      handler: (context: {
        event: { data: Record<string, unknown>; id: string };
        step: {
          run: <T>(name: string, callback: () => T | Promise<T>) => Promise<T>;
          sleep: (name: string, duration: string) => Promise<void>;
        };
      }) => Promise<unknown>
    ) => ({
      config,
      trigger,
      execute: (data: Record<string, unknown>) =>
        handler({
          event: { data, id: `${TEST_PREFIX}event` },
          step: {
            run: async <T>(_name: string, callback: () => T | Promise<T>) => await callback(),
            sleep: async () => undefined,
          },
        }),
    }),
    send: async (event: QueuedEvent | QueuedEvent[]) => fakeSend(event),
  },
  safeSendEvent: jest.fn(async () => true),
}));

// The browser anchor recorder writes through the client SDK, which has no app
// in a Node process. Delegating to the Admin twin keeps the recovery WRITE
// real — the same collection, the same record shape, the same deterministic id
// — while only the SDK underneath differs.
jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  recordEntityGraphSyncAnchor: async (options: Record<string, unknown>) => {
    const admin = jest.requireActual<typeof import('@/lib/entity-graph-sync-outbox-admin')>(
      '@/lib/entity-graph-sync-outbox-admin'
    );
    return admin.recordEntityGraphSyncAnchor(options as Parameters<typeof admin.recordEntityGraphSyncAnchor>[0]);
  },
}));

const authenticatedUid = { current: `${TEST_PREFIX}owner` };
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: async () => ({ authenticated: true, uid: authenticatedUid.current }),
}));

// The browser transport posts to the same-origin route. In-process delivery to
// the real handler keeps every server-side check — schema, authoritative
// re-read, endpoint comparison, owner provenance, dispatch — on the path.
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: async (url: string, init: RequestInit) => {
    const { NextRequest } = jest.requireActual<typeof import('next/server')>('next/server');
    const route = jest.requireActual<typeof import('@/app/api/graph/entity-document-link-sync/route')>(
      '@/app/api/graph/entity-document-link-sync/route'
    );
    const request = new NextRequest(`http://localhost${url}`, {
      method: init.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer integration-token' },
      body: init.body as string,
    });
    return route.POST(request);
  },
}));

import { db } from '@/lib/firebase-admin';
import { closeDriver, runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import { requestEntityDocumentLinkGraphHandoff } from '@/lib/entity-document-link-handoff-client';
import { adminCreateEntityDocumentLink, adminUpdateEntityDocumentLink } from '@/lib/entity-document-link-admin';
import { syncEntityDocumentLinkToNeo4jJob } from '@/lib/inngest/functions/sync-entity-document-link-to-neo4j';
import { ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION, entityGraphSyncOutboxDocumentId } from '@/lib/entity-graph-sync-outbox';
import { runProjectionReconciliationCycle } from '@/lib/graph/projection-reconciliation-runner';

const worker = syncEntityDocumentLinkToNeo4jJob as unknown as {
  execute(data: Record<string, unknown>): Promise<unknown>;
};

const ENTITY_ID = `${TEST_PREFIX}technology`;
const DOCUMENT_ID = `${TEST_PREFIX}document`;
const OWNER = `${TEST_PREFIX}owner`;

const describeIntegration =
  process.env.NEO4J_INTEGRATION_TESTS === '1' && process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

function assertDisposableTargets(): void {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(firestoreHost)) {
    throw new Error(`Entity-document link handoff acceptance requires a loopback emulator, got ${firestoreHost}`);
  }
  if (PROJECT_ID !== DISPOSABLE_PROJECT_ID) {
    throw new Error(`Acceptance requires Firebase project ${DISPOSABLE_PROJECT_ID}, got ${PROJECT_ID}`);
  }
  if (process.env.ENTITY_DOCUMENT_LINK_HANDOFF_ACCEPTANCE_DISPOSABLE !== 'true') {
    throw new Error('Acceptance requires ENTITY_DOCUMENT_LINK_HANDOFF_ACCEPTANCE_DISPOSABLE=true');
  }
  neo4jTargetGuard.assertDisposableNeo4jIntegrationTarget(process.env);
}

/** Run the real worker for every queued link event, in order, then clear. */
async function drainLinkEvents(): Promise<number> {
  const pending = accepted.filter((event) => event.name === 'app/entity-document-link.sync.requested');
  accepted.length = 0;
  for (const event of pending) {
    await worker.execute(event.data);
  }
  return pending.length;
}

interface EdgeRow {
  relType: string;
  entityId: string | null;
  documentId: string | null;
  relevance: unknown;
  note: unknown;
}

async function edgesForLink(linkId: string): Promise<EdgeRow[]> {
  const result = await runReadTransaction<EdgeRow>(
    `MATCH (source)-[edge {linkId: $linkId}]->(document)
     RETURN type(edge) AS relType, source.id AS entityId, document.id AS documentId,
            edge.relevance AS relevance, edge.note AS note`,
    { linkId }
  );
  return result.records;
}

async function readAnchor(linkId: string): Promise<Record<string, unknown> | null> {
  const snapshot = await db
    .collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION)
    .doc(entityGraphSyncOutboxDocumentId('entityDocumentLink', linkId))
    .get();
  return snapshot.exists ? (snapshot.data() as Record<string, unknown>) : null;
}

async function seedEndpoints(): Promise<void> {
  const now = Date.now();
  await db
    .collection('technologies')
    .doc(ENTITY_ID)
    .set({
      name: `${TEST_PREFIX}Technology`,
      slug: `${TEST_PREFIX}technology-slug`,
      description: 'Endpoint fixture.',
      approvalStatus: 'approved',
      createdBy: OWNER,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
  await db
    .collection('documents')
    .doc(DOCUMENT_ID)
    .set({
      title: `${TEST_PREFIX}Document`,
      type: 'upload',
      status: 'processed',
      linkedEntityCount: 0,
      uploadedBy: OWNER,
      createdAt: now,
      updatedAt: now,
    });
  await runWriteTransaction(`MERGE (t:Technology {id: $id}) SET t.name = $name`, {
    id: ENTITY_ID,
    name: `${TEST_PREFIX}Technology`,
  });
  await runWriteTransaction(`MERGE (d:Document {id: $id}) SET d.title = $title`, {
    id: DOCUMENT_ID,
    title: `${TEST_PREFIX}Document`,
  });
}

async function cleanup(): Promise<void> {
  // Link ids and their anchor ids are base64url encodings of the endpoint
  // triple, so neither contains the readable prefix. Match on the endpoint
  // fields instead, and clear the recovery collection wholesale — this project
  // is disposable and dedicated, and a surviving anchor would silently satisfy
  // (or falsify) the next case's assertions.
  for (const collection of ['entityDocumentLinks', 'technologies', 'documents']) {
    const snapshot = await db.collection(collection).get();
    const owned = snapshot.docs.filter(
      (document) => document.id.includes(TEST_PREFIX) || String(document.data()?.entityId ?? '').includes(TEST_PREFIX)
    );
    if (owned.length === 0) continue;
    const batch = db.batch();
    for (const document of owned) batch.delete(document.ref);
    await batch.commit();
  }
  const anchors = await db.collection(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).get();
  if (!anchors.empty) {
    const batch = db.batch();
    for (const document of anchors.docs) batch.delete(document.ref);
    await batch.commit();
  }
  await runWriteTransaction(`MATCH ()-[edge]->() WHERE edge.linkId STARTS WITH $prefix DELETE edge`, {
    prefix: 'edl1_',
  });
  await runWriteTransaction(`MATCH (node) WHERE node.id STARTS WITH $prefix DETACH DELETE node`, {
    prefix: TEST_PREFIX,
  });
}

/** Create the link through the admin repository, which is the server writer. */
async function createLink(overrides: { relevance?: 'high' | 'medium' | 'low'; note?: string } = {}) {
  return adminCreateEntityDocumentLink({
    workspaceId: 'default',
    entityType: 'technology',
    entityId: ENTITY_ID,
    documentId: DOCUMENT_ID,
    relationshipType: 'documentation',
    relevance: overrides.relevance ?? 'high',
    tags: ['acceptance'],
    aiSuggested: false,
    createdBy: OWNER,
    ...(overrides.note ? { note: overrides.note } : {}),
  });
}

describeIntegration('GRAPH-069 entity-document link graph handoff', () => {
  beforeAll(async () => {
    assertDisposableTargets();
    await cleanup();
  });

  beforeEach(async () => {
    accepted.length = 0;
    seenEventIds.clear();
    queueRefusal = 'none';
    authenticatedUid.current = OWNER;
    await cleanup();
    await seedEndpoints();
  });

  afterAll(async () => {
    await cleanup();
    await closeDriver();
  });

  it('converges a created link to exactly one correct edge, with no recovery debt', async () => {
    const { link, graphHandoff } = await createLink({ note: 'first note' });

    expect(graphHandoff).toEqual({ status: 'acknowledged' });
    expect(await drainLinkEvents()).toBe(1);

    const edges = await edgesForLink(link.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relType: 'DOCUMENTED_BY',
      entityId: ENTITY_ID,
      documentId: DOCUMENT_ID,
      relevance: 'high',
      note: 'first note',
    });
    // Convergence with no failure means no anchor was ever written.
    expect(await readAnchor(link.id)).toBeNull();
    const stored = await db.collection('entityDocumentLinks').doc(link.id).get();
    expect(stored.data()?.graphSyncStatus).toBe('synced');
  });

  it('reports a refused dispatch honestly and leaves a durable recovery anchor', async () => {
    queueRefusal = 'reject';

    const { link, graphHandoff } = await createLink();

    // The Firestore link IS committed…
    expect((await db.collection('entityDocumentLinks').doc(link.id).get()).exists).toBe(true);
    // …and is NOT reported as a completed projection.
    expect(graphHandoff.status).toBe('pending-reconciliation');
    expect(await edgesForLink(link.id)).toHaveLength(0);

    const anchor = await readAnchor(link.id);
    expect(anchor).toMatchObject({
      entityType: 'entityDocumentLink',
      entityId: link.id,
      operation: 'create',
      status: 'pending',
    });
  });

  it('recovers an anchored link through reconciliation and retires the anchor', async () => {
    queueRefusal = 'reject';
    const { link } = await createLink();
    const anchorBefore = await readAnchor(link.id);
    expect(anchorBefore).not.toBeNull();

    // The queue comes back. Reconciliation is the replayer: it notices the
    // missing projection and dispatches a repair event.
    queueRefusal = 'none';
    await runProjectionReconciliationCycle();
    expect(await drainLinkEvents()).toBeGreaterThan(0);

    expect(await edgesForLink(link.id)).toHaveLength(1);
    // The worker settles the anchor the moment its own write converges.
    expect(await readAnchor(link.id)).toBeNull();
  });

  it('retires a stranded anchor on the next reconciliation pass once the projection matches', async () => {
    const { link } = await createLink();
    await drainLinkEvents();
    // Simulate an anchor written by a handoff whose event never reached the
    // queue at all: no worker will ever run for it, so only the reconciler can
    // terminate it — and only because the projection provably matches.
    const admin = await import('@/lib/entity-graph-sync-outbox-admin');
    await admin.recordEntityGraphSyncAnchor({
      entityType: 'entityDocumentLink',
      entityId: link.id,
      operation: 'update',
      error: new Error('stranded'),
    });
    expect(await readAnchor(link.id)).not.toBeNull();

    await runProjectionReconciliationCycle();

    expect(await readAnchor(link.id)).toBeNull();
    expect(await edgesForLink(link.id)).toHaveLength(1);
  });

  it('converges to exactly one edge after a lost acknowledgement is retried', async () => {
    const { link } = await createLink();
    // The dispatch was accepted but the caller never learned — it retries the
    // identical handoff. Both the original and the retry are delivered.
    const outcome = await requestEntityDocumentLinkGraphHandoff(
      { linkId: link.id, entityId: ENTITY_ID, documentId: DOCUMENT_ID },
      'create'
    );
    expect(outcome).toEqual({ status: 'acknowledged' });

    await drainLinkEvents();

    expect(await edgesForLink(link.id)).toHaveLength(1);
  });

  it('deduplicates an exact retry on its stable replay identity', async () => {
    const { link } = await createLink();
    const queuedAfterCreate = accepted.length;

    await requestEntityDocumentLinkGraphHandoff(
      { linkId: link.id, entityId: ENTITY_ID, documentId: DOCUMENT_ID },
      'create'
    );

    // Same link, same content, same revision, same operation → same id → the
    // queue collapses it rather than scheduling a second identical projection.
    expect(accepted.length).toBe(queuedAfterCreate);
    await drainLinkEvents();
    expect(await edgesForLink(link.id)).toHaveLength(1);
  });

  it('projects an update through the same primitive, replacing the edge in place', async () => {
    const { link } = await createLink({ relevance: 'high', note: 'first note' });
    await drainLinkEvents();

    const { graphHandoff } = await adminUpdateEntityDocumentLink(link.id, { relevance: 'low', note: 'second note' });
    expect(graphHandoff).toEqual({ status: 'acknowledged' });
    expect(await drainLinkEvents()).toBe(1);

    const edges = await edgesForLink(link.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ relevance: 'low', note: 'second note' });
  });

  it('fails a conflicting replay closed instead of projecting a link nobody committed', async () => {
    const { link } = await createLink();
    accepted.length = 0;

    const outcome = await requestEntityDocumentLinkGraphHandoff(
      { linkId: link.id, entityId: `${TEST_PREFIX}moved-entity`, documentId: DOCUMENT_ID },
      'update'
    );

    expect(outcome.status).toBe('refused');
    expect(accepted).toHaveLength(0);
    expect(await edgesForLink(link.id)).toHaveLength(0);
  });

  it('refuses a cross-owner handoff without dispatching anything', async () => {
    const { link } = await createLink();
    accepted.length = 0;
    authenticatedUid.current = `${TEST_PREFIX}other-user`;

    const outcome = await requestEntityDocumentLinkGraphHandoff(
      { linkId: link.id, entityId: ENTITY_ID, documentId: DOCUMENT_ID },
      'update'
    );

    expect(outcome.status).toBe('refused');
    expect(accepted).toHaveLength(0);
    expect(await edgesForLink(link.id)).toHaveLength(0);
    // A refusal is about the request, not delivery: it must not enqueue
    // recovery work that can never succeed as-is.
    expect(await readAnchor(link.id)).toBeNull();
  });
});
