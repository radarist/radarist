/**
 * @file lib/__tests__/run-cost-display.test.ts
 * @description ARUN-027 — the shared visible-cost wording rule.
 *
 * Pins the two truths the previous per-surface ternary ladders got wrong: an
 * amount with no recorded authority must not be labelled "settled", and the two
 * reasons a cost is absent must never collapse into one word.
 */

import { formatRunCost } from '@/lib/run-cost-display';

describe('formatRunCost — stated amounts', () => {
  it('suffixes each recorded authority distinctly', () => {
    expect(formatRunCost({ costUsd: 0.125, costState: 'estimated' }).label).toBe('$0.13 est.');
    expect(formatRunCost({ costUsd: 4.25, costState: 'settled' }).label).toBe('$4.25 settled');
    expect(formatRunCost({ costUsd: 0.375, costState: 'mixed' }).label).toBe('$0.38 settled + est.');
    expect(formatRunCost({ costUsd: 1.5, costState: 'reserved' }).label).toBe('$1.50 reserved');
    expect(formatRunCost({ costUsd: 2.5, costState: 'maximum-exposure' }).label).toBe('$2.50 maximum exposure');
  });

  it('shows a legacy amount without claiming it was settled', () => {
    const display = formatRunCost({ costUsd: 0.25 });
    expect(display.label).toBe('$0.25');
    expect(display.unavailable).toBe(false);
    expect(display.title).toMatch(/unknown/i);
  });

  it('reports a provable zero as a real amount, not as unavailable', () => {
    const display = formatRunCost({ costUsd: 0, costState: 'settled' });
    expect(display.label).toBe('$0.00 settled');
    expect(display.unavailable).toBe(false);
  });
});

describe('formatRunCost — absent amounts', () => {
  it('distinguishes an unpriceable model from a ledger that lost receipts', () => {
    const unpriced = formatRunCost({ costUnavailable: true, costUnavailableReason: 'unknown-pricing' });
    const incomplete = formatRunCost({
      costUnavailable: true,
      costUnavailableReason: 'accounting-incomplete',
    });

    expect(unpriced.label).toBe('Unpriced');
    expect(incomplete.label).toBe('Incomplete');
    expect(unpriced.label).not.toBe(incomplete.label);
    expect(unpriced.title).not.toBe(incomplete.title);
    // Neither may read as free.
    expect(unpriced.label).not.toMatch(/\$0/);
    expect(incomplete.label).not.toMatch(/\$0/);
  });

  it('says Unavailable when the cost was looked for and no reason was recorded', () => {
    expect(formatRunCost({ costUnavailable: true }).label).toBe('Unavailable');
  });

  it('shows an em dash for a live row that has not asserted anything yet', () => {
    // `costUnavailable` undefined means nothing has been claimed, which is not
    // the same as having looked and found nothing provable.
    expect(formatRunCost({}).label).toBe('—');
  });

  it('honours an explicit unavailable flag even when an amount is present', () => {
    expect(formatRunCost({ costUsd: 3, costUnavailable: true }).label).toBe('Unavailable');
  });

  it('refuses a non-finite amount rather than rendering NaN', () => {
    expect(formatRunCost({ costUsd: Number.NaN, costUnavailable: false }).label).toBe('Unavailable');
  });
});
