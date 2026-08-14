/**
 * @file lib/entity-document-link-handoff.ts
 * @description GRAPH-069 — the vocabulary shared by every entity-document link
 * create/update graph handoff: browser transport, server dispatcher, API route,
 * and admin repositories.
 *
 * **What was wrong.** A link create or update committed to Firestore and then
 * called `inngest.send()` directly from whatever runtime it happened to be in,
 * inside a bare `catch {}`. From the browser that send cannot work at all — the
 * page bundle cannot see the server-only `INNGEST_DEV` routing value, so the
 * SDK addresses inn.gs even while the app is wired to a local dev server — and
 * the swallow meant the UI still said "Successfully linked". The admin twin was
 * quieter but no more honest: it logged `syncQueued: false` and returned the
 * link as if nothing were outstanding. Both reported a Firestore commit as if
 * it were graph convergence.
 *
 * **What replaces it.** Every create and update — browser, admin repository,
 * Assistant tool — reaches Neo4j through one authenticated, server-owned,
 * acknowledged handoff, and the caller is told which of three things actually
 * happened:
 *
 * - `acknowledged` — the server dispatched and Inngest accepted the event. The
 *   graph write has not happened yet, but delivery is guaranteed and the worker
 *   is idempotent, so no recovery work is outstanding.
 * - `pending-reconciliation` — the mutation IS committed and the handoff is
 *   NOT. A durable anchor was recorded (by whichever side is upstream of the
 *   outage) and the projection reconciler will converge it. Never reported as
 *   success.
 * - `refused` — the server rejected the request itself: a conflicting replay, a
 *   cross-owner attempt, a malformed body. Deliberately NOT anchored; recovery
 *   would re-attempt work that can never succeed in its current shape.
 *
 * Deletes are not routed here. They already own the correct contract in
 * `entity-document-link-cascade.ts`: the handoff is awaited BEFORE the Firestore
 * row is removed, so a failed delete handoff leaves the row itself as the retry
 * anchor. Creates and updates have the inverse ordering — the row must exist for
 * the worker to read it — which is exactly why they need an explicit anchor.
 *
 * Keep this module free of transport, Firebase, and outbox imports. Browser
 * delivery (`entity-document-link-handoff-client.ts`) and server delivery
 * (`entity-document-link-sync-server.ts`) both depend on it, so it is the
 * stable lower boundary that stops those two from importing each other.
 */

export const ENTITY_DOCUMENT_LINK_HANDOFF_ROUTE = '/api/graph/entity-document-link-sync';

export const ENTITY_DOCUMENT_LINK_HANDOFF_ERROR =
  'Entity-document link graph synchronization handoff was not acknowledged' as const;

export const ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT =
  'entity-document-link-graph-sync-anchor-recorded/v1' as const;

/**
 * The `EntityGraphSyncAnchorType` an entity-document link anchor is filed
 * under. Declared here rather than imported so this module stays free of the
 * outbox's dependency graph; a compile-time check in the server dispatcher
 * keeps the literal and the union in step.
 */
export const ENTITY_DOCUMENT_LINK_ANCHOR_TYPE = 'entityDocumentLink' as const;

export type EntityDocumentLinkHandoffOperation = 'create' | 'update';

/**
 * The endpoint triple a caller asserts about the link it just committed.
 *
 * The server re-reads the authoritative row and compares: a mismatch means the
 * caller is replaying against state that has moved on, and the handoff fails
 * closed rather than projecting a link the caller never saw.
 */
export interface EntityDocumentLinkHandoffTarget {
  linkId: string;
  entityId: string;
  documentId: string;
}

export type EntityDocumentLinkGraphHandoffOutcome =
  | { status: 'acknowledged' }
  | { status: 'pending-reconciliation'; reason: string; anchorRecorded: boolean }
  | { status: 'refused'; reason: string };

/**
 * What a committed link mutation returns: the row, and the honest state of its
 * graph projection. Callers that need to say "saved" versus "saved, syncing
 * later" read `graphHandoff`; there is no shape in which a committed mutation
 * silently claims convergence.
 */
export interface EntityDocumentLinkCommitResult<TLink> {
  link: TLink;
  graphHandoff: EntityDocumentLinkGraphHandoffOutcome;
}

/**
 * Raised by the server dispatcher when a handoff was not acknowledged.
 *
 * It lives in this client-safe module, not in the `server-only` dispatcher,
 * for one reason: the API route must be able to ask "did the dispatcher
 * already persist the anchor?" and `instanceof` only answers that when both
 * sides resolve the SAME class object. Route tests that stub the dispatcher —
 * and any future bundling that duplicates a server module — would otherwise
 * silently take the fallback branch and stop attesting a real anchor.
 */
