/**
 * @file lib/observability/terminal-outcome.ts
 * @description ONE canonical business/domain terminal-outcome vocabulary shared
 * by every store that records how a unit of work ended: Inngest `JobRun`
 * transport records, Missions, AgentRuns, Neo4j Episodes, AgentReflections,
 * sweep child aggregates, and build-runtime lineage.
 *
 * **Why this module exists (OBS-001 / GRAPH-030 / OBS-004 / ARUN-030).**
 * Before it, each surface invented its own encoding of "how did this end":
 * `JobRun.status` conflated *the transport completed* with *the work
 * succeeded*; a Mission said `failed` while its Neo4j Episode said `completed`;
 * a sweep reported `success` while every paid child failed. Those are not
 * display bugs — they are three stores disagreeing because no store shared a
 * vocabulary with the others.
 *
 * **Two independent axes, never collapsed.**
 * - *Transport* — did the delivery mechanism (an Inngest run, an HTTP request,
 *   a container session) finish? Owned by `JobStatus` in
 *   `@/lib/inngest/observability`.
 * - *Domain* — did the business work succeed? Owned by `DomainOutcome` here.
 *
 * A run can be transport-`completed` with domain `failed` (the exact TEST-027
 * Creator evidence: the Inngest run returned cleanly, the Mission failed, and
 * no Report existed). It can also be transport-`failed` with domain `partial`
 * (a checkpointed mission whose recovered output is real, whose final
 * persistence throw was not). Neither is a contradiction, and neither may be
 * flattened into a single field.
 *
 * **Absence is a value.** There is no `'success'`-shaped default. A producer
 * that declares nothing yields `undefined`, and every consumer must render that
 * as *undeclared*, never as green. `worstDomainOutcome` returns `undefined` for
 * an empty set for the same reason: "nothing to aggregate" is not "everything
 * succeeded".
 *
 * Pure and dependency-free by design (no firebase, no neo4j, no server-only) so
 * client components, Inngest workers, API routes, and scripts can all share the
 * one derivation instead of hand-rolling four.
 */

/**
 * How the business work ended, ordered from best to worst — see
 * `DOMAIN_OUTCOME_SEVERITY`, which depends on this ordering for aggregation.
 *
 * - `success` — the work completed and produced its promised deliverable.
 * - `partial` — real, usable output exists, but less than was promised (a
 *   checkpoint recovery, a sweep where some children failed, a build that
 *   passed QA on a subset). Deliberately distinct from both success and
 *   failure: calling it either loses information a reader needs.
 * - `skipped` — the work ran, correctly decided there was nothing to do, and
 *   produced no output. An honest no-op. NOT a failure, and NOT a success —
 *   counting a skip as success inflates success rates with non-work.
 * - `cancelled` — a human (or an owner-authorized signal) stopped the work
 *   before it reached a terminal business state.
 * - `preflight-failed` — refused BEFORE any paid/irreversible stage: an owner
 *   mismatch, an unreachable MCP surface, an over-authorization cost envelope.
 *   Distinct from `failed` because nothing was consumed and nothing partially
 *   wrote, which changes both the remediation and the billing story.
 * - `provider-fatal` — an upstream provider returned a non-retryable refusal
 *   (bad key, out of credit, wrong model id, 4xx). Distinct from `failed`
 *   because retrying is guaranteed useless; the fix is configuration.
 * - `failed` — the work ran and did not deliver.
 */
export const DOMAIN_OUTCOMES = [
  'success',
  'partial',
  'skipped',
  'cancelled',
  'preflight-failed',
  'provider-fatal',
  'failed',
] as const;

export type DomainOutcome = (typeof DOMAIN_OUTCOMES)[number];

/**
 * Outcomes that mean "no business value was delivered". Used by success-rate
 * readers so `skipped` and `cancelled` land in neither numerator nor
 * denominator, and by sweep aggregation to decide whether children failed.
 */
