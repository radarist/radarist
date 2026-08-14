/**
 * ARUN-022 — live Admin-SDK repository contract against a REAL Firestore
 * emulator (no mocks). Proves the write/replay/query path end-to-end:
 *   - create then owner-scoped read-back (and cross-owner isolation);
 *   - exact replay is idempotent (same id, original recordedAt, no second write);
 *   - conflicting replay (same identity, different facts) throws;
 *   - owner+parentType+correlation query excludes other owners and parent types;
 *   - two distinct same-tool calls under one parent (differing only by
 *     invocationId) both persist as separate receipts.
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import {
  recordOperationReceipt,
  getOperationReceipt,
  listOperationReceiptsByCorrelation,
  OperationReceiptConflictError,
} from '@/lib/operation-receipt-repository';
import {
  deriveOperationReceiptId,
  receiptIdentity,
  createOperationReceiptSchema,
  type CreateOperationReceiptInput,
} from '@/lib/schemas/operation-receipt';

const COLLECTION = 'operationReceipts';
const OWNER = 'workspace-emulator';
const written = new Set<string>();

function verification(correlationId: string, owner = OWNER): CreateOperationReceiptInput['correlation'] {
  return {
    parentType: 'verification',
    owner,
    correlationId,
    inngestRunId: 'inngest-run-emulator',
    verificationResultId: 'vr-emulator',
    entityId: 'company-emulator',
    entityType: 'companies',
  };
}

function input(overrides: Partial<CreateOperationReceiptInput> = {}): CreateOperationReceiptInput {
  return {
    correlation: verification('jobrun-emulator'),
    operation: 'verify-entity.grounded-search',
    invocationId: 'call-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'gemini',
    model: 'gemini-3-pro',
    modelProvenance: 'provider-reported',
    counters: { promptTokens: 1200, outputTokens: 340, queryCount: 2 },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T09:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
    // NOTE: no `cost` — the create input carries raw facts only; the repository
    // derives the canonical cost inside the persistence boundary.
    ...overrides,
  };
}

async function record(overrides: Partial<CreateOperationReceiptInput> = {}) {
  const receipt = await recordOperationReceipt(input(overrides));
  written.add(receipt.id);
  return receipt;
}

afterAll(async () => {
  await Promise.all(
    [...written].map((id) =>
      adminDb
        .collection(COLLECTION)
        .doc(id)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb.terminate();
});

describe('operation-receipt repository (live emulator)', () => {
  it('creates a receipt and reads it back for its owner only', async () => {
    const receipt = await record({ correlation: verification('corr-create') });

    const mine = await getOperationReceipt(OWNER, receipt.id);
    expect(mine?.id).toBe(receipt.id);
    expect(mine?.counters.promptTokens).toBe(1200);

    // Fail closed across owners even with the correct id.
    expect(await getOperationReceipt('workspace-other', receipt.id)).toBeNull();
  });

  // ------------------------------------------------------------------------
  // Cost is DERIVED inside the persistence boundary, never trusted (defect B)
  // ------------------------------------------------------------------------

  it('derives a valid canonical estimate for a real card model — the caller supplies none', async () => {
    const receipt = await record({
      correlation: verification('corr-derive-estimate'),
      model: 'gemini-3.5-flash',
    });
    const stored = await getOperationReceipt(OWNER, receipt.id);
    expect(stored?.cost.state).toBe('estimated');
    if (stored?.cost.state === 'estimated') {
      expect(stored.cost.currency).toBe('USD');
      expect(stored.cost.resolvedModel).toBe('gemini-3.5-flash');
      // amountMicros == Σ breakdown, by construction.
      const b = stored.cost.breakdown ?? {};
      const sum = Object.values(b).reduce<number>((acc, m) => acc + (m ?? 0), 0);
      expect(stored.cost.amountMicros).toBe(sum);
    }
  });

  it('fails closed to `unavailable` for an off-card model — never $0', async () => {
    const receipt = await record({ correlation: verification('corr-derive-unavail'), model: 'model-not-on-card' });
    const stored = await getOperationReceipt(OWNER, receipt.id);
    expect(stored?.cost).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });

  it('a KNOWN fee in a foreign currency (EUR) fails the cost closed — never relabeled USD', async () => {
    const receipt = await record({
      correlation: verification('corr-derive-eur'),
      model: 'gemini-3.5-flash',
      feeState: 'known',
      externalFees: { currency: 'EUR', groundingFeeMicros: 50000 },
    });
    const stored = await getOperationReceipt(OWNER, receipt.id);
    expect(stored?.cost.state).toBe('unavailable');
  });

  it('rejects a caller-supplied cost outright (no write) — cost is not a create input', async () => {
    const forged = {
      ...input({ correlation: verification('corr-forged-cost') }),
      cost: { state: 'actual', amountMicros: 999999, currency: 'USD', covers: 'tokens', evidenceRef: 'forged' },
    } as unknown as CreateOperationReceiptInput;
    await expect(recordOperationReceipt(forged)).rejects.toThrow();
  });

  it('is idempotent on exact replay — same id, original recordedAt', async () => {
    const first = await record({ correlation: verification('corr-replay') });
    const second = await record({ correlation: verification('corr-replay') });
    expect(second.id).toBe(first.id);
    expect(second.recordedAt).toBe(first.recordedAt);
  });

  it('throws on a conflicting replay (same identity, different immutable facts)', async () => {
    const first = await record({ correlation: verification('corr-conflict') });
    await expect(
      recordOperationReceipt(input({ correlation: verification('corr-conflict'), counters: { promptTokens: 999 } }))
    ).rejects.toBeInstanceOf(OperationReceiptConflictError);
    // The original is untouched.
    const stored = await getOperationReceipt(OWNER, first.id);
    expect(stored?.counters.promptTokens).toBe(1200);
  });

  it('lists by owner + parentType + correlation, excluding other owners and parent types', async () => {
    const correlationId = 'corr-list';
    const r0 = await record({ correlation: verification(correlationId), responseOrdinal: 0 });
    const r1 = await record({ correlation: verification(correlationId), responseOrdinal: 1 });
    // Same correlationId + owner, different parentType — must be excluded.
    await record({
      correlation: { parentType: 'mission', owner: OWNER, correlationId, missionId: 'mission-emulator' },
    });
    // Same correlationId + parentType, different owner — must be excluded.
    await record({ correlation: verification(correlationId, 'workspace-foreign') });

    const list = await listOperationReceiptsByCorrelation(OWNER, 'verification', correlationId);
    expect(list.map((r) => r.id).sort()).toEqual([r0.id, r1.id].sort());
    expect(list.every((r) => r.correlation.owner === OWNER && r.correlation.parentType === 'verification')).toBe(true);
  });

  it('persists two distinct same-tool calls under one parent as separate receipts', async () => {
    const callA = await record({ correlation: verification('corr-invocation'), invocationId: 'call-a' });
    const callB = await record({ correlation: verification('corr-invocation'), invocationId: 'call-b' });
    expect(callA.id).not.toBe(callB.id);

    const list = await listOperationReceiptsByCorrelation(OWNER, 'verification', 'corr-invocation');
    expect(list.map((r) => r.id).sort()).toEqual([callA.id, callB.id].sort());
  });

  // ------------------------------------------------------------------------
  // Backward compatibility with LEGACY (schema v1) documents (disposable Firestore)
  // ------------------------------------------------------------------------

  /** Write a legacy v1-shaped document (no schemaVersion/occurredAt/scope/fee)
   * DIRECTLY to Firestore, bypassing recordOperationReceipt (which stamps v2).
   * `matchInput` writes a doc whose shared v1 facts equal `input(correlation)`'s
   * (so a v2 re-record is an idempotent replay); otherwise it writes a distinct
   * legacy shape (ambiguous cacheWriteTokens + unavailable cost). */
  async function writeLegacyDoc(correlationId: string, opts: { matchInput?: boolean } = {}): Promise<string> {
    const parsed = createOperationReceiptSchema.parse(input({ correlation: verification(correlationId) }));
    const id = deriveOperationReceiptId(receiptIdentity(parsed));
    const { occurredAt, accountingScope, feeState, ...rest } = parsed;
    void occurredAt;
    void accountingScope;
    void feeState;
    // A legacy v1 stored doc still carries a cost (an incomplete legacy fact) — the
    // stored schema requires one — but no schemaVersion / occurrence / scope / fee.
    const legacy = opts.matchInput
      ? {
          ...rest,
          cost: { state: 'unavailable', reason: 'accounting-incomplete' },
          id,
          recordedAt: '2026-07-10T00:00:00.000Z',
        }
      : {
          ...rest,
          counters: { promptTokens: 300, outputTokens: 100, cacheWriteTokens: 40 },
          cost: { state: 'unavailable', reason: 'accounting-incomplete' },
          id,
          recordedAt: '2026-07-10T00:00:00.000Z',
        };
    await adminDb.collection(COLLECTION).doc(id).set(legacy);
    written.add(id);
    return id;
  }

  it('reads a legacy v1 document back verbatim (no schemaVersion / occurrence / fee)', async () => {
    const id = await writeLegacyDoc('corr-legacy-read');
    const stored = await getOperationReceipt(OWNER, id);
    expect(stored?.schemaVersion).toBeUndefined();
    expect(stored?.occurredAt).toBeUndefined();
    expect(stored?.accountingScope).toBeUndefined();
    expect(stored?.feeState).toBeUndefined();
    expect(stored?.counters.cacheWriteTokens).toBe(40);
  });

  it('lists a mixed v1/v2 correlation without failing on the legacy member', async () => {
    const correlationId = 'corr-legacy-mixed';
    const legacyId = await writeLegacyDoc(correlationId);
    const v2 = await record({ correlation: verification(correlationId), invocationId: 'v2-call' });
    const list = await listOperationReceiptsByCorrelation(OWNER, 'verification', correlationId);
    expect(list.map((r) => r.id).sort()).toEqual([legacyId, v2.id].sort());
    const legacyRow = list.find((r) => r.id === legacyId);
    expect(legacyRow?.schemaVersion).toBeUndefined();
  });

  it('a v2 re-record over a MATCHING legacy document is idempotent (no re-write, legacy preserved)', async () => {
    const correlationId = 'corr-legacy-replay-ok';
    const id = await writeLegacyDoc(correlationId, { matchInput: true });
    const receipt = await recordOperationReceipt(input({ correlation: verification(correlationId) }));
    expect(receipt.id).toBe(id);
    expect(receipt.recordedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(receipt.schemaVersion).toBeUndefined();
  });

  it('a v2 re-record over a legacy document with DIFFERENT shared facts CONFLICTS', async () => {
    const correlationId = 'corr-legacy-replay-conflict';
    // Distinct legacy shape (different counters + unavailable cost) vs the v2 input.
    await writeLegacyDoc(correlationId);
    await expect(recordOperationReceipt(input({ correlation: verification(correlationId) }))).rejects.toBeInstanceOf(
      OperationReceiptConflictError
    );
  });

  /** Write a v1 doc of a CACHED response: v1 stored NON-cached prompt + the cached
   * subset. `cacheReadTokens` is the cached subset; `totalPrompt` is the raw total. */
  async function writeCachedLegacyDoc(correlationId: string, totalPrompt: number, cached: number): Promise<string> {
    const parsed = createOperationReceiptSchema.parse(
      input({
        correlation: verification(correlationId),
        counters: { promptTokens: totalPrompt, outputTokens: 200, cacheReadTokens: cached },
      })
    );
    const id = deriveOperationReceiptId(receiptIdentity(parsed));
    const { occurredAt, accountingScope, feeState, ...rest } = parsed;
    void occurredAt;
    void accountingScope;
    void feeState;
    const legacy = {
      ...rest,
      counters: { promptTokens: totalPrompt - cached, outputTokens: 200, cacheReadTokens: cached },
      cost: { state: 'unavailable', reason: 'accounting-incomplete' },
      id,
      recordedAt: '2026-07-10T00:00:00.000Z',
    };
    await adminDb.collection(COLLECTION).doc(id).set(legacy);
    written.add(id);
    return id;
  }

  it('a v2 re-record of the SAME cached response over a v1 doc (non-cached prompt) replays idempotently', async () => {
    const correlationId = 'corr-legacy-cached-ok';
    // v1: non-cached 700 + cached 300 = total 1000.
    const id = await writeCachedLegacyDoc(correlationId, 1000, 300);
    // v2: RAW prompt 1000 (includes the 300 cached) + cache 300 — the SAME response.
    const receipt = await recordOperationReceipt(
      input({
        correlation: verification(correlationId),
        counters: { promptTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      })
    );
    expect(receipt.id).toBe(id);
    expect(receipt.schemaVersion).toBeUndefined(); // immutable legacy record preserved
  });

  it('a v2 re-record with a DIFFERENT cache split over a cached v1 doc CONFLICTS', async () => {
    const correlationId = 'corr-legacy-cached-conflict';
    await writeCachedLegacyDoc(correlationId, 1000, 300); // total 1000, cached 300
    // Genuinely different cache split (cached 400) → different response → conflict.
    await expect(
      recordOperationReceipt(
        input({
          correlation: verification(correlationId),
          counters: { promptTokens: 1000, outputTokens: 200, cacheReadTokens: 400 },
        })
      )
    ).rejects.toBeInstanceOf(OperationReceiptConflictError);
  });

  // ------------------------------------------------------------------------
  // Provider-aware legacy replay (defect A) — Anthropic uses DISJOINT cache
  // semantics: the prompt counter EXCLUDES cache in BOTH v1 and v2, so cache is
  // NEVER folded into the prompt during version normalization.
  // ------------------------------------------------------------------------

  /** A v1 Anthropic doc: prompt is DISJOINT from cache (same shape in v1 and v2). */
  async function writeAnthropicLegacyDoc(correlationId: string, prompt: number, cache: number): Promise<string> {
    const parsed = createOperationReceiptSchema.parse(
      input({
        correlation: verification(correlationId),
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        counters: { promptTokens: prompt, outputTokens: 200, cacheReadTokens: cache },
      })
    );
    const id = deriveOperationReceiptId(receiptIdentity(parsed));
    const { occurredAt, accountingScope, feeState, ...rest } = parsed;
    void occurredAt;
    void accountingScope;
    void feeState;
    const legacy = {
      ...rest,
      // Disjoint: prompt is NOT reduced by cache in v1 (unlike a subset provider).
      counters: { promptTokens: prompt, outputTokens: 200, cacheReadTokens: cache },
      cost: { state: 'unavailable', reason: 'accounting-incomplete' },
      id,
      recordedAt: '2026-07-10T00:00:00.000Z',
    };
    await adminDb.collection(COLLECTION).doc(id).set(legacy);
    written.add(id);
    return id;
  }

  it('Anthropic (disjoint): v1 prompt=700/cache=300 and v2 prompt=700/cache=300 replay IDEMPOTENTLY', async () => {
    const correlationId = 'corr-anthropic-cached-ok';
    const id = await writeAnthropicLegacyDoc(correlationId, 700, 300);
    const receipt = await recordOperationReceipt(
      input({
        correlation: verification(correlationId),
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        counters: { promptTokens: 700, outputTokens: 200, cacheReadTokens: 300 },
      })
    );
    expect(receipt.id).toBe(id);
    expect(receipt.schemaVersion).toBeUndefined(); // immutable legacy record preserved
  });

  it('Anthropic (disjoint): v2 prompt=1000/cache=300 over a v1 prompt=700/cache=300 doc CONFLICTS', async () => {
    const correlationId = 'corr-anthropic-cached-conflict';
    await writeAnthropicLegacyDoc(correlationId, 700, 300);
    await expect(
      recordOperationReceipt(
        input({
          correlation: verification(correlationId),
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          counters: { promptTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
        })
      )
    ).rejects.toBeInstanceOf(OperationReceiptConflictError);
  });
});
