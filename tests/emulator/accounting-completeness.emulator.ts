/**
 * ARUN-022 / AI-029 / TEST-021 — live Admin-SDK acceptance for the accounting
 * surface this lane completed, against a REAL Firestore emulator (no mocks).
 *
 * The sibling `arun-022-accounting-producers.emulator.ts` covers the producers
 * that already existed. This file covers what did not:
 *   1. NESTED tool provider calls under a chat turn — distinct durable receipts,
 *      per-tool attribution, and a replay that is idempotent rather than a
 *      conflict;
 *   2. a tool that FAILED or timed out after the provider was already paid;
 *   3. the mission AUXILIARY stages (classifier / judge / fact-check / reflection)
 *      aggregating with the orchestrator envelope under one mission;
 *   4. a provider fee the provider never priced — the token cost must persist and
 *      the roll-up must refuse to call the total whole;
 *   5. zero-cost settlement, missing cache facts, and a conflicting settlement
 *      chain, read back through the canonical roll-up;
 *   6. benchmark/runtime parity — the figure a benchmark prints and the amount a
 *      stored receipt carries for the same response must be the same integer.
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

export {};

import { db as adminDb } from '@/lib/firebase-admin';
import { flushCapturedUsage } from '@/lib/operation-receipt-instrument';
import { getOperationReceipt, listOperationReceiptsByCorrelation } from '@/lib/operation-receipt-repository';
import {
  listOperationSettlementsByReceipt,
  recordOperationSettlement,
  resolveSettledAmount,
} from '@/lib/operation-settlement-repository';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import { flushMissionUsageReceipts } from '@/lib/mission-usage-receipts';
import { flushMissionStageUsage, withMissionStageReceipts } from '@/lib/mission-stage-usage';
import { withNestedToolUsageCapture } from '@/lib/nested-provider-usage';
import { captureProviderUsage, type CapturedProviderUsage } from '@/lib/operation-context';
import { summarizeOperationAccounting } from '@/lib/operation-accounting-summary';
import { priceGeminiBenchmarkUsage } from '../../scripts/lib/benchmark-usage';
import type { OperationParentType } from '@/lib/schemas/operation-receipt';

const OWNER = 'user-accounting-completeness-emulator';
const AS_OF = '2026-07-29T12:00:00.000Z';

/** A complete, priceable Gemini response (1M flash input tokens = exactly $1.50). */
function geminiCapture(overrides: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage {
  return {
    provider: 'gemini',
    operation: 'gemini.generate-text',
    requestedModel: 'gemini-3.5-flash',
    providerModel: 'gemini-3.5-flash',
    counters: { promptTokens: 1_000_000, outputTokens: 0 },
    usageCompleteness: 'complete',
    occurredAt: AS_OF,
    feeState: 'none',
    ...overrides,
  };
}

async function cleanup(correlationId: string, parentType: OperationParentType) {
  const receipts = await listOperationReceiptsByCorrelation(OWNER, parentType, correlationId);
  for (const receipt of receipts) {
    // eslint-disable-next-line no-await-in-loop
    const settlements = await listOperationSettlementsByReceipt(OWNER, receipt.id);
    for (const settlement of settlements) {
      // eslint-disable-next-line no-await-in-loop
      await adminDb
        .collection('operationSettlements')
        .doc(settlement.id)
        .delete()
        .catch(() => undefined);
    }
    // eslint-disable-next-line no-await-in-loop
    await adminDb
      .collection('operationReceipts')
      .doc(receipt.id)
      .delete()
      .catch(() => undefined);
  }
  const markers = await adminDb
    .collection('operationAccountingMarkers')
    .where('owner', '==', OWNER)
    .where('parentType', '==', parentType)
    .where('correlationId', '==', correlationId)
    .get();
  for (const doc of markers.docs) {
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.delete().catch(() => undefined);
  }
}

/** Read a parent's whole ledger back through the ONE canonical roll-up. */
async function summarize(parentType: OperationParentType, correlationId: string) {
  const receipts = await listOperationReceiptsByCorrelation(OWNER, parentType, correlationId);
  const resolved = [];
  for (const receipt of receipts) {
    // eslint-disable-next-line no-await-in-loop
    resolved.push({ receipt, resolution: await resolveSettledAmount(OWNER, receipt.id) });
  }
  const markerState = await getParentAccountingState(OWNER, parentType, correlationId);
  return summarizeOperationAccounting(resolved, markerState);
}

afterAll(async () => {
  await adminDb.terminate();
});

describe('nested chat-tool provider spend (live emulator)', () => {
  it('persists the main model AND each nested tool call as distinct attributed receipts', async () => {
    const correlationId = 'acct-completeness-nested';
    const agentRunId = 'run-acct-nested';
    const captured: CapturedProviderUsage[] = [];

    // The turn's main model response.
    captured.push(geminiCapture({ operation: 'gemini.chat' }));
    // Two DIFFERENT tools, each making the same chokepoint call. Without per-tool
    // attribution these would derive one identity and one would be lost.
    await withNestedToolUsageCapture('deepResearch', captured, async () => {
      captureProviderUsage(geminiCapture());
    });
    await withNestedToolUsageCapture('searchPapers', captured, async () => {
      captureProviderUsage(geminiCapture());
    });

    const flush = await flushCapturedUsage(
      { parentType: 'chat-turn', owner: OWNER, correlationId, agentRunId },
      captured,
      agentRunId,
      'included-in-parent'
    );

    expect(flush.complete).toBe(true);
    expect(flush.written).toBe(3);
    // Three receipts, three distinct durable ids — no silent collapse.
    expect(new Set(flush.receipts.map((r) => r.id)).size).toBe(3);

    const stored = await listOperationReceiptsByCorrelation(OWNER, 'chat-turn', correlationId);
    expect(stored.map((r) => r.operation).sort()).toEqual([
      'gemini.chat',
      'tool.deepresearch.gemini.generate-text',
      'tool.searchpapers.gemini.generate-text',
    ]);
    // Each nested response prices on its own: 1M flash input tokens = $1.50.
    for (const receipt of stored) {
      expect(receipt.cost).toMatchObject({ state: 'estimated', amountMicros: 1_500_000, currency: 'USD' });
      expect(receipt.accountingScope).toBe('included-in-parent');
    }

    // The whole turn rolls up to exactly the sum of its parts.
    const summary = await summarize('chat-turn', correlationId);
    expect(summary).toMatchObject({ state: 'estimated', amountMicros: 4_500_000, receiptCount: 3 });

    // An exact re-flush of the same turn is idempotent, not a conflict.
    const replay = await flushCapturedUsage(
      { parentType: 'chat-turn', owner: OWNER, correlationId, agentRunId },
      captured,
      agentRunId,
      'included-in-parent'
    );
    expect(replay.replayed).toBe(3);
    expect(replay.conflicted).toBe(0);
    expect((await listOperationReceiptsByCorrelation(OWNER, 'chat-turn', correlationId)).length).toBe(3);

    await cleanup(correlationId, 'chat-turn');
  });

  it('records spend from a tool that FAILED after the provider was already paid', async () => {
    const correlationId = 'acct-completeness-nested-failure';
    const agentRunId = 'run-acct-nested-failure';
    const captured: CapturedProviderUsage[] = [];

    await expect(
      withNestedToolUsageCapture('deepResearch', captured, async () => {
        captureProviderUsage(geminiCapture());
        throw new Error('research backend exploded');
      })
    ).rejects.toThrow('research backend exploded');

    const flush = await flushCapturedUsage(
      { parentType: 'chat-turn', owner: OWNER, correlationId, agentRunId },
      captured,
      agentRunId,
      'included-in-parent'
    );
    expect(flush.written).toBe(1);
    const stored = await getOperationReceipt(OWNER, flush.receipts[0].id);
    expect(stored?.operation).toBe('tool.deepresearch.gemini.generate-text');
    expect(stored?.cost).toMatchObject({ state: 'estimated', amountMicros: 1_500_000 });

    await cleanup(correlationId, 'chat-turn');
  });

  it('records a response that arrives AFTER a read timeout rejected', async () => {
    const correlationId = 'acct-completeness-nested-timeout';
    const agentRunId = 'run-acct-nested-timeout';
    const captured: CapturedProviderUsage[] = [];
    let release: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });

    await expect(
      withNestedToolUsageCapture('deepResearch', captured, () => {
        const work = late.then(() => captureProviderUsage(geminiCapture({ operation: 'gemini.slow' })));
        return Promise.race([work, Promise.reject(new Error('timeout: tool:deepResearch'))]);
      })
    ).rejects.toThrow('timeout');
    expect(captured).toHaveLength(0);

    release();
    await late;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured).toHaveLength(1);

    const flush = await flushCapturedUsage(
      { parentType: 'chat-turn', owner: OWNER, correlationId, agentRunId },
      captured,
      agentRunId,
      'included-in-parent'
    );
    expect(flush.written).toBe(1);
    expect((await getOperationReceipt(OWNER, flush.receipts[0].id))?.operation).toBe('tool.deepresearch.gemini.slow');

    await cleanup(correlationId, 'chat-turn');
  });
});

