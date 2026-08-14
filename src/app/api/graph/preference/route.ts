/**
 * @file app/api/graph/preference/route.ts
 * @description POST endpoint that records a user's engagement with a briefing
 * insight as a per-topic preference signal.
 *
 * The previous version passed the raw `action`
 * string ('clicked' / 'dismissed' / 'acted_on') as BOTH the canonical action
 * AND the topic, which produced zombie UserPreference rows keyed on the action
 * string instead of an entity type. That broke per-topic weighting in the
 * mission preamble (every click landed in `topic='clicked'`).
 *
 * After the fix:
 *
 *   1. The raw action is normalized to one of `'acted' | 'dismissed'`.
 *      `clicked` and `acted_on` both canonicalize to `'acted'`. Anything else
 *      is 400.
 *   2. The topic list is derived from the insight's `:ABOUT` neighbours via
 *      `getInsightEntityTypes(insightId)` (entity types: 'company', 'technology',
 *      'useCase', 'strategy', ...). One preference row is written per topic.
 *   3. If the insight has no linked entities, the write is skipped silently
 *      and the response reports `topicsWritten: 0` — this is not an error.
 *
 * The function `trackInsightEngagement` keeps its narrow action union
 * (`'acted' | 'dismissed'`) — only this route's payload contract is widened
 * to accept the UI-friendly verbs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';

const log = createLogger('api/graph/preference');

/** UI-facing action strings the route accepts. */
const VALID_ACTIONS = ['clicked', 'dismissed', 'acted_on'] as const;
type ValidAction = (typeof VALID_ACTIONS)[number];

/**
 * Map the UI verb to the canonical engagement action the Neo4j preference
 * write understands. `clicked` and `acted_on` are both positive signals.
 */
function canonicaliseAction(action: ValidAction): 'acted' | 'dismissed' {
  return action === 'dismissed' ? 'dismissed' : 'acted';
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { insightId, action } = (await request.json()) as {
      insightId?: unknown;
      action?: unknown;
    };

    if (typeof insightId !== 'string' || !insightId || typeof action !== 'string' || !action) {
      return NextResponse.json({ error: 'Missing insightId or action' }, { status: 400 });
    }

    if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const canonicalAction = canonicaliseAction(action as ValidAction);

    const { getInsightTopics } = await import('@/lib/graph/proactive-insights');
    // SEC-008: topics resolve only for the caller's own insight — a foreign
    // id yields [] exactly like an absent id, so the response (200,
    // topicsWritten: 0) is identical for both and never leaks existence.
    const topics = await getInsightTopics(insightId, auth.uid);

    if (topics.length === 0) {
      log.info('preference: no topics derivable, skipping write', { insightId, action });
      return NextResponse.json({ success: true, topicsWritten: 0 });
    }

    const { trackInsightEngagement } = await import('@/lib/graph/preferences');
    for (const topic of topics) {
      await trackInsightEngagement(auth.uid, insightId, canonicalAction, topic);
    }

    return NextResponse.json({ success: true, topicsWritten: topics.length });
  } catch (error) {
    log.error('Failed to track insight preference', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
