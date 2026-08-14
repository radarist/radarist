/**
 * LOCAL-011 — profile-aware, read-only Neo4j health target resolution.
 *
 * This module is the health command's ONLY view of the runtime. It resolves
 * exactly one runtime profile through the canonical local-runtime authority
 * (`local-runtime-profile.ts`), derives the expected Docker identity from the
 * same naming derivation the launchers use, verifies that identity against
 * the Docker daemon, and only then probes the profile's own loopback ports.
 *
 * Fail-closed rules:
 *  - an explicit profile that is missing, mismatched, foreign-bound, or
 *    unavailable is reported and never falls back to another instance;
 *  - probes run only after the expected container identity matches, so a
 *    foreign process on the profile's ports can never be reported healthy;
 *  - no credentials are read or printed (no .env.local import, no NEO4J_AUTH).
 *
 * This is deliberately a SEPARATE boundary from the backup/restore guard in
 * `operator-neo4j-backup.ts`: a passing health check must never authorize a
 * destructive operation.
 */
import { createConnection } from 'node:net';
import type { CommandRunner } from '../benchmark/snapshot';
import { validateNeo4jDockerPluginEnv } from './local-demo';
import {
  LOCAL_RUNTIME_DOCKER_LABEL,
  LOCAL_RUNTIME_NEO4J_IMAGE,
  buildLocalRuntimeProfiles,
  deriveLocalRuntimeNeo4jDockerIdentity,
  parseLocalRuntimeProfileArg,
  resolveLocalRuntimeNameSuffix,
  type LocalRuntimeNeo4jVolumeMount,
  type LocalRuntimeProfileName,
} from './local-runtime-profile';

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_PROBLEMS = 12;

export interface Neo4jHealthTarget {
  readonly profile: LocalRuntimeProfileName;
  readonly projectId: string;
  readonly host: string;
  readonly httpPort: number;
  readonly boltPort: number;
  readonly httpUrl: string;
  readonly boltUri: string;
  readonly container: string;
  readonly image: string;
  readonly durableRuntimeLabel: string;
  readonly ephemeralRuntimeLabel: string;
  readonly volumes: readonly LocalRuntimeNeo4jVolumeMount[];
}

export interface Neo4jHealthSelection {
  readonly target: Neo4jHealthTarget;
  readonly portOffset: number;
  readonly nameSuffix: string;
}

function assertLoopbackHostname(hostname: string): void {
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(`Refusing non-loopback Neo4j health target host "${hostname}".`);
  }
}

function assertHealthPort(label: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Neo4j health target ${label} port: ${String(port)}.`);
  }
}

/**
 * Build the read-only health target for one already-resolved profile. The
 * host is fixed to loopback by construction; the explicit assertion exists so
 * a future manifest change can never silently introduce a foreign host.
 */
export function buildNeo4jHealthTarget(
  profile: {
    name: LocalRuntimeProfileName;
    projectId: string;
    ports: { neo4jHttp: number; neo4jBolt: number };
  },
  nameSuffix = '',
  host: string = LOOPBACK_HOST
): Neo4jHealthTarget {
  assertLoopbackHostname(host);
  assertHealthPort('HTTP', profile.ports.neo4jHttp);
  assertHealthPort('Bolt', profile.ports.neo4jBolt);
  const identity = deriveLocalRuntimeNeo4jDockerIdentity({ name: profile.name }, nameSuffix);
  return {
    profile: profile.name,
    projectId: profile.projectId,
    host,
    httpPort: profile.ports.neo4jHttp,
    boltPort: profile.ports.neo4jBolt,
    httpUrl: `http://${host}:${profile.ports.neo4jHttp}`,
    boltUri: `bolt://${host}:${profile.ports.neo4jBolt}`,
    container: identity.container,
    image: LOCAL_RUNTIME_NEO4J_IMAGE,
    durableRuntimeLabel: identity.durableRuntimeLabel,
    ephemeralRuntimeLabel: identity.ephemeralRuntimeLabel,
    volumes: identity.volumes,
  };
}

/**
 * Resolve exactly one profile through the canonical authority. Selection
 * errors (ambiguous flag, unknown name, malformed shift overrides) throw
 * before any Docker or network interaction.
 */
export function resolveNeo4jHealthSelection(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Neo4jHealthSelection {
  const profiles = buildLocalRuntimeProfiles(env);
  const profile = parseLocalRuntimeProfileArg(args, profiles);
  const nameSuffix = resolveLocalRuntimeNameSuffix(env);
  const rawOffset = env.RADARIST_LOCAL_RUNTIME_PORT_OFFSET;
  const portOffset = rawOffset === undefined || rawOffset === '' ? 0 : Number(rawOffset);
  return {
    target: buildNeo4jHealthTarget(profile, nameSuffix),
    portOffset,
    nameSuffix,
  };
}

// ---------------------------------------------------------------------------
// Docker identity verification
// ---------------------------------------------------------------------------

interface DockerInspectEntry {
  Name?: string;
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: unknown };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{ Destination?: string; Name?: string; Type?: string }>;
  State?: { Running?: boolean; Health?: { Status?: string } };
}

