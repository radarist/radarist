/**
 * @file lib/__tests__/operation-receipt-repository.test.ts
 * @description ARUN-022 — durable operation-receipt repository tests.
 *
 * Covers the persistence contract:
 * - create writes one immutable receipt at its owner-scoped deterministic identity;
 * - exact replay is idempotent (returns the stored receipt, no re-write);
 * - conflicting replay (same identity, different immutable facts) throws;
 * - point and by-correlation reads are OWNER-SCOPED — a receipt is never
 *   returned to, or mixed with, a different owner's scope;
 * - stored documents are verified before they are returned.
 *
 * Firestore is exercised through the shared admin mock so the transaction /
 * doc chain matches production without an emulator.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock } from './helpers/firebase-admin-mock';
import { createOperationReceiptSchema, deriveOperationReceiptId, receiptIdentity } from '../schemas/operation-receipt';
import { priceReceiptCounters } from '../operation-receipt-pricing';
import { sanitizeForFirestore } from '../firestore-sanitize';
import type { CreateOperationReceiptInput, OperationCost, OperationReceipt } from '../schemas/operation-receipt';

const { adminMock } = createFirebaseAdminMock();

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

const {
  recordOperationReceipt,
  getOperationReceipt,
  listOperationReceiptsByCorrelation,
  OperationReceiptConflictError,
  OperationReceiptLedgerIntegrityError,
} = require('../operation-receipt-repository');

function validInput(overrides: Partial<CreateOperationReceiptInput> = {}): CreateOperationReceiptInput {
  return {
    correlation: {
      parentType: 'verification',
      owner: 'workspace-abc',
      correlationId: 'jobrun-123',
      inngestRunId: 'inngest-run-1',
      verificationResultId: 'vr-1',
      entityId: 'company-1',
      entityType: 'companies',
    },
    operation: 'verify-entity.grounded-search',
    invocationId: 'call-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'gemini',
    // A real card model, so the repository derives a genuine canonical estimate.
    model: 'gemini-3.5-flash',
    modelProvenance: 'provider-reported',
    counters: {
      promptTokens: 1200,
      outputTokens: 340,
      thinkingTokens: 50,
      cacheReadTokens: 800,
      queryCount: 2,
      imageCount: 0,
    },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T09:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
    ...overrides,
  };
}

/**
 * The canonical cost the REPOSITORY would derive for an input — computed with the
 * SAME kernel, so a `storedDoc` fixture matches the repository's write byte-for-byte
 * and an exact replay is idempotent.
 */
function derivedCostFor(parsed: CreateOperationReceiptInput): OperationCost {
  return priceReceiptCounters({
    provider: parsed.provider,
    model: parsed.model,
    requestedModel: parsed.requestedModel,
    modelProvenance: parsed.modelProvenance,
    usageCompleteness: parsed.usageCompleteness,
    counters: parsed.counters,
    feeState: parsed.feeState,
    externalFees: parsed.externalFees,
    occurredAt: parsed.occurredAt,
  });
}

/** The exact canonical shape a prior (v2) write left in Firestore for the given input. */
function storedDoc(input: CreateOperationReceiptInput, recordedAt = '2026-07-20T00:00:00.000Z'): OperationReceipt {
  const parsed = createOperationReceiptSchema.parse(input);
  const id = deriveOperationReceiptId(receiptIdentity(parsed));
  return sanitizeForFirestore({
    ...parsed,
    cost: derivedCostFor(parsed),
    id,
    recordedAt,
    schemaVersion: 2,
  }) as OperationReceipt;
}

/**
 * A LEGACY (schema v1) stored document of the SAME response as the input: no
 * schemaVersion / occurredAt / accountingScope / feeState, and the v1 prompt
 * semantics — `promptTokens` is NON-cached (raw total minus the cached subset) —
 * so it fingerprints identically to the v2 re-record of the same response.
 */
function legacyStoredDoc(
  overrides: Partial<CreateOperationReceiptInput> = {},
  cost: OperationCost = { state: 'unavailable', reason: 'accounting-incomplete' },
  recordedAt = '2026-07-19T00:00:00.000Z'
): Record<string, unknown> {
  const parsed = createOperationReceiptSchema.parse(validInput(overrides));
  const id = deriveOperationReceiptId(receiptIdentity(parsed));
  const { occurredAt, accountingScope, feeState, counters, ...rest } = parsed;
  void occurredAt;
  void accountingScope;
  void feeState;
  const v1Counters = { ...counters, promptTokens: (counters.promptTokens ?? 0) - (counters.cacheReadTokens ?? 0) };
  return sanitizeForFirestore({ ...rest, counters: v1Counters, cost, id, recordedAt }) as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
});

