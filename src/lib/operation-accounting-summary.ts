/**
 * @file lib/operation-accounting-summary.ts
 * @description ARUN-027 / AI-029 / TEST-021 — the ONE canonical money roll-up
 * over the operation-usage ledger.
 *
 * The ledger already has three separate, well-defined producer-side facts:
 *   - `operationReceipts`  — the immutable per-response ESTIMATE, priced inside
 *     the repository by the one canonical rate card (fail-closed `unavailable`);
 *   - `operationSettlements` — the append-only provider ACTUAL, read ONLY through
 *     `resolveSettledAmount` (never by timestamp/id ordering);
 *   - `operationAccountingMarkers` — the durable record that a flush LOST a
 *     receipt (a conflict or a write failure), so a missing row is visible
 *     instead of silently shrinking the total.
 *
 * Turning those three into one presentable figure is a rule with real traps
 * (a settlement supersedes its receipt's estimate, a mixed-currency set is not
 * summable, an `unavailable` receipt makes the total not-provably-whole, and an
 * incomplete marker means rows are missing entirely). That rule was implemented
 * once for the Defense Verifications facet and NOT for Agent Runs or Builds,
 * which is exactly how a second accounting schema gets born. This module is that
 * rule, extracted verbatim in behaviour, so every visible surface reconciles the
 * same way and there is one place to fix if it is ever wrong.
 *
 * Two things this module deliberately does NOT do:
 *   - it never reads Firestore (it is pure, so it is exhaustively unit-testable
 *     and callable from any read model);
 *   - it never invents a figure. Every state that cannot prove an amount returns
 *     NO amount rather than `0`. `$0` is reserved for a provable zero.
 *
 * @author Radarist Team
 * @created 2026-07-27
 */

import type { ParentAccountingState } from '@/lib/schemas/operation-accounting-marker';
import type { SettlementResolution } from '@/lib/schemas/operation-settlement';
import type { OperationAccountingScope, OperationReceipt } from '@/lib/schemas/operation-receipt';

/**
 * How much of the money is proven:
 *   - `settled`     — every counted receipt carries a proven provider ACTUAL;
 *   - `estimated`   — the amount is the canonical rate card's estimate (possibly
 *     mixed with settled rows, in which case it is still only an estimate overall);
 *   - `incomplete`  — a real amount is known, but it is provably NOT the whole
 *     spend (a lost receipt, an unpriceable row, a deferred estimate);
 *   - `partial`     — nothing summable could be derived, and the reason is a
 *     structural defect (mixed currency, a conflicted settlement chain);
 *   - `unavailable` — there is nothing to show at all (no receipts, or every
 *     receipt is unpriceable). Renders as an em dash, never `$0`.
 */
export const OPERATION_ACCOUNTING_STATES = ['estimated', 'settled', 'incomplete', 'partial', 'unavailable'] as const;

export type OperationAccountingState = (typeof OPERATION_ACCOUNTING_STATES)[number];

/** Why a summary is not a plain proven total. */
export const OPERATION_ACCOUNTING_REASONS = [
  'no-receipts',
  'incomplete-accounting',
  'mixed-currency',
  'conflicted-settlement',
  /**
   * Every row priced, but at least one carries a provider fee the provider never
   * reported an amount for (a grounded search inside its free-tier window). The
   * stated amount is the exact TOKEN cost and is a genuine lower bound — the fee on
   * top is real and unknown. Distinct from `incomplete-accounting`, which means the
   * ledger LOST rows: here nothing is missing, one component is simply unpriceable.
   */
  'fee-unaccounted',
] as const;

export type OperationAccountingReason = (typeof OPERATION_ACCOUNTING_REASONS)[number];

/** One receipt paired with the resolution of its settlement chain. */
export interface ResolvedOperationReceipt {
  receipt: OperationReceipt;
  resolution: SettlementResolution;
}

/**
 * Per-scope money partition. This is the anti-double-count axis: a parent's own
 * headline ALREADY counts its `included-in-parent` rows, so a cross-parent total
 * must add only `additional-to-parent` + `standalone`. Each bucket reports its
 * own amount and whether that amount is whole.
 */
