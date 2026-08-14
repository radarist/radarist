#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const MIN_PASSED_TESTS = 8_500;
export const MIN_PASSED_SUITES = 400;
export const COVERAGE_TEST_TIMEOUT_MS = 30_000;

const ROOT = resolve(__dirname, '../..');
const DEFAULT_RESULTS_FILE = 'jest-results.current.json';

interface JestResultSummary {
  numPassedTests: number;
  numPassedTestSuites: number;
  numFailedTests: number;
  numFailedTestSuites: number;
}

export interface CoverageGateInvocation {
  jestArgs: string[];
  outputFile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Jest result ${field} must be a non-negative integer`);
  }
  return value as number;
}

function rejectsGatePolicy(arg: string): boolean {
  return (
    arg === '--no-coverage' ||
    arg === '--coverage=false' ||
    arg === '--collectCoverage=false' ||
    arg === '--help' ||
    arg === '-h' ||
    arg === '--version' ||
    arg === '-v' ||
    arg === '--listTests' ||
    arg === '--showConfig' ||
    arg === '--config' ||
    arg === '-c' ||
    arg === '--coverageThreshold' ||
    arg === '--testTimeout' ||
    arg.startsWith('--config=') ||
    arg.startsWith('--coverageThreshold=') ||
    arg.startsWith('--testTimeout=')
  );
}

const ALLOWED_DIAGNOSTIC_ARGS = new Set([
  '--watch=false',
  '--detectOpenHandles',
  '--logHeapUsage',
  '--no-cache',
]);

export function buildCoverageGateInvocation(
  args: string[],
  root: string = ROOT
): CoverageGateInvocation {
  const forwarded: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (rejectsGatePolicy(arg)) {
      throw new Error(`Coverage gate does not allow policy override: ${arg}`);
    }

    if (arg === '--outputFile') {
      throw new Error('Coverage gate owns --outputFile');
    }

    if (arg.startsWith('--outputFile=')) {
      throw new Error('Coverage gate owns --outputFile');
    }

    // The gate owns these flags so callers cannot accidentally weaken or
    // duplicate the canonical invocation.
    if (arg === '--json' || arg === '--coverage' || arg === '--runInBand' || arg === '--silent') continue;

    // Keep the measured test and source scopes fixed. Jest has many selectors
    // and coverage overrides, so an allow-list is safer than trying to deny
    // every spelling that could narrow the canonical gate.
    if (!ALLOWED_DIAGNOSTIC_ARGS.has(arg)) {
      throw new Error(`Coverage gate does not allow Jest argument: ${arg}`);
    }
    forwarded.push(arg);
  }

  const outputFile = resolve(root, DEFAULT_RESULTS_FILE);
  return {
    outputFile,
    jestArgs: [
      ...forwarded,
      '--coverage',
      '--runInBand',
      `--testTimeout=${COVERAGE_TEST_TIMEOUT_MS}`,
      '--silent',
      '--json',
      `--outputFile=${outputFile}`,
    ],
  };
}

export function validateCoverageGateResults(value: unknown): JestResultSummary {
  if (!isRecord(value)) throw new Error('Jest result file must contain an object');

  const summary: JestResultSummary = {
    numPassedTests: requireNonNegativeInteger(value.numPassedTests, 'numPassedTests'),
    numPassedTestSuites: requireNonNegativeInteger(
      value.numPassedTestSuites,
      'numPassedTestSuites'
    ),
    numFailedTests: requireNonNegativeInteger(value.numFailedTests, 'numFailedTests'),
    numFailedTestSuites: requireNonNegativeInteger(
      value.numFailedTestSuites,
      'numFailedTestSuites'
    ),
  };

  if (summary.numFailedTests > 0 || summary.numFailedTestSuites > 0) {
    throw new Error(
      `Jest reported failures: ${summary.numFailedTestSuites} suites, ${summary.numFailedTests} tests`
    );
  }
  if (summary.numPassedTests < MIN_PASSED_TESTS) {
    throw new Error(
      `Test count regression: ${summary.numPassedTests} < ${MIN_PASSED_TESTS} passed tests`
    );
  }
  if (summary.numPassedTestSuites < MIN_PASSED_SUITES) {
    throw new Error(
      `Suite count regression: ${summary.numPassedTestSuites} < ${MIN_PASSED_SUITES} passed suites`
    );
  }

  return summary;
}

export function clearPriorCoverageGateResults(outputFile: string): void {
  rmSync(outputFile, { force: true });
}

export function loadCoverageGateResults(outputFile: string): JestResultSummary {
  const parsed: unknown = JSON.parse(readFileSync(outputFile, 'utf8'));
  return validateCoverageGateResults(parsed);
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const invocation = buildCoverageGateInvocation(args);
    clearPriorCoverageGateResults(invocation.outputFile);
    const jestBin = require.resolve('jest/bin/jest');
    const result = spawnSync(process.execPath, [jestBin, ...invocation.jestArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;

    const summary = loadCoverageGateResults(invocation.outputFile);
    console.log(
      `[coverage] Gate passed: ${summary.numPassedTestSuites} suites, ${summary.numPassedTests} tests`
    );
    return 0;
  } catch (error) {
    console.error(`[coverage] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}
