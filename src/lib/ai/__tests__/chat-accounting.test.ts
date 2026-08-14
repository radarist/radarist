/**
 * @file lib/ai/__tests__/chat-accounting.test.ts
 * @description AI-029 — canonical per-response accounting for the AI chat sink.
 *
 * Exercises the REAL `terminalizeChatAccounting` + `flushCapturedUsage` stack
 * (with the REAL pricing kernel) against an in-memory receipt store, so the
 * per-response pricing/tier/cache/replay/conflict/marker/content-leak contracts
 * are proven without a live provider or a durable Firestore. The route-level
 * seams (Gemini `sendMessage`, Anthropic `messages.create`) are mocked; the
 * accounting + pricing + receipt identity are REAL.
 *
 * Mandatory adversarial coverage:
 *  1. two Gemini responses in one turn, one <200k and one >200k, each its tier;
 *  2. Gemini cached-subset billing with no 0.25 factor and no double billing;
 *  3. two responses served by different models; earlier usage not repriced by
 *     the last model;
 *  4. missing/fractional/negative/NaN/infinite/cached>prompt counters fail
 *     closed; explicit zero stays distinct from absent;
 *  5. Anthropic ordinary input/cache-read separation, no guessed cache-write
 *     tier;
 *  6. OpenRouter counters persist while pricing stays unavailable;
 *  7. paid failure followed by fallback preserves distinct attempt truth;
 *  8. exact replay, conflict, receipt-write failure, marker-write failure;
 *  9. content-leak regression — accounting records contain no prompts/responses.
 *
 * @jest-environment node
 */

import { priceReceiptCounters } from '@/lib/operation-receipt-pricing';
import { geminiUsageToReceipt } from '@/lib/operation-usage-map';
import { deriveOperationReceiptId, receiptIdentity, type OperationReceipt } from '@/lib/schemas/operation-receipt';
import type { CapturedProviderUsage } from '@/lib/operation-context';
import type { ChatAccountingPersistInput } from '@/lib/ai/chat-accounting';

// ---------------------------------------------------------------------------
// In-memory receipt store — stands in for Firestore. Derives the SAME canonical
// cost the real repository derives (via the real kernel) so headline derivation
// is exercised on real priced receipts, and supports conflict/replay/failure.
// ---------------------------------------------------------------------------

class InMemoryReceiptStore {
  private readonly store = new Map<string, { facts: string; receipt: OperationReceipt }>();
  public recordImpl:
    ((input: Record<string, unknown>) => Promise<{ receipt: OperationReceipt; outcome: string }>) | null = null;

  async record(
    input: Record<string, unknown>
  ): Promise<{ receipt: OperationReceipt; outcome: 'written' | 'replayed' | 'failed' }> {
    if (this.recordImpl) {
      const res = await this.recordImpl(input);
      return {
        receipt: res.receipt,
        outcome: res.outcome === 'replayed' ? 'replayed' : res.outcome === 'written' ? 'written' : 'failed',
      };
    }
    const cost = priceReceiptCounters({
      provider: input.provider as string,
      model: input.model as string | undefined,
      requestedModel: input.requestedModel as string | undefined,
      modelProvenance: input.modelProvenance as never,
      usageCompleteness: input.usageCompleteness as never,
      counters: input.counters as never,
      feeState: input.feeState as never,
      externalFees: input.externalFees as never,
      occurredAt: input.occurredAt as string,
    });
    const id = deriveOperationReceiptId(receiptIdentity(input as never));
    const facts = JSON.stringify({ ...input, cost });
    const existing = this.store.get(id);
    if (existing) {
      if (existing.facts === facts) return { receipt: existing.receipt, outcome: 'replayed' };
      // Conflicting replay — throw a REAL OperationReceiptConflictError instance
      // (from the mocked module) so the instrument's `instanceof` classifies it
      // as `conflicted` rather than a generic `failed`.
      throw new MockConflict();
    }
    const receipt = {
      ...input,
      cost,
      id,
      recordedAt: '2026-07-23T00:00:00.000Z',
      schemaVersion: 2,
    } as unknown as OperationReceipt;
    this.store.set(id, { facts, receipt });
    return { receipt, outcome: 'written' as const };
  }

  clear() {
    this.store.clear();
    this.recordImpl = null;
  }
}

const store = new InMemoryReceiptStore();

const mockRecordOperationReceiptWithOutcome = jest.fn(async (input: Record<string, unknown>) => {
  try {
    return await store.record(input);
  } catch (error) {
    // Re-throw conflict-shaped errors so the instrument classifies them.
    throw error;
  }
});

jest.mock('@/lib/operation-receipt-repository', () => {
  class OperationReceiptConflictError extends Error {
    constructor() {
      super('conflict');
      this.name = 'OperationReceiptConflictError';
    }
  }
  return {
    recordOperationReceiptWithOutcome: (input: unknown) =>
      mockRecordOperationReceiptWithOutcome(input as Record<string, unknown>),
    OperationReceiptConflictError,
  };
});
const { OperationReceiptConflictError: MockConflict } = jest.requireMock('@/lib/operation-receipt-repository') as {
  OperationReceiptConflictError: new () => Error;
};

const mockUpsertMarker = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/operation-accounting-marker-repository', () => ({
  upsertParentAccountingMarker: (input: unknown) => mockUpsertMarker(input),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

