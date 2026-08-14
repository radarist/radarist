/**
 * @file lib/__tests__/mission-usage-receipts.test.ts
 * @description ARUN-022 — mission envelope: provider-reported modelUsage →
 * receipts + SDK-actual settlement.
 *
 * Pins requirements 2 + 3: each provider-reported model produces its OWN
 * receipt (included-in-parent scope) priced from the canonical card with the
 * mission asOf; the SDK per-model costUSD is an append-only settlement that
 * NEVER overwrites the estimate; a zero/absent SDK cost settles nothing.
 *
 * @jest-environment node
 */

const mockFlushCapturedUsage = jest.fn();
jest.mock('@/lib/operation-receipt-instrument', () => ({
  flushCapturedUsage: (...args: unknown[]) => mockFlushCapturedUsage(...args),
}));

const mockRecordSettlement = jest.fn();
jest.mock('@/lib/operation-settlement-repository', () => ({
  recordOperationSettlement: (...args: unknown[]) => mockRecordSettlement(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const {
  flushMissionUsageReceipts,
  flushBuildSessionUsageReceipt,
  flushSubSessionUsageReceipts,
} = require('../mission-usage-receipts');

const baseInput = {
  missionId: 'mission-1',
  owner: 'user:u1',
  asOf: '2026-07-24T00:00:00.000Z',
};

describe('mission-usage-receipts — ARUN-022 mission envelope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('produces one capture per provider-reported model, all included-in-parent', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 2,
      written: 2,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [
        { id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } },
        { id: 'r2', model: 'claude-opus-4', cost: { state: 'estimated' } },
      ],
      complete: true,
      markerPersisted: true,
    });

    await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, costUSD: 0.01 },
        'claude-opus-4': { inputTokens: 200, outputTokens: 80, cacheReadInputTokens: 0, costUSD: 0.05 },
      },
    });

    expect(mockFlushCapturedUsage).toHaveBeenCalledTimes(1);
    const [correlation, captured, prefix, scope] = mockFlushCapturedUsage.mock.calls[0];
    expect(correlation).toEqual({
      parentType: 'mission',
      owner: 'user:u1',
      correlationId: 'mission-1',
      missionId: 'mission-1',
    });
    expect(prefix).toBe('mission-mission-1');
    // Anti-double-count: the orchestrator spend is already in the mission headline.
    expect(scope).toBe('included-in-parent');
    // One capture per model.
    expect(captured).toHaveLength(2);
    const sonnet = captured.find((c: { requestedModel?: string }) => c.requestedModel === 'claude-sonnet-4');
    expect(sonnet).toBeDefined();
    expect(sonnet.provider).toBe('anthropic');
    expect(sonnet.counters.promptTokens).toBe(100);
    expect(sonnet.counters.outputTokens).toBe(50);
    expect(sonnet.counters.cacheReadTokens).toBe(10);
    // The SDK reports the served model as the modelUsage key → provider-reported.
    expect(sonnet.requestedModel).toBe('claude-sonnet-4');
    expect(sonnet.providerModel).toBe('claude-sonnet-4');
    expect(sonnet.occurredAt).toBe(baseInput.asOf);
    expect(sonnet.feeState).toBe('none');
  });

  it('records the SDK costUSD as an append-only settlement (never overwrites the estimate)', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });
    mockRecordSettlement.mockResolvedValue({});

    const outcome = await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0.0123 },
      },
    });

    expect(mockRecordSettlement).toHaveBeenCalledTimes(1);
    const settlement = mockRecordSettlement.mock.calls[0][0];
    expect(settlement.receiptId).toBe('r1');
    expect(settlement.owner).toBe('user:u1');
    // $0.0123 → 12300 micros.
    expect(settlement.actualAmountMicros).toBe(12300);
    expect(settlement.currency).toBe('USD');
    expect(settlement.covers).toBe('tokens');
    expect(settlement.revision).toBe(0);
    expect(settlement.occurredAt).toBe(baseInput.asOf);
    expect(outcome.settlements['claude-sonnet-4']).toBe('settled');
  });

  it('records a provider-reported zero SDK costUSD as a zero settlement (never reads as unavailable)', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });
    mockRecordSettlement.mockResolvedValue({});

    const outcome = await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: { 'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0 } },
    });

    expect(mockRecordSettlement).toHaveBeenCalledTimes(1);
    const settlement = mockRecordSettlement.mock.calls[0][0];
    expect(settlement.actualAmountMicros).toBe(0);
    expect(outcome.settlements['claude-sonnet-4']).toBe('settled');
  });

  it('skips settlement when costUSD is absent (not the same as known-zero)', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });

    const outcome = await flushMissionUsageReceipts({
      ...baseInput,
      // `costUSD` intentionally omitted.
      modelUsage: { 'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 } },
    });

    expect(mockRecordSettlement).not.toHaveBeenCalled();
    expect(outcome.settlements['claude-sonnet-4']).toBe('skipped');
  });

  it('classifies a negative SDK costUSD as failed', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });

    const outcome = await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: -0.01 },
      },
    });

    expect(mockRecordSettlement).not.toHaveBeenCalled();
    expect(outcome.settlements['claude-sonnet-4']).toBe('failed');
  });

  it('flushes nothing when modelUsage is empty', async () => {
    const outcome = await flushMissionUsageReceipts({ ...baseInput, modelUsage: {} });

    expect(mockFlushCapturedUsage).not.toHaveBeenCalled();
    expect(outcome.flush).toBeUndefined();
  });

  it('is non-fatal and returns an empty outcome when the flush throws', async () => {
    mockFlushCapturedUsage.mockRejectedValue(new Error('firestore down'));

    const outcome = await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: { 'claude-sonnet-4': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.01 } },
    });

    expect(outcome.flush).toBeUndefined();
    expect(outcome.settlements).toEqual({});
  });

  it('marks completeness partial when per-model cache facts are absent', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [],
      complete: true,
      markerPersisted: true,
    });

    await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50 },
      },
    });

    const captured = mockFlushCapturedUsage.mock.calls[0][1][0];
    expect(captured.usageCompleteness).toBe('partial');
    expect(captured.counters).not.toHaveProperty('cacheReadTokens');
  });

  it('replaying a zero-costUSD settlement stays settled and distinct from absent', async () => {
    const settledKeys = new Set<string>();
    mockRecordSettlement.mockImplementation((params: Record<string, unknown>) => {
      const key = `${params.receiptId}:${params.actualAmountMicros}:${params.covers}`;
      if (settledKeys.has(key)) return {};
      settledKeys.add(key);
      return {};
    });

    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r-zero', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });

    const zeroInput = {
      ...baseInput,
      missionId: 'mission-zero-replay',
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0 },
      },
    };

    const first = await flushMissionUsageReceipts(zeroInput);
    expect(first.settlements['claude-sonnet-4']).toBe('settled');
    expect(mockRecordSettlement).toHaveBeenCalledTimes(1);
    expect(mockRecordSettlement.mock.calls[0][0].actualAmountMicros).toBe(0);

    // Exact replay is idempotent: only one logical settlement, state stays settled.
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 0,
      replayed: 1,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r-zero', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });

    const replay = await flushMissionUsageReceipts(zeroInput);
    expect(replay.settlements['claude-sonnet-4']).toBe('settled');

    // An absent costUSD is still reported as skipped, keeping zero distinct.
    const absentInput = {
      ...baseInput,
      missionId: 'mission-absent',
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 },
      },
    };
    const absent = await flushMissionUsageReceipts(absentInput);
    expect(absent.settlements['claude-sonnet-4']).toBe('skipped');
  });

  it('classifies a model with cache-creation writes into the 5-minute tier', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [{ id: 'r1', model: 'claude-sonnet-4', cost: { state: 'estimated' } }],
      complete: true,
      markerPersisted: true,
    });

    await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        'claude-sonnet-4': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 30,
          costUSD: 0.02,
        },
      },
    });

    const captured = mockFlushCapturedUsage.mock.calls[0][1][0];
    expect(captured.counters.cacheWrite5mTokens).toBe(30);
    expect(captured.counters.cacheWrite1hTokens).toBeUndefined();
  });

  it('marks completeness partial when a required counter is malformed', async () => {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: 1,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts: [],
      complete: true,
      markerPersisted: true,
    });

    await flushMissionUsageReceipts({
      ...baseInput,
      modelUsage: {
        // Negative input tokens → malformed → partial completeness.
        'claude-sonnet-4': { inputTokens: -5, outputTokens: 50, cacheReadInputTokens: 0, costUSD: 0 },
      },
    });

    const captured = mockFlushCapturedUsage.mock.calls[0][1][0];
    expect(captured.usageCompleteness).toBe('partial');
  });
});

