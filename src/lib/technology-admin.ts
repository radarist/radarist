/**
 * @file technology-admin.ts
 * @description Admin-SDK twin of the Technology CRUD surface consumed by AI
 * tools (`src/lib/ai/tools/technology-decoupled.ts`, `enrichment.ts`,
 * `radar-management.ts`) and the `/api/technologies/*` routes.
 *
 * WHY: `technology-core.ts` (re-exported via `technology-service.ts`) is a
 * Firebase CLIENT-SDK module (`firebase/firestore` + `@/lib/firebase`). When
 * its CRUD runs server-side — inside the `/api/ai/chat` tool executor, an API
 * route, or an Inngest worker against PRODUCTION — the client SDK has no
 * persistent connection and either throws `FIRESTORE INTERNAL ASSERTION
 * FAILED a540` or returns `code: 'unavailable'` (the same failure mode
 * observed in the migrated Inngest functions and the reason
 * `entity-factory-admin.ts` / `signals-admin.ts` / `radars-admin.ts` exist).
 *
 * UNLIKE most entities, technology does NOT create through
 * `entity-factory.createEntity`: `technology-core.createTechnology` runs its
 * OWN `runTransaction` slug-uniqueness check, generates its own `tech-…` id,
 * and fires the dedicated `app/technology.sync.requested` Inngest event (with
 * a `technologyId` field, NOT `entityId`). This file replicates that path
 * faithfully via `db.runTransaction` (reads-before-writes) rather than
 * delegating to `adminCreateEntity`, so the two paths can never drift in
 * behaviour, id format, slug, or sync semantics.
 *
 * Cascade delete (`adminDeleteTechnologiesCompletely`) replicates the
 * `deleteTechnologyCompletely` cascade — durable graph ownership, placements,
 * relations, reverse references, entity-document links, the Technology source,
 * then best-effort fast graph convergence — entirely through the admin SDK,
 * because the client-SDK cascade helpers
 * (`radar-placement-service.deleteAllPlacementsForTechnology`,
 * `relations-core.deleteRelationsForEntity`) would re-introduce the very
 * client/server failure this module exists to avoid.
 */

import 'server-only';

