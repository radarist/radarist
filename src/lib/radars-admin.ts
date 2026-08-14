/**
 * @file radars-admin.ts
 * @description Narrow admin-SDK helpers for the small set of radar
 * operations the AI assistant invokes from the server side.
 *
 * Why this exists: `src/lib/radars.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and
 * client-side hooks call into it from the browser, where a persistent
 * connection is fine. The `/api/ai/chat` route, however, executes
 * tool calls on the server inside a stateless serverless function —
 * the client SDK can't hold a connection there and reads time out or
 * return `code: 'unavailable'` (the same failure mode observed in Inngest
 * workers).
 *
 * This file exposes the Radar operations the AI assistant needs from the
 * server, including durable graph projection after create/update:
 *
 *   - adminListRadars()         — for the `listRadars` tool
 *   - adminCreateRadar()        — for the `createRadar` tool
 *   - adminUpdateRadar()        — for the `updateRadarSettings` tool
 *   - adminDeleteRadar(id, …)   — for the `deleteRadar` tool
 *
 * Anything richer (orphan checks, quadrant migration, etc.) should
 * stay on the client-SDK service module — the AI tools don't need it
 * and we don't want to duplicate the orphan logic.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { isRadarMutableBy } from '@/lib/radar-authorization';
import { buildDefaultQuadrantConfigs } from '@/lib/constants';
import { generateSlug, DuplicateEntityError } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';
import { requestRadarGraphProjection } from '@/lib/radar-projection-sync';
import { requestRadarGraphDeletion } from '@/lib/radar-deletion-sync';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
// Shared orphan error + validation reused from the client service so the two
// write paths can NEVER drift. The error/validator are values (used below); the
// rest are types re-exported for `instanceof`-symmetry with the client path.
import {
  OrphanedPlacementsError,
  prepareQuadrantConfigsForWrite,
  validateQuadrantConfigs,
  type OrphanReport,
  type UpdateRadarQuadrantsOptions,
  type RadarStats,
} from '@/lib/radars-shared';
import type { QuadrantConfig, RadarData, RadarPlacement, Technology, TechnologyWithPlacement } from '@/lib/types';

const log = createLogger('radars-admin');

/**
 * GRAPH-060 #1/#2 — thrown when a user-triggered admin radar mutation is invoked
 * by a non-owner, for a missing/ownerless radar, or with no acting owner at all.
 * The API route maps this to 403; the missing-radar and foreign-radar cases are
 * deliberately the SAME error so a caller can't probe existence by id.
 */
export class RadarAuthorizationError extends Error {
  public readonly radarId: string;
  constructor(radarId: string) {
    super(`Not authorized to mutate radar ${radarId}`);
    this.name = 'RadarAuthorizationError';
    this.radarId = radarId;
  }
}

/**
 * Load `radarId` and assert `ownerId` may mutate it under the owner-only policy.
 * Returns the radar so callers can reuse it; throws RadarAuthorizationError for a
 * foreign, ownerless, or missing radar.
 *
 * GRAPH-060 #2 — every user-facing mutation primitive (`adminDeleteRadar`,
 * `adminUpdateRadar`) takes a REQUIRED `ownerId` and always calls this. There is
 * no optional `requireOwnerId?` that a caller can silently omit to disable
 * authorization: an empty/whitespace owner fails closed here BEFORE any read, so
 * a caller that threads an absent `context?.userId` (undefined → '') can never
 * mutate. If a genuine system-only bypass is ever required, add a separately
 * named internal capability — never a nullable owner on these primitives.
 */
async function assertRadarOwnedBy(radarId: string, ownerId: string): Promise<RadarData> {
  // Fail closed before touching Firestore when no acting owner was supplied, so
  // an unauthenticated call refuses "before reads or writes".
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw new RadarAuthorizationError(radarId);
  }
  const radar = await adminGetRadarById(radarId);
  if (!isRadarMutableBy(radar, ownerId)) {
    throw new RadarAuthorizationError(radarId);
  }
  return radar as RadarData;
}

