/**
 * @file trends-core.ts
 * @description Pure trend-computation logic consumed by the admin-SDK
 * Firestore module (`trends-admin.ts`). (The client-SDK service `trends.ts`
 * was deleted on 2026-06-10 — all trend Firestore access is admin-SDK now.)
 *
 * This module deliberately has NO Firestore imports (neither client nor
 * admin SDK) so the Inngest worker can load it without pulling the Firebase
 * client SDK into a stateless server runtime (the `code: 'unavailable'` bug
 * class observed in stateless server runtimes). It contains:
 * - ComputedTrend model types
 * - Trend trajectory computation (emerging/growing/stable/declining)
 * - Daily-count bucketing
 * - AI signal clustering + cluster analysis (Gemini — server env only)
 *
 * @phase Phase 6: Daily Pipeline (split out of trends.ts on 2026-06-10)
 */

import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { z } from 'zod';
import type { Signal } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('trends-core');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Trend trajectory indicating the direction of a trend.
 */
export type TrendTrajectory = 'emerging' | 'growing' | 'stable' | 'declining';

/**
 * Daily count entry for tracking signal volume over time.
 */
export interface DailyCount {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Number of signals on that date */
  count: number;
}

/**
 * AI-computed trend cluster derived from signal clustering.
 *
 * Trends are clusters of semantically similar signals that indicate
 * a pattern or movement in the innovation landscape.
 *
 * @example
 * ```typescript
 * const trend: ComputedTrend = {
 *   id: 'trend-123',
 *   name: 'AI-Powered Drug Discovery',
 *   trajectory: 'emerging',
 *   signalIds: ['signal-1', 'signal-2', 'signal-3'],
 *   signalCount: 3,
 *   dailyCounts: [
 *     { date: '2026-01-07', count: 1 },
 *     { date: '2026-01-08', count: 2 },
 *   ],
 *   lastComputedAt: Date.now(),
 *   confidence: 85,
 *   keywords: ['AI', 'drug discovery', 'pharmaceutical'],
 *   summary: 'Multiple signals indicate growing interest in AI applications for drug discovery...',
 * };
 * ```
 *
 * @phase Phase 6: Daily Pipeline
 */
export interface ComputedTrend {
  /** Unique identifier for the trend */
  id: string;

  /** AI-generated cluster name */
  name: string;

  /** Current trajectory of the trend */
  trajectory: TrendTrajectory;

  /** Signal IDs that belong to this trend cluster */
  signalIds: string[];

  /** Total number of signals in this cluster */
  signalCount: number;

  /** Daily signal counts for the past 30 days */
  dailyCounts: DailyCount[];

  /** Timestamp when trend was last computed (ms since epoch) */
  lastComputedAt: number;

  /** AI confidence score (0-100) */
  confidence: number;

  /** Keywords associated with this trend */
  keywords: string[];

  /** AI-generated summary of the trend */
  summary?: string;

  /** Related entity IDs discovered from signals */
  relatedEntities?: {
    technologies?: string[];
    companies?: string[];
    strategies?: string[];
  };

  /** Timestamp when created (ms since epoch) */
  createdAt: number;

  /** Timestamp when last updated (ms since epoch) */
  updatedAt: number;
}

/**
 * Input for creating a new ComputedTrend.
 */
export type CreateTrendInput = Omit<ComputedTrend, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Result of signal clustering operation.
 */
export interface ClusteringResult {
  /** Clusters of signal IDs */
  clusters: Array<{
    signalIds: string[];
    name: string;
    keywords: string[];
    confidence: number;
    summary: string;
  }>;
  /** Signals that couldn't be clustered */
  unclustered: string[];
}

/**
 * Zod schema for AI-generated trend analysis.
 */
const TrendAnalysisSchema = z.object({
  name: z.string().describe('Short, descriptive name for this trend cluster'),
  trajectory: z
    .enum(['emerging', 'growing', 'stable', 'declining'])
    .describe('Current trajectory based on signal volume over time'),
  keywords: z.array(z.string()).describe('Key terms associated with this trend'),
  summary: z.string().describe('2-3 sentence summary of this trend'),
  confidence: z.number().min(0).max(100).describe('Confidence score for this analysis'),
});

/**
 * Firestore collection name for computed trends. Consumed by the admin-SDK
 * module (`trends-admin.ts`).
 */
export const TRENDS_COLLECTION = 'computedTrends';

// ============================================================================
// TREND COMPUTATION (pure / AI — no Firestore)
// ============================================================================

/**
 * Compute the trajectory of a trend based on daily counts.
 *
 * Trajectory is determined by comparing recent signal volume to historical:
 * - emerging: < 5 total signals, recent uptick
 * - growing: > 20% increase in last 7 days vs previous 7 days
 * - stable: within +/- 10% change
 * - declining: > 20% decrease in last 7 days
 */
