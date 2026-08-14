/**
 * @file lib/activity/__tests__/defense-verification-join.test.ts
 * @description Unit tests for the Background Verifications read model.
 *
 * @jest-environment node
 */

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(),
  },
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

import type { JobRun } from '@/lib/inngest/observability';
import { buildSmartEntityVerificationOutput, summarizeVerificationSources } from '@/lib/verification-output-contract';
import { type ParentAccountingState } from '@/lib/schemas/operation-accounting-marker';
import { type OperationReceipt } from '@/lib/schemas/operation-receipt';
import { type VerificationResult, type EdgeVerificationResult } from '@/lib/graph/verification';
import {
  aggregateVerificationCost,
  buildDefenseVerificationRow,
  listDefenseVerifications,
  type ResolvedReceipt,
} from '../defense-verification-join';
import { listOperationReceiptsByCorrelation } from '@/lib/operation-receipt-repository';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import { resolveSettledAmount } from '@/lib/operation-settlement-repository';
import { getVerificationForEntity } from '@/lib/graph/verification';
import { getVerificationForEdge } from '@/lib/activity/defense-verification-graph';
import { db } from '@/lib/firebase-admin';

const OWNER = 'user:system';

function baseCorrelation(verificationResultId: string): OperationReceipt['correlation'] {
  return {
    parentType: 'verification',
    owner: OWNER,
    correlationId: 'inngest-run-1',
    inngestRunId: 'run-1',
    verificationResultId,
  };
}

function receiptWithCost(cost: OperationReceipt['cost'], overrides?: Partial<OperationReceipt>): OperationReceipt {
  return {
    id: 'oprcpt~v1~test',
    correlation: baseCorrelation('vr-1'),
    operation: 'verify',
    invocationId: 'inv-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'openai',
    model: 'gpt-4o',
    modelProvenance: 'provider-reported',
    counters: { inputTokens: 100, outputTokens: 50 },
    usageCompleteness: 'complete',
    occurredAt: '2026-01-01T00:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
    recordedAt: 1704067200000,
    cost,
    ...overrides,
  } as unknown as OperationReceipt;
}

function estimatedReceipt(amountMicros: number, currency = 'USD'): ResolvedReceipt {
  return {
    receipt: receiptWithCost({
      state: 'estimated',
      amountMicros,
      currency,
      covers: 'tokens',
      rateCardVersion: 'rc-1',
    }),
    resolution: { status: 'none' },
  };
}

