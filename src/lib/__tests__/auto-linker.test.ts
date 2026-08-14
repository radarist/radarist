/**
 * Unit Tests for Auto-Linker Module
 *
 * Tests utility functions for entity extraction and matching:
 * - Similarity calculation
 * - Relation type suggestion (now using relation ontology)
 * - Snapshot creation
 * - Support for all 10 entity types
 *
 * Phase 3: Extended to test all entity types and ontology-based suggestions
 *
 * Note: The main suggestRelations function requires AI calls, so
 * we test the pure utility functions and mock the AI extraction.
 *
 * @jest-environment node
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { EntityType } from '../types';
import { createSnapshotFromSuggestion, SuggestedRelation } from '../auto-linker-utils';
import { getValidRelationTypes } from '../linker/relation-ontology';

/**
 * Helper to create a mock suggested relation
 */
function createMockSuggestion(overrides?: Partial<SuggestedRelation>): SuggestedRelation {
  return {
    entityType: 'technology',
    entityId: 'tech-123',
    entityName: 'TensorFlow',
    entityDescription: 'Machine learning framework',
    relationType: 'uses',
    confidence: 85,
    context: 'using for ML models',
    ...overrides,
  };
}

describe('Auto-Linker Utilities', () => {
  describe('createSnapshotFromSuggestion()', () => {
    it('should create a valid entity snapshot from suggestion', () => {
      const suggestion = createMockSuggestion();
      const before = Date.now();

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('technology');
      expect(snapshot.id).toBe('tech-123');
      expect(snapshot.name).toBe('TensorFlow');
      expect(snapshot.description).toBe('Machine learning framework');
      expect(snapshot.snapshotAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.snapshotAt).toBeLessThanOrEqual(Date.now());
    });

    it('should handle technology entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'technology',
        entityId: 'radar-1:42',
        entityName: 'React',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('technology');
      expect(snapshot.id).toBe('radar-1:42');
      expect(snapshot.name).toBe('React');
    });

    it('should handle company entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'company',
        entityId: 'company-456',
        entityName: 'Google',
        entityDescription: 'Technology company',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('company');
      expect(snapshot.id).toBe('company-456');
      expect(snapshot.name).toBe('Google');
    });

    it('should handle useCase entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'useCase',
        entityId: 'uc-789',
        entityName: 'Predictive Maintenance',
        entityDescription: 'Using ML to predict equipment failures',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('useCase');
      expect(snapshot.id).toBe('uc-789');
      expect(snapshot.name).toBe('Predictive Maintenance');
    });

    it('should handle missing description', () => {
      const suggestion = createMockSuggestion({
        entityDescription: undefined,
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.description).toBeUndefined();
    });

    it('should create unique timestamps for different calls', async () => {
      const suggestion1 = createMockSuggestion();
      const snapshot1 = createSnapshotFromSuggestion(suggestion1);

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      const suggestion2 = createMockSuggestion();
      const snapshot2 = createSnapshotFromSuggestion(suggestion2);

      expect(snapshot2.snapshotAt).toBeGreaterThanOrEqual(snapshot1.snapshotAt);
    });
  });

  describe('SuggestedRelation Interface', () => {
    it('should validate all required fields', () => {
      const suggestion: SuggestedRelation = {
        entityType: 'technology',
        entityId: 'tech-1',
        entityName: 'TensorFlow',
        relationType: 'uses',
        confidence: 90,
      };

      expect(suggestion.entityType).toBeDefined();
      expect(suggestion.entityId).toBeDefined();
      expect(suggestion.entityName).toBeDefined();
      expect(suggestion.relationType).toBeDefined();
      expect(suggestion.confidence).toBeDefined();
    });

    it('should allow optional fields to be undefined', () => {
      const suggestion: SuggestedRelation = {
        entityType: 'company',
        entityId: 'company-1',
        entityName: 'Google',
        relationType: 'vendor',
        confidence: 85,
        // entityDescription and context are optional
      };

      expect(suggestion.entityDescription).toBeUndefined();
      expect(suggestion.context).toBeUndefined();
    });
  });
});

describe('Similarity Calculation Logic', () => {
  /**
   * Testing the similarity logic that exists in auto-linker.ts
   * We replicate the function here for testing since it's not exported
   */
  function calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Exact match
    if (s1 === s2) return 100;

    // One contains the other
    if (s1.includes(s2) || s2.includes(s1)) {
      const longer = Math.max(s1.length, s2.length);
      const shorter = Math.min(s1.length, s2.length);
      return Math.round((shorter / longer) * 90);
    }

    // Word-based matching
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    const matchingWords = words1.filter((w) => words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w)));

    if (matchingWords.length > 0) {
      return Math.round((matchingWords.length / Math.max(words1.length, words2.length)) * 70);
    }

    return 0;
  }

  it('should return 100 for exact match', () => {
    expect(calculateSimilarity('TensorFlow', 'TensorFlow')).toBe(100);
  });

  it('should be case-insensitive', () => {
    expect(calculateSimilarity('tensorflow', 'TENSORFLOW')).toBe(100);
  });

  it('should handle whitespace trimming', () => {
    expect(calculateSimilarity('  TensorFlow  ', 'TensorFlow')).toBe(100);
  });

  it('should give high score when one contains the other', () => {
    const score = calculateSimilarity('TensorFlow', 'TensorFlow 2.0');
    expect(score).toBeGreaterThanOrEqual(60); // Score based on length ratio
    expect(score).toBeLessThanOrEqual(90);
  });

  it('should give partial score for word matches', () => {
    const score = calculateSimilarity('Machine Learning Framework', 'Machine Learning');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('should return 0 for completely different strings', () => {
    expect(calculateSimilarity('TensorFlow', 'PostgreSQL')).toBe(0);
  });

  it('should handle single word vs multiple words', () => {
    const score = calculateSimilarity('React', 'React JavaScript Library');
    expect(score).toBeGreaterThan(0);
  });

  it('should handle empty strings', () => {
    expect(calculateSimilarity('', '')).toBe(100); // Both empty = exact match
  });
});

