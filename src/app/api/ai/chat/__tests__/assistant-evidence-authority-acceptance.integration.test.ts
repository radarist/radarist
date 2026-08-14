/** @jest-environment node */

/**
 * AI-039 / AI-040 acceptance — the Assistant's batch relation plans and its
 * Signal links, proven through the REAL chat route against a REAL disposable
 * Firestore.
 *
 * Vehicle: the TEST-017 deterministic provider seam. The real
 * `@google/generative-ai` SDK talks to the in-process loopback Gemini stub
 * (`scripts/testing/gemini-chat-stub-server.ts`), so the journey is authenticated
 * and end-to-end at ZERO provider spend. The real route, tool loop, executors,
 * relation-write authority grammar, Admin services and Firestore all run
 * unmocked. Only identity, Inngest transport and prompt-enrichment side channels
 * are stubbed — none of them is what this suite proves.
 *
 * The two failure shapes:
 *
 *  - AI-039 — a multi-line relation request can exhaust its tool loop with only
 *    some links written and no receipt saying which.
 *  - AI-040 — `createSignal` accepted exact `linkedEntityNames` and persisted
 *    `linkedEntities: []`, because its resolver reached the Firebase Web SDK
 *    server-side and the `asyncQueue` rejection was swallowed three layers deep.
 *
 * Proof matrix:
 *  1. the whole bundle is ONE `createRelations` call; three curated relations
 *     land in Firestore with resolved ids and three graph handoffs fire.
 *  2. replaying the same turn converges — still three relations, no duplicates.
 *  3. a MALFORMED plan (a repeated pair) authorizes NOTHING: zero relations,
 *     zero handoffs, and a `noMutation` proof rather than a partial application.
 *  4. an explicit Signal creation persists every named link as a resolved id,
 *     returns the resolved identities, and hands the signal off to the graph.
 *  5. an unresolvable name refuses the WHOLE write: zero signals.
 *
 * Scope boundary: this lane runs Firestore only. The graph-side halves —
 * GRAPH-063 endpoint resolution and GRAPH-064 mention trust / graph-first
 * retrieval — need real Neo4j and are proven in
 * `src/lib/graph/__tests__/graph-trust-boundaries.integration.test.ts`
 * (`npm run test:integration:graph-trust-boundaries`).
 *
 * Guarded: runs only under `npm run test:acceptance:assistant-evidence`
 * (ASSISTANT_EVIDENCE_ACCEPTANCE_DISPOSABLE=true + a live Firestore emulator);
 * the ordinary jest lane skips it.
 */

const ACCEPTANCE_PROJECT_ID = 'demo-assistant-evidence';

const runAcceptance =
  process.env.ASSISTANT_EVIDENCE_ACCEPTANCE_DISPOSABLE === 'true' &&
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
  process.env.FIRESTORE_EMULATOR_HOST.length > 0;
const describeAcceptance = runAcceptance ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Client-SDK import chain breakers — the route and the tool barrel transitively
// import client modules that must not initialize a real client SDK here. AI-040's
// whole root cause was a server-side reach into these, so a passing suite must
// mean the ADMIN twins did the work.
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
jest.mock('firebase/auth', () => ({ __esModule: true, getAuth: jest.fn(() => ({})), connectAuthEmulator: jest.fn() }));
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
jest.mock('@/lib/events/data-refresh', () => ({ __esModule: true, emitDataRefresh: jest.fn() }));

