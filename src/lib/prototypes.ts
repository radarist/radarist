/**
 * @file prototypes.ts
 * @description Data access layer for Prototypes in the Agentic Innovation Platform.
 *
 * Prototypes represent tangible demonstrations of technology value delivered to business units.
 * They bridge the gap between radar technologies and measurable business outcomes.
 *
 * **Traceability Flow:**
 * Signal → Technology → Prototype → Impact Measurement
 *
 * **Lifecycle:**
 * Ideation → In Development → Demo Ready → Delivered → Archived
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { createEntity, DuplicateEntityError } from '@/lib/entity-factory';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import {
  applyEntityReferenceCleanup,
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE,
  preflightEntityReferenceCleanup,
  preflightEntityReferenceCleanups,
  type EntityReferenceCleanupPlan,
} from '@/lib/entity-reference-cleanup';
import type { Prototype, PrototypeCosts, PrototypeCostBreakdownItem } from '@/lib/types';
import { idResolver, safeResolve, needsResolution } from '@/lib/migration';
import {
  EntitySyncDispatchError,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
  requestEntityGraphSync,
} from '@/lib/entity-sync';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { createLogger } from '@/lib/logger';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
const log = createLogger('prototypes');

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Fetches all prototypes from Firestore.
 * Returns prototypes ordered by creation date (most recent first).
 *
 * @returns Promise resolving to an array of Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const prototypes = await getPrototypes();
 * console.log(`Total prototypes: ${prototypes.length}`);
 * ```
 */
export async function getPrototypes(): Promise<Prototype[]> {
  try {
    const querySnapshot = await getDocs(query(collection(db, 'prototypes'), orderBy('createdAt', 'desc')));
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch prototypes');
  }
}

/**
 * Fetches a single prototype by ID with all its data.
 * This is the primary method for getting detailed prototype information.
 *
 * @param id - The unique identifier of the prototype
 * @returns Promise resolving to the Prototype object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const prototype = await getPrototypeById("ai-flavor-lab-123");
 * if (prototype) {
 *   console.log(`${prototype.name} - Status: ${prototype.status}`);
 *   console.log(`Impact: $${prototype.impact.estimatedValue}`);
 * }
 * ```
 */