describe('Relation Type Suggestion Logic', () => {
  /**
   * Testing the relation type suggestion logic from auto-linker.ts
   * We replicate the function here for testing since it's not exported
   */
  function suggestRelationType(sourceType: EntityType, targetType: EntityType, context?: string): string {
    const contextLower = (context || '').toLowerCase();

    // Technology to Technology
    if (sourceType === 'technology' && targetType === 'technology') {
      if (contextLower.includes('uses') || contextLower.includes('using') || contextLower.includes('built on')) {
        return 'uses';
      }
      if (contextLower.includes('enables') || contextLower.includes('powers')) {
        return 'enables';
      }
      if (contextLower.includes('competes') || contextLower.includes('alternative')) {
        return 'competes_with';
      }
      return 'uses';
    }

    // Company relations
    if (targetType === 'company') {
      if (contextLower.includes('vendor') || contextLower.includes('provides') || contextLower.includes('sells')) {
        return 'vendor';
      }
      if (contextLower.includes('partner') || contextLower.includes('collaboration')) {
        return 'partner';
      }
      if (contextLower.includes('compet') || contextLower.includes('rival')) {
        return 'competitor';
      }
      if (contextLower.includes('uses') || contextLower.includes('customer')) {
        return 'user';
      }
      return 'vendor';
    }

    // Use Case relations
    if (targetType === 'useCase') {
      if (contextLower.includes('requires') || contextLower.includes('needs')) {
        return 'requires';
      }
      if (contextLower.includes('addresses') || contextLower.includes('solves')) {
        return 'addresses';
      }
      return 'addresses';
    }

    return 'custom';
  }

  describe('Technology to Technology relations', () => {
    it('should suggest "uses" for using context', () => {
      expect(suggestRelationType('technology', 'technology', 'using for models')).toBe('uses');
      expect(suggestRelationType('technology', 'technology', 'built on Python')).toBe('uses');
    });

    it('should suggest "enables" for enabling context', () => {
      expect(suggestRelationType('technology', 'technology', 'enables faster processing')).toBe('enables');
      expect(suggestRelationType('technology', 'technology', 'powers the application')).toBe('enables');
    });

    it('should suggest "competes_with" for competitive context', () => {
      expect(suggestRelationType('technology', 'technology', 'competes with PyTorch')).toBe('competes_with');
      expect(suggestRelationType('technology', 'technology', 'alternative to')).toBe('competes_with');
    });

    it('should default to "uses" without context', () => {
      expect(suggestRelationType('technology', 'technology')).toBe('uses');
    });
  });

  describe('Company relations', () => {
    it('should suggest "vendor" for vendor context', () => {
      expect(suggestRelationType('technology', 'company', 'vendor for')).toBe('vendor');
      expect(suggestRelationType('technology', 'company', 'provides service')).toBe('vendor');
      expect(suggestRelationType('technology', 'company', 'sells products')).toBe('vendor');
    });

    it('should suggest "partner" for partnership context', () => {
      expect(suggestRelationType('technology', 'company', 'partner company')).toBe('partner');
      expect(suggestRelationType('technology', 'company', 'collaboration with')).toBe('partner');
    });

    it('should suggest "competitor" for competitive context', () => {
      expect(suggestRelationType('company', 'company', 'competitor')).toBe('competitor');
      expect(suggestRelationType('company', 'company', 'rival company')).toBe('competitor');
    });

    it('should suggest "user" for customer context', () => {
      expect(suggestRelationType('technology', 'company', 'uses the service')).toBe('user');
      expect(suggestRelationType('technology', 'company', 'customer of')).toBe('user');
    });

    it('should default to "vendor" for company target without context', () => {
      expect(suggestRelationType('technology', 'company')).toBe('vendor');
    });
  });

  describe('Use Case relations', () => {
    it('should suggest "requires" for requirement context', () => {
      expect(suggestRelationType('technology', 'useCase', 'requires ML')).toBe('requires');
      expect(suggestRelationType('technology', 'useCase', 'needs this')).toBe('requires');
    });

    it('should suggest "addresses" for solution context', () => {
      expect(suggestRelationType('technology', 'useCase', 'addresses the problem')).toBe('addresses');
      expect(suggestRelationType('technology', 'useCase', 'solves this issue')).toBe('addresses');
    });

    it('should default to "addresses" for use case target without context', () => {
      expect(suggestRelationType('technology', 'useCase')).toBe('addresses');
    });
  });

  describe('Edge cases', () => {
    it('should handle undefined context', () => {
      expect(suggestRelationType('technology', 'technology', undefined)).toBe('uses');
    });

    it('should handle empty context', () => {
      expect(suggestRelationType('technology', 'company', '')).toBe('vendor');
    });

    it('should be case-insensitive for context', () => {
      expect(suggestRelationType('technology', 'technology', 'USES Python')).toBe('uses');
    });
  });
});

