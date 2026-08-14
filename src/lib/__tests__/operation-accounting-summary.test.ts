/**
 * @file lib/__tests__/operation-accounting-summary.test.ts
 * @description ARUN-027 — the canonical ledger money roll-up.
 *
 * The rules under test are the ones a wrong implementation would silently break:
 * a settlement must supersede its receipt's estimate, an unpriceable or lost row
 * must degrade a real amount to `incomplete` rather than shrink it, mixed
 * currencies must never be summed, and the `included-in-parent` /
 * `additional-to-parent` split must stay separable so a cross-parent total does
 * not double-count a parent's own headline.
 */

import { summarizeOperationAccounting, type ResolvedOperationReceipt } from '@/lib/operation-accounting-summary';
import type { OperationAccountingScope, OperationReceipt } from '@/lib/schemas/operation-receipt';
import type { ParentAccountingState } from '@/lib/schemas/operation-accounting-marker';

const OWNER = 'user:tester';

function receiptWithCost(cost: OperationReceipt['cost'], overrides?: Partial<OperationReceipt>): OperationReceipt {
  return {
    id: 'oprcpt~v2~test',
    correlation: { parentType: 'mission', owner: OWNER, correlationId: 'mission-1' },
    operation: 'anthropic.mission-turn',
    invocationId: 'inv-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    modelProvenance: 'provider-reported',
    counters: { promptTokens: 100, outputTokens: 50 },
    usageCompleteness: 'complete',
    occurredAt: '2026-01-01T00:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
    schemaVersion: 2,
    recordedAt: 1704067200000,
    cost,
    ...overrides,
  } as unknown as OperationReceipt;
}

function estimated(
  amountMicros: number,
  opts?: { currency?: string; scope?: OperationAccountingScope }
): ResolvedOperationReceipt {
  return {
    receipt: receiptWithCost(
      {
        state: 'estimated',
        amountMicros,
        currency: opts?.currency ?? 'USD',
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      } as OperationReceipt['cost'],
      opts?.scope ? { accountingScope: opts.scope } : undefined
    ),
    resolution: { status: 'none' },
  };
}

