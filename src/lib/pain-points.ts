/**
 * @file painPoints.ts
 * @description Data access layer for Pain Points in Phase 3.
 *
 * Pain Points are business problems that drive "problem-pull" innovation.
 * They link to prototypes/technologies that solve them and org units affected.
 *
 * Key Features:
 * - Severity and status tracking
 * - Category classification (operational, customer, regulatory, etc.)
 * - Links to affected org units
 * - Solution tracking via prototypes and technologies
 * - Impact measurement (estimated vs actual)
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
} from "firebase/firestore";
import type {
  PainPoint,
  PainPointSeverity,
  PainPointStatus,
  PainPointCategory,
  CreatePainPointInput,
} from "@/lib/types";
import { EntitySyncDispatchError, requestEntityGraphDeletion, requestEntityGraphSync } from "@/lib/entity-sync";
import { createEntity, DuplicateEntityError } from "@/lib/entity-factory";
import {
  getStoredPainPointCategories,
  normalizePainPointForRead,
} from "@/lib/pain-points-shared";
import {
  applyEntityReferenceCleanup,
  preflightEntityReferenceCleanup,
} from '@/lib/entity-reference-cleanup';
import { createLogger } from '@/lib/logger';
const log = createLogger('pain-points');

/**
 * Search and filter options for pain points.
 */
export interface PainPointFilters {
  /** Text search query (searches title and description). */
  searchQuery?: string;
  /** Filter by severity. */
  severity?: PainPointSeverity[];
  /** Filter by status. */
  status?: PainPointStatus[];
  /** Filter by category. */
  category?: PainPointCategory[];
  /** Filter by affected org unit IDs. */
  affectedOrgUnitIds?: string[];
  /** Filter by tags. */
  tags?: string[];
}

/**
 * Fetches all pain points from Firestore.
 *
 * @returns Promise resolving to an array of PainPoint objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const painPoints = await getPainPoints();
 * console.log(`Total pain points: ${painPoints.length}`);
 */
export async function getPainPoints(): Promise<PainPoint[]> {
  const querySnapshot = await getDocs(collection(db, "painPoints"));
  return querySnapshot.docs.map((doc) => normalizePainPointForRead(doc.data()));
}

/**
 * Fetches pain points with optional filters.
 *
 * @param filters - Optional filter criteria
 * @returns Promise resolving to filtered array of PainPoint objects
 */
export async function getPainPointsWithFilters(
  filters?: PainPointFilters
): Promise<PainPoint[]> {
  let painPoints = await getPainPoints();

  if (!filters) return painPoints;

  // Apply filters in memory
  if (filters.searchQuery) {
    const query = filters.searchQuery.toLowerCase();
    painPoints = painPoints.filter(
      (pp) =>
        pp.title.toLowerCase().includes(query) ||
        pp.description.toLowerCase().includes(query) ||
        pp.impactDescription?.toLowerCase().includes(query)
    );
  }

  if (filters.severity && filters.severity.length > 0) {
    painPoints = painPoints.filter((pp) =>
      filters.severity!.includes(pp.severity)
    );
  }

  if (filters.status && filters.status.length > 0) {
    painPoints = painPoints.filter((pp) => filters.status!.includes(pp.status));
  }

  if (filters.category && filters.category.length > 0) {
    painPoints = painPoints.filter((pp) =>
      filters.category!.includes(pp.category)
    );
  }

  if (filters.affectedOrgUnitIds && filters.affectedOrgUnitIds.length > 0) {
    painPoints = painPoints.filter((pp) =>
      filters.affectedOrgUnitIds!.some((id) =>
        pp.affectedOrgUnitIds.includes(id)
      )
    );
  }

  if (filters.tags && filters.tags.length > 0) {
    painPoints = painPoints.filter((pp) =>
      filters.tags!.some((tag) => pp.tags.includes(tag))
    );
  }

  // Sort by severity then created date
  const severityOrder: Record<PainPointSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return painPoints.sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Fetches a single pain point by ID.
 *
 * @param id - The unique identifier of the pain point
 * @returns Promise resolving to the PainPoint object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * const painPoint = await getPainPointById("slow-checkout-123");
 * if (painPoint) {
 *   console.log(`${painPoint.title} affects ${painPoint.affectedOrgUnitIds.length} units`);
 * }
 */
export async function getPainPointById(id: string): Promise<PainPoint | null> {
  const docRef = doc(db, "painPoints", id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return normalizePainPointForRead(docSnap.data());
  }
  return null;
}

/**
 * Fetches pain points by affected org unit.
 *
 * @param orgUnitId - The ID of the affected org unit
 * @returns Promise resolving to array of PainPoint objects
 */
export async function getPainPointsByOrgUnit(
  orgUnitId: string
): Promise<PainPoint[]> {
  const painPoints = await getPainPoints();
  return painPoints.filter((pp) => pp.affectedOrgUnitIds.includes(orgUnitId));
}

/**
 * Fetches pain points by category.
 *
 * @param category - The category to filter by
 * @returns Promise resolving to array of PainPoint objects
 */
export async function getPainPointsByCategory(
  category: PainPointCategory
): Promise<PainPoint[]> {
  const storedCategories = getStoredPainPointCategories(category);
  const categoryConstraint =
    storedCategories.length === 1
      ? where("category", "==", storedCategories[0])
      : where("category", "in", storedCategories);
  const q = query(
    collection(db, "painPoints"),
    categoryConstraint
  );
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => normalizePainPointForRead(doc.data()));
}