let runSeq = 0;
const mockGenerateAgentRunId = jest.fn(() => {
  runSeq += 1;
  return `run-chat-${runSeq}`;
});
const mockCreateAgentRun = jest.fn().mockImplementation((_input: unknown, options: { id?: string } = {}) => {
  return Promise.resolve({ id: options.id ?? 'run-chat-fallback' });
});
const mockPatchAgentRunAccounting = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/agent-runs', () => ({
  __esModule: true,
  generateAgentRunId: () => mockGenerateAgentRunId(),
  createAgentRun: (input: unknown, options: unknown) => mockCreateAgentRun(input, options),
  patchAgentRunAccounting: (runId: unknown, headline: unknown, usage: unknown) =>
    mockPatchAgentRunAccounting(runId, headline, usage),
}));

import {
  terminalizeChatAccounting,
  deriveHeadlineCost,
  captureChatProviderResponse,
  trackChatProviderAttempt,
} from '@/lib/ai/chat-accounting';
import { flushCapturedUsage } from '@/lib/operation-receipt-instrument';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput = (overrides: Partial<ChatAccountingPersistInput> = {}): ChatAccountingPersistInput => ({
  userId: 'user-1',
  provider: 'gemini',
  model: 'gemini-3.1-pro-preview',
  status: 'success',
  durationMs: 1000,
  usage: { inputTokens: 0, outputTokens: 0, totalInputTokens: 0 },
  toolCalls: [],
  requestId: 'req-1',
  ...overrides,
});

const geminiCapture = (overrides: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage => ({
  provider: 'gemini',
  operation: 'gemini.chat',
  requestedModel: 'gemini-3.1-pro-preview',
  providerModel: 'gemini-3.1-pro-preview',
  usageCompleteness: 'complete',
  occurredAt: '2026-07-23T00:00:00.000Z',
  feeState: 'none',
  counters: { promptTokens: 1000, outputTokens: 100 },
  ...overrides,
});

const anthropicCapture = (overrides: Partial<CapturedProviderUsage> = {}): CapturedProviderUsage => ({
  provider: 'claude',
  operation: 'claude.messages.create',
  requestedModel: 'claude-sonnet-4-6',
  providerModel: 'claude-sonnet-4-6',
  usageCompleteness: 'complete',
  occurredAt: '2026-07-23T00:00:00.000Z',
  feeState: 'none',
  counters: { promptTokens: 1000, outputTokens: 100 },
  ...overrides,
});

/** Narrow a receipt's discriminated cost to the `estimated` variant for asserts. */
type EstimatedCost = Extract<OperationReceipt['cost'], { state: 'estimated' }>;
const est = (r: OperationReceipt): EstimatedCost => {
  expect(r.cost.state).toBe('estimated');
  return r.cost as EstimatedCost;
};

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  runSeq = 0;
  mockCreateAgentRun.mockImplementation((_input: unknown, options: { id?: string } = {}) => {
    return Promise.resolve({ id: options.id ?? 'run-chat-fallback' });
  });
  mockPatchAgentRunAccounting.mockResolvedValue(undefined);
  mockUpsertMarker.mockResolvedValue(undefined);
});

// ===========================================================================
// 1 + 3. Two Gemini responses in one turn, each priced on its OWN tier/model.
// ===========================================================================

describe('per-response tier + model truth', () => {
  it('prices a <200k response on the 200k tier and a >200k response on the unbounded tier — never a flat turn rate', async () => {
    const captured = [
      geminiCapture({ counters: { promptTokens: 100_000, outputTokens: 100 }, occurredAt: '2026-07-23T01:00:00.000Z' }),
      geminiCapture({ counters: { promptTokens: 250_000, outputTokens: 100 }, occurredAt: '2026-07-23T02:00:00.000Z' }),
    ];
    const outcome = await terminalizeChatAccounting(baseInput(), captured);
    const receipts = outcome.flush!.receipts;
    expect(receipts).toHaveLength(2);
    // Response 1 (<200k): tier bound 200000, input rate 2.0, cacheRead 0.2.
    expect(est(receipts[0]).tierMaxContextTokens).toBe(200_000);
    expect(est(receipts[0]).appliedRates?.inputPerMillion).toBe(2.0);
    // Response 2 (>200k): unbounded tier, input rate 4.0, cacheRead 0.4.
    expect(est(receipts[1]).tierMaxContextTokens).toBeNull();
    expect(est(receipts[1]).appliedRates?.inputPerMillion).toBe(4.0);
    // Headline is the SUM of the two independently-priced receipts.
    const expected = (100_000 * 2.0 + 100 * 12.0) / 1_000_000 + (250_000 * 4.0 + 100 * 18.0) / 1_000_000;
    expect(outcome.costUsd).toBeCloseTo(expected, 10);
  });

  it('does not reprice an earlier response using the last response model (per-response model truth)', async () => {
    const captured = [
      geminiCapture({
        providerModel: 'gemini-3-flash-preview',
        requestedModel: 'gemini-3-flash-preview',
        counters: { promptTokens: 1000, outputTokens: 10 },
      }),
      geminiCapture({
        providerModel: 'gemini-3.1-pro-preview',
        requestedModel: 'gemini-3.1-pro-preview',
        counters: { promptTokens: 1000, outputTokens: 10 },
      }),
    ];
    const outcome = await terminalizeChatAccounting(baseInput({ model: 'gemini-3.1-pro-preview' }), captured);
    const receipts = outcome.flush!.receipts;
    // Response 1 billed at flash rates (input 0.5), NOT repriced at pro rates.
    expect(est(receipts[0]).resolvedModel).toBe('gemini-3-flash-preview');
    expect(est(receipts[0]).appliedRates?.inputPerMillion).toBe(0.5);
    // Response 2 billed at pro rates (input 2.0).
    expect(est(receipts[1]).resolvedModel).toBe('gemini-3.1-pro-preview');
    expect(est(receipts[1]).appliedRates?.inputPerMillion).toBe(2.0);

    // The AgentRun projection is derived from the durable receipts too: it
    // preserves one bucket per served model and allocates each model's own
    // receipt cost, rather than assigning the whole turn to the final model.
    const createInput = mockCreateAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(createInput.model).toBeUndefined();
    expect(createInput.modelUsage).toBeUndefined();
    const patchUsage = mockPatchAgentRunAccounting.mock.calls[0][2] as {
      model?: string;
      modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD?: number }>;
    };
    expect(patchUsage.model).toBeUndefined();
    expect(Object.keys(patchUsage.modelUsage)).toEqual(['gemini-3-flash-preview', 'gemini-3.1-pro-preview']);
    expect(patchUsage.modelUsage['gemini-3-flash-preview']).toMatchObject({
      inputTokens: 1000,
      outputTokens: 10,
      costUSD: est(receipts[0]).amountMicros! / 1_000_000,
    });
    expect(patchUsage.modelUsage['gemini-3.1-pro-preview']).toMatchObject({
      inputTokens: 1000,
      outputTokens: 10,
      costUSD: est(receipts[1]).amountMicros! / 1_000_000,
    });
  });
});

