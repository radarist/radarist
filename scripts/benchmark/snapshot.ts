/**
 * Offline snapshot and restore for an explicitly disposable Neo4j container.
 *
 * This module deliberately has no default target. Schema benchmarks may delete
 * graph data, so the caller must identify an isolated container and its data
 * volume, confirm that both are disposable, and use the Bolt port published by
 * that same container. The normal `radarist-neo4j` container is always rejected.
 */
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DISPOSABLE_CONFIRMATION = '1';
const RESTORE_CONFIRMATION = 'replace-disposable-data';
const PROTECTED_CONTAINERS = new Set(['radarist-neo4j']);
const PROTECTED_VOLUMES = new Set(['radarist_neo4j_data']);
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Shared disposable-name marker authority (also used by the operator restore guard). */
export const DISPOSABLE_NAME_PART = /(?:^|[-_.])(selftest|e2e|benchmark|test)(?:[-_.]|$)/i;
const DEFAULT_BOLT_PORT = '7687';
const SNAPSHOT_SCHEMA_VERSION = 1;

type Environment = Record<string, string | undefined>;

interface DockerInspect {
  Config?: {
    Image?: string;
  };
  Mounts?: Array<{
    Destination?: string;
    Name?: string;
    Type?: string;
  }>;
  Name?: string;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  State?: {
    Health?: { Status?: string };
    Running?: boolean;
  };
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): string;
}

export interface SnapshotDependencies {
  env?: Environment;
  runner?: CommandRunner;
  sleep?: (milliseconds: number) => void;
}

export interface BenchmarkTarget {
  container: string;
  dataVolume: string;
  database: string;
  image: string;
  boltUri: string;
  running: boolean;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  createdAt: string;
  database: string;
  container: string;
  dataVolume: string;
  sha256: string;
  sizeBytes: number;
}

const systemRunner: CommandRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      throw new Error(`${command} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n')[0];
      throw new Error(`${command} exited with code ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout ?? '';
  },
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function inspectContainer(container: string, runner: CommandRunner): DockerInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runner.run('docker', ['inspect', container]));
  } catch (error) {
    throw new Error(`Cannot inspect disposable Neo4j container ${container}: ${asError(error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error(`Docker returned invalid inspect data for ${container}`);
  }
  return parsed[0] as DockerInspect;
}

function requireValue(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for schema benchmark graph access`);
  return value;
}

function validateDockerName(value: string, variable: string): void {
  if (!DOCKER_NAME.test(value)) throw new Error(`${variable} is not a valid Docker name`);
}

function requireDisposableName(value: string, variable: string): void {
  if (!DISPOSABLE_NAME_PART.test(value)) {
    throw new Error(`${variable} must contain a disposable marker: selftest, e2e, benchmark, or test`);
  }
}

