/**
 * @file trends-admin.ts
 * @description Server-only admin-SDK Firestore module for ComputedTrends
 * (narrow admin-helper pattern; see signals-autopilot-admin.ts for the
 * template).
 *
 * Originally replaced the static `import { computeTrends } from '@/lib/trends'`
 * in `src/lib/inngest/functions/daily-pipeline.ts` (step 6) — the client-SDK
 * Firestore reads/writes failed inside the Inngest worker with
 * `code: 'unavailable'` (no persistent Firestore connection; same bug class
 * as the 2026-05-12 fetch-signals fix). The client-SDK module `trends.ts` was
 * deleted on 2026-06-10 once its last consumers (pipeline status route,
 * pipeline AI tools) migrated here — this is now the only Firestore surface
 * for trends.
 *
 * Pure computation (clustering, trajectory, daily counts) lives in
 * `trends-core.ts`, which has no Firestore imports.
 */
import 'server-only';
import { createLogger } from '@/lib/logger';
import { adminGetSignalsByStatus } from '@/lib/signals-admin';
import {
  TRENDS_COLLECTION,
  buildDailyCounts,
  clusterSignals,
  computeTrajectory,
  type ComputedTrend,
  type CreateTrendInput,
} from '@/lib/trends-core';

const log = createLogger('trends-admin');

// ============================================================================
// FIRESTORE OPERATIONS (admin SDK)
// ============================================================================

/**
 * Get all computed trends (admin SDK).
 */
export async function adminGetTrends(): Promise<ComputedTrend[]> {
  const { db } = await import('@/lib/firebase-admin');
  const snapshot = await db.collection(TRENDS_COLLECTION).orderBy('lastComputedAt', 'desc').get();
  return snapshot.docs.map((doc) => ({
    ...(doc.data() as Omit<ComputedTrend, 'id'>),
    id: doc.id,
  })) as ComputedTrend[];
}

/**
 * Get a specific trend by ID (admin SDK).
 */
export async function adminGetTrendById(id: string): Promise<ComputedTrend | null> {
  const { db } = await import('@/lib/firebase-admin');
  const snapshot = await db.collection(TRENDS_COLLECTION).doc(id).get();
  if (!snapshot.exists) return null;
  return {
    ...(snapshot.data() as Omit<ComputedTrend, 'id'>),
    id: snapshot.id,
  } as ComputedTrend;
}

/**
 * Get trend statistics for dashboard (admin SDK).
 */
export async function adminGetTrendStats(): Promise<{
  total: number;
  emerging: number;
  growing: number;
  stable: number;
  declining: number;
  avgConfidence: number;
  topKeywords: string[];
}> {
  const trends = await adminGetTrends();

  if (trends.length === 0) {
    return {
      total: 0,
      emerging: 0,
      growing: 0,
      stable: 0,
      declining: 0,
      avgConfidence: 0,
      topKeywords: [],
    };
  }

  const stats = {
    total: trends.length,
    emerging: trends.filter((t) => t.trajectory === 'emerging').length,
    growing: trends.filter((t) => t.trajectory === 'growing').length,
    stable: trends.filter((t) => t.trajectory === 'stable').length,
    declining: trends.filter((t) => t.trajectory === 'declining').length,
    avgConfidence: Math.round(trends.reduce((sum, t) => sum + t.confidence, 0) / trends.length),
    topKeywords: [] as string[],
  };

  // Get top keywords by frequency
  const keywordCounts = new Map<string, number>();
  for (const trend of trends) {
    for (const keyword of trend.keywords) {
      keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
    }
  }

  stats.topKeywords = Array.from(keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword]) => keyword);

  return stats;
}

/**
 * Create a new computed trend (admin SDK).
 *
 * Direct doc write (not entity-factory) — analytics snapshot without slug
 * or audit-trail requirements.
 */
