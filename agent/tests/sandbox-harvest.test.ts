/**
 * harvestArtifact adversarial tests. A null result is a hard reclaim veto:
 * callers must keep the named volume and retry on a later GC pass.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { harvestArtifact } from '../src/sandbox/harvest.js';
import type { ExecResult, SandboxDriver, SandboxExecOptions, SandboxRef } from '../src/sandbox/types.js';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const ARCHIVE_BYTES = Buffer.from('verified archive bytes');
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

const ref: SandboxRef = {
  driver: 'docker',
  missionId: 'm-harvest-1',
  containerName: 'radarist-build-m-harvest-1',
  volumeName: 'radarist_build_m-harvest-1',
  image: 'radarist-build-sandbox:v1',
  hostPort: 4123,
  workspacePath: '/workspace',
};

type ExecHook = (
  argv: string[],
  options: SandboxExecOptions | undefined
) => ExecResult | undefined | Promise<ExecResult | undefined>;

function successResult(argv: string[]): ExecResult {
  const gitIndex = argv.indexOf('/usr/bin/git');
  if (gitIndex >= 0) {
    const args = argv.slice(gitIndex + 1);
    if (args[0] === 'rev-parse' && args[2]?.endsWith('^{tree}')) {
      return { code: 0, stdout: `${TREE}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (args[0] === 'write-tree') return { code: 0, stdout: `${TREE}\n`, stderr: '' };
  }
  if (argv.includes('-tzf')) {
    return { code: 0, stdout: '.impulse/\n.impulse/repo.bundle\n', stderr: '' };
  }
  if (argv.includes('/usr/bin/sha256sum')) {
    return { code: 0, stdout: `${ARCHIVE_SHA256}  /tmp/harvest.tgz\n`, stderr: '' };
  }
  if (argv.includes('/usr/bin/stat')) {
    return { code: 0, stdout: `${ARCHIVE_BYTES.length}\n`, stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
}

function fakeDriver(options: { exec?: ExecHook; copyOut?: SandboxDriver['copyOut'] } = {}): {
  driver: SandboxDriver;
  execCalls: Array<{ argv: string[]; options: SandboxExecOptions | undefined }>;
  copyOutCalls: Array<{ container: string; host: string }>;
} {
  const execCalls: Array<{ argv: string[]; options: SandboxExecOptions | undefined }> = [];
  const copyOutCalls: Array<{ container: string; host: string }> = [];
  const driver: SandboxDriver = {
    name: 'docker',
    create: async () => ref,
    exec: async (_ref, argv, execOptions) => {
      execCalls.push({ argv, options: execOptions });
      const override = await options.exec?.(argv, execOptions);
      return override ?? successResult(argv);
    },
    execDetached: async () => undefined,
    copyIn: async () => undefined,
    copyOut: async (sandboxRef, container, host) => {
      copyOutCalls.push({ container, host });
      if (options.copyOut) return options.copyOut(sandboxRef, container, host);
      fs.writeFileSync(host, ARCHIVE_BYTES);
    },
    stop: async () => undefined,
    resume: async () => undefined,
    destroy: async () => undefined,
    isRunning: async () => true,
    usedHostPorts: async () => [],
  };
  return { driver, execCalls, copyOutCalls };
}

function gitArgs(argv: string[]): string[] | null {
  const index = argv.indexOf('/usr/bin/git');
  return index < 0 ? null : argv.slice(index + 1);
}

describe('harvestArtifact', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resets trusted Git state, verifies the bundle, and copies a verified archive', async () => {
    const { driver, execCalls, copyOutCalls } = fakeDriver();

    const result = await harvestArtifact(driver, ref, dir, ref.missionId);

    const expected = path.join(dir, `${ref.missionId}.tgz`);
    expect(result).toEqual({
      bundlePath: expected,
      sha256: ARCHIVE_SHA256,
      bytes: ARCHIVE_BYTES.length,
    });
    expect(fs.readFileSync(expected, 'utf8')).toBe('verified archive bytes');
    expect(fs.statSync(expected).mode & 0o777).toBe(0o600);
    expect(copyOutCalls).toHaveLength(1);
    expect(copyOutCalls[0].container).toBe('/tmp/harvest.tgz');
    expect(path.dirname(copyOutCalls[0].host)).toBe(dir);
    expect(path.basename(copyOutCalls[0].host)).toMatch(/^\.m-harvest-1\.tgz\..+\.tmp$/);

    const calls = execCalls.map((call) => call.argv);
    const gitCalls = calls.map(gitArgs).filter((args): args is string[] => args !== null);
    expect(gitCalls).toEqual(
      expect.arrayContaining([
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        ['read-tree', '--reset', HEAD],
        ['rev-parse', '--verify', `${HEAD}^{tree}`],
        ['write-tree'],
        ['bundle', 'create', '.impulse/repo.bundle', '--all'],
        ['bundle', 'verify', '.impulse/repo.bundle'],
      ])
    );
    const bundleCreate = calls.findIndex((argv) => gitArgs(argv)?.[0] === 'bundle');
    const writeTree = calls.findIndex((argv) => gitArgs(argv)?.[0] === 'write-tree');
    expect(bundleCreate).toBeGreaterThan(writeTree);

    const tarCreate = execCalls.find((call) => call.argv.includes('-czf'))!;
    const tarList = execCalls.find((call) => call.argv.includes('-tzf'))!;
    for (const call of [tarCreate, tarList]) {
      expect(call.argv.slice(0, 7)).toEqual([
        '/usr/bin/env',
        '-i',
        'HOME=/nonexistent',
        'XDG_CONFIG_HOME=/nonexistent',
        'PATH=/usr/bin:/bin',
        'LANG=C',
        'LC_ALL=C',
      ]);
      expect(call.options).toEqual(expect.objectContaining({ user: 'node' }));
    }
  });

  it('does not invoke a login shell even when a workspace profile is poisoned', async () => {
    const { driver, execCalls } = fakeDriver({
      exec: async (argv) => {
        if (argv.includes('-l') || argv.includes('-lc')) throw new Error('poisoned profile executed');
        return undefined;
      },
    });

    const result = await harvestArtifact(driver, ref, dir, ref.missionId);

    expect(result).not.toBeNull();
    for (const { argv } of execCalls) {
      expect(argv).not.toContain('-l');
      expect(argv).not.toContain('-lc');
    }
    const fixedShellCalls = execCalls.filter((call) => call.argv.includes('/bin/sh'));
    expect(fixedShellCalls.length).toBeGreaterThan(0);
    for (const call of fixedShellCalls) {
      expect(call.argv).toContain('-c');
      expect(call.argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i']);
    }
  });

  it('returns null when Git bundle creation fails', async () => {
    const { driver, copyOutCalls } = fakeDriver({
      exec: async (argv) => {
        const args = gitArgs(argv);
        return args?.[0] === 'bundle' && args[1] === 'create'
          ? { code: 1, stdout: '', stderr: 'bundle failed' }
          : undefined;
      },
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(copyOutCalls).toHaveLength(0);
  });

  it('returns null when Git bundle verification fails', async () => {
    const { driver, copyOutCalls } = fakeDriver({
      exec: async (argv) => {
        const args = gitArgs(argv);
        return args?.[0] === 'bundle' && args[1] === 'verify'
          ? { code: 1, stdout: '', stderr: 'invalid bundle' }
          : undefined;
      },
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(copyOutCalls).toHaveLength(0);
  });

  it('returns null and removes partial output when copyOut fails', async () => {
    const expected = path.join(dir, `${ref.missionId}.tgz`);
    const { driver } = fakeDriver({
      copyOut: async (_sandboxRef, _container, host) => {
        fs.writeFileSync(host, 'partial');
        throw new Error('docker cp failed');
      },
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(fs.existsSync(expected)).toBe(false);
  });

  it('keeps a prior verified bundle when a replacement copy fails', async () => {
    const expected = path.join(dir, `${ref.missionId}.tgz`);
    fs.writeFileSync(expected, 'prior verified bundle');
    const { driver } = fakeDriver({
      copyOut: async (_sandboxRef, _container, host) => {
        fs.writeFileSync(host, 'partial replacement');
        throw new Error('docker cp failed');
      },
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(fs.readFileSync(expected, 'utf8')).toBe('prior verified bundle');
  });

  it('rejects a copied archive whose bytes do not match the container digest', async () => {
    const expected = path.join(dir, `${ref.missionId}.tgz`);
    const { driver } = fakeDriver({
      copyOut: async (_sandboxRef, _container, host) => fs.writeFileSync(host, 'corrupt but non-empty'),
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(fs.existsSync(expected)).toBe(false);
  });

  it('rejects an unavailable or empty copied archive', async () => {
    const expected = path.join(dir, `${ref.missionId}.tgz`);
    const { driver } = fakeDriver({
      copyOut: async (_sandboxRef, _container, host) => fs.writeFileSync(host, ''),
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(fs.existsSync(expected)).toBe(false);
  });

  it('rejects a symlinked host output instead of accepting its target', async () => {
    const target = path.join(dir, 'target.tgz');
    const expected = path.join(dir, `${ref.missionId}.tgz`);
    fs.writeFileSync(target, 'not a new copied archive');
    const { driver } = fakeDriver({
      copyOut: async (_sandboxRef, _container, host) => fs.symlinkSync(target, host),
    });

    await expect(harvestArtifact(driver, ref, dir, ref.missionId)).resolves.toBeNull();
    expect(fs.existsSync(expected)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('rejects an unsafe mission id before executing or copying anything', async () => {
    const { driver, execCalls, copyOutCalls } = fakeDriver();

    await expect(harvestArtifact(driver, ref, dir, '../../escape')).resolves.toBeNull();
    expect(execCalls).toHaveLength(0);
    expect(copyOutCalls).toHaveLength(0);
  });

  it('normalizes a trailing slash in the harvest directory', async () => {
    const { driver } = fakeDriver();
    await expect(harvestArtifact(driver, ref, `${dir}/`, ref.missionId)).resolves.toEqual({
      bundlePath: path.join(dir, `${ref.missionId}.tgz`),
      sha256: ARCHIVE_SHA256,
      bytes: ARCHIVE_BYTES.length,
    });
  });
});
