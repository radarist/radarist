/**
 * @file org-units.ts
 * @description Data access layer for Organizational Units (OrgUnits) in Phase 3.
 *
 * OrgUnits represent the organizational structure (departments, teams, business units).
 * They enable "owned by" relationships and provide organizational context for innovation.
 *
 * Key Features:
 * - Hierarchical structure with parent-child relationships
 * - Support for different org unit types (business_unit, department, team, etc.)
 * - Budget and employee count tracking
 * - Integration with initiatives and pain points
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
import type { OrgUnit, OrgUnitType, OrgUnitLevel, CreateOrgUnitInput } from "@/lib/types";
import { EntitySyncDispatchError, requestEntityGraphDeletion, requestEntityGraphSync } from "@/lib/entity-sync";
import { createEntity, DuplicateEntityError } from "@/lib/entity-factory";
import {
  applyEntityReferenceCleanup,
  preflightEntityReferenceCleanup,
} from '@/lib/entity-reference-cleanup';
import { createLogger } from '@/lib/logger';
const log = createLogger('org-units');

/**
 * Search and filter options for org units.
 */
export interface OrgUnitFilters {
  /** Text search query (searches name and description). */
  searchQuery?: string;
  /** Filter by org unit type. */
  type?: OrgUnitType[];
  /** Filter by parent org unit ID. */
  parentId?: string;
  /** Filter by level in hierarchy. */
  level?: OrgUnitLevel;
  /** Filter by location. */
  location?: string;
  /** Filter by tags. */
  tags?: string[];
}

/**
 * Fetches all org units from Firestore.
 *
 * @returns Promise resolving to an array of OrgUnit objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const orgUnits = await getOrgUnits();
 * console.log(`Total org units: ${orgUnits.length}`);
 */
export async function getOrgUnits(): Promise<OrgUnit[]> {
  const querySnapshot = await getDocs(collection(db, "org-units"));
  return querySnapshot.docs.map((doc) => doc.data() as OrgUnit);
}

/**
 * Fetches org units with optional filters.
 *
 * @param filters - Optional filter criteria
 * @returns Promise resolving to filtered array of OrgUnit objects
 */
export async function getOrgUnitsWithFilters(
  filters?: OrgUnitFilters
): Promise<OrgUnit[]> {
  let orgUnits = await getOrgUnits();

  if (!filters) return orgUnits;

  // Apply filters in memory (Firestore doesn't support complex queries without indexes)
  if (filters.searchQuery) {
    const query = filters.searchQuery.toLowerCase();
    orgUnits = orgUnits.filter(
      (unit) =>
        unit.name.toLowerCase().includes(query) ||
        unit.description?.toLowerCase().includes(query)
    );
  }

  if (filters.type && filters.type.length > 0) {
    orgUnits = orgUnits.filter((unit) => filters.type!.includes(unit.type));
  }

  if (filters.parentId !== undefined) {
    orgUnits = orgUnits.filter((unit) => unit.parentId === filters.parentId);
  }

  if (filters.level !== undefined) {
    orgUnits = orgUnits.filter((unit) => unit.level === filters.level);
  }

  if (filters.location) {
    const location = filters.location.toLowerCase();
    orgUnits = orgUnits.filter((unit) =>
      unit.location?.toLowerCase().includes(location)
    );
  }

  if (filters.tags && filters.tags.length > 0) {
    orgUnits = orgUnits.filter((unit) =>
      filters.tags!.some((tag) => unit.tags.includes(tag))
    );
  }

  // Sort by level then name
  return orgUnits.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Fetches a single org unit by ID.
 *
 * @param id - The unique identifier of the org unit
 * @returns Promise resolving to the OrgUnit object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * const unit = await getOrgUnitById("engineering-123");
 * if (unit) {
 *   console.log(`${unit.name} has ${unit.employeeCount} employees`);
 * }
 */
export async function getOrgUnitById(id: string): Promise<OrgUnit | null> {
  const docRef = doc(db, "org-units", id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as OrgUnit;
  }
  return null;
}

/**
 * Fetches all children of a parent org unit.
 *
 * @param parentId - The ID of the parent org unit
 * @returns Promise resolving to array of child OrgUnit objects
 */
export async function getOrgUnitChildren(parentId: string): Promise<OrgUnit[]> {
  const q = query(
    collection(db, "org-units"),
    where("parentId", "==", parentId)
  );
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as OrgUnit);
}

/**
 * Fetches all root org units (those without a parent).
 *
 * @returns Promise resolving to array of root OrgUnit objects
 */
export async function getRootOrgUnits(): Promise<OrgUnit[]> {
  const orgUnits = await getOrgUnits();
  return orgUnits.filter((unit) => !unit.parentId);
}

/**
 * Builds the full hierarchy tree of org units.
 *
 * @returns Promise resolving to nested structure of org units
 */
export interface OrgUnitNode extends OrgUnit {
  children: OrgUnitNode[];
}

