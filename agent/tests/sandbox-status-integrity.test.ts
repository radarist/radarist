import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import {
  archiveQaReport,
  captureReviewerWorkspaceSnapshot,
  hasQaHandoffEvidence,
  listWorkspaceChangesSince,
  readWorkspaceGitHead,
} from '../src/sandbox/status.js';
import type { ExecResult, SandboxDriver, SandboxRef } from '../src/sandbox/types.js';

const ref = { missionId: 'm1' } as SandboxRef;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function driverWith(results: ExecResult[]): { driver: SandboxDriver; exec: jest.Mock } {
  const exec = jest.fn(async () => results.shift() ?? { code: 0, stdout: '', stderr: '' });
  return { driver: { exec } as unknown as SandboxDriver, exec };
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function localDriver(workspace: string): { driver: SandboxDriver; calls: string[][] } {
  const calls: string[][] = [];
  const driver = {
    exec: async (
      _ref: SandboxRef,
      argv: string[],
      opts?: { timeoutMs?: number; input?: string }
    ): Promise<ExecResult> => {
      calls.push(argv);
      const effective = argv.map((part) => (part === '/usr/local/bin/node' ? process.execPath : part));
      const result = spawnSync(effective[0], effective.slice(1), {
        cwd: workspace,
        input: opts?.input,
        encoding: 'utf8',
        timeout: opts?.timeoutMs,
        env: { ...process.env, NODE_OPTIONS: '--require=/definitely/hostile.js' },
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr || result.error?.message || '',
      };
    },
  } as unknown as SandboxDriver;
  return { driver, calls };
}

describe('QA workspace integrity helpers', () => {
  it('archives a stale QA report with direct argv under a sanitized forensic name', async () => {
    const { driver, exec } = driverWith([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(archiveQaReport(driver, ref, 'resume FAIL / unsafe')).resolves.toBe(true);
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['/usr/bin/test', '-f', '.impulse/qa-report.json'],
      ['/bin/mkdir', '-p', '--', '.impulse/qa-archive'],
      [
        '/bin/mv',
        '--',
        '.impulse/qa-report.json',
        '.impulse/qa-archive/resume-FAIL---unsafe.json',
      ],
    ]);
    expect(exec.mock.calls.flatMap((call) => call[1] as string[])).not.toContain('-lc');
  });

  it('returns false when there is no stale QA report to archive', async () => {
    const { driver, exec } = driverWith([{ code: 1, stdout: '', stderr: '' }]);
    await expect(archiveQaReport(driver, ref, 'missing')).resolves.toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('requires both the phase-07 report and at least one screenshot without a shell', async () => {
    const yes = driverWith([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '.impulse/screenshots/x.png\n', stderr: '' },
    ]);
    const no = driverWith([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(hasQaHandoffEvidence(yes.driver, ref)).resolves.toBe(true);
    await expect(hasQaHandoffEvidence(no.driver, ref)).resolves.toBe(false);
    expect(yes.exec.mock.calls.map((call) => call[1])).toEqual([
      ['/usr/bin/test', '-f', 'docs/07-test-report.md'],
      ['/usr/bin/find', '.impulse/screenshots', '-type', 'f', '-print', '-quit'],
    ]);
    expect(yes.exec.mock.calls.flatMap((call) => call[1] as string[])).not.toContain('sh');
  });

  it('accepts only an unambiguous full git HEAD', async () => {
    const valid = driverWith([{ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }]);
    const invalid = driverWith([{ code: 0, stdout: 'main\n', stderr: '' }]);
    await expect(readWorkspaceGitHead(valid.driver, ref)).resolves.toBe('a'.repeat(40));
    await expect(readWorkspaceGitHead(invalid.driver, ref)).resolves.toBeNull();
  });

  it('preserves both rename paths and hostile valid filenames from NUL-delimited git output', async () => {
    const { driver } = driverWith([
      {
        code: 0,
        stdout:
          'R100\0src/product.ts\0.impulse/qa-screenshots/product.ts\0M\0odd\n"name -> keep \0',
        stderr: '',
      },
      {
        code: 0,
        stdout:
          'R  .impulse/qa-screenshots/live.ts\0src/live.ts\0 M  leading and trailing \0?? new\nfile\0',
        stderr: '',
      },
    ]);
    const expected = [
      'src/product.ts',
      '.impulse/qa-screenshots/product.ts',
      'odd\n"name -> keep ',
      '.impulse/qa-screenshots/live.ts',
      'src/live.ts',
      ' leading and trailing ',
      'new\nfile',
    ].sort();
    await expect(listWorkspaceChangesSince(driver, ref, 'b'.repeat(40))).resolves.toEqual(expected);
  });

  it('fails closed for malformed or truncated NUL-delimited git output', async () => {
    const truncated = driverWith([
      { code: 0, stdout: 'M\0src/app.ts', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(listWorkspaceChangesSince(truncated.driver, ref, 'b'.repeat(40))).resolves.toEqual([
      '<workspace-integrity-unavailable>',
    ]);

    const missingRenameSource = driverWith([
      { code: 0, stdout: 'R100\0src/only-one-path.ts\0', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(listWorkspaceChangesSince(missingRenameSource.driver, ref, 'b'.repeat(40))).resolves.toEqual([
      '<workspace-integrity-unavailable>',
    ]);
  });

  it('fails closed when the baseline is invalid or git inspection fails', async () => {
    const invalid = driverWith([]);
    await expect(listWorkspaceChangesSince(invalid.driver, ref, 'main')).resolves.toEqual(['<invalid-base-head>']);

    const unavailable = driverWith([
      { code: 1, stdout: '', stderr: 'bad revision' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(listWorkspaceChangesSince(unavailable.driver, ref, 'c'.repeat(40))).resolves.toEqual([
      '<workspace-integrity-unavailable>',
    ]);
  });

  it('fingerprints ignored/runtime inputs while excluding authorized QA and derived outputs', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-review-snapshot-'));
    temporaryDirectories.push(workspace);
    write(workspace, 'src/app.ts', 'export const app=1;\n');
    write(workspace, '.env.local', 'TOKEN=one\n');
    write(workspace, 'node_modules/pkg/index.js', 'module.exports=1;\n');
    write(workspace, '.next/cache/state', 'one\n');
    write(workspace, 'coverage/coverage-final.json', '{"before":true}\n');
    write(workspace, 'node_modules/.cache/test-runner/state', 'before\n');
    write(workspace, 'line\nbreak', 'odd-one\n');
    write(workspace, '.git/config', 'hostile-one\n');
    write(workspace, '.impulse/STATUS.json', 'before\n');
    write(workspace, '.impulse/qa-report.json', 'before\n');
    write(workspace, '.impulse/qa-screenshots/desktop.png', 'before\n');
    write(workspace, '.impulse/session-4.jsonl', 'before\n');
    write(workspace, '.impulse/session-4.stderr.log', 'before\n');
    write(workspace, '.impulse/session-4.exitcode', '0\n');
    fs.mkdirSync(path.join(workspace, '.impulse/session-4.launch'));
    write(workspace, '.impulse/session-3.jsonl', 'prior\n');
    fs.symlinkSync('src/app.ts', path.join(workspace, 'entry-link'));
    const { driver, calls } = localDriver(workspace);
    const sandboxRef = { missionId: 'm', workspacePath: workspace } as SandboxRef;
    const baseline = await captureReviewerWorkspaceSnapshot(driver, sandboxRef, 4);
    expect(baseline).toEqual(expect.objectContaining({ version: 1, algorithm: 'sha256' }));
    expect(baseline!.entries).toBeGreaterThan(5);

    for (const [relative, content] of [
      ['.impulse/STATUS.json', 'after\n'],
      ['.impulse/qa-report.json', 'after\n'],
      ['.impulse/qa-screenshots/mobile.png', 'new\n'],
      ['.impulse/session-4.jsonl', 'after\n'],
      ['.git/config', 'hostile-two\n'],
      ['.next/cache/state', 'two\n'],
      ['coverage/coverage-final.json', '{"after":true}\n'],
      ['node_modules/.cache/test-runner/state', 'after\n'],
    ] as const) {
      write(workspace, relative, content);
      expect(await captureReviewerWorkspaceSnapshot(driver, sandboxRef, 4)).toEqual(baseline);
    }

    const mutations: [string, string, string][] = [
      ['.env.local', 'TOKEN=one\n', 'TOKEN=two\n'],
      ['node_modules/pkg/index.js', 'module.exports=1;\n', 'module.exports=2;\n'],
      ['line\nbreak', 'odd-one\n', 'odd-two\n'],
      ['.impulse/session-3.jsonl', 'prior\n', 'tampered\n'],
    ];
    for (const [relative, original, changed] of mutations) {
      write(workspace, relative, changed);
      expect((await captureReviewerWorkspaceSnapshot(driver, sandboxRef, 4))?.digest).not.toBe(
        baseline!.digest
      );
      write(workspace, relative, original);
      expect(await captureReviewerWorkspaceSnapshot(driver, sandboxRef, 4)).toEqual(baseline);
    }

    fs.unlinkSync(path.join(workspace, 'entry-link'));
    fs.symlinkSync('.env.local', path.join(workspace, 'entry-link'));
    expect((await captureReviewerWorkspaceSnapshot(driver, sandboxRef, 4))?.digest).not.toBe(baseline!.digest);
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i']);
    expect(argv).toContain('/usr/local/bin/node');
    expect(argv).not.toContain('sh');
    expect(argv).not.toContain('-l');
  });

  it('fails closed on invalid snapshot input and output', async () => {
    const invalidIndex = driverWith([]);
    await expect(captureReviewerWorkspaceSnapshot(invalidIndex.driver, ref, -1)).resolves.toBeNull();
    expect(invalidIndex.exec).not.toHaveBeenCalled();

    const malformed = driverWith([{ code: 0, stdout: '{not json', stderr: '' }]);
    await expect(captureReviewerWorkspaceSnapshot(malformed.driver, ref, 1)).resolves.toBeNull();
    const nonzero = driverWith([{ code: 1, stdout: '', stderr: 'failed' }]);
    await expect(captureReviewerWorkspaceSnapshot(nonzero.driver, ref, 1)).resolves.toBeNull();
  });
});
