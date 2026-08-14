/** @jest-environment node */

/**
 * OBS-007 / ARUN-027 real-accounting acceptance for the Background
 * Verifications activity facet.
 *
 * Runs the real `/api/activity/defense-verifications` route against a real,
 * disposable Firestore emulator on shifted ports. This file deliberately does
 * NOT mock the operation-receipt / accounting-marker / settlement repositories;
 * it writes real Firestore documents through them and asserts the resulting
 * cost/scope truth. Graph lookups remain mocked because this lane has no
 * disposable Neo4j target.
 *
 * Run with:
 *   DEFENSE_VERIFICATIONS_ACCEPTANCE_DISPOSABLE=true \
 *   npx firebase emulators:exec --config firebase.defense-verifications-acceptance.json \
 *     --only firestore --project demo-defense-verifications \
 *     "NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-defense-verifications \
 *      GCLOUD_PROJECT=demo-defense-verifications GOOGLE_CLOUD_PROJECT=demo-defense-verifications \
 *      FIRESTORE_EMULATOR_HOST=127.0.0.1:20390 \
 *      npx jest src/app/api/activity/defense-verifications/__tests__/defense-verifications-real-accounting.integration.test.ts --runInBand --coverage=false"
 */

import { NextRequest } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import type { CreateOperationReceiptInput } from '@/lib/schemas/operation-receipt';
import { recordOperationReceipt } from '@/lib/operation-receipt-repository';
import { upsertParentAccountingMarker } from '@/lib/operation-accounting-marker-repository';
import { recordOperationSettlement } from '@/lib/operation-settlement-repository';
import { getVerificationForEntity } from '@/lib/graph/verification';
import { getVerificationForEdge } from '@/lib/activity/defense-verification-graph';

const OPERATOR = 'acceptance-operator';
const FOREIGNER = 'foreigner-operator';

const runAcceptance =
  process.env.DEFENSE_VERIFICATIONS_ACCEPTANCE_DISPOSABLE === 'true' &&
  typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
  process.env.FIRESTORE_EMULATOR_HOST.length > 0;
const describeAcceptance = runAcceptance ? describe : describe.skip;

jest.mock('@/lib/firebase-admin', () => {
  const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const { cert, initializeApp } = jest.requireActual<typeof import('firebase-admin/app')>('firebase-admin/app');
  const { getFirestore, Timestamp } = jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-defense-verifications';
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
    `defense-verifications-real-accounting-${process.pid}`
  );
  const firestore = getFirestore(adminApp);
  firestore.settings({ preferRest: true });
  return { __esModule: true, adminApp, db: firestore, adminAuth: {}, Timestamp };
});

let currentUid = OPERATOR;
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn(async () => ({
    authenticated: true as const,
    uid: currentUid,
    email: `${currentUid}@test.local`,
  })),
}));

jest.mock('@/lib/graph/verification', () => ({
  getVerificationForEntity: jest.fn(),
}));

jest.mock('@/lib/activity/defense-verification-graph', () => ({
  getVerificationForEdge: jest.fn(),
}));

jest.setTimeout(120_000);

