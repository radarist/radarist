import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCoverageGateInvocation,
  clearPriorCoverageGateResults,
  COVERAGE_TEST_TIMEOUT_MS,
  loadCoverageGateResults,
  MIN_PASSED_SUITES,
  MIN_PASSED_TESTS,
  validateCoverageGateResults,
} from '../testing/run-coverage-gate';

describe('coverage gate runner', () => {
  it('owns the serial, timeout, quiet, coverage, JSON, and output-file flags', () => {
    const invocation = buildCoverageGateInvocation(
      ['--watch=false', '--coverage', '--runInBand', '--silent', '--json'],
      '/repo'
    );

    expect(invocation.outputFile).toBe(resolve('/repo', 'jest-results.current.json'));
    expect(invocation.jestArgs).toEqual([
      '--watch=false',
      '--coverage',
      '--runInBand',
      `--testTimeout=${COVERAGE_TEST_TIMEOUT_MS}`,
      '--silent',
      '--json',
      `--outputFile=${resolve('/repo', 'jest-results.current.json')}`,
    ]);
  });

  it.each([
    ['--outputFile', 'package.json'],
    ['--outputFile=package.json'],
    ['--outputFile', '/tmp/arbitrary.json'],
  ])('rejects caller-controlled output paths', (...args) => {
    expect(() => buildCoverageGateInvocation(args, '/repo')).toThrow(/owns --outputFile/);
  });

  it('uses the ignored current-results artifact by default', () => {
    const invocation = buildCoverageGateInvocation([], '/repo');
    expect(invocation.outputFile).toBe(resolve('/repo', 'jest-results.current.json'));
  });

  it.each([
    '--no-coverage',
    '--coverage=false',
    '--collectCoverage=false',
    '--help',
    '--version',
    '--listTests',
    '--showConfig',
    '--config=other.config.js',
    '--coverageThreshold={}',
    '--testTimeout=5000',
  ])('rejects a policy-weakening option: %s', (option) => {
    expect(() => buildCoverageGateInvocation([option], '/repo')).toThrow(/policy override/);
  });

  it.each([
    ['--collectCoverageFrom=src/lib/app-version.ts'],
    ['--collectCoverageFrom', 'src/lib/app-version.ts'],
    ['--coveragePathIgnorePatterns=src/app'],
    ['--coverageProvider=v8'],
    ['--testPathPatterns=app-version'],
    ['--runTestsByPath', 'src/lib/__tests__/app-version.test.ts'],
    ['src/lib/__tests__/app-version.test.ts'],
  ])('rejects caller-controlled test or coverage scope: %s', (...args) => {
    expect(() => buildCoverageGateInvocation(args, '/repo')).toThrow(
      /does not allow Jest argument/
    );
  });

  it('accepts the exact count floors with no failures', () => {
    expect(
      validateCoverageGateResults({
        numPassedTests: MIN_PASSED_TESTS,
        numPassedTestSuites: MIN_PASSED_SUITES,
        numFailedTests: 0,
        numFailedTestSuites: 0,
      })
    ).toEqual(
      expect.objectContaining({
        numPassedTests: MIN_PASSED_TESTS,
        numPassedTestSuites: MIN_PASSED_SUITES,
      })
    );
  });

  it('fails closed on test or suite count regressions', () => {
    const valid = {
      numPassedTests: MIN_PASSED_TESTS,
      numPassedTestSuites: MIN_PASSED_SUITES,
      numFailedTests: 0,
      numFailedTestSuites: 0,
    };

    expect(() => validateCoverageGateResults({ ...valid, numPassedTests: MIN_PASSED_TESTS - 1 })).toThrow(
      /Test count regression/
    );
    expect(() =>
      validateCoverageGateResults({ ...valid, numPassedTestSuites: MIN_PASSED_SUITES - 1 })
    ).toThrow(/Suite count regression/);
  });

  it('fails closed on reported failures or malformed results', () => {
    expect(() =>
      validateCoverageGateResults({
        numPassedTests: MIN_PASSED_TESTS,
        numPassedTestSuites: MIN_PASSED_SUITES,
        numFailedTests: 1,
        numFailedTestSuites: 1,
      })
    ).toThrow(/reported failures/);
    expect(() => validateCoverageGateResults({})).toThrow(/numPassedTests/);
  });

  it('removes stale results and requires the run to produce a fresh file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'radarist-coverage-gate-'));
    const outputFile = join(directory, 'jest-results.json');
    writeFileSync(
      outputFile,
      JSON.stringify({
        numPassedTests: MIN_PASSED_TESTS,
        numPassedTestSuites: MIN_PASSED_SUITES,
        numFailedTests: 0,
        numFailedTestSuites: 0,
      })
    );

    try {
      clearPriorCoverageGateResults(outputFile);
      expect(existsSync(outputFile)).toBe(false);
      expect(() => loadCoverageGateResults(outputFile)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