// ===========================================================================
// 2. Gemini cached-subset billing — no 0.25 factor, no double billing.
// ===========================================================================

describe('Gemini cached-subset billing (subset, not subtracted twice)', () => {
  it('bills the cached subset once at the card cache-read rate; the cached tokens are NOT subtracted from input and NOT billed at full price', async () => {
    // promptTokenCount INCLUDES cached (Gemini subset semantics): 1000 total,
    // 700 cached. Billable input = 1000 - 700 = 300 at $2/M; cache-read 700 at $0.2/M.
    const captured = [geminiCapture({ counters: { promptTokens: 1000, cacheReadTokens: 700, outputTokens: 100 } })];
    const outcome = await terminalizeChatAccounting(baseInput(), captured);
    const r = outcome.flush!.receipts[0];
    const inputMicros = est(r).breakdown!.inputMicros!;
    const cacheReadMicros = est(r).breakdown!.cacheReadMicros!;
    // input billed at (1000-700)=300 tokens, NOT 1000, NOT 1000-700+700*0.25.
    expect(inputMicros).toBe(Math.round(((300 * 2.0) / 1_000_000) * 1_000_000));
    // cache-read billed at 700 tokens * 0.2/M, the canonical rate (not 0.25x).
    expect(cacheReadMicros).toBe(Math.round(((700 * 0.2) / 1_000_000) * 1_000_000));
    expect(outcome.costUsd).toBeCloseTo((300 * 2.0 + 100 * 12.0 + 700 * 0.2) / 1_000_000, 10);
  });

  it('fails closed when cached > prompt (an impossible subset fact), never Math.min-hiding it', async () => {
    const captured = [geminiCapture({ counters: { promptTokens: 500, cacheReadTokens: 700, outputTokens: 10 } })];
    const outcome = await terminalizeChatAccounting(baseInput(), captured);
    expect(outcome.flush!.receipts[0].cost.state).toBe('unavailable');
    expect(outcome.costUsd).toBeNull();
    expect(outcome.costUnavailableReason).toBe('unknown-pricing');
    const patchUsage = mockPatchAgentRunAccounting.mock.calls[0][2];
    expect(patchUsage).toMatchObject({
      tokenUsage: { input: 500, output: 10 },
      modelUsage: {},
    });
    expect(patchUsage.model).toBeUndefined();
  });
});

// ===========================================================================
// 4. Malformed counters fail closed; explicit zero stays distinct from absent.
// ===========================================================================

describe('malformed counters fail closed; explicit zero ≠ absent', () => {
  it('fractional / negative / NaN / infinite prompt counters make the response unpriceable', async () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      store.clear();
      const captured = [geminiCapture({ counters: { promptTokens: bad as number, outputTokens: 10 } })];
      const outcome = await terminalizeChatAccounting(baseInput(), captured);
      expect(outcome.flush!.receipts[0].cost.state).toBe('unavailable');
      expect(outcome.costUsd).toBeNull();
    }
  });

  it('an explicit zero prompt prices, while an absent prompt (partial) does not', async () => {
    const zero = await terminalizeChatAccounting(baseInput(), [
      geminiCapture({ counters: { promptTokens: 0, outputTokens: 10 } }),
    ]);
    expect(zero.flush!.receipts[0].cost.state).toBe('estimated');
    expect(zero.costUsd).toBe((10 * 12.0) / 1_000_000);

    store.clear();
    const absent = await terminalizeChatAccounting(baseInput(), [geminiCapture({ counters: { outputTokens: 10 } })]);
    // No prompt counter → usageCompleteness 'partial' → unpriceable.
    expect(absent.flush!.receipts[0].cost.state).toBe('unavailable');
    expect(absent.costUsd).toBeNull();
  });
});

// ===========================================================================
// 5. Anthropic ordinary input/cache-read separation; no guessed cache-write tier.
// ===========================================================================