/**
 * GRAPH-060 #2 — owner-scoped radar resolver. Returns the radar ONLY if `ownerId`
 * owns it; throws the SAME `RadarAuthorizationError` for a missing, foreign,
 * ownerless, or owner-absent radar. Callers must resolve a target through THIS
 * boundary before doing anything that would otherwise reveal the radar's name or
 * existence to a non-owner (e.g. building a destructive-confirmation prompt). A
 * non-owner learns nothing: every denial is indistinguishable.
 */
export async function adminGetOwnedRadarById(radarId: string, ownerId: string): Promise<RadarData> {
  return assertRadarOwnedBy(radarId, ownerId);
}

/**
 * List all radars from the `radars` collection. No subcollection
 * reads, no stats join — the AI assistant only needs ids + names +
 * quadrants to disambiguate and to pass back to follow-up tool calls.
 */
export async function adminListRadars(): Promise<RadarData[]> {
  const snap = await db.collection('radars').get();
  return snap.docs.map((doc) => ({
    ...(doc.data() as Omit<RadarData, 'id'>),
    id: doc.id,
  }));
}

/**
 * Delete a radar by id, optionally cascading its placements. Returns
 * the number of placements removed so the AI assistant can report
 * back something concrete to the user.
 */
export async function adminDeleteRadar(
  radarId: string,
  ownerId: string,
  options: { cascade?: boolean } = {}
): Promise<{ placementsDeleted: number }> {
  const cascade = options.cascade ?? true;

  // GRAPH-060 #2 — owner-only, ALWAYS enforced. `ownerId` is required, so a
  // non-owner (or a probe for a missing radar, or an absent/empty owner) fails
  // closed BEFORE any read/delete and mutates nothing. There is no code path that
  // reaches the deletion below without an owner check.
  await assertRadarOwnedBy(radarId, ownerId);

  // GRAPH-066 #3 — this cascade snapshots the placements and only then deletes
  // them and the radar. Without the parent-deletion barrier a create landing in
  // that window is absent from the snapshot and survives as an orphan placement
  // (plus an orphan pair lock) pointing at a radar that no longer exists. The
  // barrier is bounded, so an interrupted cascade cannot block creates forever.
  const { withPlacementParentDeletionLease } = await import('@/lib/radar-placement-admin');
  return withPlacementParentDeletionLease('radar', radarId, () => deleteRadarUnderLease(radarId, cascade));
}

async function deleteRadarUnderLease(radarId: string, cascade: boolean): Promise<{ placementsDeleted: number }> {
  const placements = await db.collection('radarPlacements').where('radarId', '==', radarId).get();

  if (!cascade && !placements.empty) {
    throw new Error(
      `Cannot delete radar ${radarId} without cascading: ${placements.size} placement(s) still reference it`
    );
  }

  if (cascade) {
    // Clean placement-owned relations before deleting placements. The single
    // placement path enforces the same rule; bypassing it here left orphaned
    // Firestore relations after whole-radar deletion.
    if (!placements.empty) {
      const preparation = await prepareEntityDeletions(
        placements.docs.map((placement) => placement.id),
        (placementId) => adminDeleteRelationsForEntity(placementId)
      );
      if (preparation.failed.length > 0) {
        const failedIds = preparation.failed.map(({ id }) => id).join(', ');
        throw new Error(`Cannot delete radar ${radarId}: relation cleanup failed for placement(s) ${failedIds}`);
      }

      // GRAPH-066 #8 — route placement removal through the lock-aware bulk
      // primitive so every deleted placement also drops its pair lock and leaves
      // a durable delete tombstone (was: a raw doc-delete batch that orphaned the
      // radarPlacementPairs locks). Relation cleanup already ran above; the
      // primitive's idempotent relation pass is a no-op here.
      const { adminCascadeDeletePlacements } = await import('@/lib/radar-placement-admin');
      await adminCascadeDeletePlacements(
        placements.docs.map((placement) => {
          const data = placement.data() as { technologyId: string };
          return { id: placement.id, radarId, technologyId: data.technologyId };
        }),
        { skipRelationCascade: true } // relations already cleaned by prepareEntityDeletions above
      );
    }
  }

  // Required graph handoff: if this fails, leave the radar document in
  // Firestore so the deletion can be retried. Placement batches may already be
  // committed, but the idempotent graph job queries Neo4j by radarId and does
  // not depend on those Firestore documents. The handoff and final delete are
  // not atomic; a retry converges if the final Firestore delete fails after the
  // event was accepted.
  await requestRadarGraphDeletion(radarId, cascade);
  await db.collection('radars').doc(radarId).delete();
  log.info(cascade ? 'Radar deleted (cascade)' : 'Radar deleted (no cascade)', {
    radarId,
    placementsDeleted: cascade ? placements.size : 0,
  });
  return { placementsDeleted: cascade ? placements.size : 0 };
}

