/** @jest-environment node */

/**
 * OBS-007 disposable Firestore emulator acceptance for the Background
 * Verifications facet.
 *
 * Runs the real `/api/activity/defense-verifications` route against a real,
 * disposable Firestore emulator on shifted ports. Authentication and the
 * accounting/graph dependencies are stubbed so the test isolates the JobRun
 * storage, auth-first gating, and owner-scoped join wiring.
 *
 * Run with:
 *   DEFENSE_VERIFICATIONS_ACCEPTANCE_DISPOSABLE=true \
 *   npx firebase emulators:exec --config firebase.defense-verifications-acceptance.json \
 *     --only firestore --project demo-defense-verifications \
 *     "NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-defense-verifications \
 *      GCLOUD_PROJECT=demo-defense-verifications GOOGLE_CLOUD_PROJECT=demo-defense-verifications \
 *      FIRESTORE_EMULATOR_HOST=127.0.0.1:20390 \
 *      npx jest src/app/api/activity/defense-verifications/__tests__/defense-verifications-acceptance.integration.test.ts --runInBand --coverage=false"
 */

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
  const { getFirestore, Timestamp } =
    jest.requireActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
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
    `defense-verifications-acceptance-${process.pid}`
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

jest.mock('@/lib/operation-receipt-repository', () => ({
  listOperationReceiptsByCorrelation: jest.fn(),
}));

jest.mock('@/lib/operation-accounting-marker-repository', () => ({
  getParentAccountingState: jest.fn(),
}));

jest.mock('@/lib/operation-settlement-repository', () => ({
  resolveSettledAmount: jest.fn(),
}));

jest.mock('@/lib/graph/verification', () => ({
  getVerificationForEntity: jest.fn(),
}));

jest.mock('@/lib/activity/defense-verification-graph', () => ({
  getVerificationForEdge: jest.fn(),
}));

import { NextRequest } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';

jest.setTimeout(120_000);

import { listOperationReceiptsByCorrelation } from '@/lib/operation-receipt-repository';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import { resolveSettledAmount } from '@/lib/operation-settlement-repository';
import { getVerificationForEntity } from '@/lib/graph/verification';
import { getVerificationForEdge } from '@/lib/activity/defense-verification-graph';
// TEST-036 — acceptance fixtures are built by the PRODUCTION contract builders,
// so this lane can no longer invent a payload shape the producers never emit.
import { buildSmartEntityVerificationOutput, summarizeVerificationSources } from '@/lib/verification-output-contract';

const CORRELATION = 'inngest-acceptance';

