/**
 * @file strategies-admin.ts
 * @description Narrow admin-SDK helpers for the small set of strategy
 * operations the AI assistant invokes from the server side.
 *
 * Why this exists: `src/lib/strategies.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and
 * client-side hooks call into it from the browser, where a persistent
 * connection is fine. The `/api/ai/chat` route, the search API, and the
 * auto-linker, however, execute on the server inside stateless serverless
 * functions — the client SDK can't hold a connection there and reads time
 * out or return `code: 'unavailable'`, while creates can throw the `a540`
 * assertion.
 *
 * This file exposes ONLY the operations the server side needs:
 *
 *   - adminCreateStrategy(strategy)  — for the `createStrategy` tool
 *   - adminGetStrategies()           — for search / auto-linker / enrichment
 *   - adminGetStrategyById(id)       — for the AI `getEntityDetails` / page-research lookups
 *   - adminDeleteStrategy(id)        — single-delete twin (cascade relation cleanup + graph sync)
 *   - adminDeleteStrategies(ids)     — bulk-delete twin for `POST /api/strategies/bulk-delete`
 *
 * adminCreateStrategy delegates to adminCreateEntity('strategy', …) so it
 * shares the EXACT slug/id/audit/uniqueness logic with the client path and
 * fires the same post-commit graph-sync event. The delete twins reproduce
 * `strategies.deleteStrategy` / `strategies.deleteStrategies` exactly via the
 * Admin SDK: the SAME cascade relation cleanup, the SAME bounded (≤450) deletes,
 * and the SAME required graph-delete handoff the client service uses. Anything
 * richer (directive / document management,
 * AI summaries, migrations) stays on the client-SDK service module — the server
 * callers don't need it.
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
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  requestEntityGraphDeletionsServer as requestEntityGraphDeletions,
} from '@/lib/entity-sync-server';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
import type { Strategy } from '@/lib/types';

const log = createLogger('strategies-admin');

/**
 * Admin-SDK equivalent of `strategies.getStrategies`. Reads all docs from the
 * `strategies` collection. Mirrors the client function's return shape
 * (`Strategy[]`) and error semantics (throws `Failed to fetch strategies`).
 */
export async function adminGetStrategies(): Promise<Strategy[]> {
  try {
    const snap = await db.collection('strategies').get();
    return snap.docs.map((doc) => doc.data() as Strategy);
  } catch (error) {
    log.error('Error fetching strategies (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch strategies');
  }
}

/**
 * Admin-SDK equivalent of `strategies.getStrategyById`. Reads a single doc from
 * the `strategies` collection. Mirrors the client function's return shape
 * (`Strategy | null` — `null` when the doc does not exist) and error semantics
 * (throws `Failed to fetch strategy ${id}`).
 */
