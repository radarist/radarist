/** Authenticated browser-to-server handoff for durable library graph sync. */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { LIBRARY_ENTITY_SYNC_TYPES } from '@/lib/entity-sync';
import {
  buildEntityGraphSyncAnchorRecordedResponse,
  ENTITY_GRAPH_SYNC_HANDOFF_ERROR,
} from '@/lib/entity-sync-contract';
import {
  requestEntityGraphDeletionsServer,
  requestEntityGraphSyncServer,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';

const log = createLogger('api/graph/entity-sync');

const EntityIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((id) => id === id.trim(), 'entity IDs must not contain surrounding whitespace');

const RequiredEntitySingleRequestSchema = z
  .object({
    entityType: z.enum(LIBRARY_ENTITY_SYNC_TYPES),
    entityId: EntityIdSchema,
    operation: z.enum(['create', 'update', 'delete']),
  })
  .strict();

const EntityDeleteBatchRequestSchema = z
  .object({
    entityType: z.enum(LIBRARY_ENTITY_SYNC_TYPES),
    entityIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'entityIds must be unique'),
    operation: z.literal('delete'),
  })
  .strict();

const RequiredEntitySyncRequestSchema = z.union([
  RequiredEntitySingleRequestSchema,
  EntityDeleteBatchRequestSchema,
]);

const BestEffortEntitySyncRequestSchema = z
  .object({
    entityType: z.enum(LIBRARY_ENTITY_SYNC_TYPES),
    entityId: EntityIdSchema,
    operation: z.enum(['create', 'update']),
  })
  .strict();

type AuthenticatedJsonRequest =
  | { ok: true; uid: string; body: unknown }
  | { ok: false; response: NextResponse };

async function authenticateAndReadJson(request: NextRequest): Promise<AuthenticatedJsonRequest> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: 401 }) };
  }

  try {
    return { ok: true, uid: auth.uid, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authenticated = await authenticateAndReadJson(request);
  if (!authenticated.ok) return authenticated.response;

  const parsed = RequiredEntitySyncRequestSchema.safeParse(authenticated.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid entity sync request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { entityType, operation } = parsed.data;
  try {
    if ('entityIds' in parsed.data) {
      const result = await requestEntityGraphDeletionsServer(entityType, parsed.data.entityIds);
      return NextResponse.json(
        {
          success: result.failed.length === 0,
          acknowledged: result.acknowledged,
          failed: result.failed.map(({ id }) => id),
        },
        { status: 202 }
      );
    }

    const { entityId } = parsed.data;
    await requestEntityGraphSyncServer(entityType, entityId, parsed.data.operation);
    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    log.error(
      'Required entity graph handoff failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        userId: authenticated.uid,
        entityType,
        entityId: 'entityId' in parsed.data ? parsed.data.entityId : undefined,
        entityCount: 'entityIds' in parsed.data ? parsed.data.entityIds.length : 1,
        operation,
      }
    );
    return NextResponse.json(
      { error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR },
      { status: 503 }
    );
  }
}

/**
 * Best-effort post-commit handoff for library create/update mutations.
 *
 * This is a separate HTTP contract instead of a client-supplied `mode` field:
 * the request body cannot downgrade required POST semantics, and deletes can
 * never enter this saved-locally path. Both methods are authenticated and emit
 * the same identifier-only worker events; the method controls only failure
 * reporting and durable recovery behavior, not mutation authority.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const authenticated = await authenticateAndReadJson(request);
  if (!authenticated.ok) return authenticated.response;

  const parsed = BestEffortEntitySyncRequestSchema.safeParse(authenticated.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid best-effort entity sync request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { entityType, entityId, operation } = parsed.data;
  try {
    const outcome = await triggerEntityGraphSyncBestEffortServer(entityType, entityId, operation);
    if (!outcome.acknowledged && outcome.anchorRecorded) {
      return NextResponse.json(
        buildEntityGraphSyncAnchorRecordedResponse({ entityType, entityId, operation }),
        { status: 503 }
      );
    }
    if (!outcome.acknowledged) {
      throw new Error('best-effort graph handoff was not acknowledged');
    }
    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    log.error(
      'Best-effort entity graph handoff failed',
      error instanceof Error ? error : new Error(String(error)),
      { userId: authenticated.uid, entityType, entityId, operation }
    );
    return NextResponse.json({ error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR }, { status: 503 });
  }
}
