/**
 * @file lib/technology-research.ts
 * @description TRL/TimeToImpact sync and technology-placement coordination.
 * Handles syncing technology metadata changes to radar placements.
 *
 * Split from technology-service.ts for maintainability.
 * Re-exported via technology-service.ts barrel for backward compatibility.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { emitDataRefresh } from '@/lib/events/data-refresh';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import type { Technology, TimeToImpact } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { getTechnologyById, updateTechnology } from './technology-core';

const log = createLogger('technology-service');

// ============================================================================
// TRL/TIME TO IMPACT SYNC (Phase 4)
// ============================================================================

/**
 * Result of TRL/TimeToImpact sync operation
 */
export interface TRLSyncResult {
  /** Number of placements successfully updated */
  updated: number;
  /** IDs of placements that failed to update */
  failed: string[];
  /** Error messages */
  errors: string[];
}

/**
 * Syncs TRL and TimeToImpact from a Technology to all its RadarPlacements.
 *
 * When TRL or TimeToImpact changes on a Technology, this function propagates
 * those values to all RadarPlacements that reference this technology. This
 * ensures consistency between the canonical Technology record and its placements.
 *
 * Note: This is one-way sync from Technology to Placements. For bidirectional
 * sync (when placement TRL changes), see radar-placement-service.ts.
 *
 * @param technologyId - The technology ID to sync from
 * @param trl - The new TRL value (1-9) or undefined to skip
 * @param timeToImpact - The new TimeToImpact value or undefined to skip
 * @returns Promise resolving to the sync result
 *
 * @example
 * ```typescript
 * // After updating technology TRL:
 * const result = await syncTRLToPlacementsOnUpdate('tech-123', 7, 'H1');
 * console.log(`Updated ${result.updated} placements`);
 * ```
 */
export async function syncTRLToPlacementsOnUpdate(
  technologyId: string,
  trl?: number,
  timeToImpact?: TimeToImpact
): Promise<TRLSyncResult> {
  const result: TRLSyncResult = {
    updated: 0,
    failed: [],
    errors: [],
  };

  // Nothing to sync if neither value is provided
  if (trl === undefined && timeToImpact === undefined) {
    return result;
  }

  try {
    // Import placement service to avoid circular dependencies
    const { getPlacementsForTechnology, updateRadarPlacement } = await import('./radar-placement-service');

    // Get all placements for this technology
    const placements = await getPlacementsForTechnology(technologyId);

    if (placements.length === 0) {
      log.info('No placements to sync for technology', { technologyId });
      return result;
    }

    log.info('Syncing TRL/TimeToImpact to placements', { count: placements.length, technologyId });

    // Update each placement
    for (const placement of placements) {
      try {
        const updates: Record<string, number | string | undefined> = {};

        // Only update if value changed
        if (trl !== undefined && placement.trlScore !== trl) {
          updates.trlScore = trl;
        }
        if (timeToImpact !== undefined && placement.timeToImpact !== timeToImpact) {
          updates.timeToImpact = timeToImpact;
        }

        // Skip if no updates needed
        if (Object.keys(updates).length === 0) {
          continue;
        }

        await updateRadarPlacement(placement.id, updates);
        result.updated++;
      } catch (error) {
        result.failed.push(placement.id);
        result.errors.push(`${placement.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    log.info('TRL/TimeToImpact sync complete', { updated: result.updated, failed: result.failed.length });

    // Emit data refresh event for radar placements if any were updated
    if (result.updated > 0) {
      emitDataRefresh('radarPlacements', 'trl-sync');
    }

    return result;
  } catch (error) {
    log.error('Error syncing TRL to placements', error instanceof Error ? error : new Error(String(error)));
    result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    return result;
  }
}

/**
 * Updates a technology and syncs TRL/TimeToImpact to placements if changed.
 *
 * This is a convenience function that combines updateTechnology with
 * TRL/TimeToImpact sync. Use this when you want to ensure placements
 * are automatically updated when TRL/TimeToImpact changes.
 *
 * @param id - The technology ID
 * @param updates - Partial updates to apply
 * @returns Promise resolving to the updated technology and sync result
 *
 * @example
 * ```typescript
 * const { technology, syncResult } = await updateTechnologyWithSync('tech-123', {
 *   trl: 7,
 *   timeToImpact: 'H1',
 * });
 * ```
 */
export async function updateTechnologyWithSync(
  id: string,
  updates: Partial<Omit<Technology, 'id' | 'createdAt' | 'createdBy'>>
): Promise<{ technology: Technology; syncResult: TRLSyncResult }> {
  // First, get the current technology to detect changes
  const current = await getTechnologyById(id);
  if (!current) {
    throw new Error(`Technology ${id} not found`);
  }

  // Check if TRL or TimeToImpact changed
  const trlChanged = updates.trl !== undefined && updates.trl !== current.trl;
  const timeToImpactChanged = updates.timeToImpact !== undefined && updates.timeToImpact !== current.timeToImpact;

  const syncPlacements = async (): Promise<TRLSyncResult> => {
    if (!trlChanged && !timeToImpactChanged) return { updated: 0, failed: [], errors: [] };
    return syncTRLToPlacementsOnUpdate(
      id,
      trlChanged ? updates.trl : undefined,
      timeToImpactChanged ? updates.timeToImpact : undefined
    );
  };

  let technology: Technology;
  try {
    technology = await updateTechnology(id, updates);
  } catch (error) {
    // GRAPH-058: `updateTechnology` requires an acknowledged graph handoff and
    // throws when it is lost — but the Firestore write is already committed, so
    // the TRL/TimeToImpact values the placements mirror really have changed.
    // Skipping the propagation here left placement snapshots stale for a reason
    // that has nothing to do with them. Propagate first, THEN rethrow, so the
    // caller can still present the write as saved locally.
    if (error instanceof EntitySyncDispatchError) {
      await syncPlacements().catch((syncError: unknown) => {
        log.warn('Placement sync failed after an unacknowledged technology graph handoff', {
          id,
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      });
    }
    throw error;
  }

  const syncResult = await syncPlacements();

  return { technology, syncResult };
}
