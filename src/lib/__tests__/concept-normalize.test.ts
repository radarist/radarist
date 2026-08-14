/**
 * Unit Tests for Concept Normalization Utility
 *
 * Tests concept/tag normalization functions:
 * - normalizeConcept: Main normalization function
 * - slugify: URL-safe slug generation
 * - titleCase: Title case conversion
 * - getCanonicalName: Canonical name lookup
 * - normalizeConceptFull: Full normalization with name
 * - areConceptsEqual: Concept equality check
 * - normalizeConceptArray: Array normalization with deduplication
 *
 * @jest-environment node
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 */

import { describe, it, expect } from '@jest/globals';
import {
  normalizeConcept,
  slugify,
  titleCase,
  getCanonicalName,
  normalizeConceptFull,
  areConceptsEqual,
  normalizeConceptArray,
  CONCEPT_MAPPINGS,
  CANONICAL_NAMES,
} from '../utils/concept-normalize';

describe('slugify', () => {
  describe('basic conversion', () => {
    it('should convert to lowercase', () => {
      expect(slugify('Hello World')).toBe('hello-world');
      expect(slugify('UPPERCASE')).toBe('uppercase');
    });

    it('should replace spaces with hyphens', () => {
      expect(slugify('hello world')).toBe('hello-world');
      expect(slugify('multiple  spaces')).toBe('multiple-spaces');
    });

    it('should trim whitespace', () => {
      expect(slugify('  hello world  ')).toBe('hello-world');
      expect(slugify('\thello\n')).toBe('hello');
    });
  });

  describe('special characters', () => {
    it('should replace & with and', () => {
      expect(slugify('AI & ML')).toBe('ai-and-ml');
      expect(slugify('R&D')).toBe('randd'); // No space around &, so no hyphen
      expect(slugify('R & D')).toBe('r-and-d');
    });

    it('should remove periods and dots', () => {
      expect(slugify('A.I.')).toBe('ai');
      expect(slugify('Node.js')).toBe('nodejs');
    });

    it('should remove special characters', () => {
      expect(slugify('hello!@#$%world')).toBe('helloworld');
      expect(slugify('test (1)')).toBe('test-1');
    });

    it('should replace underscores with hyphens', () => {
      expect(slugify('hello_world')).toBe('hello-world');
      expect(slugify('snake_case_text')).toBe('snake-case-text');
    });
  });

  describe('hyphen handling', () => {
    it('should not create consecutive hyphens', () => {
      expect(slugify('hello   world')).toBe('hello-world');
      expect(slugify('hello - world')).toBe('hello-world');
    });

    it('should remove leading and trailing hyphens', () => {
      expect(slugify('---hello---')).toBe('hello');
      expect(slugify(' - hello - ')).toBe('hello');
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings', () => {
      expect(slugify('')).toBe('');
      expect(slugify('   ')).toBe('');
    });

    it('should handle single words', () => {
      expect(slugify('hello')).toBe('hello');
      expect(slugify('HELLO')).toBe('hello');
    });
  });
});

describe('titleCase', () => {
  it('should capitalize first letter of each word', () => {
    expect(titleCase('hello world')).toBe('Hello World');
    expect(titleCase('machine learning')).toBe('Machine Learning');
  });

  it('should convert hyphens to spaces and capitalize', () => {
    expect(titleCase('hello-world')).toBe('Hello World');
    expect(titleCase('artificial-intelligence')).toBe('Artificial Intelligence');
  });

  it('should handle single words', () => {
    expect(titleCase('hello')).toBe('Hello');
    expect(titleCase('ai')).toBe('Ai');
  });

  it('should handle already capitalized text', () => {
    expect(titleCase('HELLO')).toBe('HELLO');
    expect(titleCase('Hello World')).toBe('Hello World');
  });
});

