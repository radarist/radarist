/**
 * @file app/api/impulse/briefing/[id]/view/route.ts
 * @description Record a view of an insight from the detail page.
 *
 * POST /api/impulse/briefing/[id]/view
 *
 * Implements Q1 of the engagement-semantics decisions (plan §6):
 * "opening the detail page counts as engagement, debounced once per
 * (user, insight, session)". The debounce lives on a `:VIEWED_INSIGHT`
 * sentinel edge from the user's active Session node to the insight —
 * see `recordInsightView` for the MERGE shape.
 *
 * Response shape:
 *   { recorded: true,  topicsWritten: 0 }   — first view in this session
 *   { recorded: false, topicsWritten: 0 }   — repeat view in this session
 *
 * Views record session bookkeeping (via recordInsightView) only; they do NOT
 * write preference weights. Explicit likes/dismissals are the signal source
 * for posterior learning. Views are not endorsements.
 *
 * Rate-limit: 60 req/min per user, shared with the like route. Stops
 * client-side hammers; doesn't matter much for normal navigation.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { consumeRateLimitToken } from '@/lib/rate-limit';

const log = createLogger('api/impulse/briefing/view');

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const rate = consumeRateLimitToken(`briefing-view:${auth.uid}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': Math.ceil(rate.retryAfterMs / 1000).toString() } }
    );
  }

  const { id: insightId } = await ctx.params;
  if (!insightId || typeof insightId !== 'string') {
    return NextResponse.json({ error: 'insightId is required in the URL path' }, { status: 400 });
  }

  try {
    const { recordInsightView } = await import('@/lib/graph/proactive-insights');
    const { getOrCreateActiveSession } = await import('@/lib/graph/session-memory');

    // Same active-session logic as `recordExploration` (step 0.7): 30-minute
    // sliding window, reuse existing session if alive, otherwise create.
    const session = await getOrCreateActiveSession(auth.uid);

    const { exists, recorded } = await recordInsightView(session.id, insightId, auth.uid);
    if (!exists) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    // Views never write preference weights — only explicit likes/dismissals do.
    const topicsWritten = 0;

    log.info('insight view recorded', {
      userId: auth.uid,
      sessionId: session.id,
      insightId,
      recorded,
      topicsWritten,
    });

    return NextResponse.json({ recorded, topicsWritten });
  } catch (error) {
    log.error('Failed to record insight view', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      insightId,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
