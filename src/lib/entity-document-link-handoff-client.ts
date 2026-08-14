/**
 * @file lib/entity-document-link-handoff-client.ts
 * @description GRAPH-069 — browser delivery for the entity-document link
 * create/update graph handoff.
 *
 * The browser never dispatches to Inngest itself. It cannot: a page bundle has
 * no view of the server-only `INNGEST_DEV` routing value, so the SDK addresses
 * the hosted service even while the app is wired to a local dev server. It
 * calls the authenticated same-origin route instead, where the server SDK has
 * the authoritative environment, the authoritative link row, and the Admin-SDK
 * recovery anchor.
 *
 * The browser still owns ONE piece of recovery, and only one: a dispatch outage
 * has two shapes — the queue refusing the event, and the route itself being
 * unreachable — and only the browser sits upstream of both. Firestore is
 * provably reachable at that moment, because the link write just committed
 * through it.
 *
 * Nothing here throws. The link is already committed by the time this runs, so
 * a delivery problem reported as a thrown error would misreport a saved link as
 * rejected — the exact defect this row exists to fix.
 */

import { createLogger } from '@/lib/logger';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import {
  ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
  ENTITY_DOCUMENT_LINK_HANDOFF_ROUTE,
  assertEntityDocumentLinkHandoffTarget,
  parseEntityDocumentLinkAnchorRecordedResponse,
  type EntityDocumentLinkGraphHandoffOutcome,
  type EntityDocumentLinkHandoffOperation,
  type EntityDocumentLinkHandoffTarget,
} from '@/lib/entity-document-link-handoff';

const log = createLogger('entity-document-link-handoff-client');

/** Keep a required browser-to-server graph handoff from hanging the link UI. */
export const ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS = 15_000;

function createHandoffTimeout() {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS);

  return {
    signal: controller.signal,
    reason(error: unknown): string {
      if (timedOut) {
        return `graph synchronization handoff timed out after ${ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS}ms`;
      }
      return error instanceof Error ? error.message : String(error);
    },
    clear(): void {
      clearTimeout(timer);
    },
  };
}

class HandoffRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EntityDocumentLinkHandoffRefusedError';
  }
}

class HandoffUnacknowledgedError extends Error {
  constructor(
    reason: string,
    /** The server persisted the durable anchor itself; do not write a second one. */
    public readonly serverAnchorRecorded: boolean
  ) {
    super(reason);
    this.name = 'EntityDocumentLinkHandoffUnacknowledgedError';
  }
}

/**
 * A refusal is a statement about the REQUEST, not about delivery. Retrying it
 * unchanged cannot help, so it must never enter the recovery queue; the caller
 * surfaces it instead.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

function errorDetail(body: unknown, status: number): string {
  const parsed = body as { error?: unknown } | null;
  return typeof parsed?.error === 'string' ? parsed.error : `HTTP ${status}`;
}

/**
 * Only a 503 from the exact same-origin handoff route may suppress the
 * browser's own anchor write. Outside a browser (or with no response URL) the
 * check cannot be made, so the caller anchors — the safe direction.
 */
function isSameOriginHandoffResponse(response: Response): boolean {
  if (typeof window === 'undefined' || !response.url) return false;
  if (response.status !== 503) return false;
  try {
    const url = new URL(response.url);
    return (
      url.origin === window.location.origin &&
      url.pathname === ENTITY_DOCUMENT_LINK_HANDOFF_ROUTE &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * Persist the browser-side recovery anchor for a committed link mutation whose
 * handoff never landed.
 *
 * Dynamically imported so the outbox writer stays out of this module's static
 * delivery graph, and fail-soft twice over: the recorder already swallows its
 * own errors, and this guard covers the import itself.
 */
async function recordBrowserLinkAnchor(
  target: EntityDocumentLinkHandoffTarget,
  operation: EntityDocumentLinkHandoffOperation,
  error: unknown
): Promise<boolean> {
  try {
    const { recordEntityGraphSyncAnchor } = await import('@/lib/entity-graph-sync-outbox-client');
    const record = await recordEntityGraphSyncAnchor({
      entityType: ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
      entityId: target.linkId,
      operation,
      error,
    });
    return record !== null;
  } catch (anchorError) {
    log.warn('Could not record entity-document link graph sync anchor', {
      linkId: target.linkId,
      operation,
      error: anchorError instanceof Error ? anchorError.message : String(anchorError),
    });
    return false;
  }
}

/**
 * The single create/update graph handoff every browser caller uses.
 *
 * Never throws — the caller gets a named outcome and decides what to tell the
 * operator.
 */
export async function requestEntityDocumentLinkGraphHandoff(
  target: EntityDocumentLinkHandoffTarget,
  operation: EntityDocumentLinkHandoffOperation
): Promise<EntityDocumentLinkGraphHandoffOutcome> {
  let normalized: EntityDocumentLinkHandoffTarget;
  try {
    normalized = assertEntityDocumentLinkHandoffTarget(target);
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }

  const timeout = createHandoffTimeout();
  try {
    const response = await fetchWithAuth(ENTITY_DOCUMENT_LINK_HANDOFF_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, link: normalized }),
      signal: timeout.signal,
    });

    if (response.ok) {
      log.debug('Entity-document link graph handoff acknowledged', { linkId: normalized.linkId, operation });
      return { status: 'acknowledged' };
    }

    const body: unknown = await response.json().catch(() => null);
    const detail = errorDetail(body, response.status);
    if (REFUSAL_STATUSES.has(response.status)) throw new HandoffRefusedError(detail);

    const serverAnchorRecorded =
      isSameOriginHandoffResponse(response) &&
      parseEntityDocumentLinkAnchorRecordedResponse(body, { target: normalized, operation }) !== null;
    throw new HandoffUnacknowledgedError(detail, serverAnchorRecorded);
  } catch (error) {
    if (error instanceof HandoffRefusedError) {
      log.warn('Entity-document link graph handoff refused', {
        linkId: normalized.linkId,
        operation,
        reason: error.message,
      });
      return { status: 'refused', reason: error.message };
    }

    const reason = error instanceof HandoffUnacknowledgedError ? error.message : timeout.reason(error);
    const serverAnchorRecorded = error instanceof HandoffUnacknowledgedError && error.serverAnchorRecorded;
    const anchorRecorded = serverAnchorRecorded ? true : await recordBrowserLinkAnchor(normalized, operation, reason);
    log.warn('Entity-document link graph handoff was not acknowledged', {
      linkId: normalized.linkId,
      operation,
      reason,
      anchorRecorded,
    });
    return { status: 'pending-reconciliation', reason, anchorRecorded };
  } finally {
    timeout.clear();
  }
}
