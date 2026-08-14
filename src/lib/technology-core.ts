/**
 * @file lib/technology-core.ts
 * @description Core CRUD operations, utilities, bulk operations, query helpers,
 * and linking operations for the decoupled Technology entity.
 *
 * Split from technology-service.ts for maintainability.
 * Re-exported via technology-service.ts barrel for backward compatibility.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit as firestoreLimit,
  writeBatch,
  runTransaction,
  arrayRemove,
  documentId,
  orderBy,
  startAfter,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { fuzzySearch } from '@/lib/fuzzy-search';
import {
  EntitySyncDispatchError,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
  requestEntityGraphSync,
} from '@/lib/entity-sync';
import type { Technology, TechnologyCategory, CreateTechnologyInput } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import {
  TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE,
  TECHNOLOGY_REFERENCE_CLEANUP_TARGETS,
  type TechnologyReferenceCleanupTarget,
} from '@/lib/technology-reference-cleanup';
const log = createLogger('technology-service');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Firestore collection name for technologies */
export const COLLECTION_NAME = 'technologies';
const IS_SERVER_RUNTIME = typeof window === 'undefined';

/**
 * Thrown by `deleteTechnology` when the technology still has RadarPlacements.
 *
 * A bare delete must not orphan placements — a RadarPlacement without its
 * Technology is a dangling Firestore document. The durable Technology graph
 * worker also removes placement projections, but it cannot repair an orphaned
 * Firestore placement, so the source-side block remains required.
 * Callers that intend to remove the placements too must use
 * `deleteTechnologyWithPlacements()` or `deleteTechnologyCompletely()`.
 *
 * Mirrors the block-on-orphan contract of `OrphanedPlacementsError` on radar
 * quadrant edits. Carries the count so UI/AI executors can surface it.
 */
export class TechnologyHasPlacementsError extends Error {
  public readonly technologyId: string;
  public readonly placementCount: number;
  constructor(technologyId: string, placementCount: number) {
    super(
      `Cannot delete technology ${technologyId}: ${placementCount} radar placement(s) still reference it. ` +
        `Use deleteTechnologyWithPlacements() or deleteTechnologyCompletely() to cascade.`
    );
    this.name = 'TechnologyHasPlacementsError';
    this.technologyId = technologyId;
    this.placementCount = placementCount;
  }
}

type TechnologySyncOperation = 'create' | 'update' | 'delete';

export async function triggerTechnologySyncSafely(
  id: string,
  operation: TechnologySyncOperation
): Promise<void> {
  await requestEntityGraphSync('technology', id, operation);
}

