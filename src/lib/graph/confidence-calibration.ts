/**
 * @file graph/confidence-calibration.ts
 * @description B3 — the FIRST recalibration writer over the two-field
 * confidence authority (B0). `effectiveConfidence` is always DERIVED, never
 * incremented directly:
 *
 *   effectiveConfidence = clamp(
 *     coalesce(assertedConfidence, confidence, 100)
 *       + coalesce(corroborationNudge, 0)
 *       + coalesce(feedbackDelta, 0),
 *     5, 100)
 *
 * `applyConfidenceFeedback` mutates ONLY `feedbackDelta` (bounded to ±25, one
 * event nudges it by ±5) and then re-derives `effectiveConfidence` from the
 * SAME composition contract via `effectiveConfidenceSet` — the shared
 * Cypher-fragment helper this module exports so the next writer
 * (corroborationNudge, C3) re-derives from the identical formula rather than
 * hand-rolling a second copy that could drift.
 *
 * Both the typed edge (`()-[r {relationId}]->()`) and its backing `:Assertion`
 * node (`(a:Assertion {relationId})`) are updated — the established
 * relationId-matched convention this codebase uses to keep the edge and its
 * reified claim in sync (see `relation-assertion-sync.ts`).
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { getAssertionWithEvidenceByRelationId } from './assertions';
import { computeCorroboration } from '@/lib/claim-chips';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId } from '@/lib/observability/correlation';

const log = createLogger('graph/confidence-calibration');

/** One feedback event's nudge to `feedbackDelta`. */
const FEEDBACK_STEP = 5;

/** Hard bound on the accumulated `feedbackDelta` (never past ±25). */
const FEEDBACK_DELTA_BOUND = 25;

/** Clamp bounds for the derived `effectiveConfidence` (0-100 scale). */
const EFFECTIVE_CONFIDENCE_MIN = 5;
const EFFECTIVE_CONFIDENCE_MAX = 100;

/**
 * Single-sourced Cypher fragment: re-derives `<alias>.effectiveConfidence`
 * from the composition contract — `coalesce(assertedConfidence, confidence,
 * 100) + coalesce(corroborationNudge, 0) + coalesce(feedbackDelta, 0)`,
 * clamped to [5, 100]. Every recalibration writer (this one for
 * `feedbackDelta`, the future corroborationNudge writer) SETs its own nudge
 * field first, then appends this fragment — never assigns
 * `effectiveConfidence` any other way.
 *
 * @param alias - the Cypher variable the SET clause targets (e.g. `r`, `a`)
 */
export function effectiveConfidenceSet(alias: string): string {
  const base = `coalesce(${alias}.assertedConfidence, ${alias}.confidence, 100) + coalesce(${alias}.corroborationNudge, 0) + coalesce(${alias}.feedbackDelta, 0)`;
  return `${alias}.effectiveConfidence = CASE
      WHEN ${base} > ${EFFECTIVE_CONFIDENCE_MAX} THEN ${EFFECTIVE_CONFIDENCE_MAX}
      WHEN ${base} < ${EFFECTIVE_CONFIDENCE_MIN}   THEN ${EFFECTIVE_CONFIDENCE_MIN}
      ELSE ${base} END`;
}

/**
 * Cypher fragment: bounds `<alias>.feedbackDelta` to ±`FEEDBACK_DELTA_BOUND`
 * after adding `$delta` to its current value (absent → 0).
 */
function feedbackDeltaSet(alias: string): string {
  return `${alias}.feedbackDelta = CASE
      WHEN coalesce(${alias}.feedbackDelta, 0) + $delta >  ${FEEDBACK_DELTA_BOUND} THEN  ${FEEDBACK_DELTA_BOUND}
      WHEN coalesce(${alias}.feedbackDelta, 0) + $delta < -${FEEDBACK_DELTA_BOUND} THEN -${FEEDBACK_DELTA_BOUND}
      ELSE coalesce(${alias}.feedbackDelta, 0) + $delta END`;
}

