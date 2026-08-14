/**
 * BUILD-037 real-Docker acceptance.
 *
 * Guarded because the normal unit lane must not require Docker. The test owns
 * a unique `build-037-disposable-*` container and volume and removes both in a
 * finally block. It never enumerates, stops, or mutates any retained sandbox.
 *
 * Run explicitly:
 *   RUN_SANDBOX_DOCKER_LIFECYCLE=1 npm test --prefix agent -- \
 *     --runInBand tests/sandbox-docker-lifecycle.integration.test.ts
 */
import {
  DockerDriver,
  containerNameFor,
  defaultExec,
  volumeNameFor,
} from '../src/sandbox/drivers/docker.js';
import type { SandboxRef } from '../src/sandbox/types.js';

const enabled = process.env.RUN_SANDBOX_DOCKER_LIFECYCLE === '1';
const testDocker = enabled ? test : test.skip;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

testDocker(
  'real init reaps repeated orphan cycles and stop/resume preserves the volume without PID leakage',
  async () => {
    const missionId = `build-037-disposable-${process.pid}-${Date.now()}`;
    const driver = new DockerDriver();
    let ref: SandboxRef | null = null;

    try {
      ref = await driver.create({
        missionId,
        image: process.env.IMPULSE_BUILD_SANDBOX_IMAGE_FOR_TEST || 'radarist-build-sandbox:v2',
        cpus: 1,
        memoryGb: 1,
        pidsLimit: 64,
        network: 'bridge',
        hostPort: 4198,
        containerPort: 3000,
        workspacePath: '/workspace',
        env: {},
      });

      const ready = await driver.exec(ref, ['sh', '-c', 'test -d /workspace && test -r /proc/1/comm']);
      expect(ready.code).toBe(0);

      const inspect = await defaultExec('docker', [
        'inspect',
        '--format',
        '{{json .HostConfig.Init}} {{.HostConfig.PidsLimit}}',
        ref.containerName,
      ]);
      expect(inspect.code).toBe(0);
      expect(inspect.stdout.trim()).toBe('true 64');

      const init = await driver.exec(ref, ['cat', '/proc/1/comm']);
      expect(init.code).toBe(0);
      expect(init.stdout.trim()).toMatch(/docker-init|tini/i);

      const baseline = await driver.processTelemetry(ref);
      expect(baseline.limit).toBe(64);
      expect(baseline.zombies).toBe(0);

      // Synchronous build/test hooks plus deliberately orphaned short children.
      for (let cycle = 0; cycle < 20; cycle++) {
        const hook = await driver.exec(ref, ['sh', '-c', 'node -e "process.exit(0)" && true']);
        expect(hook.code).toBe(0);
        await driver.execDetached(ref, ['sh', '-c', 'sleep 0.02 & exit 0']);
      }
      await wait(500);
      const afterCycles = await driver.processTelemetry(ref);
      expect(afterCycles.zombies).toBe(0);
      expect(afterCycles.current).toBeLessThanOrEqual(baseline.current + 4);
      expect(afterCycles.peak).not.toBeNull();
      expect(afterCycles.peak as number).toBeLessThanOrEqual(64);

      // A stop is the sandbox cancel/timeout boundary. It must kill the whole
      // namespace; resume creates a clean init while reusing the named volume.
      await driver.execDetached(ref, ['sh', '-c', 'sleep 30 & wait']);
      await wait(100);
      await driver.stop(ref);
      await driver.resume(ref);
      await wait(250);

      const afterResume = await driver.processTelemetry(ref);
      expect(afterResume.limit).toBe(64);
      expect(afterResume.zombies).toBe(0);
      expect(afterResume.current).toBeLessThanOrEqual(baseline.current + 4);
      expect(ref.volumeName).toBe(volumeNameFor(missionId));
      expect(ref.containerName).toBe(containerNameFor(missionId));
    } finally {
      if (ref) await driver.destroy(ref, { removeVolume: true });
    }
  },
  60_000
);