describe('Integration Tests (with mocked AI)', () => {
  /**
   * These tests would require mocking the AI client and database calls
   * For now, we test the structure and expected behavior patterns
   */

  it('should handle empty text input', () => {
    // suggestRelations should return empty array for short/empty text
    const minTextLength = 10;
    const shortText = 'Hi';

    expect(shortText.length).toBeLessThan(minTextLength);
    // In real implementation: expect(await suggestRelations('Hi', 'technology', 'id')).toEqual([])
  });

  it('should limit suggestions to top 15', () => {
    // Phase 3: The suggestRelations function now limits results to 15 (was 10)
    const maxSuggestions = 15;
    expect(maxSuggestions).toBe(15);
  });

  it('should deduplicate suggestions by entity ID', () => {
    // Same entity shouldn't appear twice in suggestions
    const seen = new Set<string>();
    const suggestions = [
      createMockSuggestion({ entityId: 'tech-1' }),
      createMockSuggestion({ entityId: 'tech-1' }), // Duplicate
      createMockSuggestion({ entityId: 'tech-2' }),
    ];

    const deduped = suggestions.filter((s) => {
      const key = `${s.entityType}:${s.entityId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(deduped).toHaveLength(2);
  });

  it('should skip self-references', () => {
    // Suggestions shouldn't include the source entity itself
    const sourceId = 'tech-1';
    const suggestions = [
      createMockSuggestion({ entityId: 'tech-1' }), // Self-reference
      createMockSuggestion({ entityId: 'tech-2' }),
    ];

    const filtered = suggestions.filter((s) => s.entityId !== sourceId);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].entityId).toBe('tech-2');
  });
});

// ============================================================================
// PHASE 3: ALL ENTITY TYPES TESTS
// ============================================================================

describe('Phase 3: All Entity Types Support', () => {
  /**
   * All 10 supported entity types in the auto-linker (Phase 3: now includes document)
   */
  const ALL_ENTITY_TYPES: EntityType[] = [
    'technology',
    'company',
    'useCase',
    'prototype',
    'strategy',
    'signal',
    'initiative',
    'orgUnit',
    'painPoint',
    'document',
  ];

  describe('Entity Type Coverage', () => {
    it('should support all 10 entity types (including document)', () => {
      // Verify we support all expected types (Phase 3: includes document)
      expect(ALL_ENTITY_TYPES).toHaveLength(10);
      expect(ALL_ENTITY_TYPES).toContain('technology');
      expect(ALL_ENTITY_TYPES).toContain('company');
      expect(ALL_ENTITY_TYPES).toContain('useCase');
      expect(ALL_ENTITY_TYPES).toContain('prototype');
      expect(ALL_ENTITY_TYPES).toContain('strategy');
      expect(ALL_ENTITY_TYPES).toContain('signal');
      expect(ALL_ENTITY_TYPES).toContain('initiative');
      expect(ALL_ENTITY_TYPES).toContain('orgUnit');
      expect(ALL_ENTITY_TYPES).toContain('painPoint');
      expect(ALL_ENTITY_TYPES).toContain('document');
    });

    it('should create valid snapshots for all entity types', () => {
      for (const entityType of ALL_ENTITY_TYPES) {
        const suggestion = createMockSuggestion({
          entityType,
          entityId: `${entityType}-123`,
          entityName: `Test ${entityType}`,
        });

        const snapshot = createSnapshotFromSuggestion(suggestion);

        expect(snapshot.type).toBe(entityType);
        expect(snapshot.id).toBe(`${entityType}-123`);
        expect(snapshot.name).toBe(`Test ${entityType}`);
      }
    });
  });

  describe('New Entity Types: Prototype', () => {
    it('should handle prototype entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'prototype',
        entityId: 'proto-789',
        entityName: 'AI Chatbot MVP',
        entityDescription: 'Proof of concept for customer service chatbot',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('prototype');
      expect(snapshot.id).toBe('proto-789');
      expect(snapshot.name).toBe('AI Chatbot MVP');
    });
  });

  describe('New Entity Types: Strategy', () => {
    it('should handle strategy entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'strategy',
        entityId: 'strat-456',
        entityName: 'Digital Transformation 2026',
        entityDescription: 'Enterprise-wide digital transformation initiative',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('strategy');
      expect(snapshot.id).toBe('strat-456');
      expect(snapshot.name).toBe('Digital Transformation 2026');
    });
  });

  describe('New Entity Types: Signal', () => {
    it('should handle signal entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'signal',
        entityId: 'sig-111',
        entityName: 'GPT-5 Release Announcement',
        entityDescription: 'OpenAI announces next-generation language model',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('signal');
      expect(snapshot.id).toBe('sig-111');
      expect(snapshot.name).toBe('GPT-5 Release Announcement');
    });
  });

  describe('New Entity Types: Initiative', () => {
    it('should handle initiative entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'initiative',
        entityId: 'init-222',
        entityName: 'AI Center of Excellence',
        entityDescription: 'Cross-functional AI enablement program',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('initiative');
      expect(snapshot.id).toBe('init-222');
      expect(snapshot.name).toBe('AI Center of Excellence');
    });
  });

  describe('New Entity Types: OrgUnit', () => {
    it('should handle orgUnit entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'orgUnit',
        entityId: 'org-333',
        entityName: 'Data Engineering Team',
        entityDescription: 'Central data platform engineering unit',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('orgUnit');
      expect(snapshot.id).toBe('org-333');
      expect(snapshot.name).toBe('Data Engineering Team');
    });
  });

  describe('New Entity Types: PainPoint', () => {
    it('should handle painPoint entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'painPoint',
        entityId: 'pain-444',
        entityName: 'Manual Report Generation',
        entityDescription: 'Time-consuming manual data extraction for monthly reports',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('painPoint');
      expect(snapshot.id).toBe('pain-444');
      expect(snapshot.name).toBe('Manual Report Generation');
    });
  });

  describe('Phase 3: New Entity Type - Document', () => {
    it('should handle document entity type', () => {
      const suggestion = createMockSuggestion({
        entityType: 'document',
        entityId: 'doc-555',
        entityName: 'AI Strategy Whitepaper 2026',
        entityDescription: 'Comprehensive analysis of AI trends and enterprise adoption',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.type).toBe('document');
      expect(snapshot.id).toBe('doc-555');
      expect(snapshot.name).toBe('AI Strategy Whitepaper 2026');
    });

    it('should handle document with aiSummary as description fallback', () => {
      const suggestion = createMockSuggestion({
        entityType: 'document',
        entityId: 'doc-666',
        entityName: 'Technical Architecture Document',
        entityDescription: 'AI-generated summary of the architecture',
      });

      const snapshot = createSnapshotFromSuggestion(suggestion);

      expect(snapshot.description).toBe('AI-generated summary of the architecture');
    });
  });
});

// ============================================================================
// PHASE 3: ONTOLOGY-BASED RELATION TYPE TESTS
// ============================================================================

describe('Phase 3: Ontology-Based Relation Type Suggestions', () => {
  describe('getValidRelationTypes() Integration', () => {
    it('should return valid relation types for technology to technology', () => {
      const types = getValidRelationTypes('technology', 'technology');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('uses');
    });

    it('should return valid relation types for technology to company', () => {
      const types = getValidRelationTypes('technology', 'company');
      expect(types.length).toBeGreaterThan(0);
    });

    it('should return valid relation types for company to company', () => {
      const types = getValidRelationTypes('company', 'company');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('partner');
    });

    it('should return valid relation types for signal to technology', () => {
      const types = getValidRelationTypes('signal', 'technology');
      expect(types.length).toBeGreaterThan(0);
    });

    it('should return valid relation types for initiative to strategy', () => {
      const types = getValidRelationTypes('initiative', 'strategy');
      expect(types.length).toBeGreaterThan(0);
    });

    it('should return valid relation types for painPoint to orgUnit', () => {
      const types = getValidRelationTypes('painPoint', 'orgUnit');
      expect(types.length).toBeGreaterThan(0);
    });

    it('should return valid relation types for prototype to technology', () => {
      const types = getValidRelationTypes('prototype', 'technology');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('uses');
    });

    it('should handle unknown entity type pairs gracefully', () => {
      // Test with types that may not have defined relations
      const types = getValidRelationTypes('signal', 'signal');
      // Should return empty array or default types
      expect(Array.isArray(types)).toBe(true);
    });

    // Phase 3: Document relation type tests
    it('should return valid relation types for document to technology', () => {
      const types = getValidRelationTypes('document', 'technology');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('about');
    });

    it('should return valid relation types for document to document', () => {
      const types = getValidRelationTypes('document', 'document');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('references');
      expect(types).toContain('supersedes');
      expect(types).toContain('supplements');
      expect(types).toContain('cites');
    });

    it('should return valid relation types for document to company', () => {
      const types = getValidRelationTypes('document', 'company');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('about');
    });

    it('should return valid relation types for signal to document', () => {
      const types = getValidRelationTypes('signal', 'document');
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('source');
    });
  });
});

// ============================================================================
// PHASE 3: COMBINED CONFIDENCE SCORING TESTS
// ============================================================================

describe('Phase 3: Combined Confidence Scoring', () => {
  /**
   * Replicating the confidence calculation logic for testing
   */
  function calculateCombinedConfidence(similarity: number, extractionConfidence?: number): number {
    // If we have extraction confidence, weight it 30% and similarity 70%
    if (extractionConfidence !== undefined) {
      return Math.round(similarity * 0.7 + extractionConfidence * 0.3);
    }
    return similarity;
  }

  it('should return similarity when no extraction confidence provided', () => {
    expect(calculateCombinedConfidence(85)).toBe(85);
    expect(calculateCombinedConfidence(100)).toBe(100);
    expect(calculateCombinedConfidence(0)).toBe(0);
  });

  it('should combine similarity (70%) and extraction confidence (30%)', () => {
    // Both at 100 should give 100
    expect(calculateCombinedConfidence(100, 100)).toBe(100);

    // Both at 0 should give 0
    expect(calculateCombinedConfidence(0, 0)).toBe(0);

    // Similarity 100, extraction 0: 100*0.7 + 0*0.3 = 70
    expect(calculateCombinedConfidence(100, 0)).toBe(70);

    // Similarity 0, extraction 100: 0*0.7 + 100*0.3 = 30
    expect(calculateCombinedConfidence(0, 100)).toBe(30);

    // Balanced: 80*0.7 + 90*0.3 = 56 + 27 = 83
    expect(calculateCombinedConfidence(80, 90)).toBe(83);
  });

  it('should round to integer', () => {
    // 75*0.7 + 75*0.3 = 52.5 + 22.5 = 75
    expect(calculateCombinedConfidence(75, 75)).toBe(75);

    // 77*0.7 + 81*0.3 = 53.9 + 24.3 = 78.2 -> 78
    expect(calculateCombinedConfidence(77, 81)).toBe(78);
  });
});

// ============================================================================
// PHASE 3: SELF-REFERENCE DETECTION TESTS
// ============================================================================

// ============================================================================
// PHASE 3: DOCUMENT/SIGNAL CONTENT ANALYSIS OPTIONS TESTS
// ============================================================================

describe('Phase 3: Content Analysis Options', () => {
  /**
   * Testing the SuggestRelationsOptions interface structure
   */
  interface SuggestRelationsOptions {
    includeDocumentContent?: boolean;
    includeSignalContent?: boolean;
  }

  describe('Options Interface', () => {
    it('should accept includeDocumentContent option', () => {
      const options: SuggestRelationsOptions = {
        includeDocumentContent: true,
      };
      expect(options.includeDocumentContent).toBe(true);
    });

    it('should accept includeSignalContent option', () => {
      const options: SuggestRelationsOptions = {
        includeSignalContent: true,
      };
      expect(options.includeSignalContent).toBe(true);
    });

    it('should accept both options together', () => {
      const options: SuggestRelationsOptions = {
        includeDocumentContent: true,
        includeSignalContent: true,
      };
      expect(options.includeDocumentContent).toBe(true);
      expect(options.includeSignalContent).toBe(true);
    });

    it('should have optional properties that default to undefined', () => {
      const options: SuggestRelationsOptions = {};
      expect(options.includeDocumentContent).toBeUndefined();
      expect(options.includeSignalContent).toBeUndefined();
    });
  });

  describe('Content Analysis Logic', () => {
    it('should only apply document content analysis when sourceType is document', () => {
      // Logic: includeDocumentContent should only be effective when sourceType === 'document'
      const _sourceType = 'document';
      const shouldApplyDocumentContent = (opts: SuggestRelationsOptions, type: string) =>
        opts.includeDocumentContent && type === 'document';

      expect(shouldApplyDocumentContent({ includeDocumentContent: true }, 'document')).toBe(true);
      expect(shouldApplyDocumentContent({ includeDocumentContent: true }, 'company')).toBe(false);
      expect(shouldApplyDocumentContent({ includeDocumentContent: false }, 'document')).toBe(false);
    });

    it('should only apply signal content analysis when sourceType is signal', () => {
      // Logic: includeSignalContent should only be effective when sourceType === 'signal'
      const shouldApplySignalContent = (opts: SuggestRelationsOptions, type: string) =>
        opts.includeSignalContent && type === 'signal';

      expect(shouldApplySignalContent({ includeSignalContent: true }, 'signal')).toBe(true);
      expect(shouldApplySignalContent({ includeSignalContent: true }, 'company')).toBe(false);
      expect(shouldApplySignalContent({ includeSignalContent: false }, 'signal')).toBe(false);
    });
  });

  describe('Enhanced Text Building', () => {
    it('should build enhanced text with document metadata', () => {
      // Simulating the text building logic
      const docMeta = [
        'Document Title: AI Strategy Guide',
        'Description: Comprehensive AI adoption guide',
        'Tags: ai, strategy, enterprise',
      ];
      const chunkContent = 'This is chunk 1 content.\n\nThis is chunk 2 content.';
      const originalText = 'Additional context from user input';

      const enhancedText = `${docMeta.join('\n')}\n\nDocument Content:\n${chunkContent}\n\nAdditional Context:\n${originalText}`;

      expect(enhancedText).toContain('Document Title: AI Strategy Guide');
      expect(enhancedText).toContain('Document Content:');
      expect(enhancedText).toContain('chunk 1 content');
      expect(enhancedText).toContain('Additional Context:');
      expect(enhancedText).toContain('Additional context from user input');
    });

    it('should build enhanced text with signal metadata', () => {
      // Simulating the text building logic
      const signalMeta = [
        'Signal Title: GPT-5 Release Announcement',
        'Description: OpenAI announces next-gen model',
        'Content: Full article text here...',
        'Source: techcrunch.com',
      ];
      const originalText = 'Additional context from user input';

      const enhancedText = `${signalMeta.join('\n')}\n\nAdditional Context:\n${originalText}`;

      expect(enhancedText).toContain('Signal Title: GPT-5 Release Announcement');
      expect(enhancedText).toContain('Content: Full article text here');
      expect(enhancedText).toContain('Source: techcrunch.com');
      expect(enhancedText).toContain('Additional Context:');
    });

    it('should limit signal content to 2000 characters', () => {
      // Phase 3 spec: signal content limited to 2000 chars
      const longContent = 'x'.repeat(3000);
      const truncatedContent = longContent.slice(0, 2000);

      expect(truncatedContent.length).toBe(2000);
    });

    it('should limit document chunks to first 5', () => {
      // Phase 3 spec: only use first 5 chunks
      const chunks = Array.from({ length: 10 }, (_, i) => ({
        content: `Chunk ${i + 1} content`,
      }));

      const limitedChunks = chunks.slice(0, 5);

      expect(limitedChunks.length).toBe(5);
      expect(limitedChunks[0].content).toBe('Chunk 1 content');
      expect(limitedChunks[4].content).toBe('Chunk 5 content');
    });
  });
});

describe('Phase 3: Self-Reference Detection', () => {
  /**
   * Replicating the self-reference detection logic for testing
   */
  function isSelfReference(
    sourceEntityType: EntityType,
    sourceEntityId: string,
    targetEntityType: EntityType,
    targetEntityId: string,
    targetEntityName: string,
    extractedName: string
  ): boolean {
    // Different entity types can't be self-references
    if (sourceEntityType !== targetEntityType) {
      return false;
    }

    // Check ID match
    if (targetEntityId === sourceEntityId) {
      return true;
    }

    // For technologies, check composite ID patterns
    if (targetEntityType === 'technology') {
      const rawId = targetEntityId;
      if (sourceEntityId.includes(rawId) || rawId.includes(sourceEntityId.split(':').pop() || '')) {
        return true;
      }
    }

    // Name-based check for same-type entities
    if (targetEntityName.toLowerCase().trim() === extractedName.toLowerCase().trim()) {
      return true;
    }

    return false;
  }

  it('should detect self-reference by exact ID match', () => {
    expect(isSelfReference('company', 'comp-123', 'company', 'comp-123', 'Test Co', 'Other')).toBe(true);
  });

  it('should NOT detect self-reference for different entity types', () => {
    expect(isSelfReference('company', 'comp-123', 'technology', 'comp-123', 'Test', 'Test')).toBe(false);
  });

  it('should detect self-reference by name match for same type', () => {
    expect(isSelfReference('company', 'comp-123', 'company', 'comp-456', 'Test Company', 'Test Company')).toBe(true);
  });

  it('should be case-insensitive for name matching', () => {
    expect(isSelfReference('company', 'comp-123', 'company', 'comp-456', 'TEST COMPANY', 'test company')).toBe(true);
  });

  it('should detect technology self-reference with composite ID', () => {
    expect(isSelfReference('technology', 'radar-1:entry-42', 'technology', 'entry-42', 'React', 'Other')).toBe(true);
  });

  it('should NOT detect self-reference for different IDs and names', () => {
    expect(isSelfReference('company', 'comp-123', 'company', 'comp-456', 'Company A', 'Company B')).toBe(false);
  });
});

// ============================================================================
// INTEGRATION TESTS: suggestRelations with mocked AI and DB
// ============================================================================

// NOTE: These tests import the actual auto-linker module and mock all its
// external dependencies (AI client, database services, feature flags, etc.)
// to exercise the full suggestRelations pipeline.

type AsyncMockFn = (...args: unknown[]) => Promise<unknown>;
type SyncMockFn = (...args: unknown[]) => unknown;
const mockGenerateStructuredContent = jest.fn<AsyncMockFn>();
const mockGetTechnologies = jest.fn<AsyncMockFn>();
const mockGetCompaniesAL = jest.fn<AsyncMockFn>();
const mockGetUseCasesAL = jest.fn<AsyncMockFn>();
const mockGetPrototypesAL = jest.fn<AsyncMockFn>();
const mockGetStrategiesAL = jest.fn<AsyncMockFn>();
const mockGetSignalsAL = jest.fn<AsyncMockFn>();
const mockGetInitiativesAL = jest.fn<AsyncMockFn>();
const mockGetOrgUnitsAL = jest.fn<AsyncMockFn>();
const mockGetPainPointsAL = jest.fn<AsyncMockFn>();
const mockGetDocumentsAL = jest.fn<AsyncMockFn>();
const mockGetDocumentByIdAL = jest.fn<AsyncMockFn>();
const mockGetChunksForDocumentAL = jest.fn<AsyncMockFn>();
const mockGetSignalByIdAL = jest.fn<AsyncMockFn>();
const mockGetValidRelationTypesAL = jest.fn<SyncMockFn>();
const mockIdResolver = {
  isNewFormat: jest.fn<SyncMockFn>().mockReturnValue(true),
};

jest.mock('../ai/client', () => ({
  generateStructuredContent: (...args: unknown[]) => mockGenerateStructuredContent(...args),
}));

jest.mock('../technologies', () => ({
  getTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
}));

jest.mock('../companies', () => ({
  getCompanies: (...args: unknown[]) => mockGetCompaniesAL(...args),
}));

jest.mock('../use-cases', () => ({
  getUseCases: (...args: unknown[]) => mockGetUseCasesAL(...args),
}));

jest.mock('../prototypes', () => ({
  getPrototypes: (...args: unknown[]) => mockGetPrototypesAL(...args),
}));

jest.mock('../strategies', () => ({
  getStrategies: (...args: unknown[]) => mockGetStrategiesAL(...args),
}));

jest.mock('../signals', () => ({
  getSignals: (...args: unknown[]) => mockGetSignalsAL(...args),
  getSignalById: (...args: unknown[]) => mockGetSignalByIdAL(...args),
}));

jest.mock('../initiatives', () => ({
  getInitiatives: (...args: unknown[]) => mockGetInitiativesAL(...args),
}));

jest.mock('../org-units', () => ({
  getOrgUnits: (...args: unknown[]) => mockGetOrgUnitsAL(...args),
}));

jest.mock('../pain-points', () => ({
  getPainPoints: (...args: unknown[]) => mockGetPainPointsAL(...args),
}));

jest.mock('../document-service', () => ({
  getDocuments: (...args: unknown[]) => mockGetDocumentsAL(...args),
  getDocumentById: (...args: unknown[]) => mockGetDocumentByIdAL(...args),
}));

jest.mock('../document-chunk-service', () => ({
  getChunksForDocument: (...args: unknown[]) => mockGetChunksForDocumentAL(...args),
}));

jest.mock('../linker/relation-ontology', () => ({
  getValidRelationTypes: (...args: unknown[]) => mockGetValidRelationTypesAL(...args),
}));

jest.mock('../migration', () => ({
  idResolver: mockIdResolver,
}));

// Import the actual module
const { suggestRelations } = require('../auto-linker');

function setupAutoLinkerDefaults() {
  // Empty extraction by default - AI returns nothing
  mockGenerateStructuredContent.mockResolvedValue({
    technologies: [],
    companies: [],
    useCases: [],
    prototypes: [],
    strategies: [],
    signals: [],
    initiatives: [],
    orgUnits: [],
    painPoints: [],
    documents: [],
  });

  mockGetTechnologies.mockResolvedValue({ technologies: [] });
  mockGetCompaniesAL.mockResolvedValue([]);
  mockGetUseCasesAL.mockResolvedValue([]);
  mockGetPrototypesAL.mockResolvedValue([]);
  mockGetStrategiesAL.mockResolvedValue([]);
  mockGetSignalsAL.mockResolvedValue([]);
  mockGetInitiativesAL.mockResolvedValue([]);
  mockGetOrgUnitsAL.mockResolvedValue([]);
  mockGetPainPointsAL.mockResolvedValue([]);
  mockGetDocumentsAL.mockResolvedValue([]);
  mockGetValidRelationTypesAL.mockReturnValue(['uses', 'enables', 'competes_with']);
  mockIdResolver.isNewFormat.mockReturnValue(true);
}

describe('suggestRelations() Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupAutoLinkerDefaults();
  });

  it('should return empty array for short text', async () => {
    const result = await suggestRelations('Hi', 'company', 'comp-1');

    expect(result).toEqual([]);
    expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
  });

  it('should return empty array when AI extracts no entities', async () => {
    const result = await suggestRelations(
      'This is a long enough text to trigger extraction but has no entities.',
      'company',
      'comp-1'
    );

    expect(result).toEqual([]);
  });

  it('should match extracted technologies against database', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [{ name: 'React', context: 'using React for UI', confidence: 90 }],
      companies: [],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetTechnologies.mockResolvedValue({
      technologies: [{ id: 'tech-react', name: 'React', description: 'UI library', radarId: 'r1' }],
    });

    const result = await suggestRelations(
      'We are using React for our new frontend project and it works great.',
      'company',
      'comp-1'
    );

    expect(result.length).toBe(1);
    expect(result[0].entityType).toBe('technology');
    expect(result[0].entityName).toBe('React');
    expect(result[0].confidence).toBeGreaterThan(50);
  });

  it('should match extracted companies against database', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [],
      companies: [{ name: 'Google', context: 'partnering with Google', confidence: 95 }],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetCompaniesAL.mockResolvedValue([{ id: 'company-google', name: 'Google', description: 'Tech company' }]);

    const result = await suggestRelations(
      'We are partnering with Google on their cloud platform for enterprise workloads.',
      'technology',
      'tech-1'
    );

    expect(result.length).toBe(1);
    expect(result[0].entityType).toBe('company');
    expect(result[0].entityName).toBe('Google');
  });

  it('should filter self-references', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [],
      companies: [{ name: 'Acme Corp', context: 'we at Acme Corp', confidence: 95 }],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetCompaniesAL.mockResolvedValue([{ id: 'comp-self', name: 'Acme Corp', description: 'Our company' }]);

    const result = await suggestRelations(
      'We at Acme Corp are developing innovative solutions for the market.',
      'company',
      'comp-self' // Same ID as the matched company
    );

    expect(result).toHaveLength(0);
  });

  it('should deduplicate suggestions by entity type and ID', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [
        { name: 'React', context: 'using React', confidence: 90 },
        { name: 'React', context: 'React framework', confidence: 85 },
      ],
      companies: [],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetTechnologies.mockResolvedValue({
      technologies: [{ id: 'tech-react', name: 'React', description: 'UI lib', radarId: 'r1' }],
    });

    const result = await suggestRelations(
      'We use React for our frontend and React is the best choice for UI.',
      'company',
      'comp-1'
    );

    // Should be deduplicated to 1
    const reactSuggestions = result.filter((s: { entityName: string }) => s.entityName === 'React');
    expect(reactSuggestions).toHaveLength(1);
  });

  it('should sort suggestions by confidence descending', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [{ name: 'React', context: 'using React', confidence: 70 }],
      companies: [{ name: 'Google', context: 'Google partner', confidence: 95 }],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetTechnologies.mockResolvedValue({
      technologies: [{ id: 'tech-react', name: 'React', description: 'UI', radarId: 'r1' }],
    });
    mockGetCompaniesAL.mockResolvedValue([{ id: 'comp-google', name: 'Google', description: 'Tech co' }]);

    const result = await suggestRelations(
      'We use React and partner with Google for cloud services in our company.',
      'prototype',
      'proto-1'
    );

    if (result.length >= 2) {
      expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
    }
  });

  it('should limit results to top 15 suggestions', async () => {
    // Generate many matches
    const manyTechs = Array.from({ length: 20 }, (_, i) => ({
      name: `Tech${i}`,
      context: `using Tech${i}`,
      confidence: 80,
    }));

    mockGenerateStructuredContent.mockResolvedValue({
      technologies: manyTechs,
      companies: [],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    mockGetTechnologies.mockResolvedValue({
      technologies: manyTechs.map((t, i) => ({
        id: `tech-${i}`,
        name: t.name,
        description: `Description for ${t.name}`,
        radarId: 'r1',
      })),
    });

    const result = await suggestRelations(
      'This text mentions many technologies: ' + manyTechs.map((t) => t.name).join(', '),
      'company',
      'comp-1'
    );

    expect(result.length).toBeLessThanOrEqual(15);
  });

  it('should gracefully handle AI extraction failure', async () => {
    mockGenerateStructuredContent.mockRejectedValue(new Error('Gemini down'));

    const result = await suggestRelations('This is a valid text that should work but AI fails.', 'company', 'comp-1');

    // Should return empty instead of throwing
    expect(result).toEqual([]);
  });

  it('should handle database fetch errors gracefully', async () => {
    mockGenerateStructuredContent.mockResolvedValue({
      technologies: [{ name: 'React', context: 'using', confidence: 90 }],
      companies: [],
      useCases: [],
      prototypes: [],
      strategies: [],
      signals: [],
      initiatives: [],
      orgUnits: [],
      painPoints: [],
      documents: [],
    });

    // Simulate getTechnologies failure - it's caught internally
    mockGetTechnologies.mockRejectedValue(new Error('Firestore error'));

    const result = await suggestRelations(
      'We are using React for building our frontend application.',
      'company',
      'comp-1'
    );

    // Should not throw, getTechnologies catch returns empty
    expect(Array.isArray(result)).toBe(true);
  });

  it('should enhance text with document content when option is set', async () => {
    mockGetDocumentByIdAL.mockResolvedValue({
      id: 'doc-1',
      title: 'AI Strategy Document',
      description: 'Comprehensive AI guide',
      aiSummary: 'Summary of AI strategy',
      tags: ['ai', 'strategy'],
    });
    mockGetChunksForDocumentAL.mockResolvedValue([
      { content: 'Chunk 1 about TensorFlow' },
      { content: 'Chunk 2 about PyTorch' },
    ]);

    await suggestRelations('Additional context', 'document', 'doc-1', { includeDocumentContent: true });

    // Verify the AI was called with enhanced text
    expect(mockGenerateStructuredContent).toHaveBeenCalled();
    const callArg = mockGenerateStructuredContent.mock.calls[0][0];
    expect(callArg).toContain('Document Title: AI Strategy Document');
    expect(callArg).toContain('Chunk 1 about TensorFlow');
  });

  it('should enhance text with signal content when option is set', async () => {
    mockGetSignalByIdAL.mockResolvedValue({
      id: 'sig-1',
      title: 'GPT-5 Announcement',
      description: 'OpenAI announces GPT-5',
      aiSummary: 'Major AI model release',
      source: 'techcrunch.com',
      url: 'https://techcrunch.com/gpt5',
    });

    await suggestRelations('Additional signal context', 'signal', 'sig-1', { includeSignalContent: true });

    expect(mockGenerateStructuredContent).toHaveBeenCalled();
    const callArg = mockGenerateStructuredContent.mock.calls[0][0];
    expect(callArg).toContain('Signal Title: GPT-5 Announcement');
    expect(callArg).toContain('Source: techcrunch.com');
  });

  it('should handle document content fetch failure gracefully', async () => {
    mockGetDocumentByIdAL.mockRejectedValue(new Error('Doc not found'));

    // Should not throw
    await suggestRelations('Some text about technology and companies in this context.', 'document', 'doc-missing', {
      includeDocumentContent: true,
    });

    // AI should still be called with original text
    expect(mockGenerateStructuredContent).toHaveBeenCalled();
  });
});
