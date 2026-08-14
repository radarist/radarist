/**
 * @file tool-side-effects.test.ts
 * @description AI-047 — the no-mutation proof must be exact. A caller reads it
 * to SKIP the conservative "something may have changed" path, so anything short
 * of the literal shape has to stay unproven.
 */

import {
  isPolicyRefusalStage,
  noMutationProof,
  preWriteRefusal,
  provesNoMutation,
  readNoMutationProof,
} from '@/lib/ai/tool-side-effects';

describe('readNoMutationProof', () => {
  it('reads every declared stage', () => {
    for (const stage of ['validation', 'lookup', 'authorization', 'principal', 'unexpected'] as const) {
      expect(readNoMutationProof({ noMutation: { mutationAttempted: false, stage } })).toEqual({
        mutationAttempted: false,
        stage,
      });
    }
  });

  it('rejects anything that is not the literal proof', () => {
    expect(readNoMutationProof(undefined)).toBeUndefined();
    expect(readNoMutationProof(null)).toBeUndefined();
    expect(readNoMutationProof({})).toBeUndefined();
    expect(readNoMutationProof({ noMutation: true })).toBeUndefined();
    expect(readNoMutationProof({ noMutation: { stage: 'lookup' } })).toBeUndefined();
    // A TRUTHY mutationAttempted is the opposite claim and must never read as proof.
    expect(readNoMutationProof({ noMutation: { mutationAttempted: true, stage: 'lookup' } })).toBeUndefined();
    expect(readNoMutationProof({ noMutation: { mutationAttempted: 0, stage: 'lookup' } })).toBeUndefined();
    expect(readNoMutationProof({ noMutation: { mutationAttempted: false, stage: 'made-up' } })).toBeUndefined();
  });

  it('never infers proof from an error message or a nested data field', () => {
    expect(provesNoMutation({ success: false, error: 'Nothing was written' })).toBe(false);
    expect(
      provesNoMutation({ success: false, data: { noMutation: { mutationAttempted: false, stage: 'lookup' } } })
    ).toBe(false);
  });
});

describe('preWriteRefusal', () => {
  it('keeps the actionable cause verbatim and stamps the proof', () => {
    const result = preWriteRefusal('lookup', { error: 'Document not found: doc-9' });

    expect(result).toEqual({
      success: false,
      error: 'Document not found: doc-9',
      noMutation: { mutationAttempted: false, stage: 'lookup' },
    });
  });

  it('carries optional message and data without inventing either', () => {
    expect(preWriteRefusal('principal', { error: 'human only', message: 'Ask a person' })).toMatchObject({
      message: 'Ask a person',
    });
    expect(preWriteRefusal('validation', { error: 'bad' })).not.toHaveProperty('message');
    expect(preWriteRefusal('validation', { error: 'bad' })).not.toHaveProperty('data');
  });
});

describe('isPolicyRefusalStage', () => {
  it('separates declined-by-design from did-not-happen', () => {
    expect(isPolicyRefusalStage('authorization')).toBe(true);
    expect(isPolicyRefusalStage('principal')).toBe(true);
    expect(isPolicyRefusalStage('validation')).toBe(false);
    expect(isPolicyRefusalStage('lookup')).toBe(false);
    expect(isPolicyRefusalStage('unexpected')).toBe(false);
  });
});

describe('noMutationProof', () => {
  it('produces the exact literal the reader accepts', () => {
    expect(readNoMutationProof({ noMutation: noMutationProof('authorization') })).toEqual({
      mutationAttempted: false,
      stage: 'authorization',
    });
  });
});
