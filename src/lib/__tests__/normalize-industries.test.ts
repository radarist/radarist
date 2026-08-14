/**
 * Unit Tests for normalizeIndustries
 *
 * The persisted `Company.industry` field carries mixed shapes in practice:
 * curated docs store `string[]`, legacy/AI-imported docs store a plain
 * string, and some docs miss the field entirely. The helper must return a
 * safe string array for every shape.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeIndustries } from '../normalize-industries';

describe('normalizeIndustries', () => {
  describe('array input (declared shape)', () => {
    it('returns the array unchanged for a clean string array', () => {
      expect(normalizeIndustries(['energy', 'utilities'])).toEqual(['energy', 'utilities']);
    });

    it('returns an empty array for an empty array', () => {
      expect(normalizeIndustries([])).toEqual([]);
    });

    it('drops non-string members', () => {
      expect(normalizeIndustries(['energy', 42, null, undefined, { foo: 'bar' }, 'utilities'])).toEqual([
        'energy',
        'utilities',
      ]);
    });

    it('trims members and drops blank ones', () => {
      expect(normalizeIndustries(['  energy  ', '', '   '])).toEqual(['energy']);
    });
  });

  describe('string input (legacy/AI-imported shape)', () => {
    it('wraps a plain string in a single-element array', () => {
      expect(normalizeIndustries('energy')).toEqual(['energy']);
    });

    it('trims the string', () => {
      expect(normalizeIndustries('  energy  ')).toEqual(['energy']);
    });

    it('returns an empty array for an empty string', () => {
      expect(normalizeIndustries('')).toEqual([]);
    });

    it('returns an empty array for a whitespace-only string', () => {
      expect(normalizeIndustries('   ')).toEqual([]);
    });
  });

  describe('weird values', () => {
    it('returns an empty array for null', () => {
      expect(normalizeIndustries(null)).toEqual([]);
    });

    it('returns an empty array for undefined', () => {
      expect(normalizeIndustries(undefined)).toEqual([]);
    });

    it('returns an empty array for a number', () => {
      expect(normalizeIndustries(7)).toEqual([]);
    });

    it('returns an empty array for a boolean', () => {
      expect(normalizeIndustries(true)).toEqual([]);
    });

    it('returns an empty array for a plain object', () => {
      expect(normalizeIndustries({ 0: 'energy' })).toEqual([]);
    });
  });

  describe('crash-regression guarantees', () => {
    it('result always supports array methods used by consumers', () => {
      // These are the exact call chains that crashed the Competitors tab
      // when industry was a plain string.
      const fromString = normalizeIndustries('energy');
      expect(fromString.slice(0, 2).join(', ')).toBe('energy');
      expect(fromString.some((i) => i.includes('ener'))).toBe(true);

      const fromNothing = normalizeIndustries(undefined);
      expect(fromNothing.slice(0, 2).join(', ')).toBe('');
      expect(fromNothing.some(() => true)).toBe(false);
    });
  });
});
