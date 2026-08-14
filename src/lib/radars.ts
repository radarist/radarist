/**
 * @file radars.ts
 * @description Data access layer for Radars and RadarEntries (legacy radar system).
 *
 * This service handles the legacy radar system where:
 * - Radars are stored in `radars` collection
 * - RadarEntries are stored in `radars/{radarId}/entries` subcollection
 *
 * Provides uniqueness enforcement to prevent duplicate radars and entries, and
 * orphan-aware quadrant updates: shrinking a radar's quadrant list is blocked
 * until every placement/entry that referenced a removed quadrant has been
 * reassigned or explicitly deleted.
 *
 * @author Radarist Team
 * @created 2026-01-17
 */

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit as firestoreLimit,
  runTransaction,
} from 'firebase/firestore';
import type { RadarData, RadarEntry, QuadrantConfig } from '@/lib/types';
import { buildDefaultQuadrantConfigs } from '@/lib/constants';
import { generateSlug, DuplicateEntityError } from '@/lib/entity-factory';
import { deleteAllPlacementsForRadar, getPlacementsByRadar } from '@/lib/radar-placement-service';
import { requestRadarGraphDeletion } from '@/lib/radar-deletion-sync';
import { createLogger } from '@/lib/logger';
import {
  OrphanedPlacementsError,
  prepareQuadrantConfigsForWrite,
  type OrphanGroup,
  type OrphanReport,
  type RadarStats,
  type UpdateRadarQuadrantsOptions,
} from '@/lib/radars-shared';
export {
  OrphanedPlacementsError,
  validateQuadrantConfigs,
  type OrphanGroup,
  type OrphanReport,
  type RadarStats,
  type UpdateRadarQuadrantsOptions,
} from '@/lib/radars-shared';
const log = createLogger('radars');

// ============================================================================
// RADAR OPERATIONS
// ============================================================================

/**
 * Creates a new radar with uniqueness enforcement.
 *
 * Accepts an optional `quadrants: QuadrantConfig[]` so AI tool executors and
 * seed scripts can create a radar with custom quadrants in a single round-trip.
 * When omitted, the radar is created with the 4 default quadrants.
 *
 * Throws DuplicateEntityError if a radar with the same slug already exists.
 *
 * @param name - The name of the radar
 * @param description - Optional description
 * @param quadrants - Optional custom quadrant configs (1..8 entries). Defaults
 *                    to `buildDefaultQuadrantConfigs()` when omitted.
 * @returns The created radar
 * @throws DuplicateEntityError if radar with same slug exists
 * @throws Error if quadrants validation fails (empty list, out-of-range count, empty names)
 */
export async function createRadar(
  name: string,
  description?: string,
  quadrants?: QuadrantConfig[]
): Promise<RadarData> {
  if (!name || name.trim().length === 0) {
    throw new Error('Radar name is required');
  }

  const configs = prepareQuadrantConfigsForWrite(quadrants ?? buildDefaultQuadrantConfigs());

  const slug = generateSlug(name);

  return runTransaction(db, async (transaction) => {
    // Check for existing radar with same slug (transaction-watched read)
    const radarsRef = collection(db, 'radars');
    const existingQuery = query(radarsRef, where('slug', '==', slug), firestoreLimit(1));
    const existingSnapshot = await getDocs(existingQuery);

    if (!existingSnapshot.empty) {
      const existingId = existingSnapshot.docs[0].id;
      throw new DuplicateEntityError('radar', 'slug', slug, existingId);
    }

    const id = `${slug}-${Date.now()}`;
    const now = Date.now();
    // GRAPH-060 #2 — stamp server-resolved ownership so the creator (and only the
    // creator) can mutate the radar's placements. Ownerless-unshared radars fail
    // closed in the authorization policy.
    let createdBy: string | undefined;
    try {
      const { getAuth } = await import('firebase/auth');
      createdBy = getAuth().currentUser?.uid ?? undefined;
    } catch {
      createdBy = undefined;
    }
    const newRadar: RadarData = {
      id,
      name: name.trim(),
      slug,
      description: description || '',
      quadrants: configs,
      entries: [],
      createdAt: now,
      updatedAt: now,
      ...(createdBy ? { createdBy } : {}),
    };

    transaction.set(doc(db, 'radars', id), newRadar);

    log.info('Created radar', { id, slug, quadrantCount: configs.length });
    return newRadar;
  });
}

