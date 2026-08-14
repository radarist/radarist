/**
 * LOCAL-014 — profile-bound, guarded offline backup and restore of a local
 * runtime Neo4j graph.
 *
 * Trust boundaries (deliberately separate from the LOCAL-011 health check —
 * a passing health check NEVER authorizes anything here):
 *
 *  1. Backup source guard (`assertOperatorBackupSource`): resolves exactly one
 *     EXPLICIT runtime profile through the canonical local-runtime authority
 *     (including the sanctioned port-offset/name-suffix overrides), then proves
 *     against the Docker daemon that the selected container IS that profile's
 *     Neo4j runtime: exact derived name, pinned image, durable runtime label,
 *     loopback-only publication of the profile's own HTTP/Bolt ports, the
 *     complete expected set of profile-labelled named volumes, plus a
 *     credential-free loopback NEO4J_URI matching the profile Bolt port.
 *     Writer quiescence is checked on the profile's own app/Inngest ports.
 *     Every refusal happens before any stop/copy/mutation.
 *
 *  2. Restore target guard (`assertOperatorRestoreTarget`): an independent
 *     guard that re-resolves the target profile and additionally proves the
 *     target is disposable (marker-named container AND volumes, never the
 *     protected canonical default identities), that its database/image match
 *     the verified manifest, and that the manifest is internally consistent
 *     with the canonical identity derivation (anti-stale, anti-tamper).
 *
 *  3. Primary-apply boundary (`assertOperatorPrimaryTarget`): unchanged — the
 *     graph-repair tools remain pinned to the canonical unshifted default
 *     graph and are not part of the profile-bound backup/restore contract.
 *
 *  4. Rehearsal restore (`restoreOperatorBackupToBenchmarkTarget`): the
 *     graph-integrity rehearsal keeps its existing benchmark-env disposable
 *     guard; the sanctioned CLI restore is always the profile-bound path.
 *     Both share one mutation primitive (`executeOperatorRestore`).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertArchiveContainsDatabase,
  assertSafeBenchmarkTarget,
  DISPOSABLE_NAME_PART,
  type BenchmarkTarget,
  type CommandRunner,
} from '../benchmark/snapshot';
import {
  LOCAL_RUNTIME_DOCKER_LABEL,
  LOCAL_RUNTIME_NEO4J_IMAGE,
  LOCAL_RUNTIME_PROFILE_NAMES,
  buildLocalRuntimeProfiles,
  deriveLocalRuntimeNeo4jDockerIdentity,
  parseLocalRuntimeProfileArg,
  resolveLocalRuntimeNameSuffix,
  resolveLocalRuntimePortOffset,
  type LocalRuntimeNeo4jDockerIdentity,
  type LocalRuntimeProfile,
  type LocalRuntimeProfileName,
} from './local-runtime-profile';

const BACKUP_CONFIRMATION = 'backup-radarist-neo4j-offline';
const APPLY_QUIESCENCE_CONFIRMATION = 'graph-integrity-writers-stopped';
const RESTORE_CONFIRMATION = 'replace-disposable-neo4j-data';
const BACKUP_KIND = 'radarist-neo4j-operator-backup';
const BACKUP_SCHEMA_VERSION = 3;
const SOURCE_DATABASE = 'neo4j';

// Primary-apply stays pinned to the canonical unshifted default graph (the
// graph-repair authorization boundary; not part of LOCAL-014 profile truth).
const CANONICAL_DEFAULT_PROFILE = buildLocalRuntimeProfiles({}).default;
const CANONICAL_DEFAULT_IDENTITY = deriveLocalRuntimeNeo4jDockerIdentity(CANONICAL_DEFAULT_PROFILE, '');
const SOURCE_CONTAINER = CANONICAL_DEFAULT_IDENTITY.container;
const SOURCE_DATA_VOLUME = `${CANONICAL_DEFAULT_IDENTITY.volumePrefix}_data`;
const SOURCE_IMAGE = LOCAL_RUNTIME_NEO4J_IMAGE;
const SOURCE_BOLT_PORT = String(CANONICAL_DEFAULT_PROFILE.ports.neo4jBolt);
const WRITER_PORTS = [CANONICAL_DEFAULT_PROFILE.ports.inngest, CANONICAL_DEFAULT_PROFILE.ports.app].sort(
  (a, b) => a - b
) as number[];

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

type Environment = Record<string, string | undefined>;

interface DockerInspect {
  Config?: { Image?: string; Labels?: Record<string, string> };
  HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
  Mounts?: Array<{ Destination?: string; Name?: string; Type?: string }>;
  Name?: string;
  NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
  State?: {
    Error?: string;
    ExitCode?: number;
    Health?: { Status?: string };
    OOMKilled?: boolean;
    Running?: boolean;
  };
}

interface OperatorSourceTargetWithoutId {
  container: string;
  dataVolume: string;
  database: string;
  image: string;
}

export interface OperatorSourceTarget extends OperatorSourceTargetWithoutId {
  databaseId: string;
  boltUri: string;
}

export interface OperatorBackupVolumeIdentity {
  name: string;
  destination: string;
}

export interface OperatorBackupManifest {
  schemaVersion: 3;
  kind: 'radarist-neo4j-operator-backup';
  createdAt: string;
  profile: {
    name: LocalRuntimeProfileName;
    projectId: string;
    portOffset: number;
    nameSuffix: string;
  };
  source: {
    container: string;
    dataVolume: string;
    database: string;
    databaseId: string;
    image: string;
    runtimeLabel: string;
    ports: { http: number; bolt: number };
    volumes: OperatorBackupVolumeIdentity[];
  };
  archive: {
    fileName: string;
    sha256: string;
    sizeBytes: number;
    /** The single volume whose contents this archive carries. */
    volume: string;
  };
  safety: {
    offline: true;
    writersQuiesced: true;
    checkedPorts: number[];
  };
}

export interface VerifiedOperatorBackup {
  manifest: OperatorBackupManifest;
  manifestPath: string;
  archivePath: string;
}

export interface OperatorBackupDependencies {
  env?: Environment;
  runner?: CommandRunner;
  sleep?: (milliseconds: number) => void;
  listeningPorts?: () => number[];
  databaseIdReader?: (target: OperatorSourceTargetWithoutId, runner: CommandRunner) => string;
  syncFile?: (filePath: string) => void;
  syncDirectory?: (directory: string) => void;
}

const systemRunner: CommandRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
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

function bindMount(source: string, destination: string, readOnly = false): string {
  if (source.includes(',')) throw new Error(`Docker bind source cannot contain a comma: ${source}`);
  return `type=bind,src=${source},dst=${destination}${readOnly ? ',readonly' : ''}`;
}