// REAL admin Firestore against the disposable emulator.
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-assistant-evidence';
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
    `assistant-evidence-acceptance-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { __esModule: true, adminApp, db: firestore, adminAuth: {} };
});

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn(async () => ({
    authenticated: true as const,
    uid: 'acceptance-user-1',
    email: 'acceptance@test.local',
  })),
}));

// Inngest transport: recorded, not delivered. The graph handoffs are asserted at
// this boundary — a write with no handoff is an unconverged write.
const recordedInngestEvents: Array<{ id?: string; name: string; data: Record<string, unknown> }> = [];
const recordInngest = jest.fn(async (event: { id?: string; name: string; data: Record<string, unknown> }) => {
  recordedInngestEvents.push(event);
  return { ids: ['recorded'] };
});
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    send: (event: { id?: string; name: string; data: Record<string, unknown> }) => recordInngest(event),
    createFunction: jest.fn((config: unknown, trigger: unknown, handler: unknown) => ({ config, trigger, handler })),
  },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  __esModule: true,
  inngest: { send: (event: { id?: string; name: string; data: Record<string, unknown> }) => recordInngest(event) },
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
jest.mock('@/lib/graph/episodes', () => ({ __esModule: true, createEpisode: jest.fn(async () => ({ id: 'ep-acc' })) }));
jest.mock('@/lib/agent-events', () => ({ __esModule: true, emitAgentEvent: jest.fn(async () => undefined) }));
jest.mock('@/lib/graph/agent-run-sync', () => ({
  __esModule: true,
  syncAgentRunToNeo4j: jest.fn(async () => undefined),
}));

import { NextRequest } from 'next/server';
import { startGeminiChatStub, type GeminiChatStub } from '../../../../../../scripts/testing/gemini-chat-stub-server';

jest.setTimeout(180_000);

describeAcceptance('assistant evidence + authority acceptance — batch relations and signal links', () => {
  let stub: GeminiChatStub;
  let db: FirebaseFirestore.Firestore;
  let POST: (request: NextRequest) => Promise<Response>;

  const FIXTURES = {
    companyId: 'comp-evid-1',
    companyName: 'Acme Robotics',
    technologyId: 'tech-evid-1',
    technologyName: 'Quantum Mesh',
    strategyId: 'strategy-evid-1',
    strategyName: 'Digital First',
    orgUnitId: 'org-evid-1',
    orgUnitName: 'Retail Operations',
    useCaseId: 'uc-evid-1',
    useCaseName: 'Self-Service Checkout',
    painPointId: 'pp-evid-1',
    painPointName: 'Long Queue Times',
    unresolvableEntityName: 'Nonexistent Holdings',
  };

  /**
   * The operator's retained multi-line bundle directive. Each pair is named and
   * instructed in its own imperative clause — the SAME per-pair authority
   * evidence `createRelation` requires, expressed once for the whole bundle.
   */
  const BUNDLE_TURN = [
    'Link the strategy bundle now.',
    `Link ${FIXTURES.strategyName} to ${FIXTURES.orgUnitName}.`,
    `Link ${FIXTURES.strategyName} to ${FIXTURES.useCaseName}.`,
    `Link ${FIXTURES.strategyName} to ${FIXTURES.painPointName}.`,
  ].join('\n');

  const MALFORMED_BUNDLE_TURN = [
    'Link the strategy bundle twice now.',
    `Link ${FIXTURES.strategyName} to ${FIXTURES.orgUnitName}.`,
    `Link ${FIXTURES.strategyName} to ${FIXTURES.useCaseName}.`,
    `Link ${FIXTURES.strategyName} to ${FIXTURES.painPointName}.`,
  ].join('\n');

  const SIGNAL_TURN =
    `File a signal about the ${FIXTURES.technologyName} rollout, ` +
    `linked to ${FIXTURES.companyName} and ${FIXTURES.technologyName}.`;

  const SIGNAL_UNRESOLVABLE_TURN =
    `File a signal about the ${FIXTURES.technologyName} rollout, ` +
    `linked to ${FIXTURES.companyName} and ${FIXTURES.unresolvableEntityName}.`;

  function chatRequest(message: string): NextRequest {
    return new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message, context: { currentRoute: '/dashboard', currentPage: 'Dashboard' } }),
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
      result: {
        success: boolean;
        data?: Record<string, unknown>;
        error?: string;
        noMutation?: { stage?: string };
      };
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

  function callsNamed(envelope: ChatEnvelope, name: string) {
    return (envelope.toolCalls ?? []).filter((call) => call.name === name);
  }

  function relationSyncEvents() {
    return recordedInngestEvents.filter((event) => event.name === 'app/relation.sync.requested');
  }

  beforeAll(async () => {
    stub = await startGeminiChatStub({ fixtures: FIXTURES });
    process.env.GEMINI_TEST_BASE_URL = stub.url;
    process.env.GEMINI_API_KEY = 'acceptance-test-key';
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = ACCEPTANCE_PROJECT_ID;
    delete process.env.CLAUDE_CHAT_ENABLED;

    ({ POST } = require('../route'));
    ({ db } = require('@/lib/firebase-admin'));
  });

  afterAll(async () => {
    await stub.close();
    delete process.env.GEMINI_TEST_BASE_URL;
  });

  beforeEach(async () => {
    recordedInngestEvents.length = 0;
    // Canonical collection ids — `use-cases` and `org-units` are hyphenated, and
    // a fixture in the wrong collection is silently "not found" rather than an
    // error, so these names are load-bearing.
    for (const collection of [
      'relations',
      'proposedRelations',
      'signals',
      'companies',
      'technologies',
      'strategies',
      'org-units',
      'use-cases',
      'painPoints',
    ]) {
      await purge(collection);
    }

    const now = Date.now();
    // Audit fields are epoch milliseconds, NOT Firestore Timestamps: the domain
    // read schemas parse them as numbers.
    const base = { createdAt: now, updatedAt: now };
    await db
      .collection('companies')
      .doc(FIXTURES.companyId)
      .set({ ...base, id: FIXTURES.companyId, name: FIXTURES.companyName, slug: 'acme-robotics', status: 'active' });
    await db
      .collection('technologies')
      .doc(FIXTURES.technologyId)
      .set({
        ...base,
        id: FIXTURES.technologyId,
        name: FIXTURES.technologyName,
        slug: 'quantum-mesh',
        status: 'active',
      });
    await db
      .collection('strategies')
      .doc(FIXTURES.strategyId)
      .set({ ...base, id: FIXTURES.strategyId, name: FIXTURES.strategyName, slug: 'digital-first' });
    await db
      .collection('org-units')
      .doc(FIXTURES.orgUnitId)
      .set({ ...base, id: FIXTURES.orgUnitId, name: FIXTURES.orgUnitName, slug: 'retail-operations' });
    // Use cases and pain points carry their display name in `title`, not `name` —
    // `searchEntityCandidatesByName` reads exactly that field per type.
    await db
      .collection('use-cases')
      .doc(FIXTURES.useCaseId)
      .set({ ...base, id: FIXTURES.useCaseId, title: FIXTURES.useCaseName, slug: 'self-service-checkout' });
    // The pain-point read schema is exhaustive (`storedPainPointSchema`), so this
    // fixture has to be a real record, not a name stub.
    await db
      .collection('painPoints')
      .doc(FIXTURES.painPointId)
      .set({
        ...base,
        id: FIXTURES.painPointId,
        title: FIXTURES.painPointName,
        slug: 'long-queue-times',
        description: 'Checkout queues exceed five minutes at peak.',
        severity: 'high',
        category: 'operational',
        status: 'identified',
      });
  });

  // =========================================================================
  // AI-039 — the bundle in one bounded call
  // =========================================================================

  it('links the whole strategy bundle in ONE createRelations call with resolved ids and graph handoffs', async () => {
    const envelope = await postChat(BUNDLE_TURN);
    expect(envelope.success).toBe(true);

    // ONE tool call for the whole bundle — the property the row exists for.
    const batchCalls = callsNamed(envelope, 'createRelations');
    expect(batchCalls).toHaveLength(1);
    expect(callsNamed(envelope, 'createRelation')).toHaveLength(0);
    // On failure the receipts carry the exact per-item reason — surface them in
    // the assertion message rather than a bare `false`, which is the whole point
    // of the receipt contract.
    if (!batchCalls[0].result.success) {
      throw new Error(`createRelations refused the authorized bundle: ${JSON.stringify(batchCalls[0].result)}`);
    }
    expect(batchCalls[0].result.data).toMatchObject({ requested: 3, linked: 3, refused: 0 });

    // One receipt per requested relation, so the operator is never left guessing.
    const receipts = batchCalls[0].result.data?.receipts as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['created', 'created', 'created']);

    // Real Firestore: three curated Class A edges with the RESOLVED endpoint ids.
    const relations = await docsIn('relations');
    expect(relations).toHaveLength(3);
    const pairs = relations
      .map((doc) => doc.data())
      .map((data) => [
        (data.sourceSnapshot as { id: string }).id,
        (data.targetSnapshot as { id: string }).id,
        data.relationType,
      ])
      .sort((left, right) => String(left[1]).localeCompare(String(right[1])));
    expect(pairs).toEqual(
      [
        [FIXTURES.strategyId, FIXTURES.orgUnitId, 'custom'],
        [FIXTURES.strategyId, FIXTURES.painPointId, 'custom'],
        [FIXTURES.strategyId, FIXTURES.useCaseId, 'custom'],
      ].sort((left, right) => String(left[1]).localeCompare(String(right[1])))
    );
    for (const doc of relations) {
      expect(doc.data()).toMatchObject({ claimStatus: 'curated', aiSuggested: false, confidence: 100 });
    }

    // Every write handed off for graph convergence.
    expect(relationSyncEvents()).toHaveLength(3);
  });

  it('replaying the bundle turn converges — still three relations, no duplicates', async () => {
    await postChat(BUNDLE_TURN);
    recordedInngestEvents.length = 0;

    const replay = await postChat(BUNDLE_TURN);
    const batchCalls = callsNamed(replay, 'createRelations');
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].result.success).toBe(true);
    expect(batchCalls[0].result.data).toMatchObject({ requested: 3, refused: 0 });

    // Convergence, not accumulation.
    expect(await docsIn('relations')).toHaveLength(3);
  });

  it('a malformed plan authorizes NOTHING — zero relations, zero handoffs, a no-mutation proof', async () => {
    const envelope = await postChat(MALFORMED_BUNDLE_TURN);
    expect(envelope.success).toBe(true);

    const batchCalls = callsNamed(envelope, 'createRelations');
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].result.success).toBe(false);
    // Refused WHOLE, and provably before any write — not "the first three landed".
    expect(batchCalls[0].result.noMutation).toBeDefined();
    expect(batchCalls[0].result.error).toMatch(/same pair|duplicate|repeat/i);

    expect(await docsIn('relations')).toHaveLength(0);
    expect(relationSyncEvents()).toHaveLength(0);
  });

  // =========================================================================
  // AI-040 — Signal links resolve through the Admin boundary
  // =========================================================================

  it('persists every named Signal link as a resolved id and returns the resolved identities', async () => {
    const envelope = await postChat(SIGNAL_TURN);
    expect(envelope.success).toBe(true);

    const signalCalls = callsNamed(envelope, 'createSignalManual');
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0].result.success).toBe(true);

    // The caller never has to assume the links landed.
    const resolved = signalCalls[0].result.data?.linkedEntities as Array<Record<string, unknown>>;
    expect(resolved).toHaveLength(2);
    expect(resolved.map((entry) => entry.id).sort()).toEqual([FIXTURES.companyId, FIXTURES.technologyId].sort());
    expect(resolved.map((entry) => entry.kind).sort()).toEqual(['company', 'technology']);

    // Real Firestore: the live defect persisted `linkedEntities: []` here.
    const signals = await docsIn('signals');
    expect(signals).toHaveLength(1);
    const linkedEntities = signals[0].data().linkedEntities as { companies?: string[]; technologies?: string[] };
    expect(linkedEntities.companies).toEqual([FIXTURES.companyId]);
    expect(linkedEntities.technologies).toEqual([FIXTURES.technologyId]);

    // Handed off for graph convergence — a linked signal that never syncs is not
    // steering anything.
    const entitySyncEvents = recordedInngestEvents.filter(
      (event) => event.name === 'app/unified-entity.sync.requested'
    );
    expect(entitySyncEvents.length).toBeGreaterThanOrEqual(1);
    expect(entitySyncEvents.some((event) => event.data.entityId === signals[0].id)).toBe(true);
  });

  it('refuses the WHOLE signal write when one named entity resolves to nothing', async () => {
    const envelope = await postChat(SIGNAL_UNRESOLVABLE_TURN);
    expect(envelope.success).toBe(true);

    const signalCalls = callsNamed(envelope, 'createSignalManual');
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0].result.success).toBe(false);
    expect(signalCalls[0].result.noMutation).toBeDefined();
    // The refusal names exactly which name failed, so the operator can fix it.
    expect(signalCalls[0].result.error).toContain(FIXTURES.unresolvableEntityName);

    // All-or-nothing: no signal with silently-dropped links.
    expect(await docsIn('signals')).toHaveLength(0);
  });
});