export type Neo4jContainerIdentity =
  | {
      state: 'matched';
      container: string;
      image: string;
      runtimeLabel: string;
      running: boolean;
      health: string | undefined;
      volumes: readonly string[];
    }
  | { state: 'missing'; container: string }
  | { state: 'mismatched'; container: string; problems: string[] };

function boundedProblems(problems: string[]): string[] {
  return problems.slice(0, MAX_PROBLEMS);
}

function normalizeContainerName(name: string | undefined): string {
  return name?.replace(/^\//, '') ?? '';
}

function verifyPortBindings(target: Neo4jHealthTarget, entry: DockerInspectEntry, problems: string[]): void {
  const bindings = entry.HostConfig?.PortBindings ?? {};
  const keys = Object.keys(bindings);
  const expectedKeys = new Set(['7474/tcp', '7687/tcp']);
  for (const key of keys) {
    if (!expectedKeys.has(key)) problems.push(`unexpected published container port ${key}`);
  }
  for (const [key, expectedHostPort] of [
    ['7474/tcp', target.httpPort],
    ['7687/tcp', target.boltPort],
  ] as const) {
    const entries = bindings[key];
    if (!Array.isArray(entries) || entries.length !== 1) {
      problems.push(`container port ${key} is not published exactly once`);
      continue;
    }
    const binding = entries[0];
    const hostIp = binding?.HostIp ?? '';
    if (!LOOPBACK_HOSTNAMES.has(hostIp)) {
      problems.push(`container port ${key} publishes on non-loopback interface "${hostIp || '<empty>'}"`);
    }
    if (binding?.HostPort !== String(expectedHostPort)) {
      problems.push(`container port ${key} publishes host port ${binding?.HostPort ?? '<none>'}, expected ${expectedHostPort}`);
    }
  }
}

function verifyVolumeMounts(target: Neo4jHealthTarget, entry: DockerInspectEntry, problems: string[]): void {
  const mounts = entry.Mounts ?? [];
  const expected = new Map(target.volumes.map((volume) => [volume.destination, volume.name]));
  const seen = new Set<string>();
  for (const mount of mounts) {
    const destination = mount.Destination ?? '';
    const expectedName = expected.get(destination);
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
  for (const destination of expected.keys()) {
    if (!seen.has(destination)) problems.push(`missing expected volume mount at ${destination}`);
  }
}

function verifyVolumeLabels(
  target: Neo4jHealthTarget,
  runtimeLabel: string,
  runner: CommandRunner,
  problems: string[]
): void {
  for (const volume of target.volumes) {
    let label: string | undefined;
    try {
      label = runner
        .run('docker', [
          'volume',
          'inspect',
          '--format',
          `{{index .Labels "${LOCAL_RUNTIME_DOCKER_LABEL}"}}`,
          volume.name,
        ])
        .trim();
    } catch {
      problems.push(`volume ${volume.name} does not exist`);
      continue;
    }
    if (label !== runtimeLabel) {
      problems.push(
        `volume ${volume.name} has runtime label "${label || '<none>'}", expected "${runtimeLabel}"`
      );
    }
  }
}

/**
 * Verify that the Docker container named by the target IS the profile's Neo4j
 * runtime: exact name, pinned image, profile runtime label, loopback-only
 * bindings of the profile's own ports, and (for durable runtimes) the exact
 * profile-labelled named volumes. Any mismatch fails closed; nothing here
 * mutates Docker state.
 */
export function inspectNeo4jContainerIdentity(
  target: Neo4jHealthTarget,
  runner: CommandRunner
): Neo4jContainerIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runner.run('docker', ['inspect', target.container]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such object|no such container/i.test(message)) {
      return { state: 'missing', container: target.container };
    }
    return {
      state: 'mismatched',
      container: target.container,
      problems: boundedProblems([`Docker inspection failed: ${message.split('\n')[0]}`]),
    };
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    return {
      state: 'mismatched',
      container: target.container,
      problems: ['Docker returned invalid inspect data'],
    };
  }
  const entry = parsed[0] as DockerInspectEntry;
  const problems: string[] = [];

  if (normalizeContainerName(entry.Name) !== target.container) {
    problems.push(`inspect returned container "${normalizeContainerName(entry.Name)}", expected "${target.container}"`);
  }
  if (entry.Config?.Image !== target.image) {
    problems.push(`image "${entry.Config?.Image ?? '<none>'}", expected "${target.image}"`);
  }
  const pluginValidation = validateNeo4jDockerPluginEnv(entry.Config?.Env);
  if (!pluginValidation.valid) {
    problems.push(`plugin configuration invalid: ${pluginValidation.reason}`);
  } else if (pluginValidation.provisioning === 'legacy-auto') {
    problems.push(
      'plugin configuration uses the legacy mutable GDS resolver; run demo:full to migrate it'
    );
  }
  const runtimeLabel = entry.Config?.Labels?.[LOCAL_RUNTIME_DOCKER_LABEL] ?? '';
  const isDurable = runtimeLabel === target.durableRuntimeLabel;
  const isEphemeral = runtimeLabel === target.ephemeralRuntimeLabel;
  if (!isDurable && !isEphemeral) {
    problems.push(
      `runtime label "${runtimeLabel || '<none>'}", expected "${target.durableRuntimeLabel}" or "${target.ephemeralRuntimeLabel}"`
    );
  }
  verifyPortBindings(target, entry, problems);
  if (isDurable) {
    verifyVolumeMounts(target, entry, problems);
    verifyVolumeLabels(target, runtimeLabel, runner, problems);
  }

  if (problems.length > 0) {
    return { state: 'mismatched', container: target.container, problems: boundedProblems(problems) };
  }
  return {
    state: 'matched',
    container: target.container,
    image: target.image,
    runtimeLabel,
    running: entry.State?.Running === true,
    health: entry.State?.Health?.Status,
    volumes: isDurable ? target.volumes.map((volume) => volume.name) : [],
  };
}

