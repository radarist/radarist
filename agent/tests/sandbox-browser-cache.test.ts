/**
 * BUILD-039 — durable check dependencies across sandbox recreation.
 *
 * Failure-first: each block first reproduces the shape of the real defect (a
 * paid BUILD-017 arm reported 16/16 browser checks failing against a workspace
 * its own builder and an independent QA reviewer had run green, because
 * recreation destroyed the container that held the browser), then proves the
 * fixed path.
 *
 * The probe branches run against a REAL shell with real files and real
 * permission bits — no Docker needed for these — because the two failure
 * vectors are precisely "file is gone" and "file exists but this uid cannot
 * execute it", and only a real filesystem can tell those apart honestly.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadBuildConfig } from '../src/sandbox/config.js';
import {
  BROWSER_CACHE_MOUNT_PATH,
  MissingCheckDependencyError,
  assertCheckDependenciesSatisfied,
  browserCacheMountFor,
  buildBrowserProbeCommand,
  checksRequireBrowser,
  probeBrowserExecutable,
  verifyCheckDependencies,
} from '../src/sandbox/browser-cache.js';
import { browserCacheVolumeNameFor } from '../src/sandbox/drivers/docker.js';
import { recreateSandboxRuntime } from '../src/sandbox/provisioner.js';
import type { Check } from '../src/sandbox/checks.js';
import type { CreateSandboxOptions, ExecResult, SandboxDriver, SandboxRef } from '../src/sandbox/types.js';

const cfg = loadBuildConfig({ env: {} });
const url = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-039-'));
  temporaryRoots.push(root);
  return root;
}

/** Run the probe exactly as authored, against the host shell. */
function runProbe(mountPath: string): ExecResult {
  const result = spawnSync('sh', ['-c', buildBrowserProbeCommand(mountPath)], { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A stand-in chromium that reports a version, like the real binary. */
function installFakeBrowser(root: string, opts: { executable: boolean; revision?: string }): string {
  const dir = path.join(root, `chromium-${opts.revision ?? '1187'}`, 'chrome-linux');
  fs.mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, 'chrome');
  fs.writeFileSync(binary, '#!/bin/sh\necho "Chromium 141.0.0.0"\n');
  fs.chmodSync(binary, opts.executable ? 0o755 : 0o644);
  return binary;
}

describe('browser probe branches (real shell, real permission bits)', () => {
  test('FAILURE-FIRST: an absent cache directory is reported, not silently passed', () => {
    const probe = runProbe(path.join(tempRoot(), 'never-created'));
    expect(probe.code).toBe(3);
    expect(probe.stderr).toContain('no browser cache directory');
  });

  test('FAILURE-FIRST: recreation wiping the browser leaves the directory but no executable', () => {
    // Exactly what the supervisor saw: /opt/ms-playwright exists (the image
    // creates it) but the mission's own browser build is gone with the layer.
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'chromium-1187'), { recursive: true });
    const probe = runProbe(root);
    expect(probe.code).toBe(4);
    expect(probe.stderr).toContain('no chromium executable');
  });

  test('FAILURE-FIRST: a surviving cache the check user cannot execute is still a broken runtime', () => {
    // The second, latent vector: checks run as `preview` (uid 1001) while the
    // image owns this path as `node`. Persistence alone would not have fixed it.
    const root = tempRoot();
    installFakeBrowser(root, { executable: false });
    const probe = runProbe(root);
    expect(probe.code).toBe(5);
    expect(probe.stderr).toContain('not executable');
  });

  test('a present, executable browser resolves and reports its version', () => {
    const root = tempRoot();
    const binary = installFakeBrowser(root, { executable: true });
    const probe = runProbe(root);
    expect(probe.code).toBe(0);
    const [resolved, version] = probe.stdout.trim().split('|');
    expect(resolved).toBe(binary);
    expect(version).toContain('Chromium');
  });
});

/**
 * Driver that models the one thing that actually broke: /opt/ms-playwright
 * lives in the container's ephemeral layer unless a named volume is bound
 * there. Destroying the container discards ephemeral content; a bound cache
 * volume survives.
 */
class EphemeralLayerDriver implements SandboxDriver {
  readonly name = 'docker' as const;
  readonly created: CreateSandboxOptions[] = [];
  readonly destroyed: Array<{ ref: SandboxRef; removeVolume: boolean }> = [];
  /** Content of the named cache volume, when one exists. */
  private cacheVolume: string | null = null;
  /** Content of the container's ephemeral browser path. */
  private ephemeral: string | null = null;
  private mountedCache = false;