const EDGE_CYPHER = `
  MATCH ()-[r {relationId: $relationId}]->()
  SET ${feedbackDeltaSet('r')},
      r.confidenceUpdatedAt = $now,
      r.correlationId = coalesce($correlationId, r.correlationId)
  WITH r
  SET ${effectiveConfidenceSet('r')}
  RETURN count(r) AS n
`;

const ASSERTION_CYPHER = `
  MATCH (a:Assertion {relationId: $relationId})
  SET ${feedbackDeltaSet('a')},
      a.confidenceUpdatedAt = $now,
      a.correlationId = coalesce($correlationId, a.correlationId)
  WITH a
  SET ${effectiveConfidenceSet('a')}
  RETURN count(a) AS n
`;

/**
 * Read-only existence probe. Two independent `CALL {}` subqueries (rather
 * than two top-level `OPTIONAL MATCH`es) so the edge-count and
 * assertion-count never combine into a cartesian product.
 */
const PROBE_CYPHER = `
  CALL {
    MATCH ()-[r {relationId: $relationId}]->()
    RETURN count(r) AS edgeCount
  }
  CALL {
    MATCH (a:Assertion {relationId: $relationId})
    RETURN count(a) AS assertionCount
  }
  RETURN edgeCount, assertionCount
`;

function resolveFeedbackCorrelationId(value: string | undefined): string | null {
  if (value === undefined) return null;

  const correlationId = parseCorrelationId(value);
  if (!correlationId) {
    throw new Error('Invalid confidence feedback correlation ID');
  }
  return correlationId;
}

/**
 * Applies one approve/reject feedback event to the relation edge ONLY
 * (not its backing `:Assertion` — see `applyConfidenceFeedbackToAssertion`).
 *
 * Split out from `applyConfidenceFeedback` (LIVE-1 fix, 2026-07-06): the
 * delta write is a running accumulator
 * (`coalesce(r.feedbackDelta,0) + $delta`), NOT idempotent — re-running it
 * applies the nudge again. The Inngest job wraps this in its OWN memoized
 * `step.run`, distinct from `applyConfidenceFeedbackToAssertion`'s step, so a
 * retry after a partial failure (this write succeeded, the assertion write
 * threw) replays this step's memoized result instead of re-executing it, and
 * only the failed step re-runs.
 *
 * @param relationId - the Firestore Relation id mirrored onto the edge
 * @param direction - 'up' (approve) applies +5; 'down' (reject) applies -5
 * @param correlationId - optional strict relation-mutation provenance; legacy
 *   callers omit it and preserve any existing edge provenance
 */
export async function applyConfidenceFeedbackToEdge(
  relationId: string,
  direction: 'up' | 'down',
  correlationId?: string
): Promise<{ edgesUpdated: number }> {
  const delta = direction === 'up' ? FEEDBACK_STEP : -FEEDBACK_STEP;
  const now = Date.now();
  const persistableCorrelationId = resolveFeedbackCorrelationId(correlationId);

  const edgeResult = await runWriteTransaction<{ n: number }>(EDGE_CYPHER, {
    relationId,
    delta,
    now,
    correlationId: persistableCorrelationId,
  });
  const edgesUpdated = edgeResult.records[0]?.n ?? 0;

  log.debug('confidence feedback applied to edge', {
    relationId,
    direction,
    delta,
    edgesUpdated,
    ...(persistableCorrelationId ? { correlationId: persistableCorrelationId } : {}),
  });

  return { edgesUpdated };
}

/**
 * Applies one approve/reject feedback event to the backing `:Assertion` node
 * ONLY (not the mirrored typed edge — see `applyConfidenceFeedbackToEdge`,
 * whose doc comment explains why this is split into its own function).
 *
 * @param relationId - the Firestore Relation id mirrored onto the Assertion
 * @param direction - 'up' (approve) applies +5; 'down' (reject) applies -5
 * @param correlationId - optional strict relation-mutation provenance; legacy
 *   callers omit it and preserve any existing Assertion provenance
 */
