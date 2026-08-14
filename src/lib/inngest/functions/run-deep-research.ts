/**
 * @file lib/inngest/functions/run-deep-research.ts
 * @description Background job to run deep research on a technology
 *
 * This function is triggered when a user requests deep research and runs
 * in the background, allowing the user to navigate away from the page.
 *
 * **Execution Flow:**
 * 1. Receive technology.research.requested event with technology details
 * 2. Call the AI research generation service
 * 3. Save results to Firestore
 * 4. Trigger technology.updated event to refresh snapshots
 *
 * **Retry Strategy:**
 * - Max retries: 2 (AI calls can be expensive)
 * - Backoff: Exponential (1min, 5min)
 *
 * @author Radarist Team
 * @created 2026-01-12
 */

import { inngest } from '../client';
import { extractFailureEventData } from '../utils';
import { captureDurableInstantMs, deriveDurableTimingMs, parseDurableInstantMs } from '../durable-duration';
import { declareDomainOutcome } from '../domain-outcome';
import { deepResearchStructured } from '@/ai/flows/deep-research';
import { createLogger } from '@/lib/logger';
import {
  clearPendingSnapshotRefresh,
  completeDeepResearchAttempt,
  inspectResearchAttempt,
  recordPendingSnapshotRefresh,
  releaseResearchPending,
} from '@/lib/technology-research-admin';

const log = createLogger('inngest/run-deep-research');

function isSnapshotDebtPersistenceFailure(error: Error): boolean {
  // Inngest may serialize custom errors between the worker and onFailure, so
  // accept the stable name and the stable message prefix.
  return (
    error.name === 'PendingSnapshotRefreshPersistenceError' ||
    error.message.startsWith('Could not persist snapshot-refresh recovery debt')
  );
}

async function deliverDeepResearchHandoff(
  technologyId: string,
  attempt: number,
  updatedFields: string[]
): Promise<{ deferred: boolean }> {
  let dispatchError: unknown;
  let acknowledged = false;
  try {
    const accepted = await inngest.send({
      name: 'app/technology.updated',
      data: { technologyId, updatedFields },
    });
    acknowledged = Boolean(accepted?.ids?.length);
    if (!acknowledged) dispatchError = new Error('Inngest accepted no snapshot-refresh event');
  } catch (error) {
    dispatchError = error;
  }

  if (!acknowledged) {
    log.warn('Post-research snapshot refresh was not acknowledged; recording durable debt', {
      technologyId,
      error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
    });
    // This write is the immediate recovery anchor. If it fails, throw so the
    // function's bounded retry re-enters only this handoff phase.
    await recordPendingSnapshotRefresh(technologyId, attempt, dispatchError);
    return { deferred: true };
  }

  // A prior failed attempt may already have recorded debt. Clearing is
  // token-guarded; a failure leaves the marker for the cron drainer.
  await clearPendingSnapshotRefresh(technologyId, attempt);
  return { deferred: false };
}

/**
 * Run deep research on a technology in the background
 *
 * **Trigger:** `app/technology.research.requested` event
 * **Timeout:** 10 minutes (AI research can take time)
 * **Retries:** 2 attempts with exponential backoff
 */
