/**
 * @file linker/linker-metrics.ts
 * @description Linker Agent Metrics & Tracking Service
 *
 * Provides persistent storage for:
 * - LinkerRunMetrics: Quality tracking per run
 * - Entity processing timestamps: For incremental processing
 *
 * **Collections:**
 * - linkerRuns: Run metrics and statistics
 * - linkerEntityTracking: Last processed timestamp per entity
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { createLogger } from '@/lib/logger';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore';

const log = createLogger('linker/linker-metrics');
import { db } from '@/lib/firebase';
import type { LinkerRunMetrics } from './types';
import type { EntityType } from '@/lib/types';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Firestore collection for run metrics */
const LINKER_RUNS_COLLECTION = 'linkerRuns';

/** Firestore collection for entity tracking */
const LINKER_TRACKING_COLLECTION = 'linkerEntityTracking';

/** Default stale threshold (24 hours in milliseconds) */
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Entity tracking record for incremental processing
 */
export interface LinkerEntityTracking {
  /** Entity ID */
  entityId: string;

  /** Entity type */
  entityType: EntityType;

  /** When this entity was last processed by Linker */
  lastProcessedAt: number;

  /** Run ID that last processed this entity */
  lastRunId: string;

  /** Number of proposals generated for this entity */
  totalProposals: number;

  /** Entity name (for display) */
  entityName?: string;
}

/**
 * Persisted run metrics with additional Firestore fields
 */
export interface PersistedLinkerRun extends LinkerRunMetrics {
  /** Firestore document ID */
  id: string;

  /** Server timestamp for ordering */
  createdAt: Timestamp;

  /** Execution time in milliseconds */
  executionTimeMs?: number;

  /** Triggered by (user ID or 'scheduled') */
  triggeredBy?: string;

  /** Whether this was a dry run */
  dryRun?: boolean;
}

// ============================================================================
// RUN METRICS FUNCTIONS
// ============================================================================

/**
 * Saves run metrics to Firestore.
 *
 * @param metrics - Run metrics to save
 * @param options - Additional options
 * @returns The persisted run ID
 *
 * @example
 * ```typescript
 * const runId = await saveLinkerRun(metrics, {
 *   triggeredBy: 'user-123',
 *   dryRun: false,
 * });
 * ```
 */
export async function saveLinkerRun(
  metrics: LinkerRunMetrics,
  options?: {
    triggeredBy?: string;
    dryRun?: boolean;
  }
): Promise<string> {
  const runRef = doc(collection(db, LINKER_RUNS_COLLECTION));

  const data: Omit<PersistedLinkerRun, 'id'> = {
    ...metrics,
    createdAt: serverTimestamp() as Timestamp,
    executionTimeMs: metrics.completedAt
      ? metrics.completedAt - metrics.startedAt
      : undefined,
    triggeredBy: options?.triggeredBy || 'scheduled',
    dryRun: options?.dryRun ?? false,
  };

  await setDoc(runRef, data);

  log.info('Saved run', { runId: metrics.runId, id: runRef.id });
  return runRef.id;
}

/**
 * Gets a specific run by its run ID.
 *
 * @param runId - The run ID to look up
 * @returns The run metrics or null if not found
 */