describe('mission-usage-receipts — ARUN-022 build envelope', () => {
  const buildInput = {
    missionId: 'build-9',
    owner: 'user:u1',
    sessionIndex: 2,
    requestedModel: 'claude-sonnet-5',
    occurredAt: '2026-07-27T10:00:00.000Z',
    inputTokens: 52_000,
    outputTokens: 18_000,
  };

  function flushReturns(receipts: unknown[]) {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: 1,
      written: receipts.length,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts,
      complete: true,
      markerPersisted: true,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records the requested model without claiming the provider confirmed it', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    const captured = mockFlushCapturedUsage.mock.calls[0][1][0];
    expect(captured.requestedModel).toBe('claude-sonnet-5');
    // The headless CLI reports no served model. Asserting one here would let the
    // rate card price a requested model as if the provider had confirmed it.
    expect(captured.providerModel).toBeUndefined();
    expect(captured.provider).toBe('anthropic');
    expect(captured.operation).toBe('anthropic.build-session');
  });

  it('never claims complete usage, because the CLI reports no cache split', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    const captured = mockFlushCapturedUsage.mock.calls[0][1][0];
    expect(captured.usageCompleteness).toBe('partial');
    expect(captured.counters).toEqual({ promptTokens: 52_000, outputTokens: 18_000 });
  });

  it('scopes the session to included-in-parent under a stable per-session identity', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    const [correlation, , prefix, scope] = mockFlushCapturedUsage.mock.calls[0];
    expect(correlation).toEqual({
      parentType: 'mission',
      owner: 'user:u1',
      correlationId: 'build-9',
      missionId: 'build-9',
    });
    expect(prefix).toBe('build-build-9-session-2');
    // buildCostAccounting already counts this session in the mission headline.
    expect(scope).toBe('included-in-parent');
  });

  it("settles with the CLI's authoritative total cost", async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    expect(outcome.settlement).toBe('settled');
    expect(mockRecordSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: 'r-build',
        owner: 'user:u1',
        actualAmountMicros: 4_250_000,
        currency: 'USD',
        evidenceRef: 'claude-code-cli-total_cost_usd',
        occurredAt: '2026-07-27T10:00:00.000Z',
        revision: 0,
      })
    );
  });

  it('does NOT settle when the result was missing and the reservation was charged', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    // No authoritativeCostUsd: the supervisor charged the full budget
    // reservation, which is an exposure ceiling, not a provider actual.
    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput });

    expect(outcome.settlement).toBe('skipped');
    expect(mockRecordSettlement).not.toHaveBeenCalled();
  });

  it('records a provider-reported zero cost as a real settlement, not as unpriced', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 0 });

    expect(outcome.settlement).toBe('settled');
    expect(mockRecordSettlement).toHaveBeenCalledWith(expect.objectContaining({ actualAmountMicros: 0 }));
  });

  it('refuses an impossible negative provider cost instead of persisting it', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: -1 });

    expect(outcome.settlement).toBe('failed');
    expect(mockRecordSettlement).not.toHaveBeenCalled();
  });

  it('omits counters entirely when the CLI reported no usage', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);

    await flushBuildSessionUsageReceipt({
      missionId: 'build-9',
      owner: 'user:u1',
      sessionIndex: 0,
      requestedModel: 'claude-sonnet-5',
      occurredAt: '2026-07-27T10:00:00.000Z',
      authoritativeCostUsd: 1,
    });

    // An unreported count must not become a known zero.
    expect(mockFlushCapturedUsage.mock.calls[0][1][0].counters).toEqual({});
  });

  it('keeps a settlement failure non-fatal and reports it', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5', cost: { state: 'unavailable' } }]);
    mockRecordSettlement.mockRejectedValueOnce(new Error('firestore unavailable'));

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    expect(outcome.settlement).toBe('failed');
    expect(outcome.flush?.complete).toBe(true);
  });

  it('does not settle when the receipt itself was lost', async () => {
    flushReturns([]);

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    expect(outcome.settlement).toBe('skipped');
    expect(mockRecordSettlement).not.toHaveBeenCalled();
  });

  it('survives a flush failure without throwing into the build', async () => {
    mockFlushCapturedUsage.mockRejectedValueOnce(new Error('ledger down'));

    const outcome = await flushBuildSessionUsageReceipt({ ...buildInput, authoritativeCostUsd: 4.25 });

    expect(outcome).toEqual({
      flush: undefined,
      settlement: 'skipped',
      settlements: {},
      // This input carries no `modelUsage`, so the aggregate fallback ran.
      granularity: 'session-aggregate',
    });
  });
});

