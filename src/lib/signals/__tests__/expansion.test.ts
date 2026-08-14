/**
 * Unit Tests for Signal Expansion System (Phase 4.2)
 *
 * Tests signal expansion utilities and prompt generation including:
 * - Expansion eligibility determination
 * - Prompt template generation
 * - Strategy context formatting
 * - Quick vs full expansion prompts
 * - Re-expansion prompts
 * - Edge cases
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import type { Signal } from '../../types';
import { needsExpansion } from '../expansion-utils';
import {
  getExpansionPrompt,
  getQuickExpansionPrompt,
  getReExpansionPrompt,
  type StrategyContext,
} from '../expansion-prompts';

/**
 * Helper to create a mock signal for testing
 */
function createMockSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-123',
    type: 'patent',
    title: 'Novel AI system',
    description: 'Machine learning system for innovation',
    source: 'USPTO Patent Database',
    url: 'https://patents.google.com/patent/US12345678',
    date: Date.now() - 24 * 60 * 60 * 1000,
    relevanceScore: 85,
    alignmentScore: 78,
    alignedStrategies: ['strategy-789'],
    linkedEntities: {
      technologies: ['tech-radar-1:ai-ml'],
      companies: ['company-123'],
      useCases: ['usecase-456'],
    },
    status: 'Detected',
    sentiment: 'positive',
    aiSummary: 'AI system for innovation',
    detectedAt: Date.now() - 24 * 60 * 60 * 1000,
    ...overrides,
  } as Signal;
}

/**
 * Helper to create a mock strategy context
 */
function createMockStrategy(overrides?: Partial<StrategyContext>): StrategyContext {
  return {
    id: 'strategy-123',
    name: 'AI Innovation Strategy',
    description: 'Focus on AI and machine learning technologies',
    mainDirectives: [
      { directive: 'Adopt AI technologies', priority: 'High' },
      { directive: 'Monitor ML trends', priority: 'Medium' },
    ],
    ...overrides,
  };
}

