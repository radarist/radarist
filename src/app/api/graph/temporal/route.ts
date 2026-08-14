/**
 * @file app/api/graph/temporal/route.ts
 * @description Temporal graph queries — what changed and entity timelines.
 *
 * GET /api/graph/temporal?since=ISO — edges changed since date
 * GET /api/graph/temporal?entityId=ID — entity relationship timeline
 *
 * @phase Impulse v1.0 — Phase 5: Temporal Knowledge
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getChangedSince, getEntityTimeline } from '@/lib/graph/temporal-queries';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    const entityId = url.searchParams.get('entityId');

    if (entityId) {
      const timeline = await getEntityTimeline(entityId);
      return NextResponse.json({ timeline });
    }

    if (since) {
      const changes = await getChangedSince(new Date(since));
      return NextResponse.json({ changes });
    }

    return NextResponse.json({ error: 'Provide ?since=ISO or ?entityId=ID' }, { status: 400 });
  } catch (_error) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
