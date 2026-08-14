/**
 * @file initiatives.ts
 * @description Data access layer for Initiatives in Phase 3.
 *
 * Initiatives are strategic projects that bridge Strategy → Prototype.
 * They have budgets, timelines, and track progress across prototypes.
 *
 * Key Features:
 * - Lifecycle management (proposed → approved → active → completed)
 * - Budget tracking and milestone management
 * - Links to strategies, prototypes, and pain points
 * - Owned by organizational units
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
  Initiative,
  InitiativeStatus,
  InitiativePriority,
  CreateInitiativeInput,
} from "@/lib/types";
import { EntitySyncDispatchError, requestEntityGraphDeletion, requestEntityGraphSync } from "@/lib/entity-sync";
import { createEntity, DuplicateEntityError } from "@/lib/entity-factory";
import {
  applyEntityReferenceCleanup,
  preflightEntityReferenceCleanup,
} from '@/lib/entity-reference-cleanup';
import { createLogger } from '@/lib/logger';
const log = createLogger('initiatives');

/**
 * Search and filter options for initiatives.
 */
export interface InitiativeFilters {
  /** Text search query (searches name and description). */
  searchQuery?: string;
  /** Filter by status. */
  status?: InitiativeStatus[];
  /** Filter by priority. */
  priority?: InitiativePriority[];
  /** Filter by owner org unit ID. */
  ownerOrgUnitId?: string;
  /** Filter by linked strategy IDs. */
  linkedStrategyIds?: string[];
  /** Filter by tags. */
  tags?: string[];
}

/**
 * Fetches all initiatives from Firestore.
 *
 * @returns Promise resolving to an array of Initiative objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const initiatives = await getInitiatives();
 * console.log(`Total initiatives: ${initiatives.length}`);
 */
export async function getInitiatives(): Promise<Initiative[]> {
  const querySnapshot = await getDocs(collection(db, "initiatives"));
  return querySnapshot.docs.map((doc) => doc.data() as Initiative);
}

/**
 * Fetches initiatives with optional filters.
 *
 * @param filters - Optional filter criteria
 * @returns Promise resolving to filtered array of Initiative objects
 */
export async function getInitiativesWithFilters(
  filters?: InitiativeFilters
): Promise<Initiative[]> {
  let initiatives = await getInitiatives();

  if (!filters) return initiatives;

  // Apply filters in memory
  if (filters.searchQuery) {
    const query = filters.searchQuery.toLowerCase();
    initiatives = initiatives.filter(
      (initiative) =>
        initiative.name.toLowerCase().includes(query) ||
        initiative.description.toLowerCase().includes(query)
    );
  }

  if (filters.status && filters.status.length > 0) {
    initiatives = initiatives.filter((initiative) =>
      filters.status!.includes(initiative.status)
    );
  }

  if (filters.priority && filters.priority.length > 0) {
    initiatives = initiatives.filter((initiative) =>
      filters.priority!.includes(initiative.priority)
    );
  }

  if (filters.ownerOrgUnitId) {
    initiatives = initiatives.filter(
      (initiative) => initiative.ownerOrgUnitId === filters.ownerOrgUnitId
    );
  }

  if (filters.linkedStrategyIds && filters.linkedStrategyIds.length > 0) {
    initiatives = initiatives.filter((initiative) =>
      filters.linkedStrategyIds!.some((id) =>
        initiative.linkedStrategyIds.includes(id)
      )
    );
  }

  if (filters.tags && filters.tags.length > 0) {
    initiatives = initiatives.filter((initiative) =>
      filters.tags!.some((tag) => initiative.tags.includes(tag))
    );
  }

  // Sort by priority then name
  const priorityOrder: Record<InitiativePriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return initiatives.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Fetches a single initiative by ID.
 *
 * @param id - The unique identifier of the initiative
 * @returns Promise resolving to the Initiative object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * const initiative = await getInitiativeById("digital-transformation-123");
 * if (initiative) {
 *   console.log(`${initiative.name} is ${initiative.status}`);
 * }
 */
export async function getInitiativeById(id: string): Promise<Initiative | null> {
  const docRef = doc(db, "initiatives", id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as Initiative;
  }
  return null;
}

/**
 * Fetches initiatives by owner org unit.
 *
 * @param orgUnitId - The ID of the owning org unit
 * @returns Promise resolving to array of Initiative objects
 */
export async function getInitiativesByOrgUnit(
  orgUnitId: string
): Promise<Initiative[]> {
  const q = query(
    collection(db, "initiatives"),
    where("ownerOrgUnitId", "==", orgUnitId)
  );
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as Initiative);
}

