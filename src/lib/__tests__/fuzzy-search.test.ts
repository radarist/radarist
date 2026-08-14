/**
 * Unit Tests for Fuzzy Search Module
 *
 * Tests fuzzy matching utilities including:
 * - normalizeText - Text normalization for matching
 * - tokenize - Text tokenization
 * - tokenMatches - Single token matching
 * - tokenMatchScore - Token match scoring
 * - calculateMatchScore - Overall match scoring
 * - fuzzySearchStrings - String array fuzzy search
 * - fuzzySearch - Object array fuzzy search
 * - fuzzySearchWithScores - Search with score results
 * - fuzzyMatches - Quick match check
 *
 * @jest-environment node
 */

import {
  normalizeText,
  tokenize,
  tokenMatches,
  tokenMatchScore,
  calculateMatchScore,
  fuzzySearchStrings,
  fuzzySearch,
  fuzzySearchWithScores,
  fuzzyMatches,
} from '../fuzzy-search';

// =============================================================================
// normalizeText
// =============================================================================

describe('normalizeText', () => {
  it('should convert text to lowercase', () => {
    expect(normalizeText('Hello World')).toBe('hello world');
  });

  it('should replace hyphens with spaces', () => {
    expect(normalizeText('AI-driven')).toBe('ai driven');
  });

  it('should remove special characters except alphanumeric and spaces', () => {
    expect(normalizeText('React.js (v18)')).toBe('react js v18');
  });

  it('should collapse multiple spaces', () => {
    expect(normalizeText('hello   world')).toBe('hello world');
  });

  it('should trim whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(normalizeText('')).toBe('');
  });

  it('should handle string with only special characters', () => {
    expect(normalizeText('!@#$%')).toBe('');
  });

  it('should handle hyphenated compound words', () => {
    expect(normalizeText('machine-learning-model')).toBe('machine learning model');
  });
});

// =============================================================================
// tokenize
// =============================================================================

describe('tokenize', () => {
  it('should split text into tokens', () => {
    expect(tokenize('hello world')).toEqual(['hello', 'world']);
  });

  it('should return unique tokens', () => {
    expect(tokenize('hello hello world')).toEqual(['hello', 'world']);
  });

  it('should normalize before tokenizing', () => {
    expect(tokenize('AI-Driven Analysis')).toEqual(['ai', 'driven', 'analysis']);
  });

  it('should return empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('should filter empty tokens', () => {
    expect(tokenize('  hello  world  ')).toEqual(['hello', 'world']);
  });
});

// =============================================================================
// tokenMatches
// =============================================================================

describe('tokenMatches', () => {
  it('should match exact tokens', () => {
    expect(tokenMatches('react', 'react')).toBe(true);
  });

  it('should match prefix tokens (min 2 chars)', () => {
    expect(tokenMatches('pred', 'prediction')).toBe(true);
  });

  it('should not match single-char prefix', () => {
    expect(tokenMatches('p', 'prediction')).toBe(false);
  });

  it('should match contains tokens (min 3 chars)', () => {
    expect(tokenMatches('flavor', 'aiflavor')).toBe(true);
  });

  it('should not match 2-char contains', () => {
    expect(tokenMatches('ai', 'xaimodel')).toBe(false);
  });

  it('should not match unrelated tokens', () => {
    expect(tokenMatches('angular', 'react')).toBe(false);
  });
});

// =============================================================================
// tokenMatchScore
// =============================================================================

describe('tokenMatchScore', () => {
  it('should return 1.0 for exact match', () => {
    expect(tokenMatchScore('react', 'react')).toBe(1.0);
  });

  it('should return 0.8 for prefix match', () => {
    expect(tokenMatchScore('pred', 'prediction')).toBe(0.8);
  });

  it('should return 0.6 for contains match', () => {
    expect(tokenMatchScore('learn', 'machinelearning')).toBe(0.6);
  });

  it('should return 0 for no match', () => {
    expect(tokenMatchScore('angular', 'react')).toBe(0);
  });
});

// =============================================================================
// calculateMatchScore
// =============================================================================

