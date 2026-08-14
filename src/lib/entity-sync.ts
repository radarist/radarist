/**
 * @file lib/entity-sync.ts
 * @description Entity sync trigger for Neo4j graph synchronization.
 *
 * Provides two deliberately different delivery contracts:
 * - `triggerEntitySync` preserves the legacy best-effort notification used by
 *   non-critical projections.
 * - `requestEntityGraphSync` requires an acknowledged, retryable handoff
 *   for mutations whose caller must surface delivery failure.
 *
 * Uses the same pattern as radar-placement-service.ts (lines 318, 381, 450)
 * which has been working in production since v0.3.
 *
 * Event names match entity-factory.ts:340:
 * - 'app/technology.sync.requested' for technologies
 * - 'app/unified-entity.sync.requested' for all other entity types
 */

import type { EntityType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import {
  isLibraryEntitySyncType,
  parseEntityGraphSyncAnchorRecordedResponse,
  type LibraryEntitySyncType,
} from '@/lib/entity-sync-contract';

export { LIBRARY_ENTITY_SYNC_TYPES, isLibraryEntitySyncType } from '@/lib/entity-sync-contract';
export type { LibraryEntitySyncType } from '@/lib/entity-sync-contract';

const log = createLogger('entity-sync');

/** Keep one required browser-to-server graph handoff from hanging the mutation UI indefinitely. */
export const ENTITY_SYNC_HANDOFF_TIMEOUT_MS = 15_000;

export type EntitySyncOperation = 'create' | 'update' | 'delete';

export type RequiredEntitySyncEvent =
  | {
      name: 'app/technology.sync.requested';
      data: {
        technologyId: string;
        entityType: 'technology';
        operation: EntitySyncOperation;
      };
    }
  | {
      name: 'app/unified-entity.sync.requested';
      data: {
        entityId: string;
        entityType: Exclude<LibraryEntitySyncType, 'technology'>;
        operation: EntitySyncOperation;
      };
    };

export class EntitySyncDispatchError extends Error {
  constructor(
    public readonly entityType: LibraryEntitySyncType,
    public readonly entityId: string,
    public readonly operation: EntitySyncOperation,
    cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const retryState =
      operation === 'delete'
        ? 'The entity remains in Firestore and the same deletion can be retried safely.'
        : 'The Firestore mutation is committed; do not recreate the entity. Retry graph synchronization.';
    super(`Graph ${operation} handoff for ${entityType} ${entityId} was not acknowledged: ${detail}. ${retryState}`);
    this.name = 'EntitySyncDispatchError';
    this.cause = cause;
  }
}

/** Build one fresh, idempotent delivery attempt for a committed mutation. */
export function createRequiredEntitySyncEvent(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: EntitySyncOperation
): RequiredEntitySyncEvent {
  const normalizedId = entityId.trim();
  if (!normalizedId) throw new Error('Entity sync id must not be empty');
  if (entityId !== normalizedId) {
    throw new Error('Entity sync id must already be trimmed');
  }

  if (entityType === 'technology') {
    return {
      name: 'app/technology.sync.requested',
      data: { technologyId: normalizedId, entityType, operation },
    };
  }

  return {
    name: 'app/unified-entity.sync.requested',
    data: { entityId: normalizedId, entityType, operation },
  };
}

function createHandoffTimeout() {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ENTITY_SYNC_HANDOFF_TIMEOUT_MS);

  return {
    signal: controller.signal,
    cause(error: unknown): unknown {
      return timedOut
        ? new Error(`Graph synchronization handoff timed out after ${ENTITY_SYNC_HANDOFF_TIMEOUT_MS}ms`)
        : error;
    },
    clear(): void {
      clearTimeout(timer);
    },
  };
}

class EntityGraphSyncHandoffResponseError extends Error {
  constructor(
    message: string,
    public readonly serverAnchorRecorded: boolean
  ) {
    super(message);
    this.name = 'EntityGraphSyncHandoffResponseError';
  }
}

function isExactSameOriginEntitySyncResponse(response: Response): boolean {
  if (typeof window === 'undefined' || !response.url) return false;

  try {
    const responseUrl = new URL(response.url);
    return (
      responseUrl.origin === window.location.origin &&
      responseUrl.pathname === '/api/graph/entity-sync' &&
      responseUrl.search === '' &&
      responseUrl.hash === ''
    );
  } catch {
    return false;
  }
}

function serverAlreadyRecordedGraphSyncAnchor(error: unknown): boolean {
  return error instanceof EntityGraphSyncHandoffResponseError && error.serverAnchorRecorded;
}