export interface OperationAccountingScopeTotal {
  receiptCount: number;
  /** Summable amount for this scope, absent when none is provable. */
  amountMicros?: number;
  /** True when every receipt in this bucket contributed a summable amount. */
  complete: boolean;
}

export interface OperationAccountingSummary {
  state: OperationAccountingState;
  /** ISO-4217 code; present only when the summary can name ONE currency. */
  currency?: string;
  /** Integer micro-units (1 USD = 1_000_000); present only when provable. */
  amountMicros?: number;
  reason?: OperationAccountingReason;
  receiptCount: number;
  /** Receipts whose settlement chain resolved to a proven provider actual. */
  settledCount: number;
  /** Receipts contributing a rate-card estimate (no settlement). */
  estimatedCount: number;
  /** Receipts the rate card could not price at all. */
  unavailableCount: number;
  /** Receipts whose settlement chain could not be resolved to one head. */
  conflictedSettlementCount: number;
  /**
   * Receipts carrying a provider fee whose amount the provider never reported, so
   * their contribution is a TOKEN-only lower bound. A legacy (v1) receipt has no
   * `feeState` at all and is counted here too — its fee situation is unknown, and
   * an unknown fee must never read as $0. Non-zero means any stated amount excludes
   * real, unknown fee spend.
   */
  feeUnaccountedCount: number;
  /** Money partitioned by accounting scope — the anti-double-count axis. */
  byScope: Record<OperationAccountingScope, OperationAccountingScopeTotal>;
  /**
   * `additional-to-parent` + `standalone` — the spend to add ON TOP of parent
   * headlines when totalling across parents. Absent when not provable, including
   * whenever any receipt is `unknown-incomplete` scope (see {@link scopeComplete}),
   * because an unclassified row might belong in either half.
   */
  notDoubleCountedMicros?: number;
  /**
   * True only when every receipt carries a known scope. False means a
   * not-double-counted total is not provable and a consumer must say so rather
   * than imply a whole figure. Legacy (v1) receipts have no scope and make this
   * false — that is reported here and deliberately does NOT degrade {@link state},
   * which describes whether THIS parent's own money is proven.
   */
  scopeComplete: boolean;
}

const SCOPES: readonly OperationAccountingScope[] = [
  'included-in-parent',
  'additional-to-parent',
  'standalone',
  'unknown-incomplete',
];

function emptyScopeTotals(): Record<OperationAccountingScope, OperationAccountingScopeTotal> {
  return {
    'included-in-parent': { receiptCount: 0, complete: true },
    'additional-to-parent': { receiptCount: 0, complete: true },
    standalone: { receiptCount: 0, complete: true },
    'unknown-incomplete': { receiptCount: 0, complete: true },
  };
}

/** A legacy (v1) receipt carries no scope: classify it as the conservative unknown. */
function scopeOf(receipt: OperationReceipt): OperationAccountingScope {
  return receipt.accountingScope ?? 'unknown-incomplete';
}

/** Add a proven amount into its scope bucket with checked safe-integer addition. */
function addToScope(
  totals: Record<OperationAccountingScope, OperationAccountingScopeTotal>,
  scope: OperationAccountingScope,
  amountMicros: number
): void {
  const bucket = totals[scope];
  const next = (bucket.amountMicros ?? 0) + amountMicros;
  if (!Number.isSafeInteger(next)) {
    // Refuse to carry an unsafe total rather than silently losing precision.
    bucket.amountMicros = undefined;
    bucket.complete = false;
    return;
  }
  bucket.amountMicros = next;
}

/** Mark a scope bucket as holding a row that contributed no summable amount. */
function markScopeIncomplete(
  totals: Record<OperationAccountingScope, OperationAccountingScopeTotal>,
  scope: OperationAccountingScope
): void {
  totals[scope].complete = false;
}

/** Build a summary that names a state and reason but can prove no amount. */
function unprovable(
  state: OperationAccountingState,
  reason: OperationAccountingReason | undefined,
  counts: SummaryCounts,
  byScope: Record<OperationAccountingScope, OperationAccountingScopeTotal>,
  scopeComplete: boolean
): OperationAccountingSummary {
  return {
    state,
    ...(reason ? { reason } : {}),
    ...counts,
    byScope,
    scopeComplete,
  };
}

