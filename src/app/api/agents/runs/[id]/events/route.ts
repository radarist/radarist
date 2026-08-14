/**
 * @file app/api/agents/runs/[id]/events/route.ts
 * @description API route for a single run's persisted event history.
 *
 * Endpoints:
 * - GET /api/agents/runs/[id]/events — the run's agent-events (mission or
 *   sweep id), ascending by sequence. Powers the run detail page's step
 *   history (Task 22 follow-up: full observability per run).
 *
 * Requires Firebase Auth token in the Authorization header. Events are
 * queried with the server-authorized principal union (the caller's uid +
 * the compiled-in system principals, ARUN-005), so system sweep/discovery
 * run histories are readable — an id belonging to another HUMAN user still
 * simply returns an empty list.
 *
 * NOTE: agent-events carry a 24h `_ttl`, so an empty result for a real run
 * means "step history expired", not "never emitted". The client renders an
 * honest fallback note for that case.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getEventsForRun } from '@/lib/agent-events';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/agents/runs/[id]/events');

/**
 * GET /api/agents/runs/[id]/events
 *
 * Returns:
 * - 200 `{ events: AgentEvent[], truncated: boolean }` (events ascending by
 *   sequence; empty when the run is unknown, belongs to another user, or
 *   its history has expired. `truncated` is true when the run exceeded the
 *   500-event query cap — see `getEventsForRun`)
 * - 401 if not authenticated
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const { events, truncated } = await getEventsForRun(auth.uid, id);
    return NextResponse.json({ events, truncated });
  } catch (error) {
    log.error('Failed to get run events', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get run events' }, { status: 500 });
  }
}
