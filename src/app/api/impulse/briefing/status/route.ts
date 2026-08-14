/**
 * @file app/api/impulse/briefing/status/route.ts
 * @description UX-051 — pipeline status behind the truthful first-insight
 * empty states.
 *
 * GET /api/impulse/briefing/status
 *
 * Returns what the empty briefing feed needs to say something honest:
 *   - `hasExploration` — uid-scoped: does the CALLER have EXPLORED memory
 *     (7-day window, same semantics the sweep's watched-entity surfacing
 *     uses)? Never another user's state.
 *   - `sweepEnabled` — the resolved background-automation policy switch.
 *   - `lastSweep` — the most recent sweep-cycle summary run with its
 *     OBS-004 counters. Legacy rows without `sweepStats` report status
 *     'unknown' and null counts instead of fabricated zeros.
 *   - `degraded` — true when any source failed to answer; the failing
 *     field is null. The UI treats degraded as an outage state, never as
 *     a healthy/empty pipeline.
 *
 * 401 if not signed in. Source failures answer 200 + degraded (the
 * endpoint IS the outage detector — a 5xx here would just move the
 * ambiguity to the client).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import { SYSTEM_SWEEP_PRINCIPAL } from '@/lib/system-principals';
import { createLogger } from '@/lib/logger';
import { isMaintenancePaused } from '@/lib/maintenance-policy';
import type { AgentRunSweepStats } from '@/lib/schemas/agent-run';

export const runtime = 'nodejs';

const log = createLogger('api/impulse/briefing/status');

/**
 * How many recent runs under the sweep principal to scan for the cycle
 * summary. The sweep dispatches missions that ALSO run under this principal
 * (up to maxActionsPerSweep + gap missions per cycle), so a small window can
 * fill with mission rows and hide a summary that exists — which would make
 * the UI claim no sweep has ever run. 200 covers many days of that noise
 * without an extra composite index; beyond it the status reports `null` and
 * the UI says no RECENT result is visible, not that none ever happened.
 */
const SWEEP_RUN_SCAN_LIMIT = 200;

interface LastSweepSummary {
  at: string;
  status: 'ok' | 'quiet' | 'failed' | 'not-run' | 'unknown';
  insightsTotal: number | null;
  watchedInsights: number | null;
  narrativeInsights: number | null;
  /**
   * OBS-004 — what the sweep's CHILD missions actually did.
   *
   * `status` above describes only the sweep's own insight lane, so a cycle whose
   * paid children fail can still read as healthy. These fields are the children's terminal truth, and
   * `childrenStatus` says whether they are final yet: children outlive the sweep
   * that dispatched them, so `pending`/`partial` counters are a lower bound and a
   * reader must not treat them as settled.
   *
   * `null` throughout for legacy rows written before child accounting existed —
   * absent, not zero. A zero would assert "no children failed" about a cycle
   * whose children were never tracked.
   */
  children: {
    dispatched: number;
    settled: number;
    failed: number;
    childrenStatus: 'none' | 'pending' | 'partial' | 'settled';
    outcome: string | null;
    costUsd: number;
    costUnavailableChildren: number;
    proposals: number;
    reports: number;
  } | null;
}

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let degraded = false;

  let hasExploration: boolean | null = null;
  try {
    const { getExploredEntities } = await import('@/lib/graph/session-memory');
    hasExploration = (await getExploredEntities(auth.uid)).length > 0;
  } catch (error) {
    degraded = true;
    log.warn('briefing status: exploration read failed', { userId: auth.uid, error: String(error) });
  }

  let sweepEnabled: boolean | null = null;
  let pauseReason: 'settings' | 'maintenance' | null = null;
  if (isMaintenancePaused()) {
    // This process-wide guard wins over the persisted switch and cannot be
    // changed from Settings. Avoid a misleading Settings CTA and avoid
    // treating an intentionally paused local workspace as merely pending.
    sweepEnabled = false;
    pauseReason = 'maintenance';
  } else {
    try {
      const { db } = await import('@/lib/firebase-admin');
      const snap = await db.collection('system-config').doc('global').get();
      sweepEnabled = resolveBackgroundAutomationPolicy(snap.exists ? snap.data() : undefined).impulseSweepEnabled;
      pauseReason = sweepEnabled ? null : 'settings';
    } catch (error) {
      degraded = true;
      log.warn('briefing status: automation config read failed', { error: String(error) });
    }
  }

  let lastSweep: LastSweepSummary | null = null;
  try {
    const { db } = await import('@/lib/firebase-admin');
    const snapshot = await db
      .collection('agentRuns')
      .where('userId', '==', SYSTEM_SWEEP_PRINCIPAL)
      .orderBy('createdAt', 'desc')
      .limit(SWEEP_RUN_SCAN_LIMIT)
      .get();
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.agentName !== 'sweep-cycle') continue;
      const stats = data.sweepStats as AgentRunSweepStats | undefined;
      const children = stats?.children;
      lastSweep = {
        at: typeof data.createdAt === 'string' ? data.createdAt : '',
        status: stats?.insightsStatus ?? 'unknown',
        insightsTotal: stats?.insightsTotal ?? null,
        watchedInsights: stats?.watchedInsights ?? null,
        narrativeInsights: stats?.narrativeInsights ?? null,
        // OBS-004: surfaced separately from the insight lane, because a healthy
        // insight lane says nothing about whether the paid children delivered.
        children: children
          ? {
              dispatched: children.dispatched,
              settled: children.settled,
              failed: children.failedChildren,
              childrenStatus: children.childrenStatus,
              outcome: children.outcome ?? null,
              costUsd: children.costUsd,
              costUnavailableChildren: children.costUnavailableChildren,
              proposals: children.outputs.proposals,
              reports: children.outputs.reports,
            }
          : null,
      };
      break;
    }
  } catch (error) {
    degraded = true;
    log.warn('briefing status: sweep run read failed', { error: String(error) });
  }

  return NextResponse.json({ hasExploration, sweepEnabled, pauseReason, lastSweep, degraded });
}
