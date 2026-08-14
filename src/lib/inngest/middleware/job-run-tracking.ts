/**
 * @file lib/inngest/middleware/job-run-tracking.ts
 * @description P3-B observability: client-level Inngest middleware that
 * records every function run to the `job-runs` Firestore collection via
 * `observability.ts` (recordJobStart / recordJobComplete / recordJobFailure —
 * previously 0 callers). Registering it on the client covers ALL functions
 * in `functions/index.ts` without touching the 37 function files.
 *
 * Lifecycle mapping (Inngest v3 executes a run as a series of HTTP requests,
 * one per step, replaying memoized state):
 *   - `beforeExecution` on the FIRST request of a run (no memoized steps yet)
 *     → recordJobStart. Later requests of the same run skip this, so a run
 *     produces exactly one job-run document.
 *   - `finished` (only fires on a response that ends the run) →
 *     recordJobComplete on success, recordJobFailure on error. A retried
 *     failure that later succeeds updates the same document to 'completed'.
 *
 * A cancelled run has NO terminal hook here, by SDK design: `cancelOn` is
 * enforced Inngest-side, which stops dispatching step requests, so the SDK is
 * never re-entered and `finished` cannot fire. That case is closed out of band
 * by `finalize-cancelled-job-run.ts`, which subscribes to the SDK's own
 * `inngest/function.cancelled` event (ARUN-023).
 *
 * The doc id is derived from Inngest's own runId (`inngest-<runId>`) so all
 * requests of one run address the same document.
 *
 * IMPORTANT: `observability.ts` statically imports `@/lib/firebase-admin`
 * (server-only). The client module (`../client.ts`) is dynamically imported
 * by browser-safe service modules (entity-factory, signals-core, …), so this
 * middleware must NOT import observability statically — it lazy-imports it
 * inside the run hooks, which only ever execute in the server runtime.
 */
import { InngestMiddleware } from 'inngest';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId, parseMissionId } from '@/lib/observability/correlation';
// Pure, dependency-free (no firebase reach), so it is safe to import statically
// here even though this module is dynamically imported by browser-safe services.
import { splitDomainOutcome } from '@/lib/inngest/domain-outcome';

const log = createLogger('inngest/job-run-tracking');

/** Firestore records must be maps — wrap scalars/arrays, pass objects through. */
function toOutputRecord(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { value: data };
}

export const jobRunTrackingMiddleware = new InngestMiddleware({
  name: 'Job Run Tracking (P3-B observability)',
  init() {
    return {
      onFunctionRun({ ctx, fn, steps }) {
        // First request of a run = no memoized step state yet.
        const isFirstRequest = steps.length === 0;
        const runDocId = `inngest-${ctx.runId}`;
        let functionId: string;
        try {
          functionId = fn.id();
        } catch {
          functionId = fn.name;
        }
        const functionName = fn.name || functionId;
        const event = ctx.event as { name?: string; data?: Record<string, unknown> } | undefined;
        const eventName = event?.name;
        // Thread the triggering entity id (when the event carries one) into the
        // recorded input, so records this run derives — e.g. an entity-sync
        // `inngest-<runId>` — are discoverable by exact-owned cleanup instead of
        // being stranded (CLEANUP-001). Purely additive; absent for other events.
        const entityId = typeof event?.data?.entityId === 'string' ? event.data.entityId : undefined;
        // OBS-003: never copy arbitrary caller text into diagnostics. Only the
        // exact opaque correlation token is retained, both in this bounded
        // input map and as a top-level queryable JobRun field.
        const correlationId = parseCorrelationId(event?.data?.correlationId) ?? undefined;
        // ARUN-023: the mission link must be established at START. Inngest's
        // `inngest/function.cancelled` payload carries only `function_id` and
        // `run_id` — never the original event — so a run cancelled server-side
        // has no other moment at which its mission could be recovered. Bounded
        // by the same OBS-003 rule as correlationId: an unrecognised value is
        // discarded, never persisted.
        const missionId = parseMissionId(event?.data?.missionId) ?? undefined;
        const input: Record<string, unknown> = {
          event: eventName,
          ...(entityId ? { entityId } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(missionId ? { missionId } : {}),
        };

        return {
          async beforeExecution(): Promise<void> {
            if (!isFirstRequest) return;
            try {
              const { recordJobStart } = await import('@/lib/inngest/observability');
              await recordJobStart(functionId, functionName, input, runDocId, correlationId);
            } catch (error) {
              // Observability must never break the job itself.
              log.warn('Failed to record job start', {
                functionId,
                runDocId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },

          async finished({ result }): Promise<void> {
            try {
              const { recordJobComplete, recordJobFailure } = await import('@/lib/inngest/observability');
              // OBS-001: the run's returned value may carry an explicit BUSINESS
              // outcome declaration. Split it off before recording, so the
              // persisted `output` keeps exactly the shape existing readers
              // parse, and the transport status stops standing in for delivery.
              // `result.error !== undefined` still decides the TRANSPORT status;
              // the declaration decides the DOMAIN outcome. A run can be both
              // transport-completed and domain-failed — that is the point.
              const { declaration, output } = splitDomainOutcome(result.data);
              if (result.error !== undefined) {
                const err = result.error instanceof Error ? result.error : new Error(String(result.error));
                await recordJobFailure(runDocId, err, 0, declaration);
              } else {
                await recordJobComplete(runDocId, toOutputRecord(output), undefined, declaration);
              }
            } catch (error) {
              log.warn('Failed to record job completion', {
                functionId,
                runDocId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        };
      },
    };
  },
});
