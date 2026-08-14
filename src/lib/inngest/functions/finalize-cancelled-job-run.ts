/**
 * @file lib/inngest/functions/finalize-cancelled-job-run.ts
 * @description ARUN-023 — give a server-cancelled Inngest run its one terminal
 * job-run record.
 *
 * ## Why a separate function rather than a middleware hook
 *
 * `cancelOn` is enforced by the Inngest *server*: it stops dispatching step
 * requests for the run. The SDK is therefore never re-entered, so the job-run
 * middleware's `finished` hook — the only writer of a terminal status — cannot
 * fire, and `onFailure` does not fire either because a cancelled run is not a
 * failed run. The record was left at `running` forever.
 *
 * The SDK's own type docs point at this exact remedy: *"This is not guaranteed
 * to be called on every execution … for a guaranteed single execution, create a
 * function with an event trigger of `inngest/function.finished`."* The
 * cancellation sibling, `inngest/function.cancelled`, is an internal event
 * merged into every client's schema, so this needs no additions to
 * `InngestEvents`.
 *
 * ## What the payload can and cannot tell us
 *
 * `CancelledEventPayload` carries `{ function_id, run_id, correlation_id? }`
 * and — unlike the failure payload — does NOT nest the original event. There is
 * therefore nothing here from which a mission could be derived. That is why the
 * mission link is established at START by the job-run middleware, and why this
 * function reads correlation rather than inventing it.
 *
 * ## What this function deliberately does NOT do
 *
 * - It does not touch the mission. `/api/missions/[id]/cancel` already writes
 *   the authoritative mission result and stops the sandbox; duplicating that
 *   here would race an authoritative writer.
 * - It does not synthesize tokens, provider or cost. Those are not fields of a
 *   job-run record, and a cancelled run has no trustworthy usage to report.
 */

import { inngest } from '../client';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/finalize-cancelled-job-run');

/**
 * Job-run doc id for an Inngest run — must match the middleware's derivation
 * (`inngest-<runId>`) or the cancellation would create an orphan instead of
 * terminalizing the real record.
 */
export function jobRunDocIdForRun(runId: string): string {
  return `inngest-${runId}`;
}

export const finalizeCancelledJobRun = inngest.createFunction(
  {
    id: 'finalize-cancelled-job-run',
    name: 'Finalize Cancelled Job Run',
    // The write is a single idempotent transaction; retries are safe and are
    // the reason recordJobCancelled throws rather than swallowing infra errors.
    retries: 3,
  },
  { event: 'inngest/function.cancelled' },
  async ({ event, step }) => {
    const runId = typeof event.data?.run_id === 'string' ? event.data.run_id : undefined;
    const functionId = typeof event.data?.function_id === 'string' ? event.data.function_id : undefined;

    if (!runId) {
      // Nothing addressable — report it rather than pretending success.
      log.warn('Cancellation event carried no run_id', { functionId });
      return { finalized: false, reason: 'missing-run-id' as const };
    }

    return step.run('terminalize-job-run', async () => {
      const { recordJobCancelled } = await import('@/lib/inngest/observability');
      const runDocId = jobRunDocIdForRun(runId);
      const outcome = await recordJobCancelled(runDocId);

      log.info('Cancelled run finalized', { runDocId, functionId, outcome });
      return { finalized: outcome === 'cancelled', runDocId, functionId, outcome };
    });
  }
);