function volumeMount(source: string, destination: string, readOnly = false): string {
  return `type=volume,src=${source},dst=${destination}${readOnly ? ',readonly' : ''}`;
}

function normalizeContainerName(name: string | undefined): string {
  return name?.replace(/^\//, '') ?? '';
}

function inspectContainer(container: string, runner: CommandRunner): DockerInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runner.run('docker', ['inspect', container]));
  } catch (error) {
    throw new Error(`Cannot inspect Neo4j container ${container}: ${asError(error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error(`Docker returned invalid inspect data for ${container}`);
  }
  return parsed[0] as DockerInspect;
}

function inspectRunningContainers(runner: CommandRunner): DockerInspect[] {
  const ids = runner
    .run('docker', ['ps', '--quiet'])
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(runner.run('docker', ['inspect', ...ids]));
  } catch (error) {
    throw new Error(`Cannot inspect running Docker containers: ${asError(error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'object' || entry === null)) {
    throw new Error('Docker returned invalid running-container inspection data');
  }
  return parsed as DockerInspect[];
}

function assertExclusiveVolume(volume: string, ownerContainer: string, runner: CommandRunner): void {
  const conflicting = inspectRunningContainers(runner).filter((inspect) => {
    const name = normalizeContainerName(inspect.Name);
    return (
      inspect.State?.Running === true &&
      name !== ownerContainer &&
      inspect.Mounts?.some((mount) => mount.Type === 'volume' && mount.Name === volume)
    );
  });
  if (conflicting.length > 0) {
    throw new Error(
      `Refusing volume replacement while another running container mounts ${volume}: ` +
        conflicting.map((inspect) => normalizeContainerName(inspect.Name) || '<unnamed>').join(', ')
    );
  }
}

function assertExclusivePrimaryVolume(runner: CommandRunner): void {
  assertExclusiveVolume(SOURCE_DATA_VOLUME, SOURCE_CONTAINER, runner);
}

// ---------------------------------------------------------------------------
// LOCAL-014 profile-bound target resolution and identity verification
// ---------------------------------------------------------------------------

export interface OperatorProfileSelection {
  readonly profile: LocalRuntimeProfile;
  readonly portOffset: number;
  readonly nameSuffix: string;
  readonly identity: LocalRuntimeNeo4jDockerIdentity;
  readonly writerPorts: readonly number[];
}

/**
 * Resolve exactly one EXPLICIT runtime profile for a destructive/sensitive
 * operation. Unlike the read-only health command, an absent `--profile` is a
 * refusal: backup/restore must never silently select a graph.
 */
export function resolveOperatorProfileSelection(
  args: readonly string[],
  env: Environment = process.env
): OperatorProfileSelection {
  const hasExplicitProfile = args.some(
    (argument) => argument === '--profile' || argument.startsWith('--profile=')
  );
  if (!hasExplicitProfile) {
    throw new Error(
      'An explicit --profile <default|selftest> selection is required for Neo4j backup/restore; refusing to assume a graph.'
    );
  }
  const profiles = buildLocalRuntimeProfiles(env as NodeJS.ProcessEnv);
  const profile = parseLocalRuntimeProfileArg(args, profiles);
  const portOffset = resolveLocalRuntimePortOffset(env as NodeJS.ProcessEnv);
  const nameSuffix = resolveLocalRuntimeNameSuffix(env as NodeJS.ProcessEnv);
  const identity = deriveLocalRuntimeNeo4jDockerIdentity(profile, nameSuffix);
  const writerPorts = [profile.ports.inngest, profile.ports.app].sort((a, b) => a - b);
  return { profile, portOffset, nameSuffix, identity, writerPorts };
}

function assertProfileBoltUri(env: Environment, boltPort: number): string {
  const rawUri = env.NEO4J_URI?.trim();
  if (!rawUri) throw new Error('NEO4J_URI is required and must identify the selected local Neo4j target');
  let uri: URL;
  try {
    uri = new URL(rawUri);
  } catch {
    throw new Error('NEO4J_URI must be a valid Bolt or Neo4j URL');
  }
  if (!['bolt:', 'neo4j:'].includes(uri.protocol)) {
    throw new Error('NEO4J_URI must use the bolt or neo4j protocol');
  }
  if (!LOOPBACK_HOSTNAMES.has(uri.hostname)) {
    throw new Error(`NEO4J_URI must use a loopback host, found "${uri.hostname}"`);
  }
  if (uri.port !== String(boltPort)) {
    throw new Error(
      `NEO4J_URI port ${uri.port || '<none>'} does not match the selected profile Bolt port ${boltPort}`
    );
  }
  if (uri.username || uri.password) throw new Error('NEO4J_URI must not embed credentials');
  return rawUri;
}

function inspectProfileVolumeLabels(
  volumeName: string,
  expectedLabel: string,
  runner: CommandRunner,
  problems: string[]
): void {
  let fields: { label: string; driver: string; scope: string };
  try {
    const raw = runner.run('docker', [
      'volume',
      'inspect',
      '--format',
      `{{index .Labels "${LOCAL_RUNTIME_DOCKER_LABEL}"}}|{{.Driver}}|{{.Scope}}`,
      volumeName,
    ]);
    const [label = '', driver = '', scope = ''] = raw.trim().split('|');
    fields = { label, driver, scope };
  } catch {
    problems.push(`volume ${volumeName} does not exist`);
    return;
  }
  if (fields.label !== expectedLabel) {
    problems.push(`volume ${volumeName} has runtime label "${fields.label || '<none>'}", expected "${expectedLabel}"`);
  }
  if (fields.driver !== 'local' || fields.scope !== 'local') {
    problems.push(`volume ${volumeName} must be a plain local volume (driver ${fields.driver}, scope ${fields.scope})`);
  }
}

interface VerifiedProfileRuntime {
  container: string;
  image: string;
  runtimeLabel: string;
  running: boolean;
  health: string | undefined;
  volumes: OperatorBackupVolumeIdentity[];
  dataVolume: string;
}

/**
 * Prove that the Docker container derived from the selected profile IS that
 * profile's durable Neo4j runtime. Read-only; throws before any mutation.
 * Re-runnable at any point to shrink time-of-check/time-of-use windows.
 */
export function verifyProfileNeo4jRuntimeIdentity(
  selection: OperatorProfileSelection,
  runner: CommandRunner
): VerifiedProfileRuntime {
  const expected = selection.identity;
  const problems: string[] = [];
  const inspect = inspectContainer(expected.container, runner);

  if (normalizeContainerName(inspect.Name) !== expected.container) {
    problems.push(
      `inspect returned container "${normalizeContainerName(inspect.Name)}", expected "${expected.container}"`
    );
  }
  if (inspect.Config?.Image !== LOCAL_RUNTIME_NEO4J_IMAGE) {
    problems.push(`image "${inspect.Config?.Image ?? '<none>'}", expected "${LOCAL_RUNTIME_NEO4J_IMAGE}"`);
  }
  const runtimeLabel = inspect.Config?.Labels?.[LOCAL_RUNTIME_DOCKER_LABEL] ?? '';
  if (runtimeLabel !== expected.durableRuntimeLabel) {
    problems.push(
      `runtime label "${runtimeLabel || '<none>'}", expected "${expected.durableRuntimeLabel}" (a durable graph is required for volume backup/restore)`
    );
  }

  const bindings = inspect.HostConfig?.PortBindings ?? {};
  const bindingKeys = Object.keys(bindings);
  for (const key of bindingKeys) {
    if (key !== '7474/tcp' && key !== '7687/tcp') problems.push(`unexpected published container port ${key}`);
  }
  for (const [key, expectedHostPort] of [
    ['7474/tcp', selection.profile.ports.neo4jHttp],
    ['7687/tcp', selection.profile.ports.neo4jBolt],
  ] as const) {
    const entries = bindings[key];
    if (!Array.isArray(entries) || entries.length !== 1) {
      problems.push(`container port ${key} is not published exactly once`);
      continue;
    }
    const binding = entries[0];
    if (!LOOPBACK_HOSTNAMES.has(binding?.HostIp ?? '')) {
      problems.push(`container port ${key} publishes on non-loopback interface "${binding?.HostIp ?? '<empty>'}"`);
    }
    if (binding?.HostPort !== String(expectedHostPort)) {
      problems.push(
        `container port ${key} publishes host port ${binding?.HostPort ?? '<none>'}, expected ${expectedHostPort}`
      );
    }
  }

  const mounts = inspect.Mounts ?? [];
  const expectedByDestination = new Map(expected.volumes.map((volume) => [volume.destination, volume.name]));
  const seen = new Set<string>();
  for (const mount of mounts) {
    const destination = mount.Destination ?? '';
    const expectedName = expectedByDestination.get(destination);
    if (expectedName === undefined) {
      problems.push(`unexpected mount at ${destination || '<unknown>'}`);
      continue;
    }
    seen.add(destination);
    if (mount.Type !== 'volume' || mount.Name !== expectedName) {
      problems.push(
        `mount ${destination} must be named volume ${expectedName} (found ${mount.Type ?? '?'}:${mount.Name ?? '?'})`
      );
    }
  }
  for (const destination of expectedByDestination.keys()) {
    if (!seen.has(destination)) problems.push(`missing expected volume mount at ${destination}`);
  }

  for (const volume of expected.volumes) {
    inspectProfileVolumeLabels(volume.name, expected.durableRuntimeLabel, runner, problems);
  }

  if (problems.length > 0) {
    throw new Error(
      `Neo4j container ${expected.container} does not match the selected ${selection.profile.name} runtime profile:\n  - ` +
        problems.slice(0, 12).join('\n  - ')
    );
  }
  return {
    container: expected.container,
    image: LOCAL_RUNTIME_NEO4J_IMAGE,
    runtimeLabel: expected.durableRuntimeLabel,
    running: inspect.State?.Running === true,
    health: inspect.State?.Health?.Status,
    volumes: expected.volumes.map((volume) => ({ name: volume.name, destination: volume.destination })),
    dataVolume: `${expected.volumePrefix}_data`,
  };
}

export interface OperatorBackupSource extends VerifiedProfileRuntime {
  profile: { name: LocalRuntimeProfileName; projectId: string; portOffset: number; nameSuffix: string };
  database: string;
  databaseId: string;
  boltUri: string;
  writerPorts: readonly number[];
}

/**
 * Backup source guard: explicit profile + quiescence + full Docker identity
 * proof + live database identity. Fails closed before any stop/copy.
 */
export function assertOperatorBackupSource(
  profileArgs: readonly string[],
  dependencies: OperatorBackupDependencies = {}
): OperatorBackupSource {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? systemRunner;
  const selection = resolveOperatorProfileSelection(profileArgs, env);
  const boltUri = assertProfileBoltUri(env, selection.profile.ports.neo4jBolt);
  if (env.NEO4J_DATABASE?.trim() && env.NEO4J_DATABASE?.trim() !== SOURCE_DATABASE) {
    throw new Error(`NEO4J_DATABASE must be ${SOURCE_DATABASE} for an operator backup`);
  }
  const runtime = verifyProfileNeo4jRuntimeIdentity(selection, runner);
  if (!runtime.running) throw new Error(`${runtime.container} must be running before backup`);
  if (runtime.health !== undefined && runtime.health !== 'healthy') {
    throw new Error(`${runtime.container} must report healthy, found ${runtime.health}`);
  }
  assertExclusiveVolume(runtime.dataVolume, runtime.container, runner);
  const databaseId = (dependencies.databaseIdReader ?? readContainerDatabaseId)(
    {
      container: runtime.container,
      dataVolume: runtime.dataVolume,
      database: SOURCE_DATABASE,
      image: runtime.image,
    },
    runner
  );
  return {
    ...runtime,
    profile: {
      name: selection.profile.name,
      projectId: selection.profile.projectId,
      portOffset: selection.portOffset,
      nameSuffix: selection.nameSuffix,
    },
    database: SOURCE_DATABASE,
    databaseId,
    boltUri,
    writerPorts: selection.writerPorts,
  };
}

function assertPrimaryBoltUri(env: Environment): string {
  const rawUri = env.NEO4J_URI?.trim();
  if (!rawUri) throw new Error('NEO4J_URI is required and must identify the protected local Neo4j target');
  let uri: URL;
  try {
    uri = new URL(rawUri);
  } catch {
    throw new Error('NEO4J_URI must be a valid Bolt or Neo4j URL');
  }
  if (!['bolt:', 'neo4j:'].includes(uri.protocol)) {
    throw new Error('NEO4J_URI must use the bolt or neo4j protocol for primary apply');
  }
  if (!LOOPBACK_HOSTNAMES.has(uri.hostname) || uri.port !== SOURCE_BOLT_PORT) {
    throw new Error(`NEO4J_URI must use loopback and the protected default Bolt port ${SOURCE_BOLT_PORT}`);
  }
  if (uri.username || uri.password) throw new Error('NEO4J_URI must not embed credentials');
  return rawUri;
}

export function readContainerDatabaseId(
  target: OperatorSourceTargetWithoutId,
  runner: CommandRunner
): string {
  const output = runner.run('docker', [
    'exec',
    target.container,
    '/bin/sh',
    '-eu',
    '-c',
    'export NEO4J_USERNAME="${NEO4J_AUTH%%/*}"; export NEO4J_PASSWORD="${NEO4J_AUTH#*/}"; ' +
      'cypher-shell --format plain --database "$1" ' +
      '"CALL db.info() YIELD id RETURN \'RADARIST_DATABASE_ID=\' + toString(id) AS result"',
    'database-id-read',
    target.database,
  ]);
  const match = output.match(/RADARIST_DATABASE_ID=([^"\s]+)/);
  const databaseId = match?.[1]?.trim();
  if (!databaseId || databaseId.length > 200) {
    throw new Error(`Cannot read database ID from protected Neo4j container ${target.container}`);
  }
  return databaseId;
}

/** Read-only identity guard for the only graph that operator apply may target. */
export function assertOperatorPrimaryTarget(
  dependencies: OperatorBackupDependencies = {}
): OperatorSourceTarget {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? systemRunner;
  const boltUri = assertPrimaryBoltUri(env);
  if (env.NEO4J_DATABASE?.trim() && env.NEO4J_DATABASE?.trim() !== SOURCE_DATABASE) {
    throw new Error(`NEO4J_DATABASE must be ${SOURCE_DATABASE} for protected primary apply`);
  }
  const inspect = inspectContainer(SOURCE_CONTAINER, runner);
  if (normalizeContainerName(inspect.Name) !== SOURCE_CONTAINER) {
    throw new Error(`Docker inspect target does not match protected source ${SOURCE_CONTAINER}`);
  }
  const dataMount = inspect.Mounts?.find((mount) => mount.Destination === '/data');
  if (dataMount?.Type !== 'volume' || dataMount.Name !== SOURCE_DATA_VOLUME) {
    throw new Error(`${SOURCE_CONTAINER} does not mount ${SOURCE_DATA_VOLUME} as its /data volume`);
  }
  if (inspect.Config?.Image !== SOURCE_IMAGE) {
    throw new Error(`${SOURCE_CONTAINER} must use pinned image ${SOURCE_IMAGE}`);
  }
  if (inspect.State?.Running !== true) throw new Error(`${SOURCE_CONTAINER} must be running before backup`);
  if (inspect.State.Health?.Status === 'unhealthy') throw new Error(`${SOURCE_CONTAINER} is unhealthy`);
  const boltBindings = inspect.NetworkSettings?.Ports?.['7687/tcp'];
  if (!boltBindings?.some((binding) => binding.HostPort === SOURCE_BOLT_PORT)) {
    throw new Error(`${SOURCE_CONTAINER} does not publish protected Bolt port ${SOURCE_BOLT_PORT}`);
  }
  assertExclusivePrimaryVolume(runner);
  const baseTarget: OperatorSourceTargetWithoutId = {
    container: SOURCE_CONTAINER,
    dataVolume: SOURCE_DATA_VOLUME,
    database: SOURCE_DATABASE,
    image: SOURCE_IMAGE,
  };
  const databaseId = (dependencies.databaseIdReader ?? readContainerDatabaseId)(baseTarget, runner);
  return {
    ...baseTarget,
    databaseId,
    boltUri,
  };
}

function detectListeningWriterPorts(writerPorts: readonly number[]): number[] {
  const listening: number[] = [];
  for (const port of writerPorts) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`Cannot check writer port ${port}: ${result.error.message}`);
    if (result.status === 0) {
      listening.push(port);
    } else if (result.status !== 1) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n')[0];
      throw new Error(`Cannot check writer port ${port}${detail ? `: ${detail}` : ''}`);
    }
  }
  return listening;
}

function assertWritersQuiesced(
  dependencies: OperatorBackupDependencies,
  confirmationVariable: 'NEO4J_OPERATOR_BACKUP_CONFIRM' | 'NEO4J_OPERATOR_APPLY_CONFIRM',
  expectedConfirmation: string,
  writerPorts: readonly number[] = WRITER_PORTS
): number[] {
  const env = dependencies.env ?? process.env;
  if (env[confirmationVariable] !== expectedConfirmation) {
    throw new Error(`Set ${confirmationVariable}=${expectedConfirmation} after stopping all local graph writers`);
  }
  return assertWriterPortsQuiesced(dependencies, writerPorts);
}

function assertWriterPortsQuiesced(
  dependencies: OperatorBackupDependencies,
  writerPorts: readonly number[]
): number[] {
  const listening = (dependencies.listeningPorts ?? (() => detectListeningWriterPorts(writerPorts)))();
  const invalid = listening.find((port) => !Number.isInteger(port) || port < 1 || port > 65535);
  if (invalid !== undefined) throw new Error(`Writer-port probe returned invalid port ${invalid}`);
  const knownListeners = [...new Set(listening)].filter((port) => writerPorts.includes(port));
  if (knownListeners.length > 0) {
    throw new Error(
      `Refusing offline graph operation while local graph writers may be active on ports ${knownListeners.join(', ')}`
    );
  }
  return [...writerPorts].sort((a, b) => a - b);
}

export function assertOperatorApplyWritersQuiesced(
  dependencies: OperatorBackupDependencies = {}
): number[] {
  return assertWritersQuiesced(
    dependencies,
    'NEO4J_OPERATOR_APPLY_CONFIRM',
    APPLY_QUIESCENCE_CONFIRMATION
  );
}

function hostIdentity(): { uid: string; gid: string } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error('Neo4j operator backups require numeric host user and group IDs');
  }
  return { uid: String(uid), gid: String(gid) };
}

