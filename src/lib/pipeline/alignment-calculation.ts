/**
 * @file lib/pipeline/alignment-calculation.ts
 * @description Batch alignment score recalculation service
 *
 * Recalculates alignment scores for signals against current strategies.
 * Used by the daily pipeline to ensure alignment scores stay up-to-date
 * as strategies change.
 *
 * **Algorithm:**
 * 1. Load all active strategies
 * 2. For each signal, evaluate against all strategies
 * 3. Store the highest alignment score
 * 4. Track score changes for analytics
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { createLogger } from '@/lib/logger';
import { adminGetStrategies } from '@/lib/strategies-admin';

const log = createLogger('pipeline/alignment-calculation');
import { adminGetSignalsByStatus, adminUpdateSignal } from '@/lib/signals-admin';
import { evaluateStrategyAlignmentWithAI } from '@/lib/ai/signal-evaluation';
import type { Signal, Strategy } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface AlignmentScoreChange {
  signalId: string;
  signalTitle: string;
  oldScore: number;
  newScore: number;
  change: number;
  bestStrategy?: { id: string; name: string; score: number };
}

export interface AlignmentRecalculationResult {
  totalSignals: number;
  processedSignals: number;
  updatedSignals: number;
  skippedSignals: number;
  errors: Array<{ signalId: string; error: string }>;
  scoreChanges: AlignmentScoreChange[];
  processingTimeMs: number;
  averageOldScore: number;
  averageNewScore: number;
}

export interface AlignmentCalculationOptions {
  signalStatuses?: Signal['status'][];
  maxSignals?: number;
  minScoreChange?: number;
  useAI?: boolean;
  dryRun?: boolean;
}

// ============================================================================
// ALIGNMENT CALCULATION
// ============================================================================

/**
 * Calculate alignment score for a signal against all strategies.
 *
 * Returns the highest alignment score and the matching strategy.
 */
export async function calculateSignalAlignment(
  signal: Signal,
  strategies: Strategy[],
  useAI: boolean = true
): Promise<{
  score: number;
  bestStrategy?: { id: string; name: string; score: number };
  strategyScores: Array<{ strategyId: string; strategyName: string; score: number }>;
}> {
  if (strategies.length === 0) {
    return {
      score: signal.alignmentScore,
      strategyScores: [],
    };
  }

  const strategyScores: Array<{ strategyId: string; strategyName: string; score: number }> = [];

  if (useAI) {
    // Evaluate against each strategy using AI
    for (const strategy of strategies) {
      try {
        const result = await evaluateStrategyAlignmentWithAI(
          {
            title: signal.title,
            description: signal.aiSummary || signal.description || signal.expandedContent?.entityProfile?.summary || '',
          },
          strategy
        );

        strategyScores.push({
          strategyId: result.strategyId,
          strategyName: result.strategyName,
          score: result.score,
        });
      } catch (error) {
        log.error(
          `Failed to evaluate signal ${signal.id} against strategy ${strategy.id}`,
          error instanceof Error ? error : undefined
        );
        // Use a fallback score
        strategyScores.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          score: 50,
        });
      }
    }
  } else {
    // Simple keyword-based scoring (faster, no AI)
    for (const strategy of strategies) {
      const score = calculateKeywordAlignment(signal, strategy);
      strategyScores.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        score,
      });
    }
  }

  // Find best strategy
  const bestStrategy = strategyScores.reduce(
    (best, current) => (current.score > best.score ? current : best),
    strategyScores[0]
  );

  return {
    score: bestStrategy.score,
    bestStrategy: {
      id: bestStrategy.strategyId,
      name: bestStrategy.strategyName,
      score: bestStrategy.score,
    },
    strategyScores,
  };
}

/**
 * Simple keyword-based alignment calculation.
 * Faster than AI but less accurate.
 */
function calculateKeywordAlignment(signal: Signal, strategy: Strategy): number {
  const signalText = `${signal.title} ${signal.aiSummary || signal.description || ''} ${
    signal.expandedContent?.entityProfile?.summary || ''
  }`.toLowerCase();

  // Extract keywords from strategy
  const strategyKeywords: string[] = [];

  // From name and description
  if (strategy.name) {
    strategyKeywords.push(...strategy.name.toLowerCase().split(/\s+/));
  }
  if (strategy.description) {
    strategyKeywords.push(...strategy.description.toLowerCase().split(/\s+/));
  }

  // From directives
  if (strategy.mainDirectives) {
    for (const directive of strategy.mainDirectives) {
      if (directive.directive) {
        strategyKeywords.push(...directive.directive.toLowerCase().split(/\s+/));
      }
    }
  }

  // Filter out common words
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'must',
    'shall',
    'can',
    'need',
    'it',
    'its',
    'this',
    'that',
    'these',
    'those',
    'we',
    'our',
    'us',
  ]);

  const uniqueKeywords = [...new Set(strategyKeywords)].filter((k) => k.length > 2 && !stopWords.has(k));

  if (uniqueKeywords.length === 0) return 50;

  // Count matches
  let matches = 0;
  for (const keyword of uniqueKeywords) {
    if (signalText.includes(keyword)) {
      matches++;
    }
  }

  // Calculate score (0-100)
  const matchRatio = matches / uniqueKeywords.length;
  return Math.round(matchRatio * 100);
}

