/**
 * Docker implementation of SandboxDriver.
 *
 * All docker invocations go through an injected ExecFn (argv form, no
 * shell), which makes the driver fully unit-testable and keeps host-side
 * command construction injection-safe. Naming follows repo conventions:
 * container `radarist-build-<missionId>`, volume `radarist_build_<missionId>`.
 *
 * `--add-host=host.docker.internal:host-gateway` is always set so the
 * in-container MCP base URL works identically on macOS and Linux.
 */
import { execFile } from 'child_process';
import { sandboxPidsLimitSchema } from '../config.js';
import type {
  CreateSandboxOptions,
  ExecFn,
  ExecResult,
  SandboxDetachedExecOptions,
  SandboxDriver,
  SandboxExecOptions,
  SandboxRef,
  SandboxProcessTelemetry,
} from '../types.js';

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_TELEMETRY_VALUE = 10_000_000;
const MAX_TOP_OUTPUT_BYTES = 1024 * 1024;

// Static trusted script: no mission or user-controlled value is interpolated.
// It supports cgroup v2 and the legacy v1 pids-controller paths. Older kernels
// do not expose pids.peak; that is reported as unavailable, never fabricated.
const READ_CGROUP_PID_METRICS = `
read_first() {
  for path in "$@"; do
    if [ -r "$path" ]; then
      cat "$path"
      return 0
    fi
  done
  printf unavailable
}
printf 'current=%s\n' "$(read_first /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids/pids.current)"
printf 'peak=%s\n' "$(read_first /sys/fs/cgroup/pids.peak /sys/fs/cgroup/pids/pids.peak)"
printf 'limit=%s\n' "$(read_first /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids/pids.max)"
`.trim();

function dockerDetail(result: ExecResult): string {
  return (result.stderr || result.stdout).trim();
}

function explicitlyMissing(result: ExecResult, object: 'container' | 'volume'): boolean {
  const detail = dockerDetail(result);
  return object === 'container' ? /no such container/i.test(detail) : /no such volume/i.test(detail);
}

