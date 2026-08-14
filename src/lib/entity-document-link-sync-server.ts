/**
 * @file lib/entity-document-link-sync-server.ts
 * @description Server-only delivery for required entity-document link graph
 * synchronization — deletes (pre-commit) and, since GRAPH-069, creates and
 * updates (post-commit) through one shared primitive.
 */

import 'server-only';

import { createHash } from 'node:crypto';
import { inngest } from '@/lib/inngest/send-client';
import { createLogger } from '@/lib/logger';
import { mapSettledWithBoundedConcurrency } from '@/lib/bounded-concurrency';
import { recordEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';
import type { EntityGraphSyncAnchorType } from '@/lib/entity-graph-sync-outbox';
import {
  buildEntityDocumentLinkDeleteEvent,
  type EntityDocumentLinkDeleteTarget,
} from '@/lib/entity-document-link-cascade';
import {
  ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
  EntityDocumentLinkSyncDispatchError,
  assertEntityDocumentLinkHandoffTarget,
  type EntityDocumentLinkGraphHandoffOutcome,
  type EntityDocumentLinkHandoffOperation,
  type EntityDocumentLinkHandoffTarget,
} from '@/lib/entity-document-link-handoff';
import type { EntityDocumentLink } from '@/lib/types';

/**
 * Re-exported so existing delete callers keep importing it from the dispatcher
 * they already depend on. The class itself lives in the client-safe contract
 * module so the API route and this module resolve one identical constructor.
 */
export { EntityDocumentLinkSyncDispatchError };

const log = createLogger('entity-document-link-sync-server');

export const ENTITY_DOCUMENT_LINK_SYNC_MAX_CONCURRENCY = 8;

/**
 * Compile-time proof that the client-safe contract's anchor-type literal is a
 * member of the outbox union. If the union is renamed, this stops building
 * rather than filing anchors under a type nothing reads.
 */
const ENTITY_DOCUMENT_LINK_ANCHOR: EntityGraphSyncAnchorType = ENTITY_DOCUMENT_LINK_ANCHOR_TYPE;

function graphSyncDisabled(): boolean {
  return process.env.GRAPH_SYNC_ENABLED === 'false' || process.env.IMPULSE_GRAPH_SYNC_ENABLED === 'false';
}

// ============================================================================
// CREATE / UPDATE — the one post-commit handoff (GRAPH-069)
// ============================================================================

export const ENTITY_DOCUMENT_LINK_REPLAY_ID_PREFIX = 'edlh1_';

/** The link fields that determine what the worker projects into Neo4j. */
export type EntityDocumentLinkProjectionSource = Pick<
  EntityDocumentLink,
  'id' | 'entityType' | 'entityId' | 'documentId' | 'relationshipType' | 'relevance' | 'tags' | 'note' | 'updatedAt'
>;

/**
 * Fingerprint of exactly what the worker would project for this link: the
 * endpoint triple, the entity type and relationship type that pick the node
 * label and edge type, the three mirrored scalars, and the source revision.
 *
 * Two uses, and they are the same question asked at different times:
 *
 * - The dispatcher folds it into the replay identity, so two mutations that
 *   would project different content can never collide.
 * - The worker compares the fingerprint of the content it projected against a
 *   fresh read after the write. Equal means the edge provably describes the
 *   current source and the recovery anchor may be retired; unequal means the
 *   source moved mid-write and the anchor must survive for the next round.
 *
 * Tags are sorted because the projection compares them as a set.
 */
export function buildEntityDocumentLinkProjectionFingerprint(link: EntityDocumentLinkProjectionSource): string {
  const tuple = JSON.stringify([
    link.id,
    link.entityType,
    link.entityId,
    link.documentId,
    link.relationshipType,
    link.relevance ?? null,
    [...(link.tags ?? [])].sort(),
    link.note ?? null,
    typeof link.updatedAt === 'number' && Number.isFinite(link.updatedAt) ? link.updatedAt : null,
  ]);
  return createHash('sha256').update(tuple, 'utf8').digest('hex');
}

/**
 * Stable replay identity for one link mutation: the projection fingerprint
 * plus the operation. Supplying it to Inngest as the event id is safe because
 * of how the fingerprint is built:
 *
 * - An exact retry of an unchanged mutation produces the same id, so the queue
 *   deduplicates it instead of running the worker twice.
 * - Any mutation that would project DIFFERENT graph content produces a
 *   different id, so deduplication can never swallow a distinct projection.
 * - Two writes that collide on both content and millisecond would project
 *   identically, so collapsing them is a no-op by construction.
 */
export function buildEntityDocumentLinkReplayId(
  link: EntityDocumentLinkProjectionSource,
  operation: EntityDocumentLinkHandoffOperation
): string {
  const tuple = JSON.stringify([operation, buildEntityDocumentLinkProjectionFingerprint(link)]);
  return `${ENTITY_DOCUMENT_LINK_REPLAY_ID_PREFIX}${createHash('sha256').update(tuple, 'utf8').digest('hex')}`;
}

function toHandoffTarget(link: Pick<EntityDocumentLink, 'id' | 'entityId' | 'documentId'>) {
  return assertEntityDocumentLinkHandoffTarget({
    linkId: link.id,
    entityId: link.entityId,
    documentId: link.documentId,
  });
}

/**
 * Record the durable recovery anchor for a committed link whose handoff failed.
 *
 * Fails soft in both directions: the recorder is already fail-soft, and this
 * guard keeps an unexpected runtime failure from turning a committed link into
 * a reported dispatch bug of a different shape. Reconciliation converges the
 * projection whether or not the anchor survives.
 */
async function recordLinkHandoffAnchor(
  target: EntityDocumentLinkHandoffTarget,
  operation: EntityDocumentLinkHandoffOperation,
  observedUpdatedAt: number | null,
  error: unknown
): Promise<boolean> {
  try {
    const record = await recordEntityGraphSyncAnchor({
      entityType: ENTITY_DOCUMENT_LINK_ANCHOR,
      entityId: target.linkId,
      operation,
      observedUpdatedAt,
      error,
    });
    return record !== null;
  } catch (anchorError) {
    log.error(
      'Could not persist entity-document link graph sync anchor',
      anchorError instanceof Error ? anchorError : undefined,
      { linkId: target.linkId, operation }
    );
    return false;
  }
}

/**
 * Require Inngest to acknowledge one create/update handoff.
 *
 * Throws `EntityDocumentLinkSyncDispatchError` after the anchor is written, so
 * a caller that must surface delivery failure can, while the durable record
 * already exists no matter how the caller handles the throw.
 */
export async function requestEntityDocumentLinkGraphSyncServer(
  link: Parameters<typeof buildEntityDocumentLinkReplayId>[0] & Pick<EntityDocumentLink, 'entityId' | 'documentId'>,
  operation: EntityDocumentLinkHandoffOperation
): Promise<void> {
  const target = toHandoffTarget({ id: link.id, entityId: link.entityId, documentId: link.documentId });

  try {
    if (graphSyncDisabled()) throw new Error('graph synchronization is disabled');

    const accepted = await inngest.send({
      id: buildEntityDocumentLinkReplayId(link, operation),
      name: 'app/entity-document-link.sync.requested',
      data: {
        operation,
        linkId: target.linkId,
        // The worker re-reads Firestore for content; these endpoints exist so a
        // late or replayed event can prove it still describes the same link.
        entityId: target.entityId,
        documentId: target.documentId,
      },
    });
    if (!accepted.ids?.length) {
      throw new Error('Inngest accepted no event (delivery may be disabled or unconfigured)');
    }
    log.debug('Entity-document link graph handoff acknowledged', { linkId: target.linkId, operation });
  } catch (error) {
    const observedUpdatedAt =
      typeof link.updatedAt === 'number' && Number.isFinite(link.updatedAt) ? link.updatedAt : null;
    const anchorRecorded = await recordLinkHandoffAnchor(target, operation, observedUpdatedAt, error);
    log.warn('Entity-document link graph handoff was not acknowledged', {
      linkId: target.linkId,
      operation,
      anchorRecorded,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new EntityDocumentLinkSyncDispatchError(target.linkId, error, anchorRecorded, operation);
  }
}

/**
 * The shared server-side primitive both create and update call.
 *
 * Returns the same three-way outcome the browser contract returns, so an admin
 * repository, an Assistant tool, and a page all describe the same reality.
 * Never throws: the link is already committed, and a post-commit delivery
 * problem must not be reported as a failed mutation.
 */
export async function deliverEntityDocumentLinkGraphHandoffServer(
  link: Parameters<typeof requestEntityDocumentLinkGraphSyncServer>[0],
  operation: EntityDocumentLinkHandoffOperation
): Promise<EntityDocumentLinkGraphHandoffOutcome> {
  try {
    await requestEntityDocumentLinkGraphSyncServer(link, operation);
    return { status: 'acknowledged' };
  } catch (error) {
    if (error instanceof EntityDocumentLinkSyncDispatchError) {
      return {
        status: 'pending-reconciliation',
        reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
        anchorRecorded: error.anchorRecorded,
      };
    }
    // A target-validation failure is a caller bug, not an outage: nothing was
    // dispatched and nothing can be recovered until the caller is fixed.
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// DELETE — pre-commit handoff; the surviving Firestore row IS the anchor
// ============================================================================

export async function requestEntityDocumentLinkGraphDeletionServer(
  target: EntityDocumentLinkDeleteTarget
): Promise<void> {
  try {
    if (graphSyncDisabled()) {
      throw new Error('graph synchronization is disabled');
    }
    for (const [field, value] of Object.entries(target)) {
      if (!value || value !== value.trim()) throw new Error(`${field} must be a non-empty trimmed string`);
    }

    const accepted = await inngest.send(buildEntityDocumentLinkDeleteEvent(target));
    if (!accepted.ids?.length) {
      throw new Error('Inngest accepted no event (delivery may be disabled or unconfigured)');
    }
  } catch (error) {
    throw new EntityDocumentLinkSyncDispatchError(target.linkId, error);
  }
}

export async function requestEntityDocumentLinkGraphDeletionsServer(
  targets: readonly EntityDocumentLinkDeleteTarget[]
): Promise<{
  acknowledged: string[];
  failed: Array<{ linkId: string; error: unknown }>;
}> {
  const outcomes = await mapSettledWithBoundedConcurrency(
    targets,
    ENTITY_DOCUMENT_LINK_SYNC_MAX_CONCURRENCY,
    requestEntityDocumentLinkGraphDeletionServer
  );
  const acknowledged: string[] = [];
  const failed: Array<{ linkId: string; error: unknown }> = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') acknowledged.push(targets[index].linkId);
    else failed.push({ linkId: targets[index].linkId, error: outcome.reason });
  });
  return { acknowledged, failed };
}
