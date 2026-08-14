/** @jest-environment node */

/**
 * AI-024 / AI-023 acceptance — explicit artifact queue-intent and explicit
 * document-link dispatch semantics through the REAL chat route.
 *
 * Vehicle: the TEST-017 deterministic provider seam. The real
 * `@google/generative-ai` SDK talks to the in-process loopback Gemini stub
 * (`scripts/testing/gemini-chat-stub-server.ts`); the real route, tool loop,
 * executors, authority grammar, and Firestore (emulator, disposable `demo-`
 * project) all run unmocked. Only identity (`getAuthenticatedUser`), Inngest
 * transport, and prompt-enrichment side channels are stubbed — none of them is
 * what this suite proves.
 *
 * Proof matrix:
 *  1. explicit queue intent → the model turn carries TWO identical
 *     `recommendArtifact` calls; both execute; the store converges to exactly
 *     ONE pending+idle proposedArtifact; nothing generates.
 *  2. replaying the same turn converges (`created:false`), still one doc.
 *  3. a vague turn produces no tool call and dispatches nothing.
 *  4. a model-authored prose suggestion (even containing a JSON-looking
 *     recommendArtifact snippet) dispatches nothing.
 *  5. an explicit "Link \"<doc>\" to <entity>" turn carries TWO identical
 *     calls through the route's parallel tool loop. The transactional admin
 *     service creates exactly one entityDocumentLink (createdBy = the signed-in
 *     uid, aiSuggested false), increments once, and requests one graph handoff;
 *     replaying converges (`created:false` twice), still one link.
 *  6. the same link instruction wrapped in discovery wording is REFUSED by the
 *     route-side authority even though the scripted model still calls the tool
 *     — zero links.
 *
 * Guarded: runs only under `npm run test:acceptance:artifact-intent`
 * (ARTIFACT_INTENT_ACCEPTANCE_DISPOSABLE=true + a live Firestore emulator);
 * the ordinary jest lane skips it.
 */

const ACCEPTANCE_PROJECT_ID = 'demo-artifact-intent';
const ACCEPTANCE_UID = 'acceptance-user-1';

const runAcceptance =
  process.env.ARTIFACT_INTENT_ACCEPTANCE_DISPOSABLE === 'true' &&
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
  process.env.FIRESTORE_EMULATOR_HOST.length > 0;
const describeAcceptance = runAcceptance ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Client-SDK import chain breakers (same shape as route.test.ts) — the route
// and the tool barrel transitively import client modules that must not
// initialize a real client SDK inside this Node suite.
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase', () => ({ __esModule: true, db: {}, auth: {}, storage: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  addDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  getFirestore: jest.fn(),
  connectFirestoreEmulator: jest.fn(),
  serverTimestamp: jest.fn(),
  Timestamp: { now: jest.fn(() => ({ toMillis: () => Date.now() })) },
}));
jest.mock('firebase/auth', () => ({
  __esModule: true,
  getAuth: jest.fn(() => ({})),
  connectAuthEmulator: jest.fn(),
}));
jest.mock('firebase/storage', () => ({
  __esModule: true,
  getStorage: jest.fn(() => ({})),
  connectStorageEmulator: jest.fn(),
}));
jest.mock('firebase/app', () => ({
  __esModule: true,
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
  getApp: jest.fn(() => ({})),
}));
jest.mock('@tanstack/react-query', () => ({ __esModule: true, QueryClient: jest.fn() }));
jest.mock('@/lib/events/data-refresh', () => ({ __esModule: true }));

