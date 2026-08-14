/**
 * @file initiatives-admin.ts
 * @description Admin-SDK twin of the `initiatives` service for SERVER-side callers.
 *
 * Why this exists: `src/lib/initiatives.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and client
 * hooks call it from the browser, where a persistent connection is fine.
 * Server callers (the `/api/ai/chat` route's tool executors, MCP servers,
 * Inngest workers) execute in a stateless context where the client SDK
 * either throws `FIRESTORE INTERNAL ASSERTION FAILED a540` (entity-factory
 * path) or returns `code: 'unavailable'` (plain reads) — the same failure
 * modes observed in the migrated Inngest functions.
 *
 * This file mirrors the initiative operations the AI-assistant tool layer
 * actually invokes (`getInitiatives`, `getInitiativeById`, `createInitiative`,
 * `updateInitiative`, `deleteInitiative` — see
 * `src/lib/ai/tools/new-entities-tools.ts`,
 * `src/lib/ai/tools/entity-creation.ts`,
 * `src/app/api/ai/auto-linker/route.ts`) with EXACT semantics, return shapes,
 * validation, and thrown error types:
 *
 *   - CREATE delegates to `adminCreateEntity('initiative', …)` — same slug,
 *     id, audit fields, scoped uniqueness, DuplicateEntityError, and
 *     post-commit Inngest graph-sync event that the client's
 *     `createEntity('initiative', …)` fires. We do NOT reimplement the
 *     transaction.
 *   - READ/UPDATE/DELETE use the admin API directly. DELETE requires the same
 *     acknowledged graph handoff as the client before removing its source
 *     document. It replicates the client's relation cascade cleanup via
 *     the admin SDK because `deleteRelationsForEntity` (in `relations-core`)
 *     is a client-SDK function and cannot run here.
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
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { createLogger } from '@/lib/logger';
import type { Initiative, CreateInitiativeInput } from '@/lib/types';

const log = createLogger('initiatives-admin');

/**
 * Admin-SDK equivalent of `initiatives.getInitiatives`. Fetches all
 * initiatives from the `initiatives` collection.
 *
 * @returns Promise resolving to an array of Initiative objects
 */
export async function adminGetInitiatives(): Promise<Initiative[]> {
  const snap = await db.collection('initiatives').get();
  return snap.docs.map((doc) => doc.data() as Initiative);
}

/**
 * Admin-SDK equivalent of `initiatives.getInitiativeById`. Fetches a single
 * initiative by ID.
 *
 * @param id - The unique identifier of the initiative
 * @returns Promise resolving to the Initiative object or null if not found
 */
export async function adminGetInitiativeById(id: string): Promise<Initiative | null> {
  const snap = await db.collection('initiatives').doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as Initiative;
}

/**
 * Admin-SDK equivalent of `initiatives.createInitiative`. Same
 * undefined-stripping data shaping and uniqueness-enforced creation
 * (delegates to `adminCreateEntity('initiative', …)`), so it is safe to call
 * from server routes / AI-tool executors against production. Re-throws
 * DuplicateEntityError unchanged. Graph (Neo4j) sync fires via
 * adminCreateEntity's post-commit `app/unified-entity.sync.requested` event.
 *
 * @param initiative - The initiative data without system-managed fields
 * @returns Promise resolving to the newly created Initiative object
 * @throws DuplicateEntityError if an initiative with the same slug exists
 * @throws Error if creation fails for any other reason
 */
export async function adminCreateInitiative(initiative: CreateInitiativeInput): Promise<Initiative> {
  try {
    // Build data to create, filtering out undefined values (matches client).
    const dataToCreate: Record<string, unknown> = {
      name: initiative.name,
      description: initiative.description || '',
      ownerOrgUnitId: initiative.ownerOrgUnitId,
      status: initiative.status,
      priority: initiative.priority,
      linkedStrategyIds: initiative.linkedStrategyIds || [],
      linkedPrototypeIds: initiative.linkedPrototypeIds || [],
      linkedPainPointIds: initiative.linkedPainPointIds || [],
      tags: initiative.tags || [],
    };

    // Only add optional fields if they have values.
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

    // Admin-SDK uniqueness-enforced creation (slug/id/audit + graph sync).
    const result = await adminCreateEntity<typeof dataToCreate>(
      'initiative',
      dataToCreate as typeof dataToCreate & { name: string }
    );

    return result.entity as unknown as Initiative;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers.
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate initiative', { message: error.message });
      throw error;
    }
    log.error('Error creating initiative', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create initiative: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `initiatives.updateInitiative`. Filters out
 * undefined values (Firestore rejects them), stamps `updatedAt`, and fires the
 * same best-effort graph-sync event the client service fires, retaining a
 * durable server recovery anchor when delivery is not acknowledged.
 *
 * @param id - The ID of the initiative to update
 * @param updates - Partial initiative data to update
 * @returns Promise resolving when update is complete
 * @throws Error if Firestore operation fails
 */
export async function adminUpdateInitiative(
  id: string,
  updates: Partial<Omit<Initiative, 'id' | 'createdAt'>>
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

  await db.collection('initiatives').doc(id).update(filteredUpdates);

  await triggerEntityGraphSyncBestEffortServer('initiative', id, 'update');
}

/**
 * Admin-SDK equivalent of `initiatives.deleteInitiative`. Cascade-deletes
 * relations where this initiative is source or target (replicating
 * `deleteRelationsForEntity` via the admin SDK, since that helper is
 * client-SDK only), requires its graph-delete handoff, then deletes the
 * initiative document.
 *
 * @param id - The ID of the initiative to delete
 * @returns Promise resolving when deletion is complete
 * @throws Error if Firestore operation fails
 */
export async function adminDeleteInitiative(id: string): Promise<void> {
  const referencePlan = await adminPlanEntityReferenceCleanup('initiative', id);

  await requestEntityGraphDeletion('initiative', id);

  const linksDeleted = await adminDeleteLinksForEntity('initiative', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for initiative', { linksDeleted, id });
  }

  // Once graph ownership is acknowledged, clean up dependent relations — admin-SDK replication of
  // relations-core.deleteRelationsForEntity (client SDK, unusable here).
  const relationsDeleted = await adminDeleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for initiative', { relationsDeleted, id });
  }

  const notesDeleted = await adminDeleteAllEntityNotes('initiatives', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for initiative', { notesDeleted, id });
  }

  await adminApplyEntityReferenceCleanup(referencePlan);
  await db.collection('initiatives').doc(id).delete();
}