describe('normalizeConcept', () => {
  describe('known mappings', () => {
    it('should normalize AI variations to artificial-intelligence', () => {
      expect(normalizeConcept('AI')).toBe('artificial-intelligence');
      expect(normalizeConcept('ai')).toBe('artificial-intelligence');
      expect(normalizeConcept('A.I.')).toBe('artificial-intelligence');
      expect(normalizeConcept('a.i.')).toBe('artificial-intelligence');
      expect(normalizeConcept('Artificial Intelligence')).toBe('artificial-intelligence');
    });

    it('should normalize ML variations to machine-learning', () => {
      expect(normalizeConcept('ML')).toBe('machine-learning');
      expect(normalizeConcept('ml')).toBe('machine-learning');
      expect(normalizeConcept('Machine Learning')).toBe('machine-learning');
    });

    it('should normalize IoT variations to internet-of-things', () => {
      expect(normalizeConcept('IoT')).toBe('internet-of-things');
      expect(normalizeConcept('iot')).toBe('internet-of-things');
      expect(normalizeConcept('Internet of Things')).toBe('internet-of-things');
    });

    it('should normalize NLP variations to natural-language-processing', () => {
      expect(normalizeConcept('NLP')).toBe('natural-language-processing');
      expect(normalizeConcept('nlp')).toBe('natural-language-processing');
      expect(normalizeConcept('Natural Language Processing')).toBe('natural-language-processing');
    });

    it('should normalize Gen AI variations to generative-ai', () => {
      expect(normalizeConcept('GenAI')).toBe('generative-ai');
      expect(normalizeConcept('Gen AI')).toBe('generative-ai');
      expect(normalizeConcept('Generative AI')).toBe('generative-ai');
    });

    it('should normalize LLM variations to large-language-models', () => {
      expect(normalizeConcept('LLM')).toBe('large-language-models');
      expect(normalizeConcept('LLMs')).toBe('large-language-models');
    });

    it('should normalize VR/AR/XR variations', () => {
      expect(normalizeConcept('VR')).toBe('virtual-reality');
      expect(normalizeConcept('AR')).toBe('augmented-reality');
      expect(normalizeConcept('XR')).toBe('extended-reality');
    });

    it('should normalize tech industry terms', () => {
      expect(normalizeConcept('SaaS')).toBe('software-as-a-service');
      expect(normalizeConcept('DevOps')).toBe('development-operations');
      expect(normalizeConcept('FinTech')).toBe('financial-technology');
    });
  });

  describe('unknown concepts (fallback to slugify)', () => {
    it('should slugify unknown concepts', () => {
      expect(normalizeConcept('Custom Tag')).toBe('custom-tag');
      expect(normalizeConcept('My Special Concept')).toBe('my-special-concept');
    });

    it('should handle unknown concepts with special characters', () => {
      expect(normalizeConcept('Custom & Special')).toBe('custom-and-special');
      expect(normalizeConcept('Test (Beta)')).toBe('test-beta');
    });
  });

  describe('case insensitivity', () => {
    it('should handle different cases for known mappings', () => {
      expect(normalizeConcept('AI')).toBe(normalizeConcept('ai'));
      expect(normalizeConcept('ML')).toBe(normalizeConcept('ml'));
      expect(normalizeConcept('IOT')).toBe(normalizeConcept('iot'));
    });
  });

  describe('whitespace handling', () => {
    it('should trim whitespace', () => {
      expect(normalizeConcept('  AI  ')).toBe('artificial-intelligence');
      expect(normalizeConcept('\tML\n')).toBe('machine-learning');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for empty input', () => {
      expect(normalizeConcept('')).toBe('');
      expect(normalizeConcept('   ')).toBe('');
    });

    it('should handle null/undefined gracefully', () => {
      expect(normalizeConcept(null as unknown as string)).toBe('');
      expect(normalizeConcept(undefined as unknown as string)).toBe('');
    });
  });
});

describe('getCanonicalName', () => {
  describe('known canonical names', () => {
    it('should return canonical names for known slugs', () => {
      expect(getCanonicalName('artificial-intelligence')).toBe('Artificial Intelligence');
      expect(getCanonicalName('machine-learning')).toBe('Machine Learning');
      expect(getCanonicalName('internet-of-things')).toBe('Internet of Things');
    });

    it('should return short names where appropriate', () => {
      expect(getCanonicalName('application-programming-interface')).toBe('API');
      expect(getCanonicalName('financial-technology')).toBe('FinTech');
      expect(getCanonicalName('development-operations')).toBe('DevOps');
    });
  });

  describe('unknown slugs (fallback to title case)', () => {
    it('should title case unknown slugs', () => {
      expect(getCanonicalName('custom-concept')).toBe('Custom Concept');
      expect(getCanonicalName('my-special-tag')).toBe('My Special Tag');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for empty input', () => {
      expect(getCanonicalName('')).toBe('');
    });

    it('should handle null/undefined gracefully', () => {
      expect(getCanonicalName(null as unknown as string)).toBe('');
      expect(getCanonicalName(undefined as unknown as string)).toBe('');
    });
  });
});