export async function applyConfidenceFeedbackToAssertion(
  relationId: string,
  direction: 'up' | 'down',
  correlationId?: string
): Promise<{ assertionsUpdated: number }> {
  const delta = direction === 'up' ? FEEDBACK_STEP : -FEEDBACK_STEP;
  const now = Date.now();
  const persistableCorrelationId = resolveFeedbackCorrelationId(correlationId);

  const assertionResult = await runWriteTransaction<{ n: number }>(ASSERTION_CYPHER, {
    relationId,
    delta,
    now,
    correlationId: persistableCorrelationId,
  });
  const assertionsUpdated = assertionResult.records[0]?.n ?? 0;

  log.debug('confidence feedback applied to assertion', {
    relationId,
    direction,
    delta,
    assertionsUpdated,
    ...(persistableCorrelationId ? { correlationId: persistableCorrelationId } : {}),
  });

  return { assertionsUpdated };
}

/**
 * Applies one approve/reject feedback event to the relation edge (and its
 * backing Assertion, when present) matched by `relationId`: nudges
 * `feedbackDelta` by ±5 (bounded to ±25 total), then re-derives
 * `effectiveConfidence` from the composition contract. Never SETs
 * `confidence` or `assertedConfidence` — those stay whatever the asserter
 * last claimed; only the system's derived belief moves.
 *
 * Composes `applyConfidenceFeedbackToEdge` + `applyConfidenceFeedbackToAssertion`
 * (LIVE-1 split, 2026-07-06). Signature/return UNCHANGED for existing
 * callers/tests. The Inngest job (`apply-relation-feedback.ts`) does NOT call
 * this composition — it calls the two halves as separately-memoized steps so
 * a retry after a partial failure can't double-apply the delta on the write
 * that already succeeded. Kept for any other caller that wants the combined,
 * non-durable result in one call.
 *
 * @param relationId - the Firestore Relation id (mirrored onto both the edge
 *   and the Assertion node as `relationId`)
 * @param direction - 'up' (approve) applies +5; 'down' (reject) applies -5
 * @param correlationId - optional strict provenance stamped consistently on
 *   both graph representations
 */
export async function applyConfidenceFeedback(
  relationId: string,
  direction: 'up' | 'down',
  correlationId?: string
): Promise<{ edgesUpdated: number; assertionsUpdated: number }> {
  const { edgesUpdated } = await applyConfidenceFeedbackToEdge(relationId, direction, correlationId);
  const { assertionsUpdated } = await applyConfidenceFeedbackToAssertion(relationId, direction, correlationId);

  log.debug('confidence feedback applied', { relationId, direction, edgesUpdated, assertionsUpdated });

  return { edgesUpdated, assertionsUpdated };
}

/**
 * Read-only probe: does `relationId` currently exist as a typed edge and/or
 * a backing `:Assertion` node in Neo4j? One cheap read transaction (never a
 * write) — the sole retry-worthy step in the Inngest job's
 * `await-materialization` step (LIVE-1): Inngest retries re-execute this
 * probe while waiting for the async relation-sync job to materialize the
 * edge/Assertion, and — being read-only — repeating it is always safe.
 *
 * @param relationId - the Firestore Relation id mirrored onto the edge/Assertion
 */
export async function relationFeedbackTargetsExist(relationId: string): Promise<{ edge: boolean; assertion: boolean }> {
  const result = await runReadTransaction<{ edgeCount: number; assertionCount: number }>(PROBE_CYPHER, {
    relationId,
  });

  const row = result.records[0];
  const edge = (row?.edgeCount ?? 0) > 0;
  const assertion = (row?.assertionCount ?? 0) > 0;

  log.debug('relation feedback targets probed', { relationId, edge, assertion });

  return { edge, assertion };
}

// ============================================================================
// C3 — corroboration → effectiveConfidence
// ============================================================================