function assertOwnerOnlyRegularFile(filePath: string, label: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have owner-only permissions: ${filePath}`);
  return stat;
}

function forceOwnerOnly(filePath: string, label: string): fs.Stats {
  fs.chmodSync(filePath, 0o600);
  return assertOwnerOnlyRegularFile(filePath, label);
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function archiveListing(
  image: string,
  archiveDirectory: string,
  archiveName: string,
  runner: CommandRunner
): string {
  return runner.run('docker', [
    'run',
    '--rm',
    '--pull',
    'never',
    '--read-only',
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    bindMount(archiveDirectory, '/backup', true),
    '--entrypoint',
    '/bin/tar',
    image,
    '-tzf',
    `/backup/${archiveName}`,
  ]);
}

function stopContainer(container: string, runner: CommandRunner): void {
  runner.run('docker', ['stop', '--time', '30', container]);
  const inspect = inspectContainer(container, runner);
  if (inspect.State?.Running !== false) throw new Error(`Neo4j container ${container} did not stop cleanly`);
  if (inspect.State?.OOMKilled === true || inspect.State?.ExitCode === 137) {
    throw new Error(`Neo4j container ${container} was forcibly killed instead of completing a graceful stop`);
  }
  if (inspect.State?.Error?.trim()) {
    throw new Error(`Neo4j container ${container} stopped with a runtime error: ${inspect.State.Error.trim()}`);
  }
}

function startAndWait(
  container: string,
  runner: CommandRunner,
  sleep: (milliseconds: number) => void
): void {
  runner.run('docker', ['start', container]);
  const deadline = Date.now() + 90_000;
  let lastError = 'Neo4j HTTP endpoint did not respond';
  while (Date.now() < deadline) {
    try {
      const inspect = inspectContainer(container, runner);
      if (inspect.State?.Running !== true) {
        lastError = 'container is not running';
      } else if (
        inspect.State.Health?.Status !== undefined &&
        inspect.State.Health.Status !== 'healthy'
      ) {
        lastError = `container health check is ${inspect.State.Health.Status}`;
      } else {
        runner.run('docker', ['exec', container, 'wget', '-q', '--spider', 'http://127.0.0.1:7474']);
        return;
      }
    } catch (error) {
      lastError = asError(error).message;
    }
    sleep(500);
  }
  throw new Error(`Neo4j container ${container} did not become ready: ${lastError}`);
}

function parseManifest(manifestPath: string): OperatorBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read operator backup manifest ${manifestPath}: ${asError(error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Operator backup manifest is invalid');
  const manifest = parsed as Partial<OperatorBackupManifest>;
  const profile = manifest.profile;
  const source = manifest.source;
  const archive = manifest.archive;
  const safety = manifest.safety;
  if (
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    manifest.kind !== BACKUP_KIND ||
    typeof manifest.createdAt !== 'string' ||
    !profile ||
    !source ||
    !archive ||
    !safety ||
    !LOCAL_RUNTIME_PROFILE_NAMES.includes(profile.name as LocalRuntimeProfileName) ||
    typeof profile.projectId !== 'string' ||
    !profile.projectId ||
    !Number.isInteger(profile.portOffset) ||
    (profile.portOffset as number) < 0 ||
    typeof profile.nameSuffix !== 'string' ||
    typeof source.container !== 'string' ||
    typeof source.dataVolume !== 'string' ||
    typeof source.database !== 'string' ||
    typeof source.databaseId !== 'string' ||
    typeof source.image !== 'string' ||
    typeof source.runtimeLabel !== 'string' ||
    typeof source.ports !== 'object' ||
    source.ports === null ||
    !Number.isInteger(source.ports.http) ||
    !Number.isInteger(source.ports.bolt) ||
    !Array.isArray(source.volumes) ||
    source.volumes.length === 0 ||
    !source.volumes.every(
      (volume) =>
        typeof volume === 'object' &&
        volume !== null &&
        typeof volume.name === 'string' &&
        typeof volume.destination === 'string'
    ) ||
    typeof archive.fileName !== 'string' ||
    typeof archive.sha256 !== 'string' ||
    typeof archive.sizeBytes !== 'number' ||
    typeof archive.volume !== 'string' ||
    safety.offline !== true ||
    safety.writersQuiesced !== true ||
    !Array.isArray(safety.checkedPorts) ||
    safety.checkedPorts.length !== 2 ||
    !safety.checkedPorts.every(Number.isInteger)
  ) {
    throw new Error('Operator backup manifest has an unsupported or incomplete schema');
  }
  return manifest as OperatorBackupManifest;
}

/**
 * Re-derive the expected identity from the manifest's own profile record via
 * the canonical authority and require the recorded source to match it. A
 * stale, hand-edited, or foreign-profile manifest fails here before any
 * restore planning.
 */
function assertManifestMatchesCanonicalDerivation(manifest: OperatorBackupManifest): void {
  const profiles = buildLocalRuntimeProfiles({
    RADARIST_LOCAL_RUNTIME_PORT_OFFSET: String(manifest.profile.portOffset),
  } as NodeJS.ProcessEnv);
  const profile = profiles[manifest.profile.name];
  if (profile.projectId !== manifest.profile.projectId) {
    throw new Error('Operator backup manifest profile projectId does not match the canonical profile');
  }
  if (
    profile.ports.neo4jHttp !== manifest.source.ports.http ||
    profile.ports.neo4jBolt !== manifest.source.ports.bolt
  ) {
    throw new Error('Operator backup manifest ports do not match the canonical profile derivation');
  }
  const identity = deriveLocalRuntimeNeo4jDockerIdentity(profile, manifest.profile.nameSuffix);
  if (identity.container !== manifest.source.container) {
    throw new Error('Operator backup manifest container does not match the canonical profile derivation');
  }
  if (identity.durableRuntimeLabel !== manifest.source.runtimeLabel) {
    throw new Error('Operator backup manifest runtime label does not match the canonical profile derivation');
  }
  const expectedVolumes = identity.volumes.map((volume) => ({ name: volume.name, destination: volume.destination }));
  const recorded = [...manifest.source.volumes].sort((a, b) => a.destination.localeCompare(b.destination));
  const expected = [...expectedVolumes].sort((a, b) => a.destination.localeCompare(b.destination));
  if (
    recorded.length !== expected.length ||
    recorded.some(
      (volume, index) =>
        volume.name !== expected[index].name || volume.destination !== expected[index].destination
    )
  ) {
    throw new Error('Operator backup manifest volumes do not match the canonical profile derivation');
  }
}

/**
 * Verify the file contract consumed by guarded restores and graph migrations.
 * Pure and idempotent: no Docker inspection, no mutation, repeatable.
 */
export function verifyOperatorBackupManifest(manifestPathInput: string): VerifiedOperatorBackup {
  const manifestPath = path.resolve(manifestPathInput);
  assertOwnerOnlyRegularFile(manifestPath, 'Operator backup manifest');
  const manifest = parseManifest(manifestPath);
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Operator backup manifest createdAt is invalid');
  if (
    !manifest.source.container ||
    !manifest.source.dataVolume ||
    manifest.source.database !== SOURCE_DATABASE ||
    !manifest.source.databaseId ||
    manifest.source.databaseId.length > 200 ||
    manifest.source.image !== LOCAL_RUNTIME_NEO4J_IMAGE
  ) {
    throw new Error('Operator backup manifest does not identify a valid local Neo4j source');
  }
  const dataVolumes = manifest.source.volumes.filter((volume) => volume.destination === '/data');
  if (dataVolumes.length !== 1 || dataVolumes[0].name !== manifest.source.dataVolume) {
    throw new Error('Operator backup manifest /data volume identity is inconsistent');
  }
  if (manifest.archive.volume !== manifest.source.dataVolume) {
    throw new Error('Operator backup archive volume does not match the manifest /data volume');
  }
  assertManifestMatchesCanonicalDerivation(manifest);
  if (
    !manifest.archive.fileName ||
    path.basename(manifest.archive.fileName) !== manifest.archive.fileName ||
    manifest.archive.fileName === '.' ||
    manifest.archive.fileName === '..'
  ) {
    throw new Error('Operator backup archive fileName must be a basename relative to its manifest');
  }
  if (!SHA256.test(manifest.archive.sha256)) throw new Error('Operator backup manifest checksum is invalid');
  if (!Number.isSafeInteger(manifest.archive.sizeBytes) || manifest.archive.sizeBytes <= 0) {
    throw new Error('Operator backup manifest size is invalid');
  }
  const checkedPorts = [...manifest.safety.checkedPorts].sort((a, b) => a - b);
  if (
    checkedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    checkedPorts[0] === checkedPorts[1]
  ) {
    throw new Error('Operator backup checked writer ports are invalid');
  }
  const archivePath = path.join(path.dirname(manifestPath), manifest.archive.fileName);
  const archiveStat = assertOwnerOnlyRegularFile(archivePath, 'Operator backup archive');
  if (archiveStat.size !== manifest.archive.sizeBytes) throw new Error('Operator backup archive size does not match');
  if (sha256File(archivePath) !== manifest.archive.sha256) {
    throw new Error('Operator backup archive checksum does not match');
  }
  return { manifest, manifestPath, archivePath };
}

export interface OperatorBackupDryRunPlan {
  readonly dryRun: true;
  readonly label: string;
  readonly outputDirectory: string;
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly target: OperatorBackupSource;
  readonly writerPorts: readonly number[];
}

/**
 * Perform every read-only backup guard without creating an output directory,
 * stopping the selected container, or writing an archive/manifest.
 */
export function planOperatorNeo4jBackup(
  label: string,
  profileArgs: readonly string[] = [],
  outputDir = 'reports/graph-integrity/backups',
  dependencies: OperatorBackupDependencies = {}
): OperatorBackupDryRunPlan {
  if (!LABEL.test(label)) throw new Error('Backup label must contain only letters, numbers, dot, underscore, or dash');
  const selection = resolveOperatorProfileSelection(profileArgs, dependencies.env ?? process.env);
  const writerPorts = assertWriterPortsQuiesced(dependencies, selection.writerPorts);
  const target = assertOperatorBackupSource(profileArgs, dependencies);
  const outputDirectory = path.resolve(outputDir);
  if (fs.existsSync(outputDirectory)) {
    const outputStat = fs.lstatSync(outputDirectory);
    if (outputStat.isSymbolicLink()) throw new Error('Operator backup directory must not be a symlink');
    if (!outputStat.isDirectory()) throw new Error('Operator backup output path must be a directory');
  }
  const archivePath = path.join(outputDirectory, `neo4j-operator-${label}.tar.gz`);
  const manifestPath = `${archivePath}.manifest.json`;
  for (const candidate of [archivePath, manifestPath]) {
    if (fs.existsSync(candidate)) throw new Error(`Refusing to overwrite operator backup artifact ${candidate}`);
  }
  return {
    dryRun: true,
    label,
    outputDirectory,
    archivePath,
    manifestPath,
    target,
    writerPorts,
  };
}

/** Create a verified, offline archive of the selected profile's Neo4j `/data` volume. */
export function createOperatorNeo4jBackup(
  label: string,
  profileArgs: readonly string[] = [],
  outputDir = 'reports/graph-integrity/backups',
  dependencies: OperatorBackupDependencies = {}
): VerifiedOperatorBackup {
  if (!LABEL.test(label)) throw new Error('Backup label must contain only letters, numbers, dot, underscore, or dash');
  const runner = dependencies.runner ?? systemRunner;
  const sleep = dependencies.sleep ?? defaultSleep;
  const syncFile = dependencies.syncFile ?? fsyncFile;
  const syncDirectory = dependencies.syncDirectory ?? fsyncDirectory;
  const selection = resolveOperatorProfileSelection(profileArgs, dependencies.env ?? process.env);
  const checkedPorts = assertWritersQuiesced(
    dependencies,
    'NEO4J_OPERATOR_BACKUP_CONFIRM',
    BACKUP_CONFIRMATION,
    selection.writerPorts
  );
  const target = assertOperatorBackupSource(profileArgs, dependencies);
  const absoluteOutput = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutput, { recursive: true });
  if (fs.lstatSync(absoluteOutput).isSymbolicLink()) throw new Error('Operator backup directory must not be a symlink');

  const archiveName = `neo4j-operator-${label}.tar.gz`;
  const archivePath = path.join(absoluteOutput, archiveName);
  const manifestPath = `${archivePath}.manifest.json`;
  const nonce = `${process.pid}-${Date.now()}`;
  const partialName = `.neo4j-operator-${label}.${nonce}.partial.tar.gz`;
  const partialPath = path.join(absoluteOutput, partialName);
  const partialManifestPath = `${manifestPath}.${nonce}.partial`;
  for (const candidate of [archivePath, manifestPath, partialPath, partialManifestPath]) {
    if (fs.existsSync(candidate)) throw new Error(`Refusing to overwrite operator backup artifact ${candidate}`);
  }
  const identity = hostIdentity();

  let stopped = false;
  let archiveComplete = false;
  let operationError: Error | undefined;
  try {
    // Docker stop can succeed even if the following inspection fails.
    stopped = true;
    stopContainer(target.container, runner);
    // A writer may restart after the planning guard. Prove quiescence again
    // immediately before mounting the stopped database volume.
    assertWriterPortsQuiesced(dependencies, target.writerPorts);
    // Shrink the check/use window: re-prove volume identity after the stop,
    // immediately before the archive container mounts the data volume.
    verifyProfileNeo4jRuntimeIdentity(selection, runner);
    runner.run('docker', [
      'run',
      '--rm',
      '--pull',
      'never',
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
      'operator-backup-archive',
      `/backup/${partialName}`,
      identity.uid,
      identity.gid,
    ]);

    const archiveStat = forceOwnerOnly(partialPath, 'Operator backup archive');
    if (archiveStat.size === 0) throw new Error('Operator backup archive is empty');
    syncFile(partialPath);
    assertArchiveContainsDatabase(
      archiveListing(target.image, absoluteOutput, partialName, runner),
      target.database
    );
    const manifest: OperatorBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: BACKUP_KIND,
      createdAt: new Date().toISOString(),
      profile: target.profile,
      source: {
        container: target.container,
        dataVolume: target.dataVolume,
        database: target.database,
        databaseId: target.databaseId,
        image: target.image,
        runtimeLabel: target.runtimeLabel,
        ports: {
          http: selection.profile.ports.neo4jHttp,
          bolt: selection.profile.ports.neo4jBolt,
        },
        volumes: target.volumes,
      },
      archive: {
        fileName: archiveName,
        sha256: sha256File(partialPath),
        sizeBytes: archiveStat.size,
        volume: target.dataVolume,
      },
      safety: {
        offline: true,
        writersQuiesced: true,
        checkedPorts,
      },
    };
    fs.writeFileSync(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    forceOwnerOnly(partialManifestPath, 'Operator backup manifest');
    syncFile(partialManifestPath);
    fs.renameSync(partialPath, archivePath);
    fs.renameSync(partialManifestPath, manifestPath);
    syncDirectory(absoluteOutput);
    verifyOperatorBackupManifest(manifestPath);
    archiveComplete = true;
  } catch (error) {
    operationError = asError(error);
  }

  let restartError: Error | undefined;
  if (stopped) {
    try {
      startAndWait(target.container, runner, sleep);
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
    throw new Error(`[operator-backup] ${messages.join('; ')}`);
  }
  return verifyOperatorBackupManifest(manifestPath);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface OperatorRestoreTarget {
  container: string;
  dataVolume: string;
  database: string;
  image: string;
  boltUri: string;
  running: boolean;
  writerPorts: readonly number[];
}

/**
 * Independent restore guard (LOCAL-014): resolve the target profile and prove
 * the target is a disposable runtime whose identity matches the verified
 * manifest. A health-check result is never consulted here.
 */
export function assertOperatorRestoreTarget(
  profileArgs: readonly string[],
  verified: VerifiedOperatorBackup,
  dependencies: OperatorBackupDependencies = {},
  options: { requireConfirmation?: boolean } = {}
): OperatorRestoreTarget {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? systemRunner;
  if (options.requireConfirmation !== false && env.NEO4J_OPERATOR_RESTORE_CONFIRM !== RESTORE_CONFIRMATION) {
    throw new Error(
      `Set NEO4J_OPERATOR_RESTORE_CONFIRM=${RESTORE_CONFIRMATION} to replace disposable graph data`
    );
  }
  const selection = resolveOperatorProfileSelection(profileArgs, env);

  // Disposability proof: the derived container AND every derived volume must
  // carry a disposable marker, and none may equal the protected canonical
  // default identities. The retained graph has no marker and is refused.
  const namesToProve = [selection.identity.container, ...selection.identity.volumes.map((volume) => volume.name)];
  for (const name of namesToProve) {
    if (!DISPOSABLE_NAME_PART.test(name)) {
      throw new Error(
        `Refusing restore into ${name}: the selected profile does not resolve to a proven disposable target ` +
          '(container and volume names must contain a disposable marker: selftest, e2e, benchmark, or test)'
      );
    }
  }
  if (
    selection.identity.container === SOURCE_CONTAINER ||
    selection.identity.volumes.some((volume) => volume.name === SOURCE_DATA_VOLUME)
  ) {
    throw new Error('Refusing restore into the protected canonical default Neo4j identities');
  }

  const boltUri = assertProfileBoltUri(env, selection.profile.ports.neo4jBolt);
  const database = env.NEO4J_DATABASE?.trim() || SOURCE_DATABASE;
  if (database !== verified.manifest.source.database) {
    throw new Error('Disposable restore database does not match the operator backup');
  }
  const runtime = verifyProfileNeo4jRuntimeIdentity(selection, runner);
  if (runtime.image !== verified.manifest.source.image) {
    throw new Error('Disposable restore image must match the operator backup source image');
  }
  assertExclusiveVolume(runtime.dataVolume, runtime.container, runner);
  return {
    container: runtime.container,
    dataVolume: runtime.dataVolume,
    database,
    image: runtime.image,
    boltUri,
    running: runtime.running,
    writerPorts: selection.writerPorts,
  };
}

export interface OperatorRestoreDryRunPlan {
  readonly dryRun: true;
  readonly manifestPath: string;
  readonly archivePath: string;
  readonly target: OperatorRestoreTarget;
  readonly writerPorts: readonly number[];
}

interface PreparedOperatorRestore {
  verified: VerifiedOperatorBackup;
  target: OperatorRestoreTarget;
}

function prepareOperatorBackupRestoreToDisposable(
  manifestPath: string,
  profileArgs: readonly string[],
  dependencies: OperatorBackupDependencies,
  requireConfirmation: boolean
): PreparedOperatorRestore {
  const verified = verifyOperatorBackupManifest(manifestPath);
  const target = assertOperatorRestoreTarget(profileArgs, verified, dependencies, { requireConfirmation });
  assertWriterPortsQuiesced(dependencies, target.writerPorts);
  const runner = dependencies.runner ?? systemRunner;
  assertArchiveContainsDatabase(
    archiveListing(target.image, path.dirname(verified.archivePath), path.basename(verified.archivePath), runner),
    target.database
  );
  return { verified, target };
}

/**
 * Perform every read-only restore guard without stopping a container or
 * mounting a writable volume. This is the operator-facing `--dry-run`
 * contract required before any destructive restore.
 */
export function planOperatorBackupRestoreToDisposable(
  manifestPath: string,
  profileArgs: readonly string[] = [],
  dependencies: OperatorBackupDependencies = {}
): OperatorRestoreDryRunPlan {
  const { verified, target } = prepareOperatorBackupRestoreToDisposable(
    manifestPath,
    profileArgs,
    dependencies,
    false
  );
  return {
    dryRun: true,
    manifestPath: verified.manifestPath,
    archivePath: verified.archivePath,
    target,
    writerPorts: [...target.writerPorts],
  };
}

function assertArchiveUnchangedSincePlanning(verified: VerifiedOperatorBackup): void {
  const archiveStat = assertOwnerOnlyRegularFile(verified.archivePath, 'Operator backup archive');
  if (archiveStat.size !== verified.manifest.archive.sizeBytes) {
    throw new Error('Operator backup archive size changed after restore planning');
  }
  if (sha256File(verified.archivePath) !== verified.manifest.archive.sha256) {
    throw new Error('Operator backup archive checksum changed after restore planning');
  }
}

/** Shared mutation primitive for every guarded restore path. */
function executeOperatorRestore(
  target: { container: string; dataVolume: string; database: string; image: string; running: boolean },
  verified: VerifiedOperatorBackup,
  dependencies: OperatorBackupDependencies,
  options: { verifyDatabaseId?: boolean; writerPorts?: readonly number[] } = {}
): boolean {
  const runner = dependencies.runner ?? systemRunner;
  const sleep = dependencies.sleep ?? defaultSleep;
  assertArchiveContainsDatabase(
    archiveListing(target.image, path.dirname(verified.archivePath), path.basename(verified.archivePath), runner),
    target.database
  );

  const wasRunning = target.running;
  if (wasRunning) {
    try {
      stopContainer(target.container, runner);
    } catch (error) {
      try {
        startAndWait(target.container, runner, sleep);
      } catch (restartError) {
        throw new Error(
          `[operator-restore] could not stop the target safely: ${asError(error).message}; ` +
            `restart failed: ${asError(restartError).message}`
        );
      }
      throw new Error(`[operator-restore] could not stop the target safely: ${asError(error).message}`);
    }
  }

  // Shrink the check/use window: after the stop, immediately before the
  // replacement mount, re-prove the stopped container still mounts the exact
  // verified data volume on the pinned image.
  {
    const reinspect = inspectContainer(target.container, runner);
    const dataMount = reinspect.Mounts?.find((mount) => mount.Destination === '/data');
    if (
      normalizeContainerName(reinspect.Name) !== target.container ||
      reinspect.Config?.Image !== target.image ||
      dataMount?.Type !== 'volume' ||
      dataMount.Name !== target.dataVolume
    ) {
      throw new Error(
        `[operator-restore] ${target.container} changed between verification and replacement; refusing to mutate`
      );
    }
  }

  // The archive and exclusive-volume proofs used for planning are not mutation
  // authority forever. Recheck both after the stop, immediately before the
  // destructive delete/extract boundary. A changed archive restores the
  // previously-running target because its own identity is still proven; a new
  // competing volume mount leaves the target stopped to avoid concurrent use.
  try {
    assertArchiveUnchangedSincePlanning(verified);
  } catch (error) {
    if (wasRunning) {
      try {
        startAndWait(target.container, runner, sleep);
      } catch (restartError) {
        throw new Error(
          `[operator-restore] final archive check failed: ${asError(error).message}; ` +
            `restart failed: ${asError(restartError).message}`
        );
      }
    }
    throw new Error(`[operator-restore] final archive check failed: ${asError(error).message}`);
  }
  assertExclusiveVolume(target.dataVolume, target.container, runner);
  if (options.writerPorts) {
    // This is the final pre-delete guard. Fail closed and leave the graph
    // stopped if a writer reappeared; restarting it here would knowingly
    // reconnect that writer.
    assertWriterPortsQuiesced(dependencies, options.writerPorts);
  }

  let replaced = false;
  try {
    runner.run('docker', [
      'run',
      '--rm',
      '--pull',
      'never',
      '--read-only',
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      volumeMount(target.dataVolume, '/target'),
      '--mount',
      bindMount(path.dirname(verified.archivePath), '/backup', true),
      '--entrypoint',
      '/bin/sh',
      target.image,
      '-eu',
      '-c',
      'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "$1" -C /target',
      'operator-backup-restore',
      `/backup/${path.basename(verified.archivePath)}`,
    ]);
    replaced = true;
  } catch (error) {
    throw new Error(
      `[operator-restore] replacement failed; ${target.container} was left stopped: ${asError(error).message}`
    );
  }

  // Always start after replacement to prove the restored volume actually
  // boots, then verify the restored database identity when requested. Any
  // failure stops the target best-effort so a half-restored graph can never
  // be mistaken for a healthy one.
  try {
    startAndWait(target.container, runner, sleep);
    if (options.verifyDatabaseId) {
      const restoredId = readContainerDatabaseId(
        {
          container: target.container,
          dataVolume: target.dataVolume,
          database: target.database,
          image: target.image,
        },
        runner
      );
      if (restoredId !== verified.manifest.source.databaseId) {
        throw new Error(
          `restored database ID ${restoredId} does not match manifest source ${verified.manifest.source.databaseId}`
        );
      }
    }
  } catch (error) {
    try {
      runner.run('docker', ['stop', '--time', '30', target.container]);
    } catch {
      // Best-effort containment; the original error is authoritative.
    }
    throw new Error(
      `[operator-restore] post-restore verification failed; ${target.container} was stopped and must not be ` +
        `treated as healthy: ${asError(error).message}`
    );
  }
  if (!wasRunning) {
    try {
      runner.run('docker', ['stop', '--time', '30', target.container]);
    } catch (error) {
      throw new Error(
        `[operator-restore] restored and verified, but could not return ${target.container} to a stopped state: ${asError(error).message}`
      );
    }
  }
  return replaced;
}

/**
 * Profile-bound disposable restore (the sanctioned CLI path). Restores only
 * into a target explicitly proven disposable and matching the selected
 * profile; the restored database identity is read back and compared with the
 * manifest before the command reports success.
 */
export function restoreOperatorBackupToDisposable(
  manifestPath: string,
  profileArgs: readonly string[] = [],
  dependencies: OperatorBackupDependencies = {}
): boolean {
  const { verified, target } = prepareOperatorBackupRestoreToDisposable(
    manifestPath,
    profileArgs,
    dependencies,
    true
  );
  return executeOperatorRestore(target, verified, dependencies, {
    verifyDatabaseId: true,
    writerPorts: target.writerPorts,
  });
}

/**
 * Rehearsal restore into the benchmark-env disposable target. Kept for the
 * graph-integrity rehearsal, whose own guard (`assertSafeBenchmarkTarget`)
 * already proves disposability; the rehearsal re-verifies content itself.
 */
export function restoreOperatorBackupToBenchmarkTarget(
  manifestPath: string,
  dependencies: OperatorBackupDependencies = {}
): boolean {
  const runner = dependencies.runner ?? systemRunner;
  const target: BenchmarkTarget = assertSafeBenchmarkTarget(
    { requireRunning: false, requireRestoreConfirmation: true },
    dependencies
  );
  const verified = verifyOperatorBackupManifest(manifestPath);
  if (target.database !== verified.manifest.source.database) {
    throw new Error('Disposable restore database does not match the operator backup');
  }
  if (target.image !== verified.manifest.source.image) {
    throw new Error('Disposable restore image must match the operator backup source image');
  }
  assertExclusiveVolume(target.dataVolume, target.container, runner);
  return executeOperatorRestore(
    {
      container: target.container,
      dataVolume: target.dataVolume,
      database: target.database,
      image: target.image,
      running: target.running,
    },
    verified,
    dependencies
  );
}

export const OPERATOR_BACKUP_CONFIRMATION = BACKUP_CONFIRMATION;
export const OPERATOR_APPLY_QUIESCENCE_CONFIRMATION = APPLY_QUIESCENCE_CONFIRMATION;
export const OPERATOR_RESTORE_CONFIRMATION = RESTORE_CONFIRMATION;
