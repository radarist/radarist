/**
 * @file app/api/impulse/briefing/dismiss/route.ts
 * @description Dismiss / undismiss a single insight (Option A step A.2).
 *
 * Contract — explicit set-true / set-false, not toggle-NOT. Mirrors the
 * shape of A.1's like endpoint: a POST that retries must not double-write
 * the per-topic `dismissed_count`.
 *
 *   POST   /api/impulse/briefing/dismiss   { insightId }
 *     → set pi.consumed = true.
 *     → if previousConsumed was false, derive topics from
 *       `getInsightEntityTypes`, write +1 to each topic's `dismissed_count`,
 *       and persist the topic list as `pi.lastDismissWroteTopics` so
 *       undo knows which rows to roll back.
 *     → if previousConsumed was already true, no preference write fires.
 *
 *   DELETE /api/impulse/briefing/dismiss   { insightId }
 *     → set pi.consumed = false, clear pi.lastDismissWroteTopics.
 *     → if previousConsumed was true, decrement `dismissed_count` by 1
 *       (clamped at zero) on each topic from the cleared marker.
 *     → if previousConsumed was already false, return { noop: true }.
 *
 * Rate-limit: 60 requests per minute per user.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { consumeRateLimitToken } from '@/lib/rate-limit';

const log = createLogger('api/impulse/briefing/dismiss');

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

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const rate = consumeRateLimitToken(`briefing-dismiss:${auth.uid}`);
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
    const { setInsightConsumedState, getInsightTopics } = await import('@/lib/graph/proactive-insights');
    const { trackInsightEngagement } = await import('@/lib/graph/preferences');

    // Derive topics *before* the state write so the marker we persist
    // matches the rows we increment. ABOUT edges don't move during a
    // dismiss, so the read-before-write split is safe.
    const topics = await getInsightTopics(insightId, auth.uid);

    const { exists, previousConsumed } = await setInsightConsumedState(insightId, true, auth.uid, { topics });
    if (!exists) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    const changed = !previousConsumed;
    let topicsWritten = 0;
    if (changed) {
      // FIRST TOUCH: the dismissal is THE key negative signal, so it must land
      // even when no UserPreference row exists yet — route through the
      // MERGE-capable trackInsightEngagement, not the MATCH-only adjuster which
      // silently no-ops on a missing row (H12).
      for (const topic of topics) {
        await trackInsightEngagement(auth.uid, insightId, 'dismissed', topic);
      }
      topicsWritten = topics.length;
    }

    log.info('insight dismissed', {
      userId: auth.uid,
      insightId,
      previousConsumed,
      changed,
      topicsWritten,
    });

    return NextResponse.json({
      success: true,
      consumed: true,
      previousConsumed,
      changed,
      topicsWritten,
    });
  } catch (error) {
    log.error('Failed to dismiss insight', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      insightId,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const rate = consumeRateLimitToken(`briefing-dismiss:${auth.uid}`);
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
    const { setInsightConsumedState } = await import('@/lib/graph/proactive-insights');
    const { adjustInsightEngagement } = await import('@/lib/graph/preferences');

    // The undismiss write returns prior topics (`lastDismissWroteTopics`)
    // *before* clearing the marker, so we know which preference rows the
    // dismiss originally touched. An older dismiss that pre-dates the
    // marker stores an empty list — undo silently skips the preference
    // rollback in that case (consumed flag still flips back).
    const { exists, previousConsumed, previousTopics } = await setInsightConsumedState(insightId, false, auth.uid);
    if (!exists) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }

    if (!previousConsumed) {
      log.info('undismiss noop — insight was not consumed', { userId: auth.uid, insightId });
      return NextResponse.json({ success: true, consumed: false, previousConsumed, noop: true });
    }

    let topicsRolledBack = 0;
    for (const topic of previousTopics) {
      await adjustInsightEngagement(auth.uid, topic, 'dismissed_count', -1);
      topicsRolledBack++;
    }

    log.info('insight undismissed', {
      userId: auth.uid,
      insightId,
      previousConsumed,
      topicsRolledBack,
    });

    return NextResponse.json({
      success: true,
      consumed: false,
      previousConsumed,
      changed: true,
      topicsRolledBack,
    });
  } catch (error) {
    log.error('Failed to undismiss insight', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      insightId,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
