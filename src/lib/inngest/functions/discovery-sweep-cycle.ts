/**
 * @file inngest/functions/discovery-sweep-cycle.ts
 * @description The discovery sweep, with a hard DISC-016 mode boundary:
 *
 * - AMBIENT (cron leg): select interest-ranked candidate entities, run them
 *   through the PINNED containment pipeline (source-cap → diversity-check →
 *   dedup → quota/MMR → truncate, BIAS-FIX-2), and dispatch an evaluation
 *   build-mission for each survivor. This is the ONLY leg that may create
 *   missions/reservations, and it stays double-gated (DISCOVERY_SWEEP_ENABLED
 *   default-off + background-automation policy).
 *
 * - ON-DEMAND (`app/discovery.sweep.requested`, the Graph Discovery click):
 *   STAGE-ONLY. Requires a usable view context (fail closed — re-validated here
 *   because any server can send the event), stages bounded, deduplicated
 *   net-new triage proposals scoped to that context, and NEVER reaches
 *   candidate selection, containment, or paid dispatch. Paid evaluation work
 *   needs a separate exact confirmation (the chat dispatch tools' CONFIRM
 *   SPEND flow).
 *
 * Inngest discipline: all I/O inside `step.run`; admin/service modules
 * dynamic-imported INSIDE the step (never statically at file top — only `inngest`,
 * `createLogger`, and the pure `getDiscoveryConfig`/`clampScoutViewContext` are
 * static). concurrency
 * `{ limit: 1 }`, no `key`. Containment steps fail-open: a containment error must
 * never kill the sweep. Gated entirely behind `DISCOVERY_SWEEP_ENABLED`.
 */
import { inngest } from '../client';
import { captureDurableInstantMs } from '../durable-duration';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { SYSTEM_DISCOVERY_PRINCIPAL } from '@/lib/system-principals';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { clampScoutViewContext } from '@/lib/discovery/scout-ui';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';

const log = createLogger('inngest/discovery-sweep-cycle');

/**
 * Per-dimension net-new discovery outcome (DISC-015). `ok:false` means the
 * dimension yielded nothing usable (malformed model response or an infra
 * failure); it is retained here rather than silently dropped so a partial
 * sweep is honestly reported.
 */
interface NetNewDimensionDiagnostic {
  entityType: string;
  ok: boolean;
  considered: number;
  proposed: number;
  failed: number;
  error?: string;
}

/** Over-fetch factor so containment has slack to trim before truncating to the cap. */
const OVERFETCH = 3;

/** Cron (default twice daily, 01:30 + 13:30 UTC). Inngest accepts a `TZ=` prefix. */
const DISCOVERY_SWEEP_CRON = process.env.DISCOVERY_SWEEP_CRON || 'TZ=UTC 30 1,13 * * *';

