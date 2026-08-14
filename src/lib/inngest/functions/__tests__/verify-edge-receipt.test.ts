/**
 * @file inngest/functions/__tests__/verify-edge-receipt.test.ts
 * @description ARUN-022 — end-to-end proof that the verify-edge path records
 * durable receipts for its nested Gemini grounded searches (source + target
 * reality checks), correlated to the run, the minted EdgeVerificationResult id,
 * and the exact RELATION target (relationId, not an entity target).
 *
 * @jest-environment node
 */

type AnyFunction = (...args: any[]) => any;

const mockRecordOperationReceipt = jest.fn();
const mockCreateEdgeVerificationResult = jest.fn();
const mockVerifyEntityReality = jest.fn(async (..._args: unknown[]) => {
  const { captureProviderUsage } = require('@/lib/operation-context');
  captureProviderUsage({
    provider: 'gemini',
    operation: 'gemini.grounded-generate',
    requestedModel: 'gemini-3.5-flash',
    providerModel: 'gemini-3.5-flash',
    counters: { promptTokens: 300, outputTokens: 80, queryCount: 1 },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T09:00:00.000Z',
    feeState: 'applicable-but-unknown',
  });
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
  createEdgeVerificationResult: (...args: unknown[]) => mockCreateEdgeVerificationResult(...args),
}));
jest.mock('@/lib/entity-reality-check', () => ({
  __esModule: true,
  verifyEntityReality: (...args: unknown[]) => mockVerifyEntityReality(...args),
}));
jest.mock('@/lib/scout-url-verifier', () => ({
  __esModule: true,
  verifyUrlsReachable: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/relations-admin', () => ({
  __esModule: true,
  adminGetRelationById: jest
    .fn()
    .mockResolvedValue({ sourceSnapshot: { name: 'Alpha' }, targetSnapshot: { name: 'Beta' } }),
}));
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

import '../verify-edge';

function getHandler(): AnyFunction {
  return (require('../../client')._registry as { handlers: Record<string, AnyFunction> }).handlers['verify-edge'];
}

function buildMockStep() {
  return { run: jest.fn((_name: string, fn: AnyFunction) => fn()), sleep: jest.fn(), sendEvent: jest.fn() };
}

beforeEach(() => {
  process.env.DEFENSE_MINISTER_ENABLED = 'true';
  jest.clearAllMocks();
  mockCreateEdgeVerificationResult.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'evr-9',
    createdAt: '2026-07-22T00:00:00.000Z',
    ...input,
  }));
  mockRecordOperationReceipt.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: 'receipt',
    recordedAt: '2026-07-22T00:00:00.000Z',
  }));
});

afterEach(() => {
  delete process.env.DEFENSE_MINISTER_ENABLED;
});

describe('verify-edge — ARUN-022 receipt emission', () => {
  it('records one receipt per nested grounded search, correlated to the relation target', async () => {
    await getHandler()({
      event: { data: { relationId: 'rel-1', sourceEntityId: 'src-1', targetEntityId: 'tgt-1' } },
      step: buildMockStep(),
      runId: 'run-abc',
    });

    // Two reality checks (source + target) → two captures → two receipts.
    expect(mockRecordOperationReceipt).toHaveBeenCalledTimes(2);
    const inputs = mockRecordOperationReceipt.mock.calls.map((c) => c[0]);
    for (const input of inputs) {
      expect(input.correlation).toEqual({
        parentType: 'verification',
        owner: 'user:system',
        correlationId: 'inngest-run-abc',
        inngestRunId: 'run-abc',
        verificationResultId: 'evr-9',
        relationId: 'rel-1',
      });
      // The instrument builds RAW facts only — the repository derives the cost
      // (an applicable-but-unknown grounding fee will fail it closed, never $0).
      expect(input).not.toHaveProperty('cost');
      // Background verification spend is standalone; the grounded search owed an
      // indeterminate search fee (applicable-but-unknown), never $0.
      expect(input.accountingScope).toBe('standalone');
      expect(input.feeState).toBe('applicable-but-unknown');
      expect(input.occurredAt).toBe('2026-07-22T09:00:00.000Z');
    }
    // Distinct, stable invocation identities derived from the minted result id.
    expect(inputs.map((i) => i.invocationId).sort()).toEqual(['evr-9.0', 'evr-9.1']);
  });
});