// ===========================================================================
// ARUN-022 / AI-029 — build envelope, PER SERVED MODEL
// ===========================================================================

describe('mission-usage-receipts — build envelope, per-served-model path', () => {
  const buildInput = {
    missionId: 'build-9',
    owner: 'user:u1',
    sessionIndex: 2,
    requestedModel: 'claude-sonnet-5',
    occurredAt: '2026-07-27T10:00:00.000Z',
  };

  function flushReturns(receipts: Array<{ id: string; model?: string }>) {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: receipts.length,
      written: receipts.length,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts,
      complete: true,
      markerPersisted: true,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordSettlement.mockResolvedValue(undefined);
  });

  it('records one provider-reported receipt per SERVED model, replacing the requested-model guess', async () => {
    flushReturns([
      { id: 'r-haiku', model: 'claude-haiku-4-5-20251001' },
      { id: 'r-sonnet', model: 'claude-sonnet-4-6' },
    ]);

    const outcome = await flushBuildSessionUsageReceipt({
      ...buildInput,
      authoritativeCostUsd: 1.4358115,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 79,
          outputTokens: 18_230,
          cacheReadInputTokens: 3_046_866,
          cacheCreationInputTokens: 66_009,
          costUSD: 1.4352805,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 451,
          outputTokens: 16,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000531,
        },
      },
      cacheCreation: { ephemeral5mInputTokens: 66_009, ephemeral1hInputTokens: 0 },
    });

    expect(outcome.granularity).toBe('per-served-model');
    const [, captured, prefix, scope] = mockFlushCapturedUsage.mock.calls[0];
    // Same stable per-session identity prefix as before — a replay is idempotent.
    expect(prefix).toBe('build-build-9-session-2');
    expect(scope).toBe('included-in-parent');
    expect(captured).toHaveLength(2);

    // Deterministic ordering, so a replay derives the same positional identity
    // regardless of provider key order.
    expect(captured.map((c: { requestedModel: string }) => c.requestedModel)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]);

    const sonnet = captured[1];
    // The provider told us what it served — no more `requested-fallback` guess.
    expect(sonnet.providerModel).toBe('claude-sonnet-4-6');
    expect(sonnet.operation).toBe('anthropic.build-session');
    expect(sonnet.counters).toEqual({
      promptTokens: 79,
      outputTokens: 18_230,
      cacheReadTokens: 3_046_866,
      cacheWrite5mTokens: 66_009,
    });
    // Cache facts are now known AND the write tier is proven → complete.
    expect(sonnet.usageCompleteness).toBe('complete');
    expect(sonnet.occurredAt).toBe(buildInput.occurredAt);
  });

  it('settles each model with its OWN cost and never the session total on top', async () => {
    flushReturns([
      { id: 'r-haiku', model: 'claude-haiku-4-5-20251001' },
      { id: 'r-sonnet', model: 'claude-sonnet-4-6' },
    ]);

    const outcome = await flushBuildSessionUsageReceipt({
      ...buildInput,
      // The session total is the SUM of the per-model costs below. Settling it
      // again would double-count the session's provider actual.
      authoritativeCostUsd: 1.4358115,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 79, outputTokens: 18_230, cacheReadInputTokens: 0, costUSD: 1.4352805 },
        'claude-haiku-4-5-20251001': { inputTokens: 451, outputTokens: 16, cacheReadInputTokens: 0, costUSD: 0.000531 },
      },
    });

    expect(outcome.settlement).toBe('skipped');
    expect(outcome.settlements).toEqual({
      'claude-sonnet-4-6': 'settled',
      'claude-haiku-4-5-20251001': 'settled',
    });
    expect(mockRecordSettlement).toHaveBeenCalledTimes(2);
    const amounts = mockRecordSettlement.mock.calls.map((call) => call[0].actualAmountMicros).sort((a, b) => a - b);
    expect(amounts).toEqual([531, 1_435_281]);
    // No third settlement carrying the session total.
    for (const call of mockRecordSettlement.mock.calls) {
      expect(call[0].evidenceRef).toBe('claude-code-cli-modelUsage');
    }
  });

  it('refuses to guess the cache-write tier when two models wrote across both tiers', async () => {
    flushReturns([
      { id: 'r-a', model: 'model-a' },
      { id: 'r-b', model: 'model-b' },
    ]);

    await flushBuildSessionUsageReceipt({
      ...buildInput,
      modelUsage: {
        'model-a': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 100 },
        'model-b': { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 300 },
      },
      // Both tiers used, two writers — no way to know which model wrote which.
      cacheCreation: { ephemeral5mInputTokens: 250, ephemeral1hInputTokens: 150 },
    });

    const [, captured] = mockFlushCapturedUsage.mock.calls[0];
    for (const capture of captured) {
      // Pricing 1-hour writes at the 5-minute rate would invent a figure.
      expect(capture.counters.cacheWrite5mTokens).toBeUndefined();
      expect(capture.counters.cacheWrite1hTokens).toBeUndefined();
      expect(capture.usageCompleteness).toBe('partial');
    }
  });

  it('attributes a both-tier split to a SOLE writer, because the attribution is provable', async () => {
    flushReturns([
      { id: 'r-a', model: 'model-a' },
      { id: 'r-b', model: 'model-b' },
    ]);

    await flushBuildSessionUsageReceipt({
      ...buildInput,
      modelUsage: {
        'model-a': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 400 },
        'model-b': { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
      cacheCreation: { ephemeral5mInputTokens: 250, ephemeral1hInputTokens: 150 },
    });

    const [, captured] = mockFlushCapturedUsage.mock.calls[0];
    const writer = captured.find((c: { requestedModel: string }) => c.requestedModel === 'model-a');
    expect(writer.counters.cacheWrite5mTokens).toBe(250);
    expect(writer.counters.cacheWrite1hTokens).toBe(150);
    expect(writer.usageCompleteness).toBe('complete');
  });

  it('stays partial when the CLI reported no tier split at all', async () => {
    flushReturns([{ id: 'r-a', model: 'model-a' }]);

    await flushBuildSessionUsageReceipt({
      ...buildInput,
      modelUsage: {
        'model-a': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 400 },
      },
      // Older CLI: no `usage.cache_creation`.
    });

    const [, captured] = mockFlushCapturedUsage.mock.calls[0];
    expect(captured[0].counters.cacheWrite5mTokens).toBeUndefined();
    expect(captured[0].usageCompleteness).toBe('partial');
  });

  it('falls back to the session aggregate when the CLI reported no modelUsage', async () => {
    flushReturns([{ id: 'r-build', model: 'claude-sonnet-5' }]);

    const outcome = await flushBuildSessionUsageReceipt({
      ...buildInput,
      inputTokens: 52_000,
      outputTokens: 18_000,
      authoritativeCostUsd: 4.25,
      modelUsage: {},
    });

    expect(outcome.granularity).toBe('session-aggregate');
    const [, captured] = mockFlushCapturedUsage.mock.calls[0];
    expect(captured).toHaveLength(1);
    expect(captured[0].providerModel).toBeUndefined();
    expect(captured[0].usageCompleteness).toBe('partial');
    expect(mockRecordSettlement.mock.calls[0][0].evidenceRef).toBe('claude-code-cli-total_cost_usd');
  });

  it('leaves a model unsettled rather than allocating a session total it cannot attribute', async () => {
    flushReturns([
      { id: 'r-a', model: 'model-a' },
      { id: 'r-b', model: 'model-b' },
    ]);

    const outcome = await flushBuildSessionUsageReceipt({
      ...buildInput,
      authoritativeCostUsd: 9.99,
      modelUsage: {
        'model-a': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, costUSD: 1.5 },
        // No costUSD — the provider reported no cost for this model.
        'model-b': { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 0 },
      },
    });

    expect(outcome.settlements).toEqual({ 'model-a': 'settled', 'model-b': 'skipped' });
    expect(mockRecordSettlement).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// ARUN-022 / AI-029 — out-of-process helper/revision sub-sessions
// ===========================================================================

describe('mission-usage-receipts — helper/revision sub-session envelope', () => {
  const subInput = {
    missionId: 'mission-7',
    owner: 'user:u1',
    asOf: '2026-07-29T09:00:00.000Z',
  };

  function flushReturns(receipts: Array<{ id: string; model?: string }>) {
    mockFlushCapturedUsage.mockResolvedValue({
      expected: receipts.length,
      written: receipts.length,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts,
      complete: true,
      markerPersisted: true,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordSettlement.mockResolvedValue(undefined);
  });

  it('receipts a revision turn under its own operation and identity', async () => {
    flushReturns([{ id: 'r-rev', model: 'claude-sonnet-4-6' }]);

    await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'revision',
      sessionKey: 'attempt-1-1753776000000',
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 900,
          outputTokens: 400,
          cacheReadInputTokens: 12_000,
          cacheCreationInputTokens: 800,
          costUSD: 0.21,
        },
      },
    });

    const [correlation, captured, prefix, scope] = mockFlushCapturedUsage.mock.calls[0];
    expect(correlation).toEqual({
      parentType: 'mission',
      owner: 'user:u1',
      correlationId: 'mission-7',
      missionId: 'mission-7',
    });
    // Distinct from `mission-mission-7` so a helper receipt can never collide
    // with the main orchestrator turn's.
    expect(prefix).toBe('revision-mission-7-attempt-1-1753776000000');
    // The mission headline already sums the revision turn.
    expect(scope).toBe('included-in-parent');
    expect(captured[0].operation).toBe('anthropic.revision-turn');
    expect(captured[0].providerModel).toBe('claude-sonnet-4-6');
    expect(captured[0].counters).toEqual({
      promptTokens: 900,
      outputTokens: 400,
      cacheReadTokens: 12_000,
      cacheWrite5mTokens: 800,
    });
    expect(captured[0].usageCompleteness).toBe('complete');
    expect(mockRecordSettlement.mock.calls[0][0].actualAmountMicros).toBe(210_000);
  });

  it('receipts a skill-prelude helper under its own operation', async () => {
    flushReturns([{ id: 'r-prelude', model: 'claude-sonnet-4-6' }]);

    await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'skill-prelude',
      sessionKey: '3-1753776000000',
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, costUSD: 0.02 },
      },
    });

    const [, captured, prefix] = mockFlushCapturedUsage.mock.calls[0];
    expect(prefix).toBe('skill-prelude-mission-7-3-1753776000000');
    expect(captured[0].operation).toBe('anthropic.prelude-turn');
  });

  it('gives each of several revisions a DISTINCT identity, so none overwrites another', async () => {
    flushReturns([{ id: 'r1', model: 'm' }]);

    for (const key of ['attempt-1-1000', 'attempt-1-2000', 'attempt-2-3000']) {
      await flushSubSessionUsageReceipts({
        ...subInput,
        kind: 'revision',
        sessionKey: key,
        modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.01 } },
      });
    }

    const prefixes = mockFlushCapturedUsage.mock.calls.map((call) => call[2]);
    expect(new Set(prefixes).size).toBe(3);
  });

  it('is replay-safe: the same sub-session re-flushes to the SAME identity', async () => {
    flushReturns([{ id: 'r1', model: 'm' }]);
    const input = {
      ...subInput,
      kind: 'revision' as const,
      sessionKey: 'attempt-1-1753776000000',
      modelUsage: { m: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0, costUSD: 0.03 } },
    };

    await flushSubSessionUsageReceipts(input);
    await flushSubSessionUsageReceipts(input);

    const [firstPrefix, secondPrefix] = mockFlushCapturedUsage.mock.calls.map((call) => call[2]);
    expect(firstPrefix).toBe(secondPrefix);
    // The settlement is keyed on (receipt, occurredAt, evidenceRef, revision),
    // so an identical re-record is an idempotent replay, not a second charge.
    const [first, second] = mockRecordSettlement.mock.calls.map((call) => call[0]);
    expect(first).toEqual(second);
  });

  it('records honest partial usage when the provider omitted the cache facts', async () => {
    flushReturns([{ id: 'r1', model: 'm' }]);

    await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'revision',
      sessionKey: 'attempt-1-1',
      // No cacheReadInputTokens — the provider reported no cache fact at all.
      modelUsage: { m: { inputTokens: 10, outputTokens: 4 } },
    });

    const [, captured] = mockFlushCapturedUsage.mock.calls[0];
    expect(captured[0].usageCompleteness).toBe('partial');
    // An absent cache fact must never be recorded as a known zero.
    expect(captured[0].counters.cacheReadTokens).toBeUndefined();
  });

  it('settles nothing when the provider reported no per-model cost', async () => {
    flushReturns([{ id: 'r1', model: 'm' }]);

    const outcome = await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'skill-prelude',
      sessionKey: '0-1',
      modelUsage: { m: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 0 } },
    });

    expect(outcome.settlements).toEqual({ m: 'skipped' });
    expect(mockRecordSettlement).not.toHaveBeenCalled();
  });

  it('is a no-op when the sub-session reported no models at all', async () => {
    const outcome = await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'revision',
      sessionKey: 'attempt-1-1',
      modelUsage: {},
    });

    expect(outcome).toEqual({ flush: undefined, settlements: {} });
    expect(mockFlushCapturedUsage).not.toHaveBeenCalled();
  });

  it('keeps a ledger outage non-fatal for the mission it observes', async () => {
    mockFlushCapturedUsage.mockRejectedValueOnce(new Error('ledger down'));

    const outcome = await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'revision',
      sessionKey: 'attempt-1-1',
      modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.01 } },
    });

    expect(outcome).toEqual({ flush: undefined, settlements: {} });
  });

  it('sanitizes an id-unsafe session key instead of deriving an invalid receipt id', async () => {
    flushReturns([{ id: 'r1', model: 'm' }]);

    await flushSubSessionUsageReceipts({
      ...subInput,
      kind: 'revision',
      sessionKey: 'attempt 1/with~unsafe chars',
      modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } },
    });

    const prefix = mockFlushCapturedUsage.mock.calls[0][2];
    expect(prefix).toBe('revision-mission-7-attempt-1-with-unsafe-chars');
    expect(prefix).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

