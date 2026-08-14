/**
 * @file inngest/functions/apply-relation-feedback.ts
 * @description LIVE-1 fix — B3 feedback race. Verified live on real Neo4j
 * (2026-07-06): the relations triage route used to call
 * `applyConfidenceFeedback` inline, in-request. But the Neo4j edge + its
 * backing `:Assertion` for a freshly-approved relation are created
 * ASYNCHRONOUSLY by the sync Inngest job (`app/relation.sync.requested`). On
 * a FIRST approval neither exists yet, so the calibration Cypher matched 0
 * rows and the +5 `feedbackDelta` was silently lost.
 *
 * This durable function moves the delta application off the request path
 * with retry semantics (`retries: 4`) that outlive the sync latency.
 *
 * LIVE-1 FOLLOW-UP (critical fix, 2026-07-06): the first cut of this function
 * wrapped the ENTIRE `applyConfidenceFeedback` call — two sequential,
 * independent `runWriteTransaction`s, each a non-idempotent running
 * accumulator (`coalesce(feedbackDelta,0) + $delta`) — in a SINGLE
 * `step.run`. Inngest only memoizes a step that returns successfully; a step
 * that throws partway re-executes its ENTIRE callback on retry. So: attempt 1
 * edge-write succeeds (+5), assertion-write throws (transient Neo4j error) ->
 * attempt 2 re-runs the whole step -> the edge goes to +10 while the
 * assertion gets +5. A single approve permanently double-counted on the edge
 * and the two mirrored fields diverged.
 *
 * Fixed by splitting into THREE steps so each accumulator write is its own
 * independently-memoized step:
 *   - `await-materialization` — a read-only probe
 *     (`relationFeedbackTargetsExist`). The ONLY retry-worthy condition
 *     (waiting for the async sync job) lives here, and re-running a read is
 *     always safe:
 *       - neither edge nor Assertion exist + `expectMaterialized: true`  ->
 *         throw, so Inngest retries this (idempotent) step.
 *       - neither exist + `expectMaterialized: false` -> documented no-op,
 *         function returns WITHOUT running either write step (e.g. a 'down'
 *         on a proposal whose relation never cleared the 75-gate legitimately
 *         has no edge/Assertion to nudge — must not retry forever).
 *   - `apply-edge-feedback` — `applyConfidenceFeedbackToEdge` only.
 *   - `apply-assertion-feedback` — `applyConfidenceFeedbackToAssertion` only.
 * A retry after a partial failure now replays the successful write from
 * Inngest's step memo and re-executes only the step that actually failed —
 * the delta can no longer be double-applied.
 *
 * Triggered by: app/relation.feedback.requested
 */

import { inngest } from '../client';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId } from '@/lib/observability/correlation';

const log = createLogger('inngest/apply-relation-feedback');

export const applyRelationFeedbackJob = inngest.createFunction(
  {
    id: 'apply-relation-feedback',
    retries: 4,
    onFailure: async ({ error }) => {
      log.error(
        'apply-relation-feedback failed permanently',
        error instanceof Error ? error : new Error(String(error))
      );
    },
  },
  { event: 'app/relation.feedback.requested' },
  async ({ event, step }) => {
    const { relationId, direction, expectMaterialized } = event.data;
    if (
      typeof relationId !== 'string' ||
      relationId.trim().length === 0 ||
      relationId.length > 256 ||
      (direction !== 'up' && direction !== 'down') ||
      typeof expectMaterialized !== 'boolean'
    ) {
      throw new Error('Invalid relation feedback event data');
    }
    const parsedCorrelationId =
      event.data.correlationId === undefined ? undefined : parseCorrelationId(event.data.correlationId);
    if (event.data.correlationId !== undefined && !parsedCorrelationId) {
      throw new Error('Invalid relation feedback correlation ID');
    }
    const correlationId = parsedCorrelationId ?? undefined;

    // Step 1 — idempotent read-only probe. This is the ONLY step that should
    // ever throw-to-retry: it re-executes safely because it never mutates
    // anything, unlike the two write steps below.
    const materialized = await step.run('await-materialization', async () => {
      // Dynamic import: Inngest functions never
      // statically import `lib/graph/**` (or any other service module) at
      // the top of the file.
      const { relationFeedbackTargetsExist } = await import('@/lib/graph/confidence-calibration');
      const { edge, assertion } = await relationFeedbackTargetsExist(relationId);

      if (!edge && !assertion) {
        if (expectMaterialized) {
          throw new Error('relation not yet materialized — retrying');
        }
        log.info('relation feedback no-op — materialization not expected', {
          relationId,
          direction,
          ...(correlationId ? { correlationId } : {}),
        });
        return { ready: false as const };
      }

      return { ready: true as const };
    });

    if (!materialized.ready) {
      return {
        applied: false as const,
        reason: 'not-materialized' as const,
        ...(correlationId ? { correlationId } : {}),
      };
    }

    // Step 2 — edge write. Its own memoized step: a retry after this
    // succeeds but the assertion step (below) throws will NOT re-run this
    // step, so the delta is applied to the edge exactly once. 0 rows is a
    // valid result (e.g. a Class B below-gate relation has an Assertion but
    // no typed edge yet) — never throw on 0 here.
    const { edgesUpdated } = await step.run('apply-edge-feedback', async () => {
      const { applyConfidenceFeedbackToEdge } = await import('@/lib/graph/confidence-calibration');
      return applyConfidenceFeedbackToEdge(relationId, direction, correlationId);
    });

    // Step 3 — assertion write. Same memoization guarantee as step 2, in the
    // opposite direction: if THIS step failed on a prior attempt and step 2
    // succeeded, step 2 replays from memo and only this one re-runs.
    const { assertionsUpdated } = await step.run('apply-assertion-feedback', async () => {
      const { applyConfidenceFeedbackToAssertion } = await import('@/lib/graph/confidence-calibration');
      return applyConfidenceFeedbackToAssertion(relationId, direction, correlationId);
    });

    log.debug('relation feedback applied', {
      relationId,
      direction,
      edgesUpdated,
      assertionsUpdated,
      ...(correlationId ? { correlationId } : {}),
    });
    return {
      applied: true as const,
      edgesUpdated,
      assertionsUpdated,
      ...(correlationId ? { correlationId } : {}),
    };
  }
);