describe('normalizeConceptFull', () => {
  it('should return both slug and canonical name', () => {
    expect(normalizeConceptFull('AI')).toEqual({
      slug: 'artificial-intelligence',
      canonicalName: 'Artificial Intelligence',
    });
  });

  it('should handle unknown concepts', () => {
    expect(normalizeConceptFull('Custom Tag')).toEqual({
      slug: 'custom-tag',
      canonicalName: 'Custom Tag',
    });
  });

  it('should work with variations', () => {
    const result1 = normalizeConceptFull('ai');
    const result2 = normalizeConceptFull('A.I.');
    expect(result1).toEqual(result2);
  });
});

describe('areConceptsEqual', () => {
  it('should return true for equivalent concepts', () => {
    expect(areConceptsEqual('AI', 'ai')).toBe(true);
    expect(areConceptsEqual('AI', 'Artificial Intelligence')).toBe(true);
    expect(areConceptsEqual('ML', 'Machine Learning')).toBe(true);
  });

  it('should return false for different concepts', () => {
    expect(areConceptsEqual('AI', 'ML')).toBe(false);
    expect(areConceptsEqual('IoT', 'VR')).toBe(false);
  });

  it('should handle unknown concepts', () => {
    expect(areConceptsEqual('Custom Tag', 'custom-tag')).toBe(true);
    expect(areConceptsEqual('Custom Tag', 'CUSTOM TAG')).toBe(true);
  });
});

describe('normalizeConceptArray', () => {
  it('should normalize and deduplicate concepts', () => {
    const result = normalizeConceptArray(['AI', 'ai', 'Machine Learning', 'ML']);

    expect(result).toHaveLength(2);

    const aiConcept = result.find((c) => c.slug === 'artificial-intelligence');
    expect(aiConcept).toBeDefined();
    expect(aiConcept?.canonicalName).toBe('Artificial Intelligence');
    expect(aiConcept?.originalInputs).toContain('AI');
    expect(aiConcept?.originalInputs).toContain('ai');

    const mlConcept = result.find((c) => c.slug === 'machine-learning');
    expect(mlConcept).toBeDefined();
    expect(mlConcept?.canonicalName).toBe('Machine Learning');
  });

  it('should preserve original inputs for each concept', () => {
    const result = normalizeConceptArray(['AI', 'Artificial Intelligence', 'A.I.']);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('artificial-intelligence');
    expect(result[0].originalInputs).toHaveLength(3);
  });

  it('should handle empty arrays', () => {
    expect(normalizeConceptArray([])).toEqual([]);
  });

  it('should filter out empty strings', () => {
    const result = normalizeConceptArray(['AI', '', '  ', 'ML']);
    expect(result).toHaveLength(2);
  });

  it('should handle mixed known and unknown concepts', () => {
    const result = normalizeConceptArray(['AI', 'Custom Tag', 'ML']);

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.slug)).toContain('artificial-intelligence');
    expect(result.map((c) => c.slug)).toContain('machine-learning');
    expect(result.map((c) => c.slug)).toContain('custom-tag');
  });
});

describe('CONCEPT_MAPPINGS', () => {
  it('should have all mappings in lowercase keys', () => {
    for (const key of Object.keys(CONCEPT_MAPPINGS)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('should have valid slug values', () => {
    for (const value of Object.values(CONCEPT_MAPPINGS)) {
      // Slugs should be lowercase with hyphens
      expect(value).toMatch(/^[a-z0-9-]+$/);
      // No consecutive hyphens
      expect(value).not.toMatch(/--/);
    }
  });
});

describe('CANONICAL_NAMES', () => {
  it('should have entries for common concepts', () => {
    expect(CANONICAL_NAMES['artificial-intelligence']).toBeDefined();
    expect(CANONICAL_NAMES['machine-learning']).toBeDefined();
    expect(CANONICAL_NAMES['internet-of-things']).toBeDefined();
  });

  it('should have non-empty values', () => {
    for (const value of Object.values(CANONICAL_NAMES)) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
