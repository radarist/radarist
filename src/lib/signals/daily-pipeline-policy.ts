/**
 * @file lib/signals/daily-pipeline-policy.ts
 * @description DISC-017 — the single executable declaration of which signal
 * statuses each daily-pipeline step may act on, on what recency basis, and who
 * owns the work the pipeline deliberately does NOT do.
 *
 * ## Why this module exists
 *
 * Before DISC-017 the repository held at least six mutually inconsistent
 * notions of "an eligible signal", each inlined at its own call site:
 *
 * | Consumer                             | States                          |
 * | ------------------------------------ | ------------------------------- |
 * | daily pipeline                       | `Validated`                     |
 * | trends (`trends-admin`)              | `Validated`                     |
 * | alignment (`pipeline/alignment-…`)   | `Validated`, `Approved`         |
 * | graph projection                     | `Approved`, `Imported`          |
 * | linker candidate generation          | `Approved`                      |
 * | signal auto-apply                    | `Detected`, `Validated`, `Approved` |
 *
 * A human approving a signal therefore saw the daily pipeline select it in
 * zero of its steps. This module makes the pipeline's own slice of that matrix
 * *executable and testable* instead of implicit, following the shape already
 * proven by `@/lib/graph/signal-projection-policy` (a named status set plus a
 * `decide…`-style function returning a structured, typed outcome).
 *
 * ## Two independent causes of "processed zero"
 *
 * 1. **Status.** Selection was `Validated`-only, so `Approved` never entered.
 * 2. **Recency.** Selection windowed on `detectedAt` alone. A signal detected
 *    four days ago and approved this morning is *newly* actionable, but a
 *    `detectedAt`-only window discards it. {@link signalEligibilityAt} fixes
 *    this by taking the later of detection and human review.
 *
 * Fixing only the first would still have processed zero in the reported case.
 *
 * ## Scope boundary (deliberate, not an oversight)
 *
 * This module declares the policy for the steps the daily pipeline itself
 * selects for. Two neighbours are declared but intentionally NOT changed here:
 *
 * - **Trends** re-queries independently inside `@/lib/trends-admin` and is
 *   outside this lane's owned surface. It is recorded in
 *   {@link DAILY_PIPELINE_STATUS_POLICY} so the narrower state set is a
 *   visible, pinned decision rather than an accidental divergence.
 * - **Enrichment** is owned wholly by the `enrich-liked-signals` lane. The
 *   daily pipeline reports enrichment coverage but never dispatches it — see
 *   {@link SIGNAL_ENRICHMENT_OWNER}.
 *
 * This module is intentionally PURE (type-only imports). It carries no SDK
 * dependency chain, so it is safe to import from an Inngest worker, an API
 * route, and a test alike.
 */

import type { Signal, SignalStatus } from '@/lib/types';

/** Daily-pipeline steps that select signals by status. */
export const DAILY_PIPELINE_SIGNAL_STEPS = ['get-signals', 'compute-trends', 'recalculate-alignment'] as const;

export type DailyPipelineSignalStep = (typeof DAILY_PIPELINE_SIGNAL_STEPS)[number];

/**
 * Who performs the selection for a step.
 *
 * - `daily-pipeline` — this function selects the cohort and passes it down.
 * - `delegated` — the called module runs its own query; the policy records the
 *   states it uses so the contract stays auditable from one place.
 */
export type SignalSelectionSite = 'daily-pipeline' | 'delegated';

export interface DailyPipelineStepStatusPolicy {
  readonly step: DailyPipelineSignalStep;
  /** Statuses this step may act on. Empty is never valid. */
  readonly statuses: readonly SignalStatus[];
  readonly selectionSite: SignalSelectionSite;
  /** Whether the step's cohort is narrowed by the recency window. */
  readonly recencyWindowed: boolean;
  readonly rationale: string;
}

/**
 * The per-step contract. Changing a row here is a deliberate policy change and
 * is pinned by `__tests__/daily-pipeline-policy.test.ts`.
 */
export const DAILY_PIPELINE_STATUS_POLICY: Readonly<Record<DailyPipelineSignalStep, DailyPipelineStepStatusPolicy>> = {
  'get-signals': {
    step: 'get-signals',
    statuses: ['Validated', 'Approved'],
    selectionSite: 'daily-pipeline',
    recencyWindowed: true,
    rationale:
      'Validated is the fresh triage backlog; Approved is human-confirmed and must not be dropped. ' +
      'Rejected/Archived are terminal, Detected has not been validated, and Imported has already ' +
      'become an entity — none benefit from re-analysis.',
  },
  'compute-trends': {
    step: 'compute-trends',
    statuses: ['Validated'],
    selectionSite: 'delegated',
    recencyWindowed: false,
    rationale:
      'Trend clustering runs its own 30-day lookback query inside @/lib/trends-admin and is outside ' +
      'this lane’s owned surface. Recorded here so the narrower state set is an explicit, pinned ' +
      'decision; widening it belongs to the trends owner.',
  },
  'recalculate-alignment': {
    step: 'recalculate-alignment',
    statuses: ['Validated', 'Approved'],
    selectionSite: 'delegated',
    recencyWindowed: false,
    rationale:
      'Alignment is recomputed against current strategies, so it is not time-windowed: a strategy ' +
      'edit today changes the correct score for an older signal. @/lib/pipeline/alignment-calculation ' +
      'runs its own bounded query; these are the statuses the pipeline asks it for.',
  },
};