/**
 * Maps a distinct-source count to its `corroborationNudge` bump:
 * 0 or 1 distinct sources → +0, 2 → +5, 3 → +10, 4+ → +15.
 *
 * Derived from (not a copy of) `calculateCorroborationScore`'s frozen
 * trust-score tiers (40/70/85/95, exported from `@/lib/signals/trust-score`)
 * — 40 is the flat "no bonus" floor for 0/1 sources, and each higher tier
 * (70, 85, 95) becomes this function's +5/+10/+15 step so the display-side
 * trust score and the graph-side effectiveConfidence nudge move in lockstep.
 *
 * Mapping this function is bound to (score → nudge): 40→0, 70→+5, 85→+10,
 * 95→+15. Bound by a same-import test in
 * `graph/__tests__/confidence-calibration.test.ts` that imports both this
 * function and `calculateCorroborationScore` and asserts the composition —
 * if either tier table drifts, that test fails loudly instead of the two
 * scores silently diverging.
 *
 * Pure — no I/O, no clamping (the caller composes this into
 * `effectiveConfidenceSet`'s own [5, 100] clamp).
 */
export function corroborationNudge(distinctSources: number): number {
  if (distinctSources >= 4) return 15;
  if (distinctSources === 3) return 10;
  if (distinctSources === 2) return 5;
  return 0; // 0 or 1 distinct sources — matches trust-score's flat-40 tier
}

const ASSERTION_NUDGE_CYPHER = `
  MATCH (a:Assertion {relationId: $relationId})
  SET a.corroborationNudge = $nudge,
      a.confidenceUpdatedAt = $now
  WITH a
  SET ${effectiveConfidenceSet('a')}
  RETURN a.effectiveConfidence AS effectiveConfidence, count(a) AS n
`;

const EDGE_NUDGE_CYPHER = `
  MATCH ()-[r {relationId: $relationId}]->()
  SET r.corroborationNudge = $nudge,
      r.confidenceUpdatedAt = $now
  WITH r
  SET ${effectiveConfidenceSet('r')}
  RETURN r.effectiveConfidence AS effectiveConfidence, count(r) AS n
`;

/**
 * Recomputes the corroboration nudge for the Assertion (and mirrored typed
 * edge) backing `relationId`, from the SAME evidence the display-side claim
 * chips read (`computeCorroboration` in `@/lib/claim-chips` — excludes
 * `user_assertion` / `edge_annotation` / `entity_field` sourceTypes, so a
 * curated note or first-party entity field never inflates the count).
 *
 * Idempotent by construction: the nudge is a pure function of the current
 * evidence set, so calling this twice with unchanged evidence SETs the exact
 * same `corroborationNudge` (and re-derives the exact same
 * `effectiveConfidence`) both times — there is no running total to double-add.
 *
 * SETs `a.corroborationNudge` and re-derives `effectiveConfidence` on the
 * :Assertion node first, then mirrors both onto the typed edge — both writes
 * go through the shared `effectiveConfidenceSet` fragment so the two never
 * drift apart.
 *
 * @param relationId - the Firestore Relation id (mirrored onto both the edge
 *   and the Assertion node as `relationId`)
 * @returns the distinct-source count, the nudge applied, and the recomputed
 *   `effectiveConfidence` (null when no Assertion backs `relationId`)
 */
export async function applyCorroborationNudge(relationId: string): Promise<{
  distinctSources: number;
  nudge: number;
  effectiveConfidence: number | null;
}> {
  const found = await getAssertionWithEvidenceByRelationId(relationId);
  if (!found) {
    log.debug('applyCorroborationNudge: no assertion backs relationId, skipping', { relationId });
    return { distinctSources: 0, nudge: 0, effectiveConfidence: null };
  }

  const { independentSourceCount } = computeCorroboration(found.evidence);
  const nudge = corroborationNudge(independentSourceCount);
  const now = Date.now();

  const assertionResult = await runWriteTransaction<{ effectiveConfidence: number; n: number }>(
    ASSERTION_NUDGE_CYPHER,
    { relationId, nudge, now }
  );
  const edgeResult = await runWriteTransaction<{ effectiveConfidence: number; n: number }>(EDGE_NUDGE_CYPHER, {
    relationId,
    nudge,
    now,
  });

  const effectiveConfidence =
    assertionResult.records[0]?.effectiveConfidence ?? edgeResult.records[0]?.effectiveConfidence ?? null;

  log.debug('corroboration nudge applied', {
    relationId,
    distinctSources: independentSourceCount,
    nudge,
    effectiveConfidence,
  });

  return { distinctSources: independentSourceCount, nudge, effectiveConfidence };
}
