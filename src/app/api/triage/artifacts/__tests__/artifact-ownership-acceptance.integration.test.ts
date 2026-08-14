/** @jest-environment node */

/**
 * SEC-011 / REPORT-005 acceptance — two-user artifact-recommendation isolation
 * and CREATE-report execution truth through the REAL triage routes, the REAL
 * proposed-artifacts/missions/reports services, and a REAL disposable
 * Firestore emulator. Only identity (`getAuthenticatedUser`), the AI client
 * (zero live spend), and the Inngest transport are stubbed.
 *
 * Proof matrix:
 *  1. list isolation — each user's inbox lists exactly their recommendations;
 *  2. ID-enumeration denial — approve/reject/dismiss on a foreign id return
 *     byte-identical status+body to a genuinely absent id, dispatch nothing,
 *     and leave the foreign proposal untouched (zero cross-user dispatch);
 *  3. execution truth — the owner's approval + generation produce ONE real
 *     mission (owned by the proposal's sourceUserId) and ONE private
 *     schema-valid report whose outputRef is the authenticated /reports/{id};
 *  4. replay convergence — re-delivering the generation event creates no
 *     second mission/report and spends no AI budget;
 *  5. ownerless legacy denial — invisible in every list, mutations deny
 *     identically to absent, generation refuses to run it.
 *
 * Guarded: runs only under the emulator invocation below; the ordinary jest
 * lane skips it.
 *
 *   ARTIFACT_OWNERSHIP_ACCEPTANCE_DISPOSABLE=true RADARIST_GRAPH_RUNTIME_MODE=disabled NEO4J_URI= \
 *     npx firebase emulators:exec --config firebase.artifact-ownership-acceptance.json \
 *     --only firestore --project demo-artifact-ownership \
 *     "NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-artifact-ownership \
 *      GCLOUD_PROJECT=demo-artifact-ownership GOOGLE_CLOUD_PROJECT=demo-artifact-ownership \
 *      npx jest src/app/api/triage/artifacts/__tests__/artifact-ownership-acceptance.integration.test.ts --runInBand --coverage=false"
 */

const ALICE = 'acceptance-alice';
const BOB = 'acceptance-bob';

const runAcceptance =
  process.env.ARTIFACT_OWNERSHIP_ACCEPTANCE_DISPOSABLE === 'true' &&
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
  process.env.FIRESTORE_EMULATOR_HOST.length > 0;
const describeAcceptance = runAcceptance ? describe : describe.skip;

