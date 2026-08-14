/**
 * @file use-cases-admin.ts
 * @description Narrow admin-SDK twin of the small set of `use-cases.ts`
 * operations that the AI assistant invokes from the server side.
 *
 * Why this exists: `src/lib/use-cases.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and
 * client-side hooks call into it from the browser, where a persistent
 * connection is fine. The `/api/ai/chat` route and other server tool
 * executors, however, run inside stateless serverless functions — the
 * client SDK can't hold a connection there and reads can time out or return
 * `code: 'unavailable'`, while writes can throw the `a540` assertion.
 *
 * This file exposes ONLY the operations server callers actually need:
 *
 *   - adminCreateUseCase(useCase)  — for the `createUseCase` tool
 *   - adminGetUseCases()           — for use-case lookup / linking tools
 *   - adminGetUseCaseById(id)      — for the `getEntityById` legacy executor
 *   - adminUpdateUseCase(id, …)    — for the `updateEntity` executor + enrichment
 *   - adminDeleteUseCase(id)       — single cascade delete (mirrors deleteUseCase)
 *   - adminDeleteUseCases(ids)     — bulk cascade delete (mirrors deleteUseCases),
 *                                    used by /api/use-cases/bulk-delete
 *
 * Anything richer (link/unlink, agent-source mapping) stays on the
 * client-SDK service module — the server callers don't need it and we
 * don't want to duplicate that logic.
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
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  requestEntityGraphDeletionsServer as requestEntityGraphDeletions,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';
import type { UseCase } from '@/lib/types';

const log = createLogger('use-cases-admin');

/**
 * Deep undefined-stripping helper. Admin-safe local equivalent of
 * `removeUndefinedFields` from `@/lib/firebase` (which we cannot import here
 * because that module pulls in `firebase/firestore` at module load). Behaviour
 * is identical: recurses into plain objects, leaves arrays and Dates intact.
 * Matches the `companies-admin.ts` precedent.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T, deep = true): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (deep && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          return [key, stripUndefined(value as Record<string, unknown>, deep)];
        }
        return [key, value];
      })
  ) as Partial<T>;
}

/**
 * Admin-SDK equivalent of `use-cases.getUseCases`. Reads every doc in the
 * `use-cases` collection. Same return shape (`UseCase[]`).
 */
export async function adminGetUseCases(): Promise<UseCase[]> {
  const snap = await db.collection('use-cases').get();
  return snap.docs.map((doc) => doc.data() as UseCase);
}

/**
 * Admin-SDK equivalent of `use-cases.createUseCase`. Same contract: it
 * delegates to `adminCreateEntity('useCase', …)` (the admin twin of
 * entity-factory.createEntity) so slug generation, id format, audit
 * fields and scoped-uniqueness are identical to the client path. The
 * Neo4j graph sync fires inside `adminCreateEntity` via its post-commit
 * `app/unified-entity.sync.requested` Inngest event — the same event the
 * client path's `triggerEntitySync('useCase', …)` emits.
 *
 * Re-throws `DuplicateEntityError` unchanged for caller `instanceof`
 * branching; wraps any other failure in a generic Error, matching the
 * client `createUseCase` error semantics.
 */