// ===========================================================================
// The identities/slugs above are asserted against MOCKS. This suite checks the
// same values against the REAL receipt schema, so a slug or key this module
// mints can never be one the persistence boundary would reject at runtime.
// ===========================================================================

describe('mission-usage-receipts — new identities are valid against the real schema', () => {
  const {
    createOperationReceiptSchema,
    deriveOperationReceiptId,
  } = require('@/lib/schemas/operation-receipt');

  function receiptFor(operation: string, invocationId: string) {
    return {
      correlation: {
        parentType: 'mission' as const,
        owner: 'user:u1',
        correlationId: 'mission-7',
        missionId: 'mission-7',
      },
      operation,
      invocationId,
      attempt: 0,
      responseOrdinal: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestedModel: 'claude-sonnet-4-6',
      modelProvenance: 'provider-reported' as const,
      counters: { promptTokens: 900, outputTokens: 400, cacheReadTokens: 12_000, cacheWrite5mTokens: 800 },
      usageCompleteness: 'complete' as const,
      occurredAt: '2026-07-29T09:00:00.000Z',
      accountingScope: 'included-in-parent' as const,
      feeState: 'none' as const,
    };
  }

  it.each([
    ['anthropic.revision-turn', 'revision-mission-7-attempt-1-1753776000000.0'],
    ['anthropic.prelude-turn', 'skill-prelude-mission-7-3-1753776000000.0'],
    ['anthropic.build-session', 'build-build-9-session-2.1'],
  ])('accepts operation %s with invocationId %s', (operation, invocationId) => {
    const parsed = createOperationReceiptSchema.safeParse(receiptFor(operation, invocationId));
    expect(parsed.success).toBe(true);

    // And the identity derives a Firestore-safe id rather than throwing.
    const id = deriveOperationReceiptId({
      owner: 'user:u1',
      parentType: 'mission',
      correlationId: 'mission-7',
      operation,
      invocationId,
      attempt: 0,
      responseOrdinal: 0,
    });
    expect(id.startsWith('oprcpt~v1~')).toBe(true);
    expect(id.length).toBeLessThan(1500);
  });
});