describe('recordOperationReceipt — create', () => {
  it('persists a new receipt at its deterministic identity and returns it', async () => {
    const input = validInput();
    const expectedId = deriveOperationReceiptId(receiptIdentity(createOperationReceiptSchema.parse(input)));

    const receipt = await recordOperationReceipt(input);

    expect(adminMock.collection).toHaveBeenCalledWith('operationReceipts');
    expect(adminMock.doc).toHaveBeenCalledWith(expectedId);
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
    const [, written] = adminMock.transactionSet.mock.calls[0];
    expect(written.id).toBe(expectedId);
    expect(written.counters.promptTokens).toBe(1200);
    expect(written.cost.state).toBe('estimated');
    expect(typeof written.recordedAt).toBe('string');
    // occurredAt is the immutable provider-occurrence fact supplied by the caller;
    // recordedAt is server-set at write time — they are DISTINCT facts.
    expect(written.occurredAt).toBe('2026-07-22T09:00:00.000Z');
    expect(written.recordedAt).not.toBe(written.occurredAt);
    expect(written.accountingScope).toBe('standalone');
    expect(written.feeState).toBe('none');
    // Every new write stamps the current schema version.
    expect(written.schemaVersion).toBe(2);
    expect(written).not.toHaveProperty('prompt');
    expect(receipt.id).toBe(expectedId);
  });
});

describe('recordOperationReceipt — cost is DERIVED inside the boundary, never trusted (defect B)', () => {
  it('mints a valid canonical estimate (full provenance) for a real card model — the caller supplies none', async () => {
    await recordOperationReceipt(validInput());
    const [, written] = adminMock.transactionSet.mock.calls[0];
    // gemini-3.5-flash @ input 1.5 / output 9 / cacheRead 0.15 per 1M, subset cache:
    // billable input 400·1.5 + output (340+50)·9 + cacheRead 800·0.15 → 600+3510+120.
    expect(written.cost).toMatchObject({
      state: 'estimated',
      currency: 'USD',
      resolvedModel: 'gemini-3.5-flash',
      amountMicros: 4230,
      breakdown: { inputMicros: 600, outputMicros: 3510, cacheReadMicros: 120 },
    });
    // amountMicros == Σ breakdown, by construction.
    const b = written.cost.breakdown;
    expect(written.cost.amountMicros).toBe((b.inputMicros ?? 0) + (b.outputMicros ?? 0) + (b.cacheReadMicros ?? 0));
  });

  it('fails closed to `unavailable` for an off-card model — never $0, never a guessed estimate', async () => {
    await recordOperationReceipt(validInput({ model: 'gemini-not-on-card' }));
    const [, written] = adminMock.transactionSet.mock.calls[0];
    expect(written.cost).toEqual({ state: 'unavailable', reason: 'unknown-pricing' });
  });

  it('a KNOWN fee in a foreign currency (EUR) fails closed — never relabeled as USD', async () => {
    await recordOperationReceipt(
      validInput({ feeState: 'known', externalFees: { currency: 'EUR', groundingFeeMicros: 50000 } })
    );
    const [, written] = adminMock.transactionSet.mock.calls[0];
    expect(written.cost.state).toBe('unavailable');
  });

  it('REJECTS any caller-supplied cost — forged actual / estimate / currency / model / tier / rate / breakdown', async () => {
    const forged = [
      { state: 'actual', amountMicros: 999999, currency: 'USD', covers: 'tokens', evidenceRef: 'forged' },
      { state: 'estimated', rateCardVersion: '2026-07-22', amountMicros: 1, currency: 'USD', covers: 'tokens' },
      { state: 'estimated', rateCardVersion: '9999-99-99', amountMicros: 1, currency: 'EUR', covers: 'tokens' },
      {
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 1,
        currency: 'USD',
        covers: 'tokens',
        resolvedModel: 'made-up-model',
        tierMaxContextTokens: 5,
        appliedRates: { inputPerMillion: 0.0001 },
        breakdown: { inputMicros: 1 },
      },
    ];
    for (const cost of forged) {
      const withForgedCost = { ...validInput(), cost } as unknown as CreateOperationReceiptInput;
      await expect(recordOperationReceipt(withForgedCost)).rejects.toThrow();
    }
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('fails closed to a CONFLICT on an undecidable legacy replay (unknown provider with cached tokens)', async () => {
    // A legacy v1 doc from an unknown provider carrying cached tokens cannot be
    // normalized for comparison — the repository must NOT silently replay it.
    const legacy = legacyStoredDoc({ provider: 'exa', model: undefined, modelProvenance: 'unreported' });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => legacy });
    await expect(
      recordOperationReceipt(validInput({ provider: 'exa', model: undefined, modelProvenance: 'unreported' }))
    ).rejects.toBeInstanceOf(OperationReceiptConflictError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });
});

describe('recordOperationReceipt — exact replay', () => {
  it('is idempotent: returns the stored receipt without re-writing', async () => {
    const input = validInput();
    const existing = storedDoc(input);
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });

    const receipt = await recordOperationReceipt(input);

    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(receipt).toEqual(existing);
    expect(receipt.recordedAt).toBe('2026-07-20T00:00:00.000Z');
  });
});

