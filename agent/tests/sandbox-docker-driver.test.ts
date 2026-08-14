/** DockerDriver unit tests — injected ExecFn, exact argv assertions. */
import { DockerDriver, containerNameFor, volumeNameFor } from '../src/sandbox/drivers/docker.js';
import { pickHostPort, type ExecFn, type ExecResult, type SandboxRef } from '../src/sandbox/types.js';

function mockExec(responses?: (cmd: string, args: string[]) => Partial<ExecResult> | undefined) {
  const calls: { cmd: string; args: string[]; opts?: { timeoutMs?: number; input?: string } }[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const override = responses?.(cmd, args);
    return { code: 0, stdout: '', stderr: '', ...override };
  };
  return { exec, calls };
}

const ref: SandboxRef = {
  driver: 'docker',
  missionId: 'm1',
  containerName: containerNameFor('m1'),
  volumeName: volumeNameFor('m1'),
  image: 'radarist-build-sandbox:v1',
  hostPort: 4123,
  workspacePath: '/workspace',
};

describe('DockerDriver', () => {
  it('creates volume + container with resource limits, host-gateway, port, env, labels', async () => {
    const { exec, calls } = mockExec();
    const driver = new DockerDriver({ exec });
    const created = await driver.create({
      missionId: 'mission-42/x',
      image: 'img:v1',
      cpus: 2,
      memoryGb: 4,
      pidsLimit: 512,
      network: 'bridge',
      hostPort: 4101,
      containerPort: 3000,
      workspacePath: '/workspace',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });

    expect(calls[0].args).toEqual(['volume', 'create', 'radarist_build_mission-42-x']);
    const run = calls[1].args;
    expect(run.slice(0, 2)).toEqual(['run', '--detach']);
    for (const expected of [
      ['--name', 'radarist-build-mission-42-x'],
      ['--cpus', '2'],
      ['--memory', '4g'],
      ['--pids-limit', '512'],
      ['--network', 'bridge'],
      ['-p', '127.0.0.1:4101:3000'],
      ['-v', 'radarist_build_mission-42-x:/workspace'],
      ['-e', 'ANTHROPIC_API_KEY=sk-test'],
      ['--label', 'radarist.build.mission=mission-42/x'],
      ['--label', 'radarist.build.hostPort=4101'],
    ]) {
      const idx = run.findIndex((a, i) => a === expected[0] && run[i + 1] === expected[1]);
      expect(idx).toBeGreaterThan(-1);
    }
    expect(run).toContain('--add-host=host.docker.internal:host-gateway');
    expect(run).toContain('--init');
    expect(run[run.length - 1]).toBe('img:v1');
    expect(created.hostPort).toBe(4101);
  });

  it('exec runs inside the workspace and adds an explicit user only when requested', async () => {
    const { exec, calls } = mockExec();
    const driver = new DockerDriver({ exec });
    await driver.exec(ref, ['cat', 'x']);
    expect(calls[0].args).toEqual(['exec', '--workdir', '/workspace', ref.containerName, 'cat', 'x']);
    await driver.exec(ref, ['cat', 'root-only'], { user: 'root', input: 'trusted wrapper' });
    expect(calls[1].args).toEqual([
      'exec',
      '--interactive',
      '--user',
      'root',
      '--workdir',
      '/workspace',
      ref.containerName,
      'cat',
      'root-only',
    ]);
    expect(calls[1].opts?.input).toBe('trusted wrapper');
    await driver.execDetached(ref, ['sh', '-lc', 'run'], { user: 'root' });
    expect(calls[2].args).toEqual([
      'exec',
      '--detach',
      '--user',
      'root',
      '--workdir',
      '/workspace',
      ref.containerName,
      'sh',
      '-lc',
      'run',
    ]);
  });

  it('stop keeps the volume; destroy removes it only when asked', async () => {
    const { exec, calls } = mockExec();
    const driver = new DockerDriver({ exec });
    await driver.stop(ref);
    await driver.destroy(ref);
    await driver.destroy(ref, { removeVolume: true });
    const volumeRms = calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'rm');
    expect(calls[0].args[0]).toBe('stop');
    // BUILD-039: cleanup owns BOTH named volumes — the workspace and the
    // check-dependency cache. Recreation still passes removeVolume:false, so
    // the cache survives exactly where it must and nowhere else.
    expect(volumeRms.map((c) => c.args[2])).toEqual(['radarist_build_m1', 'radarist_build_browsers_m1']);
  });

  it('fails closed when docker stop cannot stop the credential-bearing runtime', async () => {
    const { exec } = mockExec((_cmd, args) =>
      args[0] === 'stop' ? { code: 1, stderr: 'container refused to stop' } : undefined
    );
    const driver = new DockerDriver({ exec });

    await expect(driver.stop(ref)).rejects.toThrow(/docker stop failed.*container refused to stop/);
  });

  it('destroy is idempotent only for an explicitly missing container or volume', async () => {
    const { exec } = mockExec((_cmd, args) => {
      if (args[0] === 'rm') return { code: 1, stderr: 'Error: No such container: radarist-build-m1' };
      if (args[0] === 'volume') return { code: 1, stderr: 'Error: No such volume: radarist_build_m1' };
      return undefined;
    });
    await expect(new DockerDriver({ exec }).destroy(ref, { removeVolume: true })).resolves.toBeUndefined();
  });

  it('destroy fails closed on daemon or permission failures', async () => {
    const daemon = new DockerDriver({
      exec: async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    });
    await expect(daemon.destroy(ref)).rejects.toThrow(/Cannot connect to the Docker daemon/);

    const volumeDenied = new DockerDriver({
      exec: async (_cmd, args) =>
        args[0] === 'rm' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'permission denied' },
    });
    await expect(volumeDenied.destroy(ref, { removeVolume: true })).rejects.toThrow(/permission denied/);
  });

  it('isRunning distinguishes absent containers from inspect failures and malformed output', async () => {
    const missing = new DockerDriver({
      exec: async () => ({ code: 1, stdout: '', stderr: 'Error: No such container: radarist-build-m1' }),
    });
    await expect(missing.isRunning(ref)).resolves.toBe(false);

    const daemon = new DockerDriver({
      exec: async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    });
    await expect(daemon.isRunning(ref)).rejects.toThrow(/Cannot connect to the Docker daemon/);

    const malformed = new DockerDriver({
      exec: async () => ({ code: 0, stdout: 'unknown\n', stderr: '' }),
    });
    await expect(malformed.isRunning(ref)).rejects.toThrow(/invalid running state/);
  });

  it('copyOut shells `docker cp container:path host:path` (harvest direction)', async () => {
    const { exec, calls } = mockExec();
    const driver = new DockerDriver({ exec });
    await driver.copyOut(ref, '/tmp/harvest.tgz', 'tmp/build-harvests/m1.tgz');
    expect(calls[0].args).toEqual(['cp', `${ref.containerName}:/tmp/harvest.tgz`, 'tmp/build-harvests/m1.tgz']);
  });

  it('throws with stderr context when a must-succeed command fails', async () => {
    const { exec } = mockExec((_cmd, args) => (args[0] === 'volume' ? { code: 1, stderr: 'daemon down' } : undefined));
    const driver = new DockerDriver({ exec });
    await expect(
      driver.create({
        missionId: 'm',
        image: 'i',
        cpus: 1,
        memoryGb: 1,
        pidsLimit: 512,
        network: 'bridge',
        hostPort: 4100,
        containerPort: 3000,
        workspacePath: '/workspace',
        env: {},
      })
    ).rejects.toThrow(/daemon down/);
  });

  it('usedHostPorts parses label output and tolerates failure', async () => {
    const { exec } = mockExec((_cmd, args) => (args[0] === 'ps' ? { stdout: '4101\n\n4105\nx\n' } : undefined));
    const driver = new DockerDriver({ exec });
    expect(await driver.usedHostPorts()).toEqual([4101, 4105]);

    const failing = new DockerDriver({ exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(await failing.usedHostPorts()).toEqual([]);
  });

  it('rejects an invalid PID budget before creating a volume or container', async () => {
    const { exec, calls } = mockExec();
    const create = (pidsLimit: number) =>
      new DockerDriver({ exec }).create({
        missionId: 'invalid-pids',
        image: 'img:v1',
        cpus: 1,
        memoryGb: 1,
        pidsLimit,
        network: 'bridge',
        hostPort: 4100,
        containerPort: 3000,
        workspacePath: '/workspace',
        env: {},
      });

    await expect(create(0)).rejects.toThrow(/PID limit/i);
    await expect(create(512.5)).rejects.toThrow(/PID limit/i);
    await expect(create(4097)).rejects.toThrow(/PID limit/i);
    expect(calls).toHaveLength(0);
  });

  it('reports bounded cgroup PID usage and zombie count without mutating the container', async () => {
    const { exec, calls } = mockExec((_cmd, args) => {
      if (args[0] === 'exec') {
        return { stdout: 'current=37\npeak=141\nlimit=512\n' };
      }
      if (args[0] === 'top') {
        return { stdout: 'PID STAT\n1 Ss\n10 Z\n11 Z+\n12 Sl\n' };
      }
      return undefined;
    });
    const telemetry = await new DockerDriver({ exec }).processTelemetry(ref);

    expect(telemetry).toEqual({ current: 37, peak: 141, limit: 512, zombies: 2 });
    expect(calls.map((call) => call.args[0])).toEqual(['exec', 'top']);
    expect(calls.some((call) => ['run', 'start', 'stop', 'rm'].includes(call.args[0]))).toBe(false);
  });

  it('surfaces unavailable peak telemetry honestly and rejects malformed counters', async () => {
    const unavailable = mockExec((_cmd, args) =>
      args[0] === 'exec' ? { stdout: 'current=12\npeak=unavailable\nlimit=512\n' } : { stdout: 'PID STAT\n1 S\n' }
    );
    await expect(new DockerDriver({ exec: unavailable.exec }).processTelemetry(ref)).resolves.toEqual({
      current: 12,
      peak: null,
      limit: 512,
      zombies: 0,
    });

    const malformed = mockExec((_cmd, args) =>
      args[0] === 'exec' ? { stdout: 'current=not-a-number\npeak=14\nlimit=512\n' } : { stdout: 'PID STAT\n1 S\n' }
    );
    await expect(new DockerDriver({ exec: malformed.exec }).processTelemetry(ref)).rejects.toThrow(
      /invalid current PID telemetry/i
    );
  });
});

describe('pickHostPort', () => {
  it('is deterministic per mission and probes past taken ports', () => {
    const first = pickHostPort('mission-a', 4100, 4109, []);
    expect(pickHostPort('mission-a', 4100, 4109, [])).toBe(first);
    expect(pickHostPort('mission-a', 4100, 4109, [first])).not.toBe(first);
  });

  it('throws when the range is exhausted', () => {
    const all = [4100, 4101, 4102];
    expect(() => pickHostPort('m', 4100, 4102, all)).toThrow(/No free host port/);
  });
});