export function computeTrajectory(dailyCounts: DailyCount[]): TrendTrajectory {
  if (dailyCounts.length < 7) {
    // Not enough data, check total signals
    const total = dailyCounts.reduce((sum, d) => sum + d.count, 0);
    return total < 5 ? 'emerging' : 'stable';
  }

  // Sort by date descending
  const sorted = [...dailyCounts].sort((a, b) => b.date.localeCompare(a.date));

  // Get last 7 days and previous 7 days
  const recent = sorted.slice(0, 7);
  const previous = sorted.slice(7, 14);

  const recentTotal = recent.reduce((sum, d) => sum + d.count, 0);
  const previousTotal = previous.reduce((sum, d) => sum + d.count, 0);

  // Handle case where previous is 0
  if (previousTotal === 0) {
    return recentTotal > 0 ? 'emerging' : 'stable';
  }

  const changeRate = (recentTotal - previousTotal) / previousTotal;

  if (changeRate > 0.2) return 'growing';
  if (changeRate < -0.2) return 'declining';
  if (recentTotal < 5) return 'emerging';
  return 'stable';
}

/**
 * Build daily counts from a list of signals.
 */
export function buildDailyCounts(signals: Signal[], days: number = 30): DailyCount[] {
  const counts: Map<string, number> = new Map();

  // Initialize all dates in range
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    counts.set(dateStr, 0);
  }

  // Count signals by date
  for (const signal of signals) {
    const date = new Date(signal.detectedAt).toISOString().split('T')[0];
    if (counts.has(date)) {
      counts.set(date, (counts.get(date) || 0) + 1);
    }
  }

  // Convert to array
  return Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Cluster signals using AI-based semantic similarity.
 *
 * This function groups signals by semantic similarity using the AI model
 * to identify themes and patterns.
 */
export async function clusterSignals(signals: Signal[], maxClusters: number = 10): Promise<ClusteringResult> {
  if (signals.length === 0) {
    return { clusters: [], unclustered: [] };
  }

  // If too few signals, create a single cluster
  if (signals.length < 3) {
    return {
      clusters: [
        {
          signalIds: signals.map((s) => s.id),
          name: signals[0]?.title || 'Uncategorized',
          keywords: signals[0]?.linkedEntities?.technologies || [],
          confidence: 50,
          summary: signals[0]?.aiSummary || 'Insufficient signals for clustering.',
        },
      ],
      unclustered: [],
    };
  }

  // Prepare signal summaries for AI
  const signalSummaries = signals.map((s, idx) => ({
    index: idx,
    id: s.id,
    title: s.title,
    type: s.type,
    summary: s.aiSummary || s.description.substring(0, 200),
    keywords: s.linkedEntities?.technologies?.slice(0, 5) || [],
  }));

  const prompt = `You are analyzing innovation signals to identify trend clusters.

Given these ${signals.length} signals, identify up to ${maxClusters} distinct trend clusters.
Each cluster should group signals that are semantically related (same technology area, market trend, or theme).

Signals:
${JSON.stringify(signalSummaries, null, 2)}

For each cluster, provide:
1. A short, descriptive name
2. The indices of signals that belong to this cluster
3. Key keywords
4. A brief summary

Return ONLY clusters with at least 2 signals. Mark single signals as unclustered.
Be conservative - only cluster signals that are clearly related.`;

  const ClusteringSchema = z.object({
    clusters: z.array(
      z.object({
        name: z.string(),
        signalIndices: z.array(z.number()),
        keywords: z.array(z.string()),
        summary: z.string(),
        confidence: z.number().min(0).max(100),
      })
    ),
    unclusteredIndices: z.array(z.number()),
  });

  try {
    const result = await generateStructuredContent(prompt, ClusteringSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    // Map indices back to signal IDs
    const clusters = result.clusters.map((c) => ({
      signalIds: c.signalIndices.map((i) => signals[i]?.id).filter(Boolean) as string[],
      name: c.name,
      keywords: c.keywords,
      confidence: c.confidence,
      summary: c.summary,
    }));

    const unclustered = result.unclusteredIndices.map((i) => signals[i]?.id).filter(Boolean) as string[];

    return { clusters, unclustered };
  } catch (error) {
    log.error('Clustering failed', error instanceof Error ? error : new Error(String(error)));
    // Fallback: treat all signals as unclustered
    return {
      clusters: [],
      unclustered: signals.map((s) => s.id),
    };
  }
}

/**
 * Analyze a trend cluster and generate metadata using AI.
 */
export async function analyzeTrendCluster(signals: Signal[]): Promise<z.infer<typeof TrendAnalysisSchema>> {
  const signalSummaries = signals.slice(0, 20).map((s) => ({
    title: s.title,
    type: s.type,
    summary: s.aiSummary || s.description.substring(0, 200),
    date: new Date(s.detectedAt).toISOString().split('T')[0],
  }));

  const prompt = `Analyze this cluster of ${signals.length} innovation signals and provide trend analysis.

Signals:
${JSON.stringify(signalSummaries, null, 2)}

Analyze:
1. What is this trend about? (name)
2. Is it emerging, growing, stable, or declining? (trajectory)
3. What are the key keywords?
4. Provide a 2-3 sentence summary
5. How confident are you in this analysis? (0-100)`;

  try {
    return await generateStructuredContent(prompt, TrendAnalysisSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });
  } catch (error) {
    log.error('Analysis failed', error instanceof Error ? error : new Error(String(error)));
    return {
      name: 'Analysis Failed',
      trajectory: 'stable',
      keywords: [],
      summary: 'Failed to analyze this trend cluster.',
      confidence: 0,
    };
  }
}