export async function sendTechnologyUpdatedEvent(technologyId: string, updatedFields: string[]): Promise<void> {
  if (!IS_SERVER_RUNTIME) return;
  void technologyId;
  void updatedFields;
  // Server event dispatch is intentionally deferred in client-shared services.
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Filter options for querying technologies
 */
export interface TechnologyFilters {
  /** Text search in name or description */
  search?: string;
  /** Filter by category */
  category?: TechnologyCategory;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by linked company */
  linkedCompanyId?: string;
  /** Filter by linked use case */
  linkedUseCaseId?: string;
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
 * Generates a URL-friendly slug from a name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generates a unique ID for a new technology
 */
function generateId(): string {
  return `tech-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Gets all technologies with optional filtering
 *
 * @param filters - Optional filters to apply
 * @returns Promise resolving to array of technologies
 *
 * @example
 * ```typescript
 * // Get all technologies
 * const all = await getTechnologies();
 *
 * // Get frameworks only
 * const frameworks = await getTechnologies({ category: 'framework' });
 *
 * // Search for React
 * const results = await getTechnologies({ search: 'react' });
 * ```
 */
export async function getTechnologies(filters: TechnologyFilters = {}): Promise<Technology[]> {
  try {
    const technologiesRef = collection(db, COLLECTION_NAME);
    const snapshot = await getDocs(technologiesRef);

    let technologies = snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    })) as Technology[];

    // Apply filters (in-memory to avoid composite index issues)
    if (filters.search) {
      // Use fuzzy search for better matching (supports partial matches, hyphenated terms)
      technologies = fuzzySearch(technologies, filters.search, {
        keys: ['name', 'description'] as (keyof Technology)[],
        threshold: 0.2, // Allow partial matches
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

    // Sort by name by default
    technologies.sort((a, b) => a.name.localeCompare(b.name));

    // Apply limit
    if (filters.limit) {
      technologies = technologies.slice(0, filters.limit);
    }

    return technologies;
  } catch (error) {
    log.error('Error fetching technologies', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch technologies: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Gets a single technology by its ID
 *
 * @param id - The technology ID
 * @returns Promise resolving to the technology or null if not found
 *
 * @example
 * ```typescript
 * const tech = await getTechnologyById('tech-123');
 * if (tech) {
 *   console.log(tech.name, tech.description);
 * }
 * ```
 */
export async function getTechnologyById(id: string): Promise<Technology | null> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return null;
    }

    return { ...docSnap.data(), id: docSnap.id } as Technology;
  } catch (error) {
    log.error('Error fetching technology by ID', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Gets a technology by its slug
 *
 * @param slug - The URL-friendly slug
 * @returns Promise resolving to the technology or null if not found
 *
 * @example
 * ```typescript
 * const tech = await getTechnologyBySlug('react');
 * ```
 */
export async function getTechnologyBySlug(slug: string): Promise<Technology | null> {
  try {
    const technologiesRef = collection(db, COLLECTION_NAME);
    const q = query(technologiesRef, where('slug', '==', slug), firestoreLimit(1));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return { ...doc.data(), id: doc.id } as Technology;
  } catch (error) {
    log.error('Error fetching technology by slug', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch technology by slug: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Creates a new technology
 *
 * @param data - The technology data (without id, createdAt, updatedAt)
 * @returns Promise resolving to the created technology
 *
 * @example
 * ```typescript
 * const tech = await createTechnology({
 *   name: 'React',
 *   slug: 'react',
 *   description: 'A JavaScript library for building user interfaces',
 *   category: 'framework',
 *   tags: ['frontend', 'javascript', 'ui'],
 *   websiteUrl: 'https://react.dev',
 *   createdBy: 'user-123',
 * });
 * ```
 */
export async function createTechnology(data: CreateTechnologyInput): Promise<Technology> {
  try {
    const id = generateId();
    const now = Date.now();

    // Auto-generate slug if not provided
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

    // Remove undefined values (Firestore doesn't accept them)
    const cleanTechnology = Object.fromEntries(
      Object.entries(technology).filter(([_, v]) => v !== undefined)
    ) as Technology;

    // Use transaction to ensure slug uniqueness (prevents race condition)
    // Two concurrent creates with the same slug will now properly fail one of them
    await runTransaction(db, async (transaction) => {
      // Check for slug uniqueness within transaction
      const technologiesRef = collection(db, COLLECTION_NAME);
      const slugQuery = query(technologiesRef, where('slug', '==', slug), firestoreLimit(1));
      const slugSnapshot = await getDocs(slugQuery);

      if (!slugSnapshot.empty) {
        throw new Error(`A technology with slug "${slug}" already exists`);
      }

      // Create the document within the transaction
      const docRef = doc(db, COLLECTION_NAME, id);
      transaction.set(docRef, cleanTechnology);
    });

    log.info('Created technology', { id, name: data.name });

    // Require prompt graph delivery; the committed document remains the retry source on failure.
    await triggerTechnologySyncSafely(id, 'create');

    return cleanTechnology;
  } catch (error) {
    log.error('Error creating technology', error instanceof Error ? error : new Error(String(error)));
    if (error instanceof EntitySyncDispatchError) throw error;
    throw new Error(`Failed to create technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing technology
 *
 * @param id - The technology ID
 * @param updates - Partial updates to apply
 * @returns Promise resolving to the updated technology
 *
 * @example
 * ```typescript
 * await updateTechnology('tech-123', {
 *   description: 'Updated description',
 *   tags: ['frontend', 'javascript', 'ui', 'new-tag'],
 * });
 * ```
 */
export async function updateTechnology(
  id: string,
  updates: Partial<Omit<Technology, 'id' | 'createdAt' | 'createdBy'>>
): Promise<Technology> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);

    // Check if the slug is changing (name change triggers slug regeneration)
    const isSlugChanging = updates.name || updates.slug;

    // If slug is potentially changing, use a transaction to prevent race conditions
    if (isSlugChanging) {
      const result = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(docRef);

        if (!docSnap.exists()) {
          throw new Error(`Technology ${id} not found`);
        }

        const currentData = docSnap.data() as Technology;

        // If name is changing and slug isn't provided, regenerate slug
        let newSlug = updates.slug;
        if (updates.name && !updates.slug) {
          newSlug = generateSlug(updates.name);
        }

        // Check for slug uniqueness within transaction (excluding current doc)
        if (newSlug && newSlug !== currentData.slug) {
          const technologiesRef = collection(db, COLLECTION_NAME);
          const slugQuery = query(technologiesRef, where('slug', '==', newSlug), firestoreLimit(1));
          const slugSnapshot = await getDocs(slugQuery);

          if (!slugSnapshot.empty && slugSnapshot.docs[0].id !== id) {
            throw new Error(`A technology with slug "${newSlug}" already exists`);
          }
        }

        const updatedData = {
          ...updates,
          ...(newSlug ? { slug: newSlug } : {}),
          updatedAt: Date.now(),
        };

        // Remove undefined values
        const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([_, v]) => v !== undefined));

        transaction.update(docRef, cleanUpdates);

        return { ...currentData, ...cleanUpdates, id } as Technology;
      });

      log.info('Updated technology', { id });

      // Trigger snapshot refresh for all placements of this technology.
      // Non-blocking: update succeeds even if event dispatch fails.
      void sendTechnologyUpdatedEvent(id, Object.keys(updates));

      // Require prompt graph delivery and surface an unacknowledged handoff.
      await triggerTechnologySyncSafely(id, 'update');

      return result;
    }

    // Simple update without slug change - no transaction needed
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`Technology ${id} not found`);
    }

    const updatedData = {
      ...updates,
      updatedAt: Date.now(),
    };

    // Remove undefined values
    const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([_, v]) => v !== undefined));

    await updateDoc(docRef, cleanUpdates);

    log.info('Updated technology', { id });

    // Trigger snapshot refresh for all placements of this technology.
    // Non-blocking: update succeeds even if event dispatch fails.
    void sendTechnologyUpdatedEvent(id, Object.keys(updates));

    // Return the full updated document
    const updated = await getDoc(docRef);
    const updatedTechnology = { ...updated.data(), id: updated.id } as Technology;

    // Require prompt graph delivery and surface an unacknowledged handoff.
    await triggerTechnologySyncSafely(id, 'update');

    return updatedTechnology;
  } catch (error) {
    log.error('Error updating technology', error instanceof Error ? error : new Error(String(error)));
    if (error instanceof EntitySyncDispatchError) throw error;
    throw new Error(`Failed to update technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes a technology.
 *
 * Refuses (throws `TechnologyHasPlacementsError`) if any RadarPlacement still
 * references the technology — a bare delete must not orphan placements. Use
 * `deleteTechnologyWithPlacements()` or `deleteTechnologyCompletely()` to
 * cascade the placements first.
 *
 * @param id - The technology ID
 * @returns Promise resolving when deletion is complete
 * @throws TechnologyHasPlacementsError if placements still reference it
 *
 * @example
 * ```typescript
 * await deleteTechnology('tech-123'); // only if it has no placements
 * ```
 */
export async function deleteTechnology(id: string): Promise<void> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`Technology ${id} not found`);
    }

    // Block-on-orphan: never delete a technology out from under its placements.
    // The Neo4j delete does a DETACH DELETE that drops the :PLACES edge but
    // leaves the :RadarPlacement node (and its Firestore doc) dangling. The
    // cascade variants remove placements first, so this guard passes for them.
    const { getPlacementsForTechnology } = await import('./radar-placement-service');
    const placements = await getPlacementsForTechnology(id);
    if (placements.length > 0) {
      throw new TechnologyHasPlacementsError(id, placements.length);
    }

    await requestEntityGraphDeletion('technology', id);
    const { deleteLinksForEntity } = await import('./entity-document-link-service');
    await deleteLinksForEntity('technology', id);
    await deleteDoc(docRef);
    log.info('Deleted technology', { id });
  } catch (error) {
    // Preserve the typed guard error so callers can branch on it.
    if (error instanceof TechnologyHasPlacementsError) {
      throw error;
    }
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error deleting technology', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to delete technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes a technology and all its radar placements (cascade delete)
 *
 * @param id - The technology ID
 * @returns Promise resolving to the number of placements deleted
 */
export async function deleteTechnologyWithPlacements(id: string): Promise<number> {
  try {
    const technology = await getTechnologyById(id);
    if (!technology) throw new Error(`Technology ${id} not found`);

    // Acquire durable graph ownership before deleting placements or relations.
    await requestEntityGraphDeletion('technology', id);

    // Import placement service to avoid circular dependencies
    const { deleteAllPlacementsForTechnology } = await import('./radar-placement-service');

    // Delete placements first
    const placementsDeleted = await deleteAllPlacementsForTechnology(id);

    const { deleteLinksForEntity } = await import('./entity-document-link-service');
    await deleteLinksForEntity('technology', id);

    await deleteDoc(doc(db, COLLECTION_NAME, id));

    log.info('Deleted technology with placements', { id, placementsDeleted });
    return placementsDeleted;
  } catch (error) {
    log.error('Error cascade deleting technology', error instanceof Error ? error : new Error(String(error)));
    if (error instanceof EntitySyncDispatchError) throw error;
    throw new Error(`Failed to cascade delete technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Result of a complete technology deletion including all related data
 */
export interface CompleteDeletionResult {
  /** Whether the deletion was successful */
  success: boolean;
  /** Number of radar placements deleted */
  placementsDeleted: number;
  /** Number of relations deleted */
  relationsDeleted: number;
  /** Whether the Neo4j node was deleted */
  neo4jDeleted: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Cleans up orphaned references to a technology in other entities.
 * Removes the technology ID from:
 * - Prototype.linkedTechnologies arrays
 * - UseCase.radarTechnologyIds arrays
 * - PainPoint.linkedTechnologyIds arrays
 *
 * @param technologyId - The technology ID to remove from references
 */
async function cleanupOrphanedTechnologyReferences(technologyId: string): Promise<void> {
  const cleanupPlan: Array<{
    target: TechnologyReferenceCleanupTarget;
    references: QueryDocumentSnapshot<DocumentData>[];
  }> = [];

  // Preflight every indexed query before mutating anything. If any collection
  // is unavailable, the cascade stops without partially editing another one.
  for (const target of TECHNOLOGY_REFERENCE_CLEANUP_TARGETS) {
    const references: QueryDocumentSnapshot<DocumentData>[] = [];
    const seenDocumentIds = new Set<string>();
    let cursor: QueryDocumentSnapshot<DocumentData> | undefined;

    while (true) {
      const baseQuery = query(
        collection(db, target.collection),
        where(target.field, 'array-contains', technologyId),
        orderBy(documentId()),
        firestoreLimit(TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE)
      );
      const pageQuery = cursor ? query(baseQuery, startAfter(cursor)) : baseQuery;
      const snapshot = await getDocs(pageQuery);

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
      const batch = writeBatch(db);
      for (const reference of chunk) {
        batch.update(reference.ref, { [target.field]: arrayRemove(technologyId) });
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
 * Completely deletes a technology including all related data:
 * - The technology document from Firestore
 * - All radar placements for this technology
 * - All relations where this technology is source or target
 * - Prototype, Use Case, and Pain Point reverse references
 * - Entity-document links and their document counters
 * - The corresponding node in Neo4j graph database
 *
 * This is the recommended method for deleting technologies as it ensures
 * data consistency across all systems.
 *
 * @param id - The technology ID (format: tech-xxx)
 * @returns Promise resolving to the deletion result
 *
 * @example
 * ```typescript
 * const result = await deleteTechnologyCompletely('tech-123');
 * if (result.success) {
 *   console.log(`Deleted technology with ${result.placementsDeleted} placements`);
 * }
 * ```
 */
export async function deleteTechnologyCompletely(id: string): Promise<CompleteDeletionResult> {
  const result: CompleteDeletionResult = {
    success: false,
    placementsDeleted: 0,
    relationsDeleted: 0,
    neo4jDeleted: false,
  };

  try {
    // Verify the technology exists first
    const tech = await getTechnologyById(id);
    if (!tech) {
      result.error = `Technology ${id} not found`;
      return result;
    }

    // Nothing destructive may run until the graph delete is durably owned.
    await requestEntityGraphDeletion('technology', id);

    // 1. Delete all radar placements for this technology.
    // CASCADE INVARIANT: if any sub-step fails we throw rather than press on.
    // The previous "log.warn and continue" pattern (Priority 3 of the
    // 2026-05-12 cascade-delete investigation) would have left orphan
    // placements in Firestore when the technology doc still got deleted at
    // the bottom of this function. Failing loud here makes the caller retry.
    try {
      const { deleteAllPlacementsForTechnology } = await import('./radar-placement-service');
      result.placementsDeleted = await deleteAllPlacementsForTechnology(id);
      log.info('Deleted placements', { placementsDeleted: result.placementsDeleted, id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at placements for ${id}: ${msg}`);
    }

    // 2. Delete all relations for this technology.
    try {
      const { deleteRelationsForEntity } = await import('./relations');
      result.relationsDeleted = await deleteRelationsForEntity(id);
      log.info('Deleted relations', { relationsDeleted: result.relationsDeleted, id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at relations for ${id}: ${msg}`);
    }

    // 2b. Clean up reverse references in other entities. Failure here also aborts — leaving stale
    // arrays pointing at a deleted technology is the same bug class.
    try {
      await cleanupOrphanedTechnologyReferences(id);
      log.info('Cleaned up orphaned references', { id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at orphaned-reference cleanup for ${id}: ${msg}`);
    }

    // 3. Delete every entity-document link through its own durable graph
    // handoff. Link cleanup failure retains the Technology as the retry anchor.
    try {
      const { deleteLinksForEntity } = await import('./entity-document-link-service');
      await deleteLinksForEntity('technology', id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Cascade failed at document links for ${id}: ${msg}`);
    }

    // 4. Delete the authoritative source. The worker will not touch Neo4j
    // until this succeeds, so a failed final delete retains both copies.
    await deleteDoc(doc(db, COLLECTION_NAME, id));

    // 5. Best-effort fast graph cleanup after source removal. The durable
    // worker owns convergence and may race this idempotent delete safely.
    try {
      const { getNeo4jGraphService } = await import('./graph/neo4j-graph-service');
      const { deleteEntityFromGraph } = await import('./graph/assertions');
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
      // Continue - Neo4j deletion is best effort
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
    log.error('Error in complete deletion', error instanceof Error ? error : new Error(String(error)));
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Result of bulk complete deletion
 */
export interface BulkCompleteDeletionResult {
  /** Number of successfully deleted technologies */
  succeeded: number;
  /** IDs that failed to delete */
  failed: string[];
  /** Total placements deleted across all technologies */
  totalPlacementsDeleted: number;
  /** Total relations deleted across all technologies */
  totalRelationsDeleted: number;
  /** Error messages for failed deletions */
  errors: string[];
}

/**
 * Completely deletes multiple technologies including all related data.
 * Uses the same cascade deletion as deleteTechnologyCompletely for each technology.
 *
 * @param ids - Array of technology IDs to delete
 * @returns Promise resolving to the bulk deletion result
 *
 * @example
 * ```typescript
 * const result = await deleteTechnologiesCompletely(['tech-1', 'tech-2', 'tech-3']);
 * console.log(`Deleted ${result.succeeded} technologies`);
 * ```
 */
export async function deleteTechnologiesCompletely(ids: string[]): Promise<BulkCompleteDeletionResult> {
  const result: BulkCompleteDeletionResult = {
    succeeded: 0,
    failed: [],
    totalPlacementsDeleted: 0,
    totalRelationsDeleted: 0,
    errors: [],
  };

  // Process each technology individually to ensure proper cascade deletion
  for (const id of ids) {
    const deleteResult = await deleteTechnologyCompletely(id);

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

// ============================================================================
// BULK OPERATIONS
// ============================================================================

/**
 * Deletes multiple technologies
 *
 * @param ids - Array of technology IDs to delete
 * @returns Promise resolving to bulk operation result
 */
export async function deleteTechnologies(ids: string[]): Promise<BulkOperationResult> {
  const result: BulkOperationResult = {
    succeeded: 0,
    failed: [],
    errors: [],
  };

  // Process in batches of 500 (Firestore limit)
  for (let i = 0; i < ids.length; i += 500) {
    const batchIds = ids.slice(i, i + 500);
    const handoffs = await requestEntityGraphDeletions('technology', batchIds);
    const acknowledgedIds = handoffs.acknowledged;
    for (const failure of handoffs.failed) {
      result.failed.push(failure.id);
      result.errors.push(failure.error instanceof Error ? failure.error.message : String(failure.error));
    }
    if (acknowledgedIds.length === 0) continue;

    const batch = writeBatch(db);

    for (const id of acknowledgedIds) {
      const docRef = doc(db, COLLECTION_NAME, id);
      batch.delete(docRef);
    }

    try {
      await batch.commit();
      result.succeeded += acknowledgedIds.length;
    } catch (error) {
      result.failed.push(...acknowledgedIds);
      result.errors.push(error instanceof Error ? error.message : 'Batch delete failed');
    }
  }

  if (result.succeeded > 0) {
    // Emit data refresh event for technologies
    emitDataRefresh('technologies', 'bulk-delete');
  }

  return result;
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Gets all unique tags across all technologies
 *
 * @returns Promise resolving to array of unique tag strings
 */
export async function getAllTechnologyTags(): Promise<string[]> {
  const technologies = await getTechnologies();
  const tagsSet = new Set<string>();

  technologies.forEach((tech) => {
    tech.tags.forEach((tag) => tagsSet.add(tag));
  });

  return Array.from(tagsSet).sort();
}

/**
 * Gets all unique categories across all technologies
 *
 * @returns Promise resolving to array of unique categories
 */
export async function getAllTechnologyCategories(): Promise<TechnologyCategory[]> {
  const technologies = await getTechnologies();
  const categoriesSet = new Set<TechnologyCategory>();

  technologies.forEach((tech) => {
    if (tech.category) {
      categoriesSet.add(tech.category);
    }
  });

  return Array.from(categoriesSet).sort();
}

/**
 * Searches technologies by name (fuzzy match)
 *
 * @param searchTerm - The search term
 * @param limit - Maximum results to return
 * @returns Promise resolving to matching technologies
 */
export async function searchTechnologies(searchTerm: string, limit: number = 10): Promise<Technology[]> {
  return getTechnologies({ search: searchTerm, limit });
}

// ============================================================================
// LINKING OPERATIONS
// ============================================================================

/**
 * Links a company to a technology
 *
 * @param technologyId - The technology ID
 * @param companyId - The company ID to link
 */
export async function linkCompanyToTechnology(technologyId: string, companyId: string): Promise<void> {
  const tech = await getTechnologyById(technologyId);
  if (!tech) {
    throw new Error(`Technology ${technologyId} not found`);
  }

  const linkedCompanies = tech.linkedCompanies || [];
  if (!linkedCompanies.includes(companyId)) {
    await updateTechnology(technologyId, {
      linkedCompanies: [...linkedCompanies, companyId],
    });
  }
}

/**
 * Unlinks a company from a technology
 *
 * @param technologyId - The technology ID
 * @param companyId - The company ID to unlink
 */
export async function unlinkCompanyFromTechnology(technologyId: string, companyId: string): Promise<void> {
  const tech = await getTechnologyById(technologyId);
  if (!tech) {
    throw new Error(`Technology ${technologyId} not found`);
  }

  const linkedCompanies = tech.linkedCompanies || [];
  await updateTechnology(technologyId, {
    linkedCompanies: linkedCompanies.filter((id) => id !== companyId),
  });
}

/**
 * Links a use case to a technology
 *
 * @param technologyId - The technology ID
 * @param useCaseId - The use case ID to link
 */
export async function linkUseCaseToTechnology(technologyId: string, useCaseId: string): Promise<void> {
  const tech = await getTechnologyById(technologyId);
  if (!tech) {
    throw new Error(`Technology ${technologyId} not found`);
  }

  const linkedUseCases = tech.linkedUseCases || [];
  if (!linkedUseCases.includes(useCaseId)) {
    await updateTechnology(technologyId, {
      linkedUseCases: [...linkedUseCases, useCaseId],
    });
  }
}

/**
 * Unlinks a use case from a technology
 *
 * @param technologyId - The technology ID
 * @param useCaseId - The use case ID to unlink
 */
export async function unlinkUseCaseFromTechnology(technologyId: string, useCaseId: string): Promise<void> {
  const tech = await getTechnologyById(technologyId);
  if (!tech) {
    throw new Error(`Technology ${technologyId} not found`);
  }

  const linkedUseCases = tech.linkedUseCases || [];
  await updateTechnology(technologyId, {
    linkedUseCases: linkedUseCases.filter((id) => id !== useCaseId),
  });
}