function settled(
  estimateMicros: number,
  actualMicros: number,
  opts?: { currency?: string; scope?: OperationAccountingScope }
): ResolvedOperationReceipt {
  const currency = opts?.currency ?? 'USD';
  return {
    receipt: receiptWithCost(
      {
        state: 'estimated',
        amountMicros: estimateMicros,
        currency,
        covers: 'tokens',
        rateCardVersion: 'rc-1',
      } as OperationReceipt['cost'],
      opts?.scope ? { accountingScope: opts.scope } : undefined
    ),
    resolution: {
      status: 'settled',
      head: {
        id: 'opsettl~v1~head',
        owner: OWNER,
        receiptId: 'oprcpt~v2~test',
        actualAmountMicros: actualMicros,
        currency,
        covers: 'tokens',
        evidenceRef: 'anthropic-sdk-modelUsage',
        occurredAt: '2026-01-01T00:00:00.000Z',
        revision: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      chainLength: 0,
    },
  };
}

function unpriceable(opts?: { scope?: OperationAccountingScope }): ResolvedOperationReceipt {
  return {
    receipt: receiptWithCost(
      { state: 'unavailable', reason: 'provider-unreported' } as OperationReceipt['cost'],
      opts?.scope ? { accountingScope: opts.scope } : undefined
    ),
    resolution: { status: 'none' },
  };
}

function conflictedSettlement(): ResolvedOperationReceipt {
  return {
    ...estimated(1_000_000),
    resolution: { status: 'conflicted', reason: 'competing heads' },
  };
}

/**
 * A grounded response: its TOKEN cost is exactly derived, but the provider never
 * reported the search fee it also owes, so the stated amount is a lower bound.
 */
function feeUnaccounted(amountMicros: number, opts?: { scope?: OperationAccountingScope }): ResolvedOperationReceipt {
  const base = estimated(amountMicros, opts);
  return {
    ...base,
    receipt: { ...base.receipt, feeState: 'applicable-but-unknown' } as OperationReceipt,
  };
}

/** A legacy (v1) receipt: no `feeState` at all, so its fee situation is unknown. */
function legacyNoFeeState(amountMicros: number): ResolvedOperationReceipt {
  const base = estimated(amountMicros);
  const receipt = { ...base.receipt } as Record<string, unknown>;
  delete receipt.feeState;
  delete receipt.schemaVersion;
  return { ...base, receipt: receipt as unknown as OperationReceipt };
}

const incompleteMarker: ParentAccountingState = {
  accountingState: 'incomplete',
} as ParentAccountingState;

describe('summarizeOperationAccounting — money states', () => {
  it('reports unavailable with no amount when nothing was recorded', () => {
    const summary = summarizeOperationAccounting([], null);
    expect(summary.state).toBe('unavailable');
    expect(summary.reason).toBe('no-receipts');
    expect(summary.amountMicros).toBeUndefined();
    expect(summary.receiptCount).toBe(0);
  });

  it('sums rate-card estimates as estimated', () => {
    const summary = summarizeOperationAccounting([estimated(1_230_000), estimated(770_000)], null);
    expect(summary.state).toBe('estimated');
    expect(summary.amountMicros).toBe(2_000_000);
    expect(summary.currency).toBe('USD');
    expect(summary.estimatedCount).toBe(2);
    expect(summary.reason).toBeUndefined();
  });

  it('uses the settled actual, not the estimate, when a settlement exists', () => {
    const summary = summarizeOperationAccounting([settled(1_000_000, 4_250_000)], null);
    expect(summary.state).toBe('settled');
    // The estimate was $1.00 — the proven provider actual of $4.25 must win.
    expect(summary.amountMicros).toBe(4_250_000);
    expect(summary.settledCount).toBe(1);
  });

  it('stays estimated overall when settled and estimated rows are mixed', () => {
    const summary = summarizeOperationAccounting([settled(1_000_000, 1_000_000), estimated(500_000)], null);
    expect(summary.state).toBe('estimated');
    expect(summary.amountMicros).toBe(1_500_000);
    expect(summary.settledCount).toBe(1);
    expect(summary.estimatedCount).toBe(1);
  });

  it('refuses to sum across currencies', () => {
    const summary = summarizeOperationAccounting(
      [estimated(1_000_000), estimated(1_000_000, { currency: 'EUR' })],
      null
    );
    expect(summary.state).toBe('partial');
    expect(summary.reason).toBe('mixed-currency');
    expect(summary.amountMicros).toBeUndefined();
  });

  it('surfaces a conflicted settlement chain and never falls back to its estimate', () => {
    const summary = summarizeOperationAccounting([conflictedSettlement(), estimated(2_000_000)], null);
    expect(summary.state).toBe('partial');
    expect(summary.reason).toBe('conflicted-settlement');
    // The known row is still shown, but the contested row contributes nothing.
    expect(summary.amountMicros).toBe(2_000_000);
    expect(summary.conflictedSettlementCount).toBe(1);
  });

  it('degrades a real amount to incomplete when a row could not be priced', () => {
    const summary = summarizeOperationAccounting([estimated(3_000_000), unpriceable()], null);
    expect(summary.state).toBe('incomplete');
    expect(summary.reason).toBe('incomplete-accounting');
    expect(summary.amountMicros).toBe(3_000_000);
    expect(summary.unavailableCount).toBe(1);
  });

  it('degrades a complete-looking amount to incomplete when the marker records receipt loss', () => {
    const summary = summarizeOperationAccounting([estimated(3_000_000)], incompleteMarker);
    expect(summary.state).toBe('incomplete');
    expect(summary.reason).toBe('incomplete-accounting');
    expect(summary.amountMicros).toBe(3_000_000);
  });

  it('reports unavailable rather than $0 when every row is unpriceable', () => {
    const summary = summarizeOperationAccounting([unpriceable(), unpriceable()], null);
    expect(summary.state).toBe('unavailable');
    expect(summary.amountMicros).toBeUndefined();
    expect(summary.unavailableCount).toBe(2);
  });

  it('reports incomplete rather than $0 when receipts were lost and none priced', () => {
    const summary = summarizeOperationAccounting([unpriceable()], incompleteMarker);
    expect(summary.state).toBe('incomplete');
    expect(summary.amountMicros).toBeUndefined();
  });
});

describe('summarizeOperationAccounting — scope partition', () => {
  it('separates parent-included spend from additional spend', () => {
    const summary = summarizeOperationAccounting(
      [
        estimated(10_000_000, { scope: 'included-in-parent' }),
        estimated(2_000_000, { scope: 'additional-to-parent' }),
        estimated(500_000, { scope: 'standalone' }),
      ],
      null
    );
    expect(summary.state).toBe('estimated');
    expect(summary.amountMicros).toBe(12_500_000);
    expect(summary.byScope['included-in-parent'].amountMicros).toBe(10_000_000);
    expect(summary.byScope['additional-to-parent'].amountMicros).toBe(2_000_000);
    expect(summary.byScope.standalone.amountMicros).toBe(500_000);
    // A cross-parent total must exclude the 10.00 the parent headline already counts.
    expect(summary.notDoubleCountedMicros).toBe(2_500_000);
    expect(summary.scopeComplete).toBe(true);
  });

  it('refuses a not-double-counted total when any row has unknown scope', () => {
    const summary = summarizeOperationAccounting(
      [estimated(2_000_000, { scope: 'additional-to-parent' }), estimated(1_000_000, { scope: 'unknown-incomplete' })],
      null
    );
    expect(summary.scopeComplete).toBe(false);
    expect(summary.notDoubleCountedMicros).toBeUndefined();
    // The parent's own total is still shown — unknown scope is a cross-parent
    // problem, not a reason to hide this parent's money.
    expect(summary.amountMicros).toBe(3_000_000);
    expect(summary.state).toBe('estimated');
  });

  it('treats a legacy receipt with no scope as unknown rather than assuming a bucket', () => {
    const legacy: ResolvedOperationReceipt = {
      receipt: receiptWithCost(
        {
          state: 'estimated',
          amountMicros: 1_000_000,
          currency: 'USD',
          covers: 'tokens',
          rateCardVersion: 'rc-1',
        } as OperationReceipt['cost'],
        { accountingScope: undefined, schemaVersion: undefined } as Partial<OperationReceipt>
      ),
      resolution: { status: 'none' },
    };
    const summary = summarizeOperationAccounting([legacy], null);
    expect(summary.byScope['unknown-incomplete'].receiptCount).toBe(1);
    expect(summary.byScope.standalone.receiptCount).toBe(0);
    expect(summary.scopeComplete).toBe(false);
    expect(summary.notDoubleCountedMicros).toBeUndefined();
  });

  it('withholds a not-double-counted total when a contributing bucket has an unpriceable row', () => {
    const summary = summarizeOperationAccounting(
      [
        estimated(4_000_000, { scope: 'included-in-parent' }),
        estimated(1_000_000, { scope: 'additional-to-parent' }),
        unpriceable({ scope: 'standalone' }),
      ],
      null
    );
    expect(summary.scopeComplete).toBe(true);
    // `standalone` holds a row worth an unknown amount, so additional+standalone
    // would understate real spend — refuse it rather than imply a whole figure.
    expect(summary.byScope.standalone.complete).toBe(false);
    expect(summary.notDoubleCountedMicros).toBeUndefined();
    expect(summary.state).toBe('incomplete');
  });

  it('attributes a settled amount to its own scope bucket', () => {
    const summary = summarizeOperationAccounting(
      [settled(1_000_000, 7_000_000, { scope: 'included-in-parent' })],
      null
    );
    expect(summary.byScope['included-in-parent'].amountMicros).toBe(7_000_000);
    expect(summary.notDoubleCountedMicros).toBe(0);
    expect(summary.state).toBe('settled');
  });
});

// ===========================================================================
// TEST-021 — provider fees the provider never priced.
//
// A grounded response's token cost IS derivable; its Google-Search fee is not
// (a free-tier window makes the per-request charge indeterminate). The receipt
// therefore carries a real token-only amount plus an explicit unknown-fee state.
// The roll-up must show that amount AND refuse to call it whole — reporting
// either "nothing" or "estimated" would be a different lie each way.
// ===========================================================================

describe('summarizeOperationAccounting — unaccounted provider fees', () => {
  it('states the token amount but never calls a fee-bearing total estimated', () => {
    const summary = summarizeOperationAccounting([feeUnaccounted(1_500_000)], null);
    expect(summary.amountMicros).toBe(1_500_000);
    expect(summary.currency).toBe('USD');
    expect(summary.state).toBe('incomplete');
    expect(summary.reason).toBe('fee-unaccounted');
    expect(summary.feeUnaccountedCount).toBe(1);
  });

  it('distinguishes an unpriceable FEE from a LOST receipt', () => {
    // Both are "not the whole", but an operator must be able to tell a pricing
    // gap from a data-integrity failure.
    expect(summarizeOperationAccounting([feeUnaccounted(1_000_000)], null).reason).toBe('fee-unaccounted');
    expect(summarizeOperationAccounting([estimated(1_000_000)], incompleteMarker).reason).toBe('incomplete-accounting');
  });

  it('lets a genuine accounting loss outrank the fee gap', () => {
    const summary = summarizeOperationAccounting([feeUnaccounted(1_000_000), unpriceable()], null);
    expect(summary.state).toBe('incomplete');
    // A lost/unpriceable ROW is the more severe defect and names the reason.
    expect(summary.reason).toBe('incomplete-accounting');
    expect(summary.feeUnaccountedCount).toBe(1);
  });

  it('keeps a fee-free set fully estimated (no false degradation)', () => {
    const summary = summarizeOperationAccounting([estimated(1_000_000), estimated(2_000_000)], null);
    expect(summary.state).toBe('estimated');
    expect(summary.reason).toBeUndefined();
    expect(summary.feeUnaccountedCount).toBe(0);
  });

  it('does not degrade a SETTLED row — a provider actual already includes its fees', () => {
    const summary = summarizeOperationAccounting([settled(1_000_000, 4_250_000)], null);
    expect(summary.state).toBe('settled');
    expect(summary.feeUnaccountedCount).toBe(0);
  });

  it('treats a legacy receipt with no feeState as unknown-fee, never as $0 of fees', () => {
    const summary = summarizeOperationAccounting([legacyNoFeeState(900_000)], null);
    expect(summary.amountMicros).toBe(900_000);
    expect(summary.state).toBe('incomplete');
    expect(summary.feeUnaccountedCount).toBe(1);
  });

  it('withholds the cross-parent total when the additive half carries an unknown fee', () => {
    const summary = summarizeOperationAccounting(
      [
        estimated(4_000_000, { scope: 'included-in-parent' }),
        feeUnaccounted(1_000_000, { scope: 'additional-to-parent' }),
      ],
      null
    );
    expect(summary.scopeComplete).toBe(true);
    expect(summary.byScope['additional-to-parent'].complete).toBe(false);
    // Adding 1.0 on top of parent headlines would understate: the fee is real.
    expect(summary.notDoubleCountedMicros).toBeUndefined();
  });
});
