/**
 * @file detect-emergence.ts
 * @description C5 — nightly edge-velocity emergence detection. Compares each
 * entity's recent vs. prior `t_observed` edge count (see `graph/emergence.ts`)
 * and records a best-effort AgentObservation for every entity whose activity
 * is accelerating. `agentType: 'emergence-detector'` flows into user
 * briefings via `detectInsightsForUser` — it is NOT the `'sweep-cycle'`
 * bookkeeping agentType that function filters out.
 *
 * Sparse-data caveat: on a freshly-seeded graph the "prior" window has zero
 * edges (clamped to 1 in the acceleration math), so every entity with any
 * recent edges looks infinitely "emergent". `minEdges` (default 3) and
 * `limit` (default 5) bound the blast radius until the graph has accumulated
 * enough history for the prior window to be a meaningful baseline. No new
 * env vars — all thresholds ride the event payload (see `InngestEvents` in
 * `../client.ts`).
 */
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/detect-emergence');

export const detectEmergenceJob = inngest.createFunction(
  {
    id: 'detect-emergence',
    name: 'Detect Emergence',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('detect-emergence failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  // Daily at 03:30 UTC + on-demand via event.
  [{ event: 'app/schedule.emergence.detect' }, { cron: 'TZ=UTC 30 3 * * *' }],
  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('detect-emergence');
    const startedAt = await step.run('record-start', async () => Date.now());
    const {
      windowDays,
      minEdges,
      accelerationFactor,
      limit,
      dryRun = false,
    } = (event?.data ?? {}) as {
      windowDays?: number;
      minEdges?: number;
      accelerationFactor?: number;
      limit?: number;
      dryRun?: boolean;
    };

    const findings = await step.run('detect-emergence', async () => {
      const { detectEmergence } = await import('@/lib/graph/emergence');
      return detectEmergence({ windowDays, minEdges, accelerationFactor, limit });
    });

    const observationsRecorded = await step.run('record-observations', async () => {
      if (dryRun || findings.length === 0) return 0;

      const { recordAgentObservation } = await import('@/lib/graph/proactive-insights');
      let recorded = 0;
      for (const finding of findings) {
        try {
          await recordAgentObservation({
            agentType: 'emergence-detector',
            observationType: 'pattern',
            title: `Emerging activity around ${finding.entityName}`,
            summary: `${finding.recentCount} new connections in the last window (${finding.acceleration.toFixed(
              1
            )}x acceleration vs. the prior window).`,
            // Confidence at the service boundary is 0-1 (the briefing UI renders it
            // x100). This module's selection formula is 0-100-flavored —
            // min(95, round(50 + 10*acceleration)) — so divide by 100 here to land
            // on the 0-1 scale every other recordAgentObservation caller uses.
            confidence: Math.min(0.95, (50 + 10 * finding.acceleration) / 100),
            entityId: finding.entityId,
            entityName: finding.entityName,
            entityType: finding.entityType,
            timestamp: new Date().toISOString(),
          });
          recorded += 1;
        } catch (perFindingError) {
          // One bad finding (e.g. an entity deleted between detection and
          // recording) must not lose the rest of the batch.
          log.warn('detect-emergence: failed to record observation for finding', {
            entityId: finding.entityId,
            error: perFindingError instanceof Error ? perFindingError.message : String(perFindingError),
          });
        }
      }
      return recorded;
    });

    const durationMs = Date.now() - startedAt;

    await step.run('emit-completion-event', async () => {
      await inngest.send({
        name: 'app/schedule.emergence.detect.completed',
        data: {
          findings: findings.length,
          observationsRecorded,
          durationMs,
        },
      });
    });

    log.info('detect-emergence complete', {
      findings: findings.length,
      observationsRecorded,
      durationMs,
      dryRun,
    });

    return {
      findings: findings.length,
      observationsRecorded,
      durationMs,
      dryRun,
    };
  }
);