/**
 * Gets a radar by ID.
 *
 * @param radarId - The radar ID
 * @returns The radar or null if not found
 */
export async function getRadarById(radarId: string): Promise<RadarData | null> {
  const docRef = doc(db, 'radars', radarId);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as RadarData;
  }
  return null;
}

// ============================================================================
// ORPHAN DETECTION
// ============================================================================

/**
 * Preflight helper: given a radar and a proposed new set of quadrant ids,
 * return every placement that currently references a quadrant NOT in the new
 * set.
 *
 * Read-only — callers decide whether to reassign, delete, or abort.
 */
export async function findOrphanPlacements(radarId: string, newQuadrantIds: string[]): Promise<OrphanReport> {
  const newIdSet = new Set(newQuadrantIds);

  // Read current radar (for quadrantName resolution when reporting)
  const radar = await getRadarById(radarId);
  const nameByOldId = new Map<string, string>();
  if (radar && Array.isArray(radar.quadrants)) {
    for (const q of radar.quadrants) {
      if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
        nameByOldId.set(q.id as string, q.name as string);
      }
    }
  }

  const placements = await getPlacementsByRadar(radarId);
  const orphanByQuadrant = new Map<string, OrphanGroup>();
  for (const p of placements) {
    if (!newIdSet.has(p.quadrantId)) {
      let group = orphanByQuadrant.get(p.quadrantId);
      if (!group) {
        group = {
          quadrantId: p.quadrantId,
          quadrantName: nameByOldId.get(p.quadrantId),
          placements: [],
        };
        orphanByQuadrant.set(p.quadrantId, group);
      }
      group.placements.push({
        id: p.id,
        technologyId: p.technologyId,
        ring: p.ring,
      });
    }
  }

  const orphans = Array.from(orphanByQuadrant.values());
  const totalPlacements = orphans.reduce((sum, g) => sum + g.placements.length, 0);

  return { orphans, totalPlacements };
}

// ============================================================================
// QUADRANT UPDATE
// ============================================================================

/**
 * Updates a radar's `quadrants` field. Orphan-aware.
 *
 * Algorithm:
 * 1. Validate the new configs (range, shape, unique ids).
 * 2. Run orphan detection — find placements referencing removed ids.
 * 3. If orphans exist and neither `reassignments` nor `deleteOrphans` is set,
 *    throw `OrphanedPlacementsError` carrying the full report.
 * 4. Resolve orphans via `reassignments` (move to new id) + `deleteOrphans`
 *    (delete the rest). Batched Firestore writes chunked at ≤400 ops.
 * 5. Write the new `quadrants` + `updatedAt` on the radar doc.
 * 6. Fire Neo4j sync events for every touched placement (delegated to
 *    `radar-placement-service.updateRadarPlacement` / `deleteRadarPlacement`).
 *
 * Returns a summary with the final configs and the reassigned/deleted counts.
 */