export const runDeepResearchJob = inngest.createFunction(
  {
    id: 'run-deep-research',
    name: 'Run Deep Research',

    /**
     * Retry configuration - fewer retries since AI is expensive
     */
    retries: 2,

    /**
     * Rate limit: Only 3 concurrent research jobs to manage AI costs
     */
    concurrency: {
      limit: 3,
    },

    /**
     * Failure handler - logs error and updates status
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<{
        technologyId?: string;
        triggeredAt?: number;
      }>(event.data);
      const technologyId = data.technologyId || 'unknown';

      log.error('Final failure after all retries', new Error(error.message), { technologyId });

      if (technologyId === 'unknown' || !Number.isFinite(data.triggeredAt) || Number(data.triggeredAt) <= 0) {
        log.error('No valid technology attempt in failure event');
        return;
      }

      const attempt = Number(data.triggeredAt);
      if (isSnapshotDebtPersistenceFailure(error)) {
        try {
          await recordPendingSnapshotRefresh(technologyId, attempt, error);
        } catch (persistenceError) {
          log.error(
            'Research is complete but snapshot-refresh recovery debt could not be persisted after bounded retries',
            persistenceError instanceof Error ? persistenceError : undefined,
            { technologyId, attempt }
          );
          try {
            await inngest.send({
              name: 'app/placement.snapshot-refresh.failed',
              data: { technologyId, error: error.message, failedAt: Date.now(), severity: 'low' },
            });
          } catch (notificationError) {
            log.error(
              'Could not emit terminal snapshot-refresh recovery notification',
              notificationError instanceof Error ? notificationError : undefined,
              { technologyId, attempt }
            );
          }
        }
        return;
      }
      const { released } = await releaseResearchPending(technologyId, 'worker-failed', attempt);
      if (!released) {
        log.info('Skipped stale deep-research failure', { technologyId, triggeredAt: attempt });
        return;
      }

      // Send notification event for monitoring
      await inngest.send({
        name: 'app/technology.research.failed',
        data: {
          technologyId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  /**
   * Event trigger: When research is requested
   */
  { event: 'app/technology.research.requested' },

  /**
   * Main function handler
   */
  async ({ event, step }) => {
    const { technologyId, triggeredAt } = event.data;

    if (!Number.isFinite(triggeredAt) || Number(triggeredAt) <= 0) {
      throw new Error('Deep research event requires a valid triggeredAt attempt token');
    }
    const attempt = Number(triggeredAt);

    // OBS-006: the run's own start instant must be DURABLE. A bare `Date.now()`
    // in the handler body is re-initialised on every one of Inngest's per-step
    // HTTP requests, so the terminal subtraction measured only the final
    // invocation slice instead of the full persisted span. `triggeredAt` is the attempt token AND the
    // durable instant the work was accepted, so queue wait is separable here for
    // free.
    const acceptedAtMs = parseDurableInstantMs(attempt);
    const startedAtMs = await captureDurableInstantMs(step, 'capture-start-time');

    log.info('Starting deep research', { technologyId, triggeredAt: attempt });

    try {
      /**
       * Step 1: Verify this event still owns the canonical research attempt.
       * This must happen before the paid provider step.
       */
      const inspection = await step.run('verify-research-attempt', async () => {
        return inspectResearchAttempt(technologyId, attempt, 'deep');
      });

      if (!inspection.active) {
        if (inspection.reason === 'not-found') throw new Error(`Technology ${technologyId} not found`);
        if (inspection.reason === 'handoff-pending') {
          await step.run('post-research-handoff', async () =>
            deliverDeepResearchHandoff(technologyId, attempt, ['deepResearch'])
          );
          log.info('Resumed deep-research handoff without provider spend', { technologyId, attempt });
          // A resumed handoff genuinely delivered the research (it was already
          // committed); only the downstream refresh dispatch was outstanding.
          return declareDomainOutcome(
            {
              success: true,
              resumedHandoff: true,
              technologyId,
              technologyName: inspection.technology.name,
            },
            { outcome: 'success', reason: 'resumed-handoff' }
          );
        }
        log.info('Ignoring inactive deep-research event', {
          technologyId,
          triggeredAt: attempt,
          reason: inspection.reason,
        });
        // OBS-001: an event whose attempt was superseded did no business work.
        // `success: true` here has always meant "the transport is fine, stop
        // retrying" — declaring `skipped` stops it also reading as a delivery.
        return declareDomainOutcome(
          { success: true, ignored: true, technologyId, reason: inspection.reason },
          { outcome: 'skipped', reason: inspection.reason }
        );
      }
      const technology = inspection.technology;

      /**
       * Step 2: Run deep research via AI
       *
       * OBS-006: the provider phase is measured INSIDE the step, so its span is
       * memoized with the step result and stays correct across replay. Measuring
       * it in the handler body would reproduce the original bug one level down.
       */
      const research = await step.run('run-ai-research', async () => {
        log.info('Calling AI for deep research', { technologyName: technology.name });
        const providerStartedAtMs = Date.now();

        const result = await deepResearchStructured({
          technologyName: technology.name,
          technologyDescription: technology.description ?? '',
        });

        if (!result) {
          throw new Error('AI research returned no data');
        }

        log.info('AI research completed', { technologyName: technology.name });
        return { result, providerMs: Math.max(0, Date.now() - providerStartedAtMs) };
      });
      const researchResult = research.result;

      /**
       * Step 3: Save research to technology document and update status
       */
      const completion = await step.run('save-research', async () => {
        return completeDeepResearchAttempt(technologyId, attempt, {
          completedAt: Date.now(),
          research: researchResult,
        });
      });

      if (!completion.completed) {
        log.info('Deep research completed after its attempt was superseded; result not persisted', {
          technologyId,
          triggeredAt: attempt,
          reason: completion.reason,
        });
        // The provider ran and was billed, but nothing was persisted, so this is
        // explicitly NOT a delivery — a newer attempt owns the result.
        return declareDomainOutcome(
          { success: true, ignored: true, technologyId, reason: completion.reason },
          { outcome: 'skipped', reason: completion.reason }
        );
      }

      log.info('Saved research', {
        technologyId,
        technologyName: completion.technologyName,
        updatedFields: completion.updatedFields,
      });

      /**
       * Step 4: Trigger technology updated event to refresh snapshots
       */
      // ARUN-028 — non-fatal post-research handoff. The research is already
      // committed as `completed`; a failed refresh dispatch records durable debt
      // (replayed later) instead of failing the run.
      await step.run('post-research-handoff', async () =>
        deliverDeepResearchHandoff(technologyId, attempt, completion.updatedFields)
      );

      // OBS-006: both endpoints are memoized, so this span survives every
      // resume, retry and restart in between. Phases stay separate — a slow
      // queue and a slow provider are different problems with different owners.
      const completedAtMs = await captureDurableInstantMs(step, 'capture-end-time');
      const timing = deriveDurableTimingMs({
        acceptedAtMs,
        startedAtMs,
        completedAtMs,
        providerMs: research.providerMs,
      });

      log.info('Deep research completed', {
        technologyId,
        technologyName: completion.technologyName,
        ...timing,
      });

      return declareDomainOutcome(
        {
          success: true,
          technologyId,
          technologyName: completion.technologyName,
          ...timing,
        },
        { outcome: 'success' }
      );
    } catch (error) {
      log.error('Deep research job failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