export async function getPrototypeById(id: string): Promise<Prototype | null> {
  try {
    const docRef = doc(db, 'prototypes', id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return docSnap.data() as Prototype;
    }
    return null;
  } catch (error) {
    log.error('Error fetching prototype', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch prototype ${id}`);
  }
}

/**
 * Creates a new prototype in Firestore.
 * Automatically generates an ID based on the prototype name and current timestamp.
 *
 * @param prototype - The prototype data without system-managed fields (id, timestamps)
 * @returns Promise resolving to the newly created Prototype object
 * @throws Error if Firestore operation fails or validation fails
 *
 * @example
 * ```typescript
 * const newPrototype = await createPrototype({
 *   name: "AI Flavor Lab",
 *   description: "AI-powered flavor combination discovery tool",
 *   status: "In Development",
 *   linkedTechnologies: ["nutrition-bu:42"],
 *   linkedCompanies: ["openai-123"],
 *   linkedUseCases: ["flavor-discovery-456"],
 *   linkedStrategies: ["innovation-2025"],
 *   targetBusinessUnit: "Nutrition",
 *   presentedTo: [],
 *   artifacts: {
 *     presentations: []
 *   },
 *   impact: {
 *     type: "Cost Saving",
 *     estimatedValue: 500000,
 *     timeToImpact: "6 months",
 *     confidence: 80,
 *     notes: "Based on 30% reduction in formulation time"
 *   },
 *   team: ["John Doe", "Jane Smith"]
 * });
 * console.log(`Created prototype: ${newPrototype.id}`);
 * ```
 */
export async function createPrototype(
  prototype: Omit<Prototype, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<Prototype> {
  try {
    // Validate required fields
    if (!prototype.name || !prototype.description) {
      throw new Error('Prototype name and description are required');
    }

    // Remove undefined values before saving (Firestore doesn't accept undefined)
    const cleanedPrototype = removeUndefinedFields(prototype) as Omit<
      Prototype,
      'id' | 'slug' | 'createdAt' | 'updatedAt'
    >;

    // Use entity-factory for uniqueness-enforced creation
    const result = await createEntity<Omit<Prototype, 'id' | 'slug' | 'createdAt' | 'updatedAt'>>(
      'prototype',
      cleanedPrototype,
      { graphSync: 'required' }
    );

    const newPrototype = result.entity as Prototype;

    return newPrototype;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate prototype', { message: error.message });
      throw error;
    }
    // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
    // intact. Wrapping it in a generic Error would hide the identity the
    // saved-locally resolver needs, and the write is already committed.
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error creating prototype', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create prototype: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing prototype in Firestore.
 * Automatically updates the updatedAt timestamp.
 *
 * **Note:** Partial updates are supported. Only provided fields will be updated.
 *
 * @param id - The ID of the prototype to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or prototype doesn't exist
 *
 * @example
 * ```typescript
 * // Update prototype status
 * await updatePrototype("ai-flavor-lab-123", {
 *   status: "Demo Ready",
 *   presentedTo: ["VP of Nutrition", "CTO"]
 * });
 *
 * // Update impact measurement
 * await updatePrototype("ai-flavor-lab-123", {
 *   impact: {
 *     ...existingImpact,
 *     actualValue: 750000,
 *     measuredDate: Date.now()
 *   }
 * });
 * ```
 */
export async function updatePrototype(
  id: string,
  updates: Partial<Omit<Prototype, 'id' | 'createdAt'>>
): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', id);

    // Check if prototype exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Prototype ${id} not found`);
    }

    // Remove undefined values before updating Firestore (Firestore doesn't accept undefined)
    const cleanedUpdates = removeUndefinedFields({
      ...updates,
      updatedAt: Date.now(),
    });
    await updateDoc(docRef, cleanedUpdates);

    // GRAPH-058: a required, awaited handoff. Fire-and-forget delivery meant the
    // caller could not tell a converged write from a stale projection, and the
    // durable recovery anchor was written from a floating promise a navigating
    // page could abandon. The committed Firestore document is NOT rolled back —
    // callers surface this as "saved locally", never as a failed update.
    await requestEntityGraphSync('prototype', id, 'update');

    log.info('Successfully updated prototype', { id });
  } catch (error) {
    // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
    // intact. Wrapping it in a generic Error would hide the identity the
    // saved-locally resolver needs, and the write is already committed.
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error updating prototype', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update prototype ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Deletes a prototype from Firestore.
 *
 * **WARNING:** This operation is permanent and cannot be undone.
 * Consider archiving the prototype instead by updating its status to "Archived".
 *
 * @param id - The ID of the prototype to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Recommended: Archive instead of delete
 * await updatePrototype("old-prototype-123", { status: "Archived" });
 *
 * // Permanent deletion (use with caution)
 * await deletePrototype("old-prototype-123");
 * ```
 */
async function preparePrototypeDeletion(
  id: string,
  referencePlan?: EntityReferenceCleanupPlan
): Promise<number> {
    const cleanupPlan = referencePlan ?? (await preflightEntityReferenceCleanup('prototype', id, db));

    const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
    const linksDeleted = await deleteLinksForEntity('prototype', id);
    if (linksDeleted > 0) {
      log.info('Cleaned up document links for prototype', { linksDeleted, id });
    }

    const { deleteRelationsForEntity } = await import('@/lib/relations');
    const relationsDeleted = await deleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for prototype', { relationsDeleted, id });
    }

    // Clean up the notes subcollection (UX-002/003/004) — Firestore doesn't
    // cascade subcollection deletes, so orphaned notes would persist forever.
    const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
    const notesDeleted = await deleteAllEntityNotes(db, 'prototypes', id);
    if (notesDeleted > 0) {
      log.info('Cleaned up notes subcollection', { notesDeleted, id });
    }

    await applyEntityReferenceCleanup(cleanupPlan, db);

    return relationsDeleted;
}

export async function deletePrototype(id: string): Promise<void> {
  try {
    const cleanupPlan = await preflightEntityReferenceCleanup('prototype', id, db);
    await requestEntityGraphDeletion('prototype', id);
    await preparePrototypeDeletion(id, cleanupPlan);

    // Delete the prototype document only after the graph handoff is durable.
    await deleteDoc(doc(db, 'prototypes', id));
    log.info('Deleted prototype', { id });
  } catch (error) {
    log.error('Error deleting prototype', error instanceof Error ? error : new Error(String(error)), { id });
    if (error instanceof EntitySyncDispatchError || error instanceof EntityDeletionBlockedError) throw error;
    throw new Error(`Failed to delete prototype ${id}`, { cause: error });
  }
}

/**
 * Result of a bulk delete operation.
 */
export interface BulkDeleteResult {
  /** Number of entities successfully deleted */
  deleted: number;
  /** IDs of entities that failed to delete */
  failed: string[];
  /** Number of relations cleaned up */
  relationsDeleted: number;
}

/**
 * Deletes multiple prototypes from Firestore with cascade relation cleanup.
 * Processes deletions in bounded batches with headroom below Firestore's limit.
 *
 * @param ids - Array of prototype IDs to delete
 * @returns Promise resolving to deletion results
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const result = await deletePrototypes(["proto-1", "proto-2", "proto-3"]);
 * console.log(`Deleted ${result.deleted} prototypes, ${result.relationsDeleted} relations`);
 * ```
 */
export async function deletePrototypes(ids: string[]): Promise<BulkDeleteResult> {
  const { writeBatch } = await import('firebase/firestore');

  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const cleanupPreflight = await preflightEntityReferenceCleanups('prototype', batchIds, db);
    for (const { id, error } of cleanupPreflight.failed) {
      failed.push(id);
      log.warn('Prototype reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (cleanupPreflight.prepared.length === 0) continue;

    const cleanupPlans = new Map(cleanupPreflight.prepared.map(({ id, plan }) => [id, plan]));
    const preflightedIds = cleanupPreflight.prepared.map(({ id }) => id);
    const handoffs = await requestEntityGraphDeletions('prototype', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    failed.push(...handoffs.failed.map(({ id }) => id));
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, (id) => {
      const cleanupPlan = cleanupPlans.get(id);
      if (!cleanupPlan) throw new Error(`Missing prototype cleanup preflight plan for ${id}`);
      return preparePrototypeDeletion(id, cleanupPlan);
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Prototype cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    // Delete only entities whose graph handoff and every prerequisite succeeded.
    const batch = writeBatch(db);
    for (const { id } of preparation.prepared) {
      batch.delete(doc(db, 'prototypes', id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;
    } catch (error) {
      log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  // Emit data refresh event for UI cache invalidation
  if (deleted > 0) {
    emitDataRefresh('prototypes', 'bulk-delete');
  }

  return { deleted, failed, relationsDeleted };
}

// ============================================================================
// FILTERING & QUERYING
// ============================================================================

/**
 * Fetches prototypes filtered by status.
 * Useful for dashboard views showing active, delivered, or archived prototypes.
 *
 * @param status - The status to filter by
 * @returns Promise resolving to an array of matching Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get all active prototypes
 * const activePrototypes = await getPrototypesByStatus("In Development");
 *
 * // Get delivered prototypes for reporting
 * const deliveredPrototypes = await getPrototypesByStatus("Delivered");
 * ```
 */
export async function getPrototypesByStatus(status: Prototype['status']): Promise<Prototype[]> {
  try {
    const q = query(collection(db, 'prototypes'), where('status', '==', status), orderBy('createdAt', 'desc'));

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes by status', error instanceof Error ? error : new Error(String(error)), {
      status,
    });
    throw new Error(`Failed to fetch prototypes by status ${status}`);
  }
}

/**
 * Fetches prototypes filtered by business unit.
 * Useful for showing prototypes relevant to specific departments.
 *
 * @param businessUnit - The target business unit name (matches an Org Unit of type 'business_unit')
 * @returns Promise resolving to an array of matching Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Get all prototypes for a given business unit
 * const prototypes = await getPrototypesByBusinessUnit("Consumer Products");
 * ```
 */
export async function getPrototypesByBusinessUnit(businessUnit: string): Promise<Prototype[]> {
  try {
    const q = query(
      collection(db, 'prototypes'),
      where('targetBusinessUnit', '==', businessUnit),
      orderBy('createdAt', 'desc')
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes by business unit', error instanceof Error ? error : new Error(String(error)), {
      businessUnit,
    });
    throw new Error(`Failed to fetch prototypes by business unit ${businessUnit}`);
  }
}

/**
 * Fetches prototypes linked to a specific technology.
 * Enables traceability from radar entry to prototypes using that technology.
 *
 * @param technologyId - The technology ID in format "radarId:entryId" (e.g., "nutrition-bu:42")
 * @returns Promise resolving to an array of Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Find all prototypes using "Generative AI" technology
 * const prototypes = await getPrototypesByTechnology("tech-radar-2025:42");
 * console.log(`Found ${prototypes.length} prototypes using this technology`);
 * ```
 */
export async function getPrototypesByTechnology(technologyId: string): Promise<Prototype[]> {
  try {
    // Phase 3: Technology Decoupling Migration
    // Query with both old and new ID formats during transition
    const idsToQuery: string[] = [technologyId];

    // If given a new ID, also query with old ID (for backward compat)
    if (idResolver.isNewFormat(technologyId)) {
      const oldId = idResolver.getOldId(technologyId);
      if (oldId) {
        idsToQuery.push(oldId);
      }
    }
    // If given an old ID, also query with new ID
    else if (needsResolution(technologyId)) {
      const resolvedId = safeResolve(technologyId);
      if (resolvedId !== technologyId) {
        idsToQuery.push(resolvedId);
      }
    }

    // Query for each ID and combine results
    const allPrototypes = new Map<string, Prototype>();

    for (const id of idsToQuery) {
      const q = query(collection(db, 'prototypes'), where('linkedTechnologies', 'array-contains', id));
      const querySnapshot = await getDocs(q);
      querySnapshot.docs.forEach((doc) => {
        const proto = doc.data() as Prototype;
        allPrototypes.set(proto.id, proto);
      });
    }

    return Array.from(allPrototypes.values());
  } catch (error) {
    log.error('Error fetching prototypes by technology', error instanceof Error ? error : new Error(String(error)), {
      technologyId,
    });
    throw new Error(`Failed to fetch prototypes by technology ${technologyId}`);
  }
}

/**
 * Fetches prototypes linked to a specific company.
 * Shows which prototypes involve a particular vendor or partner.
 *
 * @param companyId - The company ID
 * @returns Promise resolving to an array of Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Find all prototypes involving OpenAI
 * const prototypes = await getPrototypesByCompany("openai-123");
 * ```
 */
export async function getPrototypesByCompany(companyId: string): Promise<Prototype[]> {
  try {
    const q = query(collection(db, 'prototypes'), where('linkedCompanies', 'array-contains', companyId));

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes by company', error instanceof Error ? error : new Error(String(error)), {
      companyId,
    });
    throw new Error(`Failed to fetch prototypes by company ${companyId}`);
  }
}

/**
 * Fetches prototypes linked to a specific use case.
 * Shows which prototypes address a particular business problem.
 *
 * @param useCaseId - The use case ID
 * @returns Promise resolving to an array of Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Find prototypes addressing "Flavor Discovery" use case
 * const prototypes = await getPrototypesByUseCase("flavor-discovery-456");
 * ```
 */
export async function getPrototypesByUseCase(useCaseId: string): Promise<Prototype[]> {
  try {
    const q = query(collection(db, 'prototypes'), where('linkedUseCases', 'array-contains', useCaseId));

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes by use case', error instanceof Error ? error : new Error(String(error)), {
      useCaseId,
    });
    throw new Error(`Failed to fetch prototypes by use case ${useCaseId}`);
  }
}

/**
 * Fetches prototypes aligned with a specific strategy.
 * Shows which prototypes contribute to strategic goals.
 *
 * @param strategyId - The strategy ID
 * @returns Promise resolving to an array of Prototype objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * // Find prototypes aligned with "Sustainability 2025" strategy
 * const prototypes = await getPrototypesByStrategy("sustainability-2025");
 * console.log(`${prototypes.length} prototypes aligned with this strategy`);
 * ```
 */
export async function getPrototypesByStrategy(strategyId: string): Promise<Prototype[]> {
  try {
    const q = query(collection(db, 'prototypes'), where('linkedStrategies', 'array-contains', strategyId));

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes by strategy', error instanceof Error ? error : new Error(String(error)), {
      strategyId,
    });
    throw new Error(`Failed to fetch prototypes by strategy ${strategyId}`);
  }
}

