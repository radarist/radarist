/**
 * @file lib/radar-placement-service.ts
 * @description Service layer for RadarPlacement entity (Phase 1)
 *
 * This service manages where technologies are placed on radars (opinions).
 * RadarPlacements reference Technologies and capture position, ring, quadrant,
 * and rationale for the placement.
 *
 * **Collection**: `radarPlacements` (top-level)
 *
 * **Key Concept**: The same Technology can have multiple RadarPlacements
 * on different radars, enabling multi-radar support.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { triggerEntitySync } from '@/lib/entity-sync';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import {
  isBrowserRadarPlacementClient,
  createRadarPlacementViaApi,
  updateRadarPlacementViaApi,
  deleteRadarPlacementViaApi,
  deleteAllPlacementsForTechnologyViaApi,
  deleteAllPlacementsForRadarViaApi,
} from '@/lib/radar-placement-api-client';
import type {
  RadarPlacement,
  CreateRadarPlacementInput,
  UpdateRadarPlacementInput,
  Ring,
  Status,
  Technology,
  TechnologyWithPlacement,
  TimeToImpact,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('radar-placement-service');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Firestore collection name for radar placements */
const COLLECTION_NAME = 'radarPlacements';

/** Ring order for determining movement direction */
const RING_ORDER: Ring[] = ['Hold', 'Assess', 'Trial', 'Adopt'];

// ============================================================================
// TYPES
// ============================================================================

/**
 * Filter options for querying radar placements
 */
