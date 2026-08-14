import { dismissReasonSchema } from '../dismiss-reason';

describe('dismissReasonSchema', () => {
  it('accepts every valid reason', () => {
    for (const r of ['out-of-scope', 'low-quality', 'already-known', 'duplicate', 'correct']) {
      expect(dismissReasonSchema.parse(r)).toBe(r);
    }
  });

  it('rejects unknown reasons', () => {
    expect(dismissReasonSchema.safeParse('whatever').success).toBe(false);
    expect(dismissReasonSchema.safeParse('').success).toBe(false);
  });
});