/**
 * Fetches initiatives by linked strategy.
 *
 * @param strategyId - The ID of the strategy
 * @returns Promise resolving to array of Initiative objects
 */
export async function getInitiativesByStrategy(
  strategyId: string
): Promise<Initiative[]> {
  const initiatives = await getInitiatives();
  return initiatives.filter((initiative) =>
    initiative.linkedStrategyIds.includes(strategyId)
  );
}

/**
 * Fetches initiatives by status for Kanban view.
 *
 * @returns Promise resolving to initiatives grouped by status
 */
export async function getInitiativesForKanban(): Promise<
  Record<InitiativeStatus, Initiative[]>
> {
  const initiatives = await getInitiatives();

  const grouped: Record<InitiativeStatus, Initiative[]> = {
    proposed: [],
    approved: [],
    active: [],
    on_hold: [],
    completed: [],
    cancelled: [],
  };

  for (const initiative of initiatives) {
    grouped[initiative.status].push(initiative);
  }

  // Sort each group by priority
  const priorityOrder: Record<InitiativePriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  for (const status of Object.keys(grouped) as InitiativeStatus[]) {
    grouped[status].sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );
  }

  return grouped;
}

/**
 * Creates a new initiative in Firestore.
 *
 * @param initiative - The initiative data without system-managed fields
 * @returns Promise resolving to the newly created Initiative object
 * @throws Error if Firestore operation fails
 *
 * @example
 * const newInitiative = await createInitiative({
 *   name: "Digital Transformation",
 *   description: "Transform core operations using AI",
 *   ownerOrgUnitId: "engineering-123",
 *   status: "proposed",
 *   priority: "high",
 *   linkedStrategyIds: ["ai-strategy-123"],
 *   linkedPrototypeIds: [],
 *   linkedPainPointIds: ["ops-inefficiency-123"],
 *   tags: ["transformation", "ai"]
 * });
 */
export async function createInitiative(
  initiative: CreateInitiativeInput
): Promise<Initiative> {
  try {
    // Build data to create, filtering out undefined values
    const dataToCreate: Record<string, unknown> = {
      name: initiative.name,
      description: initiative.description || "",
      ownerOrgUnitId: initiative.ownerOrgUnitId,
      status: initiative.status,
      priority: initiative.priority,
      linkedStrategyIds: initiative.linkedStrategyIds || [],
      linkedPrototypeIds: initiative.linkedPrototypeIds || [],
      linkedPainPointIds: initiative.linkedPainPointIds || [],
      tags: initiative.tags || [],
    };

    // Only add optional fields if they have values
    if (initiative.ownerOrgUnitName) {
      dataToCreate.ownerOrgUnitName = initiative.ownerOrgUnitName;
    }
    if (initiative.sponsorUserId) {
      dataToCreate.sponsorUserId = initiative.sponsorUserId;
    }
    if (initiative.sponsorName) {
      dataToCreate.sponsorName = initiative.sponsorName;
    }
    if (initiative.startDate !== undefined) {
      dataToCreate.startDate = initiative.startDate;
    }
    if (initiative.targetEndDate !== undefined) {
      dataToCreate.targetEndDate = initiative.targetEndDate;
    }
    if (initiative.actualEndDate !== undefined) {
      dataToCreate.actualEndDate = initiative.actualEndDate;
    }
    if (initiative.budget !== undefined) {
      dataToCreate.budget = initiative.budget;
    }
    if (initiative.actualSpend !== undefined) {
      dataToCreate.actualSpend = initiative.actualSpend;
    }

    // Use entity-factory for uniqueness-enforced creation
    const result = await createEntity<typeof dataToCreate>(
      'initiative',
      dataToCreate as typeof dataToCreate & { name: string },
      { graphSync: 'required' }
    );

    const newInitiative = result.entity as unknown as Initiative;

    return newInitiative;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate initiative', { message: error.message });
      throw error;
    }
    // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
    // intact. Wrapping it in a generic Error would hide the identity the
    // saved-locally resolver needs, and the write is already committed.
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error creating initiative', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create initiative: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing initiative.
 *
 * @param id - The ID of the initiative to update
 * @param updates - Partial initiative data to update
 * @returns Promise resolving when update is complete
 * @throws Error if initiative not found or Firestore operation fails
 *
 * @example
 * await updateInitiative("digital-transformation-123", {
 *   status: "active",
 *   startDate: Date.now()
 * });
 */
export async function updateInitiative(
  id: string,
  updates: Partial<Omit<Initiative, "id" | "createdAt">>
): Promise<void> {
  const docRef = doc(db, "initiatives", id);

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
  await requestEntityGraphSync('initiative', id, 'update');
}

/**
 * Updates initiative status with automatic date tracking.
 *
 * @param id - The ID of the initiative
 * @param status - The new status
 * @returns Promise resolving when update is complete
 */
export async function updateInitiativeStatus(
  id: string,
  status: InitiativeStatus
): Promise<void> {
  const updates: Partial<Initiative> = {
    status,
    updatedAt: Date.now(),
  };

  // Auto-set dates based on status
  if (status === "active" && !(await getInitiativeById(id))?.startDate) {
    updates.startDate = Date.now();
  }
  if (status === "completed" || status === "cancelled") {
    updates.actualEndDate = Date.now();
  }

  const docRef = doc(db, "initiatives", id);
  await updateDoc(docRef, updates);
}

/**
 * Deletes an initiative from Firestore.
 *
 * @param id - The ID of the initiative to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deleteInitiative("cancelled-initiative-123");
 */
export async function deleteInitiative(id: string): Promise<void> {
  const cleanupPlan = await preflightEntityReferenceCleanup('initiative', id, db);
  await requestEntityGraphDeletion('initiative', id);

  const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
  const linksDeleted = await deleteLinksForEntity('initiative', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for initiative', { linksDeleted, id });
  }

  // Once graph ownership is acknowledged, clean up dependent relations.
  const { deleteRelationsForEntity } = await import("@/lib/relations");
  const relationsDeleted = await deleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for initiative', { relationsDeleted, id });
  }

  const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
  const notesDeleted = await deleteAllEntityNotes(db, 'initiatives', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for initiative', { notesDeleted, id });
  }

  await applyEntityReferenceCleanup(cleanupPlan, db);

  await deleteDoc(doc(db, "initiatives", id));
}