function settledReceipt(amountMicros: number, currency = 'USD'): ResolvedReceipt {
  return {
    receipt: receiptWithCost({
      state: 'estimated',
      amountMicros,
      currency,
      covers: 'tokens',
      rateCardVersion: 'rc-1',
    }),
    resolution: {
      status: 'settled',
      head: {
        id: 'opsettl~v1~head',
        owner: OWNER,
        receiptId: 'oprcpt~v1~test',
        actualAmountMicros: amountMicros,
        currency,
        covers: 'tokens',
        evidenceRef: 'ev-1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        revision: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      chainLength: 0,
    },
  };
}

describe('aggregateVerificationCost', () => {
  it('returns unavailable for no receipts', () => {
    const { cost, partialReason } = aggregateVerificationCost([], null);
    expect(cost.state).toBe('unavailable');
    expect(cost.display).toBe('—');
    expect(partialReason).toBe('no-receipts');
  });

  it('returns estimated when only an estimate exists', () => {
    const { cost, partialReason } = aggregateVerificationCost([estimatedReceipt(1_230_000)], null);
    expect(cost.state).toBe('estimated');
    expect(cost.display).toBe('$1.23 USD est.');
    expect(cost.amountMicros).toBe(1_230_000);
    expect(partialReason).toBeUndefined();
  });

  it('returns settled when a settlement replaces the estimate', () => {
    const { cost, partialReason } = aggregateVerificationCost([settledReceipt(1_230_000)], null);
    expect(cost.state).toBe('settled');
    expect(cost.display).toBe('$1.23 USD settled');
    expect(partialReason).toBeUndefined();
  });

  it('returns partial on mixed currency', () => {
    const { cost, partialReason } = aggregateVerificationCost(
      [estimatedReceipt(1_000_000, 'USD'), estimatedReceipt(1_000_000, 'EUR')],
      null
    );
    expect(cost.state).toBe('partial');
    expect(partialReason).toBe('mixed-currency');
  });

  it('returns partial on conflicted settlement chain', () => {
    const withConflict: ResolvedReceipt = {
      receipt: receiptWithCost({
        state: 'estimated',
        amountMicros: 1_000_000,
        currency: 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      }),
      resolution: { status: 'conflicted', reason: 'competing heads' },
    };
    const { cost, partialReason } = aggregateVerificationCost([withConflict], null);
    expect(cost.state).toBe('partial');
    expect(partialReason).toBe('conflicted-settlement');
  });

  it('returns incomplete when marker is incomplete', () => {
    const marker: ParentAccountingState = {
      accountingState: 'incomplete',
      batchCount: 1,
      expected: 2,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 1,
    };
    const { cost, partialReason } = aggregateVerificationCost([estimatedReceipt(1_000_000)], marker);
    expect(cost.state).toBe('incomplete');
    expect(cost.display).toBe('$1.00 USD (incomplete)');
    expect(partialReason).toBe('incomplete-accounting');
  });

  it('returns unavailable when receipt cost is unavailable', () => {
    const r: ResolvedReceipt = {
      receipt: receiptWithCost({ state: 'unavailable', reason: 'unknown-pricing' }),
      resolution: { status: 'none' },
    };
    const { cost, partialReason } = aggregateVerificationCost([r], null);
    expect(cost.state).toBe('unavailable');
    expect(cost.display).toBe('—');
    expect(partialReason).toBe('no-receipts');
  });
});

function createJobRun(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 'inngest-run-1',
    functionId: 'verify-entity',
    functionName: 'Verify Entity',
    status: 'completed',
    startedAt: 1704067200000,
    completedAt: 1704067210000,
    retryCount: 0,
    // TEST-036 — built by the PRODUCTION contract builder, not hand-written. The
    // previous fixture invented `score: 0.85`, which validated against the
    // reader's wrong 0-1 bound and so kept this suite green while real 0-100
    // producer output was rejected as malformed in production.
    output: {
      entityId: 'entity-1',
      ...buildSmartEntityVerificationOutput({
        status: 'verified',
        score: 85,
        observationCount: 6,
        weightedConfirming: 3.76,
        weightedContradicting: 0.4,
      }),
    },
    ...overrides,
  } as JobRun;
}

function createMockJobRunDoc(run: {
  functionId: string;
  id: string;
  startedAt: number;
  status: string;
  retryCount?: number;
}) {
  return {
    id: run.id,
    functionId: run.functionId,
    functionName: run.functionId,
    status: run.status,
    startedAt: run.startedAt,
    retryCount: run.retryCount ?? 0,
  };
}

