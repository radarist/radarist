/**
 * Authenticated browser-to-server handoff for entity-document link graph
 * synchronization.
 *
 * Two branches, deliberately asymmetric because the two orderings are:
 *
 * - `delete` (batch) — dispatched BEFORE the Firestore rows are removed, so a
 *   refused handoff leaves the rows themselves as the retry anchor.
 * - `create` / `update` (single link, GRAPH-069) — dispatched AFTER the row is
 *   committed, so a refused handoff must leave an explicit durable anchor and
 *   the caller must be told the projection is pending, not done.
 *
 * Both branches re-read the authoritative link and compare the endpoints the
 * caller asserted. A caller replaying against state that has moved on is
 * refused rather than allowed to project a link it never saw.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { ENTITY_DOCUMENT_LINK_DELETE_CHUNK_SIZE } from '@/lib/entity-document-link-cascade';
import {
  requestEntityDocumentLinkGraphDeletionsServer,
  requestEntityDocumentLinkGraphSyncServer,
} from '@/lib/entity-document-link-sync-server';
import {
  ENTITY_DOCUMENT_LINK_HANDOFF_ERROR,
  EntityDocumentLinkSyncDispatchError,
  buildEntityDocumentLinkAnchorRecordedResponse,
} from '@/lib/entity-document-link-handoff';
import { adminGetEntityDocumentLinkById } from '@/lib/entity-document-link-admin';
import { mapWithBoundedConcurrency } from '@/lib/bounded-concurrency';
import { isSystemPrincipal } from '@/lib/system-principals';
import type { EntityDocumentLink } from '@/lib/types';

const log = createLogger('api/graph/entity-document-link-sync');

const EndpointIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((id) => id === id.trim(), 'IDs must not contain surrounding whitespace');

const LinkTargetSchema = z
  .object({
    linkId: EndpointIdSchema,
    entityId: EndpointIdSchema,
    documentId: EndpointIdSchema,
  })
  .strict();

const DeleteRequestSchema = z
  .object({
    operation: z.literal('delete'),
    links: z
      .array(LinkTargetSchema)
      .min(1)
      .max(ENTITY_DOCUMENT_LINK_DELETE_CHUNK_SIZE)
      .refine((links) => new Set(links.map(({ linkId }) => linkId)).size === links.length, 'linkIds must be unique'),
  })
  .strict();

/**
 * Create and update share one shape and one dispatcher. The operation is a
 * literal union rather than a free string so `delete` can never reach the
 * post-commit branch and inherit its "already saved" failure semantics.
 */
const CreateOrUpdateRequestSchema = z
  .object({
    operation: z.enum(['create', 'update']),
    link: LinkTargetSchema,
  })
  .strict();

const RequestSchema = z.union([DeleteRequestSchema, CreateOrUpdateRequestSchema]);

/**
 * Owner provenance for a post-commit handoff.
 *
 * The caller is asking the server to act on a mutation it claims to have just
 * made. A DIFFERENT authenticated human's link is refused. System-owned links
 * (autonomous discovery, sweep) and legacy rows with no recorded owner stay
 * open to any authenticated caller — refusing those would strand real links
 * whose only route to the graph is this handoff.
 */
function callerOwnsLink(link: Pick<EntityDocumentLink, 'createdBy'>, uid: string): boolean {
  const owner = typeof link.createdBy === 'string' ? link.createdBy.trim() : '';
  if (!owner || owner === 'anonymous') return true;
  return owner === uid || isSystemPrincipal(owner);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid entity-document link sync request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.operation === 'delete') {
    return handleDelete(parsed.data.links, auth.uid);
  }
  return handleCreateOrUpdate(parsed.data.link, parsed.data.operation, auth.uid);
}

async function handleDelete(links: z.infer<typeof DeleteRequestSchema>['links'], uid: string): Promise<NextResponse> {
  try {
    const currentLinks = await mapWithBoundedConcurrency(links, 8, ({ linkId }) =>
      adminGetEntityDocumentLinkById(linkId)
    );
    const invalidIndex = currentLinks.findIndex((current, index) => {
      const requested = links[index];
      return !current || current.entityId !== requested.entityId || current.documentId !== requested.documentId;
    });
    if (invalidIndex >= 0) {
      return NextResponse.json({ error: 'Entity-document link endpoints changed or no longer exist' }, { status: 409 });
    }

    const result = await requestEntityDocumentLinkGraphDeletionsServer(links);
    return NextResponse.json(
      {
        success: result.failed.length === 0,
        acknowledged: result.acknowledged,
        failed: result.failed.map(({ linkId }) => linkId),
      },
      { status: 202 }
    );
  } catch (error) {
    log.error(
      'Required entity-document link graph handoff failed',
      error instanceof Error ? error : new Error(String(error)),
      { userId: uid, linkCount: links.length }
    );
    return NextResponse.json({ error: 'Graph synchronization handoff was not acknowledged' }, { status: 503 });
  }
}

async function handleCreateOrUpdate(
  target: z.infer<typeof LinkTargetSchema>,
  operation: 'create' | 'update',
  uid: string
): Promise<NextResponse> {
  let current: EntityDocumentLink | null;
  try {
    current = await adminGetEntityDocumentLinkById(target.linkId);
  } catch (error) {
    log.error(
      'Could not read the authoritative entity-document link for a graph handoff',
      error instanceof Error ? error : new Error(String(error)),
      { userId: uid, linkId: target.linkId, operation }
    );
    return NextResponse.json({ error: ENTITY_DOCUMENT_LINK_HANDOFF_ERROR }, { status: 503 });
  }

  // Conflicting replay fails closed. A missing row or moved endpoints mean the
  // caller is describing a mutation that is no longer the current one, and
  // projecting it would write a link nobody committed.
  if (!current || current.entityId !== target.entityId || current.documentId !== target.documentId) {
    return NextResponse.json({ error: 'Entity-document link endpoints changed or no longer exist' }, { status: 409 });
  }

  if (!callerOwnsLink(current, uid)) {
    log.warn('Refused a cross-owner entity-document link graph handoff', {
      userId: uid,
      linkId: target.linkId,
      operation,
    });
    return NextResponse.json({ error: 'Not authorized to synchronize this entity-document link' }, { status: 403 });
  }

  try {
    await requestEntityDocumentLinkGraphSyncServer(current, operation);
    return NextResponse.json(
      { success: true, handoff: 'acknowledged', operation, linkId: target.linkId },
      { status: 202 }
    );
  } catch (error) {
    log.error(
      'Required entity-document link graph handoff failed',
      error instanceof Error ? error : new Error(String(error)),
      { userId: uid, linkId: target.linkId, operation }
    );
    // Attest the durable anchor ONLY when it provably exists, so the browser
    // knows whether it still has to write one. Anything else returns the bare
    // error and the browser anchors — a duplicate is free, a missing one is not.
    if (error instanceof EntityDocumentLinkSyncDispatchError && error.anchorRecorded) {
      return NextResponse.json(buildEntityDocumentLinkAnchorRecordedResponse({ target, operation }), { status: 503 });
    }
    return NextResponse.json({ error: ENTITY_DOCUMENT_LINK_HANDOFF_ERROR }, { status: 503 });
  }
}
