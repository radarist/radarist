/**
 * @file lib/__tests__/operation-settlement-repository.test.ts
 * @description ARUN-022 — append-only, owner-scoped settlement repository.
 *
 * Covers:
 * - a settlement can only be appended against a receipt the SAME owner owns
 *   (ownership verified server-side against the stored receipt);
 * - exact replay is idempotent; a conflicting replay (same identity, different
 *   facts) throws — a settled fact is never overwritten;
 * - a later correction / different invoice is a distinct append that persists
 *   alongside the original;
 * - reads are owner-scoped.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock } from './helpers/firebase-admin-mock';
import { createOperationSettlementSchema, deriveOperationSettlementId } from '../schemas/operation-settlement';
import { sanitizeForFirestore } from '../firestore-sanitize';
import type { CreateOperationSettlementInput, OperationSettlement } from '../schemas/operation-settlement';

const { adminMock } = createFirebaseAdminMock();
const mockGetOperationReceipt = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));
jest.mock('@/lib/operation-receipt-repository', () => ({
  getOperationReceipt: (...args: unknown[]) => mockGetOperationReceipt(...args),
}));

const {
  recordOperationSettlement,
  listOperationSettlementsByReceipt,
  getOperationSettlement,
  resolveSettledAmount,
  OperationSettlementConflictError,
  OperationSettlementOwnershipError,
  OperationSettlementSupersessionError,
} = require('../operation-settlement-repository');

const RECEIPT_ID = 'oprcpt~v1~4~acme~12~verification~5~jr-01~7~verify.x~6~call-1~1~0~1~0';

function input(overrides: Partial<CreateOperationSettlementInput> = {}): CreateOperationSettlementInput {
  return {
    receiptId: RECEIPT_ID,
    owner: 'workspace-abc',
    actualAmountMicros: 5000,
    currency: 'USD',
    covers: 'tokens-and-fees',
    evidenceRef: 'invoice-42',
    occurredAt: '2026-07-31T00:00:00.000Z',
    revision: 0,
    ...overrides,
  };
}

function storedDoc(overrides: Partial<CreateOperationSettlementInput> = {}, recordedAt = '2026-08-01T00:00:00.000Z') {
  const parsed = createOperationSettlementSchema.parse(input(overrides));
  const id = deriveOperationSettlementId(parsed);
  return sanitizeForFirestore({ ...parsed, id, recordedAt }) as OperationSettlement;
}

beforeEach(() => {
  jest.clearAllMocks();
  adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
  // Default: the referenced receipt exists and is owned by workspace-abc.
  mockGetOperationReceipt.mockResolvedValue({ id: RECEIPT_ID, correlation: { owner: 'workspace-abc' } });
});

describe('recordOperationSettlement — append', () => {
  it('appends a settlement against a receipt the owner owns', async () => {
    const settlement = await recordOperationSettlement(input());
    expect(mockGetOperationReceipt).toHaveBeenCalledWith('workspace-abc', RECEIPT_ID);
    expect(adminMock.collection).toHaveBeenCalledWith('operationSettlements');
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
    expect(settlement.id).toBe(deriveOperationSettlementId(createOperationSettlementSchema.parse(input())));
    expect(settlement.actualAmountMicros).toBe(5000);
    expect(typeof settlement.recordedAt).toBe('string');
    expect(settlement.recordedAt).not.toBe(settlement.occurredAt);
  });

  it('rejects a settlement whose owner does not own the referenced receipt (or it is absent)', async () => {
    mockGetOperationReceipt.mockResolvedValue(null); // getOperationReceipt is owner-scoped
    await expect(recordOperationSettlement(input())).rejects.toBeInstanceOf(OperationSettlementOwnershipError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('is idempotent on exact replay (same id, no second write)', async () => {
    const existing = storedDoc();
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });
    const settlement = await recordOperationSettlement(input());
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
    expect(settlement).toEqual(existing);
  });

  it('throws on a conflicting replay (same identity, different amount) — a settled fact is never overwritten', async () => {
    const existing = storedDoc({ actualAmountMicros: 9999 });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => existing });
    await expect(recordOperationSettlement(input())).rejects.toBeInstanceOf(OperationSettlementConflictError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('a later correction (different occurredAt) is a DISTINCT append, not a conflict', async () => {
    const first = deriveOperationSettlementId(createOperationSettlementSchema.parse(input()));
    const correction = deriveOperationSettlementId(
      createOperationSettlementSchema.parse(input({ occurredAt: '2026-08-15T00:00:00.000Z', actualAmountMicros: 5200 }))
    );
    expect(correction).not.toBe(first);
    // The correction targets an empty slot → a fresh append.
    await recordOperationSettlement(input({ occurredAt: '2026-08-15T00:00:00.000Z', actualAmountMicros: 5200 }));
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
  });
});

describe('recordOperationSettlement — supersession (correction chain)', () => {
  it('appends a valid correction that supersedes an existing settlement (revision +1)', async () => {
    const base = storedDoc({ revision: 0 });
    // docGet #1 = getOperationSettlement(parent) → base; #2 = tx.get(slot) → empty.
    adminMock.docGet
      .mockResolvedValueOnce({ exists: true, data: () => base })
      .mockResolvedValueOnce({ exists: false, data: () => null });
    const correction = await recordOperationSettlement(
      input({ revision: 1, supersedesSettlementId: base.id, evidenceRef: 'invoice-43', actualAmountMicros: 5200 })
    );
    expect(correction.revision).toBe(1);
    expect(correction.supersedesSettlementId).toBe(base.id);
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
  });

  it('rejects a correction whose superseded settlement is absent / not owned (cross-owner via owner-scoped read)', async () => {
    adminMock.docGet.mockResolvedValueOnce({ exists: false, data: () => null }); // parent not found
    await expect(
      recordOperationSettlement(
        input({ revision: 1, supersedesSettlementId: 'opsettl~v1~gone', evidenceRef: 'invoice-43' })
      )
    ).rejects.toBeInstanceOf(OperationSettlementSupersessionError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('rejects a correction that supersedes a settlement of a DIFFERENT receipt', async () => {
    // A self-consistent parent (its id derives from its own receiptId) that belongs
    // to a DIFFERENT receipt, so the supersession check — not the id check — fires.
    const crossReceiptParent = storedDoc({ receiptId: 'oprcpt~v1~other-receipt', revision: 0 });
    adminMock.docGet.mockResolvedValueOnce({ exists: true, data: () => crossReceiptParent });
    await expect(
      recordOperationSettlement(
        input({ revision: 1, supersedesSettlementId: crossReceiptParent.id, evidenceRef: 'invoice-43' })
      )
    ).rejects.toBeInstanceOf(OperationSettlementSupersessionError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });

  it('rejects a correction whose revision is not exactly one past the superseded settlement', async () => {
    const base = storedDoc({ revision: 0 });
    adminMock.docGet.mockResolvedValueOnce({ exists: true, data: () => base });
    await expect(
      recordOperationSettlement(
        input({ revision: 5, supersedesSettlementId: base.id, evidenceRef: 'invoice-43', actualAmountMicros: 5200 })
      )
    ).rejects.toBeInstanceOf(OperationSettlementSupersessionError);
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });
});

describe('getOperationSettlement — owner-scoped point read', () => {
  it('returns the settlement for its owner and null for a different owner', async () => {
    const s = storedDoc({ revision: 0 });
    adminMock.docGet.mockResolvedValue({ exists: true, data: () => s });
    expect(await getOperationSettlement('workspace-abc', s.id)).toEqual(s);
    expect(await getOperationSettlement('workspace-other', s.id)).toBeNull();
  });
});

describe('resolveSettledAmount — canonical current amount, or fail closed', () => {
  it('follows the supersession chain to the proven head (never guesses by ordering)', async () => {
    const base = storedDoc({ revision: 0 });
    const rev1 = storedDoc({
      revision: 1,
      supersedesSettlementId: base.id,
      evidenceRef: 'invoice-43',
      actualAmountMicros: 6000,
    });
    adminMock.get.mockResolvedValue({ docs: [rev1, base].map((d) => ({ id: d.id, data: () => d })) });
    const res = await resolveSettledAmount('workspace-abc', RECEIPT_ID);
    expect(res.status).toBe('settled');
    if (res.status === 'settled') expect(res.head.actualAmountMicros).toBe(6000);
  });

  it('reports conflicted for competing heads (a fork), never a guessed amount', async () => {
    const base = storedDoc({ revision: 0 });
    const forkA = storedDoc({ revision: 1, supersedesSettlementId: base.id, evidenceRef: 'inv-A' });
    const forkB = storedDoc({ revision: 1, supersedesSettlementId: base.id, evidenceRef: 'inv-B' });
    adminMock.get.mockResolvedValue({ docs: [base, forkA, forkB].map((d) => ({ id: d.id, data: () => d })) });
    const res = await resolveSettledAmount('workspace-abc', RECEIPT_ID);
    expect(res.status).toBe('conflicted');
  });
});

describe('listOperationSettlementsByReceipt — owner-scoped', () => {
  it('queries by owner + receiptId and returns verified settlements sorted by occurrence', async () => {
    const a = storedDoc({ occurredAt: '2026-07-31T00:00:00.000Z', evidenceRef: 'inv-a' });
    const b = storedDoc({ occurredAt: '2026-08-15T00:00:00.000Z', evidenceRef: 'inv-b' });
    adminMock.get.mockResolvedValue({ docs: [b, a].map((d) => ({ id: d.id, data: () => d })) });
    const list = await listOperationSettlementsByReceipt('workspace-abc', RECEIPT_ID);
    expect(adminMock.where).toHaveBeenCalledWith('owner', '==', 'workspace-abc');
    expect(adminMock.where).toHaveBeenCalledWith('receiptId', '==', RECEIPT_ID);
    expect(list.map((s: OperationSettlement) => s.occurredAt)).toEqual([
      '2026-07-31T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    ]);
  });
});
