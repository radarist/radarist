#!/usr/bin/env npx tsx

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface SecuritySuiteEntry {
  control: string;
  file: string;
}

export interface SecurityKnownGap {
  control: string;
  reason: string;
}

export interface SecurityJestManifest {
  version: 1;
  suites: SecuritySuiteEntry[];
  knownGaps?: SecurityKnownGap[];
}

const ROOT = resolve(__dirname, '../..');
const DEFAULT_MANIFEST_PATH = resolve(__dirname, 'security-jest-manifest.json');
const DEFAULT_RESULTS_FILE = resolve(ROOT, 'jest-security-results.current.json');
const JEST_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
export const SECURITY_TEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateSecurityManifest(value: unknown): SecurityJestManifest {
  if (!isRecord(value)) throw new Error('Security Jest manifest must be an object');
  if (value.version !== 1) throw new Error('Security Jest manifest version must be 1');
  if (!Array.isArray(value.suites)) throw new Error('Security Jest manifest suites must be an array');
  if (value.suites.length === 0) throw new Error('Security Jest manifest must select at least one test file');

  const seenFiles = new Set<string>();
  const suites = value.suites.map((entry, index): SecuritySuiteEntry => {
    if (!isRecord(entry)) throw new Error(`Security Jest manifest suites[${index}] must be an object`);
    const control = requireNonEmptyString(entry.control, `suites[${index}].control`);
    const file = requireNonEmptyString(entry.file, `suites[${index}].file`);

    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`Security Jest manifest path must stay inside the repository: ${file}`);
    }
    if (!JEST_TEST_FILE.test(file)) {
      throw new Error(`Security Jest manifest member is not a Jest test file: ${file}`);
    }
    if (seenFiles.has(file)) throw new Error(`Duplicate Security Jest manifest member: ${file}`);
    seenFiles.add(file);
    return { control, file };
  });

  let knownGaps: SecurityKnownGap[] | undefined;
  if (value.knownGaps !== undefined) {
    if (!Array.isArray(value.knownGaps)) throw new Error('Security Jest manifest knownGaps must be an array');
    knownGaps = value.knownGaps.map((gap, index) => {
      if (!isRecord(gap)) throw new Error(`Security Jest manifest knownGaps[${index}] must be an object`);
      return {
        control: requireNonEmptyString(gap.control, `knownGaps[${index}].control`),
        reason: requireNonEmptyString(gap.reason, `knownGaps[${index}].reason`),
      };
    });
  }

  return { version: 1, suites, ...(knownGaps === undefined ? {} : { knownGaps }) };
}

export function loadSecurityManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): SecurityJestManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to read Security Jest manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateSecurityManifest(parsed);
}

type IsFile = (absolutePath: string) => boolean;

function isExistingFile(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

export function resolveSecurityTestFiles(
  manifest: SecurityJestManifest,
  root: string = ROOT,
  isFile: IsFile = isExistingFile
): string[] {
  if (manifest.suites.length === 0) throw new Error('Security Jest manifest resolved zero test files');

  const resolved = manifest.suites.map(({ file }) => {
    const absolutePath = resolve(root, file);
    const fromRoot = relative(root, absolutePath);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Security Jest manifest path escapes the repository: ${file}`);
    }
    if (!isFile(absolutePath)) throw new Error(`Security Jest manifest member is missing: ${file}`);
    return absolutePath;
  });

  if (resolved.length === 0) throw new Error('Security Jest manifest resolved zero test files');
  return resolved;
}

export function buildSecurityJestArgs(testFiles: string[]): string[] {
  if (testFiles.length === 0) throw new Error('Refusing to invoke Jest with zero security test files');
  return [
    '--runInBand',
    `--testTimeout=${SECURITY_TEST_TIMEOUT_MS}`,
    '--silent',
    '--json',
    `--outputFile=${DEFAULT_RESULTS_FILE}`,
    '--runTestsByPath',
    ...testFiles,
  ];
}

export function validateSecurityRunnerArgs(args: string[]): void {
  if (args.length > 0) {
    throw new Error(
      `Security gate does not accept Jest selectors or report overrides: ${args.join(' ')}`
    );
  }
}

export function validateSecurityJestResults(value: unknown, testFiles: string[]): void {
  if (!isRecord(value)) throw new Error('Security Jest result file must contain an object');
  if (!Array.isArray(value.testResults)) throw new Error('Security Jest results must include testResults');
  if (value.numFailedTests !== 0 || value.numFailedTestSuites !== 0) {
    throw new Error('Security Jest results contain failed tests or suites');
  }

  const suitesByPath = new Map<string, Record<string, unknown>>();
  for (const suite of value.testResults) {
    if (!isRecord(suite) || typeof suite.name !== 'string') {
      throw new Error('Security Jest result contains a malformed suite');
    }
    suitesByPath.set(resolve(suite.name), suite);
  }

  for (const file of testFiles) {
    const suite = suitesByPath.get(resolve(file));
    if (!suite) throw new Error(`Security Jest result is missing manifest member: ${file}`);
    if (!Array.isArray(suite.assertionResults)) {
      throw new Error(`Security Jest result has no assertions for manifest member: ${file}`);
    }
    const passedAssertions = suite.assertionResults.filter(
      (assertion) => isRecord(assertion) && assertion.status === 'passed'
    ).length;
    if (passedAssertions === 0) {
      throw new Error(`Security Jest manifest member executed no passing assertions: ${file}`);
    }
  }
}

export function clearPriorSecurityJestResults(outputFile: string = DEFAULT_RESULTS_FILE): void {
  rmSync(outputFile, { force: true });
}

export function loadSecurityJestResults(
  testFiles: string[],
  outputFile: string = DEFAULT_RESULTS_FILE
): void {
  const parsed: unknown = JSON.parse(readFileSync(outputFile, 'utf8'));
  validateSecurityJestResults(parsed, testFiles);
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    validateSecurityRunnerArgs(args);
    const manifest = loadSecurityManifest();
    const testFiles = resolveSecurityTestFiles(manifest);
    const controls = [...new Set(manifest.suites.map(({ control }) => control))];
    console.log(`[security] Running ${testFiles.length} explicit Jest files across ${controls.length} controls`);
    for (const gap of manifest.knownGaps ?? []) {
      console.warn(`[security] Known gap (${gap.control}): ${gap.reason}`);
    }

    clearPriorSecurityJestResults();
    const jestBin = require.resolve('jest/bin/jest');
    const result = spawnSync(process.execPath, [jestBin, ...buildSecurityJestArgs(testFiles)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
    loadSecurityJestResults(testFiles);
    console.log(`[security] Gate passed: ${testFiles.length} suites each executed passing assertions`);
    return 0;
  } catch (error) {
    console.error(`[security] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}
