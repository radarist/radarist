/**
 * Unit Tests for Pipeline Relation Proposal Module
 *
 * Tests co-occurrence analysis and AI-based relation proposals:
 * - Co-occurrence detection
 * - Relation type inference
 * - Confidence scoring
 * - AI-based proposals
 * - Proposal filtering
 *
 * @jest-environment node
 * @phase Phase 6: Daily Pipeline
 */

import type { ExtractedEntity, ExtractionResult } from '../pipeline/entity-extraction';

// Mock the AI client
jest.mock('../ai/client', () => ({
  generateStructuredContent: jest.fn(),
}));

// Import mocked modules
import { generateStructuredContent } from '../ai/client';

const mockGenerateStructuredContent = generateStructuredContent as jest.Mock;

// Import functions after mocking
import {
  findCoOccurrences,
  proposeRelationsFromCoOccurrence,
  proposeRelationsWithAI,
  proposeRelations,
  groupProposalsByType,
  filterByConfidence,
  getProposalStats,
  type ProposedRelation,
  type CoOccurrence,
  type RelationProposalResult,
} from '../pipeline/relation-proposal';

/**
 * Helper to create mock extraction results
 */
function createMockExtractionResult(
  signalId: string,
  entities: ExtractedEntity[]
): ExtractionResult {
  return {
    signalId,
    entities,
    extractedAt: Date.now(),
    sourceFields: ['title', 'summary'],
    processingTimeMs: 100,
  };
}

/**
 * Helper to create a mock entity
 */
function createMockEntity(overrides?: Partial<ExtractedEntity>): ExtractedEntity {
  return {
    name: 'Test Entity',
    type: 'company',
    confidence: 90,
    ...overrides,
  };
}

/**
 * Helper to create a mock proposed relation
 */
