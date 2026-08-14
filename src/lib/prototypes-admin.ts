/**
 * @file prototypes-admin.ts
 * @description Narrow admin-SDK twin of the small set of `prototypes`
 * operations the AI assistant + server routes invoke from the server side.
 *
 * Why this exists: `src/lib/prototypes.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and
 * client-side hooks call into it from the browser, where a persistent
 * connection is fine. The `/api/ai/chat` route, the `entity-creation`
 * AI tool executors and the `/api/search` route, however, execute on the
 * server inside stateless serverless
 * functions — the client SDK can't hold a connection there and reads/writes
 * fail with `FIRESTORE INTERNAL ASSERTION FAILED a540` (createEntity path) or
 * `code: 'unavailable'` (the same failure mode observed in
 * Inngest workers and the radars-admin / signals-admin helpers).
 *
 * This file exposes ONLY the operations the server actually needs:
 *
 *   - adminCreatePrototype(prototype)  — for the `createPrototype` AI tool
 *   - adminGetPrototypes()             — for the `getPrototypes` reads in the
 *                                        AI entity-creation/enrichment tools
 *                                        and `/api/search`
 *   - adminGetPrototypeById(id)        — for the `getEntityDetails` /
 *                                        `getRelatedEntities` legacy executors
 *                                        in `src/lib/ai/tools.ts`
 *   - adminUpdatePrototype(id, updates)— for the `updateEntity` legacy executor
 *                                        in `src/lib/ai/tools.ts`
 *   - adminDeletePrototype(id)         — single delete with cascade relation
 *                                        cleanup (mirror of `deletePrototype`)
 *   - adminDeletePrototypes(ids)       — bulk delete with cascade relation
 *                                        cleanup, for `/api/prototypes/bulk-delete`
 *                                        (mirror of `deletePrototypes`)
 *
 * Creation delegates to `adminCreateEntity('prototype', …)` so slug / id /
 * audit fields / scoped-uniqueness / DuplicateEntityError / the post-commit
 * `app/unified-entity.sync.requested` graph-sync event are IDENTICAL to the
 * client path (which goes through entity-factory + triggerEntitySync). The
 * richer link/cost/analytics surface stays on the client-SDK service module —
 * the server callers don't need it and we don't want to duplicate it.
 *
 * Deliberate, documented divergence from the client `deletePrototypes` (NOT
 * load-bearing): `emitDataRefresh('prototypes', 'bulk-delete')` is omitted. It
 * is a browser-only `window.dispatchEvent` (guarded by `typeof window`, a no-op
 * server-side), so it has zero effect in this server-only module — matching the
 * `companies-admin.ts` precedent.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteAllEntityNotes } from '@/lib/entity-notes-cleanup-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import {
  adminApplyEntityReferenceCleanup,
  adminPlanEntityReferenceCleanup,
  adminPlanEntityReferenceCleanups,
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE,
} from '@/lib/entity-reference-cleanup-admin';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  requestEntityGraphDeletionsServer as requestEntityGraphDeletions,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
import type { Prototype } from '@/lib/types';

const log = createLogger('prototypes-admin');

/**
 * Admin-SDK equivalent of `prototypes.getPrototypes`. Returns all prototypes
 * ordered by creation date (most recent first). Mirrors the client read's
 * `orderBy('createdAt', 'desc')` + return shape (`Prototype[]`).
 */
export async function adminGetPrototypes(): Promise<Prototype[]> {
  try {
    const snap = await db.collection('prototypes').orderBy('createdAt', 'desc').get();
    return snap.docs.map((doc) => doc.data() as Prototype);
  } catch (error) {
    log.error('Error fetching prototypes (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch prototypes');
  }
}

/**
 * Admin-SDK equivalent of `prototypes.getPrototypeById`. Returns the prototype
 * or `null` when the document doesn't exist. Mirrors the client read's return
 * shape (`Prototype | null`) and its `Failed to fetch prototype ${id}` throw on
 * Firestore error.
 */