describe('Anthropic cache separation + no guessed cache-write tier', () => {
  it('bills ordinary input and cache-read separately (disjoint) at their own rates', async () => {
    // Anthropic input EXCLUDES cache. 1000 input + 300 cache-read bill independently.
    const captured = [anthropicCapture({ counters: { promptTokens: 1000, cacheReadTokens: 300, outputTokens: 100 } })];
    const outcome = await terminalizeChatAccounting(
      baseInput({ provider: 'claude', model: 'claude-sonnet-4-6' }),
      captured
    );
    const r = outcome.flush!.receipts[0];
    expect(est(r).breakdown!.inputMicros).toBe(Math.round(((1000 * 3.0) / 1_000_000) * 1_000_000));
    expect(est(r).breakdown!.cacheReadMicros).toBe(Math.round(((300 * 0.3) / 1_000_000) * 1_000_000));
    expect(outcome.costUsd).toBeCloseTo((1000 * 3.0 + 300 * 0.3 + 100 * 15.0) / 1_000_000, 10);
  });

  it('uses the explicit cache_creation breakdown (5m/1h) when present and never guesses a tier', async () => {
    const captured = [
      anthropicCapture({
        counters: { promptTokens: 1000, cacheWrite5mTokens: 200, cacheWrite1hTokens: 80, outputTokens: 10 },
      }),
    ];
    const outcome = await terminalizeChatAccounting(
      baseInput({ provider: 'claude', model: 'claude-sonnet-4-6' }),
      captured
    );
    const r = outcome.flush!.receipts[0];
    expect(est(r).breakdown!.cacheWrite5mMicros).toBe(Math.round(((200 * 3.75) / 1_000_000) * 1_000_000));
    expect(est(r).breakdown!.cacheWrite1hMicros).toBe(Math.round(((80 * 6.0) / 1_000_000) * 1_000_000));
  });
});

// ===========================================================================
// 6. OpenRouter counters persist while pricing stays unavailable.
// ===========================================================================

describe('OpenRouter: usage persists, pricing unavailable', () => {
  it('persists served-model + counters but prices UNAVAILABLE (never relabelled as first-party Anthropic)', async () => {
    const captured = [
      anthropicCapture({
        provider: 'openrouter',
        requestedModel: 'anthropic/claude-sonnet-4.5',
        providerModel: 'anthropic/claude-sonnet-4.5-20260201',
        counters: { promptTokens: 5000, outputTokens: 200 },
      }),
    ];
    const outcome = await terminalizeChatAccounting(
      baseInput({ provider: 'claude', model: 'anthropic/claude-sonnet-4.5-20260201' }),
      captured
    );
    const r = outcome.flush!.receipts[0];
    // Counters + served model persisted.
    expect(r.counters.promptTokens).toBe(5000);
    expect(r.model).toBe('anthropic/claude-sonnet-4.5-20260201');
    // But NOT priced as first-party Anthropic.
    expect(r.cost.state).toBe('unavailable');
    expect(outcome.costUsd).toBeNull();
    expect(outcome.costUnavailableReason).toBe('unknown-pricing');
  });
});

// ===========================================================================
// 7. Paid failure followed by fallback preserves distinct attempt truth.
// ===========================================================================

describe('failure + fallback preserves distinct attempts', () => {
  it('flushes the failed Claude attempt and the successful Gemini attempt as SEPARATE receipt sets (no merge, no double count)', async () => {
    const claudeCaptured = [anthropicCapture({ counters: { promptTokens: 800, outputTokens: 40 } })];
    const claudeOutcome = await terminalizeChatAccounting(
      baseInput({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        status: 'failure',
        requestId: 'req-1',
        error: 'provider_error',
      }),
      claudeCaptured
    );
    const geminiCaptured = [geminiCapture({ counters: { promptTokens: 1200, outputTokens: 60 } })];
    const geminiOutcome = await terminalizeChatAccounting(
      baseInput({ provider: 'gemini', model: 'gemini-3.1-pro-preview', status: 'success', requestId: 'req-1' }),
      geminiCaptured
    );
    // Both attempts produced durable priced receipts under distinct agentRunIds.
    expect(claudeOutcome.agentRunId).not.toBe(geminiOutcome.agentRunId);
    expect(claudeOutcome.flush!.receipts).toHaveLength(1);
    expect(geminiOutcome.flush!.receipts).toHaveLength(1);
    // Each headline is its OWN sum — the Claude spend was not merged into Gemini.
    expect(claudeOutcome.costUsd).toBeCloseTo((800 * 3.0 + 40 * 15.0) / 1_000_000, 10);
    expect(geminiOutcome.costUsd).toBeCloseTo((1200 * 2.0 + 60 * 12.0) / 1_000_000, 10);

    // Both attempts share the HTTP request id, but each flush owns a distinct,
    // attempt-stable batch id. Otherwise the later Gemini marker overwrites the
    // earlier Claude marker and can erase an unresolved loss.
    const markerInputs = mockUpsertMarker.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(markerInputs).toHaveLength(2);
    expect(markerInputs[0]).toMatchObject({ correlationId: 'req-1', batchId: claudeOutcome.agentRunId });
    expect(markerInputs[1]).toMatchObject({ correlationId: 'req-1', batchId: geminiOutcome.agentRunId });
    expect(markerInputs[0].batchId).not.toBe(markerInputs[1].batchId);
  });
});

// ===========================================================================
// 8. Exact replay, conflict, receipt-write failure, marker-write failure.
// ===========================================================================