function createMockProposal(overrides?: Partial<ProposedRelation>): ProposedRelation {
  return {
    sourceName: 'Source Entity',
    sourceType: 'company',
    targetName: 'Target Entity',
    targetType: 'technology',
    relationType: 'uses',
    confidence: 80,
    reasoning: 'Co-occurrence in signal',
    signalIds: ['signal-1'],
    proposedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Helper to create a mock RelationProposalResult
 */
function createMockProposalResult(
  proposals: ProposedRelation[],
  overrides?: Partial<RelationProposalResult>
): RelationProposalResult {
  return {
    proposals,
    totalCoOccurrences: 10,
    processingTimeMs: 500,
    method: 'cooccurrence',
    ...overrides,
  };
}

describe('Pipeline Relation Proposal Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findCoOccurrences()', () => {
    it('should find entities that appear together in signals', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-2', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences.length).toBeGreaterThan(0);
      expect(coOccurrences[0].count).toBe(2);
    });

    it('should not create self-references', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      // Single entity can't co-occur with itself
      expect(coOccurrences.length).toBe(0);
    });

    it('should track signal IDs for each co-occurrence', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-2', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI', type: 'technology' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences[0].signalIds).toContain('signal-1');
      expect(coOccurrences[0].signalIds).toContain('signal-2');
    });

    it('should handle empty results', () => {
      const coOccurrences = findCoOccurrences([]);

      expect(coOccurrences).toEqual([]);
    });

    it('should handle signals with single entity', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences).toEqual([]);
    });

    it('should handle signals with no entities', () => {
      const results = [createMockExtractionResult('signal-1', [])];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences).toEqual([]);
    });

    it('should sort co-occurrences by count descending', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'A', type: 'company' }),
          createMockEntity({ name: 'B', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-2', [
          createMockEntity({ name: 'A', type: 'company' }),
          createMockEntity({ name: 'B', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-3', [
          createMockEntity({ name: 'A', type: 'company' }),
          createMockEntity({ name: 'B', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-4', [
          createMockEntity({ name: 'C', type: 'company' }),
          createMockEntity({ name: 'D', type: 'technology' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences[0].count).toBe(3); // A-B appeared 3 times
      expect(coOccurrences[1].count).toBe(1); // C-D appeared 1 time
    });
  });

  describe('proposeRelationsFromCoOccurrence()', () => {
    it('should propose relations based on co-occurrences', () => {
      const coOccurrences: CoOccurrence[] = [
        {
          entity1: { name: 'AI Platform', type: 'technology' },
          entity2: { name: 'TechCorp', type: 'company' },
          count: 3,
          signalIds: ['s1', 's2', 's3'],
        },
      ];

      const proposals = proposeRelationsFromCoOccurrence(coOccurrences);

      expect(proposals).toHaveLength(1);
      // Company should be source for company-technology relation
      expect(proposals[0].sourceName).toBe('TechCorp');
      expect(proposals[0].targetName).toBe('AI Platform');
    });

    it('should infer relation type from entity types', () => {
      const coOccurrences: CoOccurrence[] = [
        {
          entity1: { name: 'AI Platform', type: 'technology' },
          entity2: { name: 'TechCorp', type: 'company' },
          count: 2,
          signalIds: ['s1', 's2'],
        },
      ];

      const proposals = proposeRelationsFromCoOccurrence(coOccurrences);

      // Company + Technology should suggest vendor
      expect(proposals[0].relationType).toBe('vendor');
    });

    it('should calculate confidence based on co-occurrence count', () => {
      const highCount: CoOccurrence[] = [
        {
          entity1: { name: 'E1', type: 'company' },
          entity2: { name: 'E2', type: 'technology' },
          count: 10,
          signalIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
        },
      ];

      const lowCount: CoOccurrence[] = [
        {
          entity1: { name: 'E1', type: 'company' },
          entity2: { name: 'E2', type: 'technology' },
          count: 2,
          signalIds: ['s1', 's2'],
        },
      ];

      const highProposals = proposeRelationsFromCoOccurrence(highCount);
      const lowProposals = proposeRelationsFromCoOccurrence(lowCount);

      // Higher count should have higher confidence
      expect(highProposals[0].confidence).toBeGreaterThan(lowProposals[0].confidence);
    });

    it('should filter out low co-occurrence counts by default (minCount=2)', () => {
      const coOccurrences: CoOccurrence[] = [
        {
          entity1: { name: 'E1', type: 'company' },
          entity2: { name: 'E2', type: 'technology' },
          count: 1,
          signalIds: ['s1'],
        },
      ];

      const proposals = proposeRelationsFromCoOccurrence(coOccurrences);

      expect(proposals).toHaveLength(0);
    });

    it('should respect minCount option', () => {
      const coOccurrences: CoOccurrence[] = [
        {
          entity1: { name: 'E1', type: 'company' },
          entity2: { name: 'E2', type: 'technology' },
          count: 1,
          signalIds: ['s1'],
        },
      ];

      // Need to also lower minConfidence because count=1 gives confidence=50
      // which is below the default minConfidence=60
      const proposals = proposeRelationsFromCoOccurrence(coOccurrences, {
        minCount: 1,
        minConfidence: 0,
      });

      expect(proposals).toHaveLength(1);
    });
  });

  describe('proposeRelationsWithAI()', () => {
    it('should use AI to propose relations', async () => {
      const signalContent = 'TechCorp develops AI Platform for enterprise customers.';
      const entities: ExtractedEntity[] = [
        { name: 'TechCorp', type: 'company', confidence: 90 },
        { name: 'AI Platform', type: 'technology', confidence: 85 },
      ];

      mockGenerateStructuredContent.mockResolvedValueOnce({
        relations: [
          {
            sourceName: 'TechCorp',
            targetName: 'AI Platform',
            relationType: 'DEVELOPS',
            confidence: 92,
            reasoning: 'TechCorp is mentioned as the developer of AI Platform',
          },
        ],
      });

      const proposals = await proposeRelationsWithAI(signalContent, entities, 'signal-1');

      expect(proposals).toHaveLength(1);
      expect(proposals[0].relationType).toBe('DEVELOPS');
      expect(proposals[0].confidence).toBe(92);
    });

    it('should handle AI failures gracefully', async () => {
      const signalContent = 'Some content';
      const entities: ExtractedEntity[] = [
        { name: 'E1', type: 'company', confidence: 90 },
        { name: 'E2', type: 'technology', confidence: 85 },
      ];

      mockGenerateStructuredContent.mockRejectedValueOnce(new Error('AI service unavailable'));

      const proposals = await proposeRelationsWithAI(signalContent, entities, 'signal-1');

      // Should return empty array on error
      expect(proposals).toEqual([]);
    });

    it('should return empty for single entity', async () => {
      const signalContent = 'Some content';
      const entities: ExtractedEntity[] = [{ name: 'E1', type: 'company', confidence: 90 }];

      const proposals = await proposeRelationsWithAI(signalContent, entities, 'signal-1');

      expect(proposals).toEqual([]);
      expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
    });
  });

  describe('proposeRelations()', () => {
    it('should combine co-occurrence proposals', async () => {
      const extractionResults = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-2', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
      ];

      const signalContents = new Map([
        ['signal-1', 'TechCorp uses AI Platform.'],
        ['signal-2', 'TechCorp and AI Platform are mentioned.'],
      ]);

      const result = await proposeRelations(extractionResults, signalContents, { useAI: false });

      expect(result.proposals.length).toBeGreaterThan(0);
      expect(result.method).toBe('cooccurrence');
      expect(result.totalCoOccurrences).toBeGreaterThan(0);
    });

    it('should skip AI if disabled', async () => {
      const extractionResults = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
      ];

      const signalContents = new Map([['signal-1', 'TechCorp uses AI Platform.']]);

      const result = await proposeRelations(extractionResults, signalContents, { useAI: false });

      expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
      expect(result.proposals).toBeDefined();
      expect(result.method).toBe('cooccurrence');
    });

    it('should use AI when enabled', async () => {
      const extractionResults = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
        createMockExtractionResult('signal-2', [
          createMockEntity({ name: 'TechCorp', type: 'company' }),
          createMockEntity({ name: 'AI Platform', type: 'technology' }),
        ]),
      ];

      const signalContents = new Map([
        ['signal-1', 'TechCorp develops AI Platform.'],
        ['signal-2', 'TechCorp and AI Platform.'],
      ]);

      mockGenerateStructuredContent.mockResolvedValueOnce({
        relations: [
          {
            sourceName: 'TechCorp',
            targetName: 'AI Platform',
            relationType: 'DEVELOPS',
            confidence: 90,
            reasoning: 'Test',
          },
        ],
      });

      const result = await proposeRelations(extractionResults, signalContents, { useAI: true });

      expect(mockGenerateStructuredContent).toHaveBeenCalled();
      expect(result.method).toBe('combined');
    });
  });

  describe('groupProposalsByType()', () => {
    it('should group proposals by relation type', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ relationType: 'uses' }),
        createMockProposal({ relationType: 'uses' }),
        createMockProposal({ relationType: 'vendor' }),
      ];

      const grouped = groupProposalsByType(proposals);

      expect(grouped.get('uses')).toHaveLength(2);
      expect(grouped.get('vendor')).toHaveLength(1);
    });

    it('should handle empty proposals', () => {
      const grouped = groupProposalsByType([]);

      expect(grouped.size).toBe(0);
    });

    it('should return a Map with RelationType keys', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ relationType: 'vendor' }),
        createMockProposal({ relationType: 'competes_with' }),
      ];

      const grouped = groupProposalsByType(proposals);

      expect(grouped).toBeInstanceOf(Map);
      expect(grouped.has('vendor')).toBe(true);
      expect(grouped.has('competes_with')).toBe(true);
    });
  });

  describe('filterByConfidence()', () => {
    it('should filter proposals below threshold', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ confidence: 90 }),
        createMockProposal({ confidence: 50 }),
        createMockProposal({ confidence: 70 }),
      ];

      const filtered = filterByConfidence(proposals, 60);

      expect(filtered).toHaveLength(2);
      expect(filtered.every((p) => p.confidence >= 60)).toBe(true);
    });

    it('should return empty array when all below threshold', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ confidence: 50 }),
        createMockProposal({ confidence: 40 }),
      ];

      const filtered = filterByConfidence(proposals, 60);

      expect(filtered).toHaveLength(0);
    });

    it('should return all when all above threshold', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ confidence: 90 }),
        createMockProposal({ confidence: 85 }),
      ];

      const filtered = filterByConfidence(proposals, 80);

      expect(filtered).toHaveLength(2);
    });
  });

  describe('getProposalStats()', () => {
    it('should calculate proposal statistics', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ relationType: 'uses', confidence: 90 }),
        createMockProposal({ relationType: 'uses', confidence: 80 }),
        createMockProposal({ relationType: 'vendor', confidence: 70 }),
      ];

      const result = createMockProposalResult(proposals);
      const stats = getProposalStats(result);

      expect(stats.totalProposals).toBe(3);
      expect(stats.byType.uses).toBe(2);
      expect(stats.byType.vendor).toBe(1);
      expect(stats.avgConfidence).toBe(80); // (90 + 80 + 70) / 3 = 80
    });

    it('should calculate high confidence count (>=80)', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ confidence: 90 }),
        createMockProposal({ confidence: 60 }),
        createMockProposal({ confidence: 85 }),
      ];

      const result = createMockProposalResult(proposals);
      const stats = getProposalStats(result);

      expect(stats.highConfidence).toBe(2); // >= 80
      expect(stats.mediumConfidence).toBe(1); // >= 60 && < 80
      expect(stats.lowConfidence).toBe(0); // < 60
    });

    it('should handle empty proposals', () => {
      const result = createMockProposalResult([]);
      const stats = getProposalStats(result);

      expect(stats.totalProposals).toBe(0);
      expect(stats.avgConfidence).toBe(0);
      expect(stats.highConfidence).toBe(0);
      expect(stats.mediumConfidence).toBe(0);
      expect(stats.lowConfidence).toBe(0);
    });

    it('should count low confidence proposals', () => {
      const proposals: ProposedRelation[] = [
        createMockProposal({ confidence: 50 }),
        createMockProposal({ confidence: 40 }),
      ];

      const result = createMockProposalResult(proposals);
      const stats = getProposalStats(result);

      expect(stats.lowConfidence).toBe(2); // < 60
    });
  });

  describe('Edge Cases', () => {
    it('should handle entities with same name but different types', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: 'Apple', type: 'company' }),
          createMockEntity({ name: 'Apple', type: 'product' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      // Should create a co-occurrence between company Apple and product Apple
      expect(coOccurrences.length).toBeGreaterThan(0);
    });

    it('should handle special characters in entity names', () => {
      const results = [
        createMockExtractionResult('signal-1', [
          createMockEntity({ name: "O'Reilly & Co.", type: 'company' }),
          createMockEntity({ name: 'Tech-Platform', type: 'technology' }),
        ]),
      ];

      const coOccurrences = findCoOccurrences(results);

      expect(coOccurrences[0].entity1.name).toBeDefined();
      expect(coOccurrences[0].entity2.name).toBeDefined();
    });

    it('should handle many entities in one signal', () => {
      const manyEntities = Array.from({ length: 20 }, (_, i) =>
        createMockEntity({
          name: `Entity ${i}`,
          type: i % 2 === 0 ? 'company' : 'technology',
        })
      );

      const results = [createMockExtractionResult('signal-1', manyEntities)];

      const coOccurrences = findCoOccurrences(results);

      // Should create many co-occurrences (n*(n-1)/2 pairs)
      expect(coOccurrences.length).toBeGreaterThan(0);
    });
  });
});
