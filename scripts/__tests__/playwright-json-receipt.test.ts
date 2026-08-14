import { assertPlaywrightJsonReceipt } from '../lib/playwright-json-receipt';

const healthy = {
  stats: { expected: 34, skipped: 0, unexpected: 0, flaky: 0, duration: 1200 },
};

describe('Playwright JSON execution receipt', () => {
  it('accepts a non-vacuous exact-quality execution', () => {
    expect(
      assertPlaywrightJsonReceipt(healthy, {
        lane: 'smoke',
        minExpected: 30,
        maxSkipped: 0,
      })
    ).toMatchObject({ lane: 'smoke', expected: 34, skipped: 0, unexpected: 0, flaky: 0 });
  });

  it.each([
    [{ stats: { ...healthy.stats, expected: 1 } }, /floor/],
    [{ stats: { ...healthy.stats, skipped: 1 } }, /skipped/],
    [{ stats: { ...healthy.stats, unexpected: 1 } }, /unexpected/],
    [{ stats: { ...healthy.stats, flaky: 1 } }, /flaky/],
    [{ stats: { ...healthy.stats, expected: Number.NaN } }, /invalid/],
    [{}, /missing stats/],
  ])('rejects a vacuous or degraded receipt %#', (report, message) => {
    expect(() =>
      assertPlaywrightJsonReceipt(report, {
        lane: 'smoke',
        minExpected: 30,
        maxSkipped: 0,
      })
    ).toThrow(message);
  });
});