  constructor(private readonly opts: { browserInstalledDuringSession: boolean }) {}

  async create(options: CreateSandboxOptions): Promise<SandboxRef> {
    this.created.push(options);
    this.mountedCache = Boolean(options.browserCacheVolume);
    this.ephemeral = null;
    if (this.opts.browserInstalledDuringSession && this.created.length === 1) {
      // The session installs its browser build into PLAYWRIGHT_BROWSERS_PATH.
      if (this.mountedCache) this.cacheVolume = '/opt/ms-playwright/chromium-1187/chrome-linux/chrome';
      else this.ephemeral = '/opt/ms-playwright/chromium-1187/chrome-linux/chrome';
    }
    return {
      driver: this.name,
      missionId: options.missionId,
      containerName: `radarist-build-${options.missionId}`,
      volumeName: `radarist_build_${options.missionId}`,
      image: options.image,
      hostPort: options.hostPort,
      workspacePath: options.workspacePath,
      browserCacheVolume: options.browserCacheVolume?.name ?? null,
    };
  }

  async destroy(ref: SandboxRef, options?: { removeVolume?: boolean }): Promise<void> {
    this.destroyed.push({ ref, removeVolume: Boolean(options?.removeVolume) });
    this.ephemeral = null; // the layer goes with the container, always
    if (options?.removeVolume) this.cacheVolume = null;
  }

  async exec(_ref: SandboxRef, argv: string[]): Promise<ExecResult> {
    const command = argv.join(' ');
    if (command.includes('MISSION.md')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('chmod')) return { code: 0, stdout: '', stderr: '' };
    if (command.includes('no browser cache directory')) {
      const resolved = this.mountedCache ? this.cacheVolume : this.ephemeral;
      return resolved
        ? { code: 0, stdout: `${resolved}|Chromium 141.0.0.0\n`, stderr: '' }
        : { code: 4, stdout: '', stderr: 'no chromium executable under /opt/ms-playwright' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async execDetached(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> {}
  async copyIn(): Promise<void> {}
  async copyOut(): Promise<void> {}
  async isRunning(): Promise<boolean> {
    return true;
  }
  async usedHostPorts(): Promise<number[]> {
    return [];
  }
}

function refFor(missionId: string): SandboxRef {
  return {
    driver: 'docker',
    missionId,
    containerName: `radarist-build-${missionId}`,
    volumeName: `radarist_build_${missionId}`,
    image: 'radarist-build-sandbox:v2',
    hostPort: 4390,
    workspacePath: '/workspace',
    browserCacheVolume: browserCacheVolumeNameFor(missionId),
  };
}

describe('a browser installed before recreation survives it', () => {
  test('FAILURE-FIRST: with no cache volume bound, recreation destroys the browser', async () => {
    const missionId = 'build-039-unfixed';
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: true });
    // Model the pre-fix runtime: create without a cache mount at all.
    const initial = await driver.create({
      missionId,
      image: 'radarist-build-sandbox:v2',
      cpus: 1,
      memoryGb: 1,
      pidsLimit: 64,
      network: 'bridge',
      hostPort: 4390,
      containerPort: 3000,
      workspacePath: '/workspace',
      env: {},
    });
    const before = await probeBrowserExecutable(driver, initial, { user: 'preview' });
    expect(before.ok).toBe(true); // builder and QA reviewer both ran it green

    await driver.destroy(initial, { removeVolume: false });
    await driver.create({
      missionId,
      image: 'radarist-build-sandbox:v2',
      cpus: 1,
      memoryGb: 1,
      pidsLimit: 64,
      network: 'bridge',
      hostPort: 4390,
      containerPort: 3000,
      workspacePath: '/workspace',
      env: {},
    });
    const after = await probeBrowserExecutable(driver, initial, { user: 'preview' });
    expect(after.ok).toBe(false); // …and the supervisor then blamed the mission
  });

  test('with the cache volume bound, the same browser is executable after recreation', async () => {
    const missionId = 'build-039-fixed';
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: true });
    const initial = await driver.create({
      missionId,
      image: 'radarist-build-sandbox:v2',
      cpus: 1,
      memoryGb: 1,
      pidsLimit: 64,
      network: 'bridge',
      hostPort: 4390,
      containerPort: 3000,
      workspacePath: '/workspace',
      env: {},
      browserCacheVolume: browserCacheMountFor(missionId, { readOnly: false }),
    });
    expect((await probeBrowserExecutable(driver, initial, { user: 'preview' })).ok).toBe(true);

    const recreated = await recreateSandboxRuntime({
      cfg,
      missionId,
      driver,
      ref: refFor(missionId),
      hostPort: 4390,
      purpose: 'preview',
    });

    const after = await probeBrowserExecutable(driver, recreated.ref, { user: 'preview' });
    expect(after.ok).toBe(true);
    expect(after.executable).toContain('chrome');
  });
});

