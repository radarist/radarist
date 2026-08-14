/**
 * @file signals-approval.ts
 * @description Approval workflow and archival operations.
 *
 * Handles the signal lifecycle after detection:
 * - Approve/reject signals for import
 * - Mark signals as imported and track lineage (used by the radar-page
 *   drop-to-place workflow — see `markSignalAsImported`)
 * - Archive and restore signals
 * - Bulk archive and cleanup operations
 *
 * @author Radarist Team
 * @created 2025-11-25
 *
 * @deprecated (T27) This is a client-SDK module (`firebase/firestore`) with ZERO live server
 * callers — `approveSignal` / `rejectSignal` below throw `a540` if ever reached from a server
 * context because this client-SDK module is not server-safe. The LIVE approve/reject path is
 * `adminApproveSignal` / `adminRejectSignal` in `src/lib/signals-admin.ts`, which the AI chat
 * executors (`src/lib/ai/tools/signal-management.ts`) actually call, and which also folds
 * approvals/rejections into the interest-steering posterior via `steerSignalInterest`
 * (`src/lib/signals/feedback.ts`). Do not wire new callers to this file — use the admin twin.
 */

import { db } from '@/lib/firebase';
import { doc } from 'firebase/firestore';
import type { Signal, SignalStatus } from '@/lib/types';
import { getSignalById, updateSignal, deleteSignals } from './signals-core';
import { createLogger } from '@/lib/logger';
const log = createLogger('signals');

// ============================================================================
// WORKFLOW OPERATIONS
// ============================================================================

/**
 * Approves a signal for import.
 * Updates the signal status to "Approved" and records the review timestamp.
 *
 * @param signalId - The ID of the signal to approve
 * @param reviewNotes - Optional notes from the reviewer
 * @returns Promise that resolves when the signal is approved
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await approveSignal("patent-ai-flavor-123", "Excellent fit for Nutrition BU");
 * ```
 *
 * @deprecated Client-SDK, zero live server callers — use `adminApproveSignal` in
 * `src/lib/signals-admin.ts` (which also records interest-steering feedback).
 */
export async function approveSignal(signalId: string, reviewNotes?: string): Promise<void> {
  try {
    const updates: Partial<Signal> = {
      status: 'Approved',
      reviewedAt: Date.now(),
    };

    if (reviewNotes) {
      updates.validationNotes = updates.validationNotes
        ? `${updates.validationNotes}\n\nReview Notes: ${reviewNotes}`
        : `Review Notes: ${reviewNotes}`;
    }

    await updateSignal(signalId, updates);
    log.info('Approved signal', { signalId });
  } catch (error) {
    log.error('Error approving signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(`Failed to approve signal ${signalId}`);
  }
}

/**
 * Rejects a signal.
 * Updates the signal status to "Rejected" and records the review timestamp.
 * Rejected signals are kept for audit purposes.
 *
 * @param signalId - The ID of the signal to reject
 * @param reason - Reason for rejection (required)
 * @returns Promise that resolves when the signal is rejected
 * @throws Error if Firestore operation fails or reason not provided
 *
 * @example
 * ```typescript
 * await rejectSignal("spam-signal-123", "Not relevant to our business");
 * await rejectSignal("duplicate-signal-456", "Duplicate of existing technology");
 * ```
 *
 * @deprecated Client-SDK, zero live server callers — use `adminRejectSignal` in
 * `src/lib/signals-admin.ts` (which also records interest-steering feedback).
 */
export async function rejectSignal(signalId: string, reason: string): Promise<void> {
  try {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Rejection reason is required');
    }

    await updateSignal(signalId, {
      status: 'Rejected',
      reviewedAt: Date.now(),
      validationNotes: `Rejected: ${reason}`,
    });

    log.info('Rejected signal', { signalId });
  } catch (error) {
    log.error('Error rejecting signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(`Failed to reject signal ${signalId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Marks a signal as imported and records what it became.
 * Updates the signal status to "Imported" and links it to the created entity.
 *
 * **Used by:** The radar-page drop-to-place workflow (`src/app/radar/page.tsx`
 * via `signals-client.ts`), which places a signal directly onto a radar as a
 * technology placement.
 *
 * @param signalId - The ID of the signal to mark as imported
 * @param importedType - Type of entity created
 * @param importedId - ID of the created entity
 * @returns Promise that resolves when the signal is updated
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // After creating a technology from a signal
 * await markSignalAsImported("patent-ai-flavor-123", "technology", "tech-1706123456-abc123");
 *
 * // After creating a company from a signal
 * await markSignalAsImported("news-foodtech-456", "company", "foodtech-startup-789");
 * ```
 */
export async function markSignalAsImported(
  signalId: string,
  importedType: 'technology' | 'company' | 'useCase',
  importedId: string
): Promise<void> {
  try {
    await updateSignal(signalId, {
      status: 'Imported',
      processedAt: Date.now(),
      importedAs: {
        type: importedType,
        id: importedId,
      },
    });

    log.info('Marked signal as imported', { signalId, importedType, importedId });
  } catch (error) {
    log.error('Error marking signal as imported', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to mark signal as imported`);
  }
}

