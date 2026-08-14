/**
 * @file /api/session/track
 * @description API route for tracking user entity views (session memory).
 *
 * POST /api/session/track
 * Body: { entityId: string, entityType: string }
 * Returns: { success: true, sessionId: string }
 *
 * Authenticated route -- requires Firebase ID token in Authorization header.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { resolveGraphRuntime } from '@/lib/graph/runtime-mode';
import { getOrCreateActiveSession, trackEntityView } from '@/lib/graph/session-memory';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/session/track');

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Authenticate
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { entityId, entityType } = body;

  if (!entityId || typeof entityId !== 'string') {
    return NextResponse.json({ error: 'entityId is required and must be a non-empty string' }, { status: 400 });
  }

  if (!entityType || typeof entityType !== 'string') {
    return NextResponse.json({ error: 'entityType is required and must be a non-empty string' }, { status: 400 });
  }

  try {
    const graphRuntime = resolveGraphRuntime();
    if (graphRuntime.mode !== 'neo4j') {
      const reason = graphRuntime.mode === 'disabled' ? 'graph-disabled' : 'graph-unconfigured';
      log.debug('Entity view tracking skipped because graph memory is unavailable', {
        userId: auth.uid,
        entityId,
        entityType,
        reason,
      });
      return NextResponse.json({ success: true, tracked: false, reason });
    }

    const session = await getOrCreateActiveSession(auth.uid);
    const { tracked } = await trackEntityView(session.id, entityId, entityType);

    if (tracked) {
      log.info('Entity view tracked', {
        userId: auth.uid,
        sessionId: session.id,
        entityId,
        entityType,
      });
    } else {
      // M16: the entity isn't in the graph yet (e.g. not synced to Neo4j). The
      // MERGE matched nothing — report the miss honestly instead of claiming a
      // tracked view. Not a 500: the request was well-formed, the target just
      // isn't linkable yet.
      log.warn('Entity view not tracked — entity not found in graph', {
        userId: auth.uid,
        sessionId: session.id,
        entityId,
        entityType,
      });
    }

    return NextResponse.json({ success: true, sessionId: session.id, tracked });
  } catch (error) {
    log.error('Failed to track entity view', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      entityId,
      entityType,
    });

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