export async function getOrgUnitTree(): Promise<OrgUnitNode[]> {
  const allUnits = await getOrgUnits();
  const unitMap = new Map<string, OrgUnitNode>();

  // Create nodes for all units
  for (const unit of allUnits) {
    unitMap.set(unit.id, { ...unit, children: [] });
  }

  // Build tree structure
  const rootNodes: OrgUnitNode[] = [];
  for (const node of unitMap.values()) {
    if (node.parentId && unitMap.has(node.parentId)) {
      unitMap.get(node.parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // Sort children by name
  const sortChildren = (nodes: OrgUnitNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) {
      sortChildren(node.children);
    }
  };
  sortChildren(rootNodes);

  return rootNodes;
}

/**
 * Creates a new org unit in Firestore.
 *
 * @param orgUnit - The org unit data without system-managed fields
 * @returns Promise resolving to the newly created OrgUnit object
 * @throws Error if Firestore operation fails
 *
 * @example
 * const newUnit = await createOrgUnit({
 *   name: "Engineering",
 *   description: "Engineering department",
 *   type: "department",
 *   level: 2,
 *   parentId: "company-root",
 *   tags: ["tech", "product"]
 * });
 */
export async function createOrgUnit(
  orgUnit: CreateOrgUnitInput
): Promise<OrgUnit> {
  try {
    // Build data to create, filtering out undefined values
    const dataToCreate: Record<string, unknown> = {
      name: orgUnit.name,
      description: orgUnit.description || "",
      type: orgUnit.type,
      level: orgUnit.level,
      tags: orgUnit.tags || [],
    };

    // Only add optional fields if they have values
    if (orgUnit.parentId) {
      dataToCreate.parentId = orgUnit.parentId;
    }
    if (orgUnit.headUserId) {
      dataToCreate.headUserId = orgUnit.headUserId;
    }
    if (orgUnit.headName) {
      dataToCreate.headName = orgUnit.headName;
    }
    if (orgUnit.employeeCount !== undefined) {
      dataToCreate.employeeCount = orgUnit.employeeCount;
    }
    if (orgUnit.annualBudget !== undefined) {
      dataToCreate.annualBudget = orgUnit.annualBudget;
    }
    if (orgUnit.location) {
      dataToCreate.location = orgUnit.location;
    }

    // Use entity-factory for uniqueness-enforced creation
    const result = await createEntity<typeof dataToCreate>(
      'orgUnit',
      dataToCreate as typeof dataToCreate & { name: string },
      { graphSync: 'required' }
    );

    const newOrgUnit = result.entity as unknown as OrgUnit;

    return newOrgUnit;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate org unit', { message: error.message });
      throw error;
    }
    // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
    // intact. Wrapping it in a generic Error would hide the identity the
    // saved-locally resolver needs, and the write is already committed.
    if (error instanceof EntitySyncDispatchError) throw error;
    log.error('Error creating org unit', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create org unit: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Updates an existing org unit.
 *
 * @param id - The ID of the org unit to update
 * @param updates - Partial org unit data to update
 * @returns Promise resolving when update is complete
 * @throws Error if org unit not found or Firestore operation fails
 *
 * @example
 * await updateOrgUnit("engineering-123", {
 *   employeeCount: 150,
 *   annualBudget: 5000000
 * });
 */
export async function updateOrgUnit(
  id: string,
  updates: Partial<Omit<OrgUnit, "id" | "createdAt">>
): Promise<void> {
  const docRef = doc(db, "org-units", id);

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
  await requestEntityGraphSync('orgUnit', id, 'update');
}

/**
 * Deletes an org unit from Firestore. Child Org Units and owned Initiatives
 * must be explicitly reassigned first; the preflight blocks instead of
 * cascading or orphaning either dependency.
 *
 * @param id - The ID of the org unit to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deleteOrgUnit("old-team-123");
 */
export async function deleteOrgUnit(id: string): Promise<void> {
  // Required ownership is fail-closed: child units and owned Initiatives must
  // be reassigned before graph handoff or any Firestore cleanup begins.
  const cleanupPlan = await preflightEntityReferenceCleanup('orgUnit', id, db);

  await requestEntityGraphDeletion('orgUnit', id);

  const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
  const linksDeleted = await deleteLinksForEntity('orgUnit', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for org unit', { linksDeleted, id });
  }

  // Once graph ownership is acknowledged, clean up dependent relations.
  const { deleteRelationsForEntity } = await import("@/lib/relations");
  const relationsDeleted = await deleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for org unit', { relationsDeleted, id });
  }

  const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
  const notesDeleted = await deleteAllEntityNotes(db, 'org-units', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for org unit', { notesDeleted, id });
  }

  await applyEntityReferenceCleanup(cleanupPlan, db);

  await deleteDoc(doc(db, "org-units", id));
}

/**
 * Checks if an org unit has any children.
 *
 * @param id - The ID of the org unit to check
 * @returns Promise resolving to true if has children
 */
export async function hasChildren(id: string): Promise<boolean> {
  const children = await getOrgUnitChildren(id);
  return children.length > 0;
}

/**
 * Gets the full ancestry path of an org unit.
 *
 * @param id - The ID of the org unit
 * @returns Promise resolving to array of OrgUnits from root to current
 */
export async function getOrgUnitAncestry(id: string): Promise<OrgUnit[]> {
  const ancestry: OrgUnit[] = [];
  let currentId: string | undefined = id;

  while (currentId) {
    const unit = await getOrgUnitById(currentId);
    if (unit) {
      ancestry.unshift(unit);
      currentId = unit.parentId;
    } else {
      break;
    }
  }

  return ancestry;
}

/**
 * Searches org units by name.
 *
 * @param query - Search string
 * @returns Promise resolving to matching org units
 */
export async function searchOrgUnits(searchQuery: string): Promise<OrgUnit[]> {
  const allUnits = await getOrgUnits();
  const query = searchQuery.toLowerCase();

  return allUnits.filter(
    (unit) =>
      unit.name.toLowerCase().includes(query) ||
      unit.description?.toLowerCase().includes(query)
  );
}