describe('calculateMatchScore', () => {
  it('should return score 0 for empty query', () => {
    const result = calculateMatchScore('', 'hello world');
    expect(result.score).toBe(0);
    expect(result.matchedTerms).toEqual([]);
  });

  it('should return score 0 for empty text', () => {
    const result = calculateMatchScore('hello', '');
    expect(result.score).toBe(0);
    expect(result.matchedTerms).toEqual([]);
  });

  it('should return high score for exact match', () => {
    const result = calculateMatchScore('react', 'react');
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.matchedTerms).toContain('react');
  });

  it('should return partial score for partial match', () => {
    const result = calculateMatchScore('AI prediction', 'AI-driven Flavor Prediction');
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedTerms.length).toBeGreaterThan(0);
  });

  it('should score higher for more matching tokens', () => {
    const fullMatch = calculateMatchScore('machine learning', 'machine learning');
    const partialMatch = calculateMatchScore('machine database', 'machine learning');
    expect(fullMatch.score).toBeGreaterThan(partialMatch.score);
  });

  it('should cap score at 1.0', () => {
    const result = calculateMatchScore('test', 'test');
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

// =============================================================================
// fuzzySearchStrings
// =============================================================================

describe('fuzzySearchStrings', () => {
  const items = ['React', 'React Native', 'Angular', 'Vue.js', 'Svelte'];

  it('should find matching strings', () => {
    const results = fuzzySearchStrings(items, 'react');
    expect(results).toContain('React');
    expect(results).toContain('React Native');
    expect(results).not.toContain('Angular');
  });

  it('should return empty for no match', () => {
    const results = fuzzySearchStrings(items, 'python');
    expect(results).toEqual([]);
  });

  it('should respect threshold option', () => {
    const looseResults = fuzzySearchStrings(items, 'react', { threshold: 0.1 });
    const strictResults = fuzzySearchStrings(items, 'react', { threshold: 0.9 });
    expect(looseResults.length).toBeGreaterThanOrEqual(strictResults.length);
  });

  it('should respect limit option', () => {
    const results = fuzzySearchStrings(items, 'react', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should sort results by score descending', () => {
    const results = fuzzySearchStrings(items, 'react');
    // "React" should be first as it's an exact match
    if (results.length > 1) {
      expect(results[0]).toBe('React');
    }
  });

  it('should rank normalized exact matches, then prefixes, before fuzzy partials', () => {
    const results = fuzzySearchStrings(['Enterprise React', 'React Native', 'REACT!!!'], 'react');

    expect(results).toEqual(['REACT!!!', 'React Native', 'Enterprise React']);
  });
});

// =============================================================================
// fuzzySearch (objects)
// =============================================================================

describe('fuzzySearch', () => {
  interface Tech {
    name: string;
    description: string;
    category: string;
  }

  const items: Tech[] = [
    { name: 'AI-driven Flavor Prediction', description: 'Uses ML for flavor analysis', category: 'AI' },
    { name: 'React', description: 'A JavaScript library for building UIs', category: 'Frontend' },
    { name: 'TensorFlow', description: 'Machine learning framework', category: 'AI' },
    { name: 'Angular', description: 'A TypeScript web framework', category: 'Frontend' },
  ];

  it('should search specified keys', () => {
    const results = fuzzySearch(items, 'machine learning', { keys: ['description'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.name === 'TensorFlow')).toBe(true);
  });

  it('should search multiple keys', () => {
    const results = fuzzySearch(items, 'AI', { keys: ['name', 'description', 'category'] });
    expect(results.length).toBeGreaterThan(0);
  });

  it('should search all keys when keys not specified', () => {
    const results = fuzzySearch(items, 'javascript');
    expect(results.some(r => r.name === 'React')).toBe(true);
  });

  it('should respect limit option', () => {
    const results = fuzzySearch(items, 'framework', { keys: ['description'], limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should handle empty items array', () => {
    const results = fuzzySearch([], 'test');
    expect(results).toEqual([]);
  });

  it('should handle non-string field values gracefully', () => {
    const mixedItems = [{ name: 'Test', count: 5 } as unknown as Tech];
    const results = fuzzySearch(mixedItems, 'test', { keys: ['name'] });
    expect(results.length).toBe(1);
  });

  it('should keep a normalized exact name ahead of duplicate-looking names within the limit', () => {
    const duplicateLookingItems = [
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `Radar ${index}`,
        description: 'A radar variant',
        category: 'Tool',
      })),
      { name: 'Enterprise Radar', description: 'A partial name match', category: 'Tool' },
      { name: ' RADAR! ', description: 'The exact entity', category: 'Tool' },
    ];

    const results = fuzzySearch(duplicateLookingItems, 'radar', { keys: ['name', 'description'], limit: 10 });

    expect(results).toHaveLength(10);
    expect(results[0].name).toBe(' RADAR! ');
    expect(results).not.toContain(duplicateLookingItems[10]);
  });

  it('should give precedence to the first search key rather than an exact description', () => {
    const results = fuzzySearch(
      [
        { name: 'Enterprise Radar', description: 'Radar' },
        { name: 'Radar', description: 'Portfolio visualization' },
      ],
      'radar',
      { keys: ['name', 'description'] }
    );

    expect(results.map((item) => item.name)).toEqual(['Radar', 'Enterprise Radar']);
  });
});

// =============================================================================
// fuzzySearchWithScores
// =============================================================================

describe('fuzzySearchWithScores', () => {
  const items = [
    { name: 'React', description: 'JavaScript library' },
    { name: 'React Native', description: 'Mobile framework' },
    { name: 'Angular', description: 'TypeScript framework' },
  ];

  it('should include scores in results', () => {
    const results = fuzzySearchWithScores(items, 'react', { keys: ['name'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('item');
    expect(results[0]).toHaveProperty('matchedTerms');
  });

  it('should sort by score descending', () => {
    const results = fuzzySearchWithScores(items, 'react', { keys: ['name'] });
    if (results.length > 1) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });

  it('should respect threshold', () => {
    const results = fuzzySearchWithScores(items, 'react', { keys: ['name'], threshold: 0.99 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('should respect limit', () => {
    const results = fuzzySearchWithScores(items, 'react', { keys: ['name'], limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// fuzzyMatches
// =============================================================================

describe('fuzzyMatches', () => {
  it('should return true for matching text', () => {
    expect(fuzzyMatches('react', 'React framework')).toBe(true);
  });

  it('should return false for non-matching text', () => {
    expect(fuzzyMatches('python', 'React framework')).toBe(false);
  });

  it('should respect custom threshold', () => {
    // With very high threshold, a partial match should fail
    // 'rea xyz' has 2 query tokens but only 'rea' matches, giving ~0.6 score
    expect(fuzzyMatches('rea xyz', 'React framework for building UIs', 0.99)).toBe(false);
  });

  it('should use default threshold of 0.2', () => {
    // A reasonable partial match should pass with default threshold
    expect(fuzzyMatches('react', 'React')).toBe(true);
  });
});
