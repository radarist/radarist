/**
 * @file signals/scorer.ts
 * @description Pure deterministic scorer for Signal trustScore.
 *
 * Replaces the no-op run-evaluation-agent stub. Produces a TrustScore
 * object shaped to match Signal['trustScore'] in src/lib/types/entities.ts
 * so the scorer output can be dropped straight into updateSignal.
 *
 * Delegates to the existing calculateTrustScore implementation in
 * trust-score.ts, which holds the source-reliability lookup table and
 * data-completeness logic. This file is the public interface used by
 * the Inngest handler.
 *
 * A future Agent-SDK-based evaluator can replace this behind the same
 * interface without changing the Inngest event contract.
 */

import type { Signal } from '@/lib/types';
import type { TrustScore } from '@/lib/schemas/signal';
import { calculateTrustScore } from './trust-score';
import { normalizeSignalEvidenceSources } from './evidence-sources';

export type { TrustScore };

/**
 * Score a signal deterministically, returning a TrustScore object.
 *
 * Uses field presence and signal type to derive sourceReliability,
 * dataCompleteness, corroboration from distinct confirming URLs, and
 * aiConfidence. No external calls are made.
 *
 * @param signal - The signal to score
 * @returns TrustScore with overall (0-100), breakdown, and factors
 */
export function scoreSignal(signal: Signal): TrustScore {
  const title = (signal.title ?? '').trim();
  const description = (signal.description ?? '').trim();

  if (!title && !description) {
    return {
      overall: 0,
      breakdown: { sourceReliability: 0, dataCompleteness: 0, corroboration: 0, aiConfidence: 0 },
      factors: ['no-content'],
    };
  }

  const evidenceSources = normalizeSignalEvidenceSources(signal, signal.expandedContent?.sources ?? []);
  const corroboratingSourceCount = evidenceSources.filter((source) => source.verdict === 'confirming').length;
  const hasCorroboration = corroboratingSourceCount >= 2;

  // Derive aiConfidence heuristic from description richness (0-1 scale for calculateTrustScore)
  let aiConfidenceRaw = 0.5;
  if (title.length >= 20 && description.length >= 80) aiConfidenceRaw = 0.7;
  if (description.length >= 300) aiConfidenceRaw = 0.8;

  return calculateTrustScore({
    signal,
    aiConfidence: aiConfidenceRaw,
    hasCorroboration,
    corroboratingSourceCount,
  });
}
