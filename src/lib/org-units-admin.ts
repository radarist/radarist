/**
 * @file org-units-admin.ts
 * @description Admin-SDK twin of `org-units.ts` for SERVER-side callers
 * (AI-chat tool executors in `src/lib/ai/tools/**`, API routes such as
 * `src/app/api/ai/auto-linker/route.ts`).
 *
 * Why this exists: `src/lib/org-units.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and
 * client-side hooks call into it from the browser, where a persistent
 * connection is fine. The same module invoked server-side inside a
 * stateless serverless function throws `FIRESTORE INTERNAL ASSERTION
 * FAILED a540` (and poisons the in-process client) or returns
 * `code: 'unavailable'` — the same failure mode observed in
 * Inngest workers and which `entity-factory-admin` / `radars-admin` /
 * `signals-admin` already solve.
 *
 * Each function here preserves the EXACT contract of its `org-units.ts`
 * twin — same data shaping (undefined-field filtering), same delegation
 * to the entity factory (`adminCreateEntity('orgUnit', …)`), same audit
 * fields, same post-commit Inngest graph-sync events, same return shapes,
 * and the same thrown error types (`DuplicateEntityError` re-thrown
 * unchanged, other failures wrapped with the same message prefix).
 *
 * NOTE on delete: the client `deleteOrgUnit` cascades relation cleanup
 * via `deleteRelationsForEntity` from `@/lib/relations` — that helper is
 * itself client-SDK only (it would re-trigger a540 server-side). There is
 * no admin relations module, so the cascade is re-implemented here against
 * the admin SDK with identical semantics (delete every relation whose
 * source OR target snapshot id matches the org unit).
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteAllEntityNotes } from '@/lib/entity-notes-cleanup-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import {
  adminApplyEntityReferenceCleanup,
  adminPlanEntityReferenceCleanup,
} from '@/lib/entity-reference-cleanup-admin';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import type { OrgUnit, CreateOrgUnitInput } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('org-units-admin');

/** Firestore collection backing org units (matches ENTITY_CONFIGS.orgUnit.collection). */
const COLLECTION = 'org-units';

/**
 * Admin-SDK equivalent of `getOrgUnits`. Fetches all org units.
 *
 * @returns Promise resolving to an array of OrgUnit objects
 * @throws Error if the Firestore query fails
 */
export async function adminGetOrgUnits(): Promise<OrgUnit[]> {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map((doc) => doc.data() as OrgUnit);
}

/**
 * Admin-SDK equivalent of `getOrgUnitById`. Fetches a single org unit by ID.
 *
 * @param id - The unique identifier of the org unit
 * @returns Promise resolving to the OrgUnit object or null if not found
 * @throws Error if the Firestore query fails
 */
export async function adminGetOrgUnitById(id: string): Promise<OrgUnit | null> {
  const docSnap = await db.collection(COLLECTION).doc(id).get();
  if (docSnap.exists) {
    return docSnap.data() as OrgUnit;
  }
  return null;
}

/**
 * Admin-SDK equivalent of `createOrgUnit`. Same data shaping (undefined
 * optional fields are omitted so Firestore doesn't choke) and same
 * delegation to the entity factory (`adminCreateEntity('orgUnit', …)`),
 * which generates the id/slug/audit fields and fires the post-commit
 * `app/unified-entity.sync.requested` graph-sync event. Re-throws
 * `DuplicateEntityError` unchanged.
 *
 * @param orgUnit - The org unit data without system-managed fields
 * @returns Promise resolving to the newly created OrgUnit object
 * @throws DuplicateEntityError if an org unit with the same slug exists
 * @throws Error if the create operation fails
 */
export async function adminCreateOrgUnit(orgUnit: CreateOrgUnitInput): Promise<OrgUnit> {
  try {
    // Build data to create, filtering out undefined values (mirrors client twin).
    const dataToCreate: Record<string, unknown> = {
      name: orgUnit.name,
      description: orgUnit.description || '',
      type: orgUnit.type,
      level: orgUnit.level,
      tags: orgUnit.tags || [],
    };

    // Only add optional fields if they have values.
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

    // Use entity-factory (admin) for uniqueness-enforced creation.
    const result = await adminCreateEntity<typeof dataToCreate>(
      'orgUnit',
      dataToCreate as typeof dataToCreate & { name: string }
    );

    const newOrgUnit = result.entity as unknown as OrgUnit;

    return newOrgUnit;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers.
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate org unit', { message: error.message });
      throw error;
    }
    log.error('Error creating org unit', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create org unit: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `updateOrgUnit`. Same undefined-filtering, same
 * `updatedAt` stamp, same post-commit graph-sync trigger.
 *
 * @param id - The ID of the org unit to update
 * @param updates - Partial org unit data to update
 * @returns Promise resolving when the update is complete
 * @throws Error if the Firestore operation fails
 */
export async function adminUpdateOrgUnit(
  id: string,
  updates: Partial<Omit<OrgUnit, 'id' | 'createdAt'>>
): Promise<void> {
  // Filter out undefined values (Firebase doesn't accept undefined).
  const filteredUpdates: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      filteredUpdates[key] = value;
    }
  }

  await db.collection(COLLECTION).doc(id).update(filteredUpdates);

  await triggerEntityGraphSyncBestEffortServer('orgUnit', id, 'update');
}

/**
 * Admin-SDK equivalent of `deleteOrgUnit`. Preflights ownership blockers and
 * reverse references, requires the graph-delete handoff, then preserves the
 * existing link/relation/note cleanup before removing live references and the
 * source document. Child Org Units and owned Initiatives block deletion until
 * they are explicitly reassigned; neither is silently orphaned or cascaded.
 *
 * The relation cleanup is re-implemented against the admin SDK here because
 * the client `deleteRelationsForEntity` is client-SDK only.
 *
 * @param id - The ID of the org unit to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if the Firestore operation fails
 */
export async function adminDeleteOrgUnit(id: string): Promise<void> {
  const referencePlan = await adminPlanEntityReferenceCleanup('orgUnit', id);

  await requestEntityGraphDeletion('orgUnit', id);

  const linksDeleted = await adminDeleteLinksForEntity('orgUnit', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for org unit', { linksDeleted, id });
  }

  // Once graph ownership is acknowledged, clean up dependent relations — admin-SDK reimplementation of
  // deleteRelationsForEntity to avoid dragging the client-SDK relations module
  // across the server boundary.
  const relationsDeleted = await adminDeleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for org unit', { relationsDeleted, id });
  }

  const notesDeleted = await adminDeleteAllEntityNotes(COLLECTION, id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for org unit', { notesDeleted, id });
  }

  await adminApplyEntityReferenceCleanup(referencePlan);
  await db.collection(COLLECTION).doc(id).delete();
}