// ============================================================================
// ARCHIVE OPERATIONS (L4)
// ============================================================================

/**
 * Archives a signal.
 * Archived signals are kept for historical reference but hidden from the main view.
 * They can be restored or permanently deleted based on retention policy.
 *
 * @param signalId - The ID of the signal to archive
 * @param reason - Optional reason for archiving
 * @returns Promise that resolves when the signal is archived
 * @throws Error if Firestore operation fails or signal doesn't exist
 *
 * @example
 * ```typescript
 * await archiveSignal("old-signal-123", "No longer relevant");
 * ```
 */
export async function archiveSignal(signalId: string, reason?: string): Promise<void> {
  try {
    const signal = await getSignalById(signalId);
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    await updateSignal(signalId, {
      status: 'Archived' as SignalStatus,
      metadata: {
        ...signal.metadata,
        archivedAt: Date.now(),
        archiveReason: reason || 'Manual archive',
        previousStatus: signal.status,
      },
    });

    log.info('Archived signal', { signalId });
  } catch (error) {
    log.error('Error archiving signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(
      `Failed to archive signal ${signalId}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Restores an archived signal to its previous status.
 *
 * @param signalId - The ID of the signal to restore
 * @returns Promise that resolves when the signal is restored
 * @throws Error if Firestore operation fails or signal doesn't exist
 *
 * @example
 * ```typescript
 * await restoreSignal("archived-signal-123");
 * ```
 */
export async function restoreSignal(signalId: string): Promise<void> {
  try {
    const signal = await getSignalById(signalId);
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    if (signal.status !== 'Archived') {
      throw new Error(`Signal ${signalId} is not archived`);
    }

    const previousStatus = (signal.metadata?.previousStatus as SignalStatus) || 'Validated';
    const {
      archivedAt: _archivedAt,
      archiveReason: _archiveReason,
      previousStatus: _,
      ...restMetadata
    } = signal.metadata || {};

    await updateSignal(signalId, {
      status: previousStatus,
      metadata: {
        ...restMetadata,
        restoredAt: Date.now(),
      },
    });

    log.info('Restored signal: to status', { signalId, previousStatus });
  } catch (error) {
    log.error('Error restoring signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(
      `Failed to restore signal ${signalId}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Fetches all archived signals.
 * Returns signals with status "Archived", ordered by archive date (most recent first).
 *
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of archived Signal objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const archivedSignals = await getArchivedSignals();
 * console.log(`Total archived: ${archivedSignals.length}`);
 * ```
 */
export async function getArchivedSignals(maxResults?: number): Promise<Signal[]> {
  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore');
    const q = query(collection(db, 'signals'), where('status', '==', 'Archived'));

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map((doc) => doc.data() as Signal);

    // Sort by archivedAt (newest first), fallback to detectedAt
    signals.sort((a, b) => {
      const aDate = a.metadata?.archivedAt || a.detectedAt;
      const bDate = b.metadata?.archivedAt || b.detectedAt;
      return bDate - aDate;
    });

    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching archived signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch archived signals');
  }
}

/**
 * Bulk archive signals by their IDs.
 * Uses Firestore batch writes for better performance.
 *
 * @param ids - Array of signal IDs to archive
 * @param reason - Optional reason for archiving
 * @returns Promise resolving to archive result
 * @throws Error if batch write fails
 *
 * @example
 * ```typescript
 * const result = await archiveSignals(['signal-1', 'signal-2'], 'Bulk cleanup');
 * console.log(`Archived ${result.archived} signals`);
 * ```
 */
export async function archiveSignals(ids: string[], reason?: string): Promise<{ archived: number; failed: string[] }> {
  const { writeBatch } = await import('firebase/firestore');

  const failed: string[] = [];
  let archived = 0;
  const now = Date.now();

  // Firestore batch writes are limited to 500 operations
  const batchSize = 500;
  const batches = [];

  // First, get all signals to preserve their current status
  const signalsToArchive: Signal[] = [];
  for (const id of ids) {
    try {
      const signal = await getSignalById(id);
      if (signal && signal.status !== 'Archived') {
        signalsToArchive.push(signal);
      }
    } catch {
      failed.push(id);
    }
  }

  for (let i = 0; i < signalsToArchive.length; i += batchSize) {
    const batchSignals = signalsToArchive.slice(i, i + batchSize);
    const batch = writeBatch(db);

    for (const signal of batchSignals) {
      const docRef = doc(db, 'signals', signal.id);
      batch.update(docRef, {
        status: 'Archived',
        metadata: {
          ...signal.metadata,
          archivedAt: now,
          archiveReason: reason || 'Bulk archive',
          previousStatus: signal.status,
        },
      });
    }

    batches.push({ batch, signals: batchSignals });
  }

  // Execute batches
  for (const { batch, signals } of batches) {
    try {
      await batch.commit();
      archived += signals.length;
    } catch (error) {
      log.error('Batch archive failed', error instanceof Error ? error : new Error(String(error)));
      failed.push(...signals.map((s) => s.id));
    }
  }

  log.info('Archived signals', { archived, failed: failed.length });
  return { archived, failed };
}

/**
 * Permanently delete archived signals older than the retention period.
 * This is typically called by a scheduled cleanup job.
 *
 * @param retentionDays - Number of days to retain archived signals (default: 90)
 * @returns Promise resolving to cleanup result
 *
 * @example
 * ```typescript
 * // Delete archived signals older than 30 days
 * const result = await cleanupArchivedSignals(30);
 * console.log(`Deleted ${result.deleted} old archived signals`);
 * ```
 */
export async function cleanupArchivedSignals(
  retentionDays: number = 90
): Promise<{ deleted: number; failed: string[] }> {
  try {
    const cutoffDate = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const archivedSignals = await getArchivedSignals();

    // Filter signals archived before cutoff
    const signalsToDelete = archivedSignals.filter((signal) => {
      const archivedAt = signal.metadata?.archivedAt || signal.detectedAt;
      return archivedAt < cutoffDate;
    });

    if (signalsToDelete.length === 0) {
      log.info('No signals older than days to delete', { retentionDays });
      return { deleted: 0, failed: [] };
    }

    const result = await deleteSignals(signalsToDelete.map((s) => s.id));
    log.info('Deleted old archived signals', { deleted: result.deleted, retentionDays });
    return result;
  } catch (error) {
    log.error('Failed to cleanup archived signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to cleanup archived signals: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