// ============================================================================
// BATCH RECALCULATION
// ============================================================================

/**
 * Recalculate alignment scores for all signals.
 *
 * @example
 * ```typescript
 * const result = await recalculateAlignmentScores({
 *   signalStatuses: ['Validated', 'Triage'],
 *   maxSignals: 100,
 *   minScoreChange: 10,
 *   useAI: true,
 * });
 * console.log(`Updated ${result.updatedSignals} signals`);
 * ```
 */
export async function recalculateAlignmentScores(
  options: AlignmentCalculationOptions = {}
): Promise<AlignmentRecalculationResult> {
  const startTime = Date.now();
  const {
    signalStatuses = ['Validated', 'Approved'],
    maxSignals = 100,
    minScoreChange = 5,
    useAI = true,
    dryRun = false,
  } = options;

  const result: AlignmentRecalculationResult = {
    totalSignals: 0,
    processedSignals: 0,
    updatedSignals: 0,
    skippedSignals: 0,
    errors: [],
    scoreChanges: [],
    processingTimeMs: 0,
    averageOldScore: 0,
    averageNewScore: 0,
  };

  // Load strategies
  const strategies = await adminGetStrategies();
  const activeStrategies = strategies;

  if (activeStrategies.length === 0) {
    log.warn('No active strategies found, skipping recalculation');
    result.processingTimeMs = Date.now() - startTime;
    return result;
  }

  log.info('Loaded active strategies', { count: activeStrategies.length });

  // Load signals
  const allSignals: Signal[] = [];
  for (const status of signalStatuses) {
    const signals = await adminGetSignalsByStatus(status);
    allSignals.push(...signals);
  }

  result.totalSignals = allSignals.length;

  // Limit signals
  const signalsToProcess = allSignals.slice(0, maxSignals);
  log.info('Processing signals', { processing: signalsToProcess.length, total: allSignals.length });

  let totalOldScore = 0;
  let totalNewScore = 0;

  // Process signals with rate limiting
  for (let i = 0; i < signalsToProcess.length; i++) {
    const signal = signalsToProcess[i];

    try {
      const oldScore = signal.alignmentScore;
      totalOldScore += oldScore;

      // Calculate new alignment
      const alignment = await calculateSignalAlignment(signal, activeStrategies, useAI);
      const newScore = alignment.score;
      totalNewScore += newScore;

      result.processedSignals++;

      const scoreChange = newScore - oldScore;
      const absChange = Math.abs(scoreChange);

      // Record score change
      result.scoreChanges.push({
        signalId: signal.id,
        signalTitle: signal.title,
        oldScore,
        newScore,
        change: scoreChange,
        bestStrategy: alignment.bestStrategy,
      });

      // Update if change is significant
      if (absChange >= minScoreChange) {
        if (!dryRun) {
          await adminUpdateSignal(signal.id, {
            alignmentScore: newScore,
          });
        }
        result.updatedSignals++;
      } else {
        result.skippedSignals++;
      }

      // Rate limit: small delay between AI calls
      if (useAI && i < signalsToProcess.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      result.errors.push({ signalId: signal.id, error: err });
      log.error('Error processing signal', error, { signalId: signal.id });
    }
  }

  // Calculate averages
  if (result.processedSignals > 0) {
    result.averageOldScore = Math.round(totalOldScore / result.processedSignals);
    result.averageNewScore = Math.round(totalNewScore / result.processedSignals);
  }

  result.processingTimeMs = Date.now() - startTime;

  log.info('Complete', {
    updated: result.updatedSignals,
    skipped: result.skippedSignals,
    errors: result.errors.length,
    processingTimeMs: result.processingTimeMs,
  });

  return result;
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Get signals with significant score changes.
 */
export function getSignificantChanges(
  result: AlignmentRecalculationResult,
  threshold: number = 20
): AlignmentScoreChange[] {
  return result.scoreChanges.filter((c) => Math.abs(c.change) >= threshold);
}

/**
 * Get signals whose alignment improved.
 */
export function getImprovedSignals(result: AlignmentRecalculationResult): AlignmentScoreChange[] {
  return result.scoreChanges.filter((c) => c.change > 0);
}

/**
 * Get signals whose alignment decreased.
 */
export function getDeclinedSignals(result: AlignmentRecalculationResult): AlignmentScoreChange[] {
  return result.scoreChanges.filter((c) => c.change < 0);
}

/**
 * Get alignment calculation statistics.
 */
export function getAlignmentStats(result: AlignmentRecalculationResult): {
  improved: number;
  declined: number;
  unchanged: number;
  avgChange: number;
  maxImprovement: number;
  maxDecline: number;
} {
  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let totalChange = 0;
  let maxImprovement = 0;
  let maxDecline = 0;

  for (const change of result.scoreChanges) {
    if (change.change > 0) {
      improved++;
      maxImprovement = Math.max(maxImprovement, change.change);
    } else if (change.change < 0) {
      declined++;
      maxDecline = Math.min(maxDecline, change.change);
    } else {
      unchanged++;
    }
    totalChange += change.change;
  }

  return {
    improved,
    declined,
    unchanged,
    avgChange: result.scoreChanges.length > 0 ? Math.round(totalChange / result.scoreChanges.length) : 0,
    maxImprovement,
    maxDecline,
  };
}