/**
 * Single radar doc by id (admin SDK). Mirrors `getRadarById` from
 * `@/lib/radars` so the `getRadarDetails` tool executor doesn't need
 * to reach the client SDK from the chat route.
 */
export async function adminGetRadarById(radarId: string): Promise<RadarData | null> {
  const snap = await db.collection('radars').doc(radarId).get();
  if (!snap.exists) return null;
  return { ...(snap.data() as Omit<RadarData, 'id'>), id: snap.id };
}

// ============================================================================
// RADAR WRITES (admin SDK)
//
// `createRadar` / `updateRadar` in `@/lib/radars` use the Firebase CLIENT SDK
// (own `runTransaction` + `firebase/firestore`). When the AI tool executors in
// `radar-management.ts` invoke them from the stateless `/api/ai/chat` route the
// client SDK times out / returns `code: 'unavailable'` — the same failure mode
// the read/delete tools already routed through this file to dodge. These admin
// twins replicate the client semantics EXACTLY: same slug (generateSlug), same
// id format (`${slug}-${Date.now()}`), same RadarData shape + audit fields,
// same quadrant validation, same DuplicateEntityError, same orphan-aware
// quadrant-shrink path, and the same post-commit Inngest sync events for every
// touched placement. The orphan/range error TYPES are re-exported from
// `@/lib/radars-shared` so callers can `instanceof`-branch identically across both
// paths.
// ============================================================================

// Re-export the shared orphan types + error so admin callers branch on the
// exact same classes the client service throws. Never redeclare these here —
// they must stay single-source so the two paths can't drift.
export {
  OrphanedPlacementsError,
  validateQuadrantConfigs,
  type OrphanGroup,
  type OrphanReport,
  type UpdateRadarQuadrantsOptions,
  type RadarStats,
} from '@/lib/radars-shared';

/**
 * Admin-SDK equivalent of `createRadar` from `@/lib/radars`.
 *
 * Replicates the client transaction one-for-one: validates the quadrant
 * configs (defaulting to `buildDefaultQuadrantConfigs()` when omitted), checks
 * slug uniqueness inside an admin transaction (reads-before-writes), and writes
 * the radar with the SAME id format and audit fields. Throws the SAME
 * `DuplicateEntityError` (imported, never redeclared) on a slug collision.
 *
 * GRAPH-060 #1 — `ownerId` is REQUIRED (the authenticated creator's uid) and is
 * persisted as `createdBy`, so the creator OWNS the radar and the owner-only
 * authorization policy (`isRadarMutableBy`) applies immediately. A create with no
 * authenticated owner fails closed — an ownerless radar is not mutable by anyone.
 *
 * @throws Error if ownerId/name is empty or quadrant validation fails.
 * @throws DuplicateEntityError if a radar with the same slug already exists.
 */