describe('mission auxiliary stages aggregate with the orchestrator envelope (live emulator)', () => {
  it('rolls the classifier, judge, fact-check and orchestrator into ONE mission total', async () => {
    const missionId = 'acct-completeness-mission';

    // The dispatch classifier bills before the mission id exists.
    await flushMissionStageUsage({ missionId, owner: OWNER, stage: 'classifier' }, [
      geminiCapture({ operation: 'gemini.generate-structured' }),
    ]);
    // The judge and two fact-checks run inside memoized mission steps.
    await withMissionStageReceipts({ missionId, owner: OWNER, stage: 'judge' }, async () => {
      captureProviderUsage(geminiCapture({ operation: 'gemini.generate-structured' }));
    });
    await withMissionStageReceipts({ missionId, owner: OWNER, stage: 'fact-check', sequence: 0 }, async () => {
      captureProviderUsage(geminiCapture({ operation: 'gemini.grounded-generate' }));
    });
    await withMissionStageReceipts({ missionId, owner: OWNER, stage: 'fact-check', sequence: 1 }, async () => {
      captureProviderUsage(geminiCapture({ operation: 'gemini.grounded-generate' }));
    });
    // The Anthropic orchestrator envelope, settled by the SDK's own cost.
    await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, costUSD: 2.5 },
      },
    });

    const stored = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    // 4 Gemini stage receipts + 1 orchestrator receipt, all under one mission.
    expect(stored).toHaveLength(5);
    // The two fact-check runs are SEPARATE spend, not one conflicting replay.
    expect(stored.filter((r) => r.operation === 'gemini.grounded-generate')).toHaveLength(2);
    for (const receipt of stored) expect(receipt.accountingScope).toBe('included-in-parent');

    const marker = await getParentAccountingState(OWNER, 'mission', missionId);
    expect(marker?.accountingState).toBe('complete');

    const summary = await summarize('mission', missionId);
    // 4 Gemini stages at $1.50 = $6.00, plus the orchestrator's SETTLED $2.50.
    expect(summary.amountMicros).toBe(8_500_000);
    expect(summary.settledCount).toBe(1);
    expect(summary.estimatedCount).toBe(4);
    // The mission headline already counts every one of these, so nothing is
    // additive across parents.
    expect(summary.notDoubleCountedMicros).toBe(0);

    await cleanup(missionId, 'mission');
  });

  it('is idempotent when a stage is replayed and separates a second run of the same stage', async () => {
    const missionId = 'acct-completeness-mission-replay';
    const capture = [geminiCapture({ operation: 'gemini.generate-structured' })];

    const first = await flushMissionStageUsage({ missionId, owner: OWNER, stage: 'judge' }, capture);
    const replay = await flushMissionStageUsage({ missionId, owner: OWNER, stage: 'judge' }, capture);
    expect(first?.written).toBe(1);
    expect(replay?.replayed).toBe(1);
    expect(replay?.conflicted).toBe(0);

    // A DIFFERENT stage sequence is different spend and gets its own receipt.
    const second = await flushMissionStageUsage({ missionId, owner: OWNER, stage: 'fact-check', sequence: 1 }, capture);
    expect(second?.written).toBe(1);
    expect(await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId)).toHaveLength(2);

    await cleanup(missionId, 'mission');
  });
});