import { FieldPath, FieldValue, type DocumentData, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { fuzzySearch } from '@/lib/fuzzy-search';
import { createLogger } from '@/lib/logger';
import type { Technology, TechnologyCategory, CreateTechnologyInput } from '@/lib/types';
import {
  TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE,
  TECHNOLOGY_REFERENCE_CLEANUP_TARGETS,
  type TechnologyReferenceCleanupTarget,
} from '@/lib/technology-reference-cleanup';

const log = createLogger('technology-admin');

/** Firestore collection name for technologies — mirrors technology-core.COLLECTION_NAME. */
const COLLECTION_NAME = 'technologies';
/** Firestore collection name for radar placements — mirrors radar-placement-service.COLLECTION_NAME. */
const PLACEMENTS_COLLECTION = 'radarPlacements';

// ============================================================================
// TYPES (mirrors technology-core.ts)
// ============================================================================

/** Filter options for querying technologies. Mirrors `TechnologyFilters`. */
export interface TechnologyFilters {
  /** Text search in name or description (fuzzy). */
  search?: string;
  /** Filter by category. */
  category?: TechnologyCategory;
  /** Filter by tags (any match). */
  tags?: string[];
  /** Filter by linked company. */
  linkedCompanyId?: string;
  /** Filter by linked use case. */
  linkedUseCaseId?: string;
  /** Maximum number of results. */
  limit?: number;
}

/** Result of a complete technology deletion. Mirrors `CompleteDeletionResult`. */
export interface CompleteDeletionResult {
  success: boolean;
  placementsDeleted: number;
  relationsDeleted: number;
  neo4jDeleted: boolean;
  error?: string;
}

/** Result of a bulk complete deletion. Mirrors `BulkCompleteDeletionResult`. */
export interface BulkCompleteDeletionResult {
  succeeded: number;
  failed: string[];
  totalPlacementsDeleted: number;
  totalRelationsDeleted: number;
  errors: string[];
}

// ============================================================================
// UTILITIES (mirrors technology-core.ts)
// ============================================================================

/** Generates a URL-friendly slug from a name. Mirrors `technology-core.generateSlug`. */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Generates a unique ID for a new technology. Mirrors `technology-core.generateId`. */
function generateId(): string {
  return `tech-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// READ
// ============================================================================

/**
 * Admin-SDK equivalent of `technology-core.getTechnologies`. Reads the full
 * collection and applies the SAME in-memory filters (fuzzy `search` on
 * name/description, exact `category`, any-match `tags`, `linkedCompanyId`,
 * `linkedUseCaseId`), the SAME name sort, and the SAME `limit` slice.
 */
export async function adminGetTechnologies(filters: TechnologyFilters = {}): Promise<Technology[]> {
  try {
    const snapshot = await db.collection(COLLECTION_NAME).get();

    let technologies = snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    })) as Technology[];

    // Apply filters in-memory to avoid composite index issues (matches client path).
    if (filters.search) {
      technologies = fuzzySearch(technologies, filters.search, {
        keys: ['name', 'description'] as (keyof Technology)[],
        threshold: 0.2,
      });
    }

    if (filters.category) {
      technologies = technologies.filter((tech) => tech.category === filters.category);
    }

    if (filters.tags && filters.tags.length > 0) {
      technologies = technologies.filter((tech) => filters.tags!.some((tag) => tech.tags.includes(tag)));
    }

    if (filters.linkedCompanyId) {
      technologies = technologies.filter((tech) => tech.linkedCompanies?.includes(filters.linkedCompanyId!));
    }

    if (filters.linkedUseCaseId) {
      technologies = technologies.filter((tech) => tech.linkedUseCases?.includes(filters.linkedUseCaseId!));
    }

    technologies.sort((a, b) => a.name.localeCompare(b.name));

    if (filters.limit) {
      technologies = technologies.slice(0, filters.limit);
    }

    return technologies;
  } catch (error) {
    log.error('Error fetching technologies (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch technologies: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `technology-core.getTechnologyById`. Returns the
 * technology or `null` if not found. Same return shape and same wrapped error.
 */
export async function adminGetTechnologyById(id: string): Promise<Technology | null> {
  try {
    const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
    if (!docSnap.exists) {
      return null;
    }
    return { ...docSnap.data(), id: docSnap.id } as Technology;
  } catch (error) {
    log.error('Error fetching technology by ID (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// CREATE
// ============================================================================

/**
 * Admin-SDK equivalent of `technology-core.createTechnology`.
 *
 * Replicates the bespoke slug-uniqueness transaction (NOT entity-factory):
 * generates the same `tech-…` id, derives the slug the same way, strips
 * `undefined` values, runs a reads-before-writes `db.runTransaction` that
 * fails when the slug already exists, and fires the same dedicated
 * `app/technology.sync.requested` event with the same payload.
 *
 * Slug collision throws the SAME generic `Error("A technology with slug
 * "<slug>" already exists")` the client path throws — callers (e.g. the
 * `createTechnology` AI tool's DuplicateEntityError branch) already treat this
 * as a generic failure, so the thrown type is preserved deliberately.
 */
export async function adminCreateTechnology(data: CreateTechnologyInput): Promise<Technology> {
  try {
    const id = generateId();
    const now = Date.now();

    // Auto-generate slug if not provided (matches client path).
    const slug = data.slug || generateSlug(data.name);

    const technology: Technology = {
      id,
      name: data.name,
      slug,
      description: data.description,
      category: data.category,
      tags: data.tags || [],
      websiteUrl: data.websiteUrl,
      githubUrl: data.githubUrl,
      documentationUrl: data.documentationUrl,
      linkedCompanies: data.linkedCompanies || [],
      linkedUseCases: data.linkedUseCases || [],
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy,
    };

    // Remove undefined values (Firestore doesn't accept them).
    const cleanTechnology = Object.fromEntries(
      Object.entries(technology).filter(([_, v]) => v !== undefined)
    ) as Technology;

    // Transaction enforces slug uniqueness (prevents race condition). Admin
    // transactions require reads before writes, which matches: read the slug
    // query, then set the doc.
    await db.runTransaction(async (transaction) => {
      const slugQuery = db.collection(COLLECTION_NAME).where('slug', '==', slug).limit(1);
      const slugSnapshot = await transaction.get(slugQuery);

      if (!slugSnapshot.empty) {
        throw new Error(`A technology with slug "${slug}" already exists`);
      }

      transaction.set(db.collection(COLLECTION_NAME).doc(id), cleanTechnology);
    });

    log.info('Created technology', { id, name: data.name });

    await triggerEntityGraphSyncBestEffortServer('technology', id, 'create');

    return cleanTechnology;
  } catch (error) {
    log.error('Error creating technology (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// UPDATE
// ============================================================================

/**
 * Admin-SDK equivalent of `technology-core.updateTechnology`. Returns the full
 * updated technology.
 *
 * Mirrors the two-branch shape:
 *   - if name/slug is changing → reads-before-writes transaction that
 *     regenerates the slug (when name changes without an explicit slug) and
 *     re-checks slug uniqueness excluding the current doc;
 *   - otherwise → a simple existence check + update.
 *
 * Both branches strip `undefined`, stamp `updatedAt`, and fire the same
 * dedicated `app/technology.sync.requested` 'update' event. Thrown errors and
 * the `Technology` return shape are preserved.
 */
export async function adminUpdateTechnology(
  id: string,
  updates: Partial<Omit<Technology, 'id' | 'createdAt' | 'createdBy'>>
): Promise<Technology> {
  try {
    const docRef = db.collection(COLLECTION_NAME).doc(id);

    const isSlugChanging = updates.name || updates.slug;

    if (isSlugChanging) {
      const result = await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(docRef);

        if (!docSnap.exists) {
          throw new Error(`Technology ${id} not found`);
        }

        const currentData = docSnap.data() as Technology;

        // If name is changing and slug isn't provided, regenerate slug.
        let newSlug = updates.slug;
        if (updates.name && !updates.slug) {
          newSlug = generateSlug(updates.name);
        }

        // Check slug uniqueness within the transaction (excluding current doc).
        if (newSlug && newSlug !== currentData.slug) {
          const slugQuery = db.collection(COLLECTION_NAME).where('slug', '==', newSlug).limit(1);
          const slugSnapshot = await transaction.get(slugQuery);

          if (!slugSnapshot.empty && slugSnapshot.docs[0].id !== id) {
            throw new Error(`A technology with slug "${newSlug}" already exists`);
          }
        }

        const updatedData = {
          ...updates,
          ...(newSlug ? { slug: newSlug } : {}),
          updatedAt: Date.now(),
        };

        const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([_, v]) => v !== undefined));

        transaction.update(docRef, cleanUpdates);

        return { ...currentData, ...cleanUpdates, id } as Technology;
      });

      log.info('Updated technology', { id });

      await triggerEntityGraphSyncBestEffortServer('technology', id, 'update');

      return result;
    }

    // Simple update without slug change — no transaction needed.
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      throw new Error(`Technology ${id} not found`);
    }

    const updatedData = {
      ...updates,
      updatedAt: Date.now(),
    };

    const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([_, v]) => v !== undefined));

    await docRef.update(cleanUpdates);

    log.info('Updated technology', { id });

    // Return the full updated document.
    const updated = await docRef.get();
    const updatedTechnology = { ...updated.data(), id: updated.id } as Technology;

    await triggerEntityGraphSyncBestEffortServer('technology', id, 'update');

    return updatedTechnology;
  } catch (error) {
    log.error('Error updating technology (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to update technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// DELETE (cascade)
// ============================================================================

/**
 * Admin-SDK delete of all radar placements for a technology, cleaning up each
 * placement's relations first. Mirrors
 * `radar-placement-service.deleteAllPlacementsForTechnology` — relations per
 * placement are removed, the placement docs are batch-deleted, and a dedicated
 * `app/radar-placement.sync.requested` 'delete' event is fired per placement
 * (best-effort) so `sync-placement-to-neo4j` removes the graph nodes.
 * Returns the number of placements deleted.
 */
async function adminDeleteAllPlacementsForTechnology(technologyId: string): Promise<number> {
  // GRAPH-066 #8 — route the cascade through the lock-aware bulk primitive so
  // every deleted placement removes its pair lock AND leaves a durable delete
  // tombstone (was: a raw batch delete + best-effort sync that leaked locks).
  // GRAPH-066 #3 — and hold the technology parent-deletion barrier across the
  // snapshot→delete window, so a create racing this cascade is refused instead
  // of surviving as an orphan placement for a technology that is being removed.
  const { adminCascadeDeletePlacements, withPlacementParentDeletionLease } =
    await import('@/lib/radar-placement-admin');
  return withPlacementParentDeletionLease('technology', technologyId, async () => {
    const placementsSnap = await db.collection(PLACEMENTS_COLLECTION).where('technologyId', '==', technologyId).get();
    if (placementsSnap.empty) {
      return 0;
    }
    const rows = placementsSnap.docs.map((doc) => {
      const data = doc.data() as { radarId: string; technologyId: string };
      return { id: doc.id, radarId: data.radarId, technologyId: data.technologyId };
    });
    const deleted = await adminCascadeDeletePlacements(rows);
    log.info('Deleted placements for technology', { count: deleted, technologyId });
    return deleted;
  });
}

async function adminDeleteTechnologyDocument(id: string): Promise<void> {
  await db.collection(COLLECTION_NAME).doc(id).delete();
  log.info('Deleted technology', { id });
}

/**
 * Admin-SDK equivalent of `technology-core.deleteTechnologyWithPlacements`.
 *
 * Replicates the lightweight cascade the client path runs (NOT the fuller
 * `adminDeleteTechnologyCompletely` cascade): delete the technology's radar
 * placements first, then the technology document. Returns the number of
 * placements deleted (`Promise<number>`), matching the client signature and
 * return shape exactly.
 *
 * `adminDeleteAllPlacementsForTechnology` already mirrors the placement-cascade
 * (`radar-placement-service.deleteAllPlacementsForTechnology` — per-placement
 * relation cleanup + `radarPlacement` delete sync). This function first
 * requires the dedicated Technology graph-delete handoff, then performs that
 * cascade and removes the source document.
 *
 * The wrapped error message is preserved verbatim ("Failed to cascade delete
 * technology: …") so callers — e.g. `executeDeleteDecoupledTechnology` and the
 * `entity-creation` delete tool, which surface `error.message` directly — see
 * the same string the client path produced.
 */
export async function adminDeleteTechnologyWithPlacements(id: string): Promise<number> {
  try {
    const technology = await adminGetTechnologyById(id);
    if (!technology) throw new Error(`Technology ${id} not found`);

    await requestEntityGraphDeletion('technology', id);

    const placementsDeleted = await adminDeleteAllPlacementsForTechnology(id);

    await adminDeleteLinksForEntity('technology', id);

    await adminDeleteTechnologyDocument(id);

    log.info('Deleted technology with placements', { id, placementsDeleted });
    return placementsDeleted;
  } catch (error) {
    log.error('Error cascade deleting technology (admin)', error instanceof Error ? error : new Error(String(error)));
    if (error instanceof EntitySyncDispatchError) throw error;
    throw new Error(`Failed to cascade delete technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Cleans up orphaned references to a technology in other entities. Mirrors
 * `technology-core.cleanupOrphanedTechnologyReferences` — removes the id from
 * every known reverse-reference array through indexed, bounded chunks.
 */
async function adminCleanupOrphanedTechnologyReferences(technologyId: string): Promise<void> {
  const cleanupPlan: Array<{
    target: TechnologyReferenceCleanupTarget;
    references: QueryDocumentSnapshot<DocumentData>[];
  }> = [];

  // Resolve every query before the first write so a later collection failure
  // cannot leave an earlier collection partially edited.
  for (const target of TECHNOLOGY_REFERENCE_CLEANUP_TARGETS) {
    const references: QueryDocumentSnapshot<DocumentData>[] = [];
    const seenDocumentIds = new Set<string>();
    let cursor: QueryDocumentSnapshot<DocumentData> | undefined;

    while (true) {
      let pageQuery = db
        .collection(target.collection)
        .where(target.field, 'array-contains', technologyId)
        .orderBy(FieldPath.documentId())
        .limit(TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE);
      if (cursor) pageQuery = pageQuery.startAfter(cursor);

      const snapshot = await pageQuery.get();
      if (snapshot.empty || snapshot.docs.length === 0) break;

      for (const reference of snapshot.docs) {
        if (seenDocumentIds.has(reference.id)) {
          throw new Error(
            `Technology reference cleanup pagination made no progress for ${target.collection}/${target.field}`
          );
        }
        seenDocumentIds.add(reference.id);
        references.push(reference);
      }

      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.docs.length < TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE) break;
    }

    cleanupPlan.push({ target, references });
  }

  let referencesDeleted = 0;

  for (const { target, references } of cleanupPlan) {
    for (let offset = 0; offset < references.length; offset += TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE) {
      const chunk = references.slice(offset, offset + TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE);
      const batch = db.batch();
      for (const reference of chunk) {
        batch.update(reference.ref, { [target.field]: FieldValue.arrayRemove(technologyId) });
      }
      await batch.commit();
      referencesDeleted += chunk.length;

      log.info('Removed technology reverse-reference chunk', {
        technologyId,
        collection: target.collection,
        field: target.field,
        count: chunk.length,
      });
    }
  }

  log.info('Cleaned technology reverse references', { referencesDeleted, technologyId });
}

/**
 * Admin-SDK equivalent of `technology-core.deleteTechnologyCompletely`.
 *
 * Replicates the full cascade with the SAME CASCADE INVARIANT: placements,
 * relations, reverse-reference cleanup, and document-link cleanup each abort
 * (throw) on failure so the Technology document remains a retry anchor;
 * direct Neo4j deletion stays best-effort after source removal. Returns the same `CompleteDeletionResult`
 * shape (success flag, counts, neo4jDeleted, optional error string) — it
 * resolves (never rejects), capturing failures in `result.error`.
 */
export async function adminDeleteTechnologyCompletely(id: string): Promise<CompleteDeletionResult> {
  const result: CompleteDeletionResult = {
    success: false,
    placementsDeleted: 0,
    relationsDeleted: 0,
    neo4jDeleted: false,
  };

  try {
    // Verify the technology exists first.
    const tech = await adminGetTechnologyById(id);
    if (!tech) {
      result.error = `Technology ${id} not found`;
      return result;
    }

    await requestEntityGraphDeletion('technology', id);

    // 1. Delete all radar placements (abort cascade on failure).
    try {
      result.placementsDeleted = await adminDeleteAllPlacementsForTechnology(id);
      log.info('Deleted placements', { placementsDeleted: result.placementsDeleted, id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at placements for ${id}: ${msg}`);
    }

    // 2. Delete all relations (abort cascade on failure).
    try {
      result.relationsDeleted = await adminDeleteRelationsForEntity(id);
      log.info('Deleted relations', { relationsDeleted: result.relationsDeleted, id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at relations for ${id}: ${msg}`);
    }

    // 2b. Clean up orphaned references in other entities (abort cascade on failure).
    try {
      await adminCleanupOrphanedTechnologyReferences(id);
      log.info('Cleaned up orphaned references', { id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at orphaned-reference cleanup for ${id}: ${msg}`);
    }

    // 3. Delete every entity-document link through its durable graph handoff.
    try {
      await adminDeleteLinksForEntity('technology', id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at document links for ${id}: ${msg}`);
    }

    // 4. Delete the authoritative source. The graph worker waits for this
    // before deleting Neo4j, preserving both copies on a failed final delete.
    await adminDeleteTechnologyDocument(id);

    // 5. Best-effort fast graph cleanup after source removal. The durable
    // worker owns convergence and this idempotent delete may race it safely.
    try {
      const { getNeo4jGraphService } = await import('@/lib/graph/neo4j-graph-service');
      const { deleteEntityFromGraph } = await import('@/lib/graph/assertions');
      const graphService = getNeo4jGraphService();
      const health = await graphService.isHealthy();

      if (health) {
        const deletion = await deleteEntityFromGraph(id, 'technology');
        result.neo4jDeleted = deletion.endpointsDeleted > 0;
        if (result.neo4jDeleted) {
          log.info('Deleted Neo4j node', { id });
        }
      } else {
        log.warn('Neo4j not healthy, skipping graph deletion');
      }
    } catch (error) {
      log.warn('Failed to delete from Neo4j', { error: String(error) });
      // Continue — Neo4j deletion is best effort.
    }

    result.success = true;
    log.info('Completely deleted technology', {
      id,
      placementsDeleted: result.placementsDeleted,
      relationsDeleted: result.relationsDeleted,
      neo4jDeleted: result.neo4jDeleted,
    });

    return result;
  } catch (error) {
    log.error('Error in complete deletion (admin)', error instanceof Error ? error : new Error(String(error)));
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Admin-SDK equivalent of `technology-core.deleteTechnologiesCompletely`.
 * Processes each id individually through the full cascade and aggregates the
 * results into the SAME `BulkCompleteDeletionResult` shape. Used by
 * `/api/technologies/bulk-delete`.
 */
export async function adminDeleteTechnologiesCompletely(ids: string[]): Promise<BulkCompleteDeletionResult> {
  const result: BulkCompleteDeletionResult = {
    succeeded: 0,
    failed: [],
    totalPlacementsDeleted: 0,
    totalRelationsDeleted: 0,
    errors: [],
  };

  for (const id of ids) {
    const deleteResult = await adminDeleteTechnologyCompletely(id);

    if (deleteResult.success) {
      result.succeeded++;
      result.totalPlacementsDeleted += deleteResult.placementsDeleted;
      result.totalRelationsDeleted += deleteResult.relationsDeleted;
    } else {
      result.failed.push(id);
      if (deleteResult.error) {
        result.errors.push(`${id}: ${deleteResult.error}`);
      }
    }
  }

  log.info('Bulk delete complete', {
    succeeded: result.succeeded,
    failed: result.failed.length,
    totalPlacementsDeleted: result.totalPlacementsDeleted,
    totalRelationsDeleted: result.totalRelationsDeleted,
  });

  return result;
}
