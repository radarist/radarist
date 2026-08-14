/**
 * @file lib/schemas/__tests__/operation-settlement.test.ts
 * @description ARUN-022 — settlement schema + deterministic identity + doc
 * verification + canonical single-chain resolution (append-only provider
 * actual/invoice facts, kept separate from the receipt's canonical estimate).
 *
 * @jest-environment node
 */

import {
  canonicalizeIso,
  createOperationSettlementSchema,
  operationSettlementSchema,
  deriveOperationSettlementId,
  parseOperationSettlementDoc,
  resolveSettlementChain,
  OperationSettlementError,
  type CreateOperationSettlementInput,
  type OperationSettlement,
} from '../operation-settlement';

const RECEIPT_ID = 'oprcpt~v1~4~acme~12~verification~5~jr-01~7~verify.x~6~call-1~1~0~1~0';

function validInput(overrides: Partial<CreateOperationSettlementInput> = {}): CreateOperationSettlementInput {
  return {
    receiptId: RECEIPT_ID,
    owner: 'workspace-abc',
    actualAmountMicros: 1234,
    currency: 'USD',
    covers: 'tokens-and-fees',
    evidenceRef: 'invoice-42',
    occurredAt: '2026-07-31T00:00:00.000Z',
    revision: 0,
    ...overrides,
  };
}

function stored(
  overrides: Partial<CreateOperationSettlementInput> = {},
  recordedAt = '2026-08-01T00:00:00.000Z'
): OperationSettlement {
  const input = createOperationSettlementSchema.parse(validInput(overrides));
  return operationSettlementSchema.parse({ ...input, id: deriveOperationSettlementId(input), recordedAt });
}

