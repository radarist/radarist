/**
 * Unit Tests for Trust Scoring System (Phase 4.2)
 *
 * Tests trust score calculation including:
 * - Overall trust score computation
 * - Source reliability scoring
 * - Data completeness scoring
 * - Corroboration scoring
 * - AI confidence scoring
 * - Factor identification
 * - Edge cases and boundary conditions
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import type { Signal } from '../../types';
import { calculateTrustScore, calculateCorroborationScore, type TrustScoreInput } from '../trust-score';

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
 * Helper to create TrustScoreInput for testing
 */
function createTrustScoreInput(
  signalOverrides?: Partial<Signal>,
  inputOverrides?: Partial<Omit<TrustScoreInput, 'signal'>>
): TrustScoreInput {
  return {
    signal: createMockSignal(signalOverrides),
    ...inputOverrides,
  };
}

describe('Trust Score System', () => {
  describe('calculateTrustScore()', () => {
    describe('Overall Trust Score Calculation', () => {
      it('should calculate weighted average trust score', () => {
        const input = createTrustScoreInput({
          source: 'USPTO Patent Database', // High reliability source
          description: 'Detailed description with comprehensive information',
          metadata: {
            author: 'John Doe',
            verifiedSource: true,
          },
          relevanceScore: 90,
          alignmentScore: 85,
        });

        const trustScore = calculateTrustScore(input);

        expect(trustScore.overall).toBeGreaterThan(0);
        expect(trustScore.overall).toBeLessThanOrEqual(100);
        expect(trustScore.breakdown.sourceReliability).toBeDefined();
        expect(trustScore.breakdown.dataCompleteness).toBeDefined();
        expect(trustScore.breakdown.corroboration).toBeDefined();
        expect(trustScore.breakdown.aiConfidence).toBeDefined();
      });

      it('should use correct weights (30% source, 25% completeness, 25% corroboration, 20% AI)', () => {
        const input = createTrustScoreInput({
          source: 'IEEE Journal', // High reliability
          description: 'Test',
          relevanceScore: 100,
          alignmentScore: 100,
        });

        const trustScore = calculateTrustScore(input);

        // Verify weighted calculation
        const expectedScore =
          trustScore.breakdown.sourceReliability * 0.3 +
          trustScore.breakdown.dataCompleteness * 0.25 +
          trustScore.breakdown.corroboration * 0.25 +
          trustScore.breakdown.aiConfidence * 0.2;

        expect(Math.round(trustScore.overall)).toBe(Math.round(expectedScore));
      });
    });

    describe('Source Reliability Scoring', () => {
      it('should score academic sources highly', () => {
        const sources = ['Nature', 'Science', 'IEEE', 'ACM'];

        sources.forEach((source) => {
          const input = createTrustScoreInput({ source });
          const trustScore = calculateTrustScore(input);
          expect(trustScore.breakdown.sourceReliability).toBeGreaterThanOrEqual(85);
        });
      });

      it('should score patent databases at 85+', () => {
        const sources = ['USPTO Patent Database', 'Google Patents', 'Patent Office'];

        sources.forEach((source) => {
          const input = createTrustScoreInput({ source });
          const trustScore = calculateTrustScore(input);
          expect(trustScore.breakdown.sourceReliability).toBeGreaterThanOrEqual(85);
        });
      });

      it('should score established news outlets at 80+', () => {
        const sources = ['TechCrunch', 'The Verge', 'Wired', 'MIT Technology Review'];

        sources.forEach((source) => {
          const input = createTrustScoreInput({ source });
          const trustScore = calculateTrustScore(input);
          expect(trustScore.breakdown.sourceReliability).toBeGreaterThanOrEqual(80);
        });
      });

      it('should score trends lower than established sources', () => {
        const input = createTrustScoreInput({ source: 'Google Trends' });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.sourceReliability).toBeLessThan(70);
      });

      it('should score unknown sources at type-based fallback level', () => {
        // Unknown source falls through to type-based scoring; 'trend' type scores 60
        const input = createTrustScoreInput({ source: 'Unknown Random Source', type: 'trend' });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.sourceReliability).toBe(60);
      });
    });

    describe('Data Completeness Scoring', () => {
      it('should score well for complete data', () => {
        const input = createTrustScoreInput({
          title: 'Complete Title',
          description: 'A detailed description with sufficient information',
          url: 'https://example.com',
          date: Date.now(),
          source: 'Source',
          metadata: {
            author: 'John Doe',
            additionalInfo: 'Extra data',
          },
        });

        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.dataCompleteness).toBeGreaterThanOrEqual(50);
      });

      it('should penalize missing description', () => {
        const input = createTrustScoreInput({
          description: '',
        });

        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.dataCompleteness).toBeLessThan(100);
      });

      it('should penalize missing URL', () => {
        const input = createTrustScoreInput({
          url: '',
        });

        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.dataCompleteness).toBeLessThan(100);
      });

      it('should reward metadata presence', () => {
        const inputWithMetadata = createTrustScoreInput({
          metadata: {
            author: 'John Doe',
            keywords: ['AI', 'ML'],
          },
        });

        const inputWithoutMetadata = createTrustScoreInput({
          metadata: undefined,
        });

        const scoreWith = calculateTrustScore(inputWithMetadata);
        const scoreWithout = calculateTrustScore(inputWithoutMetadata);

        expect(scoreWith.breakdown.dataCompleteness).toBeGreaterThanOrEqual(scoreWithout.breakdown.dataCompleteness);
      });
    });

    describe('Corroboration Scoring', () => {
      it('should score higher with corroboration', () => {
        const inputWithCorroboration = createTrustScoreInput(
          {},
          { hasCorroboration: true, corroboratingSourceCount: 3 }
        );

        const inputWithoutCorroboration = createTrustScoreInput({}, { hasCorroboration: false });

        const scoreWith = calculateTrustScore(inputWithCorroboration);
        const scoreWithout = calculateTrustScore(inputWithoutCorroboration);

        expect(scoreWith.breakdown.corroboration).toBeGreaterThan(scoreWithout.breakdown.corroboration);
      });

      it('should give default score without corroboration', () => {
        const input = createTrustScoreInput({}, { hasCorroboration: false });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.corroboration).toBe(40);
      });

      it('should increase score with more corroborating sources', () => {
        const input2Sources = createTrustScoreInput({}, { hasCorroboration: true, corroboratingSourceCount: 2 });
        const input4Sources = createTrustScoreInput({}, { hasCorroboration: true, corroboratingSourceCount: 4 });

        const score2 = calculateTrustScore(input2Sources);
        const score4 = calculateTrustScore(input4Sources);

        expect(score4.breakdown.corroboration).toBeGreaterThan(score2.breakdown.corroboration);
      });

      // C3: confidence-calibration.ts's corroborationNudge derives its
      // 0/0/+5/+10/+15 bump for 0/1/2/3/4+ distinct sources from these SAME
      // frozen tiers — pin them so a future change here can't silently drift
      // the graph-side nudge away from the display-side trust score.
      it('exports calculateCorroborationScore with frozen tiers 40/70/85/95', () => {
        expect(calculateCorroborationScore(false, 0)).toBe(40);
        expect(calculateCorroborationScore(true, 1)).toBe(40);
        expect(calculateCorroborationScore(true, 2)).toBe(70);
        expect(calculateCorroborationScore(true, 3)).toBe(85);
        expect(calculateCorroborationScore(true, 4)).toBe(95);
        expect(calculateCorroborationScore(true, 10)).toBe(95);
      });
    });

    describe('AI Confidence Scoring', () => {
      it('should use provided AI confidence', () => {
        const input = createTrustScoreInput({}, { aiConfidence: 0.9 });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.aiConfidence).toBe(90);
      });

      it('should default to 70% AI confidence when not provided', () => {
        const input = createTrustScoreInput({});
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.aiConfidence).toBe(70);
      });

      it('should handle low AI confidence', () => {
        const input = createTrustScoreInput({}, { aiConfidence: 0.3 });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.breakdown.aiConfidence).toBe(30);
      });
    });

    describe('Trust Factors', () => {
      it('should return array of factors', () => {
        const input = createTrustScoreInput({});
        const trustScore = calculateTrustScore(input);

        expect(Array.isArray(trustScore.factors)).toBe(true);
        expect(trustScore.factors.length).toBeGreaterThan(0);
      });

      it('should identify high-quality source factor', () => {
        const input = createTrustScoreInput({ source: 'Nature' });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.factors.some((f) => f.toLowerCase().includes('quality'))).toBe(true);
      });

      it('should identify corroboration status', () => {
        const inputWith = createTrustScoreInput({}, { hasCorroboration: true, corroboratingSourceCount: 2 });
        const inputWithout = createTrustScoreInput({}, { hasCorroboration: false });

        const scoreWith = calculateTrustScore(inputWith);
        const scoreWithout = calculateTrustScore(inputWithout);

        expect(scoreWith.factors.some((f) => f.toLowerCase().includes('corroboration'))).toBe(true);
        expect(scoreWithout.factors.some((f) => f.toLowerCase().includes('single'))).toBe(true);
      });

      it('should identify AI confidence level', () => {
        const input = createTrustScoreInput({}, { aiConfidence: 0.9 });
        const trustScore = calculateTrustScore(input);
        expect(trustScore.factors.some((f) => f.toLowerCase().includes('ai'))).toBe(true);
      });
    });

    describe('Edge Cases', () => {
      it('should handle signals with minimal fields', () => {
        const input = createTrustScoreInput({
          description: '',
          url: '',
          date: 0,
          source: '',
          type: 'trend', // 'trend' type gives sourceReliability of 60
          metadata: undefined,
          relevanceScore: undefined,
          alignmentScore: undefined,
        });

        const trustScore = calculateTrustScore(input);

        expect(trustScore.overall).toBeGreaterThan(0);
        expect(trustScore.overall).toBeLessThanOrEqual(100);
        expect(trustScore.breakdown.sourceReliability).toBe(60); // trend type fallback
        expect(trustScore.breakdown.dataCompleteness).toBeLessThan(50);
        expect(trustScore.breakdown.corroboration).toBe(40);
      });

      it('should handle signals with maximum scores', () => {
        const input = createTrustScoreInput(
          {
            source: 'Nature',
            description: 'Very detailed and comprehensive description with lots of information',
            url: 'https://example.com',
            date: Date.now(),
            metadata: {
              author: 'John Doe',
              verifiedSource: true,
              keywords: ['AI', 'ML', 'Innovation'],
            },
            relevanceScore: 100,
            alignmentScore: 100,
          },
          { aiConfidence: 1.0, hasCorroboration: true, corroboratingSourceCount: 5 }
        );

        const trustScore = calculateTrustScore(input);

        expect(trustScore.overall).toBeGreaterThan(80);
        expect(trustScore.breakdown.corroboration).toBeGreaterThan(80);
        expect(trustScore.breakdown.aiConfidence).toBe(100);
      });

      it('should always return valid breakdown object', () => {
        const input = createTrustScoreInput({});
        const trustScore = calculateTrustScore(input);

        expect(trustScore.breakdown).toBeDefined();
        expect(typeof trustScore.breakdown.sourceReliability).toBe('number');
        expect(typeof trustScore.breakdown.dataCompleteness).toBe('number');
        expect(typeof trustScore.breakdown.corroboration).toBe('number');
        expect(typeof trustScore.breakdown.aiConfidence).toBe('number');
      });

      it('should always return an array for factors', () => {
        const input = createTrustScoreInput({});
        const trustScore = calculateTrustScore(input);

        expect(Array.isArray(trustScore.factors)).toBe(true);
      });

      it('should round overall score to integer', () => {
        const input = createTrustScoreInput({
          relevanceScore: 87,
          alignmentScore: 84,
        });

        const trustScore = calculateTrustScore(input);

        expect(Number.isInteger(trustScore.overall)).toBe(true);
      });
    });
  });
});