describe('recreation binds the cache with the right ownership', () => {
  test('verification runtimes bind read-only; agent runtimes bind read-write', async () => {
    const missionId = 'build-039-mount';
    for (const [purpose, readOnly] of [
      ['preview', true],
      ['agent', false],
    ] as const) {
      const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: false });
      await recreateSandboxRuntime({
        cfg,
        missionId,
        driver,
        ref: refFor(missionId),
        hostPort: 4390,
        purpose,
        // Only the agent purpose resolves host secrets; preview gets none.
        hostEnv: { ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' },
      });
      const mount = driver.created.at(-1)?.browserCacheVolume;
      expect(mount).toEqual({
        name: browserCacheVolumeNameFor(missionId),
        mountPath: BROWSER_CACHE_MOUNT_PATH,
        readOnly,
      });
    }
  });

  test('recreation never removes the cache volume — that is the whole point', async () => {
    const missionId = 'build-039-retain';
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: true });
    await recreateSandboxRuntime({
      cfg,
      missionId,
      driver,
      ref: refFor(missionId),
      hostPort: 4390,
      purpose: 'preview',
    });
    expect(driver.destroyed.every((d) => d.removeVolume === false)).toBe(true);
  });

  test('the cache volume name is per-mission, so one mission can never read another', () => {
    expect(browserCacheVolumeNameFor('a')).not.toBe(browserCacheVolumeNameFor('b'));
    expect(browserCacheVolumeNameFor('a')).not.toBe('radarist_build_a');
  });
});

describe('missing dependencies fail before another paid session', () => {
  const browserCheck: Check = {
    id: 's1',
    story: 'S1',
    files: [],
    command: 'npx playwright test tests/e2e/s1.spec.ts',
  };
  const unitCheck: Check = { id: 'u1', story: 'U1', files: [], command: 'npm test -- --run' };

  test('browser-driven checks are detected; unit-only checks are not', () => {
    expect(checksRequireBrowser([browserCheck])).toBe(true);
    expect(checksRequireBrowser([unitCheck])).toBe(false);
    expect(checksRequireBrowser([unitCheck, browserCheck])).toBe(true);
  });

  test('a mission with no browser checks is satisfied without probing', async () => {
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: false });
    const verdict = await verifyCheckDependencies(driver, refFor('m'), [unitCheck], { user: 'preview' });
    expect(verdict).toMatchObject({ required: false, satisfied: true });
  });

  test('FAILURE-FIRST: a broken runtime refuses acceptance instead of blaming the mission', async () => {
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: false });
    await expect(
      assertCheckDependenciesSatisfied(driver, refFor('m'), [browserCheck], { user: 'preview' })
    ).rejects.toBeInstanceOf(MissingCheckDependencyError);
  });

  test('a satisfied runtime returns a verdict and runs checks normally', async () => {
    const driver = new EphemeralLayerDriver({ browserInstalledDuringSession: true });
    const ref = await driver.create({
      missionId: 'm',
      image: 'radarist-build-sandbox:v2',
      cpus: 1,
      memoryGb: 1,
      pidsLimit: 64,
      network: 'bridge',
      hostPort: 4390,
      containerPort: 3000,
      workspacePath: '/workspace',
      env: {},
      browserCacheVolume: browserCacheMountFor('m', { readOnly: true }),
    });
    const verdict = await assertCheckDependenciesSatisfied(driver, ref, [browserCheck], { user: 'preview' });
    expect(verdict).toMatchObject({ required: true, satisfied: true });
  });
});

test('the mount path matches the image PLAYWRIGHT_BROWSERS_PATH', () => {
  // A drift here would persist bytes that Playwright never looks at.
  const dockerfile = fs.readFileSync(url('../src/sandbox/template/Dockerfile'), 'utf8');
  const declared = /^ENV\s+PLAYWRIGHT_BROWSERS_PATH=(\S+)\s*$/m.exec(dockerfile);
  expect(declared?.[1]).toBe(BROWSER_CACHE_MOUNT_PATH);
});
