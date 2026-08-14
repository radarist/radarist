/**
 * @file signals-core.ts
 * @description Core CRUD operations, filtering, querying, and analytics for Signals.
 *
 * Signals represent external discoveries from automated monitoring of patents, research papers,
 * news, funding data, GitHub activity, and market trends. They are potential new technologies,
 * companies, or opportunities that require validation and review before import.
 *
 * **Signal Lifecycle:**
 * 1. Detected (by background job)
 * 2. Validated (AI scores relevance and alignment)
 * 3. Approved/Rejected (by human if below auto-import threshold)
 * 4. Imported (converted to technology/company/use case)
 *
 * **Autopilot Mode:** Signals with relevanceScore >= 90% are auto-imported
 * **Co-pilot Mode:** All signals require human approval before import
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from '@/lib/firebase';
import { collection, doc, getDocs, getDoc, deleteDoc, updateDoc, query, where, orderBy } from 'firebase/firestore';
import type { Signal, SignalType, SignalStatus } from '@/lib/types';
import { needsExpansion } from '@/lib/signals/expansion-utils';
import { triggerEntitySync } from '@/lib/entity-sync';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { createEntity, DuplicateEntityError } from '@/lib/entity-factory';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import { createLogger } from '@/lib/logger';
const log = createLogger('signals');

const IS_SERVER_RUNTIME = typeof window === 'undefined';

async function queueSignalExpansionSafely(signal: Signal): Promise<void> {
  if (!IS_SERVER_RUNTIME) return;
  try {
    const { safeSendEvent } = await import('@/lib/inngest/send-client');
    await safeSendEvent(
      { name: 'app/signal.expand.requested', data: { signalId: signal.id } },
      { silent: true, logPrefix: '[signals-core]' }
    );
  } catch (err) {
    log.warn('queueSignalExpansionSafely failed', {
      signalId: signal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Fetches all signals from Firestore.
 * Returns signals ordered by detection date (most recent first).
 *
 * **Performance Note:** For large datasets, consider using pagination or filtering.
 *
 * @returns Promise resolving to an array of Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const signals = await getSignals();
 * console.log(`Total signals: ${signals.length}`);
 * const pending = signals.filter(s => s.status === "Validated");
 * console.log(`Pending review: ${pending.length}`);
 * ```
 */
export async function getSignals(): Promise<Signal[]> {
  try {
    const querySnapshot = await getDocs(query(collection(db, 'signals'), orderBy('detectedAt', 'desc')));
    return querySnapshot.docs.map((doc) => doc.data() as Signal);
  } catch (error) {
    log.error('Error fetching signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch signals');
  }
}

/**
 * Fetches a single signal by ID with all its data.
 *
 * @param id - The unique identifier of the signal
 * @returns Promise resolving to the Signal object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const signal = await getSignalById("patent-ai-flavor-123");
 * if (signal) {
 *   console.log(`${signal.title} - Relevance: ${signal.relevanceScore}%`);
 *   console.log(`Status: ${signal.status}`);
 * }
 * ```
 */
/**
 * Looks up a signal by (source, url) — the natural dedupe key for external
 * fetchers (patents, papers, news, github). Used by fetch-signals before
 * createSignal to stop 38×"new research paper" and 21×"google files patent"
 * dup explosions from the 6-hourly cron.
 *
 * Returns null when no match exists, when url is missing (agent-generated
 * signals can't dedupe on url), or when the lookup fails.
 */