describe('recordOperationReceipt — legacy (v1) compatibility', () => {
  it('reads a legacy stored document (no schemaVersion/occurredAt) and returns it idempotently on a v2 re-record', async () => {
    const legacy = legacyStoredDoc();
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => legacy });

    // A current (v2) write over the same legacy identity must NOT fail merely
    // because the stored legacy doc lacks occurredAt/accountingScope/feeState.
    const receipt = await recordOperationReceipt(validInput());

    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(receipt.schemaVersion).toBeUndefined();
    expect(receipt.occurredAt).toBeUndefined();
    expect(receipt.recordedAt).toBe('2026-07-19T00:00:00.000Z');
  });

  it('CONFLICTS on a legacy replay whose shared v1 facts differ (changed counters)', async () => {
    // Stored legacy doc has different output tokens than the incoming re-record —
    // the newer observed spend must NOT silently disappear behind the legacy doc.
    const legacy = legacyStoredDoc({ counters: { ...validInput().counters, outputTokens: 999 } });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => legacy });
    await expect(recordOperationReceipt(validInput())).rejects.toBeInstanceOf(OperationReceiptConflictError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('is IDEMPOTENT when only the derived cost differs (same raw facts) — a legacy→canonical cost upgrade is a settlement, not a conflict', async () => {
    // Same raw provider facts (counters/model/provider), but the legacy doc's cost
    // is a legacy interpretation while the v2 re-record computes the canonical
    // estimate. The cost is EXCLUDED from the raw-fact comparison, so this is an
    // idempotent replay: the immutable legacy record is preserved.
    const legacy = legacyStoredDoc({}, { state: 'unavailable', reason: 'accounting-incomplete' });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => legacy });
    const receipt = await recordOperationReceipt(validInput());
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(receipt.cost).toEqual({ state: 'unavailable', reason: 'accounting-incomplete' });
  });

  it('CONFLICTS on a legacy replay whose served model differs', async () => {
    const legacy = legacyStoredDoc({ model: 'gemini-3-flash' });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => legacy });
    await expect(recordOperationReceipt(validInput())).rejects.toBeInstanceOf(OperationReceiptConflictError);
  });
});

describe('recordOperationReceipt — conflicting replay', () => {
  it('throws when the same identity is re-recorded with different immutable facts', async () => {
    const input = validInput();
    const existing = storedDoc(validInput({ counters: { ...validInput().counters, outputTokens: 999 } }));
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });

    await expect(recordOperationReceipt(input)).rejects.toBeInstanceOf(OperationReceiptConflictError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('throws when the effective model differs for the same identity', async () => {
    const input = validInput();
    const existing = storedDoc(validInput({ model: 'gemini-3-flash' }));
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });

    await expect(recordOperationReceipt(input)).rejects.toBeInstanceOf(OperationReceiptConflictError);
  });

  it('fails closed (no write) when the stored document is malformed', async () => {
    const input = validInput();
    const malformed = { ...storedDoc(input), recordedAt: 'not-a-timestamp' };
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => malformed });

    await expect(recordOperationReceipt(input)).rejects.toThrow();
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });
});

