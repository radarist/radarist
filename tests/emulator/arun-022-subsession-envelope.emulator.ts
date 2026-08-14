/**
 * ARUN-022 / AI-029 — live Admin-SDK acceptance for the LAST accounting gap:
 * the out-of-process Anthropic helper/revision sub-sessions, and the build
 * sandbox session's upgrade from one aggregate receipt to one receipt per
 * SERVED model.
 *
 * These contracts cannot be proven by mocks, because every one of them is about
 * what the persistence boundary does with a real identity:
 *   1. A revision turn and a skill-prelude helper each become durable receipts
 *      with their own operation, `provider-reported` served model, real counters
 *      and an append-only settlement carrying that model's own cost.
 *   2. Sub-session receipts never collide with the mission's MAIN turn even
 *      though all three share one correlationId — the exact defect the
 *      per-envelope invocation prefixes exist to prevent.
 *   3. Several revisions of one mission keep DISTINCT identities, so a second
 *      attempt cannot overwrite the first's spend.
 *   4. An exact re-flush replays idempotently (no duplicate receipt, no second
 *      settlement); a genuinely different observation on the same identity is
 *      reported as a LOSS rather than silently merged.
 *   5. Missing provider facts stay honestly `partial`/`unavailable` and settle
 *      nothing — never a fabricated $0.
 *   6. A build session with `modelUsage` records one COMPLETE receipt per served
 *      model whose settlements sum to the session `total_cost_usd`, with the
 *      session total deliberately NOT settled again on top.
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

export {};

import { db as adminDb } from '@/lib/firebase-admin';
import { getOperationReceipt, listOperationReceiptsByCorrelation } from '@/lib/operation-receipt-repository';
import { listOperationSettlementsByReceipt } from '@/lib/operation-settlement-repository';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import {
  flushBuildSessionUsageReceipt,
  flushMissionUsageReceipts,
  flushSubSessionUsageReceipts,
} from '@/lib/mission-usage-receipts';

const OWNER = 'user-arun-022-subsession';
const AS_OF = '2026-07-29T09:00:00.000Z';

const REVISION_USAGE = {
  'claude-sonnet-4-6': {
    inputTokens: 900,
    outputTokens: 400,
    cacheReadInputTokens: 12_000,
    cacheCreationInputTokens: 800,
    costUSD: 0.21,
  },
};

async function cleanupMission(missionId: string) {
  const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
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
    .where('parentType', '==', 'mission')
    .where('correlationId', '==', missionId)
    .get();
  for (const doc of markers.docs) {
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.delete().catch(() => undefined);
  }
}

afterAll(async () => {
  await adminDb.terminate();
});

describe('ARUN-022/AI-029 — helper + revision sub-session receipts (live emulator)', () => {
  it('persists a revision turn with its served model, counters, and provider-actual settlement', async () => {
    const missionId = 'arun-022-sub-revision';
    await cleanupMission(missionId);

    const outcome = await flushSubSessionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'revision',
      sessionKey: 'attempt-1-1753776000000',
      modelUsage: REVISION_USAGE,
    });

    expect(outcome.flush?.complete).toBe(true);
    expect(outcome.flush?.written).toBe(1);
    expect(outcome.settlements['claude-sonnet-4-6']).toBe('settled');

    const receiptId = outcome.flush!.receipts[0].id;
    const stored = await getOperationReceipt(OWNER, receiptId);
    expect(stored?.provider).toBe('anthropic');
    expect(stored?.operation).toBe('anthropic.revision-turn');
    // The whole point of the row: a SERVED model, not a requested-model guess.
    expect(stored?.model).toBe('claude-sonnet-4-6');
    expect(stored?.modelProvenance).toBe('provider-reported');
    expect(stored?.counters).toEqual({
      promptTokens: 900,
      outputTokens: 400,
      cacheReadTokens: 12_000,
      cacheWrite5mTokens: 800,
    });
    expect(stored?.usageCompleteness).toBe('complete');
    expect(stored?.occurredAt).toBe(AS_OF);
    // The mission headline already sums the revision turn.
    expect(stored?.accountingScope).toBe('included-in-parent');
    // The receipt's own cost is the DERIVED canonical estimate, never the
    // provider actual — that arrives as the settlement below.
    expect(stored?.cost.state).not.toBe('actual');

    const settlements = await listOperationSettlementsByReceipt(OWNER, receiptId);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].actualAmountMicros).toBe(210_000); // $0.21
    expect(settlements[0].currency).toBe('USD');
    expect(settlements[0].covers).toBe('tokens');

    const marker = await getParentAccountingState(OWNER, 'mission', missionId);
    expect(marker?.accountingState).toBe('complete');

    await cleanupMission(missionId);
  });

  it('persists a skill-prelude helper under its own operation', async () => {
    const missionId = 'arun-022-sub-prelude';
    await cleanupMission(missionId);

    const outcome = await flushSubSessionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'skill-prelude',
      sessionKey: '3-1753776000000',
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 900, costUSD: 0.031 },
      },
    });

    const stored = await getOperationReceipt(OWNER, outcome.flush!.receipts[0].id);
    expect(stored?.operation).toBe('anthropic.prelude-turn');
    expect(stored?.model).toBe('claude-sonnet-4-6');

    const settlements = await listOperationSettlementsByReceipt(OWNER, outcome.flush!.receipts[0].id);
    expect(settlements[0].actualAmountMicros).toBe(31_000); // $0.031

    await cleanupMission(missionId);
  });

  it('keeps main-turn, revision, and prelude receipts DISTINCT under one mission correlation', async () => {
    const missionId = 'arun-022-sub-no-collision';
    await cleanupMission(missionId);

    // All three envelopes share the same correlationId — only the invocation
    // prefix and operation keep them apart. If they collided, the later flush
    // would conflict and real spend would be lost.
    await flushMissionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 5_000, outputTokens: 2_000, cacheReadInputTokens: 40_000, costUSD: 1.1 },
      },
    });
    await flushSubSessionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'revision',
      sessionKey: 'attempt-1-1753776000000',
      modelUsage: REVISION_USAGE,
    });
    await flushSubSessionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'skill-prelude',
      sessionKey: '0-1753776000000',
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 900, costUSD: 0.031 },
      },
    });

    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((r) => r.id)).size).toBe(3);
    expect(receipts.map((r) => r.operation).sort()).toEqual([
      'anthropic.mission-turn',
      'anthropic.prelude-turn',
      'anthropic.revision-turn',
    ]);
    // Every receipt attributes to the same mission and adds ZERO to a
    // cross-parent aggregate.
    for (const receipt of receipts) {
      expect(receipt.accountingScope).toBe('included-in-parent');
    }

    const marker = await getParentAccountingState(OWNER, 'mission', missionId);
    expect(marker?.accountingState).toBe('complete');

    await cleanupMission(missionId);
  });

  it('gives multiple revisions of one mission distinct receipts, so none overwrites another', async () => {
    const missionId = 'arun-022-sub-multi-revision';
    await cleanupMission(missionId);

    for (const [index, key] of ['attempt-1-1753776000000', 'attempt-1-1753776900000'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await flushSubSessionUsageReceipts({
        missionId,
        owner: OWNER,
        asOf: AS_OF,
        kind: 'revision',
        sessionKey: key,
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 900 + index,
            outputTokens: 400,
            cacheReadInputTokens: 12_000,
            costUSD: 0.21,
          },
        },
      });
      expect(outcome.flush?.written).toBe(1);
      expect(outcome.flush?.conflicted).toBe(0);
    }

    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(2);
    // Both attempts' spend survives.
    expect(receipts.map((r) => r.counters.promptTokens).sort()).toEqual([900, 901]);

    await cleanupMission(missionId);
  });

  it('replays an exact re-flush idempotently — no duplicate receipt, no second settlement', async () => {
    const missionId = 'arun-022-sub-replay';
    await cleanupMission(missionId);

    const input = {
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'revision' as const,
      sessionKey: 'attempt-1-1753776000000',
      modelUsage: REVISION_USAGE,
    };

    const first = await flushSubSessionUsageReceipts(input);
    expect(first.flush?.written).toBe(1);

    const replay = await flushSubSessionUsageReceipts(input);
    expect(replay.flush?.replayed).toBe(1);
    expect(replay.flush?.written).toBe(0);
    expect(replay.flush?.receipts[0].id).toBe(first.flush!.receipts[0].id);

    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(1);
    const settlements = await listOperationSettlementsByReceipt(OWNER, first.flush!.receipts[0].id);
    expect(settlements).toHaveLength(1);

    await cleanupMission(missionId);
  });

  it('reports a DIFFERENT observation on the same identity as a loss, never a silent merge', async () => {
    const missionId = 'arun-022-sub-conflict';
    await cleanupMission(missionId);

    const base = {
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'revision' as const,
      sessionKey: 'attempt-1-1753776000000',
    };

    await flushSubSessionUsageReceipts({ ...base, modelUsage: REVISION_USAGE });
    // Same identity, genuinely different counters — the durable facts disagree.
    const conflicting = await flushSubSessionUsageReceipts({
      ...base,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 5_555, outputTokens: 400, cacheReadInputTokens: 12_000, costUSD: 0.21 },
      },
    });

    expect(conflicting.flush?.conflicted).toBe(1);
    expect(conflicting.flush?.complete).toBe(false);

    // The loss is durably VISIBLE, not swallowed.
    const marker = await getParentAccountingState(OWNER, 'mission', missionId);
    expect(marker?.accountingState).not.toBe('complete');

    // The original facts are preserved — the newer observation did not overwrite.
    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].counters.promptTokens).toBe(900);

    await cleanupMission(missionId);
  });

  it('records missing provider facts as partial/unavailable and settles nothing — never a fabricated $0', async () => {
    const missionId = 'arun-022-sub-missing-facts';
    await cleanupMission(missionId);

    const outcome = await flushSubSessionUsageReceipts({
      missionId,
      owner: OWNER,
      asOf: AS_OF,
      kind: 'revision',
      sessionKey: 'attempt-1-1',
      // No cache facts and no cost — a genuinely under-reporting provider.
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 4 } },
    });

    expect(outcome.settlements['claude-sonnet-4-6']).toBe('skipped');

    const stored = await getOperationReceipt(OWNER, outcome.flush!.receipts[0].id);
    expect(stored?.usageCompleteness).toBe('partial');
    // An absent cache fact must never be persisted as a known zero.
    expect(stored?.counters.cacheReadTokens).toBeUndefined();

    const settlements = await listOperationSettlementsByReceipt(OWNER, outcome.flush!.receipts[0].id);
    expect(settlements).toHaveLength(0);

    await cleanupMission(missionId);
  });
});

describe('ARUN-022/AI-029 — build session, per-served-model granularity (live emulator)', () => {
  // The exact shape of the retained real transcript
  // (agent/tests/fixtures/stream-json/session-1.jsonl).
  const FIXTURE_MODEL_USAGE = {
    'claude-sonnet-4-6': {
      inputTokens: 79,
      outputTokens: 18_230,
      cacheReadInputTokens: 3_046_866,
      cacheCreationInputTokens: 66_009,
      costUSD: 1.4352805499999994,
    },
    'claude-haiku-4-5-20251001': {
      inputTokens: 451,
      outputTokens: 16,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000531,
    },
  };
  const FIXTURE_TOTAL_COST_USD = 1.4358115499999995;

  it('records one COMPLETE receipt per served model and settles each with its own cost', async () => {
    const missionId = 'arun-022-build-per-model';
    await cleanupMission(missionId);

    const outcome = await flushBuildSessionUsageReceipt({
      missionId,
      owner: OWNER,
      sessionIndex: 0,
      requestedModel: 'claude-sonnet-5',
      occurredAt: AS_OF,
      authoritativeCostUsd: FIXTURE_TOTAL_COST_USD,
      modelUsage: FIXTURE_MODEL_USAGE,
      cacheCreation: { ephemeral5mInputTokens: 66_009, ephemeral1hInputTokens: 0 },
    });

    expect(outcome.granularity).toBe('per-served-model');
    expect(outcome.flush?.complete).toBe(true);
    expect(outcome.flush?.written).toBe(2);

    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(2);

    const sonnet = receipts.find((r) => r.model === 'claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    expect(sonnet!.operation).toBe('anthropic.build-session');
    // The requested-model guess is gone — the CLI told us what it served.
    expect(sonnet!.modelProvenance).toBe('provider-reported');
    expect(sonnet!.counters).toEqual({
      promptTokens: 79,
      outputTokens: 18_230,
      cacheReadTokens: 3_046_866,
      cacheWrite5mTokens: 66_009,
    });
    // With the provider's own tier split, the counters are genuinely complete —
    // this session used to be recorded as `partial` with an unavailable estimate.
    expect(sonnet!.usageCompleteness).toBe('complete');

    // The auxiliary model the per-response stream never exposes is receipted too.
    const haiku = receipts.find((r) => r.model === 'claude-haiku-4-5-20251001');
    expect(haiku).toBeDefined();
    expect(haiku!.counters.promptTokens).toBe(451);

    // ANTI-DOUBLE-COUNT: the per-model settlements reproduce the session total,
    // and the session total is NOT settled again on top of them.
    expect(outcome.settlement).toBe('skipped');
    let settledMicros = 0;
    let settlementCount = 0;
    for (const receipt of receipts) {
      // eslint-disable-next-line no-await-in-loop
      const settlements = await listOperationSettlementsByReceipt(OWNER, receipt.id);
      settlementCount += settlements.length;
      for (const settlement of settlements) settledMicros += settlement.actualAmountMicros;
    }
    expect(settlementCount).toBe(2);
    expect(settledMicros).toBe(Math.round(FIXTURE_TOTAL_COST_USD * 1_000_000));

    await cleanupMission(missionId);
  });

  it('replays a supervisor retry of the per-model path without duplicating anything', async () => {
    const missionId = 'arun-022-build-per-model-replay';
    await cleanupMission(missionId);

    const input = {
      missionId,
      owner: OWNER,
      sessionIndex: 0,
      requestedModel: 'claude-sonnet-5',
      occurredAt: AS_OF,
      authoritativeCostUsd: FIXTURE_TOTAL_COST_USD,
      modelUsage: FIXTURE_MODEL_USAGE,
      cacheCreation: { ephemeral5mInputTokens: 66_009, ephemeral1hInputTokens: 0 },
    };

    await flushBuildSessionUsageReceipt(input);
    const replay = await flushBuildSessionUsageReceipt(input);

    expect(replay.flush?.replayed).toBe(2);
    expect(replay.flush?.written).toBe(0);

    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      // eslint-disable-next-line no-await-in-loop
      const settlements = await listOperationSettlementsByReceipt(OWNER, receipt.id);
      expect(settlements).toHaveLength(1);
    }

    await cleanupMission(missionId);
  });

  it('still falls back to the session aggregate when the CLI reported no modelUsage', async () => {
    const missionId = 'arun-022-build-aggregate-fallback';
    await cleanupMission(missionId);

    const outcome = await flushBuildSessionUsageReceipt({
      missionId,
      owner: OWNER,
      sessionIndex: 1,
      requestedModel: 'claude-sonnet-5',
      occurredAt: AS_OF,
      inputTokens: 52_000,
      outputTokens: 18_000,
      authoritativeCostUsd: 4.25,
    });

    expect(outcome.granularity).toBe('session-aggregate');
    const receipts = await listOperationReceiptsByCorrelation(OWNER, 'mission', missionId);
    expect(receipts).toHaveLength(1);
    // Honest about what was NOT proven: the served model is a requested fallback
    // and the counters are partial, so the estimate fails closed.
    expect(receipts[0].modelProvenance).toBe('requested-fallback');
    expect(receipts[0].usageCompleteness).toBe('partial');
    expect(outcome.settlement).toBe('settled');

    await cleanupMission(missionId);
  });
});