export async function adminCreateRadar(
  ownerId: string,
  name: string,
  description?: string,
  quadrants?: QuadrantConfig[]
): Promise<RadarData> {
  if (!ownerId || ownerId.trim().length === 0) {
    throw new Error('An authenticated owner (ownerId) is required to create a radar');
  }
  if (!name || name.trim().length === 0) {
    throw new Error('Radar name is required');
  }

  const configs = prepareQuadrantConfigsForWrite(quadrants ?? buildDefaultQuadrantConfigs());

  const slug = generateSlug(name);

  const newRadar = await db.runTransaction(async (transaction) => {
    // Slug-uniqueness check (transaction-watched read), mirroring the client path.
    const existingQuery = db.collection('radars').where('slug', '==', slug).limit(1);
    const existingSnapshot = await transaction.get(existingQuery);

    if (!existingSnapshot.empty) {
      const existingId = existingSnapshot.docs[0].id;
      throw new DuplicateEntityError('radar', 'slug', slug, existingId);
    }

    const id = `${slug}-${Date.now()}`;
    const now = Date.now();
    const newRadar: RadarData = {
      id,
      name: name.trim(),
      slug,
      description: description || '',
      quadrants: configs,
      entries: [],
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
    };

    transaction.set(db.collection('radars').doc(id), newRadar);

    log.info('Created radar', { id, slug, quadrantCount: configs.length, createdBy: ownerId });
    return newRadar;
  });

  // This is a required post-commit handoff. If acceptance is unavailable or
  // ambiguous, propagate the error: the Radar remains committed as the
  // reconciliation/replay anchor, but the assistant must not claim graph
  // convergence that was never acknowledged.
  await requestRadarGraphProjection(newRadar);
  return newRadar;
}

/**
 * Admin-SDK preflight orphan scan. Mirrors `findOrphanPlacements` from
 * `@/lib/radars`: given a radar and the proposed new quadrant ids, returns
 * every placement that currently references a quadrant NOT in the new set.
 * Read-only — callers decide reassign / delete / abort.
 */
async function adminFindOrphanPlacements(radarId: string, newQuadrantIds: string[]): Promise<OrphanReport> {
  const newIdSet = new Set(newQuadrantIds);

  const radar = await adminGetRadarById(radarId);
  const nameByOldId = new Map<string, string>();
  if (radar && Array.isArray(radar.quadrants)) {
    for (const q of radar.quadrants) {
      if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
        nameByOldId.set(q.id as string, q.name as string);
      }
    }
  }

  const placements = await adminGetRadarPlacements({ radarId });
  const orphanByQuadrant = new Map<string, OrphanReport['orphans'][number]>();
  for (const p of placements) {
    if (!newIdSet.has(p.quadrantId)) {
      let group = orphanByQuadrant.get(p.quadrantId);
      if (!group) {
        group = { quadrantId: p.quadrantId, quadrantName: nameByOldId.get(p.quadrantId), placements: [] };
        orphanByQuadrant.set(p.quadrantId, group);
      }
      group.placements.push({ id: p.id, technologyId: p.technologyId, ring: p.ring });
    }
  }

  const orphans = Array.from(orphanByQuadrant.values());
  const totalPlacements = orphans.reduce((sum, g) => sum + g.placements.length, 0);
  return { orphans, totalPlacements };
}

/**
 * Admin reassign of an orphaned placement to a surviving quadrant. GRAPH-066 —
 * routed through the lock-aware placement primitive so this path can no longer
 * write the document raw: the pair lock must still own the placement, and the
 * target quadrant must be in the prospective set the radar is about to adopt.
 */
async function adminReassignPlacement(
  placementId: string,
  newQuadrantId: string,
  prospectiveQuadrantIds: readonly string[]
): Promise<void> {
  const { adminReassignPlacementQuadrant } = await import('@/lib/radar-placement-admin');
  await adminReassignPlacementQuadrant(placementId, newQuadrantId, prospectiveQuadrantIds);
}

/**
 * Admin delete of an orphaned placement (quadrant removed). GRAPH-066 #8 — route
 * through the lock-aware primitive so the pair lock is removed and a durable
 * delete tombstone is written (was: a bare doc delete + best-effort sync).
 */
async function adminDeletePlacement(placementId: string): Promise<void> {
  const { adminDeleteRadarPlacement } = await import('@/lib/radar-placement-admin');
  await adminDeleteRadarPlacement(placementId);
}