export const discoverySweepCycle = inngest.createFunction(
  {
    id: 'discovery-sweep-cycle',
    name: 'Discovery Sweep Cycle',
    retries: 1,
    concurrency: { limit: 1 },
    onFailure: async ({ error }: { error: unknown }) => {
      log.error('discovery sweep failed', error instanceof Error ? error : new Error(String(error)));
    },
  },
  [{ event: 'app/discovery.sweep.requested' }, { cron: DISCOVERY_SWEEP_CRON }],
  async ({
    event,
    step,
  }: {
    event?: { name?: string; data?: { userId?: string; radarId?: string; context?: unknown } };
    step: SweepStep;
  }) => {
    if (isMaintenancePaused()) return maintenanceSkip('discovery-sweep-cycle');
    // OBS-004/OBS-006: durable start instant. This cycle spans several step
    // boundaries (config, candidate selection, containment, dispatch), and a
    // handler-body `Date.now()` is re-initialised on every one of Inngest's
    // per-step HTTP requests — so the `durationMs` it published on
    // `app/discovery.sweep.completed` measured only the final invocation slice.
    const startedAt = await captureDurableInstantMs(step, 'capture-discovery-sweep-start');

    const config = getDiscoveryConfig();
    if (!config.enabled) return { action: 'disabled', dispatched: 0 };

    const automationPolicy = await step.run('load-automation-policy', async () => {
      try {
        const { db: adminDb } = await import('@/lib/firebase-admin');
        const snap = await adminDb.collection('system-config').doc('global').get();
        return resolveBackgroundAutomationPolicy(snap.exists ? snap.data() : undefined);
      } catch (error) {
        log.error(
          'discovery sweep could not read system config; background automation remains paused',
          error instanceof Error ? error : new Error(String(error))
        );
        return resolveBackgroundAutomationPolicy(undefined);
      }
    });
    if (!automationPolicy.discoveryEnabled) return { action: 'paused', dispatched: 0 };

    // DISC-016 mode boundary. ANY direct `app/discovery.sweep.requested` event
    // is on-demand and therefore STAGE-ONLY — the paid pipeline below is the
    // cron leg's exclusive privilege, so a hand-crafted or unstamped event can
    // never create missions or reservations (fail closed).
    const isOnDemand = event?.name === 'app/discovery.sweep.requested';
    const userId = event?.data?.userId ?? SYSTEM_DISCOVERY_PRINCIPAL;

    // Bounded view context from the dispatching UI (GRAPH-045). Re-clamp here even
    // though the scout route already clamped: any caller can send this event, so the
    // bound must hold at the consumer, not just at one ingress. Cron leg → undefined.
    const focus = clampScoutViewContext(event?.data?.context);

    if (isOnDemand && !focus?.focusTopics?.length) {
      // The route already fails closed (400); re-refuse at the consumer so a
      // hand-sent unscoped event cannot reach staging either. Topics are the
      // scope — bare entity ids would only stage generic profile-ranked
      // proposals misrepresented as view-scoped (DISC-016).
      log.warn('on-demand discovery sweep rejected — no usable view-topic scope (fail closed)', { userId });
      return { action: 'rejected-unscoped', mode: 'staged', dispatched: 0 };
    }

    // 1 — pending-cap (count-cap budget substitute): BOTH modes skip when triage
    // is backed up, so on-demand staging is bounded by the same cap.
    const pendingCount = await step.run('check-pending-cap', async () => {
      const { getProposedAssessments } = await import('@/lib/proposed-assessments-admin');
      return (await getProposedAssessments({ status: 'pending' })).length;
    });
    if (pendingCount >= config.pendingProposalsCap) {
      return { action: 'cap-reached', dispatched: 0, pendingCount, ...(isOnDemand ? { mode: 'staged' } : {}) };
    }

    // Net-new discovery (gated): scout entities the user does NOT already have,
    // staged as PENDING proposedEntities for /triage/entities — bounded by
    // maxNetNewPerCycle per dimension and slug-deduplicated at the writer.
    // On-demand runs pass the view context's topics so proposals are scoped to
    // what the user was looking at instead of the generic profile ranking.
    // Best-effort — a discovery failure must never fail the sweep.
    // DISC-015: each dimension runs independently and reports a diagnostic; a
    // malformed/failed dimension is preserved as `ok:false` in the diagnostics
    // and never sinks the successful dimensions or the sweep as a whole.
    const runNetNewStaging = async (): Promise<{ proposed: number; diagnostics: NetNewDimensionDiagnostic[] }> => {
      if (!config.netNewEnabled) return { proposed: 0, diagnostics: [] as NetNewDimensionDiagnostic[] };
      const { discoverNetNewEntities, DISCOVERABLE_TYPES } = await import('@/lib/discovery/net-new-discovery');
      const dims = config.netNewDimensions.filter((d) => (DISCOVERABLE_TYPES as readonly string[]).includes(d));
      let total = 0;
      const diagnostics: NetNewDimensionDiagnostic[] = [];
      for (const entityType of dims) {
        try {
          const result = await discoverNetNewEntities(userId, {
            entityType: entityType as (typeof DISCOVERABLE_TYPES)[number],
            limit: config.maxNetNewPerCycle,
            ...(focus?.focusTopics?.length ? { focusTopics: focus.focusTopics } : {}),
          });
          total += result.proposed ?? 0;
          diagnostics.push({
            entityType,
            ok: result.ok !== false,
            considered: result.considered ?? 0,
            proposed: result.proposed ?? 0,
            failed: result.failed ?? 0,
            ...(result.error ? { error: result.error } : {}),
          });
          if (result.ok === false) {
            log.error(`net-new discovery returned an unusable response for dimension "${entityType}" (continuing)`, {
              entityType,
              error: result.error,
            });
          }
        } catch (error) {
          // A net-new failure for one dimension (interest read or model call down) is a
          // broken capability, not cosmetic — surface loudly; other dimensions continue.
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push({ entityType, ok: false, considered: 0, proposed: 0, failed: 0, error: message });
          log.error(
            `net-new discovery failed for dimension "${entityType}" (continuing)`,
            error instanceof Error ? error : new Error(message)
          );
        }
      }
      return { proposed: total, diagnostics };
    };

    // === ON-DEMAND (STAGE-ONLY) MODE — DISC-016 ===============================
    // A Graph Discovery click stages bounded, deduplicated triage proposals and
    // STOPS. Radar resolution, candidate selection, containment, and paid
    // dispatch below are unreachable: zero missions, zero reservations.
    if (isOnDemand) {
      const staged = await step.run('discover-net-new', runNetNewStaging);
      await step.sendEvent('emit-completion', {
        name: 'app/discovery.sweep.completed',
        data: {
          mode: 'staged',
          dispatched: 0,
          netNewProposed: staged.proposed,
          netNewDiagnostics: staged.diagnostics,
          durationMs: Date.now() - startedAt,
        },
      });
      return {
        action: 'staged',
        mode: 'staged',
        dispatched: 0,
        netNewProposed: staged.proposed,
        netNewDiagnostics: staged.diagnostics,
      };
    }

    // === AMBIENT (cron) MODE — the paid pipeline ==============================

    // 0 — resolve the radar to scope candidate selection to. The cron leg carries no
    // event, so fall back: DISCOVERY_RADAR_ID → build default → sole radar.
    const radarId = await step.run('resolve-radar', async () => {
      if (event?.data?.radarId) return event.data.radarId;
      if (config.radarId) return config.radarId;
      const { config: appConfig } = await import('@/lib/config');
      if (appConfig.build.defaultRadarId) return appConfig.build.defaultRadarId;
      const { adminGetAllRadars } = await import('@/lib/radars-admin');
      const radars = await adminGetAllRadars();
      if (radars.length === 1) return radars[0].id;
      // No radar resolvable (zero, or 2+ with none configured). The selector will
      // topic-rank the WHOLE technologies collection — a real scope loss. Make it
      // loud so a misconfigured multi-radar instance isn't silently unscoped, and
      // surface the scope in the return/completion event below (never-mask rule).
      log.warn('discovery sweep could not resolve a radar — selection runs UNSCOPED over all technologies', {
        radarCount: radars.length,
        hint: 'set DISCOVERY_RADAR_ID or BUILD_DEFAULT_RADAR_ID to scope the cron sweep',
      });
      return '';
    });

    const netNew = await step.run('discover-net-new', runNetNewStaging);
    const netNewProposed = netNew.proposed;
    const netNewDiagnostics = netNew.diagnostics;

    // 2 — select interest-ranked candidates (over-fetched). Technology is radar-scoped;
    // useCase (secondary dimension) is the whole 'use-cases' collection ranked by
    // posterior + exploration-δ. Already-evaluated candidates are excluded by the
    // selector's evaluates-relation exclusion, so this won't re-dispatch in a loop.
    const candidates = await step.run('select-candidates', async () => {
      const { selectBenchmarkCandidates, selectDiscoveryEntities } =
        await import('@/lib/discovery/discovery-entity-selector');
      const techCandidates = await selectBenchmarkCandidates({
        userId,
        radarId: radarId || undefined,
        limit: config.maxDispatchPerCycle * OVERFETCH,
        focus,
      });
      const useCaseCandidates = await selectDiscoveryEntities({
        entityType: 'useCase',
        userId,
        limit: config.maxUseCaseDispatchPerCycle * OVERFETCH,
        focus,
      });
      return [...techCandidates, ...useCaseCandidates];
    });
    if (!candidates || candidates.length === 0) {
      await step.sendEvent('emit-no-candidates', {
        name: 'app/discovery.sweep.completed',
        data: { dispatched: 0, netNewProposed, netNewDiagnostics, durationMs: Date.now() - startedAt },
      });
      return { action: 'no-candidates', dispatched: 0, netNewProposed, netNewDiagnostics };
    }

    // 3 — PINNED containment pipeline (fail-open). Order is the contract:
    // source-cap → diversity-check → dedup → quota/MMR → truncate.
    const totalLimit = config.maxDispatchPerCycle + config.maxUseCaseDispatchPerCycle;
    const { contained, collapsed, degraded } = await step.run('apply-containment', async () => {
      try {
        const { applySourceRotationCap, checkSourceDiversity } = await import('@/lib/discovery/source-diversity');
        const { dedupeBeforeTriage } = await import('@/lib/discovery/discovery-dedup');
        const { applyQuotasAndMMR } = await import('@/lib/discovery/diversity-quotas');

        // Contain each dimension against its OWN budget. Mixing both into one pool with a
        // shared limit + per-type share cap STARVES the primary (technology) dimension —
        // floor(limit · maxEntityTypeShare) caps each type to ~1, so a single useCase
        // candidate would halve technology from maxDispatchPerCycle to 1. Per-dimension
        // containment keeps each pool single-type → applyQuotasAndMMR's single-type bypass
        // applies → each dimension gets its full budget.
        const containDimension = (pool: typeof candidates, limit: number) => {
          if (pool.length === 0 || limit <= 0) return { kept: [] as typeof candidates, collapsed: 0 };
          let p = applySourceRotationCap(pool, config.maxSourceShare);
          const diversity = checkSourceDiversity(
            p.map((c) => c.source),
            config.maxSourceShare
          );
          if (!diversity.ok) {
            log.warn('source diversity escalation', {
              dominantSource: diversity.dominantSource,
              share: diversity.dominantShare,
            });
          }
          const dedup = dedupeBeforeTriage(p);
          p = applyQuotasAndMMR(dedup.kept, {
            perDimensionQuota: 1,
            maxEntityTypeShare: config.maxEntityTypeShare,
            mmrLambda: config.mmrLambda,
            limit,
          });
          return { kept: p, collapsed: dedup.collapsed.length };
        };

        const tech = containDimension(
          candidates.filter((c) => c.entityType === 'technology'),
          config.maxDispatchPerCycle
        );
        const useCase = containDimension(
          candidates.filter((c) => c.entityType !== 'technology'),
          config.maxUseCaseDispatchPerCycle
        );
        return {
          contained: [...tech.kept, ...useCase.kept],
          collapsed: tech.collapsed + useCase.collapsed,
          degraded: false,
        };
      } catch (error) {
        // Fail-open: a containment failure must never kill the sweep — but it
        // bypasses ALL bias controls for this cycle, so it is an ERROR (not a warn)
        // and the `degraded` flag is propagated to the completion event so a
        // degraded cycle is distinguishable from a healthy one.
        log.error(
          'containment pipeline failed — dispatching UN-CONTAINED (bias controls bypassed)',
          error instanceof Error ? error : new Error(String(error))
        );
        return { contained: candidates.slice(0, totalLimit), collapsed: 0, degraded: true };
      }
    });

    // 4 — dispatch each survivor. The inner per-candidate try/catch keeps this step
    // NON-THROWING, so Inngest's `retries: 1` can never re-run it and double-dispatch.
    const dispatched = await step.run('dispatch-evaluations', async () => {
      const { dispatchBenchmarkEvaluation } = await import('@/lib/discovery/discovery-dispatch');
      let count = 0;
      for (const c of contained) {
        try {
          await dispatchBenchmarkEvaluation(c.entityId, userId, c.entityType);
          count += 1;
        } catch (error) {
          log.warn('dispatch failed for candidate', {
            entityId: c.entityId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // A cycle with survivors but ZERO dispatches means the dispatch path is broken
      // — distinct from a legitimately empty cycle; surface it loudly.
      if (contained.length > 0 && count === 0) {
        log.error(
          'discovery sweep dispatched NOTHING despite candidates — dispatch path may be broken',
          new Error('all dispatches failed'),
          { attempted: contained.length }
        );
      }
      return count;
    });

    // scope echoes the resolved radar so an UNSCOPED cycle (radarId === '') is
    // distinguishable from a radar-scoped one at the observability layer.
    const scope = radarId ? 'radar' : 'unscoped';
    await step.sendEvent('emit-completion', {
      name: 'app/discovery.sweep.completed',
      data: {
        mode: 'ambient',
        dispatched,
        attempted: contained.length,
        netNewProposed,
        netNewDiagnostics,
        degraded,
        radarId: radarId || null,
        scope,
        durationMs: Math.max(0, (await captureDurableInstantMs(step, 'capture-discovery-sweep-end')) - startedAt),
      },
    });
    return {
      action: 'dispatched',
      mode: 'ambient',
      dispatched,
      attempted: contained.length,
      netNewProposed,
      netNewDiagnostics,
      selected: candidates.length,
      collapsed,
      degraded,
      radarId: radarId || null,
      scope,
    };
  }
);

interface SweepStep {
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  sendEvent(name: string, payload: unknown): Promise<unknown>;
}