function request(url: string, uid = OPERATOR): NextRequest {
  currentUid = uid;
  return new NextRequest(`http://localhost:9002${url}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer acceptance-token' },
  });
}

function makeJobDoc(opts: {
  id: string;
  functionId: 'verify-entity' | 'verify-edge';
  status: string;
  startedAt: number;
  output?: Record<string, unknown>;
}) {
  const { Timestamp } = jest.requireMock('@/lib/firebase-admin') as {
    Timestamp: typeof import('firebase-admin/firestore').Timestamp;
  };
  return {
    id: opts.id,
    functionId: opts.functionId,
    functionName: opts.functionId,
    status: opts.status,
    startedAt: Timestamp.fromMillis(opts.startedAt),
    completedAt: Timestamp.fromMillis(opts.startedAt + 1000),
    retryCount: 0,
    output: opts.output ?? null,
  };
}

function receiptInput(jobId: string): CreateOperationReceiptInput {
  return {
    correlation: {
      parentType: 'verification',
      owner: 'user:system',
      correlationId: jobId,
      inngestRunId: jobId,
      verificationResultId: `vr-${jobId}`,
      entityId: 'entity-acceptance',
      entityType: 'companies',
    },
    operation: 'verify-entity.grounded-search',
    invocationId: `${jobId}-call`,
    attempt: 0,
    responseOrdinal: 0,
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    modelProvenance: 'provider-reported',
    counters: {
      promptTokens: 1200,
      outputTokens: 340,
      thinkingTokens: 50,
      cacheReadTokens: 800,
      queryCount: 2,
      imageCount: 0,
    },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-27T09:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
  };
}

async function clearCollections(db: Firestore) {
  const collections = ['job-runs', 'operationReceipts', 'operationAccountingMarkers', 'operationSettlements'];
  for (const name of collections) {
    let snap = await db.collection(name).limit(500).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      snap = await db.collection(name).limit(500).get();
    }
  }
}

describeAcceptance('OBS-007 / ARUN-027 — real Firestore accounting + visibility', () => {
  let db: Firestore;
  let GET: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    db = (jest.requireMock('@/lib/firebase-admin') as { db: Firestore }).db;
    ({ GET } = require('../route'));
  });

  beforeEach(async () => {
    currentUid = OPERATOR;
    jest.clearAllMocks();
    (getVerificationForEntity as jest.Mock).mockResolvedValue(null);
    (getVerificationForEdge as jest.Mock).mockResolvedValue(null);
    await clearCollections(db);
  });

  it('treats verification job-runs as global system activity independent of the authenticated user', async () => {
    await db.collection('job-runs').doc('global-run').set(
      makeJobDoc({
        id: 'global-run',
        functionId: 'verify-entity',
        status: 'completed',
        startedAt: 1000,
        output: { entityId: 'e-global', status: 'verified', score: 0.9 },
      })
    );

    const operatorRes = await GET(request('/api/activity/defense-verifications'));
    expect(operatorRes.status).toBe(200);
    const operatorBody = await operatorRes.json();
    expect(operatorBody.verifications.some((v: { id: string }) => v.id === 'global-run')).toBe(true);

    const foreignRes = await GET(request('/api/activity/defense-verifications', FOREIGNER));
    expect(foreignRes.status).toBe(200);
    const foreignBody = await foreignRes.json();
    expect(foreignBody.verifications.some((v: { id: string }) => v.id === 'global-run')).toBe(true);
  });

  it('derives an estimated cost from a real operation receipt', async () => {
    const jobId = 'real-receipt-run';
    await db.collection('job-runs').doc(jobId).set(
      makeJobDoc({
        id: jobId,
        functionId: 'verify-entity',
        status: 'completed',
        startedAt: 2000,
        output: { entityId: 'e-real', status: 'verified', score: 0.9 },
      })
    );
    (getVerificationForEntity as jest.Mock).mockResolvedValue({
      id: `vr-${jobId}`,
      entityId: 'e-real',
      status: 'verified',
      score: 0.9,
    });
    const receipt = await recordOperationReceipt(receiptInput(jobId));
    expect(receipt.schemaVersion).toBe(2);

    const res = await GET(request('/api/activity/defense-verifications'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === jobId);
    expect(row).toBeDefined();
    expect(row.cost.state).toBe('estimated');
    expect(row.providers).toContain('gemini');
    expect(row.models).toContain('gemini-3.5-flash');
    expect(row.resultId).toBe(`vr-${jobId}`);
  });

  it('surfaces incomplete accounting from a real marker with unresolved loss', async () => {
    const jobId = 'incomplete-marker-run';
    await db.collection('job-runs').doc(jobId).set(
      makeJobDoc({
        id: jobId,
        functionId: 'verify-entity',
        status: 'completed',
        startedAt: 3000,
        output: { entityId: 'e-incomplete', status: 'verified', score: 0.9 },
      })
    );
    await recordOperationReceipt(receiptInput(jobId));
    await upsertParentAccountingMarker({
      owner: 'user:system',
      parentType: 'verification',
      correlationId: jobId,
      batchId: 'batch-1',
      expected: 2,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 1,
      occurredAt: '2026-07-27T09:00:00.000Z',
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === jobId);
    expect(row).toBeDefined();
    expect(row.cost.state).toBe('incomplete');
    expect(row.partialReason).toBe('incomplete-accounting');
  });

  it('surfaces a settled cost from a real receipt plus settlement', async () => {
    const jobId = 'settled-run';
    await db.collection('job-runs').doc(jobId).set(
      makeJobDoc({
        id: jobId,
        functionId: 'verify-entity',
        status: 'completed',
        startedAt: 4000,
        output: { entityId: 'e-settled', status: 'verified', score: 0.9 },
      })
    );
    (getVerificationForEntity as jest.Mock).mockResolvedValue({
      id: `vr-${jobId}`,
      entityId: 'e-settled',
      status: 'verified',
      score: 0.9,
    });
    const receipt = await recordOperationReceipt(receiptInput(jobId));
    await recordOperationSettlement({
      owner: 'user:system',
      receiptId: receipt.id,
      actualAmountMicros: 5_000_000,
      currency: 'USD',
      covers: 'tokens',
      evidenceRef: 'invoice-001',
      occurredAt: '2026-07-27T10:00:00.000Z',
      revision: 0,
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === jobId);
    expect(row).toBeDefined();
    expect(row.cost.state).toBe('settled');
    expect(row.cost.amountMicros).toBe(5_000_000);
  });

  it('paginates with a status filter and never skips a later filtered page', async () => {
    // Six entity runs; only every third one is completed. limit=1 and two
    // pages should each return exactly one completed run, proving the filtered
    // cursor advances through the raw stream instead of stopping early.
    const runIds = Array.from({ length: 6 }, (_, i) => `page-run-${i}`);
    for (let i = 0; i < runIds.length; i += 1) {
      await db.collection('job-runs').doc(runIds[i]).set(
        makeJobDoc({
          id: runIds[i],
          functionId: 'verify-entity',
          status: i % 3 === 0 ? 'completed' : 'failed',
          startedAt: 10_000 - i * 1000,
          output: { entityId: `e-${i}`, status: 'verified', score: 0.9 },
        })
      );
    }

    const first = await GET(request('/api/activity/defense-verifications?status=completed&limit=1'));
    const firstBody = await first.json();
    expect(firstBody.verifications).toHaveLength(1);
    expect(firstBody.verifications[0].status).toBe('completed');
    expect(firstBody.nextCursor).toBeTruthy();

    const completedIds = new Set([firstBody.verifications[0].id]);
    const second = await GET(
      request(`/api/activity/defense-verifications?status=completed&limit=1&cursor=${firstBody.nextCursor}`)
    );
    const secondBody = await second.json();
    expect(secondBody.verifications).toHaveLength(1);
    expect(secondBody.verifications[0].status).toBe('completed');
    completedIds.add(secondBody.verifications[0].id);

    // A third page walks off the end of the raw stream and returns nothing.
    const third = await GET(
      request(`/api/activity/defense-verifications?status=completed&limit=1&cursor=${secondBody.nextCursor}`)
    );
    const thirdBody = await third.json();
    expect(thirdBody.verifications).toHaveLength(0);
    expect(thirdBody.nextCursor).toBeNull();

    expect(completedIds).toEqual(new Set(['page-run-0', 'page-run-3']));
  });
});
