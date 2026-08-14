import { sanitizeForFirestore } from '@/lib/firestore-sanitize';

describe('sanitizeForFirestore', () => {
  it('removes nested undefined fields and preserves array positions', () => {
    const input = {
      sourceSnapshot: {
        id: 'tech-source',
        description: undefined,
      },
      evidenceRefs: [{ id: 'evidence-1', url: undefined }, undefined],
    };

    expect(sanitizeForFirestore(input)).toEqual({
      sourceSnapshot: { id: 'tech-source' },
      evidenceRefs: [{ id: 'evidence-1' }, null],
    });
  });

  it('leaves non-plain objects intact', () => {
    const date = new Date(0);
    expect(sanitizeForFirestore({ date }).date).toBe(date);
  });

  it('preserves false, zero, and empty strings in mixed skill-prelude entries while dropping undefined target', () => {
    const failedEntry = {
      skill: 'cynefin-classification',
      target: undefined,
      block: '',
      costUsd: 0,
      durationMs: 0,
      firedAt: '2026-07-18T00:00:01.000Z',
      success: false,
      error: 'sub-mission timed out',
    };

    const result = sanitizeForFirestore({ skillPrelude: [failedEntry] });

    expect(Object.prototype.hasOwnProperty.call(result.skillPrelude[0], 'target')).toBe(false);
    expect(result.skillPrelude[0]).toStrictEqual({
      skill: 'cynefin-classification',
      block: '',
      costUsd: 0,
      durationMs: 0,
      firedAt: '2026-07-18T00:00:01.000Z',
      success: false,
      error: 'sub-mission timed out',
    });
  });

  it('returns class instances (Timestamp-like) by reference without recursing into them', () => {
    class FakeTimestamp {
      seconds = 1;
      nanoseconds: number | undefined = undefined;
    }
    const ts = new FakeTimestamp();
    expect(sanitizeForFirestore({ updatedAt: ts }).updatedAt).toBe(ts);
  });

  it('returns sentinel objects with a custom prototype (FieldValue-like) by reference', () => {
    const sentinel = Object.create({ isEqual: () => true }) as { isEqual: () => boolean };
    expect(sanitizeForFirestore({ counter: sentinel }).counter).toBe(sentinel);
  });

  it('treats null-prototype objects as plain records', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.keep = 1;
    bare.drop = undefined;
    expect(sanitizeForFirestore({ bare })).toEqual({ bare: { keep: 1 } });
  });

  it('never mutates its input', () => {
    const input = { skillPrelude: [{ skill: 's', target: undefined }] };
    Object.freeze(input);
    Object.freeze(input.skillPrelude);
    Object.freeze(input.skillPrelude[0]);

    const result = sanitizeForFirestore(input);

    expect(Object.prototype.hasOwnProperty.call(input.skillPrelude[0], 'target')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.skillPrelude[0], 'target')).toBe(false);
  });

  it('passes primitives, null, and undefined through unchanged', () => {
    expect(sanitizeForFirestore(0)).toBe(0);
    expect(sanitizeForFirestore('')).toBe('');
    expect(sanitizeForFirestore(false)).toBe(false);
    expect(sanitizeForFirestore(null)).toBeNull();
    expect(sanitizeForFirestore(undefined)).toBeUndefined();
  });
});
