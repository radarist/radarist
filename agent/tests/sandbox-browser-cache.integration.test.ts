/**
 * BUILD-039 real-Docker acceptance.
 *
 * Proves the headline claim with real containers, real volumes and real uids:
 * a browser installed BEFORE the sandbox is recreated is still independently
 * executable AFTER it, as the `preview` user that actually runs acceptance
 * checks — and that the runtime keeps its isolation while doing so.
 *
 * Guarded because the normal unit lane must not require Docker. The test owns
 * a unique `build-039-disposable-*` container and its two named volumes,
 * asserts an exact census before and after, and removes everything it made in
 * a finally block. It never enumerates, stops, or mutates any retained
 * sandbox, mission volume, or Neo4j container.
 *
 * Run explicitly:
 *   RUN_SANDBOX_BROWSER_CACHE=1 npm test --prefix agent -- \
 *     --runInBand tests/sandbox-browser-cache.integration.test.ts
 */
import { loadBuildConfig } from '../src/sandbox/config.js';
import {
  DockerDriver,
  browserCacheVolumeNameFor,
  containerNameFor,
  defaultExec,
  volumeNameFor,
} from '../src/sandbox/drivers/docker.js';
import {
  BROWSER_CACHE_MOUNT_PATH,
  browserCacheMountFor,
  probeBrowserExecutable,
} from '../src/sandbox/browser-cache.js';
import { recreateSandboxRuntime } from '../src/sandbox/provisioner.js';
import type { SandboxRef } from '../src/sandbox/types.js';

const enabled = process.env.RUN_SANDBOX_BROWSER_CACHE === '1';
const testDocker = enabled ? test : test.skip;
const cfg = loadBuildConfig({ env: {} });

/** Names of every build container/volume Docker currently knows about. */
async function census(): Promise<{ containers: string[]; volumes: string[] }> {
  const containers = await defaultExec('docker', ['ps', '--all', '--format', '{{.Names}}']);
  const volumes = await defaultExec('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  return {
    containers: containers.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort(),
    volumes: volumes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort(),
  };
}

testDocker(
  'a browser installed before recreation stays executable after it, without weakening isolation',
  async () => {
    const missionId = `build-039-disposable-${process.pid}-${Date.now()}`;
    const driver = new DockerDriver();
    const before = await census();
    let ref: SandboxRef | null = null;

    try {
      ref = await driver.create({
        missionId,
        image: process.env.IMPULSE_BUILD_SANDBOX_IMAGE_FOR_TEST || 'radarist-build-sandbox:v2',
        cpus: 1,
        memoryGb: 2,
        pidsLimit: 128,
        network: 'bridge',
        hostPort: 4411,
        containerPort: 3000,
        workspacePath: '/workspace',
        env: {},
        browserCacheVolume: browserCacheMountFor(missionId, { readOnly: false }),
      });
      expect(ref.browserCacheVolume).toBe(browserCacheVolumeNameFor(missionId));

      // The cache volume initializes from the image's baked browser path, so a
      // real chromium is present without a 200MB download.
      const baked = await probeBrowserExecutable(driver, ref, { user: 'node' });
      expect(baked.ok).toBe(true);
      expect(baked.detail).toMatch(/Chromium/i);

      // Simulate what actually broke: the mission installs ITS OWN browser
      // build into PLAYWRIGHT_BROWSERS_PATH during a paid session, as `node`.
      const missionBuild = `${BROWSER_CACHE_MOUNT_PATH}/chromium-build039/chrome-linux`;
      const install = await driver.exec(
        ref,
        ['sh', '-c', `mkdir -p ${missionBuild} && cp "${baked.executable}" ${missionBuild}/chrome`],
        { user: 'node', timeoutMs: 120_000 }
      );
      expect(install.code).toBe(0);

      const beforeRecreate = await driver.exec(ref, ['sh', '-c', `${missionBuild}/chrome --version`], {
        user: 'node',
        timeoutMs: 60_000,
      });
      expect(beforeRecreate.code).toBe(0);

      // recreateSandboxRuntime probes for a real mission workspace before it
      // trusts the volume, so give it the three markers it requires.
      const seed = await driver.exec(
        ref,
        ['sh', '-c', 'git init -q . && touch MISSION.md && mkdir -p .impulse && echo "{}" > .impulse/STATUS.json'],
        { user: 'node', timeoutMs: 60_000 }
      );
      expect(seed.code).toBe(0);

      // ── The credential boundary: destroy the container, keep the volumes. ──
      const recreated = await recreateSandboxRuntime({
        cfg,
        missionId,
        driver,
        ref,
        hostPort: ref.hostPort,
        purpose: 'preview',
      });
      ref = recreated.ref;

      // THE ACCEPTANCE: the mission-installed browser is still there, and the
      // preview uid — not the uid that installed it — can execute it.
      const afterRecreate = await driver.exec(ref, ['sh', '-c', `${missionBuild}/chrome --version`], {
        user: 'preview',
        timeoutMs: 60_000,
      });
      expect(afterRecreate.code).toBe(0);
      expect(afterRecreate.stdout).toMatch(/Chromium/i);

      const probeAsPreview = await probeBrowserExecutable(driver, ref, { user: 'preview' });
      expect(probeAsPreview.ok).toBe(true);

      // Isolation must not have been traded away for that persistence.
      const readOnly = await driver.exec(
        ref,
        ['sh', '-c', `touch ${BROWSER_CACHE_MOUNT_PATH}/tamper 2>&1 || echo REFUSED`],
        { user: 'preview', timeoutMs: 60_000 }
      );
      expect(readOnly.stdout).toContain('REFUSED');

      // Widening read access on the browser cache must not have widened
      // anything else. Apply the same retained-workspace lock the supervisor
      // applies after recreation, then prove `preview` is still shut out of it.
      for (const argv of [
        ['/bin/chown', 'node:node', '--', '/workspace'],
        ['/bin/chmod', '0700', '--', '/workspace'],
      ]) {
        const locked = await driver.exec(ref, argv, { user: 'root', timeoutMs: 60_000 });
        expect(locked.code).toBe(0);
      }
      const workspaceLocked = await driver.exec(ref, ['sh', '-c', 'cat /workspace/MISSION.md 2>&1 || echo DENIED'], {
        user: 'preview',
        timeoutMs: 60_000,
      });
      expect(`${workspaceLocked.stdout}${workspaceLocked.stderr}`).toMatch(/DENIED|Permission denied/);

      const mounts = await defaultExec('docker', [
        'inspect',
        '--format',
        '{{range .Mounts}}{{.Name}}:{{.Destination}}:{{.RW}} {{end}}',
        ref.containerName,
      ]);
      expect(mounts.stdout).toContain(`${browserCacheVolumeNameFor(missionId)}:${BROWSER_CACHE_MOUNT_PATH}:false`);
      expect(mounts.stdout).toContain(`${volumeNameFor(missionId)}:/workspace:true`);
    } finally {
      if (ref) await driver.destroy(ref, { removeVolume: true });
    }

    // Zero residue: exact census equality, both directions.
    const after = await census();
    expect(after.containers).toEqual(before.containers);
    expect(after.volumes).toEqual(before.volumes);
    expect(after.containers).not.toContain(containerNameFor(missionId));
    expect(after.volumes).not.toContain(browserCacheVolumeNameFor(missionId));
  },
  600_000
);
