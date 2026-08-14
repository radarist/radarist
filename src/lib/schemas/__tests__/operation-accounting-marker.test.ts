/**
 * @file lib/schemas/__tests__/operation-accounting-marker.test.ts
 * @description ARUN-022 — durable parent accounting marker: schema, derived
 * state, count-partition integrity, deterministic identity, doc verification.
 *
 * @jest-environment node
 */

import {
  createParentAccountingMarkerSchema,
  parentAccountingMarkerSchema,
  deriveAccountingState,
  deriveParentAccountingMarkerId,
  parseParentAccountingMarkerDoc,
  resolveParentAccountingState,
  isValidMarkerOccurredAt,
  ParentAccountingMarkerError,
  type CreateParentAccountingMarkerInput,
  type ParentAccountingMarker,
} from '../operation-accounting-marker';

function validInput(overrides: Partial<CreateParentAccountingMarkerInput> = {}): CreateParentAccountingMarkerInput {
  return {
    owner: 'workspace-abc',
    parentType: 'verification',
    correlationId: 'inngest-run-1',
    batchId: 'vr-1',
    expected: 3,
    written: 2,
    replayed: 1,
    conflicted: 0,
    failed: 0,
    occurredAt: '2026-07-22T09:00:00.000Z',
    ...overrides,
  };
}

function stored(
  overrides: Partial<CreateParentAccountingMarkerInput> = {},
  recordedAt = '2026-07-22T09:05:00.000Z'
): ParentAccountingMarker {
  const input = createParentAccountingMarkerSchema.parse(validInput(overrides));
  return parentAccountingMarkerSchema.parse({
    ...input,
    accountingState: deriveAccountingState(input),
    id: deriveParentAccountingMarkerId(input),
    recordedAt,
  });
}

describe('deriveAccountingState', () => {
  it('is complete only when nothing conflicted and nothing failed', () => {
    expect(deriveAccountingState({ expected: 2, written: 2, replayed: 0, conflicted: 0, failed: 0 })).toBe('complete');
    expect(deriveAccountingState({ expected: 2, written: 1, replayed: 0, conflicted: 1, failed: 0 })).toBe(
      'incomplete'
    );
    expect(deriveAccountingState({ expected: 2, written: 1, replayed: 0, conflicted: 0, failed: 1 })).toBe(
      'incomplete'
    );
  });
});

describe('operation-accounting-marker schema', () => {
  it('accepts a valid create input and enforces the count partition', () => {
    expect(createParentAccountingMarkerSchema.safeParse(validInput()).success).toBe(true);
    // written + replayed + conflicted + failed must equal expected.
    expect(createParentAccountingMarkerSchema.safeParse(validInput({ expected: 5 })).success).toBe(false);
    expect(createParentAccountingMarkerSchema.safeParse(validInput({ written: 3 })).success).toBe(false);
  });

  it('rejects a caller-supplied accountingState on the create input (it is derived)', () => {
    expect(createParentAccountingMarkerSchema.safeParse({ ...validInput(), accountingState: 'complete' }).success).toBe(
      false
    );
  });

  it('rejects prose / fractional / negative fields (privacy + integrity boundary)', () => {
    expect(createParentAccountingMarkerSchema.safeParse(validInput({ owner: 'a b' })).success).toBe(false);
    expect(createParentAccountingMarkerSchema.safeParse(validInput({ written: 1.5, replayed: 0.5 })).success).toBe(
      false
    );
    expect(createParentAccountingMarkerSchema.safeParse(validInput({ conflicted: -1, written: 3 })).success).toBe(
      false
    );
  });

  it('the stored schema requires accountingState to be DERIVED from the counts', () => {
    const input = createParentAccountingMarkerSchema.parse(validInput({ conflicted: 1, written: 1, replayed: 1 }));
    const id = deriveParentAccountingMarkerId(input);
    // Counts imply incomplete, but the doc claims complete → rejected.
    expect(
      parentAccountingMarkerSchema.safeParse({
        ...input,
        accountingState: 'complete',
        id,
        recordedAt: '2026-07-22T09:05:00.000Z',
      }).success
    ).toBe(false);
  });
});