export class EntityDocumentLinkSyncDispatchError extends Error {
  constructor(
    public readonly linkId: string,
    cause: unknown,
    /**
     * Create/update only. Deletes are fail-closed on the Firestore row the
     * caller has not yet removed, so they never record an anchor.
     */
    public readonly anchorRecorded: boolean = false,
    public readonly operation: 'delete' | EntityDocumentLinkHandoffOperation = 'delete'
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const retryState =
      operation === 'delete'
        ? 'The link remains in Firestore and the same deletion can be retried safely.'
        : 'The Firestore link is committed; do not recreate it. Retry graph synchronization.';
    super(
      `Graph ${operation} handoff for entity-document link ${linkId} was not acknowledged: ${detail}. ${retryState}`
    );
    this.name = 'EntityDocumentLinkSyncDispatchError';
    this.cause = cause;
  }
}

/** Every field must be a non-empty, already-trimmed string. */
export function assertEntityDocumentLinkHandoffTarget(
  target: EntityDocumentLinkHandoffTarget
): EntityDocumentLinkHandoffTarget {
  for (const field of ['linkId', 'entityId', 'documentId'] as const) {
    const value = target[field];
    if (typeof value !== 'string' || !value || value !== value.trim()) {
      throw new Error(`Entity-document link handoff ${field} must be a non-empty trimmed string`);
    }
  }
  return { linkId: target.linkId, entityId: target.entityId, documentId: target.documentId };
}

export function isEntityDocumentLinkGraphAcknowledged(outcome: EntityDocumentLinkGraphHandoffOutcome): boolean {
  return outcome.status === 'acknowledged';
}

/** One sentence an operator surface can render verbatim. */
export function describeEntityDocumentLinkGraphHandoff(outcome: EntityDocumentLinkGraphHandoffOutcome): string {
  switch (outcome.status) {
    case 'acknowledged':
      return 'Graph synchronization was queued.';
    case 'pending-reconciliation':
      return `Saved, but graph synchronization is pending reconciliation: ${outcome.reason}`;
    case 'refused':
      return `Graph synchronization was refused: ${outcome.reason}`;
  }
}

// ============================================================================
// SERVER ATTESTATION THAT AN ANCHOR ALREADY EXISTS
// ============================================================================

export interface EntityDocumentLinkAnchorRecordedResponse {
  error: typeof ENTITY_DOCUMENT_LINK_HANDOFF_ERROR;
  recovery: {
    contract: typeof ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT;
    anchorType: typeof ENTITY_DOCUMENT_LINK_ANCHOR_TYPE;
    anchorRecorded: true;
    linkId: string;
    entityId: string;
    documentId: string;
    operation: EntityDocumentLinkHandoffOperation;
  };
}

export function buildEntityDocumentLinkAnchorRecordedResponse(options: {
  target: EntityDocumentLinkHandoffTarget;
  operation: EntityDocumentLinkHandoffOperation;
}): EntityDocumentLinkAnchorRecordedResponse {
  return {
    error: ENTITY_DOCUMENT_LINK_HANDOFF_ERROR,
    recovery: {
      contract: ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT,
      anchorType: ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
      anchorRecorded: true,
      linkId: options.target.linkId,
      entityId: options.target.entityId,
      documentId: options.target.documentId,
      operation: options.operation,
    },
  };
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

/**
 * Fail closed on extra, missing, stale, or cross-link receipt fields.
 *
 * The browser suppresses its own anchor write only when the server proves it
 * already wrote one FOR THIS EXACT MUTATION. Anything else and the browser
 * anchors, because a missing anchor costs recovery visibility while a duplicate
 * costs nothing (the anchor id is deterministic).
 */
export function parseEntityDocumentLinkAnchorRecordedResponse(
  value: unknown,
  expected: { target: EntityDocumentLinkHandoffTarget; operation: EntityDocumentLinkHandoffOperation }
): EntityDocumentLinkAnchorRecordedResponse | null {
  if (!isExactObject(value, ['error', 'recovery'])) return null;
  if (value.error !== ENTITY_DOCUMENT_LINK_HANDOFF_ERROR) return null;
  if (
    !isExactObject(value.recovery, [
      'contract',
      'anchorType',
      'anchorRecorded',
      'linkId',
      'entityId',
      'documentId',
      'operation',
    ])
  ) {
    return null;
  }

  const recovery = value.recovery;
  if (
    recovery.contract !== ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT ||
    recovery.anchorType !== ENTITY_DOCUMENT_LINK_ANCHOR_TYPE ||
    recovery.anchorRecorded !== true ||
    recovery.linkId !== expected.target.linkId ||
    recovery.entityId !== expected.target.entityId ||
    recovery.documentId !== expected.target.documentId ||
    recovery.operation !== expected.operation
  ) {
    return null;
  }

  return value as unknown as EntityDocumentLinkAnchorRecordedResponse;
}