function parseMetric(output: string, key: 'current' | 'peak' | 'limit', allowUnavailable: boolean): number | null {
  const match = output.match(new RegExp(`^${key}=([^\\r\\n]+)$`, 'm'));
  const raw = match?.[1]?.trim();
  if (allowUnavailable && (raw === 'unavailable' || raw === 'max')) return null;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`Docker returned invalid ${key} PID telemetry: ${JSON.stringify(raw ?? null)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TELEMETRY_VALUE) {
    throw new Error(`Docker returned out-of-range ${key} PID telemetry: ${JSON.stringify(raw)}`);
  }
  return value;
}

function countZombies(topOutput: string): number {
  if (Buffer.byteLength(topOutput, 'utf8') > MAX_TOP_OUTPUT_BYTES) {
    throw new Error('Docker PID telemetry exceeded the bounded top output size');
  }
  const lines = topOutput.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^PID\s+STAT\s*$/i.test(lines[0].trim())) {
    throw new Error('Docker top returned an invalid PID/STAT header');
  }
  const zombies = lines.slice(1).filter((line) => /^\s*\d+\s+Z/i.test(line)).length;
  if (zombies > MAX_TELEMETRY_VALUE) {
    throw new Error('Docker returned an out-of-range zombie process count');
  }
  return zombies;
}

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
    if (opts?.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

export function containerNameFor(missionId: string): string {
  return `radarist-build-${sanitize(missionId)}`;
}
export function volumeNameFor(missionId: string): string {
  return `radarist_build_${sanitize(missionId)}`;
}
/**
 * Per-mission check-dependency volume (BUILD-039).
 *
 * Deliberately per-mission rather than shared: a shared cache would let one
 * mission's installed bytes reach another mission's reviewer, and cleanup
 * could never remove it without racing concurrent missions. Per-mission keeps
 * the existing "destroy the mission, destroy its storage" residue contract.
 */
export function browserCacheVolumeNameFor(missionId: string): string {
  return `radarist_build_browsers_${sanitize(missionId)}`;
}
function sanitize(missionId: string): string {
  return missionId.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export class DockerDriver implements SandboxDriver {
  readonly name = 'docker' as const;
  private readonly exec_: ExecFn;

  constructor(deps?: { exec?: ExecFn }) {
    this.exec_ = deps?.exec ?? defaultExec;
  }

  private async docker(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ExecResult> {
    return this.exec_('docker', args, opts);
  }

  private async must(
    args: string[],
    context: string,
    opts?: { timeoutMs?: number; input?: string }
  ): Promise<ExecResult> {
    const result = await this.docker(args, opts);
    if (result.code !== 0) {
      throw new Error(`docker ${context} failed (exit ${result.code}): ${result.stderr || result.stdout}`.trim());
    }
    return result;
  }

  async create(opts: CreateSandboxOptions): Promise<SandboxRef> {
    const parsedPidsLimit = sandboxPidsLimitSchema.safeParse(opts.pidsLimit);
    if (!parsedPidsLimit.success) {
      throw new Error(`Invalid sandbox PID limit: ${parsedPidsLimit.error.issues[0]?.message ?? 'invalid value'}`);
    }
    const containerName = containerNameFor(opts.missionId);
    const volumeName = volumeNameFor(opts.missionId);
    await this.must(['volume', 'create', volumeName], 'volume create');
    const browserCache = opts.browserCacheVolume;
    if (browserCache) {
      await this.must(['volume', 'create', browserCache.name], 'browser cache volume create');
    }
    const args = [
      'run',
      '--detach',
      '--init',
      '--name',
      containerName,
      '--cpus',
      String(opts.cpus),
      '--memory',
      `${opts.memoryGb}g`,
      '--pids-limit',
      String(parsedPidsLimit.data),
      '--network',
      opts.network,
      '--add-host=host.docker.internal:host-gateway',
      '-p',
      `127.0.0.1:${opts.hostPort}:${opts.containerPort}`,
      '-v',
      `${volumeName}:${opts.workspacePath}`,
      '--workdir',
      opts.workspacePath,
      '--label',
      `radarist.build.mission=${opts.missionId}`,
      '--label',
      `radarist.build.hostPort=${opts.hostPort}`,
    ];
    // Bound after the workspace mount so the check-dependency cache can never
    // shadow the workspace path, and read-only for verification runtimes.
    if (browserCache) {
      args.push('-v', `${browserCache.name}:${browserCache.mountPath}${browserCache.readOnly ? ':ro' : ''}`);
    }
    for (const [key, value] of Object.entries(opts.env)) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(opts.image);
    await this.must(args, 'run');
    return {
      driver: this.name,
      missionId: opts.missionId,
      containerName,
      volumeName,
      image: opts.image,
      hostPort: opts.hostPort,
      workspacePath: opts.workspacePath,
      browserCacheVolume: browserCache?.name ?? null,
    };
  }

  async exec(ref: SandboxRef, argv: string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    const interactive = opts?.input !== undefined ? ['--interactive'] : [];
    const user = opts?.user ? ['--user', opts.user] : [];
    const execOpts = opts ? { timeoutMs: opts.timeoutMs, input: opts.input } : undefined;
    return this.docker(
      ['exec', ...interactive, ...user, '--workdir', ref.workspacePath, ref.containerName, ...argv],
      execOpts
    );
  }

  async execDetached(ref: SandboxRef, argv: string[], opts?: SandboxDetachedExecOptions): Promise<void> {
    const user = opts?.user ? ['--user', opts.user] : [];
    await this.must(
      ['exec', '--detach', ...user, '--workdir', ref.workspacePath, ref.containerName, ...argv],
      'exec --detach'
    );
  }

  async copyIn(ref: SandboxRef, hostPath: string, containerPath: string): Promise<void> {
    await this.must(['cp', hostPath, `${ref.containerName}:${containerPath}`], 'cp', {
      timeoutMs: 300_000,
    });
  }

  async copyOut(ref: SandboxRef, containerPath: string, hostPath: string): Promise<void> {
    await this.must(['cp', `${ref.containerName}:${containerPath}`, hostPath], 'cp (out)', {
      timeoutMs: 300_000,
    });
  }

  async stop(ref: SandboxRef): Promise<void> {
    // Volume is intentionally kept: stop == pause in the persistence model.
    await this.must(['stop', '--time', '10', ref.containerName], 'stop');
  }

  async resume(ref: SandboxRef): Promise<void> {
    await this.must(['start', ref.containerName], 'start');
  }

  async destroy(ref: SandboxRef, opts?: { removeVolume?: boolean }): Promise<void> {
    const removed = await this.docker(['rm', '--force', ref.containerName]);
    if (removed.code !== 0 && !explicitlyMissing(removed, 'container')) {
      throw new Error(`docker rm --force failed (exit ${removed.code}): ${dockerDetail(removed)}`.trim());
    }
    if (opts?.removeVolume) {
      const volumeRemoved = await this.docker(['volume', 'rm', ref.volumeName]);
      if (volumeRemoved.code !== 0 && !explicitlyMissing(volumeRemoved, 'volume')) {
        throw new Error(`docker volume rm failed (exit ${volumeRemoved.code}): ${dockerDetail(volumeRemoved)}`.trim());
      }
      // Derived from the mission id rather than read off the ref: refs persisted
      // before BUILD-039 carry no cache name, and leaving the volume behind is
      // exactly the residue the cleanup contract forbids. Recreation passes
      // removeVolume:false, so the cache survives precisely where it must.
      const cacheRemoved = await this.docker(['volume', 'rm', browserCacheVolumeNameFor(ref.missionId)]);
      if (cacheRemoved.code !== 0 && !explicitlyMissing(cacheRemoved, 'volume')) {
        throw new Error(
          `docker volume rm (browser cache) failed (exit ${cacheRemoved.code}): ${dockerDetail(cacheRemoved)}`.trim()
        );
      }
    }
  }

  async isRunning(ref: SandboxRef): Promise<boolean> {
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', ref.containerName]);
    if (result.code !== 0) {
      if (explicitlyMissing(result, 'container')) return false;
      throw new Error(`docker inspect running state failed (exit ${result.code}): ${dockerDetail(result)}`.trim());
    }
    const state = result.stdout.trim();
    if (state === 'true') return true;
    if (state === 'false') return false;
    throw new Error(`docker inspect returned an invalid running state: ${JSON.stringify(state)}`);
  }

  async usedHostPorts(): Promise<number[]> {
    const result = await this.docker([
      'ps',
      '--all',
      '--filter',
      'label=radarist.build.mission',
      '--format',
      '{{.Label "radarist.build.hostPort"}}',
    ]);
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((port) => Number.isInteger(port) && port > 0);
  }

  /**
   * Read-only process telemetry used by the supervisor and lifecycle tests.
   * A missing/malformed metric is an error except for kernel-optional peak and
   * legacy unbounded-limit values, which are represented as null.
   */
  async processTelemetry(ref: SandboxRef): Promise<SandboxProcessTelemetry> {
    const metrics = await this.must(
      ['exec', ref.containerName, 'sh', '-c', READ_CGROUP_PID_METRICS],
      'exec process telemetry'
    );
    // Docker Desktop needs PID in the ps output to correlate container tasks.
    const top = await this.must(['top', ref.containerName, '-eo', 'pid,stat'], 'top process telemetry');
    return {
      current: parseMetric(metrics.stdout, 'current', false) as number,
      peak: parseMetric(metrics.stdout, 'peak', true),
      limit: parseMetric(metrics.stdout, 'limit', true),
      zombies: countZombies(top.stdout),
    };
  }
}