/** Resolve orphaned placements before the Radar mutation commits. */
async function prepareAdminRadarQuadrantUpdate(
  radarId: string,
  quadrants: QuadrantConfig[],
  options: UpdateRadarQuadrantsOptions = {}
): Promise<{ reassigned: number; deleted: number }> {
  validateQuadrantConfigs(quadrants);

  const newIds = quadrants.map((q) => q.id);
  const report = await adminFindOrphanPlacements(radarId, newIds);

  const reassignments = options.reassignments ?? {};
  const deleteOrphans = options.deleteOrphans === true;

  if (report.orphans.length > 0) {
    const unresolved = report.orphans.filter((g) => !reassignments[g.quadrantId] && !deleteOrphans);
    if (unresolved.length > 0) {
      throw new OrphanedPlacementsError(report);
    }
    for (const [oldId, newId] of Object.entries(reassignments)) {
      if (!newIds.includes(newId)) {
        throw new Error(`Reassignment target "${newId}" for orphan "${oldId}" is not in the new quadrants list`);
      }
    }
  }

  let reassignedCount = 0;
  let deletedCount = 0;
  for (const group of report.orphans) {
    const targetId = reassignments[group.quadrantId];
    if (targetId) {
      for (const p of group.placements) {
        await adminReassignPlacement(p.id, targetId, newIds);
        reassignedCount++;
      }
    } else if (deleteOrphans) {
      for (const p of group.placements) {
        await adminDeletePlacement(p.id);
        deletedCount++;
      }
    }
  }

  return { reassigned: reassignedCount, deleted: deletedCount };
}

interface AdminRadarMutation {
  name?: string;
  description?: string;
  quadrants?: QuadrantConfig[];
  ringSystem?: string;
}

/** Commit content and its unique monotonic projection version atomically. */
async function commitAdminRadarMutation(
  radarId: string,
  updates: AdminRadarMutation
): Promise<{ radar: RadarData; changed: boolean }> {
  const docRef = db.collection('radars').doc(radarId);

  return await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
      throw new Error(`Radar ${radarId} not found`);
    }

    const current = snapshot.data() as RadarData;
    const updateData: Partial<RadarData> = {};

    if (updates.name && updates.name !== current.name) {
      updateData.name = updates.name.trim();
      updateData.slug = generateSlug(updates.name);
    }
    if (updates.description !== undefined) {
      updateData.description = updates.description;
    }
    if (updates.quadrants !== undefined) {
      updateData.quadrants = prepareQuadrantConfigsForWrite(updates.quadrants);
    }
    if (updates.ringSystem !== undefined) {
      (updateData as Record<string, unknown>).ringSystem = updates.ringSystem;
    }

    if (Object.keys(updateData).length === 0) {
      return { radar: { ...current, id: snapshot.id }, changed: false };
    }

    const latestVersion = current.updatedAt ?? current.createdAt ?? 0;
    const updatedAt = Math.max(Date.now(), latestVersion + 1);
    const committedData = { ...updateData, updatedAt };
    transaction.update(docRef, committedData);

    return {
      radar: { ...current, ...committedData, id: snapshot.id } as RadarData,
      changed: true,
    };
  });
}

/**
 * Admin-SDK equivalent of `updateRadarQuadrants` from `@/lib/radars`.
 * Orphan-aware and projection-safe when called directly.
 */
export async function adminUpdateRadarQuadrants(
  radarId: string,
  quadrants: QuadrantConfig[],
  options: UpdateRadarQuadrantsOptions = {}
): Promise<{ radar: RadarData; reassigned: number; deleted: number }> {
  const { reassigned, deleted } = await prepareAdminRadarQuadrantUpdate(radarId, quadrants, options);
  const { radar } = await commitAdminRadarMutation(radarId, { quadrants });
  await requestRadarGraphProjection(radar);

  log.info('Updated radar quadrants', {
    radarId,
    count: quadrants.length,
    reassigned,
    deleted,
  });
  return { radar, reassigned, deleted };
}

/**
 * Admin-SDK equivalent of `updateRadar` from `@/lib/radars`.
 *
 * Quadrant updates share the same orphan-aware preparation as
 * `adminUpdateRadarQuadrants`; all Radar fields and their projection revision
 * then commit atomically. Returns the updated radar.
 *
 * @throws Error if the radar does not exist.
 * @throws OrphanedPlacementsError if `updates.quadrants` shrinks and orphans
 *         are left unresolved (no `quadrantOptions`).
 */