export const UNSUCCESSFUL_DOMAIN_OUTCOMES: readonly DomainOutcome[] = ['failed', 'preflight-failed', 'provider-fatal'];

/**
 * Outcomes that represent a DECIDED delivery attempt — the only rows that may
 * enter a success-rate denominator. `skipped` did not attempt delivery and
 * `cancelled` was a human decision; counting either would report an agent as
 * failing work it never took on (the same reasoning ARUN-023 applied to
 * cancelled transport rows).
 */
export const DECIDED_DOMAIN_OUTCOMES: readonly DomainOutcome[] = [
  'success',
  'partial',
  'failed',
  'preflight-failed',
  'provider-fatal',
];

export function isDomainOutcome(value: unknown): value is DomainOutcome {
  return typeof value === 'string' && (DOMAIN_OUTCOMES as readonly string[]).includes(value);
}

export function isUnsuccessfulDomainOutcome(outcome: DomainOutcome): boolean {
  return UNSUCCESSFUL_DOMAIN_OUTCOMES.includes(outcome);
}

export function isDecidedDomainOutcome(outcome: DomainOutcome): boolean {
  return DECIDED_DOMAIN_OUTCOMES.includes(outcome);
}

/**
 * Severity rank for aggregation. Higher wins in `worstDomainOutcome`, so a
 * batch containing one failure can never report as success.
 *
 * `skipped` ranks BELOW `partial` on purpose: a batch of "nothing to do" plus
 * one real partial delivery is a partial batch, not a skipped one.
 */
export const DOMAIN_OUTCOME_SEVERITY: Readonly<Record<DomainOutcome, number>> = {
  success: 0,
  skipped: 1,
  partial: 2,
  cancelled: 3,
  'preflight-failed': 4,
  'provider-fatal': 5,
  failed: 6,
};

/**
 * The worst outcome in a set — the honest rollup for a parent whose children
 * ended differently (a sweep, a mission chain, a multi-session build).
 *
 * Returns `undefined` for an empty set. An aggregate over nothing has no
 * outcome; defaulting to `'success'` here is precisely how a sweep with two
 * failed paid children came to report success.
 */
export function worstDomainOutcome(outcomes: readonly DomainOutcome[]): DomainOutcome | undefined {
  let worst: DomainOutcome | undefined;
  for (const outcome of outcomes) {
    if (worst === undefined || DOMAIN_OUTCOME_SEVERITY[outcome] > DOMAIN_OUTCOME_SEVERITY[worst]) {
      worst = outcome;
    }
  }
  return worst;
}

/**
 * Roll a parent's outcome up from its children, distinguishing "every child
 * succeeded" from "some children succeeded and some did not".
 *
 * `settled < dispatched` means at least one child has not reported yet, so the
 * rollup is explicitly incomplete — it degrades a clean sweep to `partial`
 * rather than announcing a success that unsettled children could still
 * contradict.
 */
export function rollUpChildOutcomes(input: { dispatched: number; outcomes: readonly DomainOutcome[] }): {
  outcome: DomainOutcome | undefined;
  complete: boolean;
} {
  const settled = input.outcomes.length;
  const complete = settled >= input.dispatched;
  const worst = worstDomainOutcome(input.outcomes);
  if (worst === undefined) return { outcome: undefined, complete: input.dispatched === 0 };
  if (!complete && worst === 'success') return { outcome: 'partial', complete };
  if (!complete && worst === 'skipped') return { outcome: 'partial', complete };
  return { outcome: worst, complete };
}

/**
 * Canonical Mission terminal state → `DomainOutcome`.
 *
 * The Mission doc encodes partial recovery as `status: 'completed'` +
 * `partial: true` (ARUN-008/AI-042). Reading `status` alone therefore reports a
 * timed-out, checkpoint-rescued mission as a clean success — so `partial` is
 * checked FIRST and wins over the status field.
 */