describe('buildDefenseVerificationRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([]);
    (getParentAccountingState as jest.Mock).mockResolvedValue(null);
    (resolveSettledAmount as jest.Mock).mockResolvedValue({ status: 'none' });
    (getVerificationForEntity as jest.Mock).mockResolvedValue(null);
    (getVerificationForEdge as jest.Mock).mockResolvedValue(null);
  });

  it('exposes result details when graph result correlates exactly', async () => {
    const vr: VerificationResult = {
      id: 'vr-1',
      entityId: 'entity-1',
      status: 'verified',
      score: 85,
      sourcesChecked: 5,
      sourcesConfirming: 4,
      sourcesContradicting: 0,
      verifierModel: 'defense-minister-smart-v1',
      reasoning: 'ok',
      strictnessLevel: 'standard',
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost({
        state: 'estimated',
        amountMicros: 500_000,
        currency: 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      }),
    ]);
    (getVerificationForEntity as jest.Mock).mockResolvedValue(vr);

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);

    expect(row.id).toBe('inngest-run-1');
    expect(row.kind).toBe('entity');
    expect(row.targetId).toBe('entity-1');
    expect(row.resultId).toBe('vr-1');
    expect(row.resultStatus).toBe('verified');
    expect(row.resultScore).toBe(85);
    expect(row.verifierModel).toBe('defense-minister-smart-v1');
    expect(row.cost.state).toBe('estimated');
    expect(row.providers).toEqual(['openai']);
    expect(row.models).toEqual(['gpt-4o']);
  });

  it('suppresses result details when graph id does not match receipt', async () => {
    const vr: VerificationResult = {
      id: 'vr-OTHER',
      entityId: 'entity-1',
      status: 'verified',
      score: 85,
      sourcesChecked: 5,
      sourcesConfirming: 4,
      sourcesContradicting: 0,
      verifierModel: 'defense-minister-smart-v1',
      reasoning: 'ok',
      strictnessLevel: 'standard',
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost({
        state: 'estimated',
        amountMicros: 500_000,
        currency: 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      }),
    ]);
    (getVerificationForEntity as jest.Mock).mockResolvedValue(vr);

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);

    expect(row.resultId).toBeUndefined();
    expect(row.resultStatus).toBeUndefined();
    expect(row.partialReason).toBe('mismatched-graph-result');
  });

  it('marks missing graph result and still surfaces cost', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost({
        state: 'estimated',
        amountMicros: 500_000,
        currency: 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      }),
    ]);

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);

    expect(row.resultId).toBeUndefined();
    expect(row.partialReason).toBe('no-graph-result');
    expect(row.cost.state).toBe('estimated');
  });

  it('marks ambiguous when receipts claim multiple result ids', async () => {
    const vr: VerificationResult = {
      id: 'vr-1',
      entityId: 'entity-1',
      status: 'verified',
      score: 85,
      sourcesChecked: 5,
      sourcesConfirming: 4,
      sourcesContradicting: 0,
      verifierModel: 'defense-minister-smart-v1',
      reasoning: 'ok',
      strictnessLevel: 'standard',
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost({
        state: 'estimated',
        amountMicros: 500_000,
        currency: 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      }),
      receiptWithCost(
        {
          state: 'estimated',
          amountMicros: 500_000,
          currency: 'USD',
          covers: 'tokens',
          rateCardVersion: 'rc-1',
        },
        { id: 'oprcpt~v1~test-2', correlation: baseCorrelation('vr-2') }
      ),
    ]);
    (getVerificationForEntity as jest.Mock).mockResolvedValue(vr);

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);
    expect(row.partialReason).toBe('ambiguous-graph-result');
  });

  it('marks malformed output without exposing raw output', async () => {
    const row = await buildDefenseVerificationRow(
      createJobRun({ output: { invalid: true, nested: { reason: 'x' } } }),
      OWNER
    );
    expect(row.partialReason).toBe('malformed-output');
    expect(row.targetId).toBeUndefined();
  });

  it('flags hostile output as hostile-output', async () => {
    const row = await buildDefenseVerificationRow(
      createJobRun({ output: { entityId: 'e1', '<script>': 'alert(1)' } }),
      OWNER
    );
    expect(row.partialReason).toBe('hostile-output');
  });

  it('handles orphan edge failure', async () => {
    const row = await buildDefenseVerificationRow(
      createJobRun({
        functionId: 'verify-edge',
        status: 'failed',
        output: { status: 'unverified', score: 0 },
      }),
      OWNER
    );
    expect(row.kind).toBe('edge');
    expect(row.status).toBe('failed');
    expect(row.partialReason).toBe('orphan-target');
  });

  it('correlates a completed edge verification with its graph result', async () => {
    const evr: EdgeVerificationResult = {
      id: 'vr-edge-1',
      relationId: 'relation-1',
      sourceEntityId: 'source-1',
      targetEntityId: 'target-1',
      status: 'verified',
      score: 78,
      sourcesChecked: 4,
      sourcesConfirming: 3,
      sourcesContradicting: 0,
      verifierModel: 'defense-minister-v1-edge',
      reasoning: 'ok',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost(
        {
          state: 'estimated',
          amountMicros: 800_000,
          currency: 'USD',
          covers: 'tokens',
          rateCardVersion: 'rc-1',
        },
        { correlation: baseCorrelation('vr-edge-1') }
      ),
    ]);
    (getVerificationForEdge as jest.Mock).mockResolvedValue(evr);

    const row = await buildDefenseVerificationRow(
      createJobRun({
        functionId: 'verify-edge',
        output: {
          relationId: 'relation-1',
          sourceEntityId: 'source-1',
          targetEntityId: 'target-1',
          status: 'verified',
          score: 78,
          verifierModel: 'defense-minister-v1-edge',
        },
      }),
      OWNER
    );

    expect(row.resultId).toBe('vr-edge-1');
    expect(row.resultStatus).toBe('verified');
    expect(row.targetSubIds).toEqual({ sourceEntityId: 'source-1', targetEntityId: 'target-1' });
    expect(row.cost.state).toBe('estimated');
  });

  it('surfaces a failed entity verification without result details', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([
      receiptWithCost({ state: 'unavailable', reason: 'unknown-pricing' }),
    ]);

    const row = await buildDefenseVerificationRow(
      createJobRun({
        status: 'failed',
        output: { entityId: 'entity-failed', status: 'unverified', score: 0 },
      }),
      OWNER
    );

    expect(row.status).toBe('failed');
    expect(row.targetId).toBe('entity-failed');
    expect(row.resultId).toBeUndefined();
    expect(row.cost.state).toBe('unavailable');
  });

  it('does not include foreign-owner receipts in the row', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockImplementation(async (owner: string) => {
      if (owner !== OWNER) return [];
      return [
        receiptWithCost({
          state: 'estimated',
          amountMicros: 1_000_000,
          currency: 'USD',
          covers: 'tokens',
          rateCardVersion: 'rc-1',
        }),
      ];
    });

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);

    expect(listOperationReceiptsByCorrelation).toHaveBeenCalledWith(OWNER, 'verification', 'inngest-run-1');
    expect(row.cost.amountMicros).toBe(1_000_000);
  });

  it('surfaces dependency outage as partial truth', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockRejectedValue(new Error('Firestore down'));

    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);

    expect(row.partialReason).toBe('dependency-outage');
    expect(row.cost.state).toBe('partial');
  });
});