function normalizeContainerName(name: string | undefined): string {
  return name?.replace(/^\//, '') ?? '';
}

function parseBoltUri(rawUri: string): URL {
  let uri: URL;
  try {
    uri = new URL(rawUri);
  } catch {
    throw new Error('NEO4J_URI must be a valid Bolt or Neo4j URL for the disposable graph');
  }
  if (!['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:'].includes(uri.protocol)) {
    throw new Error('NEO4J_URI must use a Bolt or Neo4j protocol');
  }
  if (!['127.0.0.1', 'localhost'].includes(uri.hostname)) {
    throw new Error('NEO4J_URI must use localhost or 127.0.0.1 for a local disposable graph');
  }
  if (uri.username || uri.password) {
    throw new Error('NEO4J_URI must not embed credentials; use NEO4J_USER and NEO4J_PASSWORD');
  }
  if (!uri.port) throw new Error('NEO4J_URI must include the disposable container\'s published Bolt port');
  if (uri.port === DEFAULT_BOLT_PORT) {
    throw new Error(`NEO4J_URI must not use protected default Bolt port ${DEFAULT_BOLT_PORT}`);
  }
  return uri;
}

function assertPublishedBoltPort(inspect: DockerInspect, expectedPort: string): void {
  const bindings = inspect.NetworkSettings?.Ports?.['7687/tcp'];
  if (!bindings?.some((binding) => binding.HostPort === expectedPort)) {
    throw new Error(`NEO4J_URI port ${expectedPort} is not published by the disposable container`);
  }
}

/**
 * Resolve and validate the only graph target that benchmark operations may use.
 * This performs read-only Docker inspection and throws before any stop/write.
 */
export function assertSafeBenchmarkTarget(
  options: { requireRunning?: boolean; requireRestoreConfirmation?: boolean } = {},
  dependencies: SnapshotDependencies = {}
): BenchmarkTarget {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? systemRunner;
  if (env.NEO4J_BENCHMARK_CONFIRM_DISPOSABLE !== DISPOSABLE_CONFIRMATION) {
    throw new Error('Set NEO4J_BENCHMARK_CONFIRM_DISPOSABLE=1 after creating an isolated disposable graph');
  }
  if (options.requireRestoreConfirmation && env.NEO4J_BENCHMARK_CONFIRM_RESTORE !== RESTORE_CONFIRMATION) {
    throw new Error(`Set NEO4J_BENCHMARK_CONFIRM_RESTORE=${RESTORE_CONFIRMATION} to replace disposable graph data`);
  }

  const container = requireValue(env, 'NEO4J_BENCHMARK_CONTAINER');
  const dataVolume = requireValue(env, 'NEO4J_BENCHMARK_DATA_VOLUME');
  const rawUri = requireValue(env, 'NEO4J_URI');
  const database = env.NEO4J_DATABASE?.trim() || 'neo4j';

  validateDockerName(container, 'NEO4J_BENCHMARK_CONTAINER');
  validateDockerName(dataVolume, 'NEO4J_BENCHMARK_DATA_VOLUME');
  if (!DATABASE_NAME.test(database)) throw new Error('NEO4J_DATABASE is not a valid database name');

  const protectedContainer = env.NEO4J_PROTECTED_CONTAINER?.trim();
  const protectedVolume = env.NEO4J_PROTECTED_DATA_VOLUME?.trim();
  if (PROTECTED_CONTAINERS.has(container) || (protectedContainer && container === protectedContainer)) {
    throw new Error(`Refusing to target protected Neo4j container ${container}`);
  }
  if (PROTECTED_VOLUMES.has(dataVolume) || (protectedVolume && dataVolume === protectedVolume)) {
    throw new Error(`Refusing to target protected Neo4j data volume ${dataVolume}`);
  }
  requireDisposableName(container, 'NEO4J_BENCHMARK_CONTAINER');
  requireDisposableName(dataVolume, 'NEO4J_BENCHMARK_DATA_VOLUME');

  const boltUri = parseBoltUri(rawUri);
  const inspect = inspectContainer(container, runner);
  if (normalizeContainerName(inspect.Name) !== container) {
    throw new Error(`Docker inspect target does not match NEO4J_BENCHMARK_CONTAINER=${container}`);
  }
  const dataMount = inspect.Mounts?.find((mount) => mount.Destination === '/data');
  if (dataMount?.Type !== 'volume' || dataMount.Name !== dataVolume) {
    throw new Error(`Container ${container} does not mount ${dataVolume} as its /data volume`);
  }
  assertPublishedBoltPort(inspect, boltUri.port);

  const image = inspect.Config?.Image?.trim() ?? '';
  if (!IMAGE_NAME.test(image)) throw new Error(`Container ${container} has an invalid or missing image name`);
  const running = inspect.State?.Running === true;
  if (options.requireRunning !== false && !running) {
    throw new Error(`Disposable Neo4j container ${container} must be running`);
  }

  return { container, dataVolume, database, image, boltUri: boltUri.toString(), running };
}

function bindMount(source: string, destination: string, readOnly = false): string {
  if (source.includes(',')) throw new Error(`Docker bind source cannot contain a comma: ${source}`);
  return `type=bind,src=${source},dst=${destination}${readOnly ? ',readonly' : ''}`;
}

function volumeMount(source: string, destination: string, readOnly = false): string {
  return `type=volume,src=${source},dst=${destination}${readOnly ? ',readonly' : ''}`;
}

function archiveListing(
  target: BenchmarkTarget,
  archiveDirectory: string,
  archiveName: string,
  runner: CommandRunner
): string {
  return runner.run('docker', [
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    bindMount(archiveDirectory, '/backup', true),
    '--entrypoint',
    '/bin/tar',
    target.image,
    '-tzf',
    `/backup/${archiveName}`,
  ]);
}

export function assertArchiveContainsDatabase(listing: string, database: string): void {
  const prefix = `databases/${database}/`;
  const entries = listing
    .split('\n')
    .map((entry) => entry.trim().replace(/^\.\//, ''))
    .filter(Boolean);
  if (!entries.some((entry) => entry.startsWith(prefix) && entry !== prefix && !entry.endsWith('/'))) {
    throw new Error(`Snapshot archive does not contain database ${database}`);
  }
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hostIdentity(): { uid: string; gid: string } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error('Neo4j snapshots require a host with numeric user and group IDs');
  }
  return { uid: String(uid), gid: String(gid) };
}

function forceOwnerOnly(filePath: string): fs.Stats {
  fs.chmodSync(filePath, 0o600);
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`Snapshot artifact does not have owner-only permissions: ${filePath}`);
  }
  return stat;
}