describe('provider fees, settlement and completeness (live emulator)', () => {
  it('keeps the TOKEN cost of a grounded response and refuses to call the total whole', async () => {
    const missionId = 'acct-completeness-fee';
    await flushMissionStageUsage({ missionId, owner: OWNER, stage: 'fact-check' }, [
      geminiCapture({ operation: 'gemini.grounded-generate', feeState: 'applicable-but-unknown' }),
    ]);

    const stored = (await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId))[0];
    expect(stored.feeState).toBe('applicable-but-unknown');
    // The tokens WERE billed and their price is exactly derivable; only the
    // free-tier-windowed search fee is unknown.
    expect(stored.cost).toMatchObject({ state: 'estimated', amountMicros: 1_500_000, covers: 'tokens' });

    const summary = await summarize('mission', missionId);
    expect(summary.amountMicros).toBe(1_500_000);
    expect(summary.state).toBe('incomplete');
    expect(summary.reason).toBe('fee-unaccounted');
    expect(summary.feeUnaccountedCount).toBe(1);

    await cleanup(missionId, 'mission');
  });

  it('records a provider-reported ZERO cost as settled at $0, not as unpriced', async () => {
    const missionId = 'acct-completeness-zero-settlement';
    const outcome = await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUSD: 0 } },
    });
    expect(outcome.settlements['claude-haiku-4-5']).toBe('settled');

    const summary = await summarize('mission', missionId);
    expect(summary.state).toBe('settled');
    expect(summary.amountMicros).toBe(0);
    expect(summary.settledCount).toBe(1);

    await cleanup(missionId, 'mission');
  });

  it('leaves a receipt with MISSING cache facts unpriced rather than guessing a split', async () => {
    const missionId = 'acct-completeness-missing-cache';
    // No per-model cache fact at all: the SDK reported only aggregate tokens.
    await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 1000, outputTokens: 500 } },
    });

    const stored = (await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId))[0];
    expect(stored.usageCompleteness).toBe('partial');
    expect(stored.cost).toEqual({ state: 'unavailable', reason: 'missing-usage' });

    const summary = await summarize('mission', missionId);
    // Nothing summable and nothing lost — there is simply no priceable row.
    expect(summary.amountMicros).toBeUndefined();
    expect(summary.unavailableCount).toBe(1);

    await cleanup(missionId, 'mission');
  });

  it('reports a conflicting settlement chain as partial, never picking a winner', async () => {
    const missionId = 'acct-completeness-conflicted-settlement';
    const outcome = await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, costUSD: 1 },
      },
    });
    const receiptId = outcome.flush!.receipts[0].id;

    // A SECOND base settlement from a different evidence source: two competing
    // heads, so the row's actual is genuinely indeterminate.
    await recordOperationSettlement({
      receiptId,
      owner: OWNER,
      actualAmountMicros: 9_000_000,
      currency: 'USD',
      covers: 'tokens',
      evidenceRef: 'billing-export-2026-07',
      occurredAt: AS_OF,
      revision: 0,
    });
    expect(await listOperationSettlementsByReceipt(OWNER, receiptId)).toHaveLength(2);

    const summary = await summarize('mission', missionId);
    expect(summary.state).toBe('partial');
    expect(summary.reason).toBe('conflicted-settlement');
    expect(summary.conflictedSettlementCount).toBe(1);
    // Neither competing amount is presented as the answer.
    expect(summary.amountMicros).toBeUndefined();

    await cleanup(missionId, 'mission');
  });
});