describe('replay / conflict / write failure', () => {
  it('an exact replay is idempotent (replayed, not a duplicate) and the marker upserts the same slot', async () => {
    const captured = [geminiCapture({ counters: { promptTokens: 1000, outputTokens: 10 } })];
    const corr = { parentType: 'chat-turn' as const, owner: 'user:1', correlationId: 'req-1', agentRunId: 'run-1' };
    const first = await flushCapturedUsage(corr, captured, 'req-1', 'included-in-parent');
    const second = await flushCapturedUsage(corr, captured, 'req-1', 'included-in-parent');
    expect(first.written).toBe(1);
    expect(second.replayed).toBe(1);
    expect(second.written).toBe(0);
    expect(first.complete && second.complete).toBe(true);
    // Marker upserts the SAME idempotent key (owner/parent/correlation/batch) for
    // the replay; the written/replayed COUNTS differ per flush (correct — the
    // second flush saw replays, not new writes).
    expect(mockUpsertMarker).toHaveBeenCalledTimes(2);
    const keyFields = (c: unknown) => {
      const a = (c as Record<string, unknown>)[0] as Record<string, unknown>;
      return { owner: a.owner, parentType: a.parentType, correlationId: a.correlationId, batchId: a.batchId };
    };
    expect(keyFields(mockUpsertMarker.mock.calls[0])).toEqual(keyFields(mockUpsertMarker.mock.calls[1]));
  });

  it('a conflicting replay (different counters, same identity) leaves accounting visibly incomplete', async () => {
    const corr = { parentType: 'chat-turn' as const, owner: 'user:1', correlationId: 'req-1', agentRunId: 'run-1' };
    await flushCapturedUsage(
      corr,
      [geminiCapture({ counters: { promptTokens: 1000, outputTokens: 10 } })],
      'req-1',
      'included-in-parent'
    );
    const second = await flushCapturedUsage(
      corr,
      [geminiCapture({ counters: { promptTokens: 2000, outputTokens: 10 } })],
      'req-1',
      'included-in-parent'
    );
    expect(second.conflicted).toBe(1);
    expect(second.complete).toBe(false);
    // The marker records the conflict durably.
    expect(mockUpsertMarker.mock.calls[0][0]).toMatchObject({ conflicted: 0 });
    expect(mockUpsertMarker.mock.calls[1][0]).toMatchObject({ conflicted: 1 });
  });

  it('a receipt-write failure is reported as failed (not silently $0) and the marker surfaces it', async () => {
    store.recordImpl = async () => {
      throw new Error('transport failure');
    };
    const captured = [geminiCapture({ counters: { promptTokens: 1000, outputTokens: 10 } })];
    const outcome = await terminalizeChatAccounting(
      baseInput({
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          totalInputTokens: 1000,
        },
      }),
      captured
    );
    expect(outcome.flush!.failed).toBe(1);
    expect(outcome.flush!.complete).toBe(false);
    expect(outcome.costUsd).toBeNull();
    expect(outcome.costUnavailableReason).toBe('accounting-incomplete');
    // Receipt loss cannot prove a served-model breakdown, but it also cannot
    // erase provider counters already observed at the route boundary.
    expect(mockPatchAgentRunAccounting.mock.calls[0][2]).toEqual({
      modelUsage: {},
      tokenUsage: { input: 1000, output: 10 },
      tokenUsageProvenance: 'provider-reported',
    });
  });

  it('a marker-write failure surfaces markerPersisted=false while receipts still land', async () => {
    mockUpsertMarker.mockRejectedValueOnce(new Error('marker transport failure'));
    const captured = [geminiCapture({ counters: { promptTokens: 1000, outputTokens: 10 } })];
    const outcome = await terminalizeChatAccounting(baseInput(), captured);
    expect(outcome.flush!.written).toBe(1);
    expect(outcome.flush!.markerPersisted).toBe(false);
    expect(outcome.costUsd).toBeNull();
    expect(outcome.costUnavailableReason).toBe('accounting-incomplete');
  });

  it('persists receipts and a marker even when the AgentRun create fails', async () => {
    mockCreateAgentRun.mockRejectedValueOnce(new Error('agent-run write failed'));
    const outcome = await terminalizeChatAccounting(baseInput(), [geminiCapture()]);

    expect(outcome.agentRunId).toMatch(/^run-chat-/);
    expect(outcome.flush).toMatchObject({ expected: 1, written: 1, markerPersisted: true });
    expect(mockUpsertMarker).toHaveBeenCalled();
    expect(mockPatchAgentRunAccounting).not.toHaveBeenCalled();
    expect(outcome.costUsd).toBeNull();
    expect(outcome.costUnavailableReason).toBe('accounting-incomplete');
  });
});

// ===========================================================================
// 9. Content-leak regression — accounting records contain no prompts/responses.
// ===========================================================================

describe('content-leak regression', () => {
  it('receipts + AgentRun + marker carry NO prompt, response, tool argument, or header content', async () => {
    const secretPrompt = 'CONFIDENTIAL user wording: my password is hunter2';
    const secretResponse = 'tool result with private user wording';
    const captured = [
      geminiCapture({
        counters: { promptTokens: 1000, outputTokens: 10 },
        // A capture never carries content, but assert the contract end-to-end.
      }),
    ];
    const outcome = await terminalizeChatAccounting(
      baseInput({
        toolCalls: [
          { name: 'searchEntities', args: { query: secretPrompt }, result: { success: true, data: secretResponse } },
        ],
      }),
      captured
    );
    const blob = JSON.stringify({
      receipts: outcome.flush!.receipts,
      agentRun: mockCreateAgentRun.mock.calls[0][0],
      patch: mockPatchAgentRunAccounting.mock.calls[0],
      marker: mockUpsertMarker.mock.calls[0][0],
    });
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('CONFIDENTIAL');
    expect(blob).not.toContain(secretResponse);
  });
});

// ===========================================================================
// Zero-provider + headline derivation invariants.
// ===========================================================================