export async function updateRadarQuadrants(
  radarId: string,
  quadrants: QuadrantConfig[],
  options: UpdateRadarQuadrantsOptions = {}
): Promise<{ radar: RadarData; reassigned: number; deleted: number }> {
  const preparedQuadrants = prepareQuadrantConfigsForWrite(quadrants);

  const newIds = preparedQuadrants.map((q) => q.id);
  const report = await findOrphanPlacements(radarId, newIds);

  const reassignments = options.reassignments ?? {};
  const deleteOrphans = options.deleteOrphans === true;

  // Check: any orphan without a resolution?
  if (report.orphans.length > 0) {
    const unresolved = report.orphans.filter((g) => !reassignments[g.quadrantId] && !deleteOrphans);
    if (unresolved.length > 0) {
      throw new OrphanedPlacementsError(report);
    }
    // Any reassignment target must exist in the new id set
    for (const [oldId, newId] of Object.entries(reassignments)) {
      if (!newIds.includes(newId)) {
        throw new Error(`Reassignment target "${newId}" for orphan "${oldId}" is not in the new quadrants list`);
      }
    }
  }

  // Resolve orphans via batched writes (chunked ≤400 ops)
  let reassignedCount = 0;
  let deletedCount = 0;
  const { updateRadarPlacement: updatePlacementSvc, deleteRadarPlacement: deletePlacementSvc } =
    await import('@/lib/radar-placement-service');

  for (const group of report.orphans) {
    const targetId = reassignments[group.quadrantId];
    if (targetId) {
      for (const p of group.placements) {
        await updatePlacementSvc(p.id, { quadrantId: targetId });
        reassignedCount++;
      }
    } else if (deleteOrphans) {
      for (const p of group.placements) {
        await deletePlacementSvc(p.id);
        deletedCount++;
      }
    }
  }

  // Write the new quadrants on the radar doc (single update after orphan work)
  const docRef = doc(db, 'radars', radarId);
  const now = Date.now();
  await updateDoc(docRef, { quadrants: preparedQuadrants, updatedAt: now });

  const updatedSnap = await getDoc(docRef);
  const radar = updatedSnap.data() as RadarData;

  log.info('Updated radar quadrants', {
    radarId,
    count: preparedQuadrants.length,
    reassigned: reassignedCount,
    deleted: deletedCount,
  });

  return { radar, reassigned: reassignedCount, deleted: deletedCount };
}

/**
 * Gets all radars with optional statistics.
 *
 * @param includeStats - Whether to include placement statistics
 * @returns All radars in the system
 */
export async function getAllRadars(includeStats = false): Promise<(RadarData & { stats?: RadarStats })[]> {
  const radarsRef = collection(db, 'radars');
  const snapshot = await getDocs(radarsRef);

  const radars = snapshot.docs.map((doc) => ({
    ...doc.data(),
    id: doc.id,
  })) as RadarData[];

  if (!includeStats) {
    return radars;
  }

  // Get stats for each radar
  const { getRadarPlacementStats } = await import('@/lib/radar-placement-service');
  const radarsWithStats = await Promise.all(
    radars.map(async (radar) => {
      try {
        const placementStats = await getRadarPlacementStats(radar.id);
        return {
          ...radar,
          stats: {
            totalPlacements: placementStats.total,
            byRing: placementStats.byRing,
            byQuadrant: placementStats.byQuadrant,
          },
        };
      } catch (error) {
        log.warn('Failed to get stats for radar', { id: radar.id, error: String(error) });
        return {
          ...radar,
          stats: {
            totalPlacements: 0,
            byRing: {},
            byQuadrant: {},
          },
        };
      }
    })
  );

  return radarsWithStats;
}

/**
 * Updates a radar's settings (name, description, quadrants, ring system).
 *
 * Quadrant updates are delegated to `updateRadarQuadrants` so orphan handling
 * and range validation apply uniformly. Callers that need orphan-resolution
 * options pass them via `quadrantOptions`.
 *
 * @param radarId - The radar ID
 * @param updates - Fields to update
 * @param quadrantOptions - Options for orphan handling when `updates.quadrants` is provided
 * @returns The updated radar
 */