/**
 * Fetches unresolved pain points (for prioritization).
 *
 * @returns Promise resolving to array of unresolved PainPoint objects
 */
export async function getUnresolvedPainPoints(): Promise<PainPoint[]> {
  const painPoints = await getPainPoints();
  return painPoints.filter((pp) => pp.status !== "resolved");
}

/**
 * Creates a new pain point in Firestore.
 *
 * @param painPoint - The pain point data without system-managed fields
 * @returns Promise resolving to the newly created PainPoint object
 * @throws Error if Firestore operation fails
 *
 * @example
 * const newPainPoint = await createPainPoint({
 *   title: "Slow checkout process",
 *   description: "Customers abandon carts due to slow checkout",
 *   severity: "high",
 *   category: "customer",
 *   affectedOrgUnitIds: ["ecommerce-team"],
 *   status: "identified",
 *   linkedPrototypeIds: [],
 *   linkedTechnologyIds: [],
 *   linkedInitiativeIds: [],
 *   tags: ["ecommerce", "ux"]
 * });
 */
export async function createPainPoint(
  painPoint: CreatePainPointInput
): Promise<PainPoint> {
  try {
    const now = Date.now();

    // Build data to create, filtering out undefined values
    const dataToCreate: Record<string, unknown> = {
      title: painPoint.title,
      description: painPoint.description || "",
      severity: painPoint.severity,
      category: painPoint.category,
      affectedOrgUnitIds: painPoint.affectedOrgUnitIds || [],
      status: painPoint.status,
      linkedPrototypeIds: painPoint.linkedPrototypeIds || [],
      linkedTechnologyIds: painPoint.linkedTechnologyIds || [],
      linkedInitiativeIds: painPoint.linkedInitiativeIds || [],
      tags: painPoint.tags || [],
      identifiedAt: painPoint.identifiedAt || now,
    };

    // Only add optional fields if they have values
    if (painPoint.estimatedImpact !== undefined) {
      dataToCreate.estimatedImpact = painPoint.estimatedImpact;
    }
    if (painPoint.actualImpact !== undefined) {
      dataToCreate.actualImpact = painPoint.actualImpact;
    }
    if (painPoint.impactDescription) {
      dataToCreate.impactDescription = painPoint.impactDescription;
    }
    if (painPoint.rootCauses && painPoint.rootCauses.length > 0) {
      dataToCreate.rootCauses = painPoint.rootCauses;
    }
    if (painPoint.source) {
      dataToCreate.source = painPoint.source;
    }
    // Use entity-factory for uniqueness-enforced creation
    const result = await createEntity<typeof dataToCreate>(
      'painPoint',
      dataToCreate as typeof dataToCreate & { title: string },
      { graphSync: 'required' }
    );

    const newPainPoint = result.entity as unknown as PainPoint;

    return newPainPoint;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate pain point', { message: error.message });
      throw error;
    }
    // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
    // intact. Wrapping it in a generic Error would hide the identity the
    // saved-locally resolver needs, and the write is already committed.
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error creating pain point', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create pain point: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing pain point.
 *
 * @param id - The ID of the pain point to update
 * @param updates - Partial pain point data to update
 * @returns Promise resolving when update is complete
 * @throws Error if pain point not found or Firestore operation fails
 *
 * @example
 * await updatePainPoint("slow-checkout-123", {
 *   status: "validated",
 *   validatedAt: Date.now()
 * });
 */
export async function updatePainPoint(
  id: string,
  updates: Partial<Omit<PainPoint, "id" | "createdAt">>
): Promise<void> {
  const docRef = doc(db, "painPoints", id);

  // Filter out undefined values (Firebase doesn't accept undefined)
  const filteredUpdates: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      filteredUpdates[key] = value;
    }
  }

  await updateDoc(docRef, filteredUpdates);

  // GRAPH-058: a required, awaited handoff. Fire-and-forget delivery meant the
  // caller could not tell a converged write from a stale projection, and the
  // durable recovery anchor was written from a floating promise a navigating
  // page could abandon. The committed Firestore document is NOT rolled back —
  // callers surface this as "saved locally", never as a failed update.
  await requestEntityGraphSync('painPoint', id, 'update');
}

/**
 * Updates pain point status with automatic date tracking.
 *
 * @param id - The ID of the pain point
 * @param status - The new status
 * @returns Promise resolving when update is complete
 */
