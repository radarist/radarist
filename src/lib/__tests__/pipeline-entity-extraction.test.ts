/**
 * Unit Tests for Pipeline Entity Extraction Module
 *
 * Tests AI-powered entity extraction from signals:
 * - Single signal extraction
 * - Batch extraction
 * - Entity type filtering
 * - Confidence scoring
 * - Error handling
 *
 * @jest-environment node
 * @phase Phase 6: Daily Pipeline
 */

import type { Signal } from '../types';

// Mock the AI client
jest.mock('../ai/client', () => ({
  generateStructuredContent: jest.fn(),
}));

// Mock Firebase
jest.mock('../firebase', () => ({
  db: {},
}));

// Import mocked modules
import { generateStructuredContent } from '../ai/client';

const mockGenerateStructuredContent = generateStructuredContent as jest.Mock;

// Import functions after mocking
import {
  extractEntitiesFromSignal,
  extractEntitiesFromSignals,
  getUniqueEntities,
  filterEntitiesByType,
  getExtractionStats,
  type ExtractedEntity,
  type ExtractionResult,
} from '../pipeline/entity-extraction';

/**
 * Helper to create a mock signal for testing
 */
function createMockSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-123',
    slug: 'novel-ai-based-flavor-prediction-system',
    type: 'patent',
    title: 'Novel AI-based flavor prediction system',
    description:
      'Machine learning system for predicting flavor compounds using neural networks developed by TechCorp Inc.',
    source: 'USPTO Patent',
    url: 'https://patents.google.com/patent/US12345678',
    date: Date.now(),
    relevanceScore: 85,
    alignmentScore: 78,
    alignedStrategies: [],
    linkedEntities: {
      technologies: [],
      companies: [],
      useCases: [],
    },
    status: 'Detected',
    sentiment: 'positive',
    aiSummary: 'AI system for predicting flavor compounds',
    detectedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Helper to create mock extracted entities (with integer confidence 0-100)
 */
function createMockExtractedEntities(): ExtractedEntity[] {
  return [
    {
      name: 'TechCorp',
      type: 'company',
      confidence: 95,
      context: 'developed by TechCorp Inc.',
      aliases: ['TechCorp Inc.', 'TechCorp Inc'],
    },
    {
      name: 'Neural Networks',
      type: 'technology',
      confidence: 88,
      context: 'using neural networks',
    },
    {
      name: 'Machine Learning',
      type: 'technology',
      confidence: 92,
      context: 'Machine learning system',
    },
  ];
}

/**
 * Helper to create a mock ExtractionResult
 */
function createMockExtractionResult(overrides?: Partial<ExtractionResult>): ExtractionResult {
  return {
    signalId: 'signal-123',
    entities: createMockExtractedEntities(),
    extractedAt: Date.now(),
    sourceFields: ['title', 'summary'],
    processingTimeMs: 150,
    ...overrides,
  };
}