export function domainOutcomeFromMissionTerminal(input: {
  status: string | undefined;
  partial?: boolean | null;
  failureCode?: string | null;
}): DomainOutcome | undefined {
  if (input.partial === true) return 'partial';
  switch (input.status) {
    case 'completed':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return domainOutcomeFromMissionFailureCode(input.failureCode) ?? 'failed';
    default:
      // running / pending / an unrecognised value: not terminal, so no outcome.
      return undefined;
  }
}

/**
 * Structured Mission `failureCode` values that prove the mission was refused
 * BEFORE any paid stage. These are exactly the OPS-004 codes
 * `deriveMissionFailureCode` (run-agent-mission.ts) can emit — every one is an
 * internal-MCP preflight refusal raised by the `mcp-preflight` step, which is
 * the last gate before the first paid provider call.
 *
 * Kept as an explicit list rather than an `mcp-` prefix match so that adding a
 * *paid-stage* failure code beginning with `mcp-` later cannot silently start
 * reporting burned spend as "refused before start".
 */
export const PREFLIGHT_MISSION_FAILURE_CODES: readonly string[] = [
  'mcp-preflight-failed',
  'mcp-base-url-missing',
  'mcp-internal-key-missing',
  'mcp-credential-containment-failed',
];

/**
 * Refine a failed Mission using its structured `failureCode`, so a refusal that
 * spent nothing is not reported identically to a mission that burned its budget
 * and delivered nothing.
 *
 * An unrecognised code returns `undefined` — the caller then uses plain
 * `failed`. A code is never guessed into a category on the strength of its
 * spelling.
 */
export function domainOutcomeFromMissionFailureCode(code: string | null | undefined): DomainOutcome | undefined {
  if (typeof code !== 'string' || code.length === 0) return undefined;
  return PREFLIGHT_MISSION_FAILURE_CODES.includes(code) ? 'preflight-failed' : undefined;
}

/**
 * Build-runtime terminal reason (`classifyBuildTerminal`) → `DomainOutcome`.
 *
 * Exhaustion outcomes (`budget-exhausted`, `turns-exhausted`,
 * `session-cap-exhausted`) map to `partial`, not `failed`: the supervisor
 * stopped a run that was progressing and whose workspace artefacts are
 * retained, which is materially different from a build that produced nothing.
 * `review-failure` maps to `failed` — QA is the gate that decides delivery, and
 * a build that fails it delivered nothing publishable.
 */
export function domainOutcomeFromBuildTerminalReason(reason: string | undefined): DomainOutcome | undefined {
  switch (reason) {
    case 'completed':
      return 'success';
    case 'budget-exhausted':
    case 'turns-exhausted':
    case 'session-cap-exhausted':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'review-failure':
    case 'runtime-failure':
      return 'failed';
    default:
      return undefined;
  }
}

/**
 * AgentRun status (`success` | `failure` | `skipped`) for a domain outcome.
 *
 * The AgentRun vocabulary is intentionally coarser than `DomainOutcome`; the
 * finer distinction is preserved alongside it in `domainOutcome`, so this
 * narrowing never loses information — it only chooses which of three pills the
 * list view shows. `partial` maps to `success` because the row also carries
 * `partial: true`, which the renderer turns into the yellow "Partial" badge.
 */
export function agentRunStatusForDomainOutcome(outcome: DomainOutcome): 'success' | 'failure' | 'skipped' {
  switch (outcome) {
    case 'success':
    case 'partial':
      return 'success';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
    case 'failed':
    case 'preflight-failed':
    case 'provider-fatal':
      return 'failure';
  }
}

/** Short operator-facing label. Kept here so no two surfaces word it differently. */
export function describeDomainOutcome(outcome: DomainOutcome): string {
  switch (outcome) {
    case 'success':
      return 'Delivered';
    case 'partial':
      return 'Partial';
    case 'skipped':
      return 'Nothing to do';
    case 'cancelled':
      return 'Cancelled';
    case 'preflight-failed':
      return 'Refused before start';
    case 'provider-fatal':
      return 'Provider refused';
    case 'failed':
      return 'Failed';
  }
}