export async function findSignalByUrl(source: string, url: string | undefined): Promise<Signal | null> {
  if (!url) return null;
  try {
    const snap = await getDocs(
      query(collection(db, 'signals'), where('source', '==', source), where('url', '==', url))
    );
    if (snap.empty) return null;
    return snap.docs[0].data() as Signal;
  } catch (error) {
    log.warn('findSignalByUrl failed', {
      source,
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getSignalById(id: string): Promise<Signal | null> {
  try {
    const docRef = doc(db, 'signals', id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return docSnap.data() as Signal;
    }
    return null;
  } catch (error) {
    log.error('Error fetching signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch signal ${id}`);
  }
}

/**
 * Creates a new signal in Firestore.
 * Automatically generates an ID based on the signal title and timestamp.
 *
 * **Note:** Signals are typically created by background jobs (ScoutAgent),
 * not manually by users. This function is used by the signal detection pipeline.
 *
 * @param signal - The signal data without system-managed fields (id, timestamps)
 * @returns Promise resolving to the newly created Signal object
 * @throws Error if Firestore operation fails or validation fails
 *
 * @example
 * ```typescript
 * const newSignal = await createSignal({
 *   type: "patent",
 *   title: "AI-powered flavor prediction system",
 *   source: "Google Patents",
 *   url: "https://patents.google.com/patent/...",
 *   relevanceScore: 85,
 *   alignmentScore: 92,
 *   alignedStrategies: ["innovation-2025"],
 *   linkedEntities: {
 *     technologies: ["nutrition-bu:42"]
 *   },
 *   status: "Validated",
 *   sentiment: "positive",
 *   aiSummary: "Novel AI system for predicting flavor combinations...",
 *   detectedAt: Date.now()
 * });
 * console.log(`Created signal: ${newSignal.id}`);
 * ```
 */
export async function createSignal(
  signal: Omit<Signal, 'id' | 'slug' | 'reviewedAt' | 'processedAt'>
): Promise<Signal> {
  try {
    // Validate required fields
    if (!signal.title || !signal.source) {
      throw new Error('Signal title and source are required');
    }

    // URL is required for external signals, but optional for agent-generated ones
    if (!signal.url && !signal.metadata?.agentId) {
      throw new Error('Signal URL is required for non-agent signals');
    }

    if (signal.relevanceScore < 0 || signal.relevanceScore > 100) {
      throw new Error('Relevance score must be between 0 and 100');
    }

    if (signal.alignmentScore < 0 || signal.alignmentScore > 100) {
      throw new Error('Alignment score must be between 0 and 100');
    }

    // Use entity-factory for uniqueness-enforced creation
    const result = await createEntity<typeof signal>('signal', signal);

    const newSignal = result.entity as Signal;

    // Queue expansion for eligible signals (Phase 4.2)
    // Non-blocking: Don't fail signal creation if Inngest is unavailable
    if (needsExpansion(newSignal)) {
      log.info('Queueing expansion for signal', { id: newSignal.id });
      try {
        await queueSignalExpansionSafely(newSignal);
      } catch (inngestError) {
        // Log but don't fail - expansion is optional
        log.warn('Failed to queue expansion (Inngest unavailable)', { error: String(inngestError) });
      }
    }

    return newSignal;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate signal', { message: error.message });
      throw error;
    }
    log.error('Error creating signal', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create signal: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing signal in Firestore.
 *
 * **Note:** Partial updates are supported. Only provided fields will be updated.
 *
 * @param id - The ID of the signal to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or signal doesn't exist
 *
 * @example
 * ```typescript
 * // Update signal status after review
 * await updateSignal("patent-ai-flavor-123", {
 *   status: "Approved",
 *   reviewedAt: Date.now()
 * });
 *
 * // Add deep research results
 * await updateSignal("patent-ai-flavor-123", {
 *   deepResearch: {
 *     performedAt: Date.now(),
 *     data: { additionalFindings: "..." }
 *   }
 * });
 * ```
 */
export async function updateSignal(id: string, updates: Partial<Omit<Signal, 'id' | 'detectedAt'>>): Promise<void> {
  try {
    const docRef = doc(db, 'signals', id);

    // Check if signal exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Signal ${id} not found`);
    }

    // Remove undefined values before updating Firestore
    const cleanedUpdates = removeUndefinedFields(updates);
    await updateDoc(docRef, cleanedUpdates);

    log.info('Successfully updated signal', { id });

    // Trigger Neo4j sync
    triggerEntitySync('signal', id, 'update', cleanedUpdates).catch((err) => {
      log.warn('Failed to trigger Neo4j sync for update', { id, error: String(err) });
    });
  } catch (error) {
    log.error('Error updating signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update signal ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes a signal from Firestore.
 *
 * **WARNING:** This operation is permanent and cannot be undone.
 * Signals should generally not be deleted; instead, mark them as "Rejected"
 * for audit trail purposes.
 *
 * @param id - The ID of the signal to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Recommended: Reject instead of delete
 * await rejectSignal("spam-signal-123", "Not relevant");
 *
 * // Permanent deletion (use with caution)
 * await deleteSignal("spam-signal-123");
 * ```
 */
async function prepareSignalDeletion(id: string): Promise<number> {
  const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
  const linksDeleted = await deleteLinksForEntity('signal', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for signal', { linksDeleted, id });
  }

  const { deleteRelationsForEntity } = await import('@/lib/relations');
  const relationsDeleted = await deleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for signal', { relationsDeleted, id });
  }

  return relationsDeleted;
}

export async function deleteSignal(id: string): Promise<void> {
  try {
    await prepareSignalDeletion(id);

    await deleteDoc(doc(db, 'signals', id));
    log.info('Successfully deleted signal', { id });

    // Trigger Neo4j sync
    triggerEntitySync('signal', id, 'delete').catch((err) => {
      log.warn('Failed to trigger Neo4j sync for delete', { id, error: String(err) });
    });
  } catch (error) {
    log.error('Error deleting signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to delete signal ${id}`);
  }
}

// ============================================================================
// FILTERING & QUERYING
// ============================================================================

/**
 * Fetches signals filtered by status.
 * Useful for building signal review queues and dashboards.
 *
 * @param status - The status to filter by
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of matching Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get signals awaiting review
 * const pendingSignals = await getSignalsByStatus("Validated");
 *
 * // Get recently imported signals
 * const importedSignals = await getSignalsByStatus("Imported", 10);
 * ```
 */
export async function getSignalsByStatus(status: SignalStatus, maxResults?: number): Promise<Signal[]> {
  try {
    // Query without orderBy to avoid requiring composite index
    const q = query(collection(db, 'signals'), where('status', '==', status));

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching signals by status', error instanceof Error ? error : new Error(String(error)), {
      status,
    });
    throw new Error(`Failed to fetch signals by status ${status}`);
  }
}

/**
 * Fetches signals filtered by type.
 * Useful for analyzing signal sources and their effectiveness.
 *
 * @param type - The signal type to filter by
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of matching Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get all patent signals
 * const patentSignals = await getSignalsByType("patent");
 *
 * // Get recent GitHub signals
 * const githubSignals = await getSignalsByType("github", 20);
 * ```
 */
export async function getSignalsByType(type: SignalType, maxResults?: number): Promise<Signal[]> {
  try {
    // Query without orderBy to avoid requiring composite index
    const q = query(collection(db, 'signals'), where('type', '==', type));

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching signals by type', error instanceof Error ? error : new Error(String(error)), { type });
    throw new Error(`Failed to fetch signals by type ${type}`);
  }
}

/**
 * Fetches signals that need human review.
 * Returns signals with status "Validated" that are awaiting approval/rejection.
 *
 * **Used by:** Dashboard "Needs Attention" card, Signals Review page
 *
 * @param maxResults - Maximum number of results to return (default: 50)
 * @returns Promise resolving to an array of Signal objects needing review
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const pendingSignals = await getPendingSignals();
 * console.log(`${pendingSignals.length} signals awaiting your review`);
 * ```
 */
export async function getPendingSignals(maxResults: number = 50): Promise<Signal[]> {
  return getSignalsByStatus('Validated', maxResults);
}

/**
 * Fetches signals aligned with a specific strategy.
 * Shows which external signals support strategic goals.
 *
 * @param strategyId - The strategy ID
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Find signals supporting "Sustainability" strategy
 * const signals = await getSignalsByStrategy("sustainability-2025");
 * console.log(`Found ${signals.length} signals aligned with this strategy`);
 * ```
 */
export async function getSignalsByStrategy(strategyId: string, maxResults?: number): Promise<Signal[]> {
  try {
    // Query without orderBy to avoid requiring composite index
    const q = query(collection(db, 'signals'), where('alignedStrategies', 'array-contains', strategyId));

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching signals by strategy', error instanceof Error ? error : new Error(String(error)), {
      strategyId,
    });
    throw new Error(`Failed to fetch signals by strategy ${strategyId}`);
  }
}

/**
 * Fetches recent signals (last N days).
 * Useful for dashboard metrics and reporting.
 *
 * @param days - Number of days to look back (default: 7)
 * @returns Promise resolving to an array of recent Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get signals from last 24 hours
 * const recentSignals = await getRecentSignals(1);
 *
 * // Get signals from last week
 * const weeklySignals = await getRecentSignals(7);
 * ```
 */
export async function getRecentSignals(days: number = 7): Promise<Signal[]> {
  try {
    const cutoffDate = Date.now() - days * 24 * 60 * 60 * 1000;

    // Query without orderBy to avoid requiring composite index
    const q = query(collection(db, 'signals'), where('detectedAt', '>=', cutoffDate));

    const querySnapshot = await getDocs(q);
    const signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    return signals;
  } catch (error) {
    log.error('Error fetching recent signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch recent signals`);
  }
}

/**
 * Fetches high-confidence signals (relevance score >= threshold).
 * Identifies signals that are highly likely to be valuable.
 *
 * @param threshold - Minimum relevance score (default: 80)
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of high-confidence Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get very high confidence signals (>= 90%)
 * const highConfSignals = await getHighConfidenceSignals(90);
 *
 * // Get all signals above 80%
 * const goodSignals = await getHighConfidenceSignals(80);
 * ```
 */
export async function getHighConfidenceSignals(threshold: number = 80, maxResults?: number): Promise<Signal[]> {
  try {
    // Query without orderBy to avoid requiring composite index
    const q = query(collection(db, 'signals'), where('relevanceScore', '>=', threshold));

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by relevanceScore (highest first), then by detectedAt (newest first)
    signals.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return b.detectedAt - a.detectedAt;
    });

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching high-confidence signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch high-confidence signals`);
  }
}

/**
 * Bulk delete signals by their IDs.
 * Uses Firestore batch writes for better performance.
 *
 * @param ids - Array of signal IDs to delete
 * @returns Promise resolving to deletion result
 * @throws Error if batch write fails
 *
 * @example
 * ```typescript
 * const result = await deleteSignals(['signal-1', 'signal-2', 'signal-3']);
 * console.log(`Deleted ${result.deleted} signals`);
 * if (result.failed.length > 0) {
 *   console.warn(`Failed to delete: ${result.failed.join(', ')}`);
 * }
 * ```
 */
export async function deleteSignals(
  ids: string[]
): Promise<{ deleted: number; failed: string[]; relationsDeleted: number }> {
  const { writeBatch } = await import('firebase/firestore');

  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Firestore batch writes are limited to 500 operations
  const batchSize = 500;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize);
    const preparation = await prepareEntityDeletions(batchIds, prepareSignalDeletion);
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Signal cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    const batch = writeBatch(db);

    for (const { id } of preparation.prepared) {
      const docRef = doc(db, 'signals', id);
      batch.delete(docRef);
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;

      // Trigger Neo4j sync for each deleted signal
      const syncPromises = preparation.prepared.map(({ id }) =>
        triggerEntitySync('signal', id, 'delete').catch((err) => {
          log.warn('Failed to trigger Neo4j sync for delete', { id, error: String(err) });
        })
      );
      await Promise.allSettled(syncPromises);
    } catch (error) {
      log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  // Emit data refresh event for UI cache invalidation
  if (deleted > 0) {
    emitDataRefresh('signals', 'bulk-delete');
  }

  log.info('Deleted signals', { deleted, failed: failed.length, relationsDeleted });
  return { deleted, failed, relationsDeleted };
}

/**
 * Gets all signals created by a specific agent.
 *
 * @param agentId - The ID of the custom agent
 * @param maxResults - Maximum number of results (default: all)
 * @returns Promise resolving to signals created by this agent
 *
 * @example
 * ```typescript
 * const signals = await getSignalsByAgent('agent-123', 20);
 * console.log(`Agent created ${signals.length} signals`);
 * ```
 */
export async function getSignalsByAgent(agentId: string, maxResults?: number): Promise<Signal[]> {
  try {
    // Get all signals and filter by agentId (metadata.agentId)
    // Note: Firestore doesn't support querying nested fields efficiently,
    // so we fetch all and filter client-side
    const allSignals = await getSignals();
    let agentSignals = allSignals.filter((signal) => signal.metadata?.agentId === agentId);

    // Sort by detectedAt (newest first)
    agentSignals.sort((a, b) => b.detectedAt - a.detectedAt);

    // Apply limit if specified
    if (maxResults) {
      agentSignals = agentSignals.slice(0, maxResults);
    }

    return agentSignals;
  } catch (error) {
    log.error('Failed for agent', error instanceof Error ? error : new Error(String(error)), { agentId });
    throw new Error(`Failed to get signals for agent ${agentId}`);
  }
}

// ============================================================================
// ANALYTICS & REPORTING
// ============================================================================

/**
 * Calculates aggregate statistics for signals.
 * Useful for dashboard metrics, reporting, and evaluating signal sources.
 *
 * @returns Promise resolving to aggregated signal statistics
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const stats = await getSignalStatistics();
 * console.log(`Total signals: ${stats.total}`);
 * console.log(`Pending review: ${stats.pendingCount}`);
 * console.log(`Import rate: ${stats.importRate}%`);
 * console.log(`Average relevance: ${stats.averageRelevance}%`);
 * console.log(`Top source: ${stats.topSource}`);
 * ```
 */
export async function getSignalStatistics(): Promise<{
  total: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  importedCount: number;
  importRate: number;
  averageRelevance: number;
  averageAlignment: number;
  topSource: string;
  signalsByType: Record<SignalType, number>;
}> {
  try {
    const signals = await getSignals();

    const signalsByType: Record<SignalType, number> = {
      patent: 0,
      paper: 0,
      news: 0,
      funding: 0,
      github: 0,
      trend: 0,
      hackernews: 0,
      filing: 0,
    };

    const sourceCount: Record<string, number> = {};

    signals.forEach((signal) => {
      signalsByType[signal.type]++;
      sourceCount[signal.source] = (sourceCount[signal.source] || 0) + 1;
    });

    const topSource = Object.entries(sourceCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None';

    const importedCount = signals.filter((s) => s.status === 'Imported').length;
    const completedCount = signals.filter((s) => s.status === 'Imported' || s.status === 'Rejected').length;

    const stats = {
      total: signals.length,
      pendingCount: signals.filter((s) => s.status === 'Validated').length,
      approvedCount: signals.filter((s) => s.status === 'Approved').length,
      rejectedCount: signals.filter((s) => s.status === 'Rejected').length,
      importedCount,
      importRate: completedCount > 0 ? Math.round((importedCount / completedCount) * 100) : 0,
      averageRelevance: signals.length > 0 ? signals.reduce((sum, s) => sum + s.relevanceScore, 0) / signals.length : 0,
      averageAlignment: signals.length > 0 ? signals.reduce((sum, s) => sum + s.alignmentScore, 0) / signals.length : 0,
      topSource,
      signalsByType,
    };

    return stats;
  } catch (error) {
    log.error('Error calculating signal statistics', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to calculate signal statistics');
  }
}

/**
 * Fetches signals detected in a specific time range.
 * Useful for historical analysis and reporting.
 *
 * @param startDate - Start timestamp (milliseconds since epoch)
 * @param endDate - End timestamp (milliseconds since epoch)
 * @returns Promise resolving to an array of Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get signals from January 2025
 * const jan2025Start = new Date("2025-01-01").getTime();
 * const jan2025End = new Date("2025-02-01").getTime();
 * const janSignals = await getSignalsByDateRange(jan2025Start, jan2025End);
 * console.log(`Signals in January: ${janSignals.length}`);
 * ```
 */
export async function getSignalsByDateRange(startDate: number, endDate: number): Promise<Signal[]> {
  try {
    // Query without orderBy to avoid requiring composite index
    const q = query(
      collection(db, 'signals'),
      where('detectedAt', '>=', startDate),
      where('detectedAt', '<=', endDate)
    );

    const querySnapshot = await getDocs(q);
    const signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    return signals;
  } catch (error) {
    log.error('Error fetching signals by date range', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch signals by date range`);
  }
}

/**
 * Entity source lineage tracking.
 * Records the origin of an entity created from a signal.
 */
export interface EntitySource {
  type: 'signal';
  signalId: string;
  agentId?: string;
  importedAt: number;
  createdAt: number;
}
