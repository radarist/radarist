/**
 * Tests for lib/pipeline/alignment-calculation.ts
 */

// Mock dependencies before imports
// Round 4/5 migration: source now reads from admin twins, not client services.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));

jest.mock('@/lib/strategies-admin', () => ({
  adminGetStrategies: jest.fn(),
}));

jest.mock('@/lib/signals-admin', () => ({
  adminGetSignalsByStatus: jest.fn(),
  adminUpdateSignal: jest.fn(),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  evaluateStrategyAlignmentWithAI: jest.fn(),
  evaluateSignalWithAI: jest.fn(),
}));

import type { Signal, Strategy } from '@/lib/types';

const { adminGetStrategies: getStrategies } = jest.requireMock('@/lib/strategies-admin');
const { adminGetSignalsByStatus: getSignalsByStatus, adminUpdateSignal: updateSignal } =
  jest.requireMock('@/lib/signals-admin');
const { evaluateStrategyAlignmentWithAI } = jest.requireMock('@/lib/ai/signal-evaluation');

const {
  calculateSignalAlignment,
  recalculateAlignmentScores,
  getSignificantChanges,
  getImprovedSignals,
  getDeclinedSignals,
  getAlignmentStats,
} = require('../../pipeline/alignment-calculation');

// ============================================================================
// TEST DATA
// ============================================================================

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    title: 'AI in Manufacturing',
    description: 'Using AI for quality control',
    aiSummary: 'AI-powered quality inspection for manufacturing',
    status: 'Validated',
    alignmentScore: 50,
    expandedContent: {
      entityProfile: { summary: 'Manufacturing AI solutions' },
    },
    ...overrides,
  } as Signal;
}

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 'strat-1',
    name: 'AI Innovation Strategy',
    description: 'Focus on AI-powered automation',
    mainDirectives: [{ directive: 'Automate manufacturing processes' }, { directive: 'Improve quality control' }],
    ...overrides,
  } as Strategy;
}

// ============================================================================
// TESTS
// ============================================================================