/**
 * Links a prototype to an initiative.
 *
 * @param initiativeId - The ID of the initiative
 * @param prototypeId - The ID of the prototype to link
 * @returns Promise resolving when link is complete
 */
export async function linkPrototype(
  initiativeId: string,
  prototypeId: string
): Promise<void> {
  const initiative = await getInitiativeById(initiativeId);
  if (!initiative) throw new Error("Initiative not found");

  if (!initiative.linkedPrototypeIds.includes(prototypeId)) {
    await updateInitiative(initiativeId, {
      linkedPrototypeIds: [...initiative.linkedPrototypeIds, prototypeId],
    });
  }
}

/**
 * Unlinks a prototype from an initiative.
 *
 * @param initiativeId - The ID of the initiative
 * @param prototypeId - The ID of the prototype to unlink
 * @returns Promise resolving when unlink is complete
 */
export async function unlinkPrototype(
  initiativeId: string,
  prototypeId: string
): Promise<void> {
  const initiative = await getInitiativeById(initiativeId);
  if (!initiative) throw new Error("Initiative not found");

  await updateInitiative(initiativeId, {
    linkedPrototypeIds: initiative.linkedPrototypeIds.filter(
      (id) => id !== prototypeId
    ),
  });
}

/**
 * Searches initiatives by name or description.
 *
 * @param query - Search string
 * @returns Promise resolving to matching initiatives
 */
export async function searchInitiatives(
  searchQuery: string
): Promise<Initiative[]> {
  const allInitiatives = await getInitiatives();
  const query = searchQuery.toLowerCase();

  return allInitiatives.filter(
    (initiative) =>
      initiative.name.toLowerCase().includes(query) ||
      initiative.description.toLowerCase().includes(query)
  );
}

/**
 * Gets initiative statistics for dashboard.
 *
 * @returns Promise resolving to initiative counts by status
 */
export async function getInitiativeStats(): Promise<{
  total: number;
  byStatus: Record<InitiativeStatus, number>;
  byPriority: Record<InitiativePriority, number>;
}> {
  const initiatives = await getInitiatives();

  const byStatus: Record<InitiativeStatus, number> = {
    proposed: 0,
    approved: 0,
    active: 0,
    on_hold: 0,
    completed: 0,
    cancelled: 0,
  };

  const byPriority: Record<InitiativePriority, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const initiative of initiatives) {
    byStatus[initiative.status]++;
    byPriority[initiative.priority]++;
  }

  return {
    total: initiatives.length,
    byStatus,
    byPriority,
  };
}