export async function adminCreateTrend(input: CreateTrendInput): Promise<ComputedTrend> {
  const { db } = await import('@/lib/firebase-admin');
  const id = `trend-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  const now = Date.now();

  const trend: ComputedTrend = {
    id,
    ...input,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(TRENDS_COLLECTION).doc(id).set(trend);
  return trend;
}

/**
 * Update an existing trend (admin SDK).
 */
export async function adminUpdateTrend(
  id: string,
  updates: Partial<Omit<ComputedTrend, 'id' | 'createdAt'>>
): Promise<void> {
  const { db } = await import('@/lib/firebase-admin');
  await db
    .collection(TRENDS_COLLECTION)
    .doc(id)
    .update({
      ...updates,
      updatedAt: Date.now(),
    });
}

/**
 * Delete a trend (admin SDK).
 */
export async function adminDeleteTrend(id: string): Promise<void> {
  const { db } = await import('@/lib/firebase-admin');
  await db.collection(TRENDS_COLLECTION).doc(id).delete();
}

// ============================================================================
// PIPELINE INTEGRATION
// ============================================================================

/**
 * Compute all trends from recent signals (admin SDK).
 *
 * This is the main entry point for the daily pipeline: fetch recent
 * validated signals, cluster them with AI, and create/update/delete
 * ComputedTrend docs. Port of the former `computeTrends` from trends.ts
 * with all Firestore access on the admin SDK.
 */
export async function adminComputeTrends(options?: {
  lookbackDays?: number;
  maxClusters?: number;
  minSignalsPerCluster?: number;
}): Promise<{
  created: number;
  updated: number;
  deleted: number;
  trends: ComputedTrend[];
}> {
  const { lookbackDays = 30, maxClusters = 15, minSignalsPerCluster = 2 } = options || {};

  log.info('Starting trend computation...');

  // 1. Fetch recent signals
  const cutoffDate = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const allSignals = await adminGetSignalsByStatus('Validated');
  const recentSignals = allSignals.filter((s) => s.detectedAt >= cutoffDate);

  log.info('Found recent signals', { count: recentSignals.length });

  if (recentSignals.length < minSignalsPerCluster) {
    log.info('Not enough signals for clustering');
    return { created: 0, updated: 0, deleted: 0, trends: [] };
  }

  // 2. Cluster signals
  const clusterResult = await clusterSignals(recentSignals, maxClusters);
  log.info('Created clusters', { count: clusterResult.clusters.length });

  // 3. Get existing trends
  const existingTrends = await adminGetTrends();
  const existingByName = new Map(existingTrends.map((t) => [t.name.toLowerCase(), t]));

  // 4. Process clusters and create/update trends
  const results: ComputedTrend[] = [];
  let created = 0;
  let updated = 0;

  for (const cluster of clusterResult.clusters) {
    if (cluster.signalIds.length < minSignalsPerCluster) continue;

    // Get signals for this cluster
    const clusterSignalDocs = recentSignals.filter((s) => cluster.signalIds.includes(s.id));

    // Build daily counts
    const dailyCounts = buildDailyCounts(clusterSignalDocs, lookbackDays);

    // Check if trend exists (by name similarity)
    const existingTrend = existingByName.get(cluster.name.toLowerCase());

    if (existingTrend) {
      // Update existing trend
      const newSignalIds = [...new Set([...existingTrend.signalIds, ...cluster.signalIds])];
      const trajectory = computeTrajectory(dailyCounts);

      await adminUpdateTrend(existingTrend.id, {
        signalIds: newSignalIds,
        signalCount: newSignalIds.length,
        dailyCounts,
        trajectory,
        lastComputedAt: Date.now(),
        keywords: cluster.keywords,
        summary: cluster.summary,
        confidence: cluster.confidence,
      });

      results.push({
        ...existingTrend,
        signalIds: newSignalIds,
        signalCount: newSignalIds.length,
        dailyCounts,
        trajectory,
        lastComputedAt: Date.now(),
        keywords: cluster.keywords,
        summary: cluster.summary,
        confidence: cluster.confidence,
        updatedAt: Date.now(),
      });

      updated++;
    } else {
      // Create new trend
      const trajectory = computeTrajectory(dailyCounts);

      const trend = await adminCreateTrend({
        name: cluster.name,
        trajectory,
        signalIds: cluster.signalIds,
        signalCount: cluster.signalIds.length,
        dailyCounts,
        lastComputedAt: Date.now(),
        confidence: cluster.confidence,
        keywords: cluster.keywords,
        summary: cluster.summary,
      });

      results.push(trend);
      created++;
    }
  }

  // 5. Mark stale trends for deletion (no new signals in lookbackDays)
  const activeClusterNames = new Set(clusterResult.clusters.map((c) => c.name.toLowerCase()));
  let deleted = 0;

  for (const trend of existingTrends) {
    if (!activeClusterNames.has(trend.name.toLowerCase())) {
      // Check if trend has any recent signals
      const hasRecentSignals = trend.signalIds.some((id) => recentSignals.some((s) => s.id === id));

      if (!hasRecentSignals) {
        await adminDeleteTrend(trend.id);
        deleted++;
      }
    }
  }

  log.info('Computation complete: created, updated, deleted', { created, updated, deleted });

  return { created, updated, deleted, trends: results };
}
