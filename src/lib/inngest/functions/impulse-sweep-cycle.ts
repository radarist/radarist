/**
 * @file lib/inngest/functions/impulse-sweep-cycle.ts
 * @description Inngest cron function that runs the Impulse SENSE-DECIDE-ACT-REFLECT cycle.
 *
 * Runs hourly to discover data quality gaps (orphan entities, stale data,
 * missing descriptions), route work to appropriate agents, spawn agent
 * missions, and record observations for proactive intelligence.
 *
 * Phases:
 * - SENSE: Query graph for data gaps via executeFindDataGaps
 * - DECIDE: Classify gaps and plan missions (linker for orphans, scout for stale/missing)
 * - ACT: Create missions and fire Inngest events for execution
 * - REFLECT: Record an AgentObservation in Neo4j for insight detection
 *
 * @phase Impulse v0.2 -- Phase 4: Sweep Cycle
 * @author Radarist Team
 * @created 2026-02-23
 */

import { inngest } from '../client';
import { captureDurableInstantMs } from '../durable-duration';
import { declareDomainOutcome } from '../domain-outcome';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { SYSTEM_SWEEP_PRINCIPAL } from '@/lib/system-principals';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import type { DataGap } from '@/lib/ai/tools/analytics-tools';
import type { AgentRunStatus, AgentRunSweepStats } from '@/lib/schemas/agent-run';

const log = createLogger('inngest/sweep-cycle');

/**
 * Keep the run-level outcome aligned with the more specific insight outcome.
 *
 * OBS-004: this covers the sweep's OWN bookkeeping lane only. A sweep is also a
 * supervisor of paid child missions, and children settle minutes AFTER this row
 * is written — so the child lane is folded in later by
 * `resolveSweepStatusWithChildren` (see `refreshSweepChildAggregate`). Reading
 * only this lane is what let a cycle whose two paid linker children both failed
 * report `success` on the strength of a healthy REFLECT.
 */
export function resolveSweepAgentRunStatus(insightsStatus: AgentRunSweepStats['insightsStatus']): AgentRunStatus {
  if (insightsStatus === 'failed') return 'failure';
  if (insightsStatus === 'not-run') return 'skipped';
  return 'success';
}

/** Emit a sweep.phase event (best-effort, never throws). Carries the cycle's
 * sweepId so the event is attributable — live rows and the run-detail Event
 * Log both key on missionId/sweepId and drop anonymous events (ARUN-005). */
async function emitSweepPhase(sweepId: string, phase: string, data: Record<string, unknown> = {}): Promise<void> {
  try {
    const { emitAgentEvent } = await import('@/lib/agent-events');
    await emitAgentEvent({
      type: 'sweep.phase',
      userId: SYSTEM_SWEEP_PRINCIPAL,
      agentType: 'sweep-cycle',
      sweepId,
      data: { phase, ...data },
    });
  } catch {
    // Event emission must never break the sweep cycle
  }
}

/** Emit a sweep lifecycle event (agent.started / agent.completed) so the
 * /agents/runs live view opens a row for the cycle and closes it cleanly
 * (agent.completed also triggers the page's history refetch). Best-effort. */
async function emitSweepLifecycle(
  sweepId: string,
  type: 'agent.started' | 'agent.completed',
  data: Record<string, unknown>
): Promise<void> {
  try {
    const { emitAgentEvent } = await import('@/lib/agent-events');
    await emitAgentEvent({
      type,
      userId: SYSTEM_SWEEP_PRINCIPAL,
      agentType: 'sweep-cycle',
      sweepId,
      data,
    });
  } catch {
    // Event emission must never break the sweep cycle
  }
}

/**
 * Maximum missions to spawn per sweep cycle (operator-level env cap).
 *
 * Default 2 (one for actionable data gaps, one for verification rechecks).
 * Override via env `SWEEP_MAX_MISSIONS_PER_CYCLE`. The user-configured
 * `sweep.maxActionsPerSweep` on the system-config doc also applies — the
 * lower of the two wins (see `load-sweep-config` step).
 */