describe('benchmark/runtime parity against the stored receipt (live emulator)', () => {
  it('prints the same integer amount the durable receipt carries for the same response', async () => {
    const correlationId = 'acct-completeness-benchmark-parity';
    const usage = { promptTokenCount: 123_456, candidatesTokenCount: 7_890, thoughtsTokenCount: 1_234 };

    const flush = await flushCapturedUsage(
      { parentType: 'job-run', owner: OWNER, correlationId, inngestRunId: correlationId },
      [
        geminiCapture({
          counters: {
            promptTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
            thinkingTokens: usage.thoughtsTokenCount,
          },
        }),
      ],
      `benchmark-${correlationId}`,
      'standalone'
    );

    const stored = await getOperationReceipt(OWNER, flush.receipts[0].id);
    const benchmark = priceGeminiBenchmarkUsage({
      requestedModel: 'gemini-3.5-flash',
      providerModel: 'gemini-3.5-flash',
      usage,
      occurredAt: AS_OF,
    });

    if (!benchmark.ok) throw new Error(`benchmark unavailable: ${benchmark.reason}`);
    if (stored?.cost.state !== 'estimated') throw new Error(`receipt unpriced: ${JSON.stringify(stored?.cost)}`);
    // Exact integer equality against what Firestore actually holds.
    expect(benchmark.amountMicros).toBe(stored.cost.amountMicros);
    expect(benchmark.rateCardVersion).toBe(stored.cost.rateCardVersion);

    await cleanup(correlationId, 'job-run');
  });
});