describe('Pipeline Entity Extraction Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractEntitiesFromSignal()', () => {
    it('should extract entities from a signal', async () => {
      const mockSignal = createMockSignal();
      const mockEntities = createMockExtractedEntities();

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: mockEntities,
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.signalId).toBe('signal-123');
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities[0].name).toBe('TechCorp');
      expect(result.entities[0].type).toBe('company');
      expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(1);
    });

    it('should handle signals with minimal content by using linkedEntities', async () => {
      const mockSignal = createMockSignal({
        title: undefined,
        description: undefined,
        aiSummary: undefined as unknown as string,
        expandedContent: undefined,
        linkedEntities: {
          technologies: ['React'],
          companies: ['Google'],
          useCases: [],
        },
      });

      // AI should not be called when there's no text content
      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.signalId).toBe('signal-123');
      expect(result.sourceFields).toContain('linkedEntities');
      // Should have entities from linkedEntities
      expect(result.entities.length).toBe(2);
    });

    it('should handle AI extraction errors gracefully by falling back to linkedEntities', async () => {
      const mockSignal = createMockSignal({
        linkedEntities: {
          technologies: ['AI'],
          companies: [],
          useCases: [],
        },
      });

      mockGenerateStructuredContent.mockRejectedValueOnce(new Error('AI service unavailable'));

      const result = await extractEntitiesFromSignal(mockSignal);

      // Should fall back to linkedEntities
      expect(result.entities.length).toBe(1);
      expect(result.entities[0].name).toBe('AI');
      expect(result.sourceFields).toContain('linkedEntities');
    });

    it('should include confidence scores for each entity', async () => {
      const mockSignal = createMockSignal();
      const mockEntities = createMockExtractedEntities();

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: mockEntities,
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.entities.every((e) => typeof e.confidence === 'number')).toBe(true);
      expect(result.entities[0].confidence).toBe(95);
    });

    it('should extract person entities', async () => {
      const mockSignal = createMockSignal({
        description: 'Research by Dr. Jane Smith at Stanford University',
      });

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [
          {
            name: 'Dr. Jane Smith',
            type: 'person',
            confidence: 91,
            context: 'Research by Dr. Jane Smith',
          },
        ],
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.entities[0].type).toBe('person');
      expect(result.entities[0].name).toBe('Dr. Jane Smith');
    });

    it('should include processingTimeMs in result', async () => {
      const mockSignal = createMockSignal();
      mockGenerateStructuredContent.mockResolvedValueOnce({ entities: [] });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(typeof result.processingTimeMs).toBe('number');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extractEntitiesFromSignals()', () => {
    it('should extract entities from multiple signals', async () => {
      const signals = [createMockSignal({ id: 'signal-1' }), createMockSignal({ id: 'signal-2' })];

      mockGenerateStructuredContent
        .mockResolvedValueOnce({
          entities: [{ name: 'TechCorp', type: 'company', confidence: 90 }],
        })
        .mockResolvedValueOnce({
          entities: [{ name: 'AI Labs', type: 'company', confidence: 85 }],
        });

      const result = await extractEntitiesFromSignals(signals);

      expect(result.results).toHaveLength(2);
      expect(result.totalEntities).toBe(2);
      expect(result.results[0].signalId).toBe('signal-1');
      expect(result.results[1].signalId).toBe('signal-2');
    });

    it('should handle partial failures gracefully and track errors', async () => {
      const signals = [createMockSignal({ id: 'signal-1' }), createMockSignal({ id: 'signal-2' })];

      mockGenerateStructuredContent
        .mockResolvedValueOnce({
          entities: [{ name: 'TechCorp', type: 'company', confidence: 90 }],
        })
        .mockRejectedValueOnce(new Error('AI error'));

      const result = await extractEntitiesFromSignals(signals);

      // Both signals should have results (second one falls back to linkedEntities)
      expect(result.results).toHaveLength(2);
      expect(result.results[0].entities).toHaveLength(1);
    });

    it('should return empty results for empty signal list', async () => {
      const result = await extractEntitiesFromSignals([]);

      expect(result.results).toEqual([]);
      expect(result.totalEntities).toBe(0);
      expect(result.totalSignals).toBe(0);
    });

    it('should respect batchSize option', async () => {
      const signals = Array.from({ length: 10 }, (_, i) => createMockSignal({ id: `signal-${i}` }));

      mockGenerateStructuredContent.mockResolvedValue({
        entities: [{ name: 'Entity', type: 'company', confidence: 90 }],
      });

      const result = await extractEntitiesFromSignals(signals, { batchSize: 3 });

      expect(result.results).toHaveLength(10);
      expect(result.totalEntities).toBe(10);
      expect(result.totalSignals).toBe(10);
    });

    it('should filter by minConfidence', async () => {
      const signals = [createMockSignal({ id: 'signal-1' })];

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [
          { name: 'HighConf', type: 'company', confidence: 80 },
          { name: 'LowConf', type: 'company', confidence: 40 },
        ],
      });

      const result = await extractEntitiesFromSignals(signals, { minConfidence: 50 });

      expect(result.results[0].entities).toHaveLength(1);
      expect(result.results[0].entities[0].name).toBe('HighConf');
    });

    it('should include averageProcessingTimeMs', async () => {
      const signals = [createMockSignal({ id: 'signal-1' })];

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [{ name: 'Entity', type: 'company', confidence: 90 }],
      });

      const result = await extractEntitiesFromSignals(signals);

      expect(typeof result.averageProcessingTimeMs).toBe('number');
    });
  });

  describe('getUniqueEntities()', () => {
    it('should deduplicate entities by name and type across results', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [{ name: 'TechCorp', type: 'company', confidence: 90 }],
        }),
        createMockExtractionResult({
          signalId: 'signal-2',
          entities: [{ name: 'TechCorp', type: 'company', confidence: 85 }],
        }),
        createMockExtractionResult({
          signalId: 'signal-3',
          entities: [{ name: 'AI Labs', type: 'company', confidence: 88 }],
        }),
      ];

      const unique = getUniqueEntities(results);

      expect(unique.size).toBe(2);

      const techCorp = unique.get('company:techcorp');
      expect(techCorp).toBeDefined();
      expect(techCorp?.confidence).toBe(90); // Keep highest confidence
      expect(techCorp?.signalIds).toHaveLength(2);
    });

    it('should treat same name with different types as different entities', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [
            { name: 'Apple', type: 'company', confidence: 90 },
            { name: 'Apple', type: 'product', confidence: 85 },
          ],
        }),
      ];

      const unique = getUniqueEntities(results);

      expect(unique.size).toBe(2);
      expect(unique.has('company:apple')).toBe(true);
      expect(unique.has('product:apple')).toBe(true);
    });

    it('should handle empty results', () => {
      const unique = getUniqueEntities([]);

      expect(unique.size).toBe(0);
    });

    it('should track signalIds for each unique entity', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [{ name: 'TechCorp', type: 'company', confidence: 90 }],
        }),
        createMockExtractionResult({
          signalId: 'signal-2',
          entities: [{ name: 'TechCorp', type: 'company', confidence: 85 }],
        }),
      ];

      const unique = getUniqueEntities(results);
      const techCorp = unique.get('company:techcorp');

      expect(techCorp?.signalIds).toContain('signal-1');
      expect(techCorp?.signalIds).toContain('signal-2');
    });

    it('should merge aliases from duplicate entities', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [{ name: 'TechCorp', type: 'company', confidence: 90, aliases: ['TC'] }],
        }),
        createMockExtractionResult({
          signalId: 'signal-2',
          entities: [
            { name: 'TechCorp', type: 'company', confidence: 85, aliases: ['TechCorp Inc'] },
          ],
        }),
      ];

      const unique = getUniqueEntities(results);
      const techCorp = unique.get('company:techcorp');

      expect(techCorp?.aliases).toContain('TC');
      expect(techCorp?.aliases).toContain('TechCorp Inc');
    });
  });

  describe('filterEntitiesByType()', () => {
    it('should filter entities by type', () => {
      const entities: ExtractedEntity[] = [
        { name: 'TechCorp', type: 'company', confidence: 90 },
        { name: 'Machine Learning', type: 'technology', confidence: 85 },
        { name: 'AI Labs', type: 'company', confidence: 88 },
      ];

      const companies = filterEntitiesByType(entities, 'company');
      const technologies = filterEntitiesByType(entities, 'technology');

      expect(companies).toHaveLength(2);
      expect(technologies).toHaveLength(1);
    });

    it('should return empty array for non-matching type', () => {
      const entities: ExtractedEntity[] = [{ name: 'TechCorp', type: 'company', confidence: 90 }];

      const persons = filterEntitiesByType(entities, 'person');

      expect(persons).toEqual([]);
    });

    it('should handle empty entities array', () => {
      const filtered = filterEntitiesByType([], 'company');

      expect(filtered).toEqual([]);
    });
  });

  describe('getExtractionStats()', () => {
    it('should calculate extraction statistics', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [
            { name: 'TechCorp', type: 'company', confidence: 90 },
            { name: 'ML', type: 'technology', confidence: 85 },
          ],
        }),
        createMockExtractionResult({
          signalId: 'signal-2',
          entities: [{ name: 'AI Labs', type: 'company', confidence: 88 }],
        }),
      ];

      const stats = getExtractionStats(results);

      expect(stats.totalSignals).toBe(2);
      expect(stats.totalEntities).toBe(3);
      expect(stats.byType.company).toBe(2);
      expect(stats.byType.technology).toBe(1);
      expect(stats.avgEntitiesPerSignal).toBe(2); // 3/2 rounded
    });

    it('should handle empty results', () => {
      const stats = getExtractionStats([]);

      expect(stats.totalSignals).toBe(0);
      expect(stats.totalEntities).toBe(0);
      expect(stats.avgEntitiesPerSignal).toBe(0);
      expect(stats.avgConfidence).toBe(0);
    });

    it('should calculate average confidence', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [
            { name: 'TechCorp', type: 'company', confidence: 90 },
            { name: 'ML', type: 'technology', confidence: 80 },
          ],
        }),
      ];

      const stats = getExtractionStats(results);

      expect(stats.avgConfidence).toBe(85); // (90 + 80) / 2 = 85
    });

    it('should count entities by type correctly', () => {
      const results: ExtractionResult[] = [
        createMockExtractionResult({
          signalId: 'signal-1',
          entities: [
            { name: 'TechCorp', type: 'company', confidence: 90 },
            { name: 'Google', type: 'company', confidence: 85 },
            { name: 'React', type: 'technology', confidence: 80 },
            { name: 'Dr. Smith', type: 'person', confidence: 75 },
          ],
        }),
      ];

      const stats = getExtractionStats(results);

      expect(stats.byType.company).toBe(2);
      expect(stats.byType.technology).toBe(1);
      expect(stats.byType.person).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long signal content', async () => {
      const longDescription = 'A'.repeat(10000);
      const mockSignal = createMockSignal({ description: longDescription });

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [{ name: 'Entity', type: 'company', confidence: 90 }],
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.entities).toHaveLength(1);
    });

    it('should handle special characters in entity names', async () => {
      const mockSignal = createMockSignal();

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [
          {
            name: "O'Reilly Media & Associates",
            type: 'company',
            confidence: 90,
          },
        ],
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.entities[0].name).toBe("O'Reilly Media & Associates");
    });

    it('should handle unicode entity names', async () => {
      const mockSignal = createMockSignal();

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [{ name: '日本電気株式会社', type: 'company', confidence: 88 }],
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.entities[0].name).toBe('日本電気株式会社');
    });

    it('should use expandedContent when available', async () => {
      const mockSignal = createMockSignal({
        expandedContent: {
          entityProfile: {
            type: 'technology',
            summary: 'Extended content about AI technologies',
            keyFacts: [],
            recentDevelopments: [],
          },
          relatedItems: { technologies: [], companies: [], signals: [] },
          expandedAt: Date.now(),
          expansionModel: 'gemini-2.5-flash',
          expansionDuration: 1500,
        },
      });

      mockGenerateStructuredContent.mockResolvedValueOnce({
        entities: [{ name: 'AI Tech', type: 'technology', confidence: 85 }],
      });

      const result = await extractEntitiesFromSignal(mockSignal);

      expect(result.sourceFields).toContain('expandedContent');
    });
  });
});