// ---------------------------------------------------------------------------
// Bounded loopback probes (run only after identity matches)
// ---------------------------------------------------------------------------

export interface Neo4jSurfaceStatus {
  ok: boolean;
  detail: string;
}

export type Neo4jHttpProbe = (url: string, timeoutMs: number) => Promise<Neo4jSurfaceStatus>;
export type Neo4jTcpProbe = (host: string, port: number, timeoutMs: number) => Promise<Neo4jSurfaceStatus>;

const defaultHttpProbe: Neo4jHttpProbe = async (url, timeoutMs) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

const defaultTcpProbe: Neo4jTcpProbe = (host, port, timeoutMs) =>
  new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (status: Neo4jSurfaceStatus): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(status);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, detail: 'TCP connect succeeded' }));
    socket.once('timeout', () => finish({ ok: false, detail: `TCP connect timed out after ${timeoutMs}ms` }));
    socket.once('error', (error) => finish({ ok: false, detail: error.message }));
  });

export interface Neo4jHealthReport {
  target: Neo4jHealthTarget;
  identity: Neo4jContainerIdentity;
  http: Neo4jSurfaceStatus | null;
  bolt: Neo4jSurfaceStatus | null;
  healthy: boolean;
  problems: string[];
}

export interface Neo4jHealthDependencies {
  runner: CommandRunner;
  httpProbe?: Neo4jHttpProbe;
  tcpProbe?: Neo4jTcpProbe;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Read-only health check. Probes execute ONLY when the container identity
 * matched the selected profile; a missing or mismatched profile container
 * skips every probe so a foreign listener can never be reported healthy.
 */
export async function checkNeo4jHealth(
  target: Neo4jHealthTarget,
  dependencies: Neo4jHealthDependencies
): Promise<Neo4jHealthReport> {
  const httpProbe = dependencies.httpProbe ?? defaultHttpProbe;
  const tcpProbe = dependencies.tcpProbe ?? defaultTcpProbe;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const identity = inspectNeo4jContainerIdentity(target, dependencies.runner);

  if (identity.state === 'missing') {
    return {
      target,
      identity,
      http: null,
      bolt: null,
      healthy: false,
      problems: [
        `container ${target.container} is not present for profile ${target.profile}; refusing to probe unowned loopback ports`,
      ],
    };
  }
  if (identity.state === 'mismatched') {
    return {
      target,
      identity,
      http: null,
      bolt: null,
      healthy: false,
      problems: identity.problems.map((problem) => `container ${target.container} identity mismatch: ${problem}`),
    };
  }
  if (!identity.running) {
    return {
      target,
      identity,
      http: null,
      bolt: null,
      healthy: false,
      problems: [`container ${target.container} is not running`],
    };
  }

  const [http, bolt] = await Promise.all([
    httpProbe(target.httpUrl, timeoutMs),
    tcpProbe(target.host, target.boltPort, timeoutMs),
  ]);
  const problems: string[] = [];
  if (!http.ok) problems.push(`HTTP probe of ${target.httpUrl} failed: ${http.detail}`);
  if (!bolt.ok) problems.push(`Bolt probe of ${target.boltUri} failed: ${bolt.detail}`);
  if (identity.health !== undefined && identity.health !== 'healthy') {
    problems.push(`container ${target.container} reports ${identity.health}, expected healthy`);
  }
  return {
    target,
    identity,
    http,
    bolt,
    healthy: problems.length === 0,
    problems: boundedProblems(problems),
  };
}
