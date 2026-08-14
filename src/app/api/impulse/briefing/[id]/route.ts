/**
 * @file app/api/impulse/briefing/[id]/route.ts
 * @description Fetch a single insight by ID for the detail page.
 *
 * GET /api/impulse/briefing/[id]
 *
 * Returns the insight node plus the structured path data from A.0
 * (relationshipTypes, pathLength, exploredAt), the resolved related
 * entities, and the `liked` state. The UI uses this to render the
 * "Why am I seeing this?" breadcrumb without a second round-trip.
 *
 * Ownership (SEC-008): the read is bound to the authenticated uid inside
 * the graph MATCH. A foreign user's insight id and an id that never
 * existed return the identical 404, so existence never leaks. (The
 * earlier "insights are intentionally global" posture from plan §7.5 is
 * superseded by the repository authorization baseline.)
 *
 * 404 if the id is unknown or not owned, 401 if not signed in.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { GraphUnavailableError, graphDegradedBody } from '@/lib/graph/errors';
import { withGraphReadDeadline } from '@/lib/graph/interactive-read';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/impulse/briefing/[id]');

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id: insightId } = await ctx.params;
  if (!insightId || typeof insightId !== 'string') {
    return NextResponse.json({ error: 'insightId is required in the URL path' }, { status: 400 });
  }

  try {
    const { getInsightById } = await import('@/lib/graph/proactive-insights');
    // PERF-008: bound the interactive read so a Neo4j outage returns the 503
    // below within a measured budget instead of the driver's stacked ~33–60s.
    const insight = await withGraphReadDeadline('briefing-detail', () => getInsightById(insightId, auth.uid));
    if (!insight) {
      // A real miss — stale link, dismissed, or not owned by this user. The
      // same body serves all misses (SEC-008: foreign vs absent must be
      // indistinguishable). Distinct from an outage (503 below) so the UI
      // can say "not found" vs "unavailable".
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    // Strip server-only fields the UI shouldn't see (the writer's userId
    // and the consumed flag — the detail page can be opened on an already
    // consumed insight from a deep link, that's fine).
    const { userId: _ownerUserId, consumed: _consumed, ...payload } = insight;
    void _ownerUserId;
    void _consumed;

    return NextResponse.json(payload);
  } catch (error) {
    // Honest degradation (UX-018): a graph outage returns 503 `degraded` so the
    // detail page shows "unavailable / retry" rather than the "stale link"
    // copy it reserves for a genuine 404.
    if (error instanceof GraphUnavailableError) {
      log.warn('Neo4j unavailable, returning degraded insight detail', {
        error: error.message,
        backend: error.backend,
        userId: auth.uid,
        insightId,
      });
      return NextResponse.json(graphDegradedBody(error), { status: 503 });
    }

    log.error('Failed to fetch insight detail', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      insightId,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