export async function adminGetPrototypeById(id: string): Promise<Prototype | null> {
  try {
    const snap = await db.collection('prototypes').doc(id).get();
    if (!snap.exists) {
      return null;
    }
    return snap.data() as Prototype;
  } catch (error) {
    log.error('Error fetching prototype (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch prototype ${id}`);
  }
}

/**
 * Admin-SDK equivalent of `prototypes.createPrototype`. Same validation
 * (name + description required), same undefined-stripping (the Admin SDK
 * rejects `undefined` field values, so this is load-bearing), and delegates
 * to `adminCreateEntity('prototype', …)` for slug / id / audit fields /
 * uniqueness. Re-throws DuplicateEntityError unchanged. Graph (Neo4j) sync
 * fires via adminCreateEntity's post-commit `app/unified-entity.sync.requested`
 * event — the admin twin of the client's `triggerEntitySync('prototype', …)`.
 */
export async function adminCreatePrototype(
  prototype: Omit<Prototype, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<Prototype> {
  try {
    // Validate required fields (matches client createPrototype).
    if (!prototype.name || !prototype.description) {
      throw new Error('Prototype name and description are required');
    }

    // Remove undefined values before saving (Admin SDK rejects undefined).
    const cleanedPrototype = sanitizeForFirestore(prototype) as Omit<
      Prototype,
      'id' | 'slug' | 'createdAt' | 'updatedAt'
    >;

    const result = await adminCreateEntity<typeof cleanedPrototype>('prototype', cleanedPrototype);
    return result.entity as Prototype;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers.
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate prototype', { message: error.message });
      throw error;
    }
    log.error('Error creating prototype (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create prototype: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `prototypes.updatePrototype`. Same existence check
 * (throws `Prototype ${id} not found` when the doc is missing), same
 * undefined-stripping + `updatedAt` bump (the Admin SDK rejects `undefined`
 * field values, so this is load-bearing), and same best-effort Neo4j sync with
 * a durable server recovery anchor. Wraps Firestore errors in the same
 * `Failed to update prototype ${id}: …` message shape the client service uses.
 */
export async function adminUpdatePrototype(
  id: string,
  updates: Partial<Omit<Prototype, 'id' | 'createdAt'>>
): Promise<void> {
  try {
    const docRef = db.collection('prototypes').doc(id);

    // Check if prototype exists (matches client updatePrototype).
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new Error(`Prototype ${id} not found`);
    }

    // Remove undefined values before updating (Admin SDK rejects undefined).
    const cleanedUpdates = sanitizeForFirestore({
      ...updates,
      updatedAt: Date.now(),
    });
    await docRef.update(cleanedUpdates);

    await triggerEntityGraphSyncBestEffortServer('prototype', id, 'update');

    log.info('Successfully updated prototype (admin)', { id });
  } catch (error) {
    log.error('Error updating prototype (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update prototype ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Result of a bulk delete operation. Mirrors `BulkDeleteResult` from
 * `prototypes.ts` so `adminDeletePrototypes` returns the same shape.
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
 * Admin-SDK equivalent of `prototypes.deletePrototype`. Same order of
 * operations: require the graph-delete handoff, clean up relations, then delete
 * the prototype document. Wraps non-delivery Firestore errors in the same
 * `Failed to delete prototype ${id}` message shape the client service uses.
 */
async function preparePrototypeDeletion(id: string): Promise<number> {
    const linksDeleted = await adminDeleteLinksForEntity('prototype', id);
    if (linksDeleted > 0) {
      log.info('Cleaned up document links for prototype (admin)', { linksDeleted, id });
    }

    const relationsDeleted = await adminDeleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for prototype (admin)', { relationsDeleted, id });
    }

    const notesDeleted = await adminDeleteAllEntityNotes('prototypes', id);
    if (notesDeleted > 0) {
      log.info('Cleaned up notes subcollection for prototype (admin)', { notesDeleted, id });
    }

    return relationsDeleted;
}

export async function adminDeletePrototype(id: string): Promise<void> {
  try {
    const referencePlan = await adminPlanEntityReferenceCleanup('prototype', id);

    await requestEntityGraphDeletion('prototype', id);
    await preparePrototypeDeletion(id);
    await adminApplyEntityReferenceCleanup(referencePlan);

    // Delete the prototype document only after the graph handoff is durable.
    await db.collection('prototypes').doc(id).delete();
    log.info('Deleted prototype (admin)', { id });
  } catch (error) {
    log.error('Error deleting prototype (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    if (error instanceof EntitySyncDispatchError || error instanceof EntityDeletionBlockedError) throw error;
    throw new Error(`Failed to delete prototype ${id}`, { cause: error });
  }
}

/**
 * Admin-SDK equivalent of `prototypes.deletePrototypes` (the function
 * `/api/prototypes/bulk-delete` invokes). It processes batches of at most 450,
 * preflights reverse references, requires graph handoffs only for successful
 * plans, then prepares document-link, relation, note, and reverse-reference
 * cleanup with bounded concurrency. Only fully prepared parents enter the
 * Firestore batch; prerequisite and batch failures return exact IDs.
 *
 * Divergence: the client's terminal `emitDataRefresh('prototypes',
 * 'bulk-delete')` is intentionally omitted — it is a `typeof window`-guarded
 * browser-only no-op server-side (see file header).
 */
export async function adminDeletePrototypes(ids: string[]): Promise<BulkDeleteResult> {
  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Leave headroom below Firestore's hard 500-write batch limit.
  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const preflight = await adminPlanEntityReferenceCleanups('prototype', batchIds);
    for (const { id, error } of preflight.failed) {
      failed.push(id);
      log.warn('Prototype reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (preflight.planned.length === 0) continue;

    const plansById = new Map(preflight.planned.map((plan) => [plan.entityId, plan]));
    const preflightedIds = preflight.planned.map((plan) => plan.entityId);

    const handoffs = await requestEntityGraphDeletions('prototype', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    failed.push(...handoffs.failed.map(({ id }) => id));
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, async (id) => {
      const plan = plansById.get(id);
      if (!plan) throw new Error(`Missing prototype reference cleanup plan for ${id}`);
      const relationsDeletedForEntity = await preparePrototypeDeletion(id);
      await adminApplyEntityReferenceCleanup(plan);
      return relationsDeletedForEntity;
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
    const batch = db.batch();
    for (const { id } of preparation.prepared) {
      batch.delete(db.collection('prototypes').doc(id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;
    } catch (error) {
      log.error('Batch delete failed (admin)', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  return { deleted, failed, relationsDeleted };
}
