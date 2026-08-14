#!/usr/bin/env npx tsx
/**
 * @file scripts/check-demo-narrative.ts
 * @description SKILL-002 — CLI that scores the demo seed against the
 * demo-narrative contract and writes a structured quality receipt.
 *
 * Usage:
 *   npm run demo:narrative:check            # human summary + write receipt, exit non-zero on fail
 *   npm run demo:narrative:check -- --json  # print the raw JSON receipt only
 *   npm run demo:narrative:check -- --out path/to/receipt.json
 *
 * Reads the exported seed consts only (no emulator, no network). Exit code is 0
 * when the seed passes the contract, 1 otherwise — so it can gate CI.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { datasetFromSeed } from './demo-narrative/from-seed';
import { evaluateDemoNarrative } from './demo-narrative/evaluate';
import type { DemoNarrativeDataset, DemoNarrativeReceipt } from './demo-narrative/types';

export interface CheckOptions {
  json: boolean;
  out: string;
}

export function parseArgs(argv: string[]): CheckOptions {
  const json = argv.includes('--json');
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : 'reports/demo-narrative-receipt.json';
  return { json, out };
}

export function formatSummary(receipt: DemoNarrativeReceipt, outPath: string): string {
  const lines: string[] = [];
  lines.push(`\nDemo-narrative contract v${receipt.contractVersion} — ${receipt.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`  score: ${receipt.score}/100 (threshold ${receipt.threshold})`);
  lines.push(`  hero:  ${receipt.hero.label} [${receipt.hero.id}] — ${receipt.hero.linkedEntityCount} linked`);
  lines.push(`  screenshot route: ${receipt.canonicalScreenshotRoute}`);
  lines.push('  checks:');
  for (const check of receipt.checks) {
    const mark = check.status === 'pass' ? '✓' : '✗';
    const score = check.kind === 'scored' ? ` (${Math.round((check.score ?? 0) * 100)}%×${check.weight})` : '';
    lines.push(`    ${mark} [${check.kind}] ${check.id}${score} — ${check.detail}`);
    if (check.offenders && check.offenders.length > 0) {
      lines.push(
        `        offenders: ${check.offenders.slice(0, 10).join(', ')}${check.offenders.length > 10 ? ' …' : ''}`
      );
    }
  }
  lines.push(`\n  receipt written: ${outPath}\n`);
  return lines.join('\n');
}

export interface RunDeps {
  loadDataset?: () => DemoNarrativeDataset;
  writeReceipt?: (absolutePath: string, contents: string) => void;
  log?: (message: string) => void;
}

function defaultWriteReceipt(absolutePath: string, contents: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

/**
 * Evaluate the seed, emit the receipt, and return it. Sets `process.exitCode = 1`
 * when the contract fails so the CLI can gate CI. Dependencies are injectable so
 * the check is testable without importing the seed or touching the filesystem.
 */
export function runCheck(argv: string[], deps: RunDeps = {}): DemoNarrativeReceipt {
  const {
    loadDataset = datasetFromSeed,
    writeReceipt = defaultWriteReceipt,
    log = (m) => process.stdout.write(`${m}\n`),
  } = deps;
  const { json, out } = parseArgs(argv);
  const receipt = evaluateDemoNarrative(loadDataset());

  const absoluteOut = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
  writeReceipt(absoluteOut, `${JSON.stringify(receipt, null, 2)}\n`);

  log(json ? `${JSON.stringify(receipt, null, 2)}` : formatSummary(receipt, out));

  if (!receipt.passed) {
    process.exitCode = 1;
  }
  return receipt;
}

if (require.main === module) {
  runCheck(process.argv.slice(2));
}
