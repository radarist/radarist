import { qualityBadgeTestId, chainGroupTestId, verdictExpectedClass } from '../../../tests/e2e/utils/quality-helpers';

describe('qualityBadgeTestId', () => {
  it('returns the stable testid for an L1 badge on a specific mission', () => {
    expect(qualityBadgeTestId('mission-abc', 'L1')).toBe('quality-badge-L1-mission-abc');
  });
  it('returns the stable testid for an L2 badge', () => {
    expect(qualityBadgeTestId('mission-abc', 'L2')).toBe('quality-badge-L2-mission-abc');
  });
});

describe('chainGroupTestId', () => {
  it('returns the stable testid for a chain container', () => {
    expect(chainGroupTestId('chain-123-abcd')).toBe('chain-group-chain-123-abcd');
  });
});

describe('verdictExpectedClass', () => {
  it('maps PASS to the emerald-500 background token', () => {
    expect(verdictExpectedClass('PASS')).toBe('bg-emerald-500/');
  });
  it('maps REVISE to the amber-500 background token', () => {
    expect(verdictExpectedClass('REVISE')).toBe('bg-amber-500/');
  });
  it('maps FAIL to the destructive background token', () => {
    expect(verdictExpectedClass('FAIL')).toBe('bg-destructive/');
  });
});