// ---------------------------------------------------------------------------
// REAL admin Firestore against the disposable emulator (pattern from
// projection-reconciliation.integration.test.ts) — generated throwaway RSA
// credential; `FIRESTORE_EMULATOR_HOST` routes all traffic to the emulator.
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-artifact-intent';
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const adminApp = initializeApp(
    {
      projectId,
      credential: cert({ projectId, clientEmail: `acceptance@${projectId}.iam.gserviceaccount.com`, privateKey }),
    },
    `artifact-intent-acceptance-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { __esModule: true, adminApp, db: firestore, adminAuth: {} };
});

// Identity: the signed-in human. Auth-token verification is not under test.
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn(async () => ({
    authenticated: true as const,
    uid: 'acceptance-user-1',
    email: 'acceptance@test.local',
  })),
}));

// Inngest transport: recorded, not delivered — the doc-link graph handoff is
// asserted at this boundary; artifact staging sends nothing by design.
const recordedInngestEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    send: jest.fn(async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
      recordedInngestEvents.push(event);
      return { ids: ['recorded'] };
    }),
    createFunction: jest.fn((config: unknown, trigger: unknown, handler: unknown) => ({ config, trigger, handler })),
  },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  __esModule: true,
  inngest: {
    send: jest.fn(async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
      recordedInngestEvents.push(event);
      return { ids: ['recorded'] };
    }),
  },
}));

// Prompt-enrichment / observability side channels — not under test.
jest.mock('@/lib/user-preferences', () => ({
  __esModule: true,
  getMissionUserPreferences: jest.fn(),
  buildUserPreferencesPreamble: jest.fn(() => ''),
}));
jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getExploredEntities: jest.fn(async () => []),
  recordExploration: jest.fn(async () => undefined),
}));
jest.mock('@/lib/chat-preferences-admin', () => ({
  __esModule: true,
  buildWorkingStyleBlock: jest.fn(async () => ''),
}));
jest.mock('@/lib/graph/episodes', () => ({
  __esModule: true,
  createEpisode: jest.fn(async () => ({ id: 'ep-acceptance' })),
}));
jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(async () => undefined),
}));
jest.mock('@/lib/graph/agent-run-sync', () => ({
  __esModule: true,
  syncAgentRunToNeo4j: jest.fn(async () => undefined),
}));

import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { startGeminiChatStub, type GeminiChatStub } from '../../../../../../scripts/testing/gemini-chat-stub-server';

jest.setTimeout(120_000);

describeAcceptance('artifact-intent acceptance — explicit dispatch semantics through the real chat route', () => {
  let stub: GeminiChatStub;
  let db: FirebaseFirestore.Firestore;
  let POST: (request: NextRequest) => Promise<Response>;

  const EXPLICIT_QUEUE_TURN = 'Queue an HTML report recommendation on edge AI inference chips.';
  const VAGUE_TURN = 'What should I be looking at these days?';
  const SUGGEST_TURN = 'Anything interesting on my radar lately?';
  const DOC_LINK_TURN = 'Link "Q3 Architecture Review" to Acme Robotics';
  const DOC_LINK_SUGGEST_TURN = 'Could we maybe link "Q3 Architecture Review" to Acme Robotics?';

  function chatRequest(message: string): NextRequest {
    return new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        context: { currentRoute: '/dashboard', currentPage: 'Dashboard' },
      }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer acceptance-token' },
    });
  }

  interface ChatEnvelope {
    success: boolean;
    message?: string;
    error?: string;
    toolCalls?: Array<{
      name: string;
      args: Record<string, unknown>;
      result: { success: boolean; data?: Record<string, unknown>; error?: string };
    }>;
  }

  async function postChat(message: string): Promise<ChatEnvelope> {
    const response = await POST(chatRequest(message));
    expect(response.status).toBe(200);
    return (await response.json()) as ChatEnvelope;
  }

  async function purge(collection: string): Promise<void> {
    const snapshot = await db.collection(collection).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function docsIn(collection: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
    return (await db.collection(collection).get()).docs;
  }

  beforeAll(async () => {
    stub = await startGeminiChatStub({
      fixtures: {
        companyId: 'comp-accept-1',
        technologyId: 'tech-accept-1',
        companyName: 'Acme Robotics',
        technologyName: 'Quantum Mesh',
      },
    });
    process.env.GEMINI_TEST_BASE_URL = stub.url;
    process.env.GEMINI_API_KEY = 'acceptance-test-key';
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = ACCEPTANCE_PROJECT_ID;
    delete process.env.CLAUDE_CHAT_ENABLED;

    // Import AFTER env + mocks so the route captures the seam and the
    // admin mock binds the emulator project.
    ({ POST } = require('../route'));
    ({ db } = require('@/lib/firebase-admin'));
  });

  afterAll(async () => {
    await stub.close();
    delete process.env.GEMINI_TEST_BASE_URL;
  });

  beforeEach(async () => {
    recordedInngestEvents.length = 0;
    await purge('proposedArtifacts');
    await purge('entityDocumentLinks');
    await purge('companies');
    await purge('documents');
    await purge('reports');

    const now = Timestamp.now();
    await db.collection('companies').doc('comp-accept-1').set({
      id: 'comp-accept-1',
      name: 'Acme Robotics',
      slug: 'acme-robotics',
      description: 'Robotics fixture for the acceptance run.',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('documents').doc('doc-accept-1').set({
      id: 'doc-accept-1',
      title: 'Q3 Architecture Review',
      type: 'markdown',
      status: 'ready',
      tags: [],
      linkedEntityCount: 0,
      uploadedBy: ACCEPTANCE_UID,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('explicit queue intent: duplicate same-turn recommendArtifact calls converge to exactly one pending recommendation', async () => {
    const envelope = await postChat(EXPLICIT_QUEUE_TURN);

    expect(envelope.success).toBe(true);
    const recommendCalls = (envelope.toolCalls ?? []).filter((call) => call.name === 'recommendArtifact');
    expect(recommendCalls).toHaveLength(2);
    for (const call of recommendCalls) {
      expect(call.result.success).toBe(true);
    }

    const staged = await docsIn('proposedArtifacts');
    expect(staged).toHaveLength(1);
    expect(staged[0].data()).toMatchObject({
      artifactKind: 'report',
      title: 'Radar report: edge AI inference chips',
      status: 'pending',
      generationStatus: 'idle',
      sourceUserId: ACCEPTANCE_UID,
    });

    // Queue ≠ generate: staging must not have produced any report.
    expect(await docsIn('reports')).toHaveLength(0);
    expect(recordedInngestEvents.filter((event) => event.name === 'app/artifact.generation.requested')).toHaveLength(0);
  });

  it('replaying the same explicit turn converges: created:false, still exactly one document', async () => {
    await postChat(EXPLICIT_QUEUE_TURN);
    const replay = await postChat(EXPLICIT_QUEUE_TURN);

    const recommendCalls = (replay.toolCalls ?? []).filter((call) => call.name === 'recommendArtifact');
    expect(recommendCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of recommendCalls) {
      expect(call.result.success).toBe(true);
      expect(call.result.data).toMatchObject({ created: false });
    }

    expect(await docsIn('proposedArtifacts')).toHaveLength(1);
  });

  it('a vague request dispatches nothing: no tool call, no staged recommendation', async () => {
    const envelope = await postChat(VAGUE_TURN);

    expect(envelope.success).toBe(true);
    expect((envelope.toolCalls ?? []).filter((call) => call.name === 'recommendArtifact')).toHaveLength(0);
    expect(await docsIn('proposedArtifacts')).toHaveLength(0);
  });

  it('a model-authored prose suggestion dispatches nothing, even with a JSON-looking snippet in the text', async () => {
    const envelope = await postChat(SUGGEST_TURN);

    expect(envelope.success).toBe(true);
    expect(envelope.message).toContain('recommendArtifact');
    expect(envelope.toolCalls ?? []).toHaveLength(0);
    expect(await docsIn('proposedArtifacts')).toHaveLength(0);
    expect(await docsIn('reports')).toHaveLength(0);
  });

  it('explicit document link: two same-turn calls converge to one link, count increment, and graph handoff', async () => {
    const envelope = await postChat(DOC_LINK_TURN);

    expect(envelope.success).toBe(true);
    const linkCalls = (envelope.toolCalls ?? []).filter((call) => call.name === 'linkDocumentToEntity');
    expect(linkCalls).toHaveLength(2);
    expect(linkCalls.every((call) => call.result.success)).toBe(true);
    expect(linkCalls.map((call) => call.result.data?.created).sort()).toEqual([false, true]);

    const links = await docsIn('entityDocumentLinks');
    expect(links).toHaveLength(1);
    expect(links[0].data()).toMatchObject({
      entityType: 'company',
      entityId: 'comp-accept-1',
      documentId: 'doc-accept-1',
      relationshipType: 'documentation',
      aiSuggested: false,
      createdBy: ACCEPTANCE_UID,
    });

    // Canonical-service side effects: linked-entity count bump + Neo4j handoff.
    const documentDoc = await db.collection('documents').doc('doc-accept-1').get();
    expect(documentDoc.data()?.linkedEntityCount).toBe(1);
    const syncEvents = recordedInngestEvents.filter(
      (event) => event.name === 'app/entity-document-link.sync.requested'
    );
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0].data).toMatchObject({ operation: 'create', linkId: links[0].id });

    const replay = await postChat(DOC_LINK_TURN);
    const replayCalls = (replay.toolCalls ?? []).filter((call) => call.name === 'linkDocumentToEntity');
    expect(replayCalls).toHaveLength(2);
    expect(replayCalls.every((call) => call.result.success)).toBe(true);
    expect(replayCalls.every((call) => call.result.data?.created === false)).toBe(true);
    expect(await docsIn('entityDocumentLinks')).toHaveLength(1);
  });

  it('discovery-flavored link wording is refused by route-side authority even though the model calls the tool — zero links', async () => {
    const envelope = await postChat(DOC_LINK_SUGGEST_TURN);

    expect(envelope.success).toBe(true);
    const linkCalls = (envelope.toolCalls ?? []).filter((call) => call.name === 'linkDocumentToEntity');
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0].result.success).toBe(false);
    expect(linkCalls[0].result.error).toMatch(/not authorized/i);

    expect(await docsIn('entityDocumentLinks')).toHaveLength(0);
    expect(
      recordedInngestEvents.filter((event) => event.name === 'app/entity-document-link.sync.requested')
    ).toHaveLength(0);
  });
});