function request(url: string): NextRequest {
  return new NextRequest(`http://localhost:9002${url}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer acceptance-token' },
  });
}

describeAcceptance('defense-verifications route — disposable Firestore acceptance', () => {
  let db: Firestore;
  let GET: (req: NextRequest) => Promise<Response>;
  const mocked = {
    receipts: listOperationReceiptsByCorrelation as jest.Mock,
    markers: getParentAccountingState as jest.Mock,
    settlements: resolveSettledAmount as jest.Mock,
    entityGraph: getVerificationForEntity as jest.Mock,
    edgeGraph: getVerificationForEdge as jest.Mock,
  };

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

  beforeAll(async () => {
    db = (jest.requireMock('@/lib/firebase-admin') as { db: Firestore }).db;
    ({ GET } = require('../route'));
  });

  beforeEach(async () => {
    currentUid = OPERATOR;
    jest.clearAllMocks();
    mocked.receipts.mockResolvedValue([]);
    mocked.markers.mockResolvedValue(null);
    mocked.settlements.mockResolvedValue({ status: 'none' });
    mocked.entityGraph.mockResolvedValue(null);
    mocked.edgeGraph.mockResolvedValue(null);

    // Clear collections in the disposable emulator.
    const collections = ['job-runs', 'operationReceipts', 'operationAccountingMarkers', 'operationSettlements'];
    await Promise.all(
      collections.map(async (name) => {
        const snap = await db.collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      })
    );
  });

  it('returns 401 before any read when unauthenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Missing token' });

    const res = await GET(request('/api/activity/defense-verifications'));
    expect(res.status).toBe(401);
    expect(mocked.receipts).not.toHaveBeenCalled();
  });

  it('lists verification job-runs from real Firestore with default ordering', async () => {
    await db
      .collection('job-runs')
      .doc('inngest-entity')
      .set(
        makeJobDoc({
          id: 'inngest-entity',
          functionId: 'verify-entity',
          status: 'completed',
          startedAt: 1000,
          output: { entityId: 'e1', status: 'verified', score: 85, verifierModel: 'defense-minister-smart-v1' },
        })
      );
    await db
      .collection('job-runs')
      .doc('inngest-edge')
      .set(
        makeJobDoc({
          id: 'inngest-edge',
          functionId: 'verify-edge',
          status: 'completed',
          startedAt: 500,
          output: { relationId: 'r1', status: 'verified', score: 100 },
        })
      );
    mocked.entityGraph.mockResolvedValue({
      id: 'vr-e1',
      entityId: 'e1',
      status: 'verified',
      score: 85,
    });
    mocked.receipts.mockResolvedValue([
      {
        id: 'oprcpt-e1',
        correlation: {
          parentType: 'verification',
          owner: 'user:system',
          correlationId: 'inngest-entity',
          inngestRunId: 'entity',
          verificationResultId: 'vr-e1',
          entityId: 'e1',
        },
        provider: 'openai',
        accountingScope: 'standalone',
        feeState: 'none',
        usageCompleteness: 'complete',
        model: 'gpt-4o',
        cost: {
          state: 'estimated',
          amountMicros: 1_230_000,
          currency: 'USD',
          covers: 'tokens',
          rateCardVersion: 'rc-1',
        },
      },
    ]);

    const res = await GET(request('/api/activity/defense-verifications?limit=10'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications).toHaveLength(2);
    expect(body.verifications[0].id).toBe('inngest-entity');
    expect(body.verifications[0].resultId).toBe('vr-e1');
    expect(body.verifications[0].cost.state).toBe('estimated');
    expect(body.verifications[1].id).toBe('inngest-edge');
  });

  it('returns no-graph-result and unavailable cost when a finished run has no receipts', async () => {
    await db
      .collection('job-runs')
      .doc('inngest-no-receipt')
      .set(
        makeJobDoc({
          id: 'inngest-no-receipt',
          functionId: 'verify-entity',
          status: 'completed',
          startedAt: 2000,
          output: { entityId: 'e2', status: 'verified', score: 85 },
        })
      );

    const res = await GET(request('/api/activity/defense-verifications'));
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === 'inngest-no-receipt');
    expect(row).toBeDefined();
    expect(row.partialReason).toBe('no-receipts');
    expect(row.cost.display).toBe('—');
  });

  it('marks a failed edge with no target identity as orphan-target', async () => {
    await db
      .collection('job-runs')
      .doc('inngest-orphan-edge')
      .set(
        makeJobDoc({
          id: 'inngest-orphan-edge',
          functionId: 'verify-edge',
          status: 'failed',
          startedAt: 3000,
          output: { status: 'unverified', score: 50 },
        })
      );

    const res = await GET(request('/api/activity/defense-verifications'));
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === 'inngest-orphan-edge');
    expect(row).toBeDefined();
    expect(row.partialReason).toBe('orphan-target');
  });

  it('honors the system accounting owner and ignores foreign-owner receipts', async () => {
    await db
      .collection('job-runs')
      .doc('inngest-owner')
      .set(
        makeJobDoc({
          id: 'inngest-owner',
          functionId: 'verify-entity',
          status: 'completed',
          startedAt: 4000,
          output: { entityId: 'e-owner', status: 'verified', score: 85 },
        })
      );
    mocked.receipts.mockImplementation(async (owner: string) => {
      if (owner !== 'user:system') return [];
      return [
        {
          id: 'oprcpt-owner-system',
          correlation: {
            parentType: 'verification',
            owner: 'user:system',
            correlationId: 'inngest-owner',
            inngestRunId: 'owner',
            verificationResultId: 'vr-owner',
            entityId: 'e-owner',
          },
          provider: 'openai',
          accountingScope: 'standalone',
          feeState: 'none',
          usageCompleteness: 'complete',
          model: 'gpt-4o',
          cost: {
            state: 'estimated',
            amountMicros: 1_000_000,
            currency: 'USD',
            covers: 'tokens',
            rateCardVersion: 'rc-1',
          },
        },
      ];
    });

    const res = await GET(request('/api/activity/defense-verifications'));
    const body = await res.json();
    const row = body.verifications.find((v: { id: string }) => v.id === 'inngest-owner');
    expect(row.cost.amountMicros).toBe(1_000_000);
    expect(mocked.receipts).toHaveBeenCalledWith('user:system', 'verification', 'inngest-owner');
  });

  it('filters by kind', async () => {
    await db
      .collection('job-runs')
      .doc('inngest-entity-2')
      .set(makeJobDoc({ id: 'inngest-entity-2', functionId: 'verify-entity', status: 'completed', startedAt: 6000 }));
    await db
      .collection('job-runs')
      .doc('inngest-edge-2')
      .set(makeJobDoc({ id: 'inngest-edge-2', functionId: 'verify-edge', status: 'completed', startedAt: 5500 }));

    const res = await GET(request('/api/activity/defense-verifications?kind=edge'));
    const body = await res.json();
    expect(body.verifications).toHaveLength(1);
    expect(body.verifications[0].kind).toBe('edge');
  });
  /**
   * OBS-007 / TEST-036 — real-Firestore proof that production producer output
   * survives the read model.
   *
   * Each case seeds output built by the shared contract builders and FIRST
   * asserts the raw Firestore document, so the acceptance cannot normalize the
   * defect away before the route ever sees it.
   */
  describe('OBS-007 — production producer output through real Firestore', () => {
    it('keeps target, verifier, provider, model and cost for a score-85 smart entity run', async () => {
      const output = {
        entityId: 'e-85',
        ...buildSmartEntityVerificationOutput({
          status: 'verified',
          score: 85,
          observationCount: 6,
          weightedConfirming: 3.76,
          weightedContradicting: 0.4,
        }),
      };
      await db
        .collection('job-runs')
        .doc('inngest-score-85')
        .set(makeJobDoc({ id: 'inngest-score-85', functionId: 'verify-entity', status: 'completed', startedAt: 9000, output }));

      // Assert the RAW stored shape before the page/route reads it.
      const raw = (await db.collection('job-runs').doc('inngest-score-85').get()).data() as {
        output: { score: number; sourcesConfirming: number };
      };
      expect(raw.output.score).toBe(85);
      expect(raw.output.score).toBeGreaterThan(1);
      expect(Number.isInteger(raw.output.sourcesConfirming)).toBe(false);

      mocked.entityGraph.mockResolvedValue({ id: 'vr-85', entityId: 'e-85', status: 'verified', score: 85 });
      mocked.receipts.mockResolvedValue([
        {
          id: 'oprcpt-85',
          correlation: {
            parentType: 'verification',
            owner: 'user:system',
            correlationId: 'inngest-score-85',
            inngestRunId: 'score-85',
            verificationResultId: 'vr-85',
            entityId: 'e-85',
          },
          provider: 'gemini',
          accountingScope: 'standalone',
          feeState: 'none',
          usageCompleteness: 'complete',
          model: 'gemini-3.5-flash',
          cost: { state: 'estimated', amountMicros: 1_230_000, currency: 'USD', covers: 'tokens', rateCardVersion: 'rc-1' },
        },
      ]);

      const res = await GET(request('/api/activity/defense-verifications?limit=50'));
      const body = await res.json();
      const row = body.verifications.find((v: { id: string }) => v.id === 'inngest-score-85');

      expect(row.partialReason).toBeUndefined();
      expect(row.targetId).toBe('e-85');
      expect(row.verifierModel).toBe('defense-minister-smart-v1');
      expect(row.providers).toEqual(['gemini']);
      expect(row.models).toEqual(['gemini-3.5-flash']);
      expect(row.resultId).toBe('vr-85');
      expect(row.resultScore).toBe(85);
      expect(row.cost.state).toBe('estimated');
    });

    it('keeps receipt lineage when ONLY the score field is unreadable', async () => {
      const output = {
        ...summarizeVerificationSources([{ label: 'gemini-grounded-search', verdict: 'confirming' }], 'defense-minister-v1-pragmatic'),
        entityId: 'e-degraded',
        score: 4321,
      };
      await db
        .collection('job-runs')
        .doc('inngest-degraded')
        .set(makeJobDoc({ id: 'inngest-degraded', functionId: 'verify-entity', status: 'completed', startedAt: 9100, output }));

      const raw = (await db.collection('job-runs').doc('inngest-degraded').get()).data() as {
        output: { score: number; entityId: string };
      };
      expect(raw.output.score).toBe(4321);
      expect(raw.output.entityId).toBe('e-degraded');

      mocked.receipts.mockResolvedValue([
        {
          id: 'oprcpt-degraded',
          correlation: {
            parentType: 'verification',
            owner: 'user:system',
            correlationId: 'inngest-degraded',
            inngestRunId: 'degraded',
            entityId: 'e-degraded',
          },
          provider: 'gemini',
          accountingScope: 'standalone',
          feeState: 'none',
          usageCompleteness: 'complete',
          model: 'gemini-3.5-flash',
          cost: { state: 'estimated', amountMicros: 500_000, currency: 'USD', covers: 'tokens', rateCardVersion: 'rc-1' },
        },
      ]);

      const res = await GET(request('/api/activity/defense-verifications?limit=50'));
      const body = await res.json();
      const row = body.verifications.find((v: { id: string }) => v.id === 'inngest-degraded');

      // Provider/Model/Target MUST NOT be blank for a receipt-bearing run.
      expect(row.providers).toEqual(['gemini']);
      expect(row.models).toEqual(['gemini-3.5-flash']);
      expect(row.targetId).toBe('e-degraded');
      expect(row.verifierModel).toBe('defense-minister-v1-pragmatic');
      expect(row.degradedFields).toEqual(['score']);
      expect(row.cost.state).toBe('estimated');
    });

    it('refuses a hostile payload whole and leaks no raw output', async () => {
      const output = { entityId: 'e-hostile', status: 'verified', score: 90, verifierModel: '<script>alert(1)</script>' };
      await db
        .collection('job-runs')
        .doc('inngest-hostile')
        .set(makeJobDoc({ id: 'inngest-hostile', functionId: 'verify-entity', status: 'completed', startedAt: 9200, output }));

      const raw = (await db.collection('job-runs').doc('inngest-hostile').get()).data() as {
        output: { verifierModel: string };
      };
      expect(raw.output.verifierModel).toContain('<script>');

      const res = await GET(request('/api/activity/defense-verifications?limit=50'));
      const text = await res.text();
      expect(text).not.toContain('<script>');
      const row = JSON.parse(text).verifications.find((v: { id: string }) => v.id === 'inngest-hostile');
      expect(row.partialReason).toBe('hostile-output');
      expect(row.targetId).toBeUndefined();
      expect(row.verifierModel).toBeUndefined();
      expect(row.providers).toEqual([]);
    });
  });
});