describe('zero-response and headline derivation', () => {
  it('a failure before any provider response creates NO receipt and the headline is a real 0 (no fake receipt)', async () => {
    const outcome = await terminalizeChatAccounting(baseInput({ status: 'failure', error: 'provider_error' }), []);
    expect(outcome.flush!.receipts).toHaveLength(0);
    expect(outcome.flush!.expected).toBe(0);
    // No marker is written for an empty flush.
    expect(mockUpsertMarker).not.toHaveBeenCalled();
    // A real zero — nothing was spent — never a fabricated partial total.
    expect(outcome.costUsd).toBe(0);
  });

  it('deriveHeadlineCost sums priced USD receipts, returns null on any unavailable, and 0 on empty', () => {
    const mk = (
      state: 'estimated' | 'unavailable',
      amount?: number,
      feeState: 'none' | 'known' | 'applicable-but-unknown' = 'none'
    ) =>
      ({
        // A current (v2) receipt always states its fee situation; `none` is the
        // ordinary un-grounded response.
        feeState,
        cost: state === 'estimated' ? { state, amountMicros: amount, currency: 'USD' } : { state },
      }) as unknown as import('@/lib/operation-receipt-instrument').FlushResult['receipts'][number];
    const flush = (receipts: ReturnType<typeof mk>[]) =>
      ({
        expected: receipts.length,
        written: receipts.length,
        replayed: 0,
        conflicted: 0,
        failed: 0,
        receipts,
        complete: true,
        markerPersisted: true,
      }) as never;
    expect(deriveHeadlineCost(flush([])).costUsd).toBe(0);
    expect(deriveHeadlineCost(flush([mk('estimated', 1_000_000)])).costUsd).toBe(1);
    expect(deriveHeadlineCost(flush([mk('estimated', 1_000_000), mk('unavailable')])).costUsd).toBeNull();
    // A token-only estimate whose provider fee is applicable-but-unknown (a nested
    // grounded-search tool) is a LOWER BOUND. The receipt keeps that real token
    // amount; the single-figure headline must not present it as the turn's bill.
    expect(deriveHeadlineCost(flush([mk('estimated', 1_000_000, 'applicable-but-unknown')]))).toEqual({
      costUsd: null,
      costUnavailableReason: 'unknown-pricing',
      // ...but the daily SPEND GUARD still gets the exact token sum. Charging it
      // `null` would fail the whole day closed over a cents-scale search fee and
      // take the Assistant offline after one research turn.
      budgetUsd: 1,
    });
    expect(
      deriveHeadlineCost(flush([mk('estimated', 1_000_000), mk('estimated', 500_000, 'applicable-but-unknown')]))
    ).toEqual({ costUsd: null, costUnavailableReason: 'unknown-pricing', budgetUsd: 1.5 });
    // A genuinely unpriceable receipt still charges the guard nothing, so it stays
    // fail-closed for the rest of the day.
    expect(deriveHeadlineCost(flush([mk('estimated', 1_000_000), mk('unavailable')])).budgetUsd).toBeNull();
    // A KNOWN fee is already inside its receipt's amount and stays summable.
    expect(deriveHeadlineCost(flush([mk('estimated', 1_000_000, 'known')]))).toEqual({ costUsd: 1, budgetUsd: 1 });
    // A turn with no provider response spends a provable zero on both axes.
    expect(deriveHeadlineCost(flush([]))).toEqual({ costUsd: 0, budgetUsd: 0 });
    expect(
      deriveHeadlineCost({
        expected: 1,
        written: 0,
        replayed: 0,
        conflicted: 1,
        failed: 0,
        receipts: [],
        complete: false,
        markerPersisted: true,
      }).costUsd
    ).toBeNull();
    expect(
      deriveHeadlineCost({
        expected: 1,
        written: 1,
        replayed: 0,
        conflicted: 0,
        failed: 0,
        receipts: [mk('estimated', 1_000_000)],
        complete: true,
        markerPersisted: false,
      } as never).costUsd
    ).toBeNull();
  });

  it.each(['missing-usage', 'provider-unreported'])(
    'keeps the priced lower bound when nested provider usage is %s',
    (reason) => {
      const priced = {
        feeState: 'none',
        cost: { state: 'estimated', amountMicros: 1_000_000, currency: 'USD' },
      } as unknown as import('@/lib/operation-receipt-instrument').FlushResult['receipts'][number];
      const unavailable = {
        feeState: 'none',
        cost: { state: 'unavailable', reason },
      } as unknown as import('@/lib/operation-receipt-instrument').FlushResult['receipts'][number];
      const flush = {
        expected: 2,
        written: 2,
        replayed: 0,
        conflicted: 0,
        failed: 0,
        receipts: [priced, unavailable],
        complete: true,
        markerPersisted: true,
      } as never;

      expect(deriveHeadlineCost(flush)).toEqual({
        costUsd: null,
        costUnavailableReason: 'unknown-pricing',
        budgetUsd: 1,
      });
    }
  );

  it('does not invent a lower bound when no component was priced', () => {
    const flush = {
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ feeState: 'none', cost: { state: 'unavailable', reason: 'missing-usage' } }],
      complete: true,
      markerPersisted: true,
    } as never;
    expect(deriveHeadlineCost(flush)).toEqual({
      costUsd: null,
      costUnavailableReason: 'unknown-pricing',
      budgetUsd: null,
    });
  });

  it('records every rejected provider attempt as durable unreported usage and leaves successes untouched', async () => {
    const captured: CapturedProviderUsage[] = [];
    await expect(
      trackChatProviderAttempt(
        captured,
        { provider: 'gemini', operation: 'gemini.chat', requestedModel: 'gemini-3.1-pro-preview' },
        async () => {
          throw new Error('deadline');
        }
      )
    ).rejects.toThrow('deadline');
    expect(captured).toEqual([
      expect.objectContaining({
        provider: 'gemini',
        operation: 'gemini.chat',
        requestedModel: 'gemini-3.1-pro-preview',
        counters: {},
        usageCompleteness: 'unreported',
      }),
    ]);

    await expect(
      trackChatProviderAttempt(captured, { provider: 'gemini', operation: 'gemini.chat' }, async () => 'ok')
    ).resolves.toBe('ok');
    expect(captured).toHaveLength(1);
  });

  it('turns an unexpected successful-response mapping failure into unreported usage, never a precise zero', () => {
    const captured: CapturedProviderUsage[] = [];
    captureChatProviderResponse(
      captured,
      { provider: 'openrouter', operation: 'claude.messages.create', requestedModel: 'anthropic/claude-sonnet' },
      () => {
        throw new Error('unexpected provider usage shape');
      }
    );

    expect(captured).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        requestedModel: 'anthropic/claude-sonnet',
        counters: {},
        usageCompleteness: 'unreported',
      }),
    ]);
  });
});