function startAndWait(target: BenchmarkTarget, runner: CommandRunner, sleep: (milliseconds: number) => void): void {
  runner.run('docker', ['start', target.container]);
  const deadline = Date.now() + 90_000;
  let lastError = 'Neo4j HTTP endpoint did not respond';
  while (Date.now() < deadline) {
    try {
      const inspect = inspectContainer(target.container, runner);
      if (inspect.State?.Running !== true) {
        lastError = 'container is not running';
      } else if (inspect.State.Health?.Status === 'unhealthy') {
        lastError = 'container health check is unhealthy';
      } else {
        runner.run('docker', [
          'exec',
          target.container,
          'wget',
          '-q',
          '--spider',
          'http://127.0.0.1:7474',
        ]);
        return;
      }
    } catch (error) {
      lastError = asError(error).message;
    }
    sleep(500);
  }
  throw new Error(`Disposable Neo4j container ${target.container} did not become ready: ${lastError}`);
}

function stopTarget(target: BenchmarkTarget, runner: CommandRunner): void {
  runner.run('docker', ['stop', '--time', '30', target.container]);
  const inspect = inspectContainer(target.container, runner);
  if (inspect.State?.Running !== false) {
    throw new Error(`Disposable Neo4j container ${target.container} did not stop cleanly`);
  }
}

/**
 * Create a verified raw `/data` archive while the disposable container is
 * stopped. Throws on every failure; no empty or partial archive is success.
 */