export async function updatePainPointStatus(
  id: string,
  status: PainPointStatus
): Promise<void> {
  const updates: Partial<PainPoint> = {
    status,
    updatedAt: Date.now(),
  };

  // Auto-set dates based on status
  if (status === "validated") {
    updates.validatedAt = Date.now();
  }
  if (status === "resolved") {
    updates.resolvedAt = Date.now();
  }

  const docRef = doc(db, "painPoints", id);
  await updateDoc(docRef, updates);
}

/**
 * Deletes a pain point from Firestore.
 *
 * @param id - The ID of the pain point to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deletePainPoint("resolved-issue-123");
 */
export async function deletePainPoint(id: string): Promise<void> {
  const cleanupPlan = await preflightEntityReferenceCleanup('painPoint', id, db);
  await requestEntityGraphDeletion('painPoint', id);

  const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
  const linksDeleted = await deleteLinksForEntity('painPoint', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for pain point', { linksDeleted, id });
  }

  // Once graph ownership is acknowledged, clean up dependent relations.
  const { deleteRelationsForEntity } = await import("@/lib/relations");
  const relationsDeleted = await deleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for pain point', { relationsDeleted, id });
  }

  const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
  const notesDeleted = await deleteAllEntityNotes(db, 'painPoints', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for pain point', { notesDeleted, id });
  }

  await applyEntityReferenceCleanup(cleanupPlan, db);

  await deleteDoc(doc(db, "painPoints", id));
}

/**
 * Links a prototype to a pain point (as a solution).
 *
 * @param painPointId - The ID of the pain point
 * @param prototypeId - The ID of the prototype to link
 * @returns Promise resolving when link is complete
 */
export async function linkPrototype(
  painPointId: string,
  prototypeId: string
): Promise<void> {
  const painPoint = await getPainPointById(painPointId);
  if (!painPoint) throw new Error("Pain point not found");

  if (!painPoint.linkedPrototypeIds.includes(prototypeId)) {
    await updatePainPoint(painPointId, {
      linkedPrototypeIds: [...painPoint.linkedPrototypeIds, prototypeId],
    });
  }
}

/**
 * Links a technology to a pain point (as a solution).
 *
 * @param painPointId - The ID of the pain point
 * @param technologyId - The ID of the technology to link
 * @returns Promise resolving when link is complete
 */
export async function linkTechnology(
  painPointId: string,
  technologyId: string
): Promise<void> {
  const painPoint = await getPainPointById(painPointId);
  if (!painPoint) throw new Error("Pain point not found");

  if (!painPoint.linkedTechnologyIds.includes(technologyId)) {
    await updatePainPoint(painPointId, {
      linkedTechnologyIds: [...painPoint.linkedTechnologyIds, technologyId],
    });
  }
}

/**
 * Unlinks a prototype from a pain point.
 *
 * @param painPointId - The ID of the pain point
 * @param prototypeId - The ID of the prototype to unlink
 * @returns Promise resolving when unlink is complete
 */
export async function unlinkPrototype(
  painPointId: string,
  prototypeId: string
): Promise<void> {
  const painPoint = await getPainPointById(painPointId);
  if (!painPoint) throw new Error("Pain point not found");

  await updatePainPoint(painPointId, {
    linkedPrototypeIds: painPoint.linkedPrototypeIds.filter(
      (id) => id !== prototypeId
    ),
  });
}

/**
 * Searches pain points by title or description.
 *
 * @param query - Search string
 * @returns Promise resolving to matching pain points
 */
export async function searchPainPoints(
  searchQuery: string
): Promise<PainPoint[]> {
  const allPainPoints = await getPainPoints();
  const query = searchQuery.toLowerCase();

  return allPainPoints.filter(
    (pp) =>
      pp.title.toLowerCase().includes(query) ||
      pp.description.toLowerCase().includes(query)
  );
}

/**
 * Gets pain point statistics for dashboard.
 *
 * @returns Promise resolving to pain point counts by status and severity
 */
export async function getPainPointStats(): Promise<{
  total: number;
  byStatus: Record<PainPointStatus, number>;
  bySeverity: Record<PainPointSeverity, number>;
  byCategory: Record<PainPointCategory, number>;
}> {
  const painPoints = await getPainPoints();

  const byStatus: Record<PainPointStatus, number> = {
    identified: 0,
    validated: 0,
    being_addressed: 0,
    resolved: 0,
  };

  const bySeverity: Record<PainPointSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  const byCategory: Record<PainPointCategory, number> = {
    operational: 0,
    customer: 0,
    regulatory: 0,
    technical: 0,
    market: 0,
    financial: 0,
    talent: 0,
    other: 0,
  };

  for (const pp of painPoints) {
    byStatus[pp.status]++;
    bySeverity[pp.severity]++;
    byCategory[pp.category]++;
  }

  return {
    total: painPoints.length,
    byStatus,
    bySeverity,
    byCategory,
  };
}

/**
 * Gets critical pain points requiring immediate attention.
 *
 * @returns Promise resolving to critical unresolved pain points
 */
export async function getCriticalPainPoints(): Promise<PainPoint[]> {
  const painPoints = await getPainPoints();
  return painPoints.filter(
    (pp) => pp.severity === "critical" && pp.status !== "resolved"
  );
}
