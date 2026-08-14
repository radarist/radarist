/**
 * @file lib/run-cost-display.ts
 * @description ARUN-027 — the ONE presentation rule for a run's visible cost.
 *
 * Three surfaces render the same cost fact — the `/agents/runs` table, the run
 * detail Details card, and the Activity `AgentLog` — and each had grown its own
 * ternary ladder over `costUsd`/`costState`. They agreed by coincidence, and
 * they shared two defects:
 *
 *   1. every ladder ended in `: 'settled'`, so a legacy row that recorded an
 *      amount BEFORE cost authority was tracked was displayed with the
 *      strongest possible claim — "settled" — that nothing had established; and
 *   2. an absent cost always rendered as the bare word "Unavailable", collapsing
 *      two materially different facts. `unknown-pricing` means the usage IS
 *      recorded and the canonical rate card simply has no entry for that model.
 *      `accounting-incomplete` means the ledger provably LOST receipts: real
 *      spend happened that nothing can now account for. An operator needs to
 *      tell a pricing gap from a data-integrity failure, and the reason was
 *      already persisted on every AgentRun — it was just never read.
 *
 * Pure and client-safe: string derivation only, no Firestore, no React.
 *
 * @author Radarist Team
 * @created 2026-07-27
 */

/** Authority behind a stated amount. `undefined` means the row predates tracking. */
export type RunCostState = 'estimated' | 'settled' | 'mixed' | 'reserved' | 'maximum-exposure';

/** Why no amount is stated. */
export type RunCostUnavailableReason = 'unknown-pricing' | 'accounting-incomplete';

export interface RunCostFacts {
  costUsd?: number;
  costState?: RunCostState;
  costUnavailable?: boolean;
  costUnavailableReason?: RunCostUnavailableReason;
}

export interface RunCostDisplay {
  /** Short cell text, e.g. `$4.25 settled`, `Incomplete`, `Unpriced`. */
  label: string;
  /** Longer explanation for a `title`/tooltip. Always present. */
  title: string;
  /** True when no amount is stated — callers may style the cell as absent. */
  unavailable: boolean;
}

const STATE_SUFFIX: Record<RunCostState, string> = {
  estimated: 'est.',
  settled: 'settled',
  mixed: 'settled + est.',
  reserved: 'reserved',
  'maximum-exposure': 'maximum exposure',
};

const STATE_TITLE: Record<RunCostState, string> = {
  estimated: 'Estimated from the canonical rate card. Not a provider-confirmed charge.',
  settled: "Settled against the provider's own reported cost.",
  mixed: 'Part settled against provider actuals, part estimated from the rate card.',
  reserved: 'Budget authority reserved before the work ran. Nothing has been billed yet.',
  'maximum-exposure': 'The ceiling this run could cost, including authority not yet settled.',
};

const UNAVAILABLE_LABEL: Record<RunCostUnavailableReason, string> = {
  'unknown-pricing': 'Unpriced',
  'accounting-incomplete': 'Incomplete',
};

const UNAVAILABLE_TITLE: Record<RunCostUnavailableReason, string> = {
  'unknown-pricing':
    'Usage was recorded, but the canonical rate card has no entry that can price it. The spend is real and its amount is unknown — it is not zero.',
  'accounting-incomplete':
    'Provider spend occurred, but the usage ledger could not durably record all of it. Some real spend is unaccounted for.',
};

/**
 * Derive the visible cost cell from a run's persisted accounting facts.
 *
 * An amount is shown only when one exists. When it does not, the persisted
 * reason decides the wording so a pricing gap and a receipt loss never read the
 * same. A stated amount whose authority was never recorded is shown WITHOUT a
 * suffix rather than being labelled settled — the number is real, the claim
 * about it is not.
 */
export function formatRunCost(facts: RunCostFacts): RunCostDisplay {
  const hasAmount = typeof facts.costUsd === 'number' && Number.isFinite(facts.costUsd);
  if (facts.costUnavailable === true || !hasAmount) {
    const reason = facts.costUnavailableReason;
    if (reason) {
      return { label: UNAVAILABLE_LABEL[reason], title: UNAVAILABLE_TITLE[reason], unavailable: true };
    }
    if (facts.costUnavailable === undefined) {
      // Nothing has been ASSERTED about this run's cost yet — an in-flight row
      // assembled from the live event stream. That is not the same as having
      // looked and found nothing provable, so it must not read "Unavailable".
      return { label: '—', title: 'This run has not reported a cost yet.', unavailable: true };
    }
    return {
      label: 'Unavailable',
      title: 'No cost was recorded for this run.',
      unavailable: true,
    };
  }

  const amount = `$${(facts.costUsd as number).toFixed(2)}`;
  const state = facts.costState;
  if (!state) {
    // Recorded before cost authority was tracked. Showing "settled" here would
    // assert a provider confirmation that never happened.
    return {
      label: amount,
      title: 'Recorded before cost authority was tracked. Whether this is an estimate or a settled actual is unknown.',
      unavailable: false,
    };
  }
  return { label: `${amount} ${STATE_SUFFIX[state]}`, title: STATE_TITLE[state], unavailable: false };
}