async function sendEntityGraphSyncRequest(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: EntitySyncOperation,
  method: 'POST' | 'PUT',
  signal?: AbortSignal
): Promise<void> {
  const response = await fetchWithAuth('/api/graph/entity-sync', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityType, entityId, operation }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const serverAnchorRecorded =
      response.status === 503 &&
      operation !== 'delete' &&
      isExactSameOriginEntitySyncResponse(response) &&
      parseEntityGraphSyncAnchorRecordedResponse(body, { entityType, entityId, operation }) !== null;
    const errorBody = body as { error?: unknown } | null;
    const detail = typeof errorBody?.error === 'string' ? errorBody.error : `HTTP ${response.status}`;
    throw new EntityGraphSyncHandoffResponseError(detail, serverAnchorRecorded);
  }
}

/**
 * Persist the durable recovery anchor for a committed browser mutation whose
 * graph handoff failed (GRAPH-056).
 *
 * Browser-only by construction. The Admin twin is `server-only` and importing
 * it from this dual-runtime module would drag `firebase-admin` into the client
 * bundle; server callers record their own anchors through
 * `entity-sync-server.ts` and `entity-factory-admin.ts` instead.
 *
 * Deletes are skipped: `requestEntityGraphDeletion` is awaited *before* the
 * Firestore document is removed, so a failed delete handoff already leaves the
 * document itself as the retry anchor.
 */
async function recordBrowserGraphSyncAnchor(
  entityType: EntityType,
  entityId: string,
  operation: EntitySyncOperation,
  error: unknown
): Promise<void> {
  if (typeof window === 'undefined') return;
  if (operation === 'delete') return;
  if (!isLibraryEntitySyncType(entityType)) return;

  try {
    const { recordEntityGraphSyncAnchor } = await import('@/lib/entity-graph-sync-outbox-client');
    await recordEntityGraphSyncAnchor({ entityType, entityId, operation, error });
  } catch (anchorError) {
    // The twin already fails soft; this guards the dynamic import itself. The
    // mutation is committed, so an anchor failure must never surface as one.
    log.warn('Could not record graph sync recovery anchor', {
      entityType,
      entityId,
      error: anchorError instanceof Error ? anchorError.message : String(anchorError),
    });
  }
}

/**
 * Require Inngest to acknowledge a fresh entity sync attempt.
 *
 * Delete callers must await this before removing their primary Firestore
 * document. A lost acknowledgement leaves that document as a retry anchor.
 * Every retry gets a fresh attempt because Inngest's supplied-ID deduplication
 * can suppress distinct commits made in the same millisecond. Workers re-read
 * authoritative Firestore and graph writes are independently idempotent. The
 * graph kill switch is an explicit failure for this contract.
 */