// ============================================================================
// LINKING OPERATIONS
// ============================================================================

/**
 * Links a prototype to a technology (radar entry).
 * Adds the technology ID to the prototype's linkedTechnologies array.
 *
 * @param prototypeId - The ID of the prototype
 * @param technologyId - The technology ID in format "radarId:entryId"
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await linkPrototypeToTechnology("ai-flavor-lab-123", "nutrition-bu:42");
 * ```
 */
export async function linkPrototypeToTechnology(prototypeId: string, technologyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);

    // Resolve to canonical Technology ID format if input is legacy.
    let idToLink = technologyId;
    if (needsResolution(technologyId)) {
      idToLink = safeResolve(technologyId);
      log.info('Resolved technology ID for linking', { technologyId, idToLink });
    }

    await updateDoc(docRef, {
      linkedTechnologies: arrayUnion(idToLink),
      updatedAt: Date.now(),
    });
    log.info('Linked prototype to technology', { prototypeId, idToLink });
  } catch (error) {
    log.error('Error linking prototype to technology', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to link prototype to technology`);
  }
}

/**
 * Removes the link between a prototype and a technology.
 * Removes the technology ID from the prototype's linkedTechnologies array.
 *
 * @param prototypeId - The ID of the prototype
 * @param technologyId - The technology ID to unlink
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await unlinkPrototypeFromTechnology("ai-flavor-lab-123", "old-tech:99");
 * ```
 */
export async function unlinkPrototypeFromTechnology(prototypeId: string, technologyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);

    // Remove both old and new ID formats to ensure clean unlinking.
    const idsToRemove: string[] = [technologyId];
    if (needsResolution(technologyId)) {
      const resolvedId = safeResolve(technologyId);
      if (resolvedId !== technologyId) {
        idsToRemove.push(resolvedId);
      }
    } else if (idResolver.isNewFormat(technologyId)) {
      const oldId = idResolver.getOldId(technologyId);
      if (oldId) {
        idsToRemove.push(oldId);
      }
    }

    // Remove all variants
    await updateDoc(docRef, {
      linkedTechnologies: arrayRemove(...idsToRemove),
      updatedAt: Date.now(),
    });
    log.info('Unlinked prototype from technology', { prototypeId, technologyId });
  } catch (error) {
    log.error('Error unlinking prototype from technology', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to unlink prototype from technology`);
  }
}

/**
 * Links a prototype to a company.
 * Adds the company ID to the prototype's linkedCompanies array.
 *
 * @param prototypeId - The ID of the prototype
 * @param companyId - The company ID
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await linkPrototypeToCompany("ai-flavor-lab-123", "openai-456");
 * ```
 */
export async function linkPrototypeToCompany(prototypeId: string, companyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedCompanies: arrayUnion(companyId),
      updatedAt: Date.now(),
    });
    log.info('Linked prototype to company', { prototypeId, companyId });
  } catch (error) {
    log.error('Error linking prototype to company', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to link prototype to company`);
  }
}

/**
 * Removes the link between a prototype and a company.
 *
 * @param prototypeId - The ID of the prototype
 * @param companyId - The company ID to unlink
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await unlinkPrototypeFromCompany("ai-flavor-lab-123", "old-vendor-789");
 * ```
 */
export async function unlinkPrototypeFromCompany(prototypeId: string, companyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedCompanies: arrayRemove(companyId),
      updatedAt: Date.now(),
    });
    log.info('Unlinked prototype from company', { prototypeId, companyId });
  } catch (error) {
    log.error('Error unlinking prototype from company', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to unlink prototype from company`);
  }
}

/**
 * Links a prototype to a use case.
 * Adds the use case ID to the prototype's linkedUseCases array.
 *
 * @param prototypeId - The ID of the prototype
 * @param useCaseId - The use case ID
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await linkPrototypeToUseCase("ai-flavor-lab-123", "flavor-discovery-999");
 * ```
 */
export async function linkPrototypeToUseCase(prototypeId: string, useCaseId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedUseCases: arrayUnion(useCaseId),
      updatedAt: Date.now(),
    });
    log.info('Linked prototype to use case', { prototypeId, useCaseId });
  } catch (error) {
    log.error('Error linking prototype to use case', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to link prototype to use case`);
  }
}

/**
 * Removes the link between a prototype and a use case.
 *
 * @param prototypeId - The ID of the prototype
 * @param useCaseId - The use case ID to unlink
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await unlinkPrototypeFromUseCase("ai-flavor-lab-123", "old-usecase-111");
 * ```
 */
export async function unlinkPrototypeFromUseCase(prototypeId: string, useCaseId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedUseCases: arrayRemove(useCaseId),
      updatedAt: Date.now(),
    });
    log.info('Unlinked prototype from use case', { prototypeId, useCaseId });
  } catch (error) {
    log.error('Error unlinking prototype from use case', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to unlink prototype from use case`);
  }
}

/**
 * Links a prototype to a strategy.
 * Adds the strategy ID to the prototype's linkedStrategies array.
 *
 * @param prototypeId - The ID of the prototype
 * @param strategyId - The strategy ID
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await linkPrototypeToStrategy("ai-flavor-lab-123", "innovation-2025");
 * ```
 */
export async function linkPrototypeToStrategy(prototypeId: string, strategyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedStrategies: arrayUnion(strategyId),
      updatedAt: Date.now(),
    });
    log.info('Linked prototype to strategy', { prototypeId, strategyId });
  } catch (error) {
    log.error('Error linking prototype to strategy', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to link prototype to strategy`);
  }
}

/**
 * Removes the link between a prototype and a strategy.
 *
 * @param prototypeId - The ID of the prototype
 * @param strategyId - The strategy ID to unlink
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await unlinkPrototypeFromStrategy("ai-flavor-lab-123", "old-strategy-222");
 * ```
 */
export async function unlinkPrototypeFromStrategy(prototypeId: string, strategyId: string): Promise<void> {
  try {
    const docRef = doc(db, 'prototypes', prototypeId);
    await updateDoc(docRef, {
      linkedStrategies: arrayRemove(strategyId),
      updatedAt: Date.now(),
    });
    log.info('Unlinked prototype from strategy', { prototypeId, strategyId });
  } catch (error) {
    log.error('Error unlinking prototype from strategy', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to unlink prototype from strategy`);
  }
}

// ============================================================================
// ANALYTICS & REPORTING
// ============================================================================

/**
 * Calculates aggregate statistics for prototypes.
 * Useful for dashboard metrics and reporting.
 *
 * @returns Promise resolving to aggregated prototype statistics
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const stats = await getPrototypeStatistics();
 * console.log(`Active prototypes: ${stats.activeCount}`);
 * console.log(`Total estimated value: $${stats.totalEstimatedValue.toLocaleString()}`);
 * console.log(`Average confidence: ${stats.averageConfidence}%`);
 * ```
 */
export async function getPrototypeStatistics(): Promise<{
  total: number;
  activeCount: number;
  deliveredCount: number;
  archivedCount: number;
  totalEstimatedValue: number;
  totalActualValue: number;
  averageConfidence: number;
}> {
  try {
    return computePrototypeStatistics(await getPrototypes());
  } catch (error) {
    log.error('Error calculating prototype statistics', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to calculate prototype statistics');
  }
}

/**
 * Pure aggregation over an already-loaded prototype list (PERF-001): lets the
 * dashboard reuse its shared upfront fetch instead of re-reading the whole
 * collection just to compute these numbers.
 */
export function computePrototypeStatistics(prototypes: Prototype[]): {
  total: number;
  activeCount: number;
  deliveredCount: number;
  archivedCount: number;
  totalEstimatedValue: number;
  totalActualValue: number;
  averageConfidence: number;
} {
  // Optional-chain impact reads: a single malformed doc (e.g. written
  // outside the factory contract) must degrade to zeros for that doc,
  // never throw and blank the entire dashboard.
  return {
    total: prototypes.length,
    activeCount: prototypes.filter((p) => p.status === 'In Development' || p.status === 'Demo Ready').length,
    deliveredCount: prototypes.filter((p) => p.status === 'Delivered').length,
    archivedCount: prototypes.filter((p) => p.status === 'Archived').length,
    totalEstimatedValue: prototypes.reduce((sum, p) => sum + (p.impact?.estimatedValue ?? 0), 0),
    totalActualValue: prototypes.reduce((sum, p) => sum + (p.impact?.actualValue ?? 0), 0),
    averageConfidence:
      prototypes.length > 0
        ? prototypes.reduce((sum, p) => sum + (p.impact?.confidence ?? 0), 0) / prototypes.length
        : 0,
  };
}

// ============================================================================
// COST TRACKING OPERATIONS (Phase 0 Task 0.2.4)
// ============================================================================

/**
 * Updates the cost tracking data for a prototype.
 * Phase 0 Task 0.2.4 - Cost tracking functionality.
 *
 * @param id - The ID of the prototype
 * @param costs - Partial cost data to update (merged with existing)
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or prototype doesn't exist
 *
 * @example
 * ```typescript
 * // Set estimated cost from linked technology
 * await updatePrototypeCosts("ai-flavor-lab-123", {
 *   estimated: 50, // $50k
 *   currency: "USD",
 * });
 *
 * // Record actual cost with breakdown
 * await updatePrototypeCosts("ai-flavor-lab-123", {
 *   actual: 75, // $75k
 *   breakdown: [
 *     { category: "Cloud", amount: 25 },
 *     { category: "Hardware", amount: 20 },
 *     { category: "Labor", amount: 30 },
 *   ],
 * });
 * ```
 */
export async function updatePrototypeCosts(
  id: string,
  costs: Partial<Omit<PrototypeCosts, 'lastUpdated'>>
): Promise<void> {
  try {
    const prototype = await getPrototypeById(id);
    if (!prototype) {
      throw new Error(`Prototype ${id} not found`);
    }

    const updatedCosts: PrototypeCosts = {
      currency: 'USD', // Default currency
      ...prototype.costs, // Preserve existing costs
      ...costs, // Apply updates
      lastUpdated: Date.now(),
    };

    await updatePrototype(id, { costs: updatedCosts });
    log.info('Successfully updated costs for prototype', { id });
  } catch (error) {
    log.error('Error updating costs for prototype', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update costs: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Adds a cost breakdown item to a prototype.
 * Phase 0 Task 0.2.4 - Granular cost tracking.
 *
 * @param id - The ID of the prototype
 * @param item - The cost breakdown item to add
 * @returns Promise that resolves when the item is added
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await addCostBreakdownItem("ai-flavor-lab-123", {
 *   category: "Cloud Services",
 *   amount: 15,
 *   description: "AWS compute for 3 months"
 * });
 * ```
 */
export async function addCostBreakdownItem(id: string, item: PrototypeCostBreakdownItem): Promise<void> {
  try {
    const prototype = await getPrototypeById(id);
    if (!prototype) {
      throw new Error(`Prototype ${id} not found`);
    }

    const existingBreakdown = prototype.costs?.breakdown || [];
    const updatedBreakdown = [...existingBreakdown, item];

    await updatePrototypeCosts(id, { breakdown: updatedBreakdown });
    log.info('Added cost breakdown item for prototype', { id });
  } catch (error) {
    log.error('Error adding cost breakdown item', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to add cost breakdown item`);
  }
}

/**
 * Removes a cost breakdown item from a prototype by category.
 * Phase 0 Task 0.2.4 - Granular cost tracking.
 *
 * @param id - The ID of the prototype
 * @param category - The category of the item to remove
 * @returns Promise that resolves when the item is removed
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await removeCostBreakdownItem("ai-flavor-lab-123", "Cloud Services");
 * ```
 */
export async function removeCostBreakdownItem(id: string, category: string): Promise<void> {
  try {
    const prototype = await getPrototypeById(id);
    if (!prototype) {
      throw new Error(`Prototype ${id} not found`);
    }

    const existingBreakdown = prototype.costs?.breakdown || [];
    const updatedBreakdown = existingBreakdown.filter((item) => item.category !== category);

    await updatePrototypeCosts(id, { breakdown: updatedBreakdown });
    log.info('Removed cost breakdown item "" for prototype', { category, id });
  } catch (error) {
    log.error('Error removing cost breakdown item', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to remove cost breakdown item`);
  }
}

/**
 * Calculates aggregate cost statistics for all prototypes.
 * Phase 0 Task 0.2.4 - Cost analytics.
 *
 * @returns Promise resolving to aggregated cost statistics
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const costStats = await getCostStatistics();
 * console.log(`Total estimated: $${costStats.totalEstimated}k`);
 * console.log(`Total actual: $${costStats.totalActual}k`);
 * console.log(`Variance: ${costStats.variancePercentage}%`);
 * ```
 */
export async function getCostStatistics(): Promise<{
  totalEstimated: number;
  totalActual: number;
  varianceAmount: number;
  variancePercentage: number;
  prototypesWithCosts: number;
  averageEstimated: number;
  averageActual: number;
  breakdownByCategory: Record<string, number>;
}> {
  try {
    const prototypes = await getPrototypes();
    const prototypesWithCosts = prototypes.filter((p) => p.costs);

    const totalEstimated = prototypesWithCosts.reduce((sum, p) => sum + (p.costs?.estimated || 0), 0);
    const totalActual = prototypesWithCosts.reduce((sum, p) => sum + (p.costs?.actual || 0), 0);
    const varianceAmount = totalActual - totalEstimated;
    const variancePercentage = totalEstimated > 0 ? (varianceAmount / totalEstimated) * 100 : 0;

    // Aggregate breakdown by category
    const breakdownByCategory: Record<string, number> = {};
    prototypesWithCosts.forEach((p) => {
      p.costs?.breakdown?.forEach((item) => {
        breakdownByCategory[item.category] = (breakdownByCategory[item.category] || 0) + item.amount;
      });
    });

    return {
      totalEstimated,
      totalActual,
      varianceAmount,
      variancePercentage: Math.round(variancePercentage * 100) / 100,
      prototypesWithCosts: prototypesWithCosts.length,
      averageEstimated: prototypesWithCosts.length > 0 ? totalEstimated / prototypesWithCosts.length : 0,
      averageActual: prototypesWithCosts.length > 0 ? totalActual / prototypesWithCosts.length : 0,
      breakdownByCategory,
    };
  } catch (error) {
    log.error('Error calculating cost statistics', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to calculate cost statistics');
  }
}