describe('getOperationReceipt — owner-scoped point read', () => {
  it('returns the stored receipt for its owner', async () => {
    const input = validInput();
    const existing = storedDoc(input);
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });

    const receipt = await getOperationReceipt('workspace-abc', existing.id);
    expect(receipt).toEqual(existing);
  });

  it('never returns a receipt belonging to a different owner', async () => {
    const input = validInput();
    const existing = storedDoc(input);
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });

    const receipt = await getOperationReceipt('workspace-other', existing.id);
    expect(receipt).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
    expect(await getOperationReceipt('workspace-abc', 'missing')).toBeNull();
  });
});

describe('listOperationReceiptsByCorrelation — owner-scoped', () => {
  it('queries by correlation id, filters to the owner, and sorts by recordedAt', async () => {
    const mine1 = storedDoc(validInput({ responseOrdinal: 1 }), '2026-07-20T02:00:00.000Z');
    const mine0 = storedDoc(validInput({ responseOrdinal: 0 }), '2026-07-20T01:00:00.000Z');
    // Same correlationId, different owner — must never mix into the result.
    const foreign = storedDoc(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'workspace-other',
          correlationId: 'jobrun-123',
          inngestRunId: 'inngest-run-1',
          verificationResultId: 'vr-1',
          entityId: 'company-1',
          entityType: 'companies',
        },
      }),
      '2026-07-20T03:00:00.000Z'
    );
    adminMock.get.mockResolvedValue({
      empty: false,
      size: 3,
      docs: [
        { id: mine1.id, data: () => mine1 },
        { id: foreign.id, data: () => foreign },
        { id: mine0.id, data: () => mine0 },
      ],
    });

    const receipts = await listOperationReceiptsByCorrelation('workspace-abc', 'verification', 'jobrun-123');

    expect(adminMock.where).toHaveBeenCalledWith('correlation.correlationId', '==', 'jobrun-123');
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r: OperationReceipt) => r.correlation.owner === 'workspace-abc')).toBe(true);
    expect(receipts.map((r: OperationReceipt) => r.recordedAt)).toEqual([
      '2026-07-20T01:00:00.000Z',
      '2026-07-20T02:00:00.000Z',
    ]);
  });

  it('pushes owner, parentType, AND correlationId equality predicates into Firestore', async () => {
    adminMock.get.mockResolvedValue({ empty: true, size: 0, docs: [] });

    await listOperationReceiptsByCorrelation('workspace-abc', 'verification', 'jobrun-123');

    expect(adminMock.where).toHaveBeenCalledWith('correlation.owner', '==', 'workspace-abc');
    expect(adminMock.where).toHaveBeenCalledWith('correlation.parentType', '==', 'verification');
    expect(adminMock.where).toHaveBeenCalledWith('correlation.correlationId', '==', 'jobrun-123');
  });

  it('never mixes a different parentType that shares the correlationId', async () => {
    const mine = storedDoc(validInput({ responseOrdinal: 0 }));
    // Same owner + correlationId, but a different parentType (mission) — must be excluded.
    const otherParent = storedDoc(
      validInput({
        correlation: { parentType: 'mission', owner: 'workspace-abc', correlationId: 'jobrun-123', missionId: 'm-1' },
      }),
      '2026-07-20T05:00:00.000Z'
    );
    adminMock.get.mockResolvedValue({
      empty: false,
      size: 2,
      docs: [
        { id: mine.id, data: () => mine },
        { id: otherParent.id, data: () => otherParent },
      ],
    });

    const receipts = await listOperationReceiptsByCorrelation('workspace-abc', 'verification', 'jobrun-123');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].correlation.parentType).toBe('verification');
  });

  it('throws an integrity error rather than silently omitting a corrupt receipt', async () => {
    const good = storedDoc(validInput({ responseOrdinal: 0 }));
    const corrupt = { ...storedDoc(validInput({ responseOrdinal: 1 })), recordedAt: 'not-a-timestamp' };
    adminMock.get.mockResolvedValue({
      empty: false,
      size: 2,
      docs: [
        { id: good.id, data: () => good },
        { id: corrupt.id, data: () => corrupt },
      ],
    });

    await expect(
      listOperationReceiptsByCorrelation('workspace-abc', 'verification', 'jobrun-123')
    ).rejects.toBeInstanceOf(OperationReceiptLedgerIntegrityError);
  });
});
