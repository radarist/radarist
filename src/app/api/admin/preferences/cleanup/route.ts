/**
 * @file app/api/admin/preferences/cleanup/route.ts
 * @description Admin-gated one-shot cleanup for zombie UserPreference rows.
 *
 * Background: before Phase 0 step 0.1, `/api/graph/preference` passed the
 * raw action verb (`'clicked'` / `'dismissed'`) as both the canonical
 * action AND the per-topic key. That produced `:UserPreference` rows
 * keyed on the action string instead of an entity type — useless for
 * biasing future agent missions and noise in any per-topic query.
 *
 * The source bug is closed (step 0.1). This endpoint clears the historical
 * residue.
 *
 * Selection: `WHERE up.topic IN ['clicked', 'dismissed']` then `DETACH
 * DELETE`. Hard delete is safe here — these rows were never valid in the
 * first place and there's no audit trail to preserve (unlike the
 * `consumed=true` soft-delete used for ProactiveInsight purge).
 *
 * Triggers: POST /api/admin/preferences/cleanup (no body).
 * Returns: `{ success: true, deletedCount: number }`.
 *
 * Phase 0 step 0.9 of the briefing-pipeline cleanup plan (2026-05-13).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { cleanupZombiePreferences } from '@/lib/graph/preferences';

const log = createLogger('api/admin/preferences/cleanup');

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const deletedCount = await cleanupZombiePreferences();
    log.info('Zombie preferences cleaned', { deletedCount, uid: auth.uid });
    return NextResponse.json({ success: true, deletedCount });
  } catch (error) {
    log.error('Cleanup failed', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
