/**
 * @file lib/sweep-child-accounting.ts
 * @description OBS-004 — the pure aggregation of a sweep's CHILD outcomes, cost,
 * durable outputs and elapsed time.
 *
 * ## The failure shape
 *
 * A sweep can report `success` and "two missions" while both paid children fail,
 * produce no durable output, and accrue cost and elapsed time. Four separate
 * false claims share one root cause: the sweep's summary row described only what
 * the sweep DISPATCHED, never what its children DID.
 *
 * - `missionsSpawned` counted successful `inngest.send` calls, so it could not
 *   distinguish "fired" from "delivered".
 * - `costUsd: 0` was hardcoded. The sweep itself spends nothing; its children
 *   spend real money, and none of it appeared anywhere on the sweep.
 * - `duration: Date.now() - sweepCycleStart` used a handler-body instant, which
 *   Inngest re-initialises on every per-step HTTP request (same class as OBS-006).
 * - `status` came only from the insight-reflection lane, so a cycle whose paid
 *   children all failed still resolved from a healthy REFLECT.
 *
 * ## Why children settle asynchronously
 *
 * The sweep dispatches missions fire-and-forget (`inngest.send`) and returns.
 * Children then run for minutes, well past the sweep's own terminal step, so the
 * sweep CANNOT know their outcomes at write time. Converting the dispatch to
 * `step.invoke` would make the sweep block on every child, inheriting their
 * timeouts and serialising a deliberately parallel fan-out.
 *
 * So the aggregate is built by accrual: the sweep records what it dispatched, and
 * each child reports back when it terminalises. Until every dispatched child has
 * reported, the aggregate says so — `childrenStatus: 'pending' | 'partial'` — which
 * is the honest state and the one thing the pre-fix row never had.
 *
 * ## Idempotency by construction
 *
 * Settlements are stored as a MAP KEYED BY `missionId`, not appended to a list.
 * A replayed or retried settlement overwrites its own key with the same values,
 * so the derived counters cannot drift — no dedup pass, no sequence numbers. The
 * map is bounded by the per-cycle action cap (single digits), so it fits
 * comfortably in the AgentRun document.
 *
 * Pure and dependency-free: no firebase, no Inngest. The Firestore transaction
 * that applies a settlement lives in `sweep-child-accounting-admin.ts`.
 */

import {
  isUnsuccessfulDomainOutcome,
  rollUpChildOutcomes,
  type DomainOutcome,
} from '@/lib/observability/terminal-outcome';

/** Durable outputs a sweep child can produce. Counted, never inferred. */
export interface SweepChildOutputs {
  /** Relation proposals written for triage. */
  proposals?: number;
  /** Reports/artifacts published. */
  reports?: number;
  /** Entities created or enriched. */
  entities?: number;
}

/** One child's terminal report. Every field is an observation, never a default. */
export interface SweepChildSettlement {
  missionId: string;
  outcome: DomainOutcome;
  /**
   * The child's cost. ABSENT means unknown (an unpriced model, incomplete
   * accounting) — never 0. AI-029's rule: persisting 0 for an unknown cost
   * understates spend while looking exact.
   */
  costUsd?: number;
  /** Why the cost is unknown. Only meaningful when `costUsd` is absent. */
  costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
  tokensIn?: number;
  tokensOut?: number;
  /** The child's own durable elapsed time. */
  durationMs?: number;
  outputs?: SweepChildOutputs;
}

/**
 * The sweep's child accounting, derived from its dispatch list plus whatever has
 * settled so far.
 */
export interface SweepChildAggregate {
  /** Children the sweep successfully dispatched. */
  dispatched: number;
  /** Children that have reported a terminal outcome. */
  settled: number;
  /** Count per outcome — the exact terminal partition. */
  byOutcome: Partial<Record<DomainOutcome, number>>;
  /** Rolled-up child outcome, or undefined when nothing has settled. */
  outcome?: DomainOutcome;
  /**
   * Completeness of the rollup:
   * - `none`    — nothing dispatched. No children to account for.
   * - `pending` — dispatched, nothing settled yet.
   * - `partial` — some settled, some outstanding.
   * - `settled` — every dispatched child reported.
   */
  childrenStatus: 'none' | 'pending' | 'partial' | 'settled';
  /** Summed cost of children whose cost is KNOWN. */
  costUsd: number;
  /** Children whose cost could not be proven; excluded from `costUsd`. */
  costUnavailableChildren: number;
  tokensIn: number;
  tokensOut: number;
  /** Summed durable elapsed time across settled children. */
  childDurationMs: number;
  /** Summed durable outputs. */
  outputs: Required<SweepChildOutputs>;
  /** Children that failed to deliver — the number an operator acts on. */
  failedChildren: number;
}

