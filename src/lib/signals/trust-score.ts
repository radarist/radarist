/**
 * @file lib/signals/trust-score.ts
 * @description Trust score calculation for signals (Phase 4.2)
 *
 * Calculates a composite trust score based on:
 * - Source reliability (academic > news > social)
 * - Data completeness (% of fields populated)
 * - Corroboration (multiple sources confirm)
 * - AI confidence (LLM's own confidence assessment)
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

import type { Signal } from '@/lib/types';
import type { TrustScore } from '@/lib/schemas/signal';

/**
 * Input for calculating trust score
 */
export interface TrustScoreInput {
  /** The signal being scored */
  signal: Signal;

  /** AI's confidence in the expansion (0-1) */
  aiConfidence?: number;

  /** Whether multiple sources confirm this signal */
  hasCorroboration?: boolean;

  /** Number of corroborating sources (if available) */
  corroboratingSourceCount?: number;
}

/**
 * Source reliability tiers
 */
const SOURCE_RELIABILITY_SCORES: Record<string, number> = {
  // Academic & Research (highest reliability)
  papers: 95,
  arxiv: 95,
  'google scholar': 95,
  'research paper': 95,

  // Patents & Official Records
  patents: 90,
  'google patents': 90,
  'patent office': 90,

  // News & Media (vary by outlet)
  techcrunch: 85,
  'the verge': 85,
  wired: 85,
  'mit technology review': 90,
  nature: 95,
  science: 95,
  ieee: 90,
  acm: 90,

  // Industry Sources
  github: 80,
  'product hunt': 75,
  crunchbase: 85,

  // Trends & Social (lower reliability)
  trends: 60,
  'google trends': 60,
  twitter: 50,
  reddit: 45,

  // LLM-generated
  'llm-search': 70,
  'custom-agent': 70,

  // Default for unknown sources
  default: 50,
};

/**
 * Calculate comprehensive trust score for a signal
 *
 * @param input - Trust score calculation input
 * @returns Complete trust score breakdown
 */
export function calculateTrustScore(input: TrustScoreInput): TrustScore {
  const { signal, aiConfidence = 0.7, hasCorroboration = false, corroboratingSourceCount = 0 } = input;

  // Calculate each component
  const sourceReliability = calculateSourceReliability(signal);
  const dataCompleteness = calculateDataCompleteness(signal);
  const corroboration = calculateCorroborationScore(hasCorroboration, corroboratingSourceCount);
  const aiConfidenceScore = Math.round(aiConfidence * 100);

  // Calculate overall score (weighted average)
  const overall = Math.round(
    sourceReliability * 0.3 + // 30% weight on source quality
      dataCompleteness * 0.25 + // 25% weight on data completeness
      corroboration * 0.25 + // 25% weight on corroboration
      aiConfidenceScore * 0.2 // 20% weight on AI confidence
  );

  // Generate human-readable factors
  const factors = generateTrustFactors({
    overall,
    sourceReliability,
    dataCompleteness,
    corroboration,
    aiConfidenceScore,
    signal,
    hasCorroboration,
  });

  return {
    overall,
    breakdown: {
      sourceReliability,
      dataCompleteness,
      corroboration,
      aiConfidence: aiConfidenceScore,
    },
    factors,
  };
}

/**
 * Calculate source reliability score (0-100)
 */
function calculateSourceReliability(signal: Signal): number {
  if (!signal.source) {
    // No source provided, use type-based scoring only
    const typeScores: Record<string, number> = {
      paper: 90,
      patent: 85,
      news: 70,
      github: 75,
      funding: 80,
      trend: 60,
    };
    return typeScores[signal.type] || SOURCE_RELIABILITY_SCORES.default;
  }

  const sourceLower = signal.source.toLowerCase();
  const typeLower = signal.type.toLowerCase();

  // Check for exact matches first
  for (const [key, score] of Object.entries(SOURCE_RELIABILITY_SCORES)) {
    if (sourceLower.includes(key) || typeLower.includes(key)) {
      return score;
    }
  }

  // Check signal type as fallback
  const typeScores: Record<string, number> = {
    paper: 90,
    patent: 85,
    news: 70,
    github: 75,
    funding: 80,
    trend: 60,
  };

  return typeScores[signal.type] || SOURCE_RELIABILITY_SCORES.default;
}

/**
 * Calculate data completeness score (0-100)
 */