describe('listDefenseVerifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([]);
    (getParentAccountingState as jest.Mock).mockResolvedValue(null);
    (resolveSettledAmount as jest.Mock).mockResolvedValue({ status: 'none' });
    (getVerificationForEntity as jest.Mock).mockResolvedValue(null);
    (getVerificationForEdge as jest.Mock).mockResolvedValue(null);
  });

  function mockJobRuns(
    runs: Array<{ functionId: string; id: string; startedAt: number; status: string; retryCount?: number }>
  ) {
    (db.collection as jest.Mock).mockImplementation(() => {
      let currentFunctionId: string | undefined;
      let startAfterCursor: { startedAt: number; id: string } | undefined;
      let currentLimit: number | undefined;

      function runComparator(a: (typeof runs)[number], b: (typeof runs)[number]): number {
        if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      }

      return {
        where(field: string, _op: string, value: string) {
          if (field === 'functionId') currentFunctionId = value;
          return this;
        },
        orderBy() {
          return this;
        },
        limit(limit: number) {
          currentLimit = limit;
          return this;
        },
        startAfter(startedAt: number | { toMillis(): number }, id: string) {
          const cursorStartedAt =
            typeof startedAt === 'object' && 'toMillis' in startedAt ? startedAt.toMillis() : startedAt;
          startAfterCursor = { startedAt: cursorStartedAt, id };
          return this;
        },
        get: jest.fn().mockImplementation(() => {
          let filtered = currentFunctionId ? runs.filter((r) => r.functionId === currentFunctionId) : [...runs];
          filtered.sort(runComparator);
          if (startAfterCursor) {
            filtered = filtered.filter(
              (r) =>
                r.startedAt < startAfterCursor!.startedAt ||
                (r.startedAt === startAfterCursor!.startedAt && r.id < startAfterCursor!.id)
            );
          }
          if (currentLimit !== undefined && currentLimit > 0) {
            filtered = filtered.slice(0, currentLimit);
          }
          return Promise.resolve({
            docs: filtered.map((r) => ({
              id: r.id,
              data: () => createMockJobRunDoc(r),
            })),
          });
        }),
      };
    });
  }

  it('paginates and filters by kind', async () => {
    mockJobRuns([
      { functionId: 'verify-entity', id: 'inngest-e1', startedAt: 1000, status: 'completed' },
      { functionId: 'verify-edge', id: 'inngest-e2', startedAt: 900, status: 'completed' },
    ]);

    const page = await listDefenseVerifications({ accountingOwner: OWNER, kind: 'entity' });

    expect(page.verifications).toHaveLength(1);
    expect(page.verifications[0].kind).toBe('entity');
    expect(page.verifications[0].id).toBe('inngest-e1');
    expect(page.nextCursor).toBeNull();
  });

  it('uses a cursor to return the next page', async () => {
    mockJobRuns([
      { functionId: 'verify-entity', id: 'inngest-e1', startedAt: 1000, status: 'completed' },
      { functionId: 'verify-entity', id: 'inngest-e2', startedAt: 1000, status: 'completed' },
      { functionId: 'verify-entity', id: 'inngest-e3', startedAt: 500, status: 'completed' },
    ]);

    const first = await listDefenseVerifications({ accountingOwner: OWNER, limit: 2 });
    expect(first.verifications).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await listDefenseVerifications({
      accountingOwner: OWNER,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.verifications).toHaveLength(1);
    expect(second.verifications[0].id).toBe('inngest-e3');
    expect(second.nextCursor).toBeNull();
  });

  it('does not skip filtered rows across pages', async () => {
    // First two runs are dropped by the status filter, then a completed run,
    // then another dropped run, then a final completed run. With limit=1 the
    // pagination must continue through the raw stream and return both completed
    // rows on successive pages instead of stopping after the first page.
    mockJobRuns([
      { functionId: 'verify-entity', id: 'inngest-f1', startedAt: 1000, status: 'failed' },
      { functionId: 'verify-entity', id: 'inngest-f2', startedAt: 900, status: 'failed' },
      { functionId: 'verify-entity', id: 'inngest-c1', startedAt: 800, status: 'completed' },
      { functionId: 'verify-entity', id: 'inngest-f3', startedAt: 700, status: 'failed' },
      { functionId: 'verify-entity', id: 'inngest-c2', startedAt: 600, status: 'completed' },
    ]);

    const first = await listDefenseVerifications({
      accountingOwner: OWNER,
      limit: 1,
      status: 'completed',
    });
    expect(first.verifications).toHaveLength(1);
    expect(first.verifications[0].id).toBe('inngest-c1');
    expect(first.nextCursor).toBeTruthy();

    const second = await listDefenseVerifications({
      accountingOwner: OWNER,
      limit: 1,
      status: 'completed',
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.verifications).toHaveLength(1);
    expect(second.verifications[0].id).toBe('inngest-c2');
    expect(second.nextCursor).toBeNull();
  });

  it('scopes accounting joins to the accountingOwner principal', async () => {
    mockJobRuns([{ functionId: 'verify-entity', id: 'inngest-e1', startedAt: 1000, status: 'completed' }]);

    await listDefenseVerifications({ accountingOwner: OWNER });

    expect(listOperationReceiptsByCorrelation).toHaveBeenCalledWith(OWNER, 'verification', 'inngest-e1');
  });
});

