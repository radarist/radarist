import { resolve } from 'node:path';
import {
  buildSecurityJestArgs,
  clearPriorSecurityJestResults,
  loadSecurityManifest,
  loadSecurityJestResults,
  resolveSecurityTestFiles,
  SECURITY_TEST_TIMEOUT_MS,
  validateSecurityJestResults,
  validateSecurityManifest,
  validateSecurityRunnerArgs,
  type SecurityJestManifest,
} from '../testing/run-security-jest';

const ROOT = resolve(__dirname, '../..');

function manifest(files: string[]): SecurityJestManifest {
  return {
    version: 1,
    suites: files.map((file) => ({ control: 'test-control', file })),
  };
}

describe('Security Jest manifest', () => {
  it('resolves every checked-in manifest member in declared order', () => {
    const checkedIn = loadSecurityManifest(resolve(ROOT, 'scripts/testing/security-jest-manifest.json'));
    const resolved = resolveSecurityTestFiles(checkedIn, ROOT);

    expect(resolved).toHaveLength(26);
    expect(resolved.map((file) => file.slice(ROOT.length + 1))).toEqual(checkedIn.suites.map(({ file }) => file));
    expect([...new Set(checkedIn.suites.map(({ control }) => control))]).toEqual([
      'authentication-and-authorization',
      'api-input-validation',
      'api-key-lifecycle-and-permissions',
      'destructive-confirmation',
      'local-network-exposure',
      'document-url-fetch-policy',
      'report-html-and-iframe-policy',
      'document-upload-ownership',
      'document-download-ownership',
      'server-owned-collection-isolation',
    ]);
    // Firestore Rules run in the separate, CI-required `test:emulator` lane.
    expect(checkedIn.knownGaps).toBeUndefined();
  });

  it('rejects empty manifests before Jest can run', () => {
    expect(() => validateSecurityManifest({ version: 1, suites: [] })).toThrow(/at least one test file/);
    expect(() => buildSecurityJestArgs([])).toThrow(/zero security test files/);
  });

  it('rejects malformed, duplicate, absolute, and traversal members', () => {
    expect(() => validateSecurityManifest({ version: 2, suites: [] })).toThrow(/version must be 1/);
    expect(() =>
      validateSecurityManifest({
        version: 1,
        suites: [
          { control: 'auth', file: 'src/a.test.ts' },
          { control: 'auth', file: 'src/a.test.ts' },
        ],
      })
    ).toThrow(/Duplicate/);
    expect(() => validateSecurityManifest(manifest(['/tmp/security.test.ts']))).toThrow(/inside the repository/);
    expect(() => validateSecurityManifest(manifest(['../security.test.ts']))).toThrow(/inside the repository/);
    expect(() => validateSecurityManifest(manifest(['src/security.ts']))).toThrow(/not a Jest test file/);
  });

  it('fails with the exact missing manifest member', () => {
    const selected = manifest(['src/present.test.ts', 'src/missing.test.ts']);
    const present = resolve(ROOT, 'src/present.test.ts');

    expect(() => resolveSecurityTestFiles(selected, ROOT, (file) => file === present)).toThrow(
      'Security Jest manifest member is missing: src/missing.test.ts'
    );
  });

  it('builds a runTestsByPath invocation containing exactly the resolved files', () => {
    const files = ['/repo/auth.test.ts', '/repo/ssrf.test.ts'];

    expect(buildSecurityJestArgs(files)).toEqual([
      '--runInBand',
      `--testTimeout=${SECURITY_TEST_TIMEOUT_MS}`,
      '--silent',
      '--json',
      `--outputFile=${resolve(ROOT, 'jest-security-results.current.json')}`,
      '--runTestsByPath',
      '/repo/auth.test.ts',
      '/repo/ssrf.test.ts',
    ]);
  });

  it('rejects caller-controlled selectors and report overrides', () => {
    expect(() => validateSecurityRunnerArgs([])).not.toThrow();
    expect(() => validateSecurityRunnerArgs(['--testPathPatterns=auth'])).toThrow(/does not accept Jest selectors/);
    expect(() => validateSecurityRunnerArgs(['--report=html'])).toThrow(/does not accept Jest selectors/);
  });

  it('requires every manifest member to execute at least one passing assertion', () => {
    const files = ['/repo/auth.test.ts', '/repo/ssrf.test.ts'];
    const passingSuite = (name: string) => ({
      name,
      status: 'passed',
      assertionResults: [{ status: 'passed' }],
    });

    expect(() =>
      validateSecurityJestResults(
        {
          numFailedTests: 0,
          numFailedTestSuites: 0,
          testResults: [passingSuite(files[0]), passingSuite(files[1])],
        },
        files
      )
    ).not.toThrow();

    expect(() =>
      validateSecurityJestResults(
        {
          numFailedTests: 0,
          numFailedTestSuites: 0,
          testResults: [
            passingSuite(files[0]),
            { name: files[1], status: 'passed', assertionResults: [{ status: 'pending' }] },
          ],
        },
        files
      )
    ).toThrow(/no passing assertions/);
  });

  it('fails closed when a result is missing, stale, or reports failures', () => {
    const files = ['/repo/auth.test.ts'];
    expect(() =>
      validateSecurityJestResults({ numFailedTests: 0, numFailedTestSuites: 0, testResults: [] }, files)
    ).toThrow(/missing manifest member/);
    expect(() =>
      validateSecurityJestResults({ numFailedTests: 1, numFailedTestSuites: 1, testResults: [] }, files)
    ).toThrow(/failed tests or suites/);

    const outputFile = resolve(ROOT, 'jest-security-results.current.json');
    clearPriorSecurityJestResults(outputFile);
    expect(() => loadSecurityJestResults(files, outputFile)).toThrow();
  });
});
