/**
 * @file inngest/functions/__tests__/verify-entity-receipt.test.ts
 * @description ARUN-022 — end-to-end proof that the verify-entity path records a
 * durable operation-usage receipt for the nested Gemini grounded search.
 *
 * Exercises the REAL substrate (operation-context sink + instrument bridge) with
 * only the provider call and the Firestore/Neo4j writes mocked:
 * - the Step 2 grounded search captures its usage into the ambient sink;
 * - Step 3 flushes it as a receipt correlated to THIS Inngest run, the minted
 *   VerificationResult id, and the exact entity target;
 * - cost is the honest deferred-pricing fact (no rate card invented);
 * - a verification that makes NO provider call records NO receipt.
 *
 * @jest-environment node
 */

type AnyFunction = (...args: any[]) => any;

import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';
const { adminMock } = createFirebaseAdminMock();
adminMock.docGet.mockResolvedValue({ exists: true, data: () => ({ name: 'TestCo' }) });

const mockRecordOperationReceipt = jest.fn();
const mockCreateVerificationResult = jest.fn();
// Default: the reality check makes a Gemini grounded call and captures its usage.
let realityCheckCaptures = true;
const mockVerifyEntityReality = jest.fn(async (..._args: unknown[]) => {
  if (realityCheckCaptures) {
    const { captureProviderUsage } = require('@/lib/operation-context');
    captureProviderUsage({
      provider: 'gemini',
      operation: 'gemini.grounded-generate',
      requestedModel: 'gemini-3.5-flash',
      providerModel: 'models/gemini-3.5-flash',
      counters: { promptTokens: 500, outputTokens: 120, queryCount: 2 },
      usageCompleteness: 'complete',
      occurredAt: '2026-07-22T09:00:00.000Z',
      feeState: 'applicable-but-unknown',
    });
  }
  return { ok: true, reason: 'verified', evidenceText: '' };
});

jest.mock('@/lib/operation-receipt-repository', () => {
  class OperationReceiptConflictError extends Error {}
  return {
    recordOperationReceiptWithOutcome: async (...args: unknown[]) => ({
      receipt: await mockRecordOperationReceipt(...args),
      outcome: 'written',
    }),
    OperationReceiptConflictError,
  };
});
jest.mock('@/lib/operation-accounting-marker-repository', () => ({
  upsertParentAccountingMarker: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/graph/verification', () => ({
  __esModule: true,
  createVerificationResult: (...args: unknown[]) => mockCreateVerificationResult(...args),
}));
jest.mock('@/lib/entity-reality-check', () => ({
  __esModule: true,
  verifyEntityReality: (...args: unknown[]) => mockVerifyEntityReality(...args),
}));
jest.mock('@/lib/scout-url-verifier', () => ({
  __esModule: true,
  verifyUrlsReachable: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/graph/observations', () => ({
  __esModule: true,
  getObservationsForEntity: jest.fn().mockResolvedValue([]),
  aggregateObservationScore: jest.fn().mockReturnValue({ sparse: true, observationCount: 0 }),
}));
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../client', () => {
  const reg: { handlers: Record<string, AnyFunction> } = { handlers: {} };
  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, _trigger: unknown, handler: AnyFunction) => {
        reg.handlers[config.id as string] = handler;
        return { config, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: reg,
  };
});

import '../verify-entity';

function getHandler(): AnyFunction {
  return (require('../../client')._registry as { handlers: Record<string, AnyFunction> }).handlers['verify-entity'];
}

function buildMockStep() {
  return { run: jest.fn((_name: string, fn: AnyFunction) => fn()), sleep: jest.fn(), sendEvent: jest.fn() };
}

beforeEach(() => {
  process.env.DEFENSE_MINISTER_ENABLED = 'true';
  jest.clearAllMocks();
  realityCheckCaptures = true;
  mockCreateVerificationResult.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'vr-123',
    checkedAt: '2026-07-22T00:00:00.000Z',
    ...input,
  }));
  mockRecordOperationReceipt.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: 'receipt-1',
    recordedAt: '2026-07-22T00:00:00.000Z',
  }));
});

afterEach(() => {
  delete process.env.DEFENSE_MINISTER_ENABLED;
});

describe('verify-entity — ARUN-022 receipt emission', () => {
  it('records a verification-correlated receipt for the nested grounded search', async () => {
    await getHandler()({
      event: { data: { entityId: 'tech-1', entityType: 'technology' } },
      step: buildMockStep(),
      runId: 'run-xyz',
    });

    expect(mockRecordOperationReceipt).toHaveBeenCalledTimes(1);
    const input = mockRecordOperationReceipt.mock.calls[0][0];
    expect(input.correlation).toEqual({
      parentType: 'verification',
      owner: 'user:system',
      correlationId: 'inngest-run-xyz',
      inngestRunId: 'run-xyz',
      verificationResultId: 'vr-123',
      entityId: 'tech-1',
      entityType: 'technology',
    });
    expect(input).toMatchObject({
      operation: 'gemini.grounded-generate',
      invocationId: 'vr-123.0',
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      modelProvenance: 'provider-reported',
      counters: { promptTokens: 500, outputTokens: 120, queryCount: 2 },
      usageCompleteness: 'complete',
      occurredAt: '2026-07-22T09:00:00.000Z',
      // A background verification is standalone spend (no parent headline).
      accountingScope: 'standalone',
      feeState: 'applicable-but-unknown',
    });
    // The instrument builds RAW facts only — the repository derives the cost (the
    // applicable-but-unknown grounding fee will fail it closed, never $0).
    expect(input).not.toHaveProperty('cost');
  });

  it('records the VerificationResult exactly once (receipt flush does not perturb it)', async () => {
    await getHandler()({
      event: { data: { entityId: 'tech-1', entityType: 'technology' } },
      step: buildMockStep(),
      runId: 'run-xyz',
    });
    expect(mockCreateVerificationResult).toHaveBeenCalledTimes(1);
  });

  it('records NO receipt when the verification made no provider call', async () => {
    realityCheckCaptures = false;
    await getHandler()({
      event: { data: { entityId: 'tech-1', entityType: 'technology' } },
      step: buildMockStep(),
      runId: 'run-xyz',
    });
    expect(mockRecordOperationReceipt).not.toHaveBeenCalled();
  });
});