/**
 * OBS-007 — the regression this lane exists to close.
 *
 * Every fixture is produced by the shared contract builders. Against the old
 * reader (whole-object parse, `score` bounded 0-1) each of these fails: real
 * producer output threw, the function returned before the receipt/marker/graph
 * joins, and the row rendered as a bare "Malformed output" with no target, no
 * verifier, no provider and no cost.
 */
describe('OBS-007 — real producer output is not falsely rejected', () => {
  const RECEIPT = () =>
    receiptWithCost({
      state: 'estimated',
      amountMicros: 500_000,
      currency: 'USD',
      covers: 'tokens',
      rateCardVersion: 'rc-1',
    });

  beforeEach(() => {
    jest.clearAllMocks();
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([]);
    (getParentAccountingState as jest.Mock).mockResolvedValue(null);
    (resolveSettledAmount as jest.Mock).mockResolvedValue({ status: 'none' });
    (getVerificationForEntity as jest.Mock).mockResolvedValue(null);
    (getVerificationForEdge as jest.Mock).mockResolvedValue(null);
  });

  it('keeps full lineage for a real 0-100 edge verdict', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([RECEIPT()]);
    const row = await buildDefenseVerificationRow(
      createJobRun({
        id: 'inngest-edge-1',
        functionId: 'verify-edge',
        functionName: 'Verify Edge',
        output: {
          relationId: 'rel-1',
          sourceEntityId: 'src-1',
          targetEntityId: 'tgt-1',
          ...summarizeVerificationSources(
            [
              { label: 'source-reality', verdict: 'confirming' },
              { label: 'target-reality', verdict: 'confirming' },
            ],
            'defense-minister-v1-edge'
          ),
        },
      } as Partial<JobRun>),
      OWNER
    );

    expect(row.partialReason).not.toBe('malformed-output');
    expect(row.targetId).toBe('rel-1');
    expect(row.targetSubIds).toEqual({ sourceEntityId: 'src-1', targetEntityId: 'tgt-1' });
    expect(row.verifierModel).toBe('defense-minister-v1-edge');
    expect(row.providers).toEqual(['openai']);
    expect(row.models).toEqual(['gpt-4o']);
    expect(row.degradedFields).toBeUndefined();
  });

  it('accepts fractional decay-weighted source counts from the smart path', async () => {
    const row = await buildDefenseVerificationRow(createJobRun(), OWNER);
    expect(row.partialReason).not.toBe('malformed-output');
    expect(row.targetId).toBe('entity-1');
    expect(row.verifierModel).toBe('defense-minister-smart-v1');
  });

  it('preserves target, verifier, provider, model and cost when ONLY the score is unreadable', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([RECEIPT()]);

    const row = await buildDefenseVerificationRow(
      createJobRun({
        output: {
          ...summarizeVerificationSources(
            [{ label: 'gemini-grounded-search', verdict: 'confirming' }],
            'defense-minister-v1-pragmatic'
          ),
          entityId: 'entity-1',
          score: 4321,
        },
      } as Partial<JobRun>),
      OWNER
    );

    // The single unreadable field is named, and costs nothing else.
    expect(row.degradedFields).toEqual(['score']);
    expect(row.targetId).toBe('entity-1');
    expect(row.verifierModel).toBe('defense-minister-v1-pragmatic');
    expect(row.providers).toEqual(['openai']);
    expect(row.models).toEqual(['gpt-4o']);
    expect(row.cost.state).toBe('estimated');
  });

  it('still reports provable spend for a genuinely unreadable payload', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([RECEIPT()]);

    const row = await buildDefenseVerificationRow(
      createJobRun({ output: { totally: 'unrelated' } } as Partial<JobRun>),
      OWNER
    );

    expect(row.partialReason).toBe('malformed-output');
    expect(row.targetId).toBeUndefined();
    // Receipts are keyed by JobRun id in a trusted store, not read from the
    // payload — reporting "no cost" for a run that provably billed would be a
    // second false statement.
    expect(row.providers).toEqual(['openai']);
    expect(row.cost.state).toBe('estimated');
  });

  it('refuses a hostile payload WHOLE and joins nothing', async () => {
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([RECEIPT()]);

    const row = await buildDefenseVerificationRow(
      createJobRun({
        output: { entityId: 'entity-1', score: 85, verifierModel: '<script>alert(1)</script>' },
      } as Partial<JobRun>),
      OWNER
    );

    expect(row.partialReason).toBe('hostile-output');
    expect(row.targetId).toBeUndefined();
    expect(row.verifierModel).toBeUndefined();
    expect(row.providers).toEqual([]);
    expect(row.models).toEqual([]);
    expect(row.cost.state).toBe('unavailable');
  });

  it('never echoes raw output back into the row', async () => {
    const row = await buildDefenseVerificationRow(
      createJobRun({
        output: {
          entityId: 'entity-1',
          ...summarizeVerificationSources([{ label: 'x', verdict: 'confirming' }], 'v1'),
          secretPrompt: 'do not leak me',
        },
      } as Partial<JobRun>),
      OWNER
    );

    expect(JSON.stringify(row)).not.toContain('do not leak me');
    expect(JSON.stringify(row)).not.toContain('decisive sources confirm');
  });

  it('reports a graph correlation gap even while a field is degraded', async () => {
    // With a receipt present the accounting is whole, so the graph gap is the
    // top-ranked reason and the field gap has to survive alongside it.
    (listOperationReceiptsByCorrelation as jest.Mock).mockResolvedValue([RECEIPT()]);
    const row = await buildDefenseVerificationRow(
      createJobRun({ output: { entityId: 'entity-1', score: 4321 } } as Partial<JobRun>),
      OWNER
    );

    // Both facts stay visible: the primary reason AND which field degraded.
    expect(row.partialReason).toBe('no-graph-result');
    expect(row.degradedFields).toEqual(['score']);
  });
});
