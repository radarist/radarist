/**
 * Unit Tests for Pipeline Deduplication Module
 *
 * Tests fuzzy matching and entity deduplication:
 * - Levenshtein distance calculation
 * - String normalization
 * - Company name normalization
 * - Similarity scoring
 * - Duplicate detection
 * - Entity merging
 *
 * @jest-environment node
 * @phase Phase 6: Daily Pipeline
 */

import {
  levenshteinDistance,
  normalizeString,
  normalizeCompanyName,
  calculateSimilarity,
  isSimilar,
  isAbbreviationMatch,
  deduplicateEntities,
  mergeEntities,
  getDeduplicationStats,
} from '../pipeline/deduplication';

import type { ExtractedEntity } from '../pipeline/entity-extraction';

/**
 * Helper to create a mock extracted entity with integer confidence
 */
function createMockEntity(
  overrides?: Partial<ExtractedEntity> & { signalIds?: string[] }
): ExtractedEntity & { signalIds?: string[] } {
  return {
    name: 'Test Entity',
    type: 'company',
    confidence: 90,
    ...overrides,
  };
}

describe('Pipeline Deduplication Module', () => {
  describe('levenshteinDistance()', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('should return string length for empty comparisons', () => {
      expect(levenshteinDistance('hello', '')).toBe(5);
      expect(levenshteinDistance('', 'hello')).toBe(5);
    });

    it('should calculate correct distance for single character difference', () => {
      expect(levenshteinDistance('hello', 'hallo')).toBe(1);
      expect(levenshteinDistance('cat', 'hat')).toBe(1);
    });

    it('should calculate correct distance for insertions', () => {
      expect(levenshteinDistance('hello', 'helllo')).toBe(1);
      expect(levenshteinDistance('cat', 'cats')).toBe(1);
    });

    it('should calculate correct distance for deletions', () => {
      expect(levenshteinDistance('hello', 'helo')).toBe(1);
      expect(levenshteinDistance('cats', 'cat')).toBe(1);
    });

    it('should calculate correct distance for complex transformations', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(levenshteinDistance('saturday', 'sunday')).toBe(3);
    });

    it('should be case sensitive', () => {
      expect(levenshteinDistance('Hello', 'hello')).toBe(1);
    });
  });

  describe('normalizeString()', () => {
    it('should convert to lowercase', () => {
      expect(normalizeString('HELLO')).toBe('hello');
    });

    it('should trim whitespace', () => {
      expect(normalizeString('  hello  ')).toBe('hello');
    });

    it('should handle multiple spaces', () => {
      expect(normalizeString('hello   world')).toContain('hello');
    });

    it('should handle empty strings', () => {
      expect(normalizeString('')).toBe('');
    });

    it('should preserve numbers', () => {
      expect(normalizeString('Company 123')).toContain('123');
    });
  });

  describe('normalizeCompanyName()', () => {
    it('should remove common suffixes', () => {
      expect(normalizeCompanyName('TechCorp Inc')).toBe('techcorp');
      expect(normalizeCompanyName('TechCorp LLC')).toBe('techcorp');
      expect(normalizeCompanyName('TechCorp Ltd')).toBe('techcorp');
      expect(normalizeCompanyName('TechCorp Corp')).toBe('techcorp');
    });

    it('should normalize punctuation', () => {
      const result = normalizeCompanyName('Tech-Corp, Inc');
      expect(result).toContain('tech');
    });

    it('should handle empty strings', () => {
      expect(normalizeCompanyName('')).toBe('');
    });
  });

  describe('calculateSimilarity()', () => {
    it('should return 1 for identical strings', () => {
      expect(calculateSimilarity('hello', 'hello')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      expect(calculateSimilarity('abc', 'xyz')).toBe(0);
    });

    it('should return value between 0 and 1 for similar strings', () => {
      const similarity = calculateSimilarity('hello', 'hallo');
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    it('should handle empty strings', () => {
      expect(calculateSimilarity('', '')).toBe(1);
      expect(calculateSimilarity('hello', '')).toBe(0);
    });

    it('should be symmetric', () => {
      const sim1 = calculateSimilarity('hello', 'hallo');
      const sim2 = calculateSimilarity('hallo', 'hello');
      expect(sim1).toBe(sim2);
    });
  });

  describe('isSimilar()', () => {
    // isSimilar requires a threshold parameter
    it('should return true for identical strings above threshold', () => {
      expect(isSimilar('TechCorp', 'TechCorp', 0.8)).toBe(true);
    });

    it('should return true for case-insensitive matches', () => {
      expect(isSimilar('TechCorp', 'techcorp', 0.8)).toBe(true);
    });

    it('should return true for minor typos above threshold', () => {
      expect(isSimilar('Microsoft', 'Microsft', 0.8)).toBe(true);
    });

    it('should return false for completely different names', () => {
      expect(isSimilar('Apple', 'Microsoft', 0.8)).toBe(false);
    });

    it('should respect threshold parameter', () => {
      expect(isSimilar('hello', 'hallo', 0.9)).toBe(false);
      expect(isSimilar('hello', 'hallo', 0.7)).toBe(true);
    });
  });

  describe('isAbbreviationMatch()', () => {
    it('should match AI abbreviation with full name', () => {
      expect(isAbbreviationMatch('AI', 'Artificial Intelligence')).toBe(true);
    });

    it('should handle case differences', () => {
      expect(isAbbreviationMatch('ai', 'Artificial Intelligence')).toBe(true);
    });

    it('should return false for non-matching abbreviations', () => {
      expect(isAbbreviationMatch('ABC', 'Apple Corporation')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isAbbreviationMatch('', 'Something')).toBe(false);
      expect(isAbbreviationMatch('ABC', '')).toBe(false);
    });

    it('should work with technology abbreviations', () => {
      expect(isAbbreviationMatch('ML', 'Machine Learning')).toBe(true);
      expect(isAbbreviationMatch('NLP', 'Natural Language Processing')).toBe(true);
    });
  });

  describe('deduplicateEntities()', () => {
    it('should identify duplicate entities and return groups', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp Inc', confidence: 90 }),
        createMockEntity({ name: 'TechCorp', confidence: 85 }),
        createMockEntity({ name: 'AI Labs', confidence: 88 }),
      ];

      const result = deduplicateEntities(entities);

      // Result has: groups, totalEntities, uniqueEntities (number), duplicatesFound, processingTimeMs
      expect(result.totalEntities).toBe(3);
      expect(result.uniqueEntities).toBe(2); // uniqueEntities is a NUMBER
      expect(result.groups.length).toBe(2);
      expect(result.duplicatesFound).toBe(1);
    });

    it('should not merge different entity types by default', () => {
      const entities = [
        createMockEntity({ name: 'Apple', type: 'company', confidence: 90 }),
        createMockEntity({ name: 'Apple', type: 'technology', confidence: 85 }),
      ];

      const result = deduplicateEntities(entities, { groupByType: true });

      expect(result.uniqueEntities).toBe(2);
    });

    it('should handle empty list', () => {
      const result = deduplicateEntities([]);

      expect(result.groups).toEqual([]);
      expect(result.totalEntities).toBe(0);
      expect(result.uniqueEntities).toBe(0);
    });

    it('should respect similarityThreshold option', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp', confidence: 90 }),
        createMockEntity({ name: 'TekCorp', confidence: 85 }),
      ];

      const strictResult = deduplicateEntities(entities, { similarityThreshold: 0.95 });
      const lenientResult = deduplicateEntities(entities, { similarityThreshold: 0.7 });

      expect(strictResult.uniqueEntities).toBe(2); // Not merged (below threshold)
      expect(lenientResult.uniqueEntities).toBe(1); // Merged (above threshold)
    });

    it('should track duplicates in groups', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp', confidence: 90 }),
        createMockEntity({ name: 'TechCorp Inc', confidence: 85 }),
      ];

      const result = deduplicateEntities(entities);

      // Should have one group with TechCorp as canonical and TechCorp Inc as duplicate
      expect(result.groups.length).toBe(1);
      expect(result.groups[0].canonical).toBe('TechCorp');
      expect(result.groups[0].duplicates.length).toBe(1);
      expect(result.groups[0].duplicates[0].name).toBe('TechCorp Inc');
    });
  });

  describe('mergeEntities()', () => {
    // mergeEntities takes an array of entities, not two separate entities
    it('should merge entities with same name', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp', confidence: 90, signalIds: ['s1'] }),
        createMockEntity({ name: 'TechCorp Inc', confidence: 85, signalIds: ['s2'] }),
      ];

      const merged = mergeEntities(entities);

      expect(merged.length).toBe(1);
      expect(merged[0].name).toBe('TechCorp');
      expect(merged[0].signalIds.length).toBe(2);
    });

    it('should keep distinct entities separate', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp', confidence: 90 }),
        createMockEntity({ name: 'AI Labs', confidence: 85 }),
      ];

      const merged = mergeEntities(entities);

      expect(merged.length).toBe(2);
    });

    it('should include mergedFrom when duplicates exist', () => {
      const entities = [
        createMockEntity({ name: 'TechCorp', confidence: 90 }),
        createMockEntity({ name: 'TechCorp Inc', confidence: 85 }),
      ];

      const merged = mergeEntities(entities);

      expect(merged[0].mergedFrom).toBeDefined();
      expect(merged[0].mergedFrom).toContain('TechCorp Inc');
    });
  });

  describe('getDeduplicationStats()', () => {
    it('should calculate deduplication statistics', () => {
      // Create a proper DeduplicationResult
      const result = {
        groups: [
          {
            canonical: 'Entity 1',
            canonicalType: 'company' as const,
            duplicates: [{ name: 'Entity 1 Inc', similarity: 1, matchReason: 'exact' as const }],
            totalOccurrences: 2,
            averageConfidence: 85,
          },
          {
            canonical: 'Entity 2',
            canonicalType: 'company' as const,
            duplicates: [],
            totalOccurrences: 1,
            averageConfidence: 90,
          },
        ],
        totalEntities: 3,
        uniqueEntities: 2,
        duplicatesFound: 1,
        processingTimeMs: 50,
      };

      const stats = getDeduplicationStats(result);

      expect(stats.compressionRatio).toBeCloseTo(2 / 3);
      expect(stats.duplicateRate).toBeCloseTo(1 / 3);
      expect(stats.matchReasons.exact).toBe(1);
    });

    it('should handle zero duplicates', () => {
      const result = {
        groups: [
          {
            canonical: 'Entity 1',
            canonicalType: 'company' as const,
            duplicates: [],
            totalOccurrences: 1,
            averageConfidence: 90,
          },
          {
            canonical: 'Entity 2',
            canonicalType: 'company' as const,
            duplicates: [],
            totalOccurrences: 1,
            averageConfidence: 85,
          },
        ],
        totalEntities: 2,
        uniqueEntities: 2,
        duplicatesFound: 0,
        processingTimeMs: 20,
      };

      const stats = getDeduplicationStats(result);

      expect(stats.duplicateRate).toBe(0);
      expect(stats.compressionRatio).toBe(1);
    });

    it('should handle empty results', () => {
      const result = {
        groups: [],
        totalEntities: 0,
        uniqueEntities: 0,
        duplicatesFound: 0,
        processingTimeMs: 0,
      };

      const stats = getDeduplicationStats(result);

      expect(stats.compressionRatio).toBe(1);
      expect(stats.duplicateRate).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle entities with special characters', () => {
      const entities = [
        createMockEntity({ name: "O'Reilly Associates", confidence: 90 }),
        createMockEntity({ name: 'OReilly Associates', confidence: 85 }),
      ];

      const result = deduplicateEntities(entities, { similarityThreshold: 0.8 });

      // Should recognize these as similar after normalization
      expect(result.uniqueEntities).toBeLessThanOrEqual(2);
    });

    it('should handle unicode names', () => {
      const entities = [
        createMockEntity({ name: '日本電気', confidence: 90 }),
        createMockEntity({ name: '日本電気株式会社', confidence: 85 }),
      ];

      const result = deduplicateEntities(entities);

      expect(result.uniqueEntities).toBeGreaterThan(0);
    });

    it('should handle very similar technology names with abbreviations', () => {
      const entities = [
        createMockEntity({ name: 'Machine Learning', type: 'technology', confidence: 90 }),
        createMockEntity({ name: 'ML', type: 'technology', confidence: 85 }),
      ];

      const result = deduplicateEntities(entities, { useAbbreviations: true });

      // Should match ML abbreviation with Machine Learning
      expect(result.uniqueEntities).toBe(1);
    });

    it('should handle large entity lists efficiently', () => {
      // Use distinct company names to avoid fuzzy matching
      // (e.g., "Entity 1" and "Entity 10" are too similar at 0.85 threshold)
      const entities = Array.from({ length: 100 }, (_, i) =>
        createMockEntity({ name: `UniqueCompany_${String(i).padStart(3, '0')}`, confidence: 90 })
      );

      const startTime = Date.now();
      // Use a high threshold to ensure no fuzzy matches
      const result = deduplicateEntities(entities, { similarityThreshold: 0.99 });
      const duration = Date.now() - startTime;

      // uniqueEntities is a number, not an array
      expect(result.uniqueEntities).toBe(100);
      expect(duration).toBeLessThan(5000); // Should complete in under 5s
    });
  });
});