export interface RadarPlacementFilters {
  /** Filter by radar ID */
  radarId?: string;
  /** Filter by technology ID */
  technologyId?: string;
  /** Filter by stable quadrant id (from the target radar's quadrant config). */
  quadrantId?: string;
  /** Filter by ring */
  ring?: Ring;
  /** Filter by status */
  status?: Status;
  /** Filter by time-to-impact horizon */
  timeToImpact?: TimeToImpact;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Result of bulk operations
 */
export interface BulkOperationResult {
  /** Number of successful operations */
  succeeded: number;
  /** IDs that failed */
  failed: string[];
  /** Error messages for failed operations */
  errors: string[];
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generates a unique ID for a new placement
 */
function generateId(): string {
  return `placement-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Determines movement direction between rings
 */
function _calculateMovement(fromRing: Ring, toRing: Ring): number {
  const fromIndex = RING_ORDER.indexOf(fromRing);
  const toIndex = RING_ORDER.indexOf(toRing);

  if (fromIndex === -1 || toIndex === -1) return 0;
  if (toIndex > fromIndex) return 1; // Moving towards Adopt
  if (toIndex < fromIndex) return -1; // Moving towards Hold
  return 0;
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Gets all radar placements with optional filtering
 *
 * @param filters - Optional filters to apply
 * @returns Promise resolving to array of placements
 *
 * @example
 * ```typescript
 * // Get all placements for a radar
 * const placements = await getRadarPlacements({ radarId: 'my-radar' });
 *
 * // Get all placements in the Adopt ring
 * const adopted = await getRadarPlacements({ ring: 'Adopt' });
 * ```
 */
export async function getRadarPlacements(filters: RadarPlacementFilters = {}): Promise<RadarPlacement[]> {
  try {
    const placementsRef = collection(db, COLLECTION_NAME);
    const snapshot = await getDocs(placementsRef);

    let placements = snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    })) as RadarPlacement[];

    // Apply filters (in-memory to avoid composite index issues)
    if (filters.radarId) {
      placements = placements.filter((p) => p.radarId === filters.radarId);
    }

    if (filters.technologyId) {
      placements = placements.filter((p) => p.technologyId === filters.technologyId);
    }

    if (filters.quadrantId) {
      placements = placements.filter((p) => p.quadrantId === filters.quadrantId);
    }

    if (filters.ring) {
      placements = placements.filter((p) => p.ring === filters.ring);
    }

    if (filters.status) {
      placements = placements.filter((p) => p.status === filters.status);
    }

    if (filters.timeToImpact) {
      placements = placements.filter((p) => p.timeToImpact === filters.timeToImpact);
    }

    // Apply limit
    if (filters.limit) {
      placements = placements.slice(0, filters.limit);
    }

    return placements;
  } catch (error) {
    log.error('Error fetching placements', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placements: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Gets placements for a specific radar
 *
 * @param radarId - The radar ID
 * @returns Promise resolving to array of placements
 */
export async function getPlacementsByRadar(radarId: string): Promise<RadarPlacement[]> {
  return getRadarPlacements({ radarId });
}

/**
 * Gets all placements for a specific technology (across all radars)
 *
 * @param technologyId - The technology ID
 * @returns Promise resolving to array of placements
 */
export async function getPlacementsForTechnology(technologyId: string): Promise<RadarPlacement[]> {
  return getRadarPlacements({ technologyId });
}

/**
 * Gets a single placement by its ID
 *
 * @param id - The placement ID
 * @returns Promise resolving to the placement or null if not found
 */
export async function getRadarPlacementById(id: string): Promise<RadarPlacement | null> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return null;
    }

    return { ...docSnap.data(), id: docSnap.id } as RadarPlacement;
  } catch (error) {
    log.error('Error fetching placement by ID', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Gets a placement for a specific technology on a specific radar
 *
 * @param technologyId - The technology ID
 * @param radarId - The radar ID
 * @returns Promise resolving to the placement or null if not found
 */
export async function getPlacementForTechnologyOnRadar(
  technologyId: string,
  radarId: string
): Promise<RadarPlacement | null> {
  try {
    const placementsRef = collection(db, COLLECTION_NAME);
    const q = query(placementsRef, where('technologyId', '==', technologyId), where('radarId', '==', radarId));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return { ...doc.data(), id: doc.id } as RadarPlacement;
  } catch (error) {
    log.error('Error fetching placement', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Creates a new radar placement
 *
 * @param data - The placement data (without id, createdAt, updatedAt)
 * @returns Promise resolving to the created placement
 *
 * @example
 * ```typescript
 * const placement = await createRadarPlacement({
 *   technologyId: 'tech-123',
 *   radarId: 'my-radar',
 *   quadrant: 'languages-frameworks',
 *   ring: 'Adopt',
 *   rationale: 'Mature framework with strong team expertise',
 *   placedBy: 'user-456',
 * });
 * ```
 */
export async function createRadarPlacement(data: CreateRadarPlacementInput): Promise<RadarPlacement> {
  // GRAPH-060: in a browser, route through the authenticated same-origin handoff
  // instead of writing Firestore directly + emitting the graph-sync event via a
  // client Inngest sender that cannot reach the server-only local endpoint. The
  // server route re-runs the technology-existence and duplicate guards inside its
  // Admin-SDK transaction, so no validation is lost.
  if (isBrowserRadarPlacementClient()) return createRadarPlacementViaApi(data);
  try {
    // Verify the referenced Technology actually exists before recording any
    // placement. Without this guard, callers that pass a fabricated
    // `technologyId` create orphan placements that the radar-render path has
    // to filter and
    // warn on. Closing the gap at the service boundary covers every entry
    // point — AI tools, UI mutations, scripts, future server actions — with
    // one check.
    const { getTechnologyById } = await import('./technology-service');
    const technology = await getTechnologyById(data.technologyId);
    if (!technology) {
      throw new Error(`Cannot create placement: technology ${data.technologyId} does not exist`);
    }

    // Check if placement already exists for this technology on this radar
    const existing = await getPlacementForTechnologyOnRadar(data.technologyId, data.radarId);
    if (existing) {
      throw new Error(`Technology ${data.technologyId} is already placed on radar ${data.radarId}`);
    }

    const id = generateId();
    const now = Date.now();

    const placement: RadarPlacement = {
      id,
      technologyId: data.technologyId,
      radarId: data.radarId,
      quadrantId: data.quadrantId,
      ring: data.ring,
      rationale: data.rationale,
      x: data.x,
      y: data.y,
      status: data.status,
      timeToImpact: data.timeToImpact ?? 'unknown',
      trlScore: data.trlScore,
      technologySnapshot: data.technologySnapshot,
      createdAt: now,
      updatedAt: now,
      placedBy: data.placedBy,
    };

    // Remove undefined values (Firestore doesn't accept them)
    const cleanPlacement = Object.fromEntries(
      Object.entries(placement).filter(([_, v]) => v !== undefined)
    ) as RadarPlacement;

    const docRef = doc(db, COLLECTION_NAME, id);
    await setDoc(docRef, cleanPlacement);

    log.info('Created placement', { id, technologyId: data.technologyId, radarId: data.radarId });

    // Trigger Neo4j sync
    triggerEntitySync('radarPlacement', id, 'create', cleanPlacement as unknown as Record<string, unknown>).catch(
      (err) => {
        log.warn('Failed to trigger Neo4j sync for create', { id, error: String(err) });
      }
    );

    // Fire direct Inngest sync event (best-effort)
    try {
      const { inngest } = await import('@/lib/inngest/send-client');
      await inngest.send({
        name: 'app/radar-placement.sync.requested',
        data: { placementId: placement.id, operation: 'create' },
      });
    } catch {
      // Graph sync is best-effort
    }

    return cleanPlacement;
  } catch (error) {
    log.error('Error creating placement', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing radar placement
 *
 * Automatically tracks ring movement history when ring changes.
 *
 * @param id - The placement ID
 * @param updates - Partial updates to apply
 * @returns Promise resolving to the updated placement
 */
export async function updateRadarPlacement(
  id: string,
  // GRAPH-060 #1 (round 3) — the TS boundary omits BOTH immutable identity fields
  // (`technologyId`, `radarId`) plus server-owned audit fields, matching the runtime
  // `.strict()` schema so an identity change can't compile OR pass validation.
  updates: UpdateRadarPlacementInput
): Promise<RadarPlacement> {
  // GRAPH-060: browser updates (including ring moves) go through the authenticated
  // same-origin handoff. The server tracks movedFrom/movedAt on its side.
  if (isBrowserRadarPlacementClient()) return updateRadarPlacementViaApi(id, updates);
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`Placement ${id} not found`);
    }

    const currentData = docSnap.data() as RadarPlacement;
    const updatedData: Partial<RadarPlacement> = {
      ...updates,
      updatedAt: Date.now(),
    };

    // Track ring movement
    if (updates.ring && updates.ring !== currentData.ring) {
      updatedData.movedFrom = currentData.ring;
      updatedData.movedAt = Date.now();
    }

    // Remove undefined values
    const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([_, v]) => v !== undefined));

    await updateDoc(docRef, cleanUpdates);

    log.info('Updated placement', { id });

    // Trigger Neo4j sync
    triggerEntitySync('radarPlacement', id, 'update', cleanUpdates).catch((err) => {
      log.warn('Failed to trigger Neo4j sync for update', { id, error: String(err) });
    });

    // Fire direct Inngest sync event (best-effort)
    try {
      const { inngest } = await import('@/lib/inngest/send-client');
      await inngest.send({
        name: 'app/radar-placement.sync.requested',
        data: { placementId: id, operation: 'update' },
      });
    } catch {
      // Graph sync is best-effort
    }

    // Return the full updated document
    const updated = await getDoc(docRef);
    return { ...updated.data(), id: updated.id } as RadarPlacement;
  } catch (error) {
    log.error('Error updating placement', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to update placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Moves a technology to a different ring on a radar
 *
 * @param placementId - The placement ID
 * @param newRing - The new ring to move to
 * @param rationale - Optional rationale for the move
 * @returns Promise resolving to the updated placement
 */
export async function moveTechnologyRing(
  placementId: string,
  newRing: Ring,
  rationale?: string
): Promise<RadarPlacement> {
  return updateRadarPlacement(placementId, {
    ring: newRing,
    rationale: rationale,
  });
}

/**
 * Deletes a radar placement and its associated relations.
 *
 * @param id - The placement ID
 * @returns Promise resolving when deletion is complete
 */
export async function deleteRadarPlacement(id: string): Promise<void> {
  // GRAPH-060: browser deletes go through the authenticated same-origin handoff,
  // which performs the relation cascade + graph removal server-side.
  if (isBrowserRadarPlacementClient()) return deleteRadarPlacementViaApi(id);
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`Placement ${id} not found`);
    }

    // Clean up relations first (cascade delete)
    const { deleteRelationsForEntity } = await import('@/lib/relations');
    const relationsDeleted = await deleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for placement', { relationsDeleted, id });
    }

    await deleteDoc(docRef);
    log.info('Deleted placement', { id });

    // Trigger Neo4j sync
    triggerEntitySync('radarPlacement', id, 'delete').catch((err) => {
      log.warn('Failed to trigger Neo4j sync for delete', { id, error: String(err) });
    });

    // Fire direct Inngest sync event (best-effort)
    try {
      const { inngest } = await import('@/lib/inngest/send-client');
      await inngest.send({
        name: 'app/radar-placement.sync.requested',
        data: { placementId: id, operation: 'delete' },
      });
    } catch {
      // Graph sync is best-effort
    }
  } catch (error) {
    log.error('Error deleting placement', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to delete placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes all placements for a technology (used when deleting a technology)
 *
 * @param technologyId - The technology ID
 * @returns Promise resolving to the number of placements deleted
 */
export async function deleteAllPlacementsForTechnology(technologyId: string): Promise<number> {
  // GRAPH-060 #1: browser bulk deletes route through the authenticated server
  // cascade (firestore.rules deny direct client placement writes).
  if (isBrowserRadarPlacementClient()) return deleteAllPlacementsForTechnologyViaApi(technologyId);
  try {
    const placements = await getPlacementsForTechnology(technologyId);

    if (placements.length === 0) {
      return 0;
    }

    // Clean up relations for all placements first
    const { deleteRelationsForEntity } = await import('@/lib/relations');
    const relationResults = await Promise.all(placements.map((p) => deleteRelationsForEntity(p.id)));
    const totalRelationsDeleted = relationResults.reduce((sum, count) => sum + count, 0);
    if (totalRelationsDeleted > 0) {
      log.info('Cleaned up relations for placements', {
        totalRelationsDeleted,
        count: placements.length,
        technologyId,
      });
    }

    const batch = writeBatch(db);
    placements.forEach((placement) => {
      const docRef = doc(db, COLLECTION_NAME, placement.id);
      batch.delete(docRef);
    });

    await batch.commit();

    // Trigger Neo4j sync for each deleted placement
    const syncPromises = placements.map((placement) =>
      triggerEntitySync('radarPlacement', placement.id, 'delete').catch((err) => {
        log.warn('Failed to trigger Neo4j sync for delete', { id: placement.id, error: String(err) });
      })
    );
    await Promise.allSettled(syncPromises);

    log.info('Deleted placements for technology', { count: placements.length, technologyId });
    return placements.length;
  } catch (error) {
    log.error('Error deleting placements', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to delete placements: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes all placements for a radar (used when deleting a radar)
 *
 * @param radarId - The radar ID
 * @returns Promise resolving to the number of placements deleted
 */
export async function deleteAllPlacementsForRadar(radarId: string): Promise<number> {
  // GRAPH-060 #1: browser bulk deletes route through the authenticated server cascade.
  if (isBrowserRadarPlacementClient()) return deleteAllPlacementsForRadarViaApi(radarId);
  try {
    const placements = await getPlacementsByRadar(radarId);

    if (placements.length === 0) {
      return 0;
    }

    // Clean up relations for all placements first
    const { deleteRelationsForEntity } = await import('@/lib/relations');
    const relationResults = await Promise.all(placements.map((p) => deleteRelationsForEntity(p.id)));
    const totalRelationsDeleted = relationResults.reduce((sum, count) => sum + count, 0);
    if (totalRelationsDeleted > 0) {
      log.info('Cleaned up relations for placements', { totalRelationsDeleted, count: placements.length });
    }

    // Process in batches of 500 (Firestore limit)
    let deletedCount = 0;
    for (let i = 0; i < placements.length; i += 500) {
      const batchPlacements = placements.slice(i, i + 500);
      const batch = writeBatch(db);

      batchPlacements.forEach((placement) => {
        const docRef = doc(db, COLLECTION_NAME, placement.id);
        batch.delete(docRef);
      });

      await batch.commit();
      deletedCount += batchPlacements.length;

      // Do not fan out per-placement events here. `triggerEntitySync` is an
      // intentional no-op for radarPlacement, and independent sends after a
      // committed Firestore batch can fail partially with no source documents
      // left to reconstruct the missing IDs. `deleteRadar` performs one
      // required, idempotent cleanup handoff keyed by radarId after every batch
      // has committed.
    }

    // Emit data refresh event for UI cache invalidation
    if (deletedCount > 0) {
      emitDataRefresh('radarPlacements', 'bulk-delete');
    }

    log.info('Deleted placements for radar', { deletedCount, radarId });
    return deletedCount;
  } catch (error) {
    log.error('Error deleting placements', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to delete placements: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// COMBINED QUERIES (Technology + Placement)
// ============================================================================

/**
 * Gets technologies with their placements for a specific radar
 *
 * @param radarId - The radar ID
 * @returns Promise resolving to array of technologies with placements
 */
export async function getTechnologiesWithPlacementsForRadar(radarId: string): Promise<TechnologyWithPlacement[]> {
  try {
    // Import technology service dynamically to avoid circular dependencies
    const { getTechnologyById } = await import('./technology-service');

    // Get all placements for the radar
    const placements = await getPlacementsByRadar(radarId);

    // Fetch all technologies in parallel
    const results = await Promise.all(
      placements.map(async (placement) => {
        const technology = await getTechnologyById(placement.technologyId);
        if (!technology) {
          log.warn('Technology not found for placement', { technologyId: placement.technologyId, id: placement.id });
          return null;
        }

        return {
          ...technology,
          placement,
        } as TechnologyWithPlacement;
      })
    );

    // Filter out nulls (technologies that no longer exist)
    return results.filter((r): r is TechnologyWithPlacement => r !== null);
  } catch (error) {
    log.error('Error fetching technologies with placements', error instanceof Error ? error : new Error(String(error)));
    throw new Error(
      `Failed to fetch technologies with placements: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Gets all technologies with their placements across ALL radars
 *
 * Used by the Library Technologies page to display all technologies
 * regardless of which radar they're on.
 *
 * @returns Promise resolving to array of technologies with placements and radar metadata
 */
export async function getAllTechnologiesWithPlacements(): Promise<
  Array<TechnologyWithPlacement & { radarId: string; radarName: string }>
> {
  try {
    // Import technology service dynamically to avoid circular dependencies
    const { getTechnologyById } = await import('./technology-service');

    // Get all placements
    const placementsRef = collection(db, COLLECTION_NAME);
    const snapshot = await getDocs(placementsRef);
    const placements = snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    })) as RadarPlacement[];

