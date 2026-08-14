/**
 * @file run-evaluation-agent.ts
 * @description Inngest function to run the Evaluation Agent on-demand
 *
 * This function evaluates signals against strategic directives to determine
 * relevance, alignment, and overall value. It can be triggered manually or
 * automatically.
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

import { inngest } from '../client';
import { extractFailureEventData } from '../utils';
import { createLogger } from '@/lib/logger';
import { adminGetSignalById, adminUpdateSignal } from '@/lib/signals-admin';
import { scoreSignal } from '@/lib/signals/scorer';

const log = createLogger('inngest/run-evaluation-agent');

/**
 * Run Evaluation Agent
 *
 * Evaluates detected signals for relevance and strategic alignment.
 * Scores each signal and recommends approval/rejection.
 */
export const runEvaluationAgent = inngest.createFunction(
  {
    id: 'run-evaluation-agent',
    name: 'Run Evaluation Agent',
    retries: 2,

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const signalIds = extractFailureEventData<{ signalIds?: string[] }>(event.data).signalIds || [];
      log.error('Evaluation agent final failure', new Error(error.message), { signalCount: signalIds.length });

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/agent.evaluation.failed',
        data: {
          signalIds,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },
  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API to re-score signals.
  { event: 'app/agent.evaluation.triggered' },
  async ({ event }) => {
    // PERF-005: rely on the single stable `inngest-<runId>` job-runs record from
    // the tracking middleware. The manual observable-job writer added a
    // duplicate, manually-keyed row that stayed "running" forever on replay.
    const signalIds: string[] = event.data.signalIds ?? [];
    log.info('Evaluation agent started', { signalCount: signalIds.length });

    const settled = await Promise.allSettled(
      signalIds.map(async (signalId: string) => {
        const sig = await adminGetSignalById(signalId);
        if (!sig) {
          log.warn('[Evaluator] signal not found', { signalId });
          return null;
        }
        const score = scoreSignal(sig);
        await adminUpdateSignal(signalId, { trustScore: score });
        return { signalId, overall: score.overall };
      })
    );

    const results = settled.flatMap((r) => {
      if (r.status === 'fulfilled' && r.value) return [r.value];
      if (r.status === 'rejected') {
        log.warn('[Evaluator] scoreSignal failed', {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
      return [];
    });

    const result = { scored: results.length, results };
    log.info('Evaluation agent completed', {
      requestedSignalCount: signalIds.length,
      scoredSignalCount: results.length,
    });
    return result;
  }
);