export function snapshotNeo4j(
  label: string,
  outputDir = 'reports',
  dependencies: SnapshotDependencies = {}
): string {
  if (!LABEL.test(label)) throw new Error('Snapshot label must contain only letters, numbers, dot, underscore, or dash');
  const runner = dependencies.runner ?? systemRunner;
  const sleep = dependencies.sleep ?? defaultSleep;
  const target = assertSafeBenchmarkTarget({ requireRunning: true }, dependencies);
  const absoluteOutput = path.resolve(outputDir);
  const archivePath = path.join(absoluteOutput, `neo4j-${label}.tar.gz`);
  const manifestPath = `${archivePath}.manifest.json`;
  const partialName = `.neo4j-${label}.${process.pid}.partial.tar.gz`;
  const partialPath = path.join(absoluteOutput, partialName);
  const partialManifestPath = `${manifestPath}.${process.pid}.partial`;

  fs.mkdirSync(absoluteOutput, { recursive: true });
  for (const candidate of [archivePath, manifestPath, partialPath, partialManifestPath]) {
    if (fs.existsSync(candidate)) throw new Error(`Refusing to overwrite existing snapshot artifact ${candidate}`);
  }
  const identity = hostIdentity();

  let stopped = false;
  let archiveComplete = false;
  let operationError: Error | undefined;
  try {
    // Mark this before invoking `docker stop`: the stop command can succeed
    // even when the follow-up inspection fails, and we must still restart.
    stopped = true;
    stopTarget(target, runner);
    runner.run('docker', [
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      volumeMount(target.dataVolume, '/source', true),
      '--mount',
      bindMount(absoluteOutput, '/backup'),
      '--entrypoint',
      '/bin/sh',
      target.image,
      '-eu',
      '-c',
      'tar -czf "$1" -C /source .; chown "$2:$3" "$1"; chmod 600 "$1"',
      'snapshot-archive',
      `/backup/${partialName}`,
      identity.uid,
      identity.gid,
    ]);

    const stat = forceOwnerOnly(partialPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('Snapshot archive is missing or empty');
    assertArchiveContainsDatabase(archiveListing(target, absoluteOutput, partialName, runner), target.database);

    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      database: target.database,
      container: target.container,
      dataVolume: target.dataVolume,
      sha256: sha256(partialPath),
      sizeBytes: stat.size,
    };
    fs.writeFileSync(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    forceOwnerOnly(partialManifestPath);
    fs.renameSync(partialPath, archivePath);
    fs.renameSync(partialManifestPath, manifestPath);
    archiveComplete = true;
  } catch (error) {
    operationError = asError(error);
  }

  let restartError: Error | undefined;
  if (stopped) {
    try {
      startAndWait(target, runner, sleep);
    } catch (error) {
      restartError = asError(error);
    }
  }

  fs.rmSync(partialPath, { force: true });
  fs.rmSync(partialManifestPath, { force: true });
  if (!archiveComplete) {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(manifestPath, { force: true });
  }
  if (operationError || restartError) {
    const messages = [operationError?.message, restartError && `restart failed: ${restartError.message}`].filter(Boolean);
    throw new Error(`[snapshot] ${messages.join('; ')}`);
  }

  console.log(`[snapshot] wrote verified archive ${archivePath}`);
  return archivePath;
}

function readManifest(archivePath: string): SnapshotManifest {
  const manifestPath = `${archivePath}.manifest.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read snapshot manifest ${manifestPath}: ${asError(error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Snapshot manifest is invalid');
  const manifest = parsed as Partial<SnapshotManifest>;
  if (
    manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.database !== 'string' ||
    typeof manifest.container !== 'string' ||
    typeof manifest.dataVolume !== 'string' ||
    typeof manifest.sha256 !== 'string' ||
    typeof manifest.sizeBytes !== 'number'
  ) {
    throw new Error('Snapshot manifest has an unsupported or incomplete schema');
  }
  return manifest as SnapshotManifest;
}

/**
 * Replace the same disposable target's data with a verified snapshot. A
 * failure after replacement begins intentionally leaves the target stopped.
 */
export function restoreNeo4j(
  dumpPath: string,
  dependencies: SnapshotDependencies = {}
): boolean {
  const runner = dependencies.runner ?? systemRunner;
  const sleep = dependencies.sleep ?? defaultSleep;
  const target = assertSafeBenchmarkTarget(
    { requireRunning: false, requireRestoreConfirmation: true },
    dependencies
  );
  const archivePath = path.resolve(dumpPath);
  const archiveDirectory = path.dirname(archivePath);
  const archiveName = path.basename(archivePath);
  const manifest = readManifest(archivePath);
  const stat = fs.statSync(archivePath);

  if (!stat.isFile() || stat.size === 0 || stat.size !== manifest.sizeBytes) {
    throw new Error('Snapshot archive size does not match its manifest');
  }
  if (sha256(archivePath) !== manifest.sha256) throw new Error('Snapshot archive checksum does not match its manifest');
  if (
    manifest.container !== target.container ||
    manifest.dataVolume !== target.dataVolume ||
    manifest.database !== target.database
  ) {
    throw new Error('Snapshot manifest target does not match the configured disposable graph');
  }
  assertArchiveContainsDatabase(archiveListing(target, archiveDirectory, archiveName, runner), target.database);

  const wasRunning = target.running;
  if (wasRunning) {
    try {
      stopTarget(target, runner);
    } catch (error) {
      try {
        startAndWait(target, runner, sleep);
      } catch (restartError) {
        throw new Error(
          `[restore] could not stop the target safely: ${asError(error).message}; restart failed: ${asError(restartError).message}`
        );
      }
      throw new Error(`[restore] could not stop the target safely: ${asError(error).message}`);
    }
  }
  try {
    runner.run('docker', [
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      volumeMount(target.dataVolume, '/target'),
      '--mount',
      bindMount(archiveDirectory, '/backup', true),
      '--entrypoint',
      '/bin/sh',
      target.image,
      '-eu',
      '-c',
      'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "$1" -C /target',
      'snapshot-restore',
      `/backup/${archiveName}`,
    ]);
  } catch (error) {
    throw new Error(`[restore] replacement failed; ${target.container} was left stopped: ${asError(error).message}`);
  }

  if (wasRunning) startAndWait(target, runner, sleep);
  console.log(`[restore] restored verified archive ${archivePath}`);
  return true;
}
