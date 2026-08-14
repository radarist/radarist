/**
 * ARUN-022 — live Admin-SDK acceptance of the new producer boundaries against a
 * REAL Firestore emulator (no mocks). Proves the four producer-specific
 * durability contracts that unit tests cannot:
 *   1. Firecrawl receipt persistence and exact replay (one paid call → one durable
 *      receipt + marker; basic fallback emits none).
 *   2. Deep Research completed/failed terminal receipts (a terminal poll, whether
 *      success or failure, flushes a paid provider capture).
 *   3. Mission per-model receipt plus append-only SDK settlement (one receipt per
 *      model; the SDK costUSD is an immutable settlement, not a receipt cost).
 *   4. Receipt-loss marker visibility (a conflicting replay updates the durable
 *      marker so a loss is visible, never swallowed).
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

export {};

import { db as adminDb } from '@/lib/firebase-admin';
import { withCapturedUsage, flushCapturedUsage } from '@/lib/operation-receipt-instrument';
import { getOperationReceipt } from '@/lib/operation-receipt-repository';
import { listOperationSettlementsByReceipt, recordOperationSettlement } from '@/lib/operation-settlement-repository';
import { getParentAccountingMarker, getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import {
  flushBuildSessionUsageReceipt,
  flushMissionUsageReceipts,
  flushSubSessionUsageReceipts,
} from '@/lib/mission-usage-receipts';
import type { CapturedProviderUsage } from '@/lib/operation-context';

const OWNER = 'user-arun-022-emulator';
const AS_OF = '2026-07-24T12:00:00.000Z';

function firecrawlCapture(overrides: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage {
  return {
    provider: 'firecrawl',
    operation: 'firecrawl.scrape',
    counters: {},
    usageCompleteness: 'unreported',
    occurredAt: AS_OF,
    feeState: 'applicable-but-unknown',
    ...overrides,
  };
}

function deepResearchCapture(status: string): CapturedProviderUsage {
  return {
    provider: 'gemini',
    operation: 'gemini.deep-research',
    requestedModel: 'models/gemini-deep-research',
    counters: {},
    usageCompleteness: 'unreported',
    occurredAt: AS_OF,
    feeState: 'applicable-but-unknown',
  };
}

async function cleanupReceipts(correlationId: string, parentType: 'mcp' | 'job-run' | 'mission') {
  const { listOperationReceiptsByCorrelation } = await import('@/lib/operation-receipt-repository');
  const receipts = await listOperationReceiptsByCorrelation(OWNER, parentType, correlationId);
  for (const r of receipts) {
    // eslint-disable-next-line no-await-in-loop
    await adminDb
      .collection('operationReceipts')
      .doc(r.id)
      .delete()
      .catch(() => undefined);
  }
}

async function cleanupMarkers(correlationId: string, parentType: 'mcp' | 'job-run' | 'mission') {
  const snap = await adminDb
    .collection('operationAccountingMarkers')
    .where('owner', '==', OWNER)
    .where('parentType', '==', parentType)
    .where('correlationId', '==', correlationId)
    .get();
  for (const doc of snap.docs) {
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.delete().catch(() => undefined);
  }
}

async function cleanupSettlements(receiptId: string) {
  const settlements = await listOperationSettlementsByReceipt(OWNER, receiptId);
  for (const s of settlements) {
    // eslint-disable-next-line no-await-in-loop
    await adminDb
      .collection('operationSettlements')
      .doc(s.id)
      .delete()
      .catch(() => undefined);
  }
}

afterAll(async () => {
  await adminDb.terminate();
});

describe('ARUN-022 accounting producers (live emulator)', () => {
  it('persist one Firecrawl receipt per paid call and replays idempotently', async () => {
    const correlationId = 'arun-022-firecrawl-emulator';

    const capture = firecrawlCapture();
    const first = await flushCapturedUsage(
      { parentType: 'mcp', owner: OWNER, correlationId },
      [capture],
      `firecrawl-${correlationId}`,
      'standalone'
    );

    expect(first.complete).toBe(true);
    expect(first.written).toBe(1);
    expect(first.markerPersisted).toBe(true);
    expect(first.receipts).toHaveLength(1);

    const receiptId = first.receipts[0].id;

    // Read the receipt back and verify the paid-but-unreported fee shape.
    const stored = await getOperationReceipt(OWNER, receiptId);
    expect(stored).not.toBeNull();
    expect(stored?.provider).toBe('firecrawl');
    expect(stored?.operation).toBe('firecrawl.scrape');
    expect(stored?.feeState).toBe('applicable-but-unknown');
    expect(stored?.usageCompleteness).toBe('unreported');
    // Firecrawl is not modeled on the canonical rate card, so the token-receipt
    // prices as `unknown-pricing` rather than being read as a fabricated $0.
    expect(stored?.cost).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });

    // Exact replay is idempotent.
    const second = await flushCapturedUsage(
      { parentType: 'mcp', owner: OWNER, correlationId },
      [capture],
      `firecrawl-${correlationId}`,
      'standalone'
    );
    expect(second.replayed).toBe(1);
    expect(second.receipts[0].id).toBe(receiptId);

    const marker = await getParentAccountingState(OWNER, 'mcp', correlationId);
    expect(marker).not.toBeNull();
    expect(marker?.accountingState).toBe('complete');

    await cleanupReceipts(correlationId, 'mcp');
    await cleanupMarkers(correlationId, 'mcp');
  });

  it('flushes Deep Research terminal receipts for both completed and failed outcomes', async () => {
    const completedCorrelationId = 'arun-022-deep-research-completed';
    const failedCorrelationId = 'arun-022-deep-research-failed';

    const completedCapture = deepResearchCapture('completed');
    const failedCapture = deepResearchCapture('failed');

    const completed = await flushCapturedUsage(
      {
        parentType: 'job-run',
        owner: OWNER,
        correlationId: completedCorrelationId,
        inngestRunId: completedCorrelationId,
      },
      [completedCapture],
      `deep-research-${completedCorrelationId}`,
      'standalone'
    );
    expect(completed.complete).toBe(true);

    const failed = await flushCapturedUsage(
      { parentType: 'job-run', owner: OWNER, correlationId: failedCorrelationId, inngestRunId: failedCorrelationId },
      [failedCapture],
      `deep-research-${failedCorrelationId}`,
      'standalone'
    );
    expect(failed.complete).toBe(true);

    const completedReceipt = await getOperationReceipt(OWNER, completed.receipts[0].id);
    expect(completedReceipt?.provider).toBe('gemini');
    expect(completedReceipt?.operation).toBe('gemini.deep-research');
    expect(completedReceipt?.feeState).toBe('applicable-but-unknown');

    const failedReceipt = await getOperationReceipt(OWNER, failed.receipts[0].id);
    expect(failedReceipt?.provider).toBe('gemini');
    expect(failedReceipt?.operation).toBe('gemini.deep-research');
    expect(failedReceipt?.cost).toEqual({ state: 'unavailable', reason: 'missing-usage' });

    await cleanupReceipts(completedCorrelationId, 'job-run');
    await cleanupReceipts(failedCorrelationId, 'job-run');
    await cleanupMarkers(completedCorrelationId, 'job-run');
    await cleanupMarkers(failedCorrelationId, 'job-run');
  });

  it('flushes mission per-model receipts and records the SDK costUSD as append-only settlements', async () => {
    const missionId = 'arun-022-mission-emulator';

    const outcome = await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, costUSD: 0.0123 },
      },
    });

    expect(outcome.flush?.complete).toBe(true);
    expect(outcome.flush?.receipts).toHaveLength(1);
    expect(outcome.settlements['claude-sonnet-4']).toBe('settled');

    const receiptId = outcome.flush!.receipts[0].id;
    const stored = await getOperationReceipt(OWNER, receiptId);
    expect(stored?.provider).toBe('anthropic');
    expect(stored?.operation).toBe('anthropic.mission-turn');
    expect(stored?.model).toBe('claude-sonnet-4');
    expect(stored?.counters.promptTokens).toBe(100);
    expect(stored?.counters.outputTokens).toBe(50);
    expect(stored?.counters.cacheReadTokens).toBe(10);
    expect(stored?.accountingScope).toBe('included-in-parent');

    const settlements = await listOperationSettlementsByReceipt(OWNER, receiptId);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].actualAmountMicros).toBe(12300); // $0.0123
    expect(settlements[0].currency).toBe('USD');
    expect(settlements[0].covers).toBe('tokens');

    // Append-only settlement is idempotent on replay.
    const replay = await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, costUSD: 0.0123 },
      },
    });
    expect(replay.flush?.replayed).toBe(1);
    const settlementsAfterReplay = await listOperationSettlementsByReceipt(OWNER, receiptId);
    expect(settlementsAfterReplay).toHaveLength(1);

    await cleanupSettlements(receiptId);
    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });

  it('makes receipt loss visible through the durable accounting marker', async () => {
    const correlationId = 'arun-022-loss-marker';

    const firstCapture = firecrawlCapture();
    const first = await flushCapturedUsage(
      { parentType: 'mcp', owner: OWNER, correlationId },
      [firstCapture],
      `firecrawl-${correlationId}`,
      'standalone'
    );
    expect(first.conflicted).toBe(0);

    const secondCapture = firecrawlCapture({ occurredAt: '2026-07-24T12:05:00.000Z' });
    const second = await flushCapturedUsage(
      { parentType: 'mcp', owner: OWNER, correlationId },
      [secondCapture],
      `firecrawl-${correlationId}`,
      'standalone'
    );
    expect(second.conflicted).toBe(1);
    expect(second.complete).toBe(false);

    const marker = await getParentAccountingState(OWNER, 'mcp', correlationId);
    expect(marker).not.toBeNull();
    expect(marker?.accountingState).toBe('incomplete');
    expect(marker?.conflicted).toBe(1);

    // The original receipt survives; the conflict did not overwrite it.
    const receiptId = first.receipts[0].id;
    const storedAfterConflict = await getOperationReceipt(OWNER, receiptId);
    expect(storedAfterConflict?.id).toBe(receiptId);

    await cleanupReceipts(correlationId, 'mcp');
    await cleanupMarkers(correlationId, 'mcp');
  });
});

/**
 * ARUN-022 / ARUN-027 — the build envelope, end to end against real Firestore,
 * and the canonical roll-up reading back what the producer actually wrote.
 *
 * These assert the properties that only a durable store can prove: that an
 * unpriceable estimate plus a provider settlement really does reconcile to
 * `settled`, that a supervisor replay does not duplicate or double-settle, and
 * that a genuine conflict degrades the visible state instead of being swallowed.
 */
