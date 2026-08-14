/**
 * Unit tests for the pure `normalizeAlias` text normalizer (DISC-012).
 *
 * Salvaged verbatim from the removed `entity-aliases.test.ts` when the dead
 * alias subsystem was deleted — these cases lock the one live export the
 * linker's candidate generator + document scanner depend on.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeAlias } from '../text-normalize';

describe('normalizeAlias()', () => {
  describe('Basic Normalization', () => {
    it('should convert to lowercase', () => {
      expect(normalizeAlias('TensorFlow')).toBe('tensorflow');
      expect(normalizeAlias('AWS')).toBe('aws');
      expect(normalizeAlias('KUBERNETES')).toBe('kubernetes');
    });

    it('should preserve spaces between words', () => {
      expect(normalizeAlias('Amazon Web Services')).toBe('amazon web services');
      expect(normalizeAlias('Machine Learning')).toBe('machine learning');
    });

    it('should collapse multiple spaces', () => {
      expect(normalizeAlias('Amazon  Web   Services')).toBe('amazon web services');
      expect(normalizeAlias('  TensorFlow  ')).toBe('tensorflow');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(normalizeAlias('  React  ')).toBe('react');
      expect(normalizeAlias('\t\nVue\n\t')).toBe('vue');
    });
  });

  describe('Punctuation Removal', () => {
    it('should remove dots', () => {
      expect(normalizeAlias('React.js')).toBe('reactjs');
      expect(normalizeAlias('Node.js')).toBe('nodejs');
      expect(normalizeAlias('Vue.js')).toBe('vuejs');
    });

    it('should remove hyphens', () => {
      expect(normalizeAlias('Next-js')).toBe('nextjs');
      expect(normalizeAlias('Type-Script')).toBe('typescript');
    });

    it('should remove other punctuation', () => {
      expect(normalizeAlias('C++')).toBe('c');
      expect(normalizeAlias('C#')).toBe('c');
      expect(normalizeAlias('A.I.')).toBe('ai');
    });

    it('should remove parentheses and brackets', () => {
      expect(normalizeAlias('React (Facebook)')).toBe('react facebook');
      expect(normalizeAlias('ML [Beta]')).toBe('ml beta');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      expect(normalizeAlias('')).toBe('');
    });

    it('should handle only whitespace', () => {
      expect(normalizeAlias('   ')).toBe('');
    });

    it('should handle only punctuation', () => {
      expect(normalizeAlias('...')).toBe('');
    });

    it('should handle numbers', () => {
      expect(normalizeAlias('Python3')).toBe('python3');
      expect(normalizeAlias('ES6')).toBe('es6');
      expect(normalizeAlias('2024')).toBe('2024');
    });

    it('should handle mixed case with numbers', () => {
      expect(normalizeAlias('GPT-4')).toBe('gpt4');
      expect(normalizeAlias('TypeScript 5.0')).toBe('typescript 50');
    });

    it('should return "" for null / undefined input', () => {
      expect(normalizeAlias(null as unknown as string)).toBe('');
      expect(normalizeAlias(undefined as unknown as string)).toBe('');
    });
  });

  describe('Real-World Examples', () => {
    it('should normalize AWS correctly', () => {
      expect(normalizeAlias('AWS')).toBe('aws');
      expect(normalizeAlias('A.W.S.')).toBe('aws');
    });

    it('should normalize company names', () => {
      expect(normalizeAlias('Amazon Web Services')).toBe('amazon web services');
      expect(normalizeAlias('Microsoft Corporation')).toBe('microsoft corporation');
      expect(normalizeAlias('Google LLC')).toBe('google llc');
    });

    it('should normalize technology names', () => {
      expect(normalizeAlias('React.js')).toBe('reactjs');
      expect(normalizeAlias('Vue.js')).toBe('vuejs');
      expect(normalizeAlias('Angular')).toBe('angular');
      expect(normalizeAlias('Next.js')).toBe('nextjs');
    });
  });
});