/**
 * Aggregate settlements against the dispatch count.
 *
 * `dispatched` is authoritative for the denominator: a settlement arriving for a
 * mission the sweep never recorded still counts in `settled` (the work happened),
 * and the rollup is then treated as complete because `settled >= dispatched`.
 * Silently discarding it would lose a real outcome.
 */
export function aggregateSweepChildren(input: {
  dispatched: number;
  settlements: readonly SweepChildSettlement[];
}): SweepChildAggregate {
  const byOutcome: Partial<Record<DomainOutcome, number>> = {};
  const outputs: Required<SweepChildOutputs> = { proposals: 0, reports: 0, entities: 0 };
  let costUsd = 0;
  let costUnavailableChildren = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let childDurationMs = 0;
  let failedChildren = 0;

  for (const settlement of input.settlements) {
    byOutcome[settlement.outcome] = (byOutcome[settlement.outcome] ?? 0) + 1;
    if (isUnsuccessfulDomainOutcome(settlement.outcome)) failedChildren += 1;

    if (typeof settlement.costUsd === 'number' && Number.isFinite(settlement.costUsd)) {
      costUsd += settlement.costUsd;
    } else {
      // An unprovable cost is COUNTED, not summed as zero, so a partly-priced
      // batch never presents its total as exact.
      costUnavailableChildren += 1;
    }

    tokensIn += numeric(settlement.tokensIn);
    tokensOut += numeric(settlement.tokensOut);
    childDurationMs += numeric(settlement.durationMs);
    outputs.proposals += numeric(settlement.outputs?.proposals);
    outputs.reports += numeric(settlement.outputs?.reports);
    outputs.entities += numeric(settlement.outputs?.entities);
  }

  const settled = input.settlements.length;
  const { outcome } = rollUpChildOutcomes({
    dispatched: input.dispatched,
    outcomes: input.settlements.map((s) => s.outcome),
  });

  return {
    dispatched: input.dispatched,
    settled,
    byOutcome,
    ...(outcome !== undefined ? { outcome } : {}),
    childrenStatus: resolveChildrenStatus(input.dispatched, settled),
    // Float addition of a few small values; round to cents-of-a-cent so the
    // displayed total does not carry binary-representation noise.
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    costUnavailableChildren,
    tokensIn,
    tokensOut,
    childDurationMs,
    outputs,
    failedChildren,
  };
}

/**
 * The aggregate for a sweep whose settlements could not be READ.
 *
 * Used when the settlement store is unavailable while the summary row is being
 * written. The dispatch count is known (the sweep just made those calls), so
 * reporting it with `childrenStatus: 'pending'` is exactly true: children were
 * dispatched and nothing is known about them yet. The alternative — letting the
 * read failure abort the summary write — would lose the whole row, which is the
 * regression the pre-fix `costUsd: 0` at least avoided.
 */
export function dispatchOnlySweepChildAggregate(dispatched: number): SweepChildAggregate {
  return aggregateSweepChildren({ dispatched, settlements: [] });
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function resolveChildrenStatus(dispatched: number, settled: number): SweepChildAggregate['childrenStatus'] {
  if (dispatched === 0 && settled === 0) return 'none';
  if (settled === 0) return 'pending';
  return settled >= dispatched ? 'settled' : 'partial';
}

/**
 * The sweep's own AgentRun status, resolved from BOTH lanes.
 *
 * Pre-fix this read only `insightsStatus`, so the cycle whose two paid children
 * failed reported success on the strength of a healthy REFLECT. A sweep is a
 * supervisor: if the work it commissioned failed, the sweep did not succeed,
 * whatever its own bookkeeping did.
 *
 * `pending`/`partial` children deliberately do NOT force a failure — nothing has
 * gone wrong yet. They are surfaced through `childrenStatus` so a reader can see
 * the row is not yet final, rather than being told an outcome that has not
 * happened.
 */
export function resolveSweepStatusWithChildren(input: {
  insightsStatus: 'ok' | 'quiet' | 'failed' | 'not-run';
  children: Pick<SweepChildAggregate, 'failedChildren' | 'settled' | 'childrenStatus'>;
}): 'success' | 'failure' | 'skipped' {
  if (input.children.failedChildren > 0) return 'failure';
  if (input.insightsStatus === 'failed') return 'failure';
  if (input.insightsStatus === 'not-run' && input.children.settled === 0) return 'skipped';
  return 'success';
}
