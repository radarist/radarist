/**
 * @file app/api/impulse/briefing/bulk-dismiss/route.ts
 * @description Bulk dismiss / undismiss for the Option A table.
 *
 * Q3 contract — bulk writes skip preference updates. The intent of "mark
 * all as read" is housekeeping, not "all of these were bad signals."
 * Single dismiss writes preferences; bulk does not. Symmetric undo: the
 * DELETE handler also skips preference rollback (there's nothing to roll
 * back).
 *
 *   POST   /api/impulse/briefing/bulk-dismiss   { insightIds: string[] }
 *     → set pi.consumed = true for each known id.
 *     → no preference write.
 *     → returns { changed } — count of rows whose flag actually flipped.
 *
 *   DELETE /api/impulse/briefing/bulk-dismiss   { insightIds: string[] }
 *     → set pi.consumed = false for each known id.
 *     → no preference rollback.
 *     → returns { changed }.
 *
 * Unknown AND foreign ids in the batch are silently skipped by the same
 * uid-bound MATCH (SEC-008) — the `changed` count never reveals which
 * ids were absent vs owned by someone else. Capping the batch at
 * MAX_BATCH_SIZE protects the DB from accidental "select 10,000 rows"
 * misuse from the client; the request errors out with a clear message.
 *
 * Rate-limit: 60 req/min per user. Same limiter family as A.1.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { consumeRateLimitToken } from '@/lib/rate-limit';

const log = createLogger('api/impulse/briefing/bulk-dismiss');

/**
 * Maximum batch size per request. 200 is well above any realistic
 * "mark all unread" use case (the briefing feed renders 20 at a time)
 * and below the row-budget at which a single Cypher write becomes
 * blocking. Pick a higher number only if a real workflow demands it.
 */
const MAX_BATCH_SIZE = 200;

async function parseInsightIds(request: NextRequest): Promise<{ insightIds: string[] } | { error: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: 'Request body must be valid JSON' };
  }
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object' };
  const raw = (body as { insightIds?: unknown }).insightIds;
  if (!Array.isArray(raw)) return { error: 'insightIds is required and must be an array' };
  if (raw.length === 0) return { error: 'insightIds must contain at least one id' };
  if (raw.length > MAX_BATCH_SIZE) return { error: `insightIds must contain at most ${MAX_BATCH_SIZE} ids` };
  // Strip duplicates and non-strings — the underlying Cypher will silently
  // skip unknown ids, but we want the request shape to be tight.
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || !id) {
      return { error: 'insightIds entries must be non-empty strings' };
    }
    seen.add(id);
  }
  return { insightIds: Array.from(seen) };
}

async function handleBulkConsumedChange(request: NextRequest, targetConsumed: boolean) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const rate = consumeRateLimitToken(`briefing-bulk-dismiss:${auth.uid}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': Math.ceil(rate.retryAfterMs / 1000).toString() } }
    );
  }

  const parsed = await parseInsightIds(request);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { insightIds } = parsed;

  try {
    const { bulkSetInsightsConsumed } = await import('@/lib/graph/proactive-insights');
    const { changed } = await bulkSetInsightsConsumed(insightIds, targetConsumed, auth.uid);

    log.info('bulk consumed-state changed', {
      userId: auth.uid,
      requested: insightIds.length,
      targetConsumed,
      changed,
    });

    return NextResponse.json({
      success: true,
      consumed: targetConsumed,
      requested: insightIds.length,
      changed,
    });
  } catch (error) {
    log.error('Failed to bulk-set consumed state', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
      requested: insightIds.length,
      targetConsumed,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handleBulkConsumedChange(request, true);
}

export async function DELETE(request: NextRequest) {
  return handleBulkConsumedChange(request, false);
}
