/**
 * @file app/api/admin/briefing/purge-stale/route.ts
 * @description Admin-gated one-shot cleanup that marks pre-2026-05-13
 * connection-class `:ProactiveInsight` nodes as consumed so they stop
 * showing on `/briefing`.
 *
 * Background: the 2026-05-12 dot-connector fix restricted path traversal
 * to semantic relation types (USES, VENDOR, PARTNER, …) and added
 * `observedEntityId` / `exploredEntityId` to every new connection
 * insight. Insights created before that change still live in Neo4j with
 * paths through bookkeeping edges (HAS_CONCEPT, ABOUT, EXPLORED) and
 * look like agent hallucinations on the UI.
 *
 * This endpoint nukes those nodes via the safe `consumed=true` flag —
 * never deletes data, so the audit trail is preserved. The next sweep
 * cycle will produce a fresh batch of higher-quality insights.
 *
 * Selection criteria (locked in by `purgeStaleConnectionInsights()`):
 *   `type='connection' AND consumed=false AND observedEntityId IS NULL`.
 *
 * `observedEntityId` is set only by the post-fix code path, so its
 * absence is a reliable marker of "pre-fix stale".
 *
 * Trigger: `POST /api/admin/briefing/purge-stale` (no body).
 * Returns: `{ success: true, purgedCount: number }`.
 *
 * Phase 0 step 0.2 of the briefing-pipeline cleanup plan (2026-05-13).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { purgeStaleConnectionInsights } from '@/lib/graph/proactive-insights';

const log = createLogger('api/admin/briefing/purge-stale');

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const purgedCount = await purgeStaleConnectionInsights();
    log.info('Stale connection insights purged', { purgedCount, uid: auth.uid });
    return NextResponse.json({ success: true, purgedCount });
  } catch (error) {
    log.error('Purge failed', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
