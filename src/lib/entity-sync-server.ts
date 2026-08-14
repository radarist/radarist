/**
 * @file lib/entity-sync-server.ts
 * @description Server-only delivery for required entity graph synchronization.
 */

import 'server-only';

import { inngest } from '@/lib/inngest/send-client';
import { createLogger } from '@/lib/logger';
import { recordEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';
import {
  createRequiredEntitySyncEvent,
  EntitySyncDispatchError,
  triggerEntitySync,
  type EntitySyncOperation,
  type LibraryEntitySyncType,
} from '@/lib/entity-sync';

const log = createLogger('entity-sync-server');

/** Keep local Inngest and dev-server pressure bounded during 500-item deletes. */
export const ENTITY_SYNC_MAX_CONCURRENCY = 8;

export type BestEffortEntityGraphSyncOutcome =
  | { acknowledged: true; anchorRecorded: false }
  | { acknowledged: false; anchorRecorded: boolean };

async function recordBestEffortAnchor(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: Exclude<EntitySyncOperation, 'delete'>,
  error: unknown
): Promise<boolean> {
  try {
    const record = await recordEntityGraphSyncAnchor({ entityType, entityId, operation, error });
    return record !== null;
  } catch (anchorError) {
    // The outbox writer is already fail-soft. Keep this final guard at the
    // mutation boundary so an unexpected runtime failure cannot turn an
    // already committed entity write into a rejected operation.
    log.error(
      'Could not persist best-effort graph sync recovery anchor',
      anchorError instanceof Error ? anchorError : undefined,
      { entityType, entityId, operation }
    );
    return false;
  }
}

/**
 * Preserve the legacy best-effort server mutation contract while retaining a
 * durable record of every unacknowledged create/update.
 *
 * `triggerEntitySync` normally resolves to a delivery flag, but this boundary
 * also catches unexpected rejections so a post-commit bookkeeping failure can
 * never make a successfully saved entity look rejected. Awaiting this helper
 * lets admin callers know the anchor write has finished before they return.
 */
export async function triggerEntityGraphSyncBestEffortServer(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: Exclude<EntitySyncOperation, 'delete'>
): Promise<BestEffortEntityGraphSyncOutcome> {
  try {
    const delivered = await triggerEntitySync(entityType, entityId, operation);
    if (delivered === true) return { acknowledged: true, anchorRecorded: false };

    const anchorRecorded = await recordBestEffortAnchor(
      entityType,
      entityId,
      operation,
      new Error('Graph synchronization handoff was not acknowledged')
    );
    return { acknowledged: false, anchorRecorded };
  } catch (error) {
    log.warn('Best-effort graph sync handoff rejected unexpectedly', {
      entityType,
      entityId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    const anchorRecorded = await recordBestEffortAnchor(entityType, entityId, operation, error);
    return { acknowledged: false, anchorRecorded };
  }
}

/** Require Inngest to acknowledge a fresh idempotent attempt from server code. */
export async function requestEntityGraphSyncServer(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: EntitySyncOperation
): Promise<void> {
  const event = createRequiredEntitySyncEvent(entityType, entityId, operation);

  try {
    if (process.env.GRAPH_SYNC_ENABLED === 'false' || process.env.IMPULSE_GRAPH_SYNC_ENABLED === 'false') {
      throw new Error('graph synchronization is disabled');
    }

    const accepted = await inngest.send(event);
    if (!accepted.ids?.length) {
      throw new Error('Inngest accepted no event (delivery may be disabled or unconfigured)');
    }
    log.debug('Required graph sync acknowledged', {
      entityType,
      entityId,
      operation,
    });
  } catch (error) {
    log.warn('Required graph sync handoff failed', {
      entityType,
      entityId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    // Deletes stay fail-closed on their own Firestore document, which the
    // caller has not yet removed; anchoring them would duplicate that anchor.
    if (operation !== 'delete') {
      await recordEntityGraphSyncAnchor({ entityType, entityId, operation, error });
    }
    throw new EntitySyncDispatchError(entityType, entityId, operation, error);
  }
}

export function requestEntityGraphDeletionServer(entityType: LibraryEntitySyncType, entityId: string): Promise<void> {
  return requestEntityGraphSyncServer(entityType, entityId, 'delete');
}

export async function requestEntityGraphDeletionsServer(
  entityType: LibraryEntitySyncType,
  entityIds: readonly string[]
): Promise<{ acknowledged: string[]; failed: Array<{ id: string; error: unknown }> }> {
  const outcomes: PromiseSettledResult<void>[] = new Array(entityIds.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < entityIds.length) {
      const index = nextIndex++;
      try {
        await requestEntityGraphDeletionServer(entityType, entityIds[index]);
        outcomes[index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENTITY_SYNC_MAX_CONCURRENCY, entityIds.length) }, () => worker()));
  const acknowledged: string[] = [];
  const failed: Array<{ id: string; error: unknown }> = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') acknowledged.push(entityIds[index]);
    else failed.push({ id: entityIds[index], error: outcome.reason });
  });
  return { acknowledged, failed };
}
