import { AccountingUnavailableError } from '../../src/accounting-errors.js';
import { estimateCostUsd } from '../../src/hooks/cost-estimator.js';

describe('estimateCostUsd', () => {
  it('should estimate Sonnet cost correctly', () => {
    // 1000 input + 1000 output + 0 cache
    // = (1000 * 3.0 + 1000 * 15.0 + 0) / 1_000_000 = 0.018
    const cost = estimateCostUsd('claude-sonnet-4-6', 1000, 1000, 0);
    expect(cost).toBeCloseTo(0.018, 4);
  });

  it('should estimate Opus 4-8 cost correctly', () => {
    // = (1000 * 5.0 + 1000 * 25.0 + 0) / 1_000_000 = 0.03
    const cost = estimateCostUsd('claude-opus-4-8', 1000, 1000, 0);
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it('should estimate Opus 4-6 cost correctly', () => {
    // = (1000 * 5.0 + 1000 * 25.0 + 0) / 1_000_000 = 0.03
    const cost = estimateCostUsd('claude-opus-4-6', 1000, 1000, 0);
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it('should estimate Haiku cost correctly', () => {
    // = (1000 * 1.0 + 1000 * 5.0 + 0) / 1_000_000 = 0.006
    const cost = estimateCostUsd('claude-haiku-4-5', 1000, 1000, 0);
    expect(cost).toBeCloseTo(0.006, 4);
  });

  it('should include cache read cost', () => {
    // Sonnet: 0 input + 0 output + 100000 cache = 100000 * 0.30 / 1M = 0.03
    const cost = estimateCostUsd('claude-sonnet-4-6', 0, 0, 100000);
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it('FAILS CLOSED for an unknown model — never a wrong-model floor or zero', () => {
    expect(() => estimateCostUsd('unknown-model', 1000, 1000, 0)).toThrow(AccountingUnavailableError);
  });

  it('should handle the dated Haiku model ID', () => {
    // = (1000 * 1.0 + 1000 * 5.0 + 0) / 1_000_000 = 0.006
    const cost = estimateCostUsd('claude-haiku-4-5-20251001', 1000, 1000, 0);
    expect(cost).toBeCloseTo(0.006, 4);
  });

  it('fails closed for a dated introductory rate without an in-window asOf', () => {
    // Sonnet 5 is dated (introductory); no asOf → unavailable, not the promo or a floor.
    expect(() => estimateCostUsd('claude-sonnet-5', 1000, 1000, 0)).toThrow(AccountingUnavailableError);
    // In-window asOf prices at the 2/10 introductory rate.
    expect(estimateCostUsd('claude-sonnet-5', 1000, 1000, 0, '2026-08-15')).toBeCloseTo(
      (1000 * 2 + 1000 * 10) / 1_000_000,
      6
    );
  });
});