/**
 * Enrichment (expansion) is owned by exactly one lane. "Exactly once" is
 * achieved by single ownership rather than by two lanes coordinating: the
 * `enrich-liked-signals` cron and the on-like path share one idempotency gate
 * (`@/lib/signals/enrich-on-like`), and the daily pipeline deliberately does
 * not dispatch enrichment at all.
 *
 * Reported by the pipeline, never performed by it. A test pins that the daily
 * pipeline sends no expansion event.
 */
export const SIGNAL_ENRICHMENT_OWNER = 'enrich-liked-signals' as const;

export type DailyPipelineSkipReason = 'status-not-eligible' | 'outside-recency-window';

export interface DailyPipelineSelectionTally {
  /** Rows the step looked at. */
  readonly scanned: number;
  /** Rows that passed both status and recency. */
  readonly selected: number;
  /** Rows dropped because their status is not in the step's set. */
  readonly skippedByStatus: number;
  /** Rows with an eligible status dropped by the recency window. */
  readonly skippedByRecency: number;
  /**
   * Per-status skip breakdown. Only statuses actually observed appear, so an
   * empty object honestly means "nothing was skipped", not "not measured".
   */
  readonly skippedStatusCounts: Readonly<Partial<Record<SignalStatus, number>>>;
}

export interface DailyPipelineSelection<T> extends DailyPipelineSelectionTally {
  readonly signals: readonly T[];
}

/** The minimum shape selection needs — keeps the helper usable from tests. */
export type SelectableSignal = Pick<Signal, 'status' | 'detectedAt'> & Partial<Pick<Signal, 'reviewedAt'>>;

/**
 * The moment a signal last became actionable: the later of detection and human
 * review.
 *
 * Windowing on `detectedAt` alone hides the exact case DISC-017 was raised
 * for — a signal detected outside the window but approved inside it. Both
 * approval writers (`signals-approval.approveSignal`,
 * `signals-admin.adminApproveSignal`) stamp `reviewedAt`, and the `Math.max`
 * degrades safely to `detectedAt` for rows that predate that.
 */
export function signalEligibilityAt(signal: SelectableSignal): number {
  return Math.max(signal.detectedAt ?? 0, signal.reviewedAt ?? 0);
}

/** True when `status` is eligible for `step` under the declared policy. */
export function isStatusEligibleForStep(step: DailyPipelineSignalStep, status: SignalStatus): boolean {
  return (DAILY_PIPELINE_STATUS_POLICY[step].statuses as readonly string[]).includes(status);
}

/**
 * Apply the declared policy to a scanned cohort, returning both the survivors
 * and the counts an operator needs to tell "nothing was eligible" apart from
 * "the step silently did nothing".
 *
 * `windowMs <= 0` disables recency narrowing, which is what the non-windowed
 * steps in {@link DAILY_PIPELINE_STATUS_POLICY} use.
 */
export function selectSignalsForStep<T extends SelectableSignal>(
  step: DailyPipelineSignalStep,
  signals: readonly T[],
  options: { readonly now: number; readonly windowMs: number }
): DailyPipelineSelection<T> {
  const applyWindow = DAILY_PIPELINE_STATUS_POLICY[step].recencyWindowed && options.windowMs > 0;
  const cutoff = options.now - options.windowMs;

  const selected: T[] = [];
  const skippedStatusCounts: Partial<Record<SignalStatus, number>> = {};
  let skippedByStatus = 0;
  let skippedByRecency = 0;

  for (const signal of signals) {
    if (!isStatusEligibleForStep(step, signal.status)) {
      skippedByStatus += 1;
      skippedStatusCounts[signal.status] = (skippedStatusCounts[signal.status] ?? 0) + 1;
      continue;
    }
    if (applyWindow && signalEligibilityAt(signal) < cutoff) {
      skippedByRecency += 1;
      continue;
    }
    selected.push(signal);
  }

  return {
    signals: selected,
    scanned: signals.length,
    selected: selected.length,
    skippedByStatus,
    skippedByRecency,
    skippedStatusCounts,
  };
}

export interface EnrichmentCoverage {
  /** Selected signals whose status makes them enrichment candidates. */
  readonly candidates: number;
  /** Of those, how many already carry expanded content. */
  readonly alreadyEnriched: number;
  /** Of those, how many the owning lane still has to reach. */
  readonly awaitingOwner: number;
  /** Always the owning lane — the pipeline never enriches. */
  readonly owner: typeof SIGNAL_ENRICHMENT_OWNER;
}

/**
 * Report — never perform — enrichment coverage for a selected cohort.
 *
 * This deliberately observes only a durable fact already on the document
 * (`expandedContent` present or absent) rather than re-implementing the owning
 * lane's in-flight window. Duplicating that gate here would create a second
 * definition of "already enriched" that could drift, which is the class of bug
 * DISC-017 exists to remove.
 */
export function summarizeEnrichmentCoverage(
  signals: readonly Pick<Signal, 'status' | 'expandedContent'>[]
): EnrichmentCoverage {
  let candidates = 0;
  let alreadyEnriched = 0;
  for (const signal of signals) {
    if (signal.status !== 'Approved') continue;
    candidates += 1;
    if (signal.expandedContent) alreadyEnriched += 1;
  }
  return {
    candidates,
    alreadyEnriched,
    awaitingOwner: candidates - alreadyEnriched,
    owner: SIGNAL_ENRICHMENT_OWNER,
  };
}