describe('Signal Expansion System', () => {
  describe('needsExpansion()', () => {
    describe('High Relevance Signals', () => {
      it('should expand signals with relevance >= 70', () => {
        const signal = createMockSignal({ relevanceScore: 70 });
        expect(needsExpansion(signal)).toBe(true);
      });

      it('should expand signals with high relevance', () => {
        const signal = createMockSignal({ relevanceScore: 90 });
        expect(needsExpansion(signal)).toBe(true);
      });

      it('should expand signals with relevance = 100', () => {
        const signal = createMockSignal({ relevanceScore: 100 });
        expect(needsExpansion(signal)).toBe(true);
      });
    });

    describe('Medium Relevance Signals', () => {
      it('should expand medium relevance signals with aligned strategies', () => {
        const signal = createMockSignal({
          relevanceScore: 50,
          alignedStrategies: ['strategy-1'],
        });
        expect(needsExpansion(signal)).toBe(true);
      });

      it('should expand signals with relevance 60 and strategies', () => {
        const signal = createMockSignal({
          relevanceScore: 60,
          alignedStrategies: ['strategy-1', 'strategy-2'],
        });
        expect(needsExpansion(signal)).toBe(true);
      });

      it('should NOT expand medium relevance signals without strategies', () => {
        const signal = createMockSignal({
          relevanceScore: 60,
          alignedStrategies: [],
        });
        expect(needsExpansion(signal)).toBe(false);
      });

      it('should NOT expand signals at relevance = 49', () => {
        const signal = createMockSignal({
          relevanceScore: 49,
          alignedStrategies: ['strategy-1'],
        });
        expect(needsExpansion(signal)).toBe(false);
      });
    });

    describe('Low Relevance Signals', () => {
      it('should NOT expand signals with relevance < 50', () => {
        const signal = createMockSignal({ relevanceScore: 30 });
        expect(needsExpansion(signal)).toBe(false);
      });

      it('should NOT expand signals with relevance = 0', () => {
        const signal = createMockSignal({ relevanceScore: 0 });
        expect(needsExpansion(signal)).toBe(false);
      });
    });

    describe('Already Expanded Signals', () => {
      it('should NOT expand signals that already have expandedContent', () => {
        const signal = createMockSignal({
          relevanceScore: 100,
          expandedContent: {
            entityProfile: {
              type: 'technology',
              summary: 'Summary',
              keyFacts: ['Fact 1'],
              recentDevelopments: ['Dev 1'],
            },
            strategicAnalysis: {
              alignedStrategies: [],
              radarImpact: 'Impact',
              competitiveImplications: 'Implications',
              opportunityOrThreat: 'opportunity',
            },
            recommendations: {
              suggestedNextSteps: ['Step 1'],
              questionsForInvestigation: ['Question 1'],
            },
            expandedAt: Date.now(),
            expansionModel: 'gemini-1.5-flash',
            expansionDuration: 1500,
          },
        });
        expect(needsExpansion(signal)).toBe(false);
      });

      it('should NOT expand even high relevance signals with existing expansion', () => {
        const signal = createMockSignal({
          relevanceScore: 95,
          alignedStrategies: ['strategy-1', 'strategy-2'],
          expandedContent: {
            entityProfile: {
              type: 'company',
              summary: 'Company summary',
              keyFacts: [],
              recentDevelopments: [],
            },
            strategicAnalysis: {
              alignedStrategies: [],
              radarImpact: 'Impact',
              competitiveImplications: 'Implications',
              opportunityOrThreat: 'threat',
            },
            recommendations: {
              suggestedNextSteps: [],
              questionsForInvestigation: [],
            },
            expandedAt: Date.now(),
            expansionModel: 'gemini-1.5-flash',
            expansionDuration: 1200,
          },
        });
        expect(needsExpansion(signal)).toBe(false);
      });
    });

    describe('Edge Cases', () => {
      it('should handle undefined relevanceScore', () => {
        const signal = createMockSignal({ relevanceScore: undefined });
        expect(needsExpansion(signal)).toBe(false);
      });

      it('should handle boundary at 69 without strategies', () => {
        const signal = createMockSignal({
          relevanceScore: 69,
          alignedStrategies: [], // No strategies, should not expand
        });
        expect(needsExpansion(signal)).toBe(false);
      });

      it('should handle boundary at 50', () => {
        const signal = createMockSignal({
          relevanceScore: 50,
          alignedStrategies: ['strategy-1'],
        });
        expect(needsExpansion(signal)).toBe(true);
      });
    });
  });

  describe('getExpansionPrompt()', () => {
    describe('Prompt Structure', () => {
      it('should include signal information in prompt', () => {
        const signal = createMockSignal({
          title: 'Test Signal',
          description: 'Test description',
          source: 'Test Source',
          url: 'https://test.com',
          aiSummary: 'Test AI summary',
        });
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('Test Signal');
        expect(prompt).toContain('Test description');
        expect(prompt).toContain('Test Source');
        expect(prompt).toContain('https://test.com');
        expect(prompt).toContain('Test AI summary');
      });

      it('should include signal type and source', () => {
        const signal = createMockSignal({
          type: 'patent',
          source: 'USPTO',
        });
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('patent');
        expect(prompt).toContain('USPTO');
      });

      it('should include metadata if available', () => {
        const signal = createMockSignal({
          metadata: {
            author: 'John Doe',
            keywords: ['AI', 'ML'],
          },
        });
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('John Doe');
        expect(prompt).toContain('AI');
      });

      it('should include expected JSON structure', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('entityProfile');
        expect(prompt).toContain('strategicAnalysis');
        expect(prompt).toContain('recommendations');
        expect(prompt).toContain('relatedItems');
        expect(prompt).toContain('sources');
      });

      it('should include analysis guidelines', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('ANALYSIS GUIDELINES');
        expect(prompt).toContain('Entity Profile');
        expect(prompt).toContain('Strategic Analysis');
        expect(prompt).toContain('Recommendations');
        expect(prompt).toContain('Related Items');
      });
    });

    describe('Strategy Context Formatting', () => {
      it('should include strategy information in prompt', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [
          createMockStrategy({
            name: 'AI Innovation',
            description: 'AI-focused strategy',
          }),
        ];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('AI Innovation');
        expect(prompt).toContain('AI-focused strategy');
      });

      it('should include strategy directives', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [
          createMockStrategy({
            mainDirectives: [
              { directive: 'Adopt AI', priority: 'High' },
              { directive: 'Monitor trends', priority: 'Low' },
            ],
          }),
        ];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('Adopt AI');
        expect(prompt).toContain('High');
        expect(prompt).toContain('Monitor trends');
        expect(prompt).toContain('Low');
      });

      it('should handle multiple strategies', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [
          createMockStrategy({ name: 'Strategy 1' }),
          createMockStrategy({ name: 'Strategy 2' }),
          createMockStrategy({ name: 'Strategy 3' }),
        ];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('Strategy 1');
        expect(prompt).toContain('Strategy 2');
        expect(prompt).toContain('Strategy 3');
      });

      it('should handle empty strategies list', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('No strategic directives available');
        expect(prompt).toContain('general innovation value');
      });

      it('should handle strategies without directives', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [
          createMockStrategy({
            mainDirectives: undefined,
          }),
        ];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('No specific directives');
      });

      it('should handle strategies without descriptions', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [
          createMockStrategy({
            description: undefined,
          }),
        ];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('No description provided');
      });
    });

    describe('Sources Requirement', () => {
      it('should request 3-5 sources in the prompt', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('sources');
        expect(prompt).toContain('3-5');
      });

      it('should specify source fields (title, url, description, date)', () => {
        const signal = createMockSignal();
        const strategies: StrategyContext[] = [];

        const prompt = getExpansionPrompt(signal, strategies);

        expect(prompt).toContain('title');
        expect(prompt).toContain('url');
        expect(prompt).toContain('description');
        expect(prompt).toContain('date');
      });
    });
  });

  describe('getQuickExpansionPrompt()', () => {
    it('should generate a simplified prompt', () => {
      const signal = createMockSignal({
        title: 'Quick Test',
        description: 'Quick description',
        source: 'Source',
      });

      const prompt = getQuickExpansionPrompt(signal);

      expect(prompt).toContain('Quick Test');
      expect(prompt).toContain('Quick description');
      expect(prompt).toContain('Source');
    });

    it('should request simplified output structure', () => {
      const signal = createMockSignal();
      const prompt = getQuickExpansionPrompt(signal);

      expect(prompt).toContain('summary');
      expect(prompt).toContain('keyInsights');
      expect(prompt).toContain('recommendedAction');
      expect(prompt).toContain('opportunityOrThreat');
    });

    it('should request JSON output', () => {
      const signal = createMockSignal();
      const prompt = getQuickExpansionPrompt(signal);

      expect(prompt).toContain('JSON');
    });

    it('should be shorter than full expansion prompt', () => {
      const signal = createMockSignal();
      const strategies: StrategyContext[] = [createMockStrategy()];

      const fullPrompt = getExpansionPrompt(signal, strategies);
      const quickPrompt = getQuickExpansionPrompt(signal);

      expect(quickPrompt.length).toBeLessThan(fullPrompt.length);
    });
  });

  describe('getReExpansionPrompt()', () => {
    it('should include change reason', () => {
      const signal = createMockSignal();
      const previousExpansion = {
        entityProfile: {
          type: 'technology',
          summary: 'Old summary',
          keyFacts: ['Old fact'],
          recentDevelopments: [],
        },
      };
      const changeReason = 'New information discovered';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(prompt).toContain('New information discovered');
    });

    it('should include previous analysis', () => {
      const signal = createMockSignal();
      const previousExpansion = {
        entityProfile: {
          type: 'company',
          summary: 'Previous company summary',
          keyFacts: ['Fact 1', 'Fact 2'],
          recentDevelopments: ['Development 1'],
        },
      };
      const changeReason = 'Update required';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(prompt).toContain('Previous company summary');
      expect(prompt).toContain('Fact 1');
      expect(prompt).toContain('Development 1');
    });

    it('should include new signal data', () => {
      const signal = createMockSignal({
        description: 'Updated description',
        metadata: { newField: 'New value' },
      });
      const previousExpansion = {};
      const changeReason = 'Metadata updated';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(prompt).toContain('Updated description');
      expect(prompt).toContain('newField');
      expect(prompt).toContain('New value');
    });

    it('should request full updated analysis', () => {
      const signal = createMockSignal();
      const previousExpansion = {};
      const changeReason = 'Re-analysis needed';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(prompt).toContain('full expanded JSON structure');
      expect(prompt).toContain('updated information');
    });

    it('should focus on changes', () => {
      const signal = createMockSignal();
      const previousExpansion = {};
      const changeReason = 'Changes detected';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(prompt).toContain('what has changed');
    });
  });

  describe('Edge Cases', () => {
    it('should handle signals with minimal information', () => {
      const signal = createMockSignal({
        title: 'A',
        description: 'B',
        source: 'C',
        url: '',
        aiSummary: '',
      });
      const strategies: StrategyContext[] = [];

      const prompt = getExpansionPrompt(signal, strategies);

      expect(prompt).toContain('A');
      expect(prompt).toContain('B');
      expect(prompt).toContain('C');
    });

    it('should handle null/undefined metadata gracefully', () => {
      const signal = createMockSignal({
        metadata: undefined,
      });
      const strategies: StrategyContext[] = [];

      const prompt = getExpansionPrompt(signal, strategies);

      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should handle very long signal descriptions', () => {
      const longDescription = 'A'.repeat(10000);
      const signal = createMockSignal({
        description: longDescription,
      });
      const strategies: StrategyContext[] = [];

      const prompt = getExpansionPrompt(signal, strategies);

      expect(prompt).toContain(longDescription);
    });

    it('should handle special characters in signal data', () => {
      const signal = createMockSignal({
        title: 'Signal with "quotes" and <brackets>',
        description: 'Description with $pecial ch@r@cter$',
      });
      const strategies: StrategyContext[] = [];

      const prompt = getExpansionPrompt(signal, strategies);

      expect(prompt).toContain('"quotes"');
      expect(prompt).toContain('<brackets>');
      expect(prompt).toContain('$pecial ch@r@cter$');
    });

    it('should handle empty previous expansion in re-expansion', () => {
      const signal = createMockSignal();
      const previousExpansion = {};
      const changeReason = 'Initial expansion';

      const prompt = getReExpansionPrompt(signal, previousExpansion, changeReason);

      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('Initial expansion');
    });
  });
});