export async function adminGetStrategyById(id: string): Promise<Strategy | null> {
  try {
    const snap = await db.collection('strategies').doc(id).get();
    if (snap.exists) {
      return snap.data() as Strategy;
    }
    return null;
  } catch (error) {
    log.error('Error fetching strategy (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch strategy ${id}`);
  }
}

/**
 * Admin-SDK equivalent of `strategies.createStrategy`. Same validation +
 * default-field semantics, delegates to adminCreateEntity('strategy', …) so it
 * shares the exact slug/id/audit/uniqueness logic with the client path and is
 * safe to call from server routes / AI-tool executors against production.
 * Re-throws DuplicateEntityError unchanged. Graph (Neo4j) sync fires via
 * adminCreateEntity's post-commit `app/unified-entity.sync.requested` event
 * (the client path additionally fires legacy `triggerEntitySync`; the unified
 * sync event is the canonical one).
 */
export async function adminCreateStrategy(
  strategy: Omit<Strategy, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<Strategy> {
  try {
    // Validate required fields (mirror client createStrategy).
    if (!strategy.name || !strategy.description) {
      throw new Error('Strategy name and description are required');
    }

    // Ensure new fields have default values if not provided (mirror client).
    const dataToCreate = {
      ...strategy,
      mainDirectives: strategy.mainDirectives || [],
      documents: strategy.documents || [],
      links: strategy.links || [],
      ...(strategy.aiGeneratedSummary !== undefined && { aiGeneratedSummary: strategy.aiGeneratedSummary }),
    };

    const result = await adminCreateEntity<typeof dataToCreate>('strategy', dataToCreate);
    const newStrategy = result.entity as Strategy;

    log.info('Successfully created strategy (admin)', { id: newStrategy.id });
    return newStrategy;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers.
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate strategy', { message: error.message });
      throw error;
    }
    log.error('Error creating strategy (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create strategy: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// DELETE (admin twins of strategies.deleteStrategy / deleteStrategies)
// ============================================================================

/**
 * Result of a bulk delete operation. Mirrors `BulkDeleteResult` from
 * `strategies.ts` so `adminDeleteStrategies` returns the same shape.
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
 * Admin-SDK equivalent of `strategies.deleteStrategy`. Reproduces the client
 * orchestration faithfully:
 *   1. require an acknowledged graph-delete handoff,
 *   2. cascade-delete relations for the entity (admin replica of
 *      `deleteRelationsForEntity`),
 *   3. delete the strategy document.
 *
 * Same thrown-Error semantics (`Failed to delete strategy ${id}`) as the client.
 */
async function prepareStrategyDeletion(id: string): Promise<number> {
    const linksDeleted = await adminDeleteLinksForEntity('strategy', id);
    if (linksDeleted > 0) {
      log.info('Cleaned up document links for strategy (admin)', { linksDeleted, id });
    }

    const relationsDeleted = await adminDeleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for strategy (admin)', { relationsDeleted, id });
    }

    const notesDeleted = await adminDeleteAllEntityNotes('strategies', id);
    if (notesDeleted > 0) {
      log.info('Cleaned up notes subcollection for strategy (admin)', { notesDeleted, id });
    }

    return relationsDeleted;
}

export async function adminDeleteStrategy(id: string): Promise<void> {
  try {
    const referencePlan = await adminPlanEntityReferenceCleanup('strategy', id);

    await requestEntityGraphDeletion('strategy', id);
    await prepareStrategyDeletion(id);
    await adminApplyEntityReferenceCleanup(referencePlan);

    // Delete the strategy document only after the graph handoff is durable.
    await db.collection('strategies').doc(id).delete();

    log.info('Deleted strategy (admin)', { id });
  } catch (error) {
    log.error('Error deleting strategy (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    if (error instanceof EntitySyncDispatchError || error instanceof EntityDeletionBlockedError) throw error;
    throw new Error(`Failed to delete strategy ${id}`, { cause: error });
  }
}

/**
 * Admin-SDK equivalent of `strategies.deleteStrategies`. Powers
 * `POST /api/strategies/bulk-delete`. Reproduces the client orchestration
 * faithfully:
 *   1. preflight reverse references in batches of at most 450,
 *   2. require per-entity graph-delete handoffs only for successful plans,
 *   3. prepare document-link, relation, note, and reverse-reference cleanup
 *      with bounded concurrency and exact per-ID failures,
 *   4. batch-delete only fully prepared strategy docs.
 *
 * The browser-only `emitDataRefresh('strategies', 'bulk-delete')` step the
 * client path runs is a no-op server-side (it is a `window` `dispatchEvent`
 * guarded by `typeof window`) and is intentionally skipped. Returns the same
 * `BulkDeleteResult` shape (`{ deleted, failed, relationsDeleted }`).
 */
export async function adminDeleteStrategies(ids: string[]): Promise<BulkDeleteResult> {
  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Leave headroom below Firestore's hard 500-write batch limit.
  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const preflight = await adminPlanEntityReferenceCleanups('strategy', batchIds);
    for (const { id, error } of preflight.failed) {
      failed.push(id);
      log.warn('Strategy reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (preflight.planned.length === 0) continue;

    const plansById = new Map(preflight.planned.map((plan) => [plan.entityId, plan]));
    const preflightedIds = preflight.planned.map((plan) => plan.entityId);

    const handoffs = await requestEntityGraphDeletions('strategy', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    failed.push(...handoffs.failed.map(({ id }) => id));
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, async (id) => {
      const plan = plansById.get(id);
      if (!plan) throw new Error(`Missing strategy reference cleanup plan for ${id}`);
      const relationsDeletedForEntity = await prepareStrategyDeletion(id);
      await adminApplyEntityReferenceCleanup(plan);
      return relationsDeletedForEntity;
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Strategy cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    // Delete only entities whose graph handoff and every prerequisite succeeded.
    const batch = db.batch();
    for (const { id } of preparation.prepared) {
      batch.delete(db.collection('strategies').doc(id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;
    } catch (error) {
      log.error('Batch delete failed (admin)', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  // NOTE: client path emits emitDataRefresh('strategies', 'bulk-delete') here — a
  // browser-only UI cache hint that is a no-op server-side, so it is skipped.

  log.info('Deleted strategies (admin)', { deleted, failed: failed.length, relationsDeleted });
  return { deleted, failed, relationsDeleted };
}
