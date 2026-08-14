/**
 * @file coerce-to-enum.test.ts
 * @description AI-028 — the enum coercion used by the comprehensive company
 * research flow must normalize FORMATTING, never infer meaning from prose.
 *
 * The flow generates through the structured client, but its Zod `.preprocess`
 * coercer then scanned the model's string for any allowed value as a substring.
 * That is the same defect as the deleted regex parser, one layer down:
 * "not yet public" resolved to `public`, and "publicly available API,
 * bootstrapped" resolved to `public` rather than `bootstrapped`.
 */

import { coerceToEnum } from '../coerce-to-enum';

const STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'public', 'bootstrapped'] as const;
const SIZES = ['micro', 'small', 'medium', 'large', 'enterprise'] as const;

describe('coerceToEnum formatting normalization', () => {
  it('accepts an exact value', () => {
    expect(coerceToEnum(STAGES)('series_b')).toBe('series_b');
  });

  it('accepts case and whitespace variants', () => {
    expect(coerceToEnum(STAGES)('  Series_B  ')).toBe('series_b');
  });

  it('accepts human separators for an underscored value', () => {
    expect(coerceToEnum(STAGES)('Series B')).toBe('series_b');
    expect(coerceToEnum(STAGES)('series-b')).toBe('series_b');
    expect(coerceToEnum(STAGES)('Pre Seed')).toBe('pre_seed');
  });
});

describe('coerceToEnum refuses to infer from prose', () => {
  it('does not read a negated value as that value', () => {
    expect(coerceToEnum(STAGES)('not yet public')).toBeUndefined();
  });

  it('does not read an incidental word as a funding stage', () => {
    expect(coerceToEnum(STAGES)('publicly available API, bootstrapped')).toBeUndefined();
    expect(coerceToEnum(STAGES)('runs on public cloud infrastructure')).toBeUndefined();
  });

  it('does not read an incidental word as a company size', () => {
    expect(coerceToEnum(SIZES)('operates at large scale globally')).toBeUndefined();
    expect(coerceToEnum(SIZES)('serves enterprise customers')).toBeUndefined();
  });

  it('does not resolve a prefix match to the shorter value', () => {
    // 'seed' is a prefix of the prose below; the old startsWith pass took it.
    expect(coerceToEnum(STAGES)('seed-stage rumours, unconfirmed')).toBeUndefined();
  });

  it('returns undefined for a non-string', () => {
    expect(coerceToEnum(STAGES)(42)).toBeUndefined();
    expect(coerceToEnum(STAGES)(null)).toBeUndefined();
  });
});