describe('alignment-calculation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // calculateSignalAlignment
  // ==========================================================================

  describe('calculateSignalAlignment', () => {
    it('should return current score when no strategies', async () => {
      const signal = makeSignal({ alignmentScore: 75 });
      const result = await calculateSignalAlignment(signal, []);

      expect(result.score).toBe(75);
      expect(result.strategyScores).toEqual([]);
      expect(result.bestStrategy).toBeUndefined();
    });

    it('should evaluate with AI when useAI is true', async () => {
      const signal = makeSignal();
      const strategy = makeStrategy();
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'AI Innovation Strategy',
        score: 85,
      });

      const result = await calculateSignalAlignment(signal, [strategy], true);

      expect(evaluateStrategyAlignmentWithAI).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'AI in Manufacturing' }),
        strategy
      );
      expect(result.score).toBe(85);
      expect(result.bestStrategy).toEqual({
        id: 'strat-1',
        name: 'AI Innovation Strategy',
        score: 85,
      });
      expect(result.strategyScores).toHaveLength(1);
    });

    it('should pick the best strategy from multiple', async () => {
      const signal = makeSignal();
      const strategies = [
        makeStrategy({ id: 'strat-1', name: 'Low Match' }),
        makeStrategy({ id: 'strat-2', name: 'High Match' }),
      ];

      evaluateStrategyAlignmentWithAI
        .mockResolvedValueOnce({ strategyId: 'strat-1', strategyName: 'Low Match', score: 30 })
        .mockResolvedValueOnce({ strategyId: 'strat-2', strategyName: 'High Match', score: 90 });

      const result = await calculateSignalAlignment(signal, strategies, true);

      expect(result.score).toBe(90);
      expect(result.bestStrategy!.id).toBe('strat-2');
      expect(result.strategyScores).toHaveLength(2);
    });

    it('should use fallback score 50 when AI fails for a strategy', async () => {
      const signal = makeSignal();
      const strategy = makeStrategy();
      evaluateStrategyAlignmentWithAI.mockRejectedValue(new Error('AI failed'));

      const result = await calculateSignalAlignment(signal, [strategy], true);

      expect(result.score).toBe(50);
      expect(result.strategyScores[0].score).toBe(50);
    });

    it('should use keyword-based scoring when useAI is false', async () => {
      const signal = makeSignal({
        title: 'AI automation platform',
        aiSummary: 'Automate manufacturing quality control processes',
      });
      const strategy = makeStrategy({
        name: 'AI Innovation',
        description: 'Focus on automation',
        mainDirectives: [
          { id: 'd1', directive: 'Automate manufacturing processes', category: 'Efficiency' as const, priority: 1 },
        ],
      });

      const result = await calculateSignalAlignment(signal, [strategy], false);

      expect(evaluateStrategyAlignmentWithAI).not.toHaveBeenCalled();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.strategyScores).toHaveLength(1);
    });

    it('should handle signal with only description (no aiSummary)', async () => {
      const signal = makeSignal({
        aiSummary: undefined,
        description: 'Automation tools for factories',
        expandedContent: undefined,
      });
      const strategy = makeStrategy();

      const result = await calculateSignalAlignment(signal, [strategy], false);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle signal with expandedContent summary fallback', async () => {
      const signal = makeSignal({
        aiSummary: undefined,
        description: undefined,
        expandedContent: {
          entityProfile: {
            type: 'technology' as const,
            summary: 'AI manufacturing automation',
            keyFacts: [],
            recentDevelopments: [],
          },
          expandedAt: Date.now(),
          expansionModel: 'gemini',
          expansionDuration: 0,
        },
      });
      const strategy = makeStrategy();

      const result = await calculateSignalAlignment(signal, [strategy], false);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('keyword scoring returns 50 when strategy has no meaningful keywords', async () => {
      const signal = makeSignal();
      const strategy = makeStrategy({
        name: 'a',
        description: 'the',
        mainDirectives: [],
      });

      const result = await calculateSignalAlignment(signal, [strategy], false);

      expect(result.score).toBe(50);
    });

    it('keyword scoring filters stop words', async () => {
      const signal = makeSignal({ title: 'blockchain technology', aiSummary: 'blockchain decentralized' });
      const strategy = makeStrategy({
        name: 'the blockchain innovation strategy',
        description: 'focus on blockchain and decentralized systems',
        mainDirectives: [
          { id: 'd2', directive: 'use blockchain for transparency', category: 'Innovation' as const, priority: 2 },
        ],
      });

      const result = await calculateSignalAlignment(signal, [strategy], false);

      // Should match on 'blockchain', 'decentralized', etc. but not stop words
      expect(result.score).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // recalculateAlignmentScores
  // ==========================================================================

  describe('recalculateAlignmentScores', () => {
    it('should return early when no strategies found', async () => {
      getStrategies.mockResolvedValue([]);

      const result = await recalculateAlignmentScores();

      expect(result.totalSignals).toBe(0);
      expect(result.processedSignals).toBe(0);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should process signals and update when score change exceeds threshold', async () => {
      const strategy = makeStrategy();
      const signal = makeSignal({ alignmentScore: 40 });

      getStrategies.mockResolvedValue([strategy]);
      getSignalsByStatus.mockResolvedValue([signal]);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'AI Innovation Strategy',
        score: 80,
      });
      updateSignal.mockResolvedValue(undefined);

      const result = await recalculateAlignmentScores({
        signalStatuses: ['Validated'],
        minScoreChange: 5,
        useAI: true,
      });

      expect(result.totalSignals).toBe(1);
      expect(result.processedSignals).toBe(1);
      expect(result.updatedSignals).toBe(1);
      expect(result.skippedSignals).toBe(0);
      expect(updateSignal).toHaveBeenCalledWith('sig-1', { alignmentScore: 80 });
    });

    it('should skip signals when score change is below threshold', async () => {
      const strategy = makeStrategy();
      const signal = makeSignal({ alignmentScore: 48 });

      getStrategies.mockResolvedValue([strategy]);
      getSignalsByStatus.mockResolvedValue([signal]);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'AI Innovation Strategy',
        score: 50,
      });

      const result = await recalculateAlignmentScores({
        signalStatuses: ['Validated'],
        minScoreChange: 5,
      });

      expect(result.updatedSignals).toBe(0);
      expect(result.skippedSignals).toBe(1);
      expect(updateSignal).not.toHaveBeenCalled();
    });

    it('should not call updateSignal in dryRun mode', async () => {
      const strategy = makeStrategy();
      const signal = makeSignal({ alignmentScore: 20 });

      getStrategies.mockResolvedValue([strategy]);
      getSignalsByStatus.mockResolvedValue([signal]);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'Strategy',
        score: 80,
      });

      const result = await recalculateAlignmentScores({ dryRun: true, signalStatuses: ['Validated'] });

      expect(result.updatedSignals).toBe(1);
      expect(updateSignal).not.toHaveBeenCalled();
    });

    it('should respect maxSignals limit', async () => {
      const strategy = makeStrategy();
      const signals = [
        makeSignal({ id: 'sig-1', alignmentScore: 30 }),
        makeSignal({ id: 'sig-2', alignmentScore: 30 }),
        makeSignal({ id: 'sig-3', alignmentScore: 30 }),
      ];

      getStrategies.mockResolvedValue([strategy]);
      getSignalsByStatus.mockResolvedValue(signals);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'Strategy',
        score: 80,
      });
      updateSignal.mockResolvedValue(undefined);

      const result = await recalculateAlignmentScores({
        signalStatuses: ['Validated'],
        maxSignals: 2,
      });

      expect(result.totalSignals).toBe(3);
      expect(result.processedSignals).toBe(2);
    });

    it('should handle AI failures gracefully with fallback score', async () => {
      const strategy = makeStrategy();
      const signals = [
        makeSignal({ id: 'sig-1', alignmentScore: 30 }),
        makeSignal({ id: 'sig-2', alignmentScore: 30 }),
      ];

      getStrategies.mockResolvedValue([strategy]);
      getSignalsByStatus.mockResolvedValue(signals);
      // First signal AI fails -> calculateSignalAlignment catches and returns fallback 50
      // Second signal AI succeeds -> returns 80
      evaluateStrategyAlignmentWithAI
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({ strategyId: 'strat-1', strategyName: 'Strategy', score: 80 });
      updateSignal.mockResolvedValue(undefined);

      const result = await recalculateAlignmentScores({
        signalStatuses: ['Validated'],
        minScoreChange: 5,
      });

      // AI error is caught inside calculateSignalAlignment, not propagated to outer catch
      // sig-1 gets fallback score 50 (change=20 from 30, > threshold 5, so updated)
      // sig-2 gets score 80 (change=50 from 30, > threshold 5, so updated)
      expect(result.errors).toHaveLength(0);
      expect(result.processedSignals).toBe(2);
      expect(result.updatedSignals).toBe(2);
    });

    it('should load signals from multiple statuses', async () => {
      getStrategies.mockResolvedValue([makeStrategy()]);
      getSignalsByStatus
        .mockResolvedValueOnce([makeSignal({ id: 'v1' })])
        .mockResolvedValueOnce([makeSignal({ id: 'a1' })]);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'Strategy',
        score: 80,
      });
      updateSignal.mockResolvedValue(undefined);

      const result = await recalculateAlignmentScores({
        signalStatuses: ['Validated', 'Approved'],
      });

      expect(getSignalsByStatus).toHaveBeenCalledTimes(2);
      expect(result.totalSignals).toBe(2);
    });

    it('should calculate average old and new scores', async () => {
      getStrategies.mockResolvedValue([makeStrategy()]);
      getSignalsByStatus.mockResolvedValue([
        makeSignal({ id: 'sig-1', alignmentScore: 40 }),
        makeSignal({ id: 'sig-2', alignmentScore: 60 }),
      ]);
      evaluateStrategyAlignmentWithAI.mockResolvedValue({
        strategyId: 'strat-1',
        strategyName: 'Strategy',
        score: 80,
      });
      updateSignal.mockResolvedValue(undefined);

      const result = await recalculateAlignmentScores({ signalStatuses: ['Validated'] });

      expect(result.averageOldScore).toBe(50); // (40+60)/2
      expect(result.averageNewScore).toBe(80); // (80+80)/2
    });

    it('should use default options when none provided', async () => {
      getStrategies.mockResolvedValue([makeStrategy()]);
      getSignalsByStatus.mockResolvedValue([]);

      const result = await recalculateAlignmentScores();

      // Default statuses are ['Validated', 'Approved']
      expect(getSignalsByStatus).toHaveBeenCalledTimes(2);
      expect(result.totalSignals).toBe(0);
    });
  });

  // ==========================================================================
  // Utility functions
  // ==========================================================================

  describe('getSignificantChanges', () => {
    it('should filter changes by threshold', () => {
      const result = {
        scoreChanges: [
          { signalId: '1', change: 25 },
          { signalId: '2', change: -30 },
          { signalId: '3', change: 5 },
          { signalId: '4', change: -10 },
        ],
      } as any;

      const significant = getSignificantChanges(result, 20);

      expect(significant).toHaveLength(2);
      expect(significant[0].signalId).toBe('1');
      expect(significant[1].signalId).toBe('2');
    });

    it('should use default threshold of 20', () => {
      const result = {
        scoreChanges: [
          { signalId: '1', change: 21 },
          { signalId: '2', change: 19 },
        ],
      } as any;

      const significant = getSignificantChanges(result);

      expect(significant).toHaveLength(1);
    });
  });

  describe('getImprovedSignals', () => {
    it('should return only positive changes', () => {
      const result = {
        scoreChanges: [
          { signalId: '1', change: 10 },
          { signalId: '2', change: -5 },
          { signalId: '3', change: 0 },
          { signalId: '4', change: 20 },
        ],
      } as any;

      const improved = getImprovedSignals(result);

      expect(improved).toHaveLength(2);
      expect(improved.map((c: any) => c.signalId)).toEqual(['1', '4']);
    });
  });

  describe('getDeclinedSignals', () => {
    it('should return only negative changes', () => {
      const result = {
        scoreChanges: [
          { signalId: '1', change: 10 },
          { signalId: '2', change: -5 },
          { signalId: '3', change: 0 },
          { signalId: '4', change: -15 },
        ],
      } as any;

      const declined = getDeclinedSignals(result);

      expect(declined).toHaveLength(2);
      expect(declined.map((c: any) => c.signalId)).toEqual(['2', '4']);
    });
  });

  describe('getAlignmentStats', () => {
    it('should compute all stats correctly', () => {
      const result = {
        scoreChanges: [{ change: 30 }, { change: -20 }, { change: 0 }, { change: 10 }, { change: -5 }],
      } as any;

      const stats = getAlignmentStats(result);

      expect(stats.improved).toBe(2);
      expect(stats.declined).toBe(2);
      expect(stats.unchanged).toBe(1);
      expect(stats.avgChange).toBe(3); // (30-20+0+10-5)/5 = 15/5 = 3
      expect(stats.maxImprovement).toBe(30);
      expect(stats.maxDecline).toBe(-20);
    });

    it('should handle empty changes', () => {
      const result = { scoreChanges: [] } as any;

      const stats = getAlignmentStats(result);

      expect(stats.improved).toBe(0);
      expect(stats.declined).toBe(0);
      expect(stats.unchanged).toBe(0);
      expect(stats.avgChange).toBe(0);
      expect(stats.maxImprovement).toBe(0);
      expect(stats.maxDecline).toBe(0);
    });

    it('should handle all improvements', () => {
      const result = {
        scoreChanges: [{ change: 10 }, { change: 20 }, { change: 5 }],
      } as any;

      const stats = getAlignmentStats(result);

      expect(stats.improved).toBe(3);
      expect(stats.declined).toBe(0);
      expect(stats.unchanged).toBe(0);
      expect(stats.maxImprovement).toBe(20);
      expect(stats.maxDecline).toBe(0);
    });

    it('should handle all declines', () => {
      const result = {
        scoreChanges: [{ change: -10 }, { change: -20 }, { change: -5 }],
      } as any;

      const stats = getAlignmentStats(result);

      expect(stats.improved).toBe(0);
      expect(stats.declined).toBe(3);
      expect(stats.maxDecline).toBe(-20);
    });
  });
});