export async function adminUpdateRadar(
  radarId: string,
  ownerId: string,
  updates: AdminRadarMutation,
  quadrantOptions?: UpdateRadarQuadrantsOptions
): Promise<RadarData> {
  // GRAPH-060 #2 — owner-only, ALWAYS enforced. `ownerId` is required, so an
  // absent/empty owner or a non-owner fails closed before any orphan preparation
  // or commit and mutates nothing.
  await assertRadarOwnedBy(radarId, ownerId);

  if (updates.quadrants !== undefined) {
    await prepareAdminRadarQuadrantUpdate(radarId, updates.quadrants, quadrantOptions);
  }

  const { radar, changed } = await commitAdminRadarMutation(radarId, updates);
  if (changed) {
    await requestRadarGraphProjection(radar);
  }

  log.info('Updated radar', { radarId, fields: Object.keys(updates), changed });
  return radar;
}

/**
 * Admin-SDK equivalent of `getAllRadars` from `@/lib/radars`. When
 * `includeStats` is false (the AI tool default) this is equivalent to
 * `adminListRadars()`. When true, joins per-radar placement counts (computed
 * in-memory over a single `radarPlacements` fetch — no client-SDK reach) into
 * the same `{ stats }` shape the client path returns. Per-radar failures degrade
 * to zeroed stats, matching the client service.
 */
export async function adminGetAllRadars(includeStats = false): Promise<(RadarData & { stats?: RadarStats })[]> {
  const radars = await adminListRadars();
  if (!includeStats) {
    return radars;
  }

  // One bounded read over all placements, then bucket per radar in-memory.
  const allPlacements = await adminGetRadarPlacements();
  const byRadar = new Map<string, RadarPlacement[]>();
  for (const p of allPlacements) {
    const list = byRadar.get(p.radarId);
    if (list) list.push(p);
    else byRadar.set(p.radarId, [p]);
  }

  return radars.map((radar) => {
    try {
      const placements = byRadar.get(radar.id) ?? [];
      const byRing: Record<string, number> = {};
      const byQuadrant: Record<string, { name: string; count: number }> = {};
      const nameById = new Map<string, string>(
        Array.isArray(radar.quadrants) ? radar.quadrants.map((q) => [q.id, q.name] as [string, string]) : []
      );
      for (const p of placements) {
        byRing[p.ring] = (byRing[p.ring] || 0) + 1;
        const existing = byQuadrant[p.quadrantId];
        if (existing) existing.count++;
        else byQuadrant[p.quadrantId] = { name: nameById.get(p.quadrantId) ?? p.quadrantId, count: 1 };
      }
      return { ...radar, stats: { totalPlacements: placements.length, byRing, byQuadrant } };
    } catch (error) {
      log.warn('Failed to compute stats for radar', { id: radar.id, error: String(error) });
      return { ...radar, stats: { totalPlacements: 0, byRing: {}, byQuadrant: {} } };
    }
  });
}

/**
 * Join `radarPlacements` (where radarId == radarId) with the
 * `technologies` collection. Mirrors
 * `getTechnologiesWithPlacementsForRadar` from
 * `@/lib/radar-placement-service` but via the admin SDK so the
 * `/api/ai/chat` route can call it. Technologies that no longer
 * exist (orphan placements) are filtered out, same as production.
 */
export async function adminGetTechnologiesWithPlacementsForRadar(radarId: string): Promise<TechnologyWithPlacement[]> {
  const placementsSnap = await db.collection('radarPlacements').where('radarId', '==', radarId).get();
  if (placementsSnap.empty) return [];

  const placements: RadarPlacement[] = placementsSnap.docs.map(
    (doc) => ({ ...(doc.data() as Omit<RadarPlacement, 'id'>), id: doc.id }) as RadarPlacement
  );

  // Fan-out the technology lookups in parallel — admin doc reads are
  // cheap and bounded (one radar's placements are at most a few
  // hundred).
  const joined = await Promise.all(
    placements.map(async (placement) => {
      const techSnap = await db.collection('technologies').doc(placement.technologyId).get();
      if (!techSnap.exists) {
        log.warn('Technology not found for placement', { technologyId: placement.technologyId, id: placement.id });
        return null;
      }
      const tech = { ...(techSnap.data() as Omit<Technology, 'id'>), id: techSnap.id } as Technology;
      return { ...tech, placement } as TechnologyWithPlacement;
    })
  );

  return joined.filter((t): t is TechnologyWithPlacement => t !== null);
}

