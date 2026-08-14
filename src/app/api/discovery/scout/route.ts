/**
 * @file api/discovery/scout/route.ts
 * @description On-demand Graph Discovery scout — fires a STAGE-ONLY discovery
 * sweep scoped to the caller's current graph view, with a per-user debounce lock
 * so repeated taps can't spam staging. DISC-016: a request without a usable view
 * context FAILS CLOSED (400) before any lock or event; on-demand sweeps stage
 * bounded triage proposals only and never dispatch paid missions. POST returns
 * 200 when dispatched, 400 unscoped/malformed, 409 when capability policy is
 * paused, 429 while debounced, 503 when policy cannot be read, or 401.
 *
 * Admin SDK only; `db` + the Inngest client are dynamic-imported inside the handler.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import { isMaintenancePaused } from '@/lib/maintenance-policy';
import { clampScoutViewContext } from '@/lib/discovery/scout-ui';

const log = createLogger('api/discovery/scout');

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { enabled: discoveryEnabled, scoutDebounceMs, deriveInterestEnabled } = getDiscoveryConfig();
  const now = Date.now();
  // Optional radar + bounded current-view context — forwarded to the sweep, which
  // falls back to a default radar when absent. "Scout my radar" lets the UI pass the
  // radar being viewed; the Graph Explorer passes the entities/tags currently in view.
  const body = (await request.json().catch((e: unknown) => {
    // A corrupt/malformed payload is logged AND rejected below — the empty
    // fallback exists only so the shape check can produce one uniform 400.
    log.debug('scout body parse failed — request will fail closed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return {};
  })) as { radarId?: string; context?: unknown };
  const radarId = typeof body.radarId === 'string' && body.radarId ? body.radarId : undefined;
  // DISC-016 — FAIL CLOSED before any lock or event. Bounds + shape validation in
  // one seam (clampScoutViewContext): a request whose context is missing,
  // malformed, or clamps to no TOPICS is rejected here, before the first
  // Firestore read, the debounce lock, and the sweep event. Neither a radarId
  // nor bare entity ids are scope — topics (entity names/tags in view) are what
  // the stage-only sweep ranks on, so without them the sweep could only degrade
  // to the generic profile ranking the UI would misrepresent as view-scoped.
  const context = clampScoutViewContext(body.context);
  if (!context?.focusTopics?.length) {
    return NextResponse.json(
      {
        error: 'Discovery needs the current graph view for scope — load entities in the graph before scouting',
        code: 'invalid_context',
        dispatched: false,
      },
      { status: 400 }
    );
  }
  try {
    const { db } = await import('@/lib/firebase-admin');

    if (!discoveryEnabled) {
      return NextResponse.json(
        { error: 'Discovery is disabled', code: 'discovery_disabled', dispatched: false },
        { status: 409 }
      );
    }

    let automationPolicy;
    try {
      const policySnap = await db.collection('system-config').doc('global').get();
      automationPolicy = resolveBackgroundAutomationPolicy(policySnap.exists ? policySnap.data() : undefined);
    } catch (policyError) {
      log.error(
        'scout could not read system config; background automation remains paused',
        policyError instanceof Error ? policyError : new Error(String(policyError)),
        { uid: auth.uid }
      );
      return NextResponse.json(
        {
          error: 'Background automation policy is unavailable',
          code: 'automation_policy_unavailable',
          dispatched: false,
        },
        { status: 503 }
      );
    }

    if (!automationPolicy.discoveryEnabled) {
      return NextResponse.json(
        { error: 'Background automation is paused', code: 'automation_paused', dispatched: false },
        { status: 409 }
      );
    }

    // Second, INDEPENDENT guard (OPS-001): the sweep worker skips outright while
    // MAINTENANCE_PAUSED is on, so a dispatch here would report "queued" for a run
    // that can never happen. Refuse honestly BEFORE dispatch instead.
    if (isMaintenancePaused()) {
      return NextResponse.json(
        {
          error: 'Ambient maintenance is paused by the MAINTENANCE_PAUSED environment guard',
          code: 'maintenance_paused',
          dispatched: false,
        },
        { status: 409 }
      );
    }

    const lockRef = db.collection('discoveryScoutLocks').doc(auth.uid);
    const lockSnap = await lockRef.get();
    const lastScoutAt = lockSnap.exists ? (lockSnap.data()?.lastScoutAt as number | undefined) : undefined;

    if (typeof lastScoutAt === 'number' && now - lastScoutAt < scoutDebounceMs) {
      return NextResponse.json(
        { error: 'Scout debounced — try again later', retryAfterMs: scoutDebounceMs - (now - lastScoutAt) },
        { status: 429 }
      );
    }

    // Refresh the user's interest from their exploration BEFORE the sweep selects, so it
    // ranks on their real footprint instead of the cold-start prior. Best-effort — a
    // derive failure must NEVER block the scout (the selector falls back to the prior).
    if (deriveInterestEnabled) {
      try {
        const { deriveInterestFromBehavior } = await import('@/lib/discovery/derive-interest');
        const { topics } = await deriveInterestFromBehavior(auth.uid);
        log.debug('interest refreshed from activity before scout', { uid: auth.uid, topicCount: topics.length });
      } catch (deriveError) {
        log.warn('interest derive failed before scout (continuing on prior)', {
          uid: auth.uid,
          error: deriveError instanceof Error ? deriveError.message : String(deriveError),
        });
      }
    }

    const { inngest } = await import('@/lib/inngest/client');
    // The consumer discriminates on `event.name` — EVERY direct
    // `app/discovery.sweep.requested` event runs stage-only; the paid pipeline
    // is the cron trigger's alone.
    await inngest.send({ name: 'app/discovery.sweep.requested', data: { userId: auth.uid, radarId, context } });

    // Commit the debounce lock only AFTER the sweep is dispatched — a send failure
    // must leave the user un-debounced, else a failed tap silently locks them out
    // for hours with no sweep ever having run. Two rapid taps may double-fire (cheap,
    // cap-bounded, downstream-deduped) — far preferable to a false multi-hour lockout.
    await lockRef.set({ lastScoutAt: now }, { merge: true });

    return NextResponse.json({ dispatched: true });
  } catch (error) {
    log.error('scout request failed', error instanceof Error ? error : new Error(String(error)), { uid: auth.uid });
    return NextResponse.json({ error: 'Failed to dispatch scout' }, { status: 500 });
  }
}