export async function adminCreateUseCase(
  useCase: Omit<UseCase, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<UseCase> {
  try {
    const result = await adminCreateEntity<typeof useCase>('useCase', useCase);
    return result.entity as unknown as UseCase;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate use case', { message: error.message });
      throw error;
    }
    log.error('Error creating use case', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create use case: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `use-cases.getUseCaseById`. Reads a single doc from
 * the `use-cases` collection by id. Same contract: resolves to the `UseCase`
 * when the doc exists, or `null` when it does not.
 */
export async function adminGetUseCaseById(id: string): Promise<UseCase | null> {
  const snap = await db.collection('use-cases').doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as UseCase;
}

/**
 * Admin-SDK equivalent of `use-cases.updateUseCase`. Same contract: deep-strips
 * `undefined` values (Firestore rejects them), bumps `updatedAt`, writes the
 * doc, then fires best-effort Neo4j sync with a durable server recovery anchor.
 * Returns `void`.
 */
export async function adminUpdateUseCase(
  id: string,
  updates: Partial<Omit<UseCase, 'id' | 'createdAt'>>
): Promise<void> {
  // Remove undefined values before updating Firestore (Firestore doesn't accept undefined).
  const cleanedUpdates = stripUndefined({
    ...updates,
    updatedAt: Date.now(),
  });

  await db.collection('use-cases').doc(id).update(cleanedUpdates);

  await triggerEntityGraphSyncBestEffortServer('useCase', id, 'update');
}

/**
 * Result of a bulk delete operation. Mirrors `BulkDeleteResult` from
 * `use-cases.ts` so `adminDeleteUseCases` returns the same shape.
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
 * Admin-SDK equivalent of `use-cases.deleteUseCase`. It preflights reverse
 * references, requires the Neo4j handoff, preserves link/relation/note cleanup,
 * removes live arrays, then deletes the source document last. Returns `void`.
 */
async function prepareUseCaseDeletion(id: string): Promise<number> {
  const linksDeleted = await adminDeleteLinksForEntity('useCase', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for use case', { linksDeleted, id });
  }

  const relationsDeleted = await adminDeleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for use case', { relationsDeleted, id });
  }

  const notesDeleted = await adminDeleteAllEntityNotes('use-cases', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for use case', { notesDeleted, id });
  }

  return relationsDeleted;
}

export async function adminDeleteUseCase(id: string): Promise<void> {
  const referencePlan = await adminPlanEntityReferenceCleanup('useCase', id);

  await requestEntityGraphDeletion('useCase', id);
  await prepareUseCaseDeletion(id);
  await adminApplyEntityReferenceCleanup(referencePlan);

  // Delete the use case document only after the graph handoff is durable.
  await db.collection('use-cases').doc(id).delete();
  log.info('Deleted use case', { id });
}

/**
 * Admin-SDK equivalent of `use-cases.deleteUseCases`. Same contract: processes
 * deletions in batches of at most 450; for each batch it preflights reverse
 * references, requires graph handoffs only for successful plans, then prepares
 * document-link, relation, note, and reverse-reference cleanup with bounded
 * concurrency. Only fully prepared parents enter the Firestore batch; every
 * prerequisite failure is returned by exact ID.
 *
 * Documented divergence (NOT load-bearing): the client `deleteUseCases` ends
 * with `emitDataRefresh('useCases', 'bulk-delete')`. That is a browser-only
 * `window.dispatchEvent` (guarded by `typeof window`, a no-op server-side), so
 * it is omitted here — matching the `companies-admin.ts` precedent. The
 * load-bearing Neo4j delete sync IS preserved.
 */
export async function adminDeleteUseCases(ids: string[]): Promise<BulkDeleteResult> {
  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Leave headroom below Firestore's hard 500-write batch limit.
  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const preflight = await adminPlanEntityReferenceCleanups('useCase', batchIds);
    for (const { id, error } of preflight.failed) {
      failed.push(id);
      log.warn('Use case reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (preflight.planned.length === 0) continue;

    const plansById = new Map(preflight.planned.map((plan) => [plan.entityId, plan]));
    const preflightedIds = preflight.planned.map((plan) => plan.entityId);

    const handoffs = await requestEntityGraphDeletions('useCase', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    failed.push(...handoffs.failed.map(({ id }) => id));
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, async (id) => {
      const plan = plansById.get(id);
      if (!plan) throw new Error(`Missing use case reference cleanup plan for ${id}`);
      const relationsDeletedForEntity = await prepareUseCaseDeletion(id);
      await adminApplyEntityReferenceCleanup(plan);
      return relationsDeletedForEntity;
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Use case cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    // Delete only entities whose graph handoff and every prerequisite succeeded.
    const batch = db.batch();
    for (const { id } of preparation.prepared) {
      batch.delete(db.collection('use-cases').doc(id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;
    } catch (error) {
      log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  return { deleted, failed, relationsDeleted };
}