export async function getLinkerRun(
  runId: string
): Promise<PersistedLinkerRun | null> {
  const q = query(
    collection(db, LINKER_RUNS_COLLECTION),
    where('runId', '==', runId),
    limit(1)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return {
    id: doc.id,
    ...doc.data(),
  } as PersistedLinkerRun;
}

/**
 * Gets recent runs for monitoring/debugging.
 *
 * @param limitCount - Maximum number of runs to return
 * @returns Array of recent runs, newest first
 */
export async function getRecentLinkerRuns(
  limitCount: number = 10
): Promise<PersistedLinkerRun[]> {
  const q = query(
    collection(db, LINKER_RUNS_COLLECTION),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as PersistedLinkerRun[];
}

/**
 * Gets aggregate statistics across all runs.
 *
 * @param days - Number of days to aggregate
 * @returns Aggregate statistics
 */
export async function getLinkerStats(days: number = 7): Promise<{
  totalRuns: number;
  totalProposals: number;
  totalEntitiesProcessed: number;
  avgConfidence: number;
  avgProposalsPerRun: number;
  byRelationType: Record<string, number>;
}> {
  const cutoffDate = Date.now() - days * 24 * 60 * 60 * 1000;

  const q = query(
    collection(db, LINKER_RUNS_COLLECTION),
    where('startedAt', '>=', cutoffDate),
    orderBy('startedAt', 'desc')
  );

  const snapshot = await getDocs(q);
  const runs = snapshot.docs.map((d) => d.data() as LinkerRunMetrics);

  if (runs.length === 0) {
    return {
      totalRuns: 0,
      totalProposals: 0,
      totalEntitiesProcessed: 0,
      avgConfidence: 0,
      avgProposalsPerRun: 0,
      byRelationType: {},
    };
  }

  // Aggregate stats
  let totalProposals = 0;
  let totalEntitiesProcessed = 0;
  let totalConfidence = 0;
  let _runsWithProposals = 0;
  const byRelationType: Record<string, number> = {};

  for (const run of runs) {
    totalProposals += run.proposalsCreated;
    totalEntitiesProcessed += run.entitiesProcessed;

    if (run.proposalsCreated > 0) {
      totalConfidence += run.avgConfidence * run.proposalsCreated;
      _runsWithProposals++;
    }

    for (const [relType, count] of Object.entries(run.byRelationType || {})) {
      byRelationType[relType] = (byRelationType[relType] || 0) + count;
    }
  }

  return {
    totalRuns: runs.length,
    totalProposals,
    totalEntitiesProcessed,
    avgConfidence: totalProposals > 0 ? Math.round(totalConfidence / totalProposals) : 0,
    avgProposalsPerRun: Math.round(totalProposals / runs.length),
    byRelationType,
  };
}

// ============================================================================
// ENTITY TRACKING FUNCTIONS
// ============================================================================

/**
 * Updates the last processed timestamp for entities.
 * Uses batch write for efficiency.
 *
 * @param entities - Array of entity IDs and types that were processed
 * @param runId - The run ID that processed them
 * @param proposalCounts - Map of entity ID to number of proposals created
 *
 * @example
 * ```typescript
 * await updateEntityTracking(
 *   [
 *     { id: 'tech-1', type: 'technology', name: 'React' },
 *     { id: 'tech-2', type: 'technology', name: 'Vue' },
 *   ],
 *   'linker-run-123',
 *   new Map([['tech-1', 3], ['tech-2', 1]])
 * );
 * ```
 */
export async function updateEntityTracking(
  entities: Array<{ id: string; type: EntityType; name?: string }>,
  runId: string,
  proposalCounts?: Map<string, number>
): Promise<void> {
  if (entities.length === 0) {
    return;
  }

  // Firestore batch limit is 500
  const batches: Array<Array<{ id: string; type: EntityType; name?: string }>> = [];
  for (let i = 0; i < entities.length; i += 500) {
    batches.push(entities.slice(i, i + 500));
  }

  for (const batch of batches) {
    const firestoreBatch = writeBatch(db);

    for (const entity of batch) {
      const trackingId = `${entity.type}_${entity.id}`;
      const ref = doc(db, LINKER_TRACKING_COLLECTION, trackingId);

      // Get existing to update totalProposals
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as LinkerEntityTracking)
        : null;

      const newProposals = proposalCounts?.get(entity.id) || 0;

      const data: LinkerEntityTracking = {
        entityId: entity.id,
        entityType: entity.type,
        lastProcessedAt: Date.now(),
        lastRunId: runId,
        totalProposals: (existingData?.totalProposals || 0) + newProposals,
        entityName: entity.name,
      };

      firestoreBatch.set(ref, data);
    }

    await firestoreBatch.commit();
  }

  log.info('Updated tracking', { entityCount: entities.length });
}

/**
 * Gets entities that haven't been processed recently.
 * Used for incremental processing.
 *
 * @param entityType - Type of entities to get
 * @param staleThresholdMs - How old is "stale" (default: 24 hours)
 * @param maxResults - Maximum number of results
 * @returns Array of entity IDs that need processing
 *
 * @example
 * ```typescript
 * const staleEntities = await getStaleEntities('technology', 24 * 60 * 60 * 1000, 100);
 * ```
 */
export async function getStaleEntityIds(
  entityType: EntityType,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  maxResults: number = 100
): Promise<string[]> {
  const cutoffTime = Date.now() - staleThresholdMs;

  const q = query(
    collection(db, LINKER_TRACKING_COLLECTION),
    where('entityType', '==', entityType),
    where('lastProcessedAt', '<', cutoffTime),
    orderBy('lastProcessedAt', 'asc'),
    limit(maxResults)
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => (d.data() as LinkerEntityTracking).entityId);
}

/**
 * Gets entities that have NEVER been processed.
 * These are entities not in the tracking collection at all.
 *
 * Note: This requires checking against the entity collection,
 * which should be done at the caller level.
 *
 * @param entityType - Type of entities
 * @returns Set of tracked entity IDs (to filter against full entity list)
 */
export async function getTrackedEntityIds(
  entityType: EntityType
): Promise<Set<string>> {
  const q = query(
    collection(db, LINKER_TRACKING_COLLECTION),
    where('entityType', '==', entityType)
  );

  const snapshot = await getDocs(q);
  return new Set(
    snapshot.docs.map((d) => (d.data() as LinkerEntityTracking).entityId)
  );
}

/**
 * Gets the tracking record for a specific entity.
 *
 * @param entityId - Entity ID
 * @param entityType - Entity type
 * @returns Tracking record or null
 */
export async function getEntityTracking(
  entityId: string,
  entityType: EntityType
): Promise<LinkerEntityTracking | null> {
  const trackingId = `${entityType}_${entityId}`;
  const ref = doc(db, LINKER_TRACKING_COLLECTION, trackingId);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as LinkerEntityTracking;
}

/**
 * Checks if an entity was recently processed.
 *
 * @param entityId - Entity ID
 * @param entityType - Entity type
 * @param thresholdMs - How recent is "recent" (default: 24 hours)
 * @returns True if processed within threshold
 */
export async function wasRecentlyProcessed(
  entityId: string,
  entityType: EntityType,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS
): Promise<boolean> {
  const tracking = await getEntityTracking(entityId, entityType);
  if (!tracking) {
    return false;
  }

  return Date.now() - tracking.lastProcessedAt < thresholdMs;
}

// ============================================================================
// PERFORMANCE METRICS FUNCTIONS
// ============================================================================

/**
 * Linker performance metrics for dashboard display
 */
export interface LinkerPerformanceMetrics {
  /** Total proposals created in period */
  totalProposals: number;

  /** Number of proposals approved */
  approved: number;

  /** Number of proposals rejected */
  rejected: number;

  /** Number of proposals pending */
  pending: number;

  /** Approval rate (0-100) */
  approvalRate: number;

  /** Average confidence of approved proposals */
  avgApprovedConfidence: number;

  /** Average confidence of rejected proposals */
  avgRejectedConfidence: number;

  /** Precision estimate: approved / (approved + rejected) */
  precisionEstimate: number;

  /** Number of runs in period */
  runsInPeriod: number;

  /** Last run timestamp */
  lastRunAt: number | null;
}

/**
 * Gets comprehensive linker performance metrics.
 * Combines proposal stats with run metrics.
 *
 * @param days - Number of days to analyze
 * @returns Performance metrics
 *
 * @example
 * ```typescript
 * const metrics = await getLinkerPerformanceMetrics(7);
 * console.log(`Approval rate: ${metrics.approvalRate}%`);
 * ```
 */
export async function getLinkerPerformanceMetrics(
  days: number = 7
): Promise<LinkerPerformanceMetrics> {
  const cutoffDate = Date.now() - days * 24 * 60 * 60 * 1000;

  // Import dynamically to avoid a circular dependency. AI-040: the ADMIN twin —
  // the client-SDK barrel has no auth context in this server-only surface and
  // its reads are filtered to [] (or reject) rather than failing loudly.
  const { getProposedRelations } = await import('@/lib/proposed-relations-admin');

  // Fetch proposals created in period
  const proposals = await getProposedRelations({
    createdAfter: cutoffDate,
  });

  // Count by status
  const approved = proposals.filter((p) => p.status === 'approved');
  const rejected = proposals.filter((p) => p.status === 'rejected');
  const pending = proposals.filter((p) => p.status === 'pending');

  // Calculate average confidence for each category
  const avgApprovedConfidence =
    approved.length > 0
      ? Math.round(
          approved.reduce((sum, p) => sum + p.confidence, 0) / approved.length
        )
      : 0;

  const avgRejectedConfidence =
    rejected.length > 0
      ? Math.round(
          rejected.reduce((sum, p) => sum + p.confidence, 0) / rejected.length
        )
      : 0;

  // Calculate approval rate and precision
  const decidedTotal = approved.length + rejected.length;
  const approvalRate =
    decidedTotal > 0 ? Math.round((approved.length / decidedTotal) * 100) : 0;

  const precisionEstimate = approvalRate; // Same as approval rate when all decisions are manual

  // Get run stats
  const runs = await getRecentLinkerRuns(100);
  const runsInPeriod = runs.filter(
    (r) => r.startedAt && r.startedAt >= cutoffDate
  ).length;

  const lastRun = runs[0];
  const lastRunAt = lastRun?.startedAt || null;

  return {
    totalProposals: proposals.length,
    approved: approved.length,
    rejected: rejected.length,
    pending: pending.length,
    approvalRate,
    avgApprovedConfidence,
    avgRejectedConfidence,
    precisionEstimate,
    runsInPeriod,
    lastRunAt,
  };
}
