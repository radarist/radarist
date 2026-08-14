#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPlaywrightJsonReceipt,
  type PlaywrightJsonReport,
  type PlaywrightReceiptSummary,
} from '../lib/playwright-json-receipt';

export interface PlaywrightJsonLaneOptions {
  readonly lane: string;
  readonly config: string;
  readonly minExpected: number;
  readonly maxSkipped: number;
  readonly maxFlaky: number;
  readonly playwrightArgs?: readonly string[];
}

interface CommandResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio: 'inherit' }
) => CommandResult;

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio: 'inherit' }
): CommandResult {
  return spawnSync(command, [...args], options);
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function safeLaneName(lane: string): string {
  const normalized = lane.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('lane must contain at least one safe filename character');
  }
  return normalized;
}

/**
 * Execute one Playwright lane with an owned, unpredictable JSON receipt.
 * Paths are passed through argv/environment, never interpolated into a shell
 * command, and the receipt root is removed on every terminal path.
 */
export function runPlaywrightJsonLane(
  options: PlaywrightJsonLaneOptions,
  dependencies: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly runCommand?: CommandRunner;
    readonly createTempRoot?: (prefix: string) => string;
  } = {}
): PlaywrightReceiptSummary {
  requireNonNegativeInteger('minExpected', options.minExpected);
  requireNonNegativeInteger('maxSkipped', options.maxSkipped);
  requireNonNegativeInteger('maxFlaky', options.maxFlaky);

  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const runCommand = dependencies.runCommand ?? defaultCommandRunner;
  const createTempRoot = dependencies.createTempRoot ?? mkdtempSync;
  const receiptRoot = createTempRoot(join(tmpdir(), `radarist-${safeLaneName(options.lane)}-`));
  const externalReceiptRoot = env.E2E_PARTITION_RAW_DIR;
  const phase = safeLaneName(env.E2E_PARTITION_PHASE ?? 'full');
  const receiptPath = externalReceiptRoot
    ? join(externalReceiptRoot, `${safeLaneName(options.lane)}-${phase}-${process.pid}.json`)
    : join(receiptRoot, 'playwright.json');

  try {
    const playwrightCli = require.resolve('@playwright/test/cli');
    const result = runCommand(
      process.execPath,
      [
        playwrightCli,
        'test',
        '--config',
        options.config,
        ...(options.playwrightArgs ?? []),
        '--reporter=line,json,html',
      ],
      {
        cwd,
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: receiptPath },
        stdio: 'inherit',
      }
    );
    if (result.error) throw result.error;
    if (!existsSync(receiptPath)) {
      throw new Error(
        `Playwright lane ${options.lane} produced no JSON receipt (exit ${String(result.status ?? result.signal)})`
      );
    }

    const report = JSON.parse(readFileSync(receiptPath, 'utf8')) as PlaywrightJsonReport;
    const receipt = assertPlaywrightJsonReceipt(report, {
      lane: options.lane,
      minExpected: options.minExpected,
      maxSkipped: options.maxSkipped,
      maxFlaky: options.maxFlaky,
    });
    if (result.status !== 0) {
      throw new Error(
        `Playwright lane ${options.lane} exited ${String(result.status ?? result.signal)} despite a valid receipt`
      );
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...receipt }, null, 2)}\n`);
    return receipt;
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

function parseCount(name: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function parsePlaywrightJsonLaneArgs(args: readonly string[]): PlaywrightJsonLaneOptions {
  const separator = args.indexOf('--');
  const contractArgs = separator === -1 ? args : args.slice(0, separator);
  const playwrightArgs = separator === -1 ? [] : args.slice(separator + 1);
  if (contractArgs.length !== 5) {
    throw new Error(
      'Usage: run-playwright-json-lane.ts <lane> <config> <min-expected> <max-skipped> <max-flaky> [-- <playwright args...>]'
    );
  }
  const [lane, config, minExpectedRaw, maxSkippedRaw, maxFlakyRaw] = contractArgs;
  if (!lane || !config) throw new Error('lane and config are required');
  return {
    lane,
    config,
    minExpected: parseCount('min-expected', minExpectedRaw),
    maxSkipped: parseCount('max-skipped', maxSkippedRaw),
    maxFlaky: parseCount('max-flaky', maxFlakyRaw),
    playwrightArgs,
  };
}

if (require.main === module) {
  try {
    runPlaywrightJsonLane(parsePlaywrightJsonLaneArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
    );
    process.exitCode = 1;
  }
}