/**
 * List technologies from the `technologies` collection (admin SDK).
 * Used for the "unplaced technologies in the library" surface of
 * `getRadarDetails`. Keeps a hard cap so the model doesn't get a
 * 1000-tech blob when only a sample is needed.
 */
export async function adminListTechnologies(limit = 200): Promise<Technology[]> {
  const snap = await db.collection('technologies').limit(limit).get();
  return snap.docs.map((doc) => ({ ...(doc.data() as Omit<Technology, 'id'>), id: doc.id }) as Technology);
}

/**
 * Read placements for a radar (or across all radars when no filter is
 * passed). Mirrors `getRadarPlacements` from
 * `@/lib/radar-placement-service` for the `searchTechnologiesAdvanced`
 * tool executor's join.
 */
export async function adminGetRadarPlacements(filters: { radarId?: string } = {}): Promise<RadarPlacement[]> {
  const baseRef = db.collection('radarPlacements');
  const query = filters.radarId ? baseRef.where('radarId', '==', filters.radarId) : baseRef;
  const snap = await query.get();
  return snap.docs.map((doc) => ({ ...(doc.data() as Omit<RadarPlacement, 'id'>), id: doc.id }) as RadarPlacement);
}

/**
 * Lightweight search over the `technologies` collection. Firestore
 * doesn't support full-text search natively, so the predicate filters
 * are applied in-memory before the result limit — matching the existing
 * client-SDK `getTechnologies({search,...})` behaviour from
 * `@/lib/technology-service`. Limiting the collection read first makes
 * valid technologies outside Firestore's arbitrary first page invisible.
 */
export async function adminSearchTechnologies(filters: {
  search?: string;
  category?: string;
  tags?: string[];
  limit?: number;
}): Promise<Technology[]> {
  const resultLimit =
    typeof filters.limit === 'number' && Number.isFinite(filters.limit)
      ? Math.max(0, Math.min(Math.floor(filters.limit), 500))
      : undefined;
  const snap = await db.collection('technologies').get();
  const all = snap.docs.map((doc) => ({ ...(doc.data() as Omit<Technology, 'id'>), id: doc.id }) as Technology);

  const searchLower = filters.search?.toLowerCase();
  const matches = all.filter((tech) => {
    if (filters.category && tech.category !== filters.category) return false;
    if (filters.tags && filters.tags.length > 0) {
      const techTags = Array.isArray(tech.tags) ? tech.tags : [];
      if (!filters.tags.some((t) => techTags.includes(t))) return false;
    }
    if (searchLower) {
      const haystack = `${tech.name ?? ''} ${tech.description ?? ''}`.toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  });

  return resultLimit === undefined ? matches : matches.slice(0, resultLimit);
}

/**
 * Narrow projection that the AI assistant returns to the model — id +
 * name + quadrant ids/names. Exported so the chat route can call it
 * without re-implementing the shape.
 *
 * `description` and `ringSystem` are ALWAYS present (`''` / `'Standard'`
 * when the doc omits them) so external MCP clients see a consistent key
 * set across radars — JSON.stringify silently dropped `undefined`
 * descriptions before, making the company-wide radar shape diverge.
 */
export interface AdminRadarSummary {
  id: string;
  name: string;
  description: string;
  ringSystem: string;
  quadrants: Array<{ id: string; name: string; order: number }>;
}

export function summarizeRadar(radar: RadarData): AdminRadarSummary {
  return {
    id: radar.id,
    name: radar.name,
    description: radar.description ?? '',
    ringSystem: radar.ringSystem ?? 'Standard',
    quadrants: Array.isArray(radar.quadrants)
      ? radar.quadrants.map((q) =>
          typeof q === 'object' && q !== null && 'id' in q && 'name' in q
            ? { id: q.id as string, name: q.name as string, order: (q as QuadrantConfig).order ?? 0 }
            : { id: '', name: String(q), order: 0 }
        )
      : [],
  };
}
