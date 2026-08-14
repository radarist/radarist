export interface PlaywrightJsonStats {
  readonly expected: number;
  readonly skipped: number;
  readonly unexpected: number;
  readonly flaky: number;
  readonly duration?: number;
}

export interface PlaywrightJsonReport {
  readonly stats?: Partial<PlaywrightJsonStats>;
}

export interface PlaywrightReceiptContract {
  readonly lane: string;
  readonly minExpected: number;
  readonly maxSkipped: number;
  readonly maxFlaky?: number;
}

export interface PlaywrightReceiptSummary extends PlaywrightJsonStats {
  readonly lane: string;
}

function requireCount(stats: Partial<PlaywrightJsonStats>, key: keyof PlaywrightJsonStats): number {
  const value = stats[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Playwright JSON receipt has invalid stats.${key}: ${JSON.stringify(value)}`);
  }
  return value as number;
}

/**
 * Fail closed on vacuous or degraded Playwright executions. Playwright's
 * `expected` count is the number of tests that passed as expected; skipped,
 * unexpected, and flaky results are accounted for separately.
 */
export function assertPlaywrightJsonReceipt(
  report: PlaywrightJsonReport,
  contract: PlaywrightReceiptContract
): PlaywrightReceiptSummary {
  if (!report.stats) throw new Error('Playwright JSON receipt is missing stats');
  const expected = requireCount(report.stats, 'expected');
  const skipped = requireCount(report.stats, 'skipped');
  const unexpected = requireCount(report.stats, 'unexpected');
  const flaky = requireCount(report.stats, 'flaky');
  const duration = report.stats.duration;

  const failures: string[] = [];
  if (expected < contract.minExpected) failures.push(`expected ${expected} < floor ${contract.minExpected}`);
  if (skipped > contract.maxSkipped) failures.push(`skipped ${skipped} > ceiling ${contract.maxSkipped}`);
  if (unexpected !== 0) failures.push(`unexpected ${unexpected} != 0`);
  if (flaky > (contract.maxFlaky ?? 0)) {
    failures.push(`flaky ${flaky} > ceiling ${contract.maxFlaky ?? 0}`);
  }
  if (failures.length > 0) {
    throw new Error(`Playwright lane ${contract.lane} failed its execution contract: ${failures.join('; ')}`);
  }

  return { lane: contract.lane, expected, skipped, unexpected, flaky, duration };
}