const MAX_MISSIONS_PER_SWEEP = (() => {
  const raw = process.env.SWEEP_MAX_MISSIONS_PER_CYCLE;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();

/**
 * Number of days after which a verified entity becomes eligible for
 * re-verification by Defense Minister. Override via env
 * `SWEEP_REVERIFICATION_AGE_DAYS`.
 */
const REVERIFICATION_AGE_DAYS = (() => {
  const raw = process.env.SWEEP_REVERIFICATION_AGE_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();

/** Maximum data gaps to request from the analytics tool */
const MAX_GAPS_TO_DISCOVER = 10;

/**
 * Cron schedule for the sweep cycle. Default `0 0,6,12,18 * * *` (every 6h
 * UTC at 00:00, 06:00, 12:00, 18:00). The sweep is pure Cypher + Firestore
 * (no Anthropic spend), but with 0/576 of last cycle's insights consumed
 * (per the C1–C4 audit), hourly cadence was producing no-op writes. Override
 * via env `SWEEP_CRON`. Inngest accepts standard cron syntax with an
 * optional `TZ=...` prefix.
 */
const SWEEP_CRON = process.env.SWEEP_CRON || 'TZ=UTC 0 0,6,12,18 * * *';

/**
 * Classify a gap into a routing category based on its issues array.
 *
 * The DataGap type from analytics-tools has an `issues` array of strings
 * rather than a single gapType. We inspect the issue text to determine
 * the best agent to handle it.
 */
function classifyGap(issues: string[]): 'orphan' | 'stale' | 'missing-description' | 'reverify' | 'unknown' {
  const joined = issues.join(' ').toLowerCase();
  // Re-verification check first — its issue text contains "stale" as a
  // substring of "(verifiedAt > 30 days ago)" but is semantically different
  // from data-staleness. Match the explicit reverification marker first.
  if (joined.includes('reverification') || joined.includes('re-verification')) {
    return 'reverify';
  }
  if (joined.includes('no relation') || joined.includes('orphan') || joined.includes('zero relation')) {
    return 'orphan';
  }
  if (joined.includes('stale') || joined.includes('not updated')) {
    return 'stale';
  }
  if (joined.includes('missing description') || joined.includes('no description')) {
    return 'missing-description';
  }
  return 'unknown';
}

/**
 * Impulse Sweep Cycle -- runs periodically to discover data gaps,
 * spawn agent missions, and produce proactive insights.
 *
 * SENSE: Query graph for opportunities (orphan entities, stale data)
 * DECIDE: Route work to appropriate agents
 * ACT: Spawn agent missions via Inngest events
 * REFLECT: Record observations and generate insights
 */
export const impulseSweepCycle = inngest.createFunction(
  {
    id: 'impulse-sweep-cycle',
    name: 'Impulse Sweep Cycle',
    retries: 1,
    concurrency: { limit: 1 },
  },
  // Two triggers: scheduled cron (auto, 6-hourly default per SWEEP_CRON) + manual event.
  // The manual event leg is a manual ops hook — no in-app sender; trigger via
  // Inngest dev UI / API to force a sweep outside the scheduled cadence.
  [{ cron: SWEEP_CRON }, { event: 'app/sweep.manual.requested' }],
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('impulse-sweep-cycle');
    // OBS-004: the cycle's start instant must be DURABLE. `Date.now()` in the
    // handler body is re-initialised on every one of Inngest's per-step HTTP
    // requests, so `Date.now() - sweepCycleStart` measures only the final
    // invocation slice. Same bug class as OBS-006.
    const sweepStartedAtMs = await captureDurableInstantMs(step, 'capture-sweep-start');
    // Memoized so replays keep the same id — every event and the summary
    // AgentRun of this cycle share it (ARUN-005 attribution).
    const sweepId = await step.run('mint-sweep-id', () => `sweep-${Date.now()}`);
    log.info('Starting sweep cycle', { sweepId });
    await emitSweepLifecycle(sweepId, 'agent.started', {
      prompt: 'Autonomous sweep cycle: SENSE → DECIDE → ACT → REFLECT',
    });

    // -----------------------------------------------------------------------
    // Load sweep config live from Firestore (Settings → Agent Config panel).
    // Read via the admin SDK inside step.run to preserve worker isolation —
    // `@/lib/system-config` imports the firebase client SDK transitively,
    // which hangs server-side (same bug class as the fetch-signals fix).
    // -----------------------------------------------------------------------
    const sweepConfig = await step.run('load-sweep-config', async () => {
      try {
        const { db: adminDb } = await import('@/lib/firebase-admin');
        const snap = await adminDb.collection('system-config').doc('global').get();
        return resolveBackgroundAutomationPolicy(snap.exists ? snap.data() : undefined);
      } catch (error) {
        log.error('Failed to load sweep config; background automation remains paused', new Error(String(error)));
        return resolveBackgroundAutomationPolicy(undefined);
      }
    });

    if (!sweepConfig.impulseSweepEnabled) {
      log.info('Sweep cycle disabled via system-config (Settings → Agent Config) — skipping this run');
      await emitSweepPhase(sweepId, 'COMPLETE', { action: 'disabled' });
      await emitSweepLifecycle(sweepId, 'agent.completed', { action: 'disabled' });
      return { phase: 'config', action: 'disabled', missionsSpawned: 0 };
    }

    // Effective per-cycle action cap: the lower of the operator env cap
    // (SWEEP_MAX_MISSIONS_PER_CYCLE) and the user-configured value wins.
    const maxActionsPerSweep = Math.min(MAX_MISSIONS_PER_SWEEP, sweepConfig.maxActionsPerSweep);

    await emitSweepPhase(sweepId, 'SENSE', { status: 'starting' });

    // -----------------------------------------------------------------------
    // Create the required Episode before SENSE so every later graph write has
    // one durable lifecycle owner. Failure escapes into the configured retry.
    // -----------------------------------------------------------------------
    const episodeId = await step.run('create-sweep-episode', async () => {
      const { createEpisode } = await import('@/lib/graph/episodes');
      const episode = await createEpisode({
        agentName: 'sweep-cycle',
        missionId: sweepId,
        userId: SYSTEM_SWEEP_PRINCIPAL,
        summary: 'Automated sweep cycle: SENSE-DECIDE-ACT-REFLECT',
      });
      return episode.id;
    });

    const completeSweepEpisode = async (summary: string): Promise<void> => {
      await step.run('complete-sweep-episode', async () => {
        const { completeEpisode } = await import('@/lib/graph/episodes');
        await completeEpisode(episodeId, summary);
      });
    };

    /**
     * Persist the one durable summary row for every enabled sweep outcome.
     * Keeping all exits behind this boundary prevents early successful runs
     * from disappearing from operator history while the full REFLECT path
     * records richer counters. The shared step id is safe because every
     * branch is determined by memoized preceding steps and only one branch
     * can execute in a run.
     */
    const writeSweepAgentRun = async (
      action: string,
      sweepStats: AgentRunSweepStats,
      dispatchedChildMissionIds: readonly string[] = []
    ): Promise<void> => {
      // OBS-004: memoized terminal instant, so the recorded elapsed time is the
      // real cycle wall time across every step boundary and replay.
      const sweepEndedAtMs = await captureDurableInstantMs(step, 'capture-sweep-end');
      await step.run('write-sweep-agent-run', async () => {
        try {
          const { createAgentRun } = await import('@/lib/agent-runs');
          const { dispatchOnlySweepChildAggregate, resolveSweepStatusWithChildren } =
            await import('@/lib/sweep-child-accounting');

          // Children are dispatched fire-and-forget and outlive this cycle, so a
          // fast child can already have settled before this row exists. Reading
          // the settlement collection here — the SAME source a later refresh uses
          // — means an early settlement is folded in rather than dropped.
          //
          // Read failure must NOT cost us the summary row: fall back to the
          // dispatch-only aggregate, which reports the known dispatch count with
          // `childrenStatus: 'pending'`. A later settlement refresh converges it.
          let children = dispatchOnlySweepChildAggregate(dispatchedChildMissionIds.length);
          let truncated = false;
          try {
            const { computeSweepChildAggregate } = await import('@/lib/sweep-child-accounting-admin');
            const { truncated: readTruncated, ...computed } = await computeSweepChildAggregate(
              sweepId,
              dispatchedChildMissionIds.length
            );
            truncated = readTruncated;
            children = computed;
          } catch (aggregateError) {
            log.warn('Could not read sweep child settlements; recording the dispatch-only aggregate', {
              sweepId,
              error: aggregateError instanceof Error ? aggregateError.message : String(aggregateError),
            });
          }
          const statsWithChildren: AgentRunSweepStats = { ...sweepStats, children };

          await createAgentRun({
            userId: SYSTEM_SWEEP_PRINCIPAL,
            agentName: 'sweep-cycle',
            action,
            status: resolveSweepStatusWithChildren({ insightsStatus: sweepStats.insightsStatus, children }),
            sweepId,
            tokenUsage: { input: children.tokensIn, output: children.tokensOut },
            // The sweep's own provider spend is genuinely nil; this is its
            // children's KNOWN spend, which previously appeared nowhere at all.
            costUsd: children.costUsd,
            ...(children.costUnavailableChildren > 0 ? { costState: 'estimated' as const } : {}),
            duration: Math.max(0, sweepEndedAtMs - sweepStartedAtMs),
            sweepStats: statsWithChildren,
          });
          if (truncated) {
            log.warn('Sweep child settlements were truncated for this cycle', { sweepId });
          }
        } catch (error) {
          log.warn('Failed to write sweep AgentRun record', { error: String(error) });
        }
      });
    };

    type WatchedInsightReflection = {
      status: 'ok' | 'failed';
      users: number;
      processed: number;
      failures: number;
      observed: number;
      insights: number;
      narrative: number;
    };

    /**
     * Run the user-relevance part of REFLECT independently from data-gap work.
     * A healthy graph can have no repair gaps while an entity the user viewed
     * has changed; coupling these paths made that clean-workspace case exit
     * before its first insight could be created. Early exits use the
     * deterministic watched-update lane only (no model/research spend); full
     * cycles additionally run narrative and stale-report recommendations.
     */
    const reflectWatchedEntityInsights = async (includeNarrative: boolean): Promise<WatchedInsightReflection> =>
      step.run('reflect-watched-entity-insights', async () => {
        try {
          const { observeWatchedEntityUpdates, detectInsightsForUser, generateNarrativeInsights } =
            await import('@/lib/graph/proactive-insights');
          const { getActiveUserIds } = await import('@/lib/graph/session-memory');
          const userIds = await getActiveUserIds();
          let observed = 0;
          let insights = 0;
          let narrative = 0;
          let processed = 0;
          let failures = 0;

          for (const uid of userIds) {
            try {
              observed += await observeWatchedEntityUpdates(uid);
            } catch (err) {
              failures += 1;
              log.warn('[REFLECT] watched-entity OBSERVE failed', {
                userId: uid,
                phase: 'observe',
                error: String(err),
              });
              continue;
            }
            processed += 1;
            try {
              insights += (await detectInsightsForUser(uid)).insightsCreated;
            } catch (err) {
              failures += 1;
              log.warn('[REFLECT] watched-entity DETECT failed', {
                userId: uid,
                phase: 'detect',
                error: String(err),
              });
            }

            if (includeNarrative) {
              try {
                narrative += await generateNarrativeInsights(uid, { limit: 2, recommendReports: true });
              } catch (err) {
                failures += 1;
                log.warn('[REFLECT] NARRATIVE insight generation failed', {
                  userId: uid,
                  phase: 'narrative',
                  error: String(err),
                });
              }
              try {
                const { recommendStaleReportUpdates } = await import('@/lib/discovery/recommend-stale-reports');
                await recommendStaleReportUpdates(uid);
              } catch (err) {
                log.warn('[REFLECT] stale-report recommendation failed', {
                  userId: uid,
                  phase: 'stale-reports',
                  error: String(err),
                });
              }
            }
          }

          log.info('[REFLECT] watched-entity insights', {
            users: userIds.length,
            processed,
            failures,
            observed,
            insights,
            narrative,
            includeNarrative,
          });
          return { status: 'ok' as const, users: userIds.length, processed, failures, observed, insights, narrative };
        } catch (error) {
          log.error(
            '[REFLECT] watched-entity insight step failed — feature produced nothing this cycle',
            error instanceof Error ? error : new Error(String(error))
          );
          return {
            status: 'failed' as const,
            users: 0,
            processed: 0,
            failures: 0,
            observed: 0,
            insights: 0,
            narrative: 0,
          };
        }
      });

    const summarizeInsightReflection = (reflection: WatchedInsightReflection) => {
      const watchedCount = reflection.insights;
      const narrativeCount = reflection.narrative ?? 0;
      const insightsTotal = watchedCount + narrativeCount;
      const insightFailures = reflection.failures ?? 0;
      const insightsStatus: 'ok' | 'quiet' | 'failed' =
        reflection.status === 'failed' || (insightsTotal === 0 && insightFailures > 0)
          ? 'failed'
          : insightsTotal > 0
            ? 'ok'
            : 'quiet';
      const summary =
        insightsStatus === 'failed'
          ? 'insight generation failed'
          : insightsStatus === 'quiet'
            ? 'no new insights'
            : `${insightsTotal} insights surfaced (${watchedCount} watched, ${narrativeCount} narrative)`;
      return { watchedCount, narrativeCount, insightsTotal, insightsStatus, summary };
    };

    // -----------------------------------------------------------------------
    // SENSE: Discover data gaps
    // -----------------------------------------------------------------------
    const gaps = await step.run('sense-discover-gaps', async () => {
      const analyticsTools = await import('@/lib/ai/tools/analytics-tools').catch(() => null);
      if (!analyticsTools) {
        log.warn('SENSE: analytics-tools module unavailable');
        return [];
      }

      // Data-gaps pass (orphans, stale, missing-description).
      let dataGaps: DataGap[] = [];
      if (typeof analyticsTools.executeFindDataGaps === 'function') {
        try {
          const result = await analyticsTools.executeFindDataGaps({ limit: MAX_GAPS_TO_DISCOVER });
          dataGaps = result.gaps;
        } catch (err) {
          log.warn('SENSE: data-gap discovery failed', { error: String(err) });
        }
      }

      // Re-verification pass (entities with stale verifiedAt).
      let reverifyGaps: DataGap[] = [];
      if (typeof analyticsTools.findEntitiesNeedingReverification === 'function') {
        try {
          const result = await analyticsTools.findEntitiesNeedingReverification(
            REVERIFICATION_AGE_DAYS,
            MAX_GAPS_TO_DISCOVER
          );
          reverifyGaps = result.gaps;
        } catch (err) {
          log.warn('SENSE: reverification-gap discovery failed', { error: String(err) });
        }
      }

      log.info('SENSE: discovered gaps', {
        dataGaps: dataGaps.length,
        reverifyGaps: reverifyGaps.length,
      });
      // Reverification gaps go FIRST so the per-cycle cap reaches at least
      // one verification before exhausting on expensive mission dispatch.
      // Verifications cost ~$0.001 (one Gemini grounded call); missions
      // cost ~$0.50–$1.50 (full agent run). Filling the cheap slot first
      // keeps the platform's verifiedAt timestamps fresh even when data
      // gaps dominate the gap pool.
      return [...reverifyGaps, ...dataGaps];
    });

    if (gaps.length === 0) {
      log.info('No data gaps found; running user-relevance reflection');
      await emitSweepPhase(sweepId, 'REFLECT', { action: 'watched-entity-updates', gapsFound: 0 });
      const reflection = await reflectWatchedEntityInsights(false);
      const insightSummary = summarizeInsightReflection(reflection);
      await completeSweepEpisode('Sweep complete: no gaps found');
      await writeSweepAgentRun(`Sweep: no gaps found, ${insightSummary.summary}`, {
        gapsFound: 0,
        missionsSpawned: 0,
        usersProcessed: reflection.processed ?? reflection.users,
        observationsWritten: reflection.observed,
        watchedInsights: insightSummary.watchedCount,
        narrativeInsights: insightSummary.narrativeCount,
        insightsTotal: insightSummary.insightsTotal,
        insightsStatus: insightSummary.insightsStatus,
      });
      await emitSweepPhase(sweepId, 'COMPLETE', { action: 'no-gaps' });
      await emitSweepLifecycle(sweepId, 'agent.completed', { action: 'no-gaps' });
      return {
        phase: 'sense',
        action: 'no-gaps',
        missionsSpawned: 0,
        insightsSurfaced: insightSummary.watchedCount,
        narrativeInsights: insightSummary.narrativeCount,
        insightsTotal: insightSummary.insightsTotal,
        observationsWritten: reflection.observed,
        insightsStatus: insightSummary.insightsStatus,
      };
    }

    await emitSweepPhase(sweepId, 'DECIDE', { gapsFound: gaps.length });

    // -----------------------------------------------------------------------
    // DECIDE: Route to agents based on gap classification
    // -----------------------------------------------------------------------
    type PlannedMission = {
      kind: 'mission';
      prompt: string;
      agent: string;
      entityName: string;
      entityType: string;
    };
    type PlannedVerification = {
      kind: 'verify';
      entityId: string;
      entityName: string;
      entityType: string;
    };
    type PlannedAction = PlannedMission | PlannedVerification;

    const planned: PlannedAction[] = await step.run('decide-route-tasks', async () => {
      const items: PlannedAction[] = [];

      for (const gap of gaps.slice(0, maxActionsPerSweep)) {
        const category = classifyGap(gap.issues);

        if (category === 'reverify') {
          items.push({
            kind: 'verify',
            entityId: gap.entityId,
            entityName: gap.entityName,
            entityType: gap.entityType,
          });
        } else if (category === 'orphan') {
          items.push({
            kind: 'mission',
            prompt: `Research and find relationships for: ${gap.entityName} (${gap.entityType})`,
            agent: 'linker',
            entityName: gap.entityName,
            entityType: gap.entityType,
          });
        } else if (category === 'stale') {
          items.push({
            kind: 'mission',
            prompt: `Update information about: ${gap.entityName} (${gap.entityType})`,
            agent: 'scout',
            entityName: gap.entityName,
            entityType: gap.entityType,
          });
        } else if (category === 'missing-description') {
          items.push({
            kind: 'mission',
            prompt: `Research and provide a description for: ${gap.entityName} (${gap.entityType})`,
            agent: 'scout',
            entityName: gap.entityName,
            entityType: gap.entityType,
          });
        }
        // 'unknown' gaps are skipped -- no agent can handle them meaningfully
      }

      log.info('DECIDE: planned items', {
        total: items.length,
        missions: items.filter((i) => i.kind === 'mission').length,
        verifications: items.filter((i) => i.kind === 'verify').length,
      });
      return items;
    });

    // Backwards-compat alias for the rest of the function (which expects
    // `missions` containing dispatchable mission items only).
    const missions = planned.filter((p): p is PlannedMission => p.kind === 'mission');
    const verifications = planned.filter((p): p is PlannedVerification => p.kind === 'verify');

    if (missions.length === 0 && verifications.length === 0) {
      log.info('No actionable data gaps; running user-relevance reflection');
      await emitSweepPhase(sweepId, 'REFLECT', {
        action: 'watched-entity-updates',
        gapsFound: gaps.length,
      });
      const reflection = await reflectWatchedEntityInsights(false);
      const insightSummary = summarizeInsightReflection(reflection);
      await completeSweepEpisode(`Sweep complete: ${gaps.length} non-actionable gaps found`);
      await writeSweepAgentRun(`Sweep: ${gaps.length} non-actionable gaps found, ${insightSummary.summary}`, {
        gapsFound: gaps.length,
        missionsSpawned: 0,
        usersProcessed: reflection.processed ?? reflection.users,
        observationsWritten: reflection.observed,
        watchedInsights: insightSummary.watchedCount,
        narrativeInsights: insightSummary.narrativeCount,
        insightsTotal: insightSummary.insightsTotal,
        insightsStatus: insightSummary.insightsStatus,
      });
      await emitSweepPhase(sweepId, 'COMPLETE', { action: 'no-actionable-gaps', gapsFound: gaps.length });
      await emitSweepLifecycle(sweepId, 'agent.completed', { action: 'no-actionable-gaps' });
      return {
        phase: 'decide',
        action: 'no-actionable-gaps',
        gapsFound: gaps.length,
        missionsSpawned: 0,
        insightsSurfaced: insightSummary.watchedCount,
        narrativeInsights: insightSummary.narrativeCount,
        insightsTotal: insightSummary.insightsTotal,
        observationsWritten: reflection.observed,
        insightsStatus: insightSummary.insightsStatus,
      };
    }

    await emitSweepPhase(sweepId, 'ACT', {
      missionsPlanned: missions.length,
      verificationsPlanned: verifications.length,
    });

    // -----------------------------------------------------------------------
    // ACT (verifications): fire entity-verification events for stale-verified
    // entities. These don't dispatch new agent missions — they hit the
    // Defense Minister verify-entity handler directly.
    // -----------------------------------------------------------------------
    // Gated by DEFENSE_MINISTER_ENABLED env (default: disabled when missing).
    if (verifications.length > 0 && process.env.DEFENSE_MINISTER_ENABLED === 'true') {
      await step.run('act-fire-verifications', async () => {
        let firedCount = 0;
        for (const v of verifications) {
          try {
            await inngest.send({
              name: 'app/entity.verification.requested',
              data: {
                entityId: v.entityId,
                entityType: v.entityType,
              },
            });
            firedCount++;
          } catch (err) {
            log.warn('Failed to fire verification event', {
              entityId: v.entityId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        log.info('ACT: fired verification events', { count: firedCount });
        return firedCount;
      });
    } else if (verifications.length > 0) {
      log.info('ACT: verifications skipped — DEFENSE_MINISTER_ENABLED not set to "true"', {
        wouldHaveFired: verifications.length,
      });
    }

    // -----------------------------------------------------------------------
    // ACT: Spawn missions (skip if server already has running missions)
    // -----------------------------------------------------------------------
    // OBS-004: returns the dispatched mission IDs, not just a count. The IDs are
    // what make child accounting possible — a count can only ever say how many
    // missions were FIRED, never how they ended, what they cost, or what they
    // produced. Returned (not accumulated in a closure) because Inngest memoizes
    // a step by its RETURN VALUE: closure mutations vanish on replay.
    const spawnResult = await step.run('act-spawn-missions', async () => {
      const { listMissions } = await import('@/lib/missions');
      const { dispatchMissionWithGate } = await import('@/lib/mission-research-gate');

      // Check if there are already running missions to avoid overloading
      // the server (each orchestrator loads ~3764 modules)
      try {
        // listMissions returns the system-principal UNION (ARUN-005) — filter
        // back to sweep-owned so discovery evaluations can't trip this gate.
        const existing = await listMissions(SYSTEM_SWEEP_PRINCIPAL);
        const runningCount = existing.filter(
          (m) => m.userId === SYSTEM_SWEEP_PRINCIPAL && (m.status === 'running' || m.status === 'pending')
        ).length;
        if (runningCount >= 2) {
          log.info('ACT: skipping — already have running missions', { runningCount });
          return { missionIds: [] as string[] };
        }
      } catch {
        // If we can't check, proceed with caution (spawn at most 1)
        log.warn('ACT: could not check running missions, will limit to 1');
      }

      // Use a system user ID for sweep-initiated missions
      const SYSTEM_USER_ID = SYSTEM_SWEEP_PRINCIPAL;
      const missionIds: string[] = [];

      for (const m of missions) {
        try {
          const { dispatched } = await dispatchMissionWithGate(SYSTEM_USER_ID, {
            agent: m.agent,
            prompt: m.prompt,
            skipResearchGate: true, // sweep does its own research in SENSE phase
            // OBS-004: stamp the sweep link at CREATE. The mission runner reads it
            // at terminal time, long after this cycle has returned — there is no
            // later moment at which the child could learn who dispatched it.
            sweepId,
          });
          const mission = dispatched[0];

          await inngest.send({
            name: 'app/mission.run.requested' as const,
            data: {
              missionId: mission.id,
              userId: SYSTEM_USER_ID,
              // MISSION-011: dispatch the PERSISTED prompt, never the planned
              // one. `createMission` appends the deliverable contract for
              // proposal agents (linker); sending `m.prompt` here would run the
              // agent on a prompt the stored mission — and the L1 gate that
              // reads it — never saw.
              prompt: mission.prompt,
              agent: mission.agent,
            },
          });

          missionIds.push(mission.id);
        } catch (error) {
          log.error('Failed to spawn mission', error instanceof Error ? error : new Error(String(error)), {
            prompt: m.prompt,
          });
        }
      }

      log.info('ACT: spawned missions', { count: missionIds.length });
      return { missionIds };
    });
    // A sweep resumed across a deploy can replay a memoized pre-OBS-004 step
    // result (a bare number), so the shape is coalesced defensively.
    const spawnedMissionIds: string[] = Array.isArray(spawnResult?.missionIds) ? spawnResult.missionIds : [];
    const spawned = typeof spawnResult === 'number' ? spawnResult : spawnedMissionIds.length;

    await emitSweepPhase(sweepId, 'REFLECT', { missionsSpawned: spawned });

    // -----------------------------------------------------------------------
    // REFLECT: Record one observation per gap, each anchored to its real
    // entity. Previously we created a single sweep meta-observation linked
    // to gaps[0] — which then made every dot-connected ProactiveInsight
    // claim "AI Agents connects to X" regardless of what the actual gap
    // was about, because gaps[0] was the only anchor. The 2026-05-12 fix
    // creates N observations (one per gap), so each downstream insight is
    // about the real entity the gap concerned.
    //
    // Cardinality: a sweep typically finds 5-20 gaps; N observations is
    // cheap, and each one carries a deterministic entity link.
    // -----------------------------------------------------------------------
    const observationResults: { ids: string[]; skipped: number } = { ids: [], skipped: 0 };
    const { createSweepObservationId } = await import('@/lib/graph/observation-identity');
    for (const [gapIndex, gap] of gaps.entries()) {
      const observationId = createSweepObservationId({ sweepId, gapIndex, entityId: gap.entityId });
      const writeResult = await step.run(
        `reflect-record-observation-${gapIndex}-${observationId.slice(-12)}`,
        async () => {
          const { recordSweepObservation } = await import('@/lib/graph/sweep-observations');
          const category = classifyGap(gap.issues);
          return recordSweepObservation({
            sweepId,
            episodeId,
            gapIndex,
            title: `Sweep: ${gap.entityName} (${category})`,
            summary: `Sweep cycle flagged ${gap.entityName} (${gap.entityType}): ${gap.issues.join('; ')}`,
            confidence: 0.8,
            entityId: gap.entityId,
            entityName: gap.entityName,
            entityType: gap.entityType,
            timestamp: new Date().toISOString(),
          });
        }
      );
      if (writeResult.status === 'recorded') {
        observationResults.ids.push(writeResult.observation.id);
      } else {
        observationResults.skipped++;
        log.warn('REFLECT: sweep observation skipped without graph mutation', {
          entityId: gap.entityId,
          reason: writeResult.reason,
        });
      }
    }
    log.info('REFLECT: observations converged', {
      count: observationResults.ids.length,
      skipped: observationResults.skipped,
    });

    // -----------------------------------------------------------------------
    // REFLECT: Persist CuriosityGaps for failed work items
    // -----------------------------------------------------------------------
    await step.run('reflect-persist-curiosity-gaps', async () => {
      try {
        const { recordCuriosityGap } = await import('@/lib/graph/curiosity-gaps');
        // Gaps that were classified as 'unknown' could not be routed to any agent
        const failedItems = gaps
          .filter((g) => classifyGap(g.issues) === 'unknown')
          .map((g) => ({
            entityId: g.entityId,
            entityType: g.entityType,
            entityName: g.entityName,
            type: 'missing_data',
            error: g.issues.join('; '),
          }));
        let gapsCreated = 0;
        for (const item of failedItems) {
          try {
            await recordCuriosityGap({
              question: `Failed to process: ${item.entityName} (${item.type})${item.error ? ' — ' + item.error : ''}`,
              entityIds: [item.entityId],
              agentName: 'sweep-cycle',
              missionId: sweepId,
              priority: 'medium',
              gapType: item.type === 'missing_relation' ? 'missing_relation' : 'missing_data',
            });
            gapsCreated++;
          } catch {
            /* individual gap failure is non-blocking */
          }
        }
        log.info('REFLECT: curiosity gaps persisted', { gapsCreated });
        return { gapsCreated };
      } catch (error) {
        log.warn('REFLECT: failed to persist curiosity gaps', { error: String(error) });
        return { gapsCreated: 0 };
      }
    });

    // -----------------------------------------------------------------------
    // REFLECT: Cross-session dot-connecting for proactive insights.
    // One dot-connect run per (observation × active user). With N
    // per-gap observations replacing the previous single meta-observation,
    // each ProactiveInsight is now anchored to the real gap entity rather
    // than to gaps[0].
    // -----------------------------------------------------------------------
    if (observationResults.ids.length > 0) {
      await step.run('reflect-connect-dots', async () => {
        try {
          const { connectDots } = await import('@/lib/graph/dot-connector');
          const { getActiveUserIds } = await import('@/lib/graph/session-memory');
          const userIds = await getActiveUserIds();
          for (const userId of userIds) {
            for (const observationId of observationResults.ids) {
              await connectDots(observationId, userId).catch((err) =>
                log.warn('[REFLECT] dot-connect failed', { userId, observationId, error: String(err) })
              );
            }
          }
        } catch (error) {
          log.warn('[REFLECT] dot-connect step failed', { error: String(error) });
        }
      });
    }

    // -----------------------------------------------------------------------
    // REFLECT: Surface "an entity you explored has new info" insights.
    // -----------------------------------------------------------------------
    // Re-enables same-entity surfacing that was disabled on 2026-05-13 — but
    // SCOPED to avoid the original noise. The 2026-05-13 disable removed
    // `detectInsightsForUser` because it indiscriminately promoted EVERY
    // observation about an explored entity (incl. the sweep's own
    // "Sweep: X (stale)" bookkeeping) into a briefing card. The fix:
    //   1. observeWatchedEntityUpdates records the SIGNAL only — explored
    //      entities updated SINCE the user viewed them — as `interest-watch`
    //      observations (deduped per update).
    //   2. detectInsightsForUser surfaces those, de-noised against the
    //      sweep's own `sweep-cycle` observations (excluded in its query).
    // Per-user try/catch: one user's failure neither aborts the loop nor the
    // sweep, and a Neo4j failure surfaces as a logged warning (never a silent
    // "no insights").
    const watchedInsights = await reflectWatchedEntityInsights(true);

    // -----------------------------------------------------------------------
    // Complete the required Episode before publishing durable success.
    // -----------------------------------------------------------------------
    await completeSweepEpisode(`Sweep complete: ${gaps.length} gaps, ${spawned} missions spawned`);

    // Task 3.5: CuriosityGap → Mission Pipeline
    // Convert accumulated high-priority open gaps into Scout missions
    const gapMissions = await step.run('curiosity-gap-pipeline', async () => {
      try {
        const { getOpenGaps, resolveCuriosityGap } = await import('@/lib/graph/curiosity-gaps');
        const openGaps = await getOpenGaps(5); // Top 5 by priority
        const highPriorityGaps = openGaps.filter((g) => g.priority === 'high');

        const gapMissionIds: string[] = [];
        for (const gap of highPriorityGaps) {
          try {
            const { dispatchMissionWithGate } = await import('@/lib/mission-research-gate');
            const { dispatched } = await dispatchMissionWithGate(SYSTEM_SWEEP_PRINCIPAL, {
              agent: 'scout',
              prompt: `Investigate curiosity gap: ${gap.question}`,
              skipResearchGate: true, // sweep does its own research in SENSE phase
              // OBS-004: gap-pipeline children are the sweep's children too, and
              // they spend the same real money — they belong in the same accounting.
              sweepId,
            });
            const mission = dispatched[0];
            await inngest.send({
              name: 'app/mission.run.requested',
              data: {
                missionId: mission.id,
                userId: SYSTEM_SWEEP_PRINCIPAL,
                prompt: `Investigate and resolve this knowledge gap: ${gap.question}`,
                agent: 'scout',
              },
            });
            await resolveCuriosityGap(gap.id, `Auto-dispatched as mission ${mission.id}`);
            gapMissionIds.push(mission.id);
          } catch {
            /* individual gap mission failure is non-blocking */
          }
        }

        log.info('CuriosityGap pipeline', {
          openGaps: openGaps.length,
          highPriority: highPriorityGaps.length,
          missionsSpawned: gapMissionIds.length,
        });
        return { gapMissionsSpawned: gapMissionIds.length, gapMissionIds };
      } catch (error) {
        log.warn('CuriosityGap pipeline failed', { error: String(error) });
        return { gapMissionsSpawned: 0, gapMissionIds: [] as string[] };
      }
    });

    const totalMissions = spawned + (gapMissions?.gapMissionsSpawned ?? 0);
    // Every child this cycle dispatched, from both lanes. This is the DISPATCH
    // DENOMINATOR the child aggregate needs: without it, `settled` has nothing to
    // be complete against and a rollup over an empty set would read as success.
    const dispatchedChildMissionIds = [
      ...spawnedMissionIds,
      ...(Array.isArray(gapMissions?.gapMissionIds) ? gapMissions.gapMissionIds : []),
    ];
    // OBS-004 — durable honest counters. `narrative` is coalesced defensively:
    // a sweep resumed across a deploy can replay a memoized step result from
    // the pre-counter shape.
    const {
      watchedCount,
      narrativeCount,
      insightsTotal,
      insightsStatus,
      summary: insightsSummary,
    } = summarizeInsightReflection(watchedInsights);
    // Persist a terminal row only after every required memory step has completed.
    // Otherwise a permanently failed REFLECT retry would leave a false-success
    // durable row even though the live lifecycle never reached completion.
    await writeSweepAgentRun(
      `Sweep: ${gaps.length} gaps found, ${totalMissions} missions spawned, ${insightsSummary}`,
      {
        gapsFound: gaps.length,
        missionsSpawned: totalMissions,
        // Users that actually completed the OBSERVE stage — not merely
        // enumerated, which would overstate coverage on a failing cycle.
        usersProcessed: watchedInsights.processed ?? watchedInsights.users,
        observationsWritten: watchedInsights.observed,
        watchedInsights: watchedCount,
        narrativeInsights: narrativeCount,
        insightsTotal,
        insightsStatus,
      },
      dispatchedChildMissionIds
    );
    await emitSweepPhase(sweepId, 'COMPLETE', { gapsFound: gaps.length, missionsSpawned: totalMissions });
    // Close the live row only after REFLECT, Episode completion, and the final
    // curiosity-gap pipeline have reached their durable terminal state.
    await emitSweepLifecycle(sweepId, 'agent.completed', { missionsSpawned: totalMissions });
    log.info('Sweep cycle complete', { gaps: gaps.length, missions: totalMissions });
    // Surface the insight-production volume in the result so 'pipeline silently zero'
    // is detectable per-cycle (the missing signal the review flagged). insightsStatus
    // (OBS-004) is three-way: 'failed' (zeros untrustworthy) vs 'quiet' (healthy,
    // genuinely nothing) vs 'ok' (produced) — and narrative production is counted,
    // not dropped, so a narrative-only cycle never reads as zero.
    // OBS-001/OBS-004: declare the sweep's own business outcome. A cycle that
    // dispatched paid children has not yet delivered anything — its children have
    // not reported — so `partial` is the honest declaration until they do; a cycle
    // whose insight lane failed is a failure regardless.
    return declareDomainOutcome(
      {
        phase: 'complete',
        gapsFound: gaps.length,
        missionsSpawned: totalMissions,
        childrenDispatched: dispatchedChildMissionIds.length,
        insightsSurfaced: watchedCount,
        narrativeInsights: narrativeCount,
        insightsTotal,
        observationsWritten: watchedInsights.observed,
        insightsStatus,
      },
      insightsStatus === 'failed'
        ? { outcome: 'failed', reason: 'insight-pipeline-failed' }
        : dispatchedChildMissionIds.length > 0
          ? { outcome: 'partial', reason: 'children-pending' }
          : insightsStatus === 'ok'
            ? { outcome: 'success' }
            : { outcome: 'skipped', reason: `insights-${insightsStatus}` }
    );
  }
);