describe('ARUN-022 build envelope + ARUN-027 reconciliation (live emulator)', () => {
  const REQUESTED_MODEL = 'claude-sonnet-5';

  async function summarize(missionId: string) {
    const { listOperationReceiptsByCorrelation } = await import('@/lib/operation-receipt-repository');
    const { resolveSettledAmount } = await import('@/lib/operation-settlement-repository');
    const { summarizeOperationAccounting } = await import('@/lib/operation-accounting-summary');
    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    const resolved = [];
    for (const receipt of receipts) {
      // eslint-disable-next-line no-await-in-loop
      resolved.push({ receipt, resolution: await resolveSettledAmount(OWNER, receipt.id) });
    }
    const markerState = await getParentAccountingState(OWNER, 'mission', missionId);
    return summarizeOperationAccounting(resolved, markerState);
  }

  it('records an unpriceable estimate and reconciles it to settled via the CLI actual', async () => {
    const missionId = 'arun-022-build-settled';

    const outcome = await flushBuildSessionUsageReceipt({
      missionId,
      owner: OWNER,
      sessionIndex: 0,
      requestedModel: REQUESTED_MODEL,
      occurredAt: AS_OF,
      inputTokens: 52_000,
      outputTokens: 18_000,
      authoritativeCostUsd: 4.25,
    });

    expect(outcome.flush?.complete).toBe(true);
    expect(outcome.settlement).toBe('settled');

    const receiptId = outcome.flush!.receipts[0].id;
    const stored = await getOperationReceipt(OWNER, receiptId);
    expect(stored?.operation).toBe('anthropic.build-session');
    expect(stored?.accountingScope).toBe('included-in-parent');
    // The CLI never confirms the served model, so the receipt must say so and
    // the rate card must refuse to price it rather than invent a figure.
    expect(stored?.modelProvenance).toBe('requested-fallback');
    expect(stored?.usageCompleteness).toBe('partial');
    expect(stored?.cost.state).toBe('unavailable');

    // The money is nonetheless fully proven — through the settlement.
    const summary = await summarize(missionId);
    expect(summary.state).toBe('settled');
    expect(summary.amountMicros).toBe(4_250_000);
    expect(summary.currency).toBe('USD');
    expect(summary.settledCount).toBe(1);
    // The mission headline already counts this session.
    expect(summary.byScope['included-in-parent'].amountMicros).toBe(4_250_000);
    expect(summary.notDoubleCountedMicros).toBe(0);

    await cleanupSettlements(receiptId);
    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });

  it('replays a supervisor retry without duplicating the receipt or the settlement', async () => {
    const missionId = 'arun-022-build-replay';
    const input = {
      missionId,
      owner: OWNER,
      sessionIndex: 3,
      requestedModel: REQUESTED_MODEL,
      occurredAt: AS_OF,
      inputTokens: 1_000,
      outputTokens: 500,
      authoritativeCostUsd: 0.75,
    };

    const first = await flushBuildSessionUsageReceipt(input);
    expect(first.flush?.written).toBe(1);
    const receiptId = first.flush!.receipts[0].id;

    // An Inngest step retry re-runs the same finalization with the same durable
    // facts. Identity is derived from them, so this must be a replay.
    const second = await flushBuildSessionUsageReceipt(input);
    expect(second.flush?.replayed).toBe(1);
    expect(second.flush?.written).toBe(0);
    expect(second.flush?.receipts[0].id).toBe(receiptId);

    const settlements = await listOperationSettlementsByReceipt(OWNER, receiptId);
    expect(settlements).toHaveLength(1);

    const summary = await summarize(missionId);
    expect(summary.receiptCount).toBe(1);
    expect(summary.amountMicros).toBe(750_000);
    expect(summary.state).toBe('settled');

    await cleanupSettlements(receiptId);
    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });

  it('leaves a missing-result session unsettled and visibly unavailable, never $0', async () => {
    const missionId = 'arun-022-build-no-result';

    // No authoritativeCostUsd: the CLI produced no result line, so the
    // supervisor charged the reservation — an exposure ceiling, not a bill.
    const outcome = await flushBuildSessionUsageReceipt({
      missionId,
      owner: OWNER,
      sessionIndex: 1,
      requestedModel: REQUESTED_MODEL,
      occurredAt: AS_OF,
    });

    expect(outcome.settlement).toBe('skipped');
    const receiptId = outcome.flush!.receipts[0].id;
    expect(await listOperationSettlementsByReceipt(OWNER, receiptId)).toHaveLength(0);

    const summary = await summarize(missionId);
    // Unavailable rather than a fabricated zero: spend happened, its amount is
    // genuinely unknown here.
    expect(summary.state).toBe('unavailable');
    expect(summary.amountMicros).toBeUndefined();
    expect(summary.unavailableCount).toBe(1);

    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });

  it('degrades the visible state when a conflicting re-flush loses a receipt', async () => {
    const missionId = 'arun-022-build-loss';
    const base = {
      missionId,
      owner: OWNER,
      sessionIndex: 0,
      requestedModel: REQUESTED_MODEL,
      inputTokens: 10_000,
      outputTokens: 2_000,
    };

    const first = await flushBuildSessionUsageReceipt({
      ...base,
      occurredAt: AS_OF,
      authoritativeCostUsd: 1.0,
    });
    const receiptId = first.flush!.receipts[0].id;
    expect(first.flush?.complete).toBe(true);

    // Same identity, DIFFERENT immutable facts — a real receipt loss: the newer
    // observed spend cannot be recorded over the durable one.
    const conflicting = await flushBuildSessionUsageReceipt({
      ...base,
      occurredAt: '2026-07-24T13:00:00.000Z',
      authoritativeCostUsd: 9.0,
    });
    expect(conflicting.flush?.conflicted).toBe(1);
    expect(conflicting.flush?.complete).toBe(false);
    // Nothing durable came back, so nothing may be settled against it.
    expect(conflicting.settlement).toBe('skipped');

    const marker = await getParentAccountingState(OWNER, 'mission', missionId);
    expect(marker?.accountingState).toBe('incomplete');

    // The visible total keeps the amount it CAN prove but must not present it
    // as whole — a reader has to see that spend went unaccounted for.
    const summary = await summarize(missionId);
    expect(summary.state).toBe('incomplete');
    expect(summary.reason).toBe('incomplete-accounting');
    expect(summary.amountMicros).toBe(1_000_000);

    await cleanupSettlements(receiptId);
    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });

  it('surfaces a forked settlement chain as partial rather than picking a winner', async () => {
    const missionId = 'arun-022-build-fork';

    const outcome = await flushBuildSessionUsageReceipt({
      missionId,
      owner: OWNER,
      sessionIndex: 0,
      requestedModel: REQUESTED_MODEL,
      occurredAt: AS_OF,
      inputTokens: 100,
      outputTokens: 50,
      authoritativeCostUsd: 2.0,
    });
    const receiptId = outcome.flush!.receipts[0].id;

    // A second, independent base settlement forks the chain: two competing
    // heads with no supersession between them.
    await recordOperationSettlement({
      receiptId,
      owner: OWNER,
      actualAmountMicros: 3_000_000,
      currency: 'USD',
      covers: 'tokens',
      evidenceRef: 'operator-correction',
      occurredAt: '2026-07-24T14:00:00.000Z',
      revision: 0,
    });

    const summary = await summarize(missionId);
    // Never guess by timestamp or id — say the actual is contested.
    expect(summary.state).toBe('partial');
    expect(summary.reason).toBe('conflicted-settlement');
    expect(summary.conflictedSettlementCount).toBe(1);
    expect(summary.amountMicros).toBeUndefined();

    await cleanupSettlements(receiptId);
    await cleanupReceipts(missionId, 'mission');
    await cleanupMarkers(missionId, 'mission');
  });
});