export async function updateRadar(
  radarId: string,
  updates: {
    name?: string;
    description?: string;
    quadrants?: QuadrantConfig[];
    ringSystem?: string;
    /** Public-link opt-in — see RadarData.shared (AUDIT-001). */
    shared?: boolean;
  },
  quadrantOptions?: UpdateRadarQuadrantsOptions
): Promise<RadarData> {
  const docRef = doc(db, 'radars', radarId);
  const docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    throw new Error(`Radar ${radarId} not found`);
  }

  const currentData = docSnap.data() as RadarData;

  // Quadrant updates go through the orphan-aware path
  if (updates.quadrants) {
    await updateRadarQuadrants(radarId, updates.quadrants, quadrantOptions);
  }

  // Build update object for non-quadrant fields
  const updateData: Partial<RadarData> & { updatedAt: number } = {
    updatedAt: Date.now(),
  };

  if (updates.name && updates.name !== currentData.name) {
    updateData.name = updates.name.trim();
    updateData.slug = generateSlug(updates.name);
  }

  if (updates.description !== undefined) {
    updateData.description = updates.description;
  }

  if (updates.shared !== undefined) {
    updateData.shared = updates.shared;
  }

  if (updates.ringSystem !== undefined) {
    // Store ring system in radar data (for UI display logic)
    (updateData as Record<string, unknown>).ringSystem = updates.ringSystem;
  }

  // Only write non-quadrant fields if there's anything to write beyond updatedAt
  if (Object.keys(updateData).length > 1) {
    await updateDoc(docRef, updateData);
  }

  log.info('Updated radar', { radarId, fields: Object.keys(updateData) });

  // Return updated radar
  const updated = await getDoc(docRef);
  return updated.data() as RadarData;
}

/**
 * Deletes a radar and optionally all its placements (cascade delete).
 *
 * @param radarId - The radar ID
 * @param cascadeDelete - Whether to delete all placements (default: true)
 * @returns Number of placements deleted (if cascading)
 */
export async function deleteRadar(radarId: string, cascadeDelete = true): Promise<{ placementsDeleted: number }> {
  const docRef = doc(db, 'radars', radarId);
  const docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    throw new Error(`Radar ${radarId} not found`);
  }

  let placementsDeleted = 0;

  // Cascade delete placements first if enabled
  if (cascadeDelete) {
    try {
      placementsDeleted = await deleteAllPlacementsForRadar(radarId);
      log.info('Cascade deleted placements for radar', { placementsDeleted, radarId });
    } catch (error) {
      log.error('Error deleting placements for radar', error instanceof Error ? error : new Error(String(error)), {
        radarId,
      });
      throw new Error(`Failed to delete radar placements: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    const remainingPlacements = await getPlacementsByRadar(radarId);
    if (remainingPlacements.length > 0) {
      throw new Error(
        `Cannot delete radar ${radarId} without cascading: ${remainingPlacements.length} placement(s) still reference it`
      );
    }
  }

  // This is a required handoff, not a best-effort notification. The graph
  // worker deletes every placement it can still find by radarId, including
  // graph-only residue, before removing the synthetic Radar node. Dispatching
  // before the final Firestore delete leaves the radar doc as a retry anchor if
  // Inngest is temporarily unavailable. The handoff and final delete are not
  // atomic: if deleteDoc fails after acceptance, retrying this idempotent flow
  // converges the stores.
  try {
    await requestRadarGraphDeletion(radarId, cascadeDelete);
  } catch (error) {
    log.error('Failed to schedule radar graph cleanup', error instanceof Error ? error : new Error(String(error)), {
      radarId,
    });
    throw new Error(
      `Failed to schedule radar graph cleanup: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Delete the radar document
  await deleteDoc(docRef);
  log.info('Deleted radar', { radarId });

  return { placementsDeleted };
}

// ============================================================================
// RADAR ENTRY OPERATIONS
// ============================================================================

/**
 * Read-only scan of the legacy `radars/{id}/entries` subcollection.
 *
 * Production code uses the decoupled `Technology` + `RadarPlacement` model
 * — entries are no longer written here. This helper survives only because
 * guarded maintenance tooling still needs to detect stale legacy data.
 * Do not use it from product code.
 *
 * @param radarId - The radar ID
 * @returns Array of legacy radar entries (may be empty)
 */
export async function getRadarEntries(radarId: string): Promise<RadarEntry[]> {
  const entriesRef = collection(db, `radars/${radarId}/entries`);
  const snapshot = await getDocs(entriesRef);
  return snapshot.docs.map((doc) => doc.data() as RadarEntry);
}
