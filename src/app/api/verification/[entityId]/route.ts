/**
 * @file app/api/verification/[entityId]/route.ts
 * @description Get verification status for an entity.
 *
 * GET /api/verification/[entityId]
 *
 * @phase Impulse v1.0 — Phase 3: Defense Minister
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { GraphUnavailableError, graphDegradedBody } from '@/lib/graph/errors';
import { resolveGraphRuntime } from '@/lib/graph/runtime-mode';
import { getVerificationForEntity } from '@/lib/graph/verification';

export async function GET(request: NextRequest, { params }: { params: Promise<{ entityId: string }> }) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { entityId } = await params;
    const graphRuntime = resolveGraphRuntime();
    if (graphRuntime.mode !== 'neo4j') {
      const reason = graphRuntime.mode === 'disabled' ? 'graph-disabled' : 'graph-unconfigured';
      return NextResponse.json({ verification: null, available: false, reason });
    }

    const result = await getVerificationForEntity(entityId);
    return NextResponse.json({ verification: result });
  } catch (error) {
    if (error instanceof GraphUnavailableError) {
      return NextResponse.json(graphDegradedBody(error), { status: 503 });
    }

    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