// ---------------------------------------------------------------------------
// REAL admin Firestore against the disposable emulator (established pattern:
// report-trust-acceptance) — generated throwaway RSA credential;
// FIRESTORE_EMULATOR_HOST routes all traffic to the emulator.
// ---------------------------------------------------------------------------
jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-artifact-ownership';
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
    `artifact-ownership-acceptance-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { __esModule: true, adminApp, db: firestore, adminAuth: {} };
});

// Identity: mutable so the suite can act as Alice, then Bob.
let currentUid = ALICE;
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn(async () => ({
    authenticated: true as const,
    uid: currentUid,
    email: `${currentUid}@test.local`,
  })),
}));

// Inngest transport — the approval route dispatches through it; the worker is
// invoked directly below instead of through an Inngest runtime.
const inngestSend = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    send: (...a: unknown[]) => inngestSend(...a),
    createFunction: (_c: unknown, _t: unknown, h: unknown) => h,
  },
  safeSendEvent: jest.fn(async () => ({ ok: true })),
}));

// Discovery-feedback wire (best-effort in the route) — not under test.
jest.mock('@/lib/discovery/discovery-feedback', () => ({
  __esModule: true,
  recordProposalFeedback: jest.fn(async () => undefined),
}));
jest.mock('@/lib/deep-research-document-admin', () => ({
  __esModule: true,
  dispatchDeepResearchDocument: jest.fn(),
}));

// AI client — ZERO live spend anywhere in this suite.
const STATIC_HTML =
  '<!DOCTYPE html><html><body><h1>AI agents landscape</h1><p>Static publishable acceptance body.</p></body></html>';
const generateContent = jest.fn(async () => STATIC_HTML);
jest.mock('@/lib/ai/client', () => ({ __esModule: true, generateContent }));

import { NextRequest } from 'next/server';

jest.setTimeout(120_000);

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:9002${url}`, {
    method,
    headers: { Authorization: 'Bearer acceptance-token', 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

const LEGACY_ID = 'artifact-legacy-acceptance';
const ABSENT_ID = 'artifact-does-not-exist';

describeAcceptance(
  'artifact-recommendation acceptance — two-user isolation + execution truth (real routes, real Firestore)',
  () => {
    let db: FirebaseFirestore.Firestore;
    let listGET: (req: NextRequest) => Promise<Response>;
    let resolvePOST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
    let runArtifactGeneration: (id: string, requestedBy: string) => Promise<void>;
    let createProposedArtifactIfNotExists: (input: Record<string, unknown>) => Promise<{ entity: { id: string } }>;

    let aliceProposalId = '';
    let bobProposalId = '';

    const docsIn = async (collection: string) => (await db.collection(collection).get()).docs.map((d) => d.data());

    beforeAll(async () => {
      db = (jest.requireMock('@/lib/firebase-admin') as { db: FirebaseFirestore.Firestore }).db;
      ({ GET: listGET } = require('../route'));
      ({ POST: resolvePOST } = require('../[id]/route'));
      ({ runArtifactGeneration } = require('@/lib/inngest/functions/generate-recommended-artifact'));
      ({ createProposedArtifactIfNotExists } = require('@/lib/proposed-artifacts-admin'));

      // Seed: one recommendation per user (real create path), plus an
      // ownerless legacy doc written the way pre-SEC-011 code left them.
      ({
        entity: { id: aliceProposalId },
      } = await createProposedArtifactIfNotExists({
        artifactKind: 'report',
        title: 'AI agents landscape',
        rationale: 'acceptance: alice recommendation',
        scope: { entityIds: [] },
        sourceUserId: ALICE,
      }));
      ({
        entity: { id: bobProposalId },
      } = await createProposedArtifactIfNotExists({
        artifactKind: 'report',
        title: 'Quantum brief',
        rationale: 'acceptance: bob recommendation',
        scope: { entityIds: [] },
        sourceUserId: BOB,
      }));
      await db
        .collection('proposedArtifacts')
        .doc(LEGACY_ID)
        .set({
          id: LEGACY_ID,
          artifactKind: 'report',
          title: 'Legacy ownerless recommendation',
          status: 'pending',
          generationStatus: 'idle',
          scope: { entityIds: [] },
          matchedTopics: [],
          params: {},
          confidence: 70,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
    });

    beforeEach(() => {
      inngestSend.mockClear();
      generateContent.mockClear();
    });

    it('1. list isolation — each user sees exactly their own recommendations, never the legacy doc', async () => {
      currentUid = ALICE;
      const aliceRes = await listGET(jsonRequest('/api/triage/artifacts?status=pending', 'GET'));
      const aliceRows = (await aliceRes.json()).artifacts as Array<{ id: string }>;
      expect(aliceRes.status).toBe(200);
      expect(aliceRows.map((a) => a.id)).toEqual([aliceProposalId]);

      currentUid = BOB;
      const bobRes = await listGET(jsonRequest('/api/triage/artifacts?status=pending', 'GET'));
      const bobRows = (await bobRes.json()).artifacts as Array<{ id: string }>;
      expect(bobRows.map((a) => a.id)).toEqual([bobProposalId]);
    });

    it('2. foreign, absent, and legacy ids are indistinguishable on every mutation — and dispatch nothing', async () => {
      currentUid = BOB;
      for (const action of ['approve', 'reject', 'dismiss'] as const) {
        const foreign = await resolvePOST(
          jsonRequest(`/api/triage/artifacts/${aliceProposalId}`, 'POST', { action }),
          params({ id: aliceProposalId })
        );
        const absent = await resolvePOST(
          jsonRequest(`/api/triage/artifacts/${ABSENT_ID}`, 'POST', { action }),
          params({ id: ABSENT_ID })
        );
        const legacy = await resolvePOST(
          jsonRequest(`/api/triage/artifacts/${LEGACY_ID}`, 'POST', { action }),
          params({ id: LEGACY_ID })
        );

        expect(foreign.status).toBe(404);
        expect(absent.status).toBe(404);
        expect(legacy.status).toBe(404);
        const [fBody, aBody, lBody] = [await foreign.text(), await absent.text(), await legacy.text()];
        expect(fBody).toBe(aBody);
        expect(lBody).toBe(aBody);
      }
      expect(inngestSend).not.toHaveBeenCalled();

      const aliceDoc = (await db.collection('proposedArtifacts').doc(aliceProposalId).get()).data() as {
        status: string;
      };
      expect(aliceDoc.status).toBe('pending');
    });

    it('3. the owner approves and generation mints ONE owned mission + ONE private report', async () => {
      currentUid = ALICE;
      const res = await resolvePOST(
        jsonRequest(`/api/triage/artifacts/${aliceProposalId}`, 'POST', { action: 'approve' }),
        params({ id: aliceProposalId })
      );
      expect(res.status).toBe(200);
      expect(inngestSend).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/artifact.generation.requested' }));
      expect(inngestSend).toHaveBeenCalledTimes(1);

      // An idempotent re-approve (double-click / retried request) must not
      // dispatch a second generation event.
      const again = await resolvePOST(
        jsonRequest(`/api/triage/artifacts/${aliceProposalId}`, 'POST', { action: 'approve' }),
        params({ id: aliceProposalId })
      );
      expect(again.status).toBe(200);
      expect(inngestSend).toHaveBeenCalledTimes(1);

      await runArtifactGeneration(aliceProposalId, ALICE);

      const missions = await docsIn('missions');
      const reports = await docsIn('reports');
      expect(missions).toHaveLength(1);
      expect(reports).toHaveLength(1);
      const mission = missions[0] as Record<string, unknown>;
      const report = reports[0] as Record<string, unknown>;
      expect(mission.userId).toBe(ALICE);
      expect(mission.status).toBe('completed');
      expect(report.missionId).toBe(mission.id);
      expect(report.ownerId).toBe(ALICE);
      expect(report.createdBy).toBe('agent');
      expect(report.shared).toBe(false);

      const proposal = (await db.collection('proposedArtifacts').doc(aliceProposalId).get()).data() as {
        generationStatus: string;
        outputRef: { url: string };
        executionMissionId: string;
      };
      expect(proposal.generationStatus).toBe('ready');
      expect(proposal.outputRef.url).toBe(`/reports/${report.id as string}`);
      expect(proposal.executionMissionId).toBe(mission.id);
    });

    it('4. replaying the generation event converges — one mission, one report, zero extra AI spend', async () => {
      await runArtifactGeneration(aliceProposalId, ALICE);
      await runArtifactGeneration(aliceProposalId, ALICE);

      expect(await docsIn('missions')).toHaveLength(1);
      expect(await docsIn('reports')).toHaveLength(1);
      expect(generateContent).not.toHaveBeenCalled();
    });

    it('5. an approved-then-orphaned legacy proposal cannot execute (no owner → failed, no report)', async () => {
      // Force the legacy doc into the state a replayed pre-SEC-011 approval
      // would present: approved + generating, still ownerless.
      await db
        .collection('proposedArtifacts')
        .doc(LEGACY_ID)
        .update({ status: 'approved', generationStatus: 'generating' });

      await runArtifactGeneration(LEGACY_ID, BOB);

      const legacy = (await db.collection('proposedArtifacts').doc(LEGACY_ID).get()).data() as {
        generationStatus: string;
        generationError?: string;
      };
      expect(legacy.generationStatus).toBe('failed');
      expect(legacy.generationError).toContain('no owner');
      // Still exactly the one report from Alice's approval — nothing for Bob/legacy.
      expect(await docsIn('reports')).toHaveLength(1);
      expect(generateContent).not.toHaveBeenCalled();
    });
  }
);