export async function requestEntityGraphSync(
  entityType: LibraryEntitySyncType,
  entityId: string,
  operation: EntitySyncOperation
): Promise<void> {
  createRequiredEntitySyncEvent(entityType, entityId, operation);
  const timeout = createHandoffTimeout();

  try {
    await sendEntityGraphSyncRequest(entityType, entityId, operation, 'POST', timeout.signal);
    log.debug('Required graph sync acknowledged', {
      entityType,
      entityId,
      operation,
    });
  } catch (error) {
    const cause = timeout.cause(error);
    log.warn('Required graph sync handoff failed', {
      entityType,
      entityId,
      operation,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    // Anchor before throwing unless the exact same-origin 503 attests that the
    // server already persisted it. Ambiguous responses remain browser-owned.
    if (!serverAlreadyRecordedGraphSyncAnchor(cause)) {
      await recordBrowserGraphSyncAnchor(entityType, entityId, operation, cause);
    }
    throw new EntitySyncDispatchError(entityType, entityId, operation, cause);
  } finally {
    timeout.clear();
  }
}

export function requestEntityGraphDeletion(entityType: LibraryEntitySyncType, entityId: string): Promise<void> {
  return requestEntityGraphSync(entityType, entityId, 'delete');
}

export async function requestEntityGraphDeletions(
  entityType: LibraryEntitySyncType,
  entityIds: readonly string[]
): Promise<{ acknowledged: string[]; failed: Array<{ id: string; error: unknown }> }> {
  if (entityIds.length === 0) return { acknowledged: [], failed: [] };
  const timeout = createHandoffTimeout();

  try {
    const response = await fetchWithAuth('/api/graph/entity-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType, entityIds, operation: 'delete' }),
      signal: timeout.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const body = (await response.json()) as { acknowledged?: unknown; failed?: unknown };
    if (!Array.isArray(body.acknowledged) || !Array.isArray(body.failed)) {
      throw new Error('Invalid graph handoff acknowledgement');
    }
    const requested = new Set(entityIds);
    const acknowledgedSet = new Set(
      body.acknowledged.filter((id): id is string => typeof id === 'string' && requested.has(id))
    );
    const failedSet = new Set(body.failed.filter((id): id is string => typeof id === 'string' && requested.has(id)));
    const responseIsComplete =
      acknowledgedSet.size + failedSet.size === requested.size &&
      [...acknowledgedSet].every((id) => !failedSet.has(id));
    if (!responseIsComplete) {
      throw new Error('Incomplete graph handoff acknowledgement');
    }

    return {
      acknowledged: entityIds.filter((id) => acknowledgedSet.has(id)),
      failed: entityIds
        .filter((id) => failedSet.has(id))
        .map((id) => ({
          id,
          error: new EntitySyncDispatchError(entityType, id, 'delete', 'server handoff failed'),
        })),
    };
  } catch (error) {
    const cause = timeout.cause(error);
    return {
      acknowledged: [],
      failed: entityIds.map((id) => ({
        id,
        error:
          cause instanceof EntitySyncDispatchError
            ? cause
            : new EntitySyncDispatchError(entityType, id, 'delete', cause),
      })),
    };
  } finally {
    timeout.clear();
  }
}

/**
 * Trigger Neo4j graph sync for an entity mutation.
 *
 * Uses the client-safe Inngest send client in both runtimes. Delivery remains
 * best-effort: failures are swallowed, with server-side failures logged.
 *
 * Gated by GRAPH_SYNC_ENABLED env var (default: true).
 *
 * M1 / decision D2: the event carries IDENTIFIERS ONLY
 * ({technologyId|entityId, entityType, operation}) — the sync handlers always
 * load the full document from Firestore admin. The old `payload` field was a
 * dead side-channel (handlers read `technologyData`/`data`, which no producer
 * sent), and feeding partial patch payloads into the upsert would demote
 * approved technologies (patches lack `approvalStatus`/`conceptIds`). The
 * `_payload` parameter is still accepted (and ignored) so the ~30 existing
 * call sites don't churn; it goes away with P3's typed EventSchemas.
 */
export async function triggerEntitySync(
  entityType: EntityType,
  entityId: string,
  operation: EntitySyncOperation,
  _payload?: unknown
): Promise<boolean> {
  // Kill switch — disable sync if it floods the queue. Reported as delivered:
  // suppression is a deliberate operator policy, not an outstanding debt, and
  // anchoring every write while sync is switched off would fill the recovery
  // collection with records no retry can settle.
  if (process.env.GRAPH_SYNC_ENABLED === 'false' || process.env.IMPULSE_GRAPH_SYNC_ENABLED === 'false') {
    return true;
  }

  // Entity types with dedicated sync functions — skip unified event to avoid noise
  const DEDICATED_SYNC_TYPES: EntityType[] = ['radarPlacement'];
  if (DEDICATED_SYNC_TYPES.includes(entityType)) {
    return true; // Already handled by sync-placement-to-neo4j
  }

  try {
    // Browser bundles cannot see the server-only `INNGEST_DEV` routing value.
    // Calling the Inngest SDK from a page therefore defaults to inn.gs even
    // while the app is connected to an owned local dev server. Route supported
    // library mutations through the authenticated same-origin boundary, where
    // the server SDK has the authoritative environment and recovery anchor.
    if (typeof window !== 'undefined' && isLibraryEntitySyncType(entityType)) {
      const timeout = createHandoffTimeout();
      try {
        // PUT is the authenticated best-effort contract. Required callers use
        // POST, so the request body cannot downgrade their failure semantics.
        await sendEntityGraphSyncRequest(entityType, entityId, operation, 'PUT', timeout.signal);
        log.debug('Graph sync triggered through server boundary', { entityType, entityId, operation });
        return true;
      } catch (error) {
        throw timeout.cause(error);
      } finally {
        timeout.clear();
      }
    }

    const { inngest } = await import('@/lib/inngest/send-client');
    let accepted: { ids?: string[] } | undefined;

    // Explicit branches so each payload is compile-time checked against the
    // typed event contract: technology sync expects `technologyId`, unified
    // sync expects `entityId` (M1 / decision D2 — identifiers only).
    if (entityType === 'technology') {
      accepted = await inngest.send({
        name: 'app/technology.sync.requested',
        data: {
          technologyId: entityId,
          entityType,
          operation,
        },
      });
    } else {
      accepted = await inngest.send({
        name: 'app/unified-entity.sync.requested',
        data: {
          entityId,
          entityType,
          operation,
        },
      });
    }

    if (!accepted?.ids?.length) {
      throw new Error('Inngest accepted no event (delivery may be disabled or unconfigured)');
    }

    log.debug('Graph sync triggered', { entityType, entityId, operation });
    return true;
  } catch (err) {
    // Still best-effort for the CALLER — this never throws, so no mutation is
    // reported as failed. But it is no longer amnesiac: the browser records a
    // durable anchor, and the returned flag lets server callers record theirs
    // through the Admin twin (GRAPH-056).
    log.warn('Graph sync trigger failed — entity may be missing from Neo4j', {
      entityType,
      entityId,
      operation,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!serverAlreadyRecordedGraphSyncAnchor(err)) {
      await recordBrowserGraphSyncAnchor(entityType, entityId, operation, err);
    }
    return false;
  }
}