    // Get radar names for each unique radarId
    const _radarIds = [...new Set(placements.map((p) => p.radarId))];
    const radarsRef = collection(db, 'radars');
    const radarsSnapshot = await getDocs(radarsRef);
    const radarNameMap = new Map<string, string>();
    radarsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      radarNameMap.set(data.id, data.name || data.id);
    });

    // Fetch all technologies in parallel
    const technologyIds = [...new Set(placements.map((p) => p.technologyId))];
    const technologiesPromises = technologyIds.map((id) => getTechnologyById(id));
    const technologiesResults = await Promise.all(technologiesPromises);

    // Build a map of technology ID -> technology
    const technologyMap = new Map<string, Technology | null>();
    technologyIds.forEach((id, index) => {
      technologyMap.set(id, technologiesResults[index]);
    });

    // Combine technologies with placements
    const results: Array<TechnologyWithPlacement & { radarId: string; radarName: string }> = [];

    for (const placement of placements) {
      const technology = technologyMap.get(placement.technologyId);
      if (!technology) {
        log.warn('Technology not found for placement', { technologyId: placement.technologyId, id: placement.id });
        continue;
      }

      results.push({
        ...technology,
        placement,
        radarId: placement.radarId,
        radarName: radarNameMap.get(placement.radarId) || placement.radarId,
      });
    }

    return results;
  } catch (error) {
    log.error(
      'Error fetching all technologies with placements',
      error instanceof Error ? error : new Error(String(error))
    );
    throw new Error(
      `Failed to fetch all technologies with placements: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Gets placement statistics for a radar
 *
 * @param radarId - The radar ID
 * @returns Promise resolving to statistics object
 */
export async function getRadarPlacementStats(radarId: string): Promise<{
  total: number;
  byRing: Record<Ring, number>;
  /**
   * Keyed by stable `quadrantId`. Each entry carries the display name resolved
   * from the parent radar's quadrant config, and the placement count. Display
   * components iterate `Object.values()` and read `.name` / `.count`.
   */
  byQuadrant: Record<string, { name: string; count: number }>;
  recentMoves: number;
}> {
  const placements = await getPlacementsByRadar(radarId);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Resolve the radar once so we can denormalize `quadrantName` per stat row
  const { getRadarById } = await import('@/lib/radars');
  const radar = await getRadarById(radarId);
  const nameById = new Map<string, string>();
  if (radar && Array.isArray(radar.quadrants)) {
    for (const q of radar.quadrants) {
      if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
        nameById.set(q.id as string, q.name as string);
      }
    }
  }

  const byRing: Record<string, number> = {
    Adopt: 0,
    Trial: 0,
    Assess: 0,
    Hold: 0,
  };

  const byQuadrant: Record<string, { name: string; count: number }> = {};
  let recentMoves = 0;

  placements.forEach((p) => {
    // Count by ring
    if (p.ring in byRing) {
      byRing[p.ring]++;
    }

    // Count by quadrant id, denormalizing the display name from the radar config
    const existing = byQuadrant[p.quadrantId];
    if (existing) {
      existing.count++;
    } else {
      byQuadrant[p.quadrantId] = {
        name: nameById.get(p.quadrantId) ?? '',
        count: 1,
      };
    }

    // Count recent moves
    if (p.movedAt && p.movedAt > thirtyDaysAgo) {
      recentMoves++;
    }
  });

  return {
    total: placements.length,
    byRing: byRing as Record<Ring, number>,
    byQuadrant,
    recentMoves,
  };
}

// ============================================================================
// BIDIRECTIONAL TRL/TIME TO IMPACT SYNC (Phase 4)
// ============================================================================

/**
 * Result of TRL/TimeToImpact sync from placement to technology
 */
export interface PlacementToTechSyncResult {
  /** Whether the sync was successful */
  success: boolean;
  /** Whether any fields were actually updated */
  updated: boolean;
  /** Error message if sync failed */
  error?: string;
}

/**
 * Syncs TRL and TimeToImpact from a RadarPlacement back to its Technology.
 *
 * This enables bidirectional sync: when a placement's TRL or TimeToImpact is
 * changed (e.g., during assessment on a specific radar), those values can
 * optionally be propagated back to the canonical Technology record.
 *
 * Use Case: An analyst evaluating a technology on a specific radar may
 * determine a more accurate TRL or time horizon. This function allows that
 * assessment to update the source Technology.
 *
 * Note: This is an opt-in operation. The updateRadarPlacement function does
 * NOT automatically sync back to avoid circular updates. Call this explicitly
 * when you want placement changes to update the technology.
 *
 * @param placementId - The placement ID to sync from
 * @returns Promise resolving to the sync result
 *
 * @example
 * ```typescript
 * // After updating a placement's TRL on a radar:
 * const result = await syncPlacementTRLToTechnology('placement-123');
 * if (result.updated) {
 *   console.log('Technology TRL updated from placement');
 * }
 * ```
 */
export async function syncPlacementTRLToTechnology(placementId: string): Promise<PlacementToTechSyncResult> {
  try {
    // Get the placement
    const placement = await getRadarPlacementById(placementId);
    if (!placement) {
      return {
        success: false,
        updated: false,
        error: `Placement ${placementId} not found`,
      };
    }

    // Import technology service to avoid circular dependencies
    const { getTechnologyById, updateTechnology } = await import('./technology-service');

    // Get the technology
    const technology = await getTechnologyById(placement.technologyId);
    if (!technology) {
      return {
        success: false,
        updated: false,
        error: `Technology ${placement.technologyId} not found`,
      };
    }

    // Check what needs to be updated
    const updates: Record<string, number | string | undefined> = {};

    // Sync TRL if placement has it and it's different
    if (placement.trlScore !== undefined && placement.trlScore !== technology.trl) {
      updates.trl = placement.trlScore;
    }

    // Sync TimeToImpact if placement has it and it's different (and not 'unknown')
    if (
      placement.timeToImpact &&
      placement.timeToImpact !== 'unknown' &&
      placement.timeToImpact !== technology.timeToImpact
    ) {
      updates.timeToImpact = placement.timeToImpact;
    }

    // Nothing to update
    if (Object.keys(updates).length === 0) {
      return {
        success: true,
        updated: false,
      };
    }

    // Update the technology (without triggering another sync to placements)
    await updateTechnology(placement.technologyId, updates);

    log.info('Synced TRL/TimeToImpact from placement to technology', {
      placementId,
      technologyId: placement.technologyId,
      updates,
    });

    return {
      success: true,
      updated: true,
    };
  } catch (error) {
    log.error('Error syncing placement to technology', error instanceof Error ? error : new Error(String(error)));
    return {
      success: false,
      updated: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Updates a radar placement and optionally syncs TRL/TimeToImpact back to the Technology.
 *
 * This is a convenience function that combines updateRadarPlacement with
 * an optional sync back to the Technology.
 *
 * @param id - The placement ID
 * @param updates - Partial updates to apply
 * @param syncToTechnology - Whether to sync TRL/TimeToImpact back to the Technology
 * @returns Promise resolving to the updated placement and sync result
 *
 * @example
 * ```typescript
 * // Update placement and sync TRL back to technology
 * const { placement, syncResult } = await updateRadarPlacementWithSync(
 *   'placement-123',
 *   { trlScore: 7, timeToImpact: 'H1' },
 *   true
 * );
 * ```
 */
export async function updateRadarPlacementWithSync(
  id: string,
  updates: Partial<Omit<RadarPlacement, 'id' | 'technologyId' | 'createdAt' | 'placedBy'>>,
  syncToTechnology: boolean = false
): Promise<{ placement: RadarPlacement; syncResult: PlacementToTechSyncResult | null }> {
  // Update the placement
  const placement = await updateRadarPlacement(id, updates);

  // Sync to technology if requested and TRL or TimeToImpact was updated
  let syncResult: PlacementToTechSyncResult | null = null;
  if (syncToTechnology && (updates.trlScore !== undefined || updates.timeToImpact !== undefined)) {
    syncResult = await syncPlacementTRLToTechnology(id);
  }

  return { placement, syncResult };
}