function calculateDataCompleteness(signal: Signal): number {
  const requiredFields = ['title', 'description', 'source', 'url', 'date', 'type'];

  const optionalHighValueFields = [
    'aiSummary',
    'expandedContent',
    'metadata',
    'relevanceScore',
    'alignmentScore',
    'alignedStrategies',
    'linkedEntities',
  ];

  // Count populated required fields (must be 100%)
  const populatedRequired = requiredFields.filter((field) => {
    const value = signal[field as keyof Signal];
    return value !== null && value !== undefined && value !== '';
  }).length;

  if (populatedRequired < requiredFields.length) {
    // Missing required fields = very low score
    return Math.round((populatedRequired / requiredFields.length) * 50);
  }

  // Count populated optional high-value fields
  const populatedOptional = optionalHighValueFields.filter((field) => {
    const value = signal[field as keyof Signal];
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value === '') return false;
    if (typeof value === 'object' && Object.keys(value).length === 0) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }).length;

  // Base score of 50 for all required, +50 for optional fields
  const optionalScore = (populatedOptional / optionalHighValueFields.length) * 50;
  return Math.round(50 + optionalScore);
}

/**
 * Calculate corroboration score (0-100).
 *
 * Exported (not just an internal helper): `confidence-calibration.ts`'s
 * `corroborationNudge` derives its 0/0/+5/+10/+15 bump for 0/1/2/3/4+ distinct
 * sources from these SAME frozen tiers (40/70/85/95) so the display-side trust
 * score and the graph-side effectiveConfidence nudge never drift apart.
 */
export function calculateCorroborationScore(hasCorroboration: boolean, sourceCount: number): number {
  if (!hasCorroboration || sourceCount === 0) {
    return 40; // Default score for single source
  }

  if (sourceCount === 1) return 40;
  if (sourceCount === 2) return 70;
  if (sourceCount === 3) return 85;
  if (sourceCount >= 4) return 95;

  return 40;
}

/**
 * Generate human-readable trust factors
 */
function generateTrustFactors(params: {
  overall: number;
  sourceReliability: number;
  dataCompleteness: number;
  corroboration: number;
  aiConfidenceScore: number;
  signal: Signal;
  hasCorroboration: boolean;
}): string[] {
  const factors: string[] = [];
  const {
    sourceReliability,
    dataCompleteness,
    corroboration: _corroboration,
    aiConfidenceScore,
    signal,
    hasCorroboration,
  } = params;

  // Source reliability factors
  if (sourceReliability >= 90) {
    factors.push('High-quality source (academic/patent)');
  } else if (sourceReliability >= 75) {
    factors.push('Reputable source (industry/news)');
  } else if (sourceReliability >= 60) {
    factors.push('Moderate source reliability');
  } else {
    factors.push('Limited source reliability');
  }

  // Data completeness factors
  if (dataCompleteness >= 80) {
    factors.push('Comprehensive data available');
  } else if (dataCompleteness >= 60) {
    factors.push('Good data coverage');
  } else {
    factors.push('Limited data available');
  }

  // Corroboration factors
  if (hasCorroboration) {
    factors.push('Multiple source corroboration');
  } else {
    factors.push('Single source (no corroboration)');
  }

  // AI confidence factors
  if (aiConfidenceScore >= 85) {
    factors.push('High AI confidence');
  } else if (aiConfidenceScore >= 70) {
    factors.push('Moderate AI confidence');
  } else {
    factors.push('Low AI confidence');
  }

  // Additional contextual factors
  if (signal.expandedContent) {
    factors.push('Deep analysis completed');
  }

  if (signal.alignedStrategies && signal.alignedStrategies.length > 0) {
    factors.push(
      `Aligned with ${signal.alignedStrategies.length} strateg${signal.alignedStrategies.length === 1 ? 'y' : 'ies'}`
    );
  }

  if (signal.metadata && Object.keys(signal.metadata).length > 5) {
    factors.push('Rich metadata available');
  }

  return factors;
}

/**
 * Get trust score tier label
 */
export function getTrustScoreTier(score: number): {
  label: string;
  color: string;
  description: string;
} {
  if (score >= 85) {
    return {
      label: 'Excellent',
      color: 'green',
      description: 'High confidence - suitable for autopilot mode',
    };
  }

  if (score >= 70) {
    return {
      label: 'Good',
      color: 'blue',
      description: 'Reliable signal - review recommended',
    };
  }

  if (score >= 50) {
    return {
      label: 'Fair',
      color: 'yellow',
      description: 'Moderate confidence - manual review needed',
    };
  }

  return {
    label: 'Low',
    color: 'red',
    description: 'Low confidence - verify before acting',
  };
}
