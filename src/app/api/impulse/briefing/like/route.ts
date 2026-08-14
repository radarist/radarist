/**
 * @file app/api/impulse/briefing/like/route.ts
 * @description Like / unlike a briefing insight (Option A step A.1).
 *
 * Contract — explicit set-true / set-false, not toggle-NOT. A POST that
 * retries must not double-flip the count.
 *
 *   POST   /api/impulse/briefing/like   { insightId }
 *     → sets pi.liked = true.
 *     → if previousLiked was false, increment acted_count by 1 on each
 *       UserPreference row keyed by an entity type the insight is ABOUT.
 *     → if previousLiked was already true, no preference write fires.
 *
 *   DELETE /api/impulse/briefing/like   { insightId }
 *     → sets pi.liked = false.
 *     → if previousLiked was true, decrement acted_count by 1 (clamped at
 *       zero) on each UserPreference row keyed by an entity type the
 *       insight is ABOUT.
 *     → if previousLiked was already false, no preference write fires.
 *
 * Idempotency lives in `setInsightLikedState` (prior-state read + SET in
 * one transaction). The route layer only decides whether to fire the
 * preference adjustment.
 *
 * Rate-limit: 60 requests per minute per user. Tighter than is strictly
 * required for human click rates, but the only knob against client-side
 * spam. Same limiter is shared with bulk-dismiss in A.2.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { consumeRateLimitToken } from '@/lib/rate-limit';

const log = createLogger('api/impulse/briefing/like');

/** Parse + validate the `{ insightId }` body. Returns 400-ready error or the id. */
async function parseInsightId(request: NextRequest): Promise<{ insightId: string } | { error: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: 'Request body must be valid JSON' };
  }
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object' };
  const insightId = (body as { insightId?: unknown }).insightId;
  if (typeof insightId !== 'string' || !insightId) {
    return { error: 'insightId is required and must be a non-empty string' };
  }
  return { insightId };
}

async function handleLikeChange(request: NextRequest, targetLiked: boolean) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const rate = consumeRateLimitToken(`briefing-like:${auth.uid}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': Math.ceil(rate.retryAfterMs / 1000).toString() } }
    );
  }

  const parsed = await parseInsightId(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { insightId } = parsed;

  try {
    // Dynamic imports to keep the server-only Neo4j layer out of the
    // route file's static import graph. Same pattern as the rest of the
    // briefing endpoints.
    const { setInsightLikedState, getInsightTopics } = await import('@/lib/graph/proactive-insights');
    const { adjustInsightEngagement, trackInsightEngagement } = await import('@/lib/graph/preferences');

    const { exists, previousLiked } = await setInsightLikedState(insightId, targetLiked, auth.uid);
    if (!exists) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    const changed = previousLiked !== targetLiked;
    let topicsWritten = 0;

    if (changed) {
      const topics = await getInsightTopics(insightId, auth.uid);
      for (const topic of topics) {
        if (targetLiked) {
          // FIRST TOUCH (false→true): MERGE the row so the +1 lands even when
          // no UserPreference exists yet (H12 — adjustInsightEngagement is
          // MATCH-only and would silently no-op on a missing row).
          await trackInsightEngagement(auth.uid, insightId, 'acted', topic);
        } else {
          // ROLLBACK (true→false): MATCH-only decrement — must never resurrect a
          // row the like path (or a cleanup) already removed.
          await adjustInsightEngagement(auth.uid, topic, 'acted_count', -1);
        }
      }
      topicsWritten = topics.length;
    }

    log.info('like state set', {
      userId: auth.uid,
      insightId,
      previousLiked,
      liked: targetLiked,
      changed,
      topicsWritten,
    });

    return NextResponse.json({
      success: true,
      liked: targetLiked,
      previousLiked,
      changed,
      topicsWritten,
    });
  } catch (error) {
    log.error('Failed to set insight like state', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      insightId,
      targetLiked,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handleLikeChange(request, true);
}

export async function DELETE(request: NextRequest) {
  return handleLikeChange(request, false);
}