interface SummaryCounts {
  receiptCount: number;
  settledCount: number;
  estimatedCount: number;
  unavailableCount: number;
  conflictedSettlementCount: number;
  feeUnaccountedCount: number;
}

/**
 * A receipt whose priced amount excludes a real provider fee. Only an ESTIMATE is
 * affected: a settlement is the provider's own actual and already includes whatever
 * the provider charged. A legacy receipt (no `feeState`) is treated as unknown-fee,
 * matching how `aggregateOperationReceipts` folds a legacy row in — never as $0.
 */
function hasUnaccountedFee(receipt: OperationReceipt): boolean {
  const feeState = receipt.feeState ?? 'applicable-but-unknown';
  return feeState === 'applicable-but-unknown';
}

/**
 * Roll a parent's resolved receipts plus its accounting marker state up into ONE
 * canonical money summary.
 *
 * The precedence is deliberate and load-bearing:
 *   1. no receipts at all → `unavailable` / `no-receipts` (nothing was recorded);
 *   2. mixed currencies → `partial` / `mixed-currency` with NO amount — summing
 *      across currencies would fabricate a figure;
 *   3. a conflicted settlement chain → `partial` / `conflicted-settlement`, since
 *      the provider actual for that row is genuinely indeterminate;
 *   4. nothing summable → `incomplete` when the shortfall is provable accounting
 *      loss, `unavailable` when the rows simply could not be priced;
 *   5. an amount plus ANY hole (lost receipt, unpriceable row, deferred estimate)
 *      → `incomplete` WITH the partial amount, so the reader sees both the figure
 *      and the fact that it is not the whole;
 *   6. every row settled → `settled`; otherwise `estimated`.
 *
 * A settlement always supersedes its receipt's estimate for that row — that is
 * the whole point of an actual — but a set that mixes settled and estimated rows
 * is only `estimated` overall, never `settled`.
 */