// ===========================================================================
// Acceptance — real chat terminalization + real AgentRun/receipt persistence
// against a disposable store, with strict provider seams (no live provider).
// ===========================================================================

describe('zero-provider acceptance (real terminalization + real persistence, no live provider)', () => {
  it('maps a raw Gemini SDK usage through the real mapper into a real priced receipt + AgentRun headline', async () => {
    // Raw SDK-shaped usageMetadata (the shape the route's chokepoint receives).
    const usageMetadata = {
      promptTokenCount: 50_000,
      candidatesTokenCount: 300,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 10_000,
    };
    const { counters, usageCompleteness } = geminiUsageToReceipt(usageMetadata, { groundingQueryCount: 0 });
    const captured: CapturedProviderUsage[] = [
      {
        provider: 'gemini',
        operation: 'gemini.chat',
        requestedModel: 'gemini-3.1-pro-preview',
        providerModel: 'gemini-3.1-pro-preview',
        counters,
        usageCompleteness,
        occurredAt: '2026-07-23T00:00:00.000Z',
        feeState: 'none',
      },
    ];
    const outcome = await terminalizeChatAccounting(baseInput(), captured);
    // Real AgentRun persisted (accounting-incomplete initially), then patched.
    expect(mockCreateAgentRun).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentRun.mock.calls[0][0]).toMatchObject({
      kind: 'chat',
      provider: 'gemini',
      costUnavailableReason: 'accounting-incomplete',
    });
    expect(mockPatchAgentRunAccounting).toHaveBeenCalledTimes(1);
    // Real receipt persisted in the disposable store.
    expect(outcome.flush!.receipts).toHaveLength(1);
    expect(outcome.flush!.written).toBe(1);
    const r = outcome.flush!.receipts[0];
    expect(r.cost.state).toBe('estimated');
    // Headline === the single receipt's amount (single source of truth).
    expect(outcome.costUsd).toBe(est(r).amountMicros! / 1_000_000);
    // Zero spend, zero live provider, zero residue beyond the ledger.
    expect(outcome.costUsd).toBeGreaterThan(0);
  });
});

// silence the unused-conflict import reference (kept for instanceof symmetry docs)
void MockConflict;

// ===========================================================================
// ARUN-020 — the Runs list and the run detail must never publish two different
// token totals for the SAME run.
//
// A chat turn writes its usage twice: once when the AgentRun row is created
// (before any receipt exists) and again when the durable receipts are known.
// Before this lane the two writes used different bases — the route's mutable
// aggregate, which substitutes a `characters / 4` estimate whenever a provider
// response omits `usageMetadata`, versus the receipt fold, which correctly
// refuses to invent one. Whichever surface read first won, which is how one
// the list and detail could disagree.
// ===========================================================================

