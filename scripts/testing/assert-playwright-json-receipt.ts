#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { assertPlaywrightJsonReceipt, type PlaywrightJsonReport } from '../lib/playwright-json-receipt';

const [receiptPath, lane, minExpectedRaw, maxSkippedRaw, maxFlakyRaw = '0'] = process.argv.slice(2);

try {
  if (!receiptPath || !lane || minExpectedRaw === undefined || maxSkippedRaw === undefined) {
    throw new Error(
      'Usage: assert-playwright-json-receipt.ts <receipt.json> <lane> <min-expected> <max-skipped> [max-flaky]'
    );
  }
  const minExpected = Number(minExpectedRaw);
  const maxSkipped = Number(maxSkippedRaw);
  const maxFlaky = Number(maxFlakyRaw);
  if (![minExpected, maxSkipped, maxFlaky].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error('Receipt limits must be non-negative integers');
  }
  const report = JSON.parse(readFileSync(receiptPath, 'utf8')) as PlaywrightJsonReport;
  const summary = assertPlaywrightJsonReceipt(report, { lane, minExpected, maxSkipped, maxFlaky });
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  );
  process.exitCode = 1;
}
