/**
 * AI-029 — live Admin-SDK acceptance for terminal chat accounting.
 *
 * Proves against real Firestore that a provider model containing BOTH `/` and
 * `.` remains one literal modelUsage key, the receipt-derived amount is marked
 * estimated, and the full terminalize → receipt → per-batch loss marker →
 * AgentRun chain keeps an earlier failed provider attempt visible after a later
 * fallback succeeds under the same chat-turn correlation.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import { createAgentRun, patchAgentRunAccounting } from '@/lib/agent-runs';
import { terminalizeChatAccounting } from '@/lib/ai/chat-accounting';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import type { CapturedProviderUsage } from '@/lib/operation-context';

const COLLECTION = 'agentRuns';
const MODEL = 'anthropic/claude.sonnet-4.5';
const USER_ID = 'ai029-emulator-user';
const writtenIds = new Set<string>();
const correlationIds = new Set<string>();

afterAll(async () => {
  for (const id of writtenIds) {
    await adminDb.collection(COLLECTION).doc(id).delete().catch(() => undefined);
  }
  for (const correlationId of correlationIds) {
    for (const collection of ['operationReceipts', 'operationAccountingMarkers']) {
      const snapshot = await adminDb
        .collection(collection)
        .where(
          collection === 'operationReceipts' ? 'correlation.correlationId' : 'correlationId',
          '==',
          correlationId
        )
        .get();
      for (const doc of snapshot.docs) {
        await doc.ref.delete().catch(() => undefined);
      }
    }
  }
  await adminDb.terminate();
});

describe('AgentRun accounting patch (live emulator)', () => {
  it('keeps a dotted/slashed model literal and transitions estimate to unavailable truthfully', async () => {
    const run = await createAgentRun(
      {
        userId: USER_ID,
        kind: 'chat',
        provider: 'claude',
        agentName: 'chat',
        action: 'AI-029 emulator acceptance',
        status: 'success',
        model: MODEL,
        modelUsage: {
          [MODEL]: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 5,
          },
        },
        tokenUsage: { input: 105, output: 20 },
        costUnavailableReason: 'accounting-incomplete',
        duration: 10,
      },
      { deferGraphSync: true }
    );
    writtenIds.add(run.id);

    const usage = {
      model: MODEL,
      modelUsage: {
        [MODEL]: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          costUSD: 0.75,
        },
      },
      tokenUsage: { input: 105, output: 20 },
      tokenUsageProvenance: 'provider-reported' as const,
    };
    await patchAgentRunAccounting(run.id, { costUsd: 0.75 }, usage);
    const estimated = (await adminDb.collection(COLLECTION).doc(run.id).get()).data();
    expect(estimated).toMatchObject({ costUsd: 0.75, costState: 'estimated' });
    expect(Object.keys(estimated?.modelUsage ?? {})).toEqual([MODEL]);
    expect(estimated?.modelUsage[MODEL]).toMatchObject({ inputTokens: 100, outputTokens: 20, costUSD: 0.75 });
    expect(estimated?.modelUsage.anthropic).toBeUndefined();
    expect(estimated?.costUnavailableReason).toBeUndefined();

    await patchAgentRunAccounting(
      run.id,
      {
        costUsd: null,
        costUnavailableReason: 'unknown-pricing',
      },
      {
        ...usage,
        modelUsage: {
          [MODEL]: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 5,
          },
        },
      }
    );
    const unavailable = (await adminDb.collection(COLLECTION).doc(run.id).get()).data();
    expect(unavailable?.costUsd).toBeUndefined();
    expect(unavailable?.costState).toBeUndefined();
    expect(unavailable?.costUnavailableReason).toBe('unknown-pricing');
    expect(Object.keys(unavailable?.modelUsage ?? {})).toEqual([MODEL]);
    expect(unavailable?.modelUsage[MODEL].costUSD).toBeUndefined();
  });

  it('keeps provider-attempt marker batches distinct and rolls loss→fallback success up as incomplete', async () => {
    const requestId = `ai029-terminal-${Date.now()}`;
    correlationIds.add(requestId);
    const persistInput = {
      userId: USER_ID,
      provider: 'gemini' as const,
      model: 'gemini-3.1-pro-preview',
      status: 'failure' as const,
      durationMs: 15,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalInputTokens: 10,
      },
      toolCalls: [],
      requestId,
    };
    const baseCapture: CapturedProviderUsage = {
      provider: 'gemini',
      operation: 'gemini.chat',
      requestedModel: 'gemini-3.1-pro-preview',
      providerModel: 'gemini-3.1-pro-preview',
      counters: { promptTokens: 10, outputTokens: 2 },
      usageCompleteness: 'complete',
      occurredAt: '2026-07-23T10:00:00.000Z',
      feeState: 'none',
    };

    // Attempt 1 observed provider work but the immutable timestamp is malformed:
    // the receipt fails, while the content-free per-attempt marker still lands.
    const failed = await terminalizeChatAccounting(
      persistInput,
      [{ ...baseCapture, occurredAt: 'not-an-iso-timestamp' }]
    );
    writtenIds.add(failed.agentRunId);
    expect(failed.flush).toMatchObject({
      expected: 1,
      failed: 1,
      complete: false,
      markerPersisted: true,
    });
    expect(failed.costUsd).toBeNull();
    expect(failed.costUnavailableReason).toBe('accounting-incomplete');

    // Attempt 2 is a successful fallback under the SAME request correlation.
    // Its reserved AgentRun id creates a different marker batch.
    const succeeded = await terminalizeChatAccounting(
      { ...persistInput, status: 'success' },
      [baseCapture]
    );
    writtenIds.add(succeeded.agentRunId);
    expect(succeeded.flush).toMatchObject({
      expected: 1,
      written: 1,
      complete: true,
      markerPersisted: true,
    });
    expect(succeeded.costUsd).toEqual(expect.any(Number));
    expect(succeeded.agentRunId).not.toBe(failed.agentRunId);

    const parent = await getParentAccountingState(
      `user:${USER_ID}`,
      'chat-turn',
      requestId
    );
    expect(parent).toMatchObject({
      accountingState: 'incomplete',
      batchCount: 2,
      expected: 2,
      written: 1,
      failed: 1,
    });

    const markers = await adminDb
      .collection('operationAccountingMarkers')
      .where('owner', '==', `user:${USER_ID}`)
      .where('parentType', '==', 'chat-turn')
      .where('correlationId', '==', requestId)
      .get();
    expect(markers.docs.map((doc) => doc.data().batchId).sort()).toEqual(
      [failed.agentRunId, succeeded.agentRunId].sort()
    );

    const failedRun = (await adminDb.collection(COLLECTION).doc(failed.agentRunId).get()).data();
    expect(failedRun).toMatchObject({
      costUnavailableReason: 'accounting-incomplete',
      modelUsage: {},
      // The timestamp prevented receipt persistence, not provider observation.
      // Keep the known aggregate counters while leaving model attribution
      // unproven and the cost visibly incomplete.
      tokenUsage: { input: 10, output: 2 },
    });
    expect(failedRun?.model).toBeUndefined();
    expect(failedRun?.costUsd).toBeUndefined();

    const succeededRun = (await adminDb.collection(COLLECTION).doc(succeeded.agentRunId).get()).data();
    expect(succeededRun).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      costState: 'estimated',
      tokenUsage: { input: 10, output: 2 },
      modelUsage: {
        'gemini-3.1-pro-preview': expect.objectContaining({
          inputTokens: 10,
          outputTokens: 2,
          costUSD: expect.any(Number),
        }),
      },
    });
  });
});
