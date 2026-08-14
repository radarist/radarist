/**
 * ARUN-022 — live Admin-SDK settlement repository against a REAL Firestore
 * emulator (no mocks). Proves the append-only settlement contract end-to-end:
 *   - a settlement can only be appended against a receipt the SAME owner owns;
 *   - exact replay is idempotent; a conflicting replay throws;
 *   - a correction SUPERSEDES an existing settlement (revision +1), and the
 *     canonical reader follows the chain to the one proven head;
 *   - competing heads (a fork) resolve to `conflicted`, never a guessed amount;
 *   - cross-receipt / non-monotonic supersession is rejected at write time.
 *
 * Runs via `npm run test:emulator` or standalone through
 * `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import { recordOperationReceipt } from '@/lib/operation-receipt-repository';
import {
  recordOperationSettlement,
  getOperationSettlement,
  resolveSettledAmount,
  OperationSettlementConflictError,
  OperationSettlementOwnershipError,
  OperationSettlementSupersessionError,
} from '@/lib/operation-settlement-repository';
import type { CreateOperationReceiptInput } from '@/lib/schemas/operation-receipt';
import type { CreateOperationSettlementInput } from '@/lib/schemas/operation-settlement';

const RECEIPTS = 'operationReceipts';
const SETTLEMENTS = 'operationSettlements';
const OWNER = 'workspace-settle-emulator';
const writtenReceipts = new Set<string>();
const writtenSettlements = new Set<string>();

/** Create a real receipt (settlement ownership verifies against the stored receipt). */
async function createReceipt(correlationId: string, owner = OWNER): Promise<string> {
  const receiptInput: CreateOperationReceiptInput = {
    correlation: {
      parentType: 'verification',
      owner,
      correlationId,
      inngestRunId: 'inngest-run-settle',
      verificationResultId: 'vr-settle',
      entityId: 'company-settle',
      entityType: 'companies',
    },
    operation: 'verify-entity.grounded-search',
    invocationId: 'call-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    modelProvenance: 'provider-reported',
    counters: { promptTokens: 1000, outputTokens: 200 },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T09:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
  };
  const receipt = await recordOperationReceipt(receiptInput);
  writtenReceipts.add(receipt.id);
  return receipt.id;
}

function settlementInput(
  receiptId: string,
  overrides: Partial<CreateOperationSettlementInput> = {}
): CreateOperationSettlementInput {
  return {
    receiptId,
    owner: OWNER,
    actualAmountMicros: 5000,
    currency: 'USD',
    covers: 'tokens-and-fees',
    evidenceRef: 'invoice-1',
    occurredAt: '2026-07-31T00:00:00.000Z',
    revision: 0,
    ...overrides,
  };
}

async function append(receiptId: string, overrides: Partial<CreateOperationSettlementInput> = {}) {
  const s = await recordOperationSettlement(settlementInput(receiptId, overrides));
  writtenSettlements.add(s.id);
  return s;
}

afterAll(async () => {
  await Promise.all([
    ...[...writtenReceipts].map((id) =>
      adminDb
        .collection(RECEIPTS)
        .doc(id)
        .delete()
        .catch(() => undefined)
    ),
    ...[...writtenSettlements].map((id) =>
      adminDb
        .collection(SETTLEMENTS)
        .doc(id)
        .delete()
        .catch(() => undefined)
    ),
  ]);
  await adminDb.terminate();
});

describe('operation-settlement repository (live emulator)', () => {
  it('appends a base settlement against an owned receipt and reads it back owner-scoped', async () => {
    const receiptId = await createReceipt('settle-base');
    const s = await append(receiptId);
    expect(await getOperationSettlement(OWNER, s.id)).toEqual(s);
    expect(await getOperationSettlement('workspace-other', s.id)).toBeNull();
  });

  it('rejects a settlement whose owner does not own the referenced receipt', async () => {
    const foreignReceiptId = await createReceipt('settle-foreign', 'workspace-foreign');
    await expect(recordOperationSettlement(settlementInput(foreignReceiptId))).rejects.toBeInstanceOf(
      OperationSettlementOwnershipError
    );
  });

  it('is idempotent on exact replay and conflicts on a divergent replay', async () => {
    const receiptId = await createReceipt('settle-replay');
    const first = await append(receiptId);
    const replay = await append(receiptId);
    expect(replay.id).toBe(first.id);
    await expect(
      recordOperationSettlement(settlementInput(receiptId, { actualAmountMicros: 9999 }))
    ).rejects.toBeInstanceOf(OperationSettlementConflictError);
  });

  it('follows a correction chain to the proven head (never guesses by ordering)', async () => {
    const receiptId = await createReceipt('settle-chain');
    const base = await append(receiptId, { revision: 0, evidenceRef: 'inv-base', actualAmountMicros: 5000 });
    await append(receiptId, {
      revision: 1,
      supersedesSettlementId: base.id,
      evidenceRef: 'inv-corrected',
      actualAmountMicros: 5200,
    });
    const res = await resolveSettledAmount(OWNER, receiptId);
    expect(res.status).toBe('settled');
    if (res.status === 'settled') expect(res.head.actualAmountMicros).toBe(5200);
  });

  it('reports conflicted for competing heads (a fork), never a guessed amount', async () => {
    const receiptId = await createReceipt('settle-fork');
    const base = await append(receiptId, { revision: 0, evidenceRef: 'inv-base' });
    await append(receiptId, { revision: 1, supersedesSettlementId: base.id, evidenceRef: 'inv-A' });
    await append(receiptId, { revision: 1, supersedesSettlementId: base.id, evidenceRef: 'inv-B' });
    const res = await resolveSettledAmount(OWNER, receiptId);
    expect(res.status).toBe('conflicted');
  });

  it('rejects a non-monotonic supersession at write time', async () => {
    const receiptId = await createReceipt('settle-nonmonotonic');
    const base = await append(receiptId, { revision: 0, evidenceRef: 'inv-base' });
    await expect(
      recordOperationSettlement(
        settlementInput(receiptId, { revision: 5, supersedesSettlementId: base.id, evidenceRef: 'inv-skew' })
      )
    ).rejects.toBeInstanceOf(OperationSettlementSupersessionError);
  });
});
