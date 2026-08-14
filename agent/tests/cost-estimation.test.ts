/**
 * MISSION-004: model- and cache-aware turn cost estimation. Locks the rate
 * cards (verified against the live Anthropic pricing page 2026-07-12 — Opus
 * 4.5+ is $5/$25, NOT the Opus 4.1-era $15/$75), cache-write inclusion, the
 * absence of any long-context tier on current models, and the unknown-model
 * Sonnet floor.
 */
import { describe, it, expect } from '@jest/globals';
import { AccountingUnavailableError } from '../src/accounting-errors.js';
import { estimateTurnCostUsd } from '../src/cost-estimation.js';

const MTOK = 1_000_000;

describe('estimateTurnCostUsd', () => {
  it('prices an Opus turn at CURRENT Opus rates ($5/$25) — not the deprecated $15/$75 sheet', () => {
    const usage = { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
    expect(estimateTurnCostUsd('claude-opus-4-8', usage)).toBeCloseTo((100_000 * (5 + 25)) / MTOK, 6);
    expect(estimateTurnCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo((100_000 * (3 + 15)) / MTOK, 6);
  });

  it('prices Haiku turns at Haiku rates', () => {
    const usage = { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(estimateTurnCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(0.1, 6);
  });

  it('prices Fable/Mythos turns at the frontier-tier rates ($10/$50)', () => {
    const usage = { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
    expect(estimateTurnCostUsd('claude-fable-5', usage)).toBeCloseTo((100_000 * (10 + 50)) / MTOK, 6);
  });

  it('includes cache-creation (write) tokens — the old estimator priced them at $0', () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: MTOK };
    expect(estimateTurnCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(3.75, 6);
    expect(estimateTurnCostUsd('claude-opus-4-8', usage)).toBeCloseTo(6.25, 6);
  });

  it('prices cache reads per family', () => {
    const usage = { input: 0, output: 0, cacheRead: MTOK, cacheWrite: 0 };
    expect(estimateTurnCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(0.3, 6);
    expect(estimateTurnCostUsd('claude-opus-4-8', usage)).toBeCloseTo(0.5, 6);
  });

  it('applies NO long-context premium — current models serve 1M context at standard pricing', () => {
    // A cache-heavy 950K-prompt Sonnet turn (routine on long missions) must
    // price identically per-token to a small turn. The removed tier repriced
    // these at $6/$22.50 — a 2× input / 1.5× output overcharge on essentially
    // every mid-mission turn.
    const big = { input: 150_000, output: 10_000, cacheRead: 800_000, cacheWrite: 0 };
    const expected = (150_000 * 3.0 + 10_000 * 15.0 + 800_000 * 0.3) / MTOK;
    expect(estimateTurnCostUsd('claude-sonnet-4-6', big)).toBeCloseTo(expected, 6);
  });

  it('FAILS CLOSED for an unknown/missing model — never a wrong-model floor or zero', () => {
    const usage = { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(() => estimateTurnCostUsd(undefined, usage)).toThrow(AccountingUnavailableError);
    expect(() => estimateTurnCostUsd('mystery-model', usage)).toThrow(AccountingUnavailableError);
  });

  it('prices a dated introductory rate only with an in-window asOf, and fails closed otherwise', () => {
    const usage = { input: MTOK, output: MTOK, cacheRead: 0, cacheWrite: 0 };
    // Sonnet 5 introductory price (2/10) requires an in-window receipt timestamp.
    expect(estimateTurnCostUsd('claude-sonnet-5', usage, '2026-08-15')).toBeCloseTo((MTOK * (2 + 10)) / MTOK, 6);
    // Omitted asOf on a dated rate: fail closed (do not pin to the card date).
    expect(() => estimateTurnCostUsd('claude-sonnet-5', usage)).toThrow(AccountingUnavailableError);
    // Expired: fail closed rather than continue the promo.
    expect(() => estimateTurnCostUsd('claude-sonnet-5', usage, '2026-09-01')).toThrow(AccountingUnavailableError);
  });

  it('prices a timeless model with no asOf', () => {
    const usage = { input: MTOK, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(estimateTurnCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(3, 6);
  });
});