describe('ARUN-020 — create-time and terminal usage agree', () => {
  /** Synthetic shape: one reported response plus one that reported nothing. */
  const partiallyReportedTurn = (): CapturedProviderUsage[] => [
    geminiCapture({ counters: { promptTokens: 100, outputTokens: 9 } }),
    geminiCapture({ counters: {}, usageCompleteness: 'unreported', providerModel: undefined }),
  ];

  const persistedTokenTotals = () => {
    const created = mockCreateAgentRun.mock.calls[0][0] as {
      tokenUsage: { input: number; output: number };
      tokenUsageProvenance?: string;
    };
    const patched = mockPatchAgentRunAccounting.mock.calls[0][2] as {
      tokenUsage: { input: number; output: number };
      tokenUsageProvenance?: string;
    };
    return {
      created,
      patched,
      createdTotal: created.tokenUsage.input + created.tokenUsage.output,
      patchedTotal: patched.tokenUsage.input + patched.tokenUsage.output,
    };
  };

  it('reproduces the 115-vs-109 divergence basis and publishes ONE total for both writes', async () => {
    // The route's own aggregate for this turn: the reported response (100 + 9)
    // PLUS a 6-token `characters / 4` estimate for the response the provider
    // never counted. 115 is exactly what the pre-fix create-time write stored.
    const routeAggregate = { inputTokens: 106, outputTokens: 9, totalInputTokens: 106 };
    expect(routeAggregate.totalInputTokens + routeAggregate.outputTokens).toBe(115);

    await terminalizeChatAccounting(baseInput({ usage: routeAggregate }), partiallyReportedTurn());

    const { created, patched, createdTotal, patchedTotal } = persistedTokenTotals();
    // The regression this pins: the two writes must state the SAME total.
    expect(createdTotal).toBe(patchedTotal);
    // ...and that total is the provider-reported 109, never the estimated 115.
    expect(createdTotal).toBe(109);
    expect(created.tokenUsage).toEqual({ input: 100, output: 9 });
    expect(patched.tokenUsage).toEqual({ input: 100, output: 9 });
    // Both writes also agree that the number is a lower bound, so no surface can
    // present a partially-reported turn as an exact measurement.
    expect(created.tokenUsageProvenance).toBe('partially-reported');
    expect(patched.tokenUsageProvenance).toBe('partially-reported');
  });

  it('never invents a count when the provider reported none — both writes say unreported', async () => {
    const captured = [
      geminiCapture({ counters: {}, usageCompleteness: 'unreported', providerModel: undefined }),
      geminiCapture({ counters: {}, usageCompleteness: 'unreported', providerModel: undefined }),
    ];
    // The route would have estimated 48 tokens from response characters.
    await terminalizeChatAccounting(
      baseInput({ usage: { inputTokens: 40, outputTokens: 8, totalInputTokens: 40 } }),
      captured
    );

    const { created, patched, createdTotal, patchedTotal } = persistedTokenTotals();
    expect(createdTotal).toBe(patchedTotal);
    expect(created.tokenUsageProvenance).toBe('unreported');
    expect(patched.tokenUsageProvenance).toBe('unreported');
    // The stored counters are a required-field placeholder; the read snapshot
    // (agentRunUsageSnapshot) turns this provenance into "—", never "0 tokens".
    expect(created.tokenUsage).toEqual({ input: 0, output: 0 });
  });

  it('a turn with no provider response at all is a real reported zero', async () => {
    await terminalizeChatAccounting(baseInput(), []);
    const { created, patched } = persistedTokenTotals();
    expect(created.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(created.tokenUsageProvenance).toBe('provider-reported');
    expect(patched.tokenUsageProvenance).toBe('provider-reported');
  });

  it('keeps the capture-derived total (not the route estimate) when the receipt flush cannot complete', async () => {
    mockRecordOperationReceiptWithOutcome.mockRejectedValueOnce(new Error('firestore unavailable'));
    await terminalizeChatAccounting(
      baseInput({ usage: { inputTokens: 999, outputTokens: 999, totalInputTokens: 999 } }),
      [geminiCapture({ counters: { promptTokens: 100, outputTokens: 9 } })]
    );

    const { created, patched, createdTotal, patchedTotal } = persistedTokenTotals();
    expect(createdTotal).toBe(patchedTotal);
    expect(patched.tokenUsage).toEqual({ input: 100, output: 9 });
    // A conflicted/failed batch cannot prove a served-model breakdown, so the
    // per-model map is dropped — but the observed counters are NOT zeroed.
    expect(patched).toMatchObject({ modelUsage: {} });
    expect(mockPatchAgentRunAccounting.mock.calls[0][1]).toMatchObject({
      costUsd: null,
      costUnavailableReason: 'accounting-incomplete',
    });
  });

  it('fails a malformed capture counter closed instead of throwing out of terminalization', async () => {
    // Receipt counters are schema-validated at the repository boundary; a
    // CAPTURE is a raw provider fact and can carry a fractional/NaN/negative
    // value. Folding it must neither throw nor poison the total with NaN.
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      jest.clearAllMocks();
      store.clear();
      await terminalizeChatAccounting(baseInput(), [
        geminiCapture({ counters: { promptTokens: bad as number, outputTokens: 10 } }),
        geminiCapture({ counters: { promptTokens: 40, outputTokens: 4 } }),
      ]);
      const { created, patched, createdTotal, patchedTotal } = persistedTokenTotals();
      expect(createdTotal).toBe(patchedTotal);
      expect(created.tokenUsage).toEqual({ input: 40, output: 4 });
      expect(created.tokenUsageProvenance).toBe('partially-reported');
      expect(patched.tokenUsageProvenance).toBe('partially-reported');
    }
  });

  it('does not double-count two responses served by the same model', async () => {
    await terminalizeChatAccounting(baseInput(), [
      geminiCapture({ counters: { promptTokens: 100, outputTokens: 10 } }),
      geminiCapture({ counters: { promptTokens: 200, outputTokens: 20 } }),
    ]);
    const { created, patched } = persistedTokenTotals();
    expect(created.tokenUsage).toEqual({ input: 300, output: 30 });
    expect(patched.tokenUsage).toEqual({ input: 300, output: 30 });
    const modelUsage = (mockPatchAgentRunAccounting.mock.calls[0][2] as { modelUsage: Record<string, unknown> })
      .modelUsage;
    expect(Object.keys(modelUsage)).toEqual(['gemini-3.1-pro-preview']);
    expect(modelUsage['gemini-3.1-pro-preview']).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it('folds a `models/`-prefixed served model onto the same key both writes use', async () => {
    await terminalizeChatAccounting(baseInput(), [
      geminiCapture({
        providerModel: 'models/gemini-3.1-pro-preview',
        counters: { promptTokens: 50, outputTokens: 5 },
      }),
      geminiCapture({ providerModel: 'gemini-3.1-pro-preview', counters: { promptTokens: 50, outputTokens: 5 } }),
    ]);
    const created = mockCreateAgentRun.mock.calls[0][0] as { tokenUsage: { input: number; output: number } };
    const patched = mockPatchAgentRunAccounting.mock.calls[0][2] as {
      tokenUsage: { input: number; output: number };
      modelUsage: Record<string, unknown>;
    };
    expect(created.tokenUsage).toEqual(patched.tokenUsage);
    expect(Object.keys(patched.modelUsage)).toEqual(['gemini-3.1-pro-preview']);
  });
});