describe('deriveParentAccountingMarkerId', () => {
  it('is deterministic, owner-scoped, per-batch, and Firestore-safe', () => {
    const a = deriveParentAccountingMarkerId(validInput());
    expect(a).toBe(deriveParentAccountingMarkerId(validInput()));
    expect(deriveParentAccountingMarkerId(validInput({ owner: 'workspace-xyz' }))).not.toBe(a);
    expect(deriveParentAccountingMarkerId(validInput({ correlationId: 'other' }))).not.toBe(a);
    // A DIFFERENT batch under the SAME parent gets a DISTINCT slot (so it can never
    // overwrite an earlier batch's loss).
    expect(deriveParentAccountingMarkerId(validInput({ batchId: 'vr-2' }))).not.toBe(a);
    expect(a.startsWith('opacct~')).toBe(true);
    expect(a).not.toContain('/');
  });
});

describe('parseParentAccountingMarkerDoc', () => {
  it('verifies a canonical stored document and fails closed on id / identity mismatch', () => {
    const m = stored();
    expect(parseParentAccountingMarkerDoc(m.id, m)).toEqual(m);
    expect(() => parseParentAccountingMarkerDoc('other-id', m)).toThrow(ParentAccountingMarkerError);
    const tampered = { ...m, correlationId: 'tampered' };
    expect(() => parseParentAccountingMarkerDoc(m.id, tampered)).toThrow(ParentAccountingMarkerError);
  });

  it('round-trips an incomplete marker (a receipt loss is durably visible)', () => {
    const m = stored({ expected: 2, written: 1, replayed: 0, conflicted: 1, failed: 0 });
    expect(m.accountingState).toBe('incomplete');
    expect(parseParentAccountingMarkerDoc(m.id, m).accountingState).toBe('incomplete');
  });
});

describe('occurredAt is optional (a malformed timestamp must not block the loss record)', () => {
  it('isValidMarkerOccurredAt accepts a strict ISO Z time and rejects malformed / offset forms', () => {
    expect(isValidMarkerOccurredAt('2026-07-22T09:00:00.000Z')).toBe(true);
    expect(isValidMarkerOccurredAt('not-a-date')).toBe(false);
    expect(isValidMarkerOccurredAt('2026-07-22')).toBe(false);
    expect(isValidMarkerOccurredAt('2026-07-22T09:00:00+02:00')).toBe(false);
    expect(isValidMarkerOccurredAt(undefined)).toBe(false);
  });

  it('records a loss with occurredAt ABSENT', () => {
    const input = createParentAccountingMarkerSchema.parse({
      owner: 'workspace-abc',
      parentType: 'verification',
      correlationId: 'inngest-run-1',
      batchId: 'vr-x',
      expected: 1,
      written: 0,
      replayed: 0,
      conflicted: 0,
      failed: 1,
    });
    expect(input.occurredAt).toBeUndefined();
    const m = parentAccountingMarkerSchema.parse({
      ...input,
      accountingState: deriveAccountingState(input),
      id: deriveParentAccountingMarkerId(input),
      recordedAt: '2026-07-22T09:05:00.000Z',
    });
    expect(m.accountingState).toBe('incomplete');
    expect(m.occurredAt).toBeUndefined();
  });
});

describe('resolveParentAccountingState — whole-of-parent terminal truth', () => {
  it('returns null for a parent with no batches', () => {
    expect(resolveParentAccountingState([])).toBeNull();
  });

  it('is complete only when EVERY batch is complete; sums counts across batches', () => {
    const complete = stored({ batchId: 'b1', expected: 2, written: 2, replayed: 0, conflicted: 0, failed: 0 });
    const alsoComplete = stored({ batchId: 'b2', expected: 1, written: 1, replayed: 0, conflicted: 0, failed: 0 });
    const rolled = resolveParentAccountingState([complete, alsoComplete]);
    expect(rolled).toEqual({
      accountingState: 'complete',
      batchCount: 2,
      expected: 3,
      written: 3,
      replayed: 0,
      conflicted: 0,
      failed: 0,
    });
  });

  it('loss→success ordering: an earlier batch loss is NOT erased by a later complete batch', () => {
    const lostBatch = stored({ batchId: 'b1', expected: 2, written: 1, replayed: 0, conflicted: 1, failed: 0 });
    const okBatch = stored({ batchId: 'b2', expected: 1, written: 1, replayed: 0, conflicted: 0, failed: 0 });
    // Regardless of ordering, the parent stays incomplete while the loss is unresolved.
    const forward = resolveParentAccountingState([lostBatch, okBatch]);
    const reverse = resolveParentAccountingState([okBatch, lostBatch]);
    expect(forward?.accountingState).toBe('incomplete');
    expect(reverse?.accountingState).toBe('incomplete');
    expect(forward?.conflicted).toBe(1);
    expect(forward).toEqual(reverse);
  });
});