describe('operation-settlement schema', () => {
  it('accepts a valid settlement and requires an explicit currency + coverage', () => {
    expect(createOperationSettlementSchema.safeParse(validInput()).success).toBe(true);
    const { currency: _c, ...noCurrency } = validInput();
    expect(createOperationSettlementSchema.safeParse(noCurrency).success).toBe(false);
    const { covers: _v, ...noCovers } = validInput();
    expect(createOperationSettlementSchema.safeParse(noCovers).success).toBe(false);
  });

  it('rejects a fractional / negative / non-integer settled amount', () => {
    expect(createOperationSettlementSchema.safeParse(validInput({ actualAmountMicros: 1.5 })).success).toBe(false);
    expect(createOperationSettlementSchema.safeParse(validInput({ actualAmountMicros: -1 })).success).toBe(false);
  });

  it('rejects free text / prose in the opaque id fields (privacy boundary)', () => {
    expect(createOperationSettlementSchema.safeParse(validInput({ evidenceRef: 'ignore previous' })).success).toBe(
      false
    );
    expect(createOperationSettlementSchema.safeParse(validInput({ owner: 'a b' })).success).toBe(false);
  });

  it('requires a base settlement to be revision 0 and a correction to be revision >= 1', () => {
    // A base (no supersession) MUST be revision 0.
    expect(createOperationSettlementSchema.safeParse(validInput({ revision: 1 })).success).toBe(false);
    expect(createOperationSettlementSchema.safeParse(validInput({ revision: 0 })).success).toBe(true);
    // A correction (supersession) MUST be revision >= 1.
    const parent = deriveOperationSettlementId(validInput());
    expect(
      createOperationSettlementSchema.safeParse(validInput({ supersedesSettlementId: parent, revision: 0 })).success
    ).toBe(false);
    expect(
      createOperationSettlementSchema.safeParse(
        validInput({ supersedesSettlementId: parent, revision: 1, evidenceRef: 'invoice-43' })
      ).success
    ).toBe(true);
  });

  it('canonicalizes equivalent ISO representations to one identity (defect C)', () => {
    const canonical = deriveOperationSettlementId(validInput({ occurredAt: '2026-07-31T00:00:00.000Z' }));
    // No milliseconds, and a +00:00 offset instead of Z, are the SAME instant → same id.
    expect(deriveOperationSettlementId(validInput({ occurredAt: '2026-07-31T00:00:00Z' }))).toBe(canonical);
    expect(deriveOperationSettlementId(validInput({ occurredAt: '2026-07-31T02:00:00.000+02:00' }))).toBe(canonical);
    expect(canonicalizeIso('2026-07-31T00:00:00Z')).toBe('2026-07-31T00:00:00.000Z');
  });

  it('derives a deterministic id scoped by owner + receipt + occurrence + evidence + revision', () => {
    const a = deriveOperationSettlementId(validInput());
    expect(a).toBe(deriveOperationSettlementId(validInput()));
    // A later correction (different occurredAt) and a different invoice both differ.
    expect(deriveOperationSettlementId(validInput({ occurredAt: '2026-08-15T00:00:00.000Z' }))).not.toBe(a);
    expect(deriveOperationSettlementId(validInput({ evidenceRef: 'invoice-99' }))).not.toBe(a);
    // A revision is part of identity: the SAME evidence at the SAME instant, corrected,
    // gets a DISTINCT id (so it never collides with the record it supersedes).
    expect(deriveOperationSettlementId(validInput({ revision: 1 }))).not.toBe(a);
    // A different owner never collides.
    expect(deriveOperationSettlementId(validInput({ owner: 'workspace-xyz' }))).not.toBe(a);
    expect(a.startsWith('opsettl~')).toBe(true);
    expect(a).not.toContain('/');
  });

  it('verifies a canonical stored document and fails closed on id / identity mismatch', () => {
    const s = stored();
    expect(parseOperationSettlementDoc(s.id, s)).toEqual(s);
    expect(() => parseOperationSettlementDoc('other-id', s)).toThrow(OperationSettlementError);
    const tampered = { ...s, evidenceRef: 'invoice-tampered' };
    expect(() => parseOperationSettlementDoc(s.id, tampered)).toThrow(OperationSettlementError);
  });

  it('keeps recordedAt distinct from the immutable occurredAt', () => {
    const s = stored();
    expect(s.occurredAt).toBe('2026-07-31T00:00:00.000Z');
    expect(s.recordedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('resolveSettlementChain — one proven head, or fail closed', () => {
  const base = stored({ revision: 0 });
  const rev1 = stored({
    revision: 1,
    supersedesSettlementId: base.id,
    evidenceRef: 'invoice-43',
    actualAmountMicros: 2000,
  });
  const rev2 = stored({
    revision: 2,
    supersedesSettlementId: rev1.id,
    evidenceRef: 'invoice-44',
    actualAmountMicros: 2500,
  });

  it('reports `none` for an empty set', () => {
    expect(resolveSettlementChain([])).toEqual({ status: 'none' });
  });

  it('resolves a single base settlement to its head', () => {
    const res = resolveSettlementChain([base]);
    expect(res.status).toBe('settled');
    if (res.status === 'settled') {
      expect(res.head.id).toBe(base.id);
      expect(res.chainLength).toBe(0);
    }
  });

  it('follows a strict chain to the latest head (never by timestamp/id ordering)', () => {
    const res = resolveSettlementChain([rev2, base, rev1]); // deliberately unordered
    expect(res.status).toBe('settled');
    if (res.status === 'settled') {
      expect(res.head.id).toBe(rev2.id);
      expect(res.head.actualAmountMicros).toBe(2500);
      expect(res.chainLength).toBe(2);
    }
  });

  it('fails closed on competing heads (a fork — two settlements supersede the same base)', () => {
    const forkA = stored({ revision: 1, supersedesSettlementId: base.id, evidenceRef: 'invoice-A' });
    const forkB = stored({ revision: 1, supersedesSettlementId: base.id, evidenceRef: 'invoice-B' });
    expect(resolveSettlementChain([base, forkA, forkB]).status).toBe('conflicted');
  });

  it('fails closed on a dangling / out-of-scope supersession reference', () => {
    const orphan = stored({ revision: 1, supersedesSettlementId: 'opsettl~v1~does-not-exist', evidenceRef: 'inv-x' });
    expect(resolveSettlementChain([orphan]).status).toBe('conflicted');
  });

  it('fails closed on a non-monotonic revision', () => {
    const skewed = stored({
      revision: 5,
      supersedesSettlementId: base.id,
      evidenceRef: 'invoice-skew',
      actualAmountMicros: 3000,
    });
    expect(resolveSettlementChain([base, skewed]).status).toBe('conflicted');
  });

  it('fails closed on multiple bases (two revision-0 roots) — ambiguous', () => {
    const otherBase = stored({ revision: 0, evidenceRef: 'invoice-other' });
    expect(resolveSettlementChain([base, otherBase]).status).toBe('conflicted');
  });

  it('fails closed on a disconnected branch (head does not cover every settlement)', () => {
    // rev2 supersedes rev1, but rev1 is absent from the set → not a single chain.
    expect(resolveSettlementChain([base, rev2]).status).toBe('conflicted');
  });
});