export function summarizeOperationAccounting(
  resolved: readonly ResolvedOperationReceipt[],
  markerState: ParentAccountingState | null
): OperationAccountingSummary {
  const byScope = emptyScopeTotals();
  for (const { receipt } of resolved) {
    byScope[scopeOf(receipt)].receiptCount += 1;
  }
  const scopeComplete = byScope['unknown-incomplete'].receiptCount === 0;

  const counts: SummaryCounts = {
    receiptCount: resolved.length,
    settledCount: 0,
    estimatedCount: 0,
    unavailableCount: 0,
    conflictedSettlementCount: 0,
    feeUnaccountedCount: 0,
  };

  if (resolved.length === 0) {
    return unprovable('unavailable', 'no-receipts', counts, byScope, scopeComplete);
  }

  let currency: string | undefined;
  let amountMicros = 0;
  let hasAmount = false;
  let hasSettled = false;
  let hasEstimated = false;
  let hasUnavailable = false;
  let hasConflictedSettlement = false;
  let hasDeferredEstimate = false;

  for (const { receipt, resolution } of resolved) {
    const scope = scopeOf(receipt);

    if (resolution.status === 'conflicted') {
      // The provider actual for this row is indeterminate. Do NOT fall back to
      // the estimate — a contested settlement means the row's money is unknown,
      // not "the estimate after all".
      hasConflictedSettlement = true;
      counts.conflictedSettlementCount += 1;
      markScopeIncomplete(byScope, scope);
      continue;
    }

    if (resolution.status === 'settled') {
      const settled = resolution.head;
      if (!currency) currency = settled.currency;
      else if (currency !== settled.currency) {
        return unprovable('partial', 'mixed-currency', counts, byScope, scopeComplete);
      }
      amountMicros += settled.actualAmountMicros;
      hasAmount = true;
      hasSettled = true;
      counts.settledCount += 1;
      addToScope(byScope, scope, settled.actualAmountMicros);
      continue;
    }

    const cost = receipt.cost;
    if (cost.state === 'unavailable') {
      hasUnavailable = true;
      counts.unavailableCount += 1;
      markScopeIncomplete(byScope, scope);
      continue;
    }

    if (cost.state === 'estimated') {
      hasEstimated = true;
      counts.estimatedCount += 1;
      if (cost.amountMicros == null || cost.currency == null) {
        // A priced-but-deferred estimate: the row is known to cost something,
        // but the figure is not available, so it cannot be summed.
        hasDeferredEstimate = true;
        markScopeIncomplete(byScope, scope);
        continue;
      }
      if (!currency) currency = cost.currency;
      else if (currency !== cost.currency) {
        return unprovable('partial', 'mixed-currency', counts, byScope, scopeComplete);
      }
      amountMicros += cost.amountMicros;
      hasAmount = true;
      addToScope(byScope, scope, cost.amountMicros);
      // A token-only estimate whose provider fee is applicable-but-unknown is a
      // real lower bound, not a whole. Count it and mark its scope bucket
      // incomplete so a cross-parent total can never be presented as proven.
      if (hasUnaccountedFee(receipt)) {
        counts.feeUnaccountedCount += 1;
        markScopeIncomplete(byScope, scope);
      }
      continue;
    }

    if (cost.state === 'actual') {
      // A legacy v1 receipt may carry an embedded actual; newer writes route
      // actuals through settlements instead.
      if (!currency) currency = cost.currency;
      else if (currency !== cost.currency) {
        return unprovable('partial', 'mixed-currency', counts, byScope, scopeComplete);
      }
      amountMicros += cost.amountMicros;
      hasAmount = true;
      hasSettled = true;
      counts.settledCount += 1;
      addToScope(byScope, scope, cost.amountMicros);
    }
  }

  const isMarkerIncomplete = markerState?.accountingState === 'incomplete';

  if (hasConflictedSettlement) {
    return {
      state: 'partial',
      reason: 'conflicted-settlement',
      ...(hasAmount ? { amountMicros, currency } : {}),
      ...counts,
      byScope,
      scopeComplete,
      ...notDoubleCounted(byScope, scopeComplete),
    };
  }

  if (!hasAmount) {
    if (hasUnavailable && hasDeferredEstimate) {
      return unprovable('partial', 'incomplete-accounting', counts, byScope, scopeComplete);
    }
    if (isMarkerIncomplete) {
      return unprovable('incomplete', 'incomplete-accounting', counts, byScope, scopeComplete);
    }
    if (hasUnavailable) {
      return unprovable('unavailable', 'no-receipts', counts, byScope, scopeComplete);
    }
    return unprovable('incomplete', 'incomplete-accounting', counts, byScope, scopeComplete);
  }

  const base = {
    amountMicros,
    currency,
    ...counts,
    byScope,
    scopeComplete,
    ...notDoubleCounted(byScope, scopeComplete),
  };

  if (isMarkerIncomplete || hasDeferredEstimate || hasUnavailable) {
    return { state: 'incomplete', reason: 'incomplete-accounting', ...base };
  }

  // Nothing was LOST and every row priced — but a row's provider fee is real and
  // unreported, so the figure is a lower bound. Report it with its own reason so an
  // operator can tell "the ledger dropped rows" from "one fee is unpriceable".
  if (counts.feeUnaccountedCount > 0) {
    return { state: 'incomplete', reason: 'fee-unaccounted', ...base };
  }

  if (hasSettled && !hasEstimated) {
    return { state: 'settled', ...base };
  }

  return { state: 'estimated', ...base };
}

/**
 * The cross-parent total: `additional-to-parent` + `standalone`. Provable only
 * when the scope classification is complete AND both contributing buckets are
 * themselves whole — otherwise an unclassified or unpriceable row could belong
 * to it and the figure would understate real spend.
 */
function notDoubleCounted(
  byScope: Record<OperationAccountingScope, OperationAccountingScopeTotal>,
  scopeComplete: boolean
): { notDoubleCountedMicros?: number } {
  if (!scopeComplete) return {};
  const additional = byScope['additional-to-parent'];
  const standalone = byScope.standalone;
  if (!additional.complete || !standalone.complete) return {};
  const total = (additional.amountMicros ?? 0) + (standalone.amountMicros ?? 0);
  if (!Number.isSafeInteger(total)) return {};
  return { notDoubleCountedMicros: total };
}

/** Every accounting scope, in a stable order, for exhaustive presentation. */
export const OPERATION_ACCOUNTING_SCOPES = SCOPES;
