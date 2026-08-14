/**
 * @file scripts/lib/disposable-neo4j-runtime.ts
 * @description TEST-023 — the caller-owned disposable graph that browser
 * acceptance lanes declare but do not provision themselves.
 *
 * Two lanes in `tests/e2e/runtime-manifest.json` declare
 * `neo4j: 'caller-owned-disposable'` (`demo`, `relation-workflow-integrity`).
 * Nothing owned that half of the contract, so `npm run e2e:partition-proof`
 * could never execute them and the all-active receipt was unreachable.
 *
 * The port matters as much as the lifecycle. The repository-wide disposable
 * integration port 17687 is ALSO the Bolt port of the canonical `selftest`
 * local-runtime profile (`scripts/lib/local-runtime-profile.ts`), so a demo
 * journey pointed at 17687 while an operator's retained selftest stack is up
 * seeds and then DELETES its graph fixture inside retained data — and
 * `assertDisposableNeo4jIntegrationTarget` cannot tell the two apart, because
 * both are loopback and neither is the protected default 7687. Browser
 * acceptance therefore gets its own Bolt/HTTP pair that no durable profile
 * publishes, and this module refuses to run unless it can prove the graph it
 * hands out is a container this process created and left empty.
 *
 * Every proof is exact rather than advisory:
 *  - the published ports must be free BEFORE the container starts, so an
 *    occupied port fails closed instead of adopting a foreign graph;
 *  - the container name must be absent, and is unique per process;
 *  - the started container is re-inspected for the pinned image, automatic
 *    removal, the ownership label, loopback-only bindings, and a `/data`
 *    tmpfs with no bind or volume mount — a graph that cannot outlive it;
 *  - the first Bolt session proves the server identifies as Neo4j and holds
 *    zero nodes, which is what makes "this is not retained data" a measurement
 *    rather than an assumption;
 *  - teardown removes the container and proves its absence.
 */
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

import neo4j from 'neo4j-driver';
import { stopAndRemoveDockerContainer } from './docker-container-cleanup';

/** Pinned image, shared with every other disposable graph in the repository. */
export const DISPOSABLE_NEO4J_IMAGE = 'neo4j:5.15.0-community';
export const DISPOSABLE_NEO4J_LABEL_KEY = 'radarist.disposable-graph';

/**
 * Browser-acceptance Bolt/HTTP pair. Deliberately outside every canonical
 * local-runtime profile (default 7687/7474, selftest 17687/17474), the
 * TEST-023 offset stack (30687/30474) and the relation-integrity graph
 * (17690/17475), so no lane can reach a durable graph by accident.
 */
export const BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT = 17692;
export const BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT = 17477;
export const BROWSER_ACCEPTANCE_NEO4J_URI = `bolt://127.0.0.1:${BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT}`;
export const BROWSER_ACCEPTANCE_NEO4J_USER = 'neo4j';
export const BROWSER_ACCEPTANCE_NEO4J_DATABASE = 'neo4j';

/** Bolt ports this module must never publish onto. */
const PROTECTED_BOLT_PORTS = new Set([7687, 17687]);
const PROTECTED_HTTP_PORTS = new Set([7474, 17474]);

export interface DisposableNeo4jOptions {
  readonly containerName: string;
  readonly boltPort: number;
  readonly httpPort: number;
  readonly password: string;
  readonly labelValue: string;
}

export interface DisposableNeo4jHandle {
  readonly containerId: string;
  readonly uri: string;
  readonly env: Readonly<Record<string, string>>;
}

interface DockerPortBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

interface DockerMount {
  readonly Type?: string;
  readonly Destination?: string;
}

export interface DisposableNeo4jInspection {
  readonly Id?: string;
  readonly State?: { readonly Running?: boolean };
  readonly HostConfig?: { readonly AutoRemove?: boolean };
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>>;
    readonly Env?: readonly string[];
  };
  readonly Mounts?: readonly DockerMount[];
  readonly NetworkSettings?: {
    readonly Ports?: Readonly<Record<string, readonly DockerPortBinding[] | null>>;
  };
}

/** Unique per process so a crashed run can never be adopted by a later one. */
export function disposableNeo4jContainerName(prefix: string, pid: number, nonce: string): string {
  if (!/^[a-z0-9-]{4,40}$/.test(prefix)) throw new Error('Disposable graph prefix must be kebab-case.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Disposable graph pid must be positive.');
  if (!/^[a-f0-9]{8}$/.test(nonce)) throw new Error('Disposable graph nonce must be eight hex characters.');
  return `${prefix}-${pid.toString(36)}-${nonce}-ephemeral`;
}

export function assertDisposableNeo4jPorts(options: DisposableNeo4jOptions): void {
  if (PROTECTED_BOLT_PORTS.has(options.boltPort)) {
    throw new Error(
      `Disposable graph refuses Bolt port ${options.boltPort}: it belongs to a durable local-runtime profile.`
    );
  }
  if (PROTECTED_HTTP_PORTS.has(options.httpPort)) {
    throw new Error(
      `Disposable graph refuses HTTP port ${options.httpPort}: it belongs to a durable local-runtime profile.`
    );
  }
  if (options.boltPort === options.httpPort) {
    throw new Error('Disposable graph Bolt and HTTP ports must differ.');
  }
  for (const port of [options.boltPort, options.httpPort]) {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error(`Disposable graph port ${port} is outside the usable unprivileged range.`);
    }
  }
}

/** Exact `docker run` argv — no volumes, no bind mounts, loopback only. */
export function disposableNeo4jRunArgs(options: DisposableNeo4jOptions): string[] {
  assertDisposableNeo4jPorts(options);
  return [
    'run',
    '--rm',
    '--detach',
    '--name',
    options.containerName,
    '--label',
    `${DISPOSABLE_NEO4J_LABEL_KEY}=${options.labelValue}`,
    // `--mount type=tmpfs` rather than `--tmpfs`: the short form is recorded in
    // HostConfig.Tmpfs and never appears in `Mounts`, so it cannot be verified
    // alongside the mounts it is supposed to displace. Both paths the image
    // declares as VOLUME are covered — an uncovered one becomes an anonymous
    // Docker volume, which is exactly the residue the partition receipt fails on.
    '--mount',
    'type=tmpfs,destination=/data',
    '--mount',
    'type=tmpfs,destination=/logs',
    '--publish',
    `127.0.0.1:${options.httpPort}:7474`,
    '--publish',
    `127.0.0.1:${options.boltPort}:7687`,
    '--env',
    `NEO4J_AUTH=${BROWSER_ACCEPTANCE_NEO4J_USER}/${options.password}`,
    DISPOSABLE_NEO4J_IMAGE,
  ];
}

function loopbackBinding(bindings: readonly DockerPortBinding[] | null | undefined, port: number): boolean {
  return (bindings ?? []).some(
    (binding) => (binding.HostIp === '127.0.0.1' || binding.HostIp === '::1') && binding.HostPort === String(port)
  );
}

/**
 * Every way the started container could still reach or outlive retained data.
 * Returned as a list so a refusal names all of them at once.
 */
export function disposableNeo4jInspectionProblems(
  inspection: DisposableNeo4jInspection,
  options: DisposableNeo4jOptions
): string[] {
  const problems: string[] = [];
  if (inspection.State?.Running !== true) problems.push('container is not running');
  if (inspection.HostConfig?.AutoRemove !== true) problems.push('container must enable automatic removal');
  if (inspection.Config?.Image !== DISPOSABLE_NEO4J_IMAGE) {
    problems.push(`image must be ${DISPOSABLE_NEO4J_IMAGE}`);
  }
  if (inspection.Config?.Labels?.[DISPOSABLE_NEO4J_LABEL_KEY] !== options.labelValue) {
    problems.push('ownership label does not match this run');
  }
  const auth = (inspection.Config?.Env ?? []).filter((entry) => entry.startsWith('NEO4J_AUTH='));
  if (auth.length !== 1 || auth[0] !== `NEO4J_AUTH=${BROWSER_ACCEPTANCE_NEO4J_USER}/${options.password}`) {
    problems.push('container credentials do not match this run');
  }
  const mounts = inspection.Mounts ?? [];
  for (const destination of ['/data', '/logs']) {
    if (!mounts.some((mount) => mount.Type === 'tmpfs' && mount.Destination === destination)) {
      problems.push(`graph storage must use an ephemeral ${destination} tmpfs mount`);
    }
  }
  if (mounts.some((mount) => mount.Type !== 'tmpfs')) {
    problems.push('bind and volume mounts are forbidden for a disposable graph');
  }
  const ports = inspection.NetworkSettings?.Ports ?? {};
  if (!loopbackBinding(ports['7687/tcp'], options.boltPort)) {
    problems.push(`Bolt must be bound to loopback port ${options.boltPort}`);
  }
  if (!loopbackBinding(ports['7474/tcp'], options.httpPort)) {
    problems.push(`HTTP must be bound to loopback port ${options.httpPort}`);
  }
  for (const [portSpec, bindings] of Object.entries(ports)) {
    for (const binding of bindings ?? []) {
      if (binding.HostIp && binding.HostIp !== '127.0.0.1' && binding.HostIp !== '::1') {
        problems.push(`${portSpec} is published beyond loopback (${binding.HostIp})`);
      }
    }
  }
  return problems;
}

/** The graph environment a caller-owned lane needs, and nothing else. */
export function disposableNeo4jChildEnv(options: DisposableNeo4jOptions): Record<string, string> {
  return {
    RADARIST_GRAPH_RUNTIME_MODE: 'neo4j',
    NEO4J_URI: `bolt://127.0.0.1:${options.boltPort}`,
    NEO4J_USER: BROWSER_ACCEPTANCE_NEO4J_USER,
    NEO4J_PASSWORD: options.password,
    NEO4J_DATABASE: BROWSER_ACCEPTANCE_NEO4J_DATABASE,
    NEO4J_INTEGRATION_DISPOSABLE: 'true',
  };
}

function runDocker(args: readonly string[], allowStatus: readonly number[] = [0]) {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { PATH: process.env.PATH },
  });
  if (result.error) throw result.error;
  if (!allowStatus.includes(result.status ?? -1)) {
    throw new Error(
      `docker ${args[0] ?? ''} failed (${String(result.status)}): ${`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()}`
    );
  }
  return result;
}

function isMissingContainer(output: string): boolean {
  return /no such (?:object|container)/i.test(output);
}

function containerAbsent(reference: string): boolean {
  const result = runDocker(['inspect', '--type', 'container', reference], [0, 1]);
  if (result.status === 0) return false;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!isMissingContainer(output)) {
    throw new Error(`Could not prove disposable graph ${reference} is absent: ${output.trim()}`);
  }
  return true;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

/** Name the process holding a port so a refusal is actionable, not a riddle. */
function describePortHolders(ports: readonly number[]): string {
  const result = spawnSync('lsof', ['-nP', '-sTCP:LISTEN', ...ports.map((port) => `-iTCP:${port}`)], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean).slice(1, 4);
  return lines.length > 0 ? lines.join(' | ') : 'holder unknown';
}

/**
 * `before launch` is a single immediate check — an occupied port there means a
 * foreign holder and must fail fast rather than wait for it. `after cleanup`
 * polls, because Docker's userland proxy releases a published port shortly
 * AFTER the container disappears, and a race there would report a leak the run
 * did not cause.
 */
async function assertPortsFree(options: DisposableNeo4jOptions, phase: string, timeoutMs = 0): Promise<void> {
  const ports = [options.boltPort, options.httpPort];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all(ports.map(portIsListening));
    const occupied = ports.filter((_, index) => states[index]);
    if (occupied.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Disposable graph ports occupied ${phase}: ${occupied.join(', ')} — ${describePortHolders(occupied)}`
      );
    }
    await sleep(250);
  }
}

/**
 * Wait for Bolt, then PROVE the target is a graph this run owns: it must
 * identify as Neo4j and hold zero nodes. An empty database cannot be a retained
 * workspace, which is the only claim worth making before a lane starts writing.
 */
async function verifyEmptyOwnedGraph(options: DisposableNeo4jOptions, timeoutMs: number): Promise<void> {
  const driver = neo4j.driver(
    `bolt://127.0.0.1:${options.boltPort}`,
    neo4j.auth.basic(BROWSER_ACCEPTANCE_NEO4J_USER, options.password)
  );
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
      try {
        await driver.verifyConnectivity();
        break;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) {
          throw new Error(
            `Disposable graph never accepted Bolt within ${timeoutMs}ms: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`
          );
        }
        await sleep(500);
      }
    }

    const session = driver.session({ database: BROWSER_ACCEPTANCE_NEO4J_DATABASE });
    try {
      const components = await session.run('CALL dbms.components() YIELD name RETURN name LIMIT 1');
      const name = components.records.length === 1 ? String(components.records[0].get('name')) : '';
      if (!name.includes('Neo4j')) {
        throw new Error('Disposable graph target did not identify itself as a Neo4j database');
      }
      const nodes = await session.run('MATCH (n) RETURN count(n) AS total');
      // Counts arrive as driver Integers; a plain Number() coercion on one is
      // not guaranteed, and a NaN here would silently pass the !== 0 check.
      const raw: unknown = nodes.records[0]?.get('total');
      const total = neo4j.isInt(raw) ? neo4j.integer.toNumber(raw) : Number(raw);
      if (!Number.isSafeInteger(total) || total !== 0) {
        throw new Error(
          `Disposable graph target already holds ${total} nodes; refusing to treat retained data as disposable`
        );
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

async function removeOwnedContainer(reference: string): Promise<void> {
  await stopAndRemoveDockerContainer(reference, {
    stop: (container) => {
      runDocker(['stop', '--time', '10', container], [0, 1]);
    },
    // `--volumes` so a forced removal still discards any anonymous volume the
    // image would otherwise leave behind for a VOLUME path that was not covered.
    forceRemove: (container) => {
      runDocker(['rm', '--force', '--volumes', container], [0, 1]);
    },
    exists: (container) => !containerAbsent(container),
    wait: sleep,
  });
}

export interface DisposableNeo4jRuntimeOptions {
  readonly namePrefix: string;
  readonly labelValue: string;
  readonly boltPort?: number;
  readonly httpPort?: number;
  readonly readinessTimeoutMs?: number;
}

/**
 * Own a disposable Neo4j for the duration of `inner`. Teardown runs on every
 * path, and a teardown failure is reported even when `inner` already failed —
 * a leaked graph container is exactly the residue the partition receipt refuses.
 */
export async function withDisposableNeo4j<T>(
  runtime: DisposableNeo4jRuntimeOptions,
  inner: (handle: DisposableNeo4jHandle) => Promise<T>
): Promise<T> {
  const options: DisposableNeo4jOptions = {
    containerName: disposableNeo4jContainerName(runtime.namePrefix, process.pid, randomBytes(4).toString('hex')),
    boltPort: runtime.boltPort ?? BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT,
    httpPort: runtime.httpPort ?? BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT,
    password: `disposable-${randomBytes(12).toString('hex')}`,
    labelValue: runtime.labelValue,
  };
  assertDisposableNeo4jPorts(options);
  await assertPortsFree(options, 'before launch');
  if (!containerAbsent(options.containerName)) {
    throw new Error(`Refusing to reuse existing container ${options.containerName}`);
  }

  const started = runDocker(disposableNeo4jRunArgs(options));
  const containerId = (started.stdout ?? '').trim();
  // A successful `docker run` means this process owns the previously absent
  // name, so keep it as the cleanup target even if stdout was malformed.
  let cleanupReference = options.containerName;
  let removed = false;
  // Last-resort synchronous sweep for an exit path that skips the teardown
  // below (an explicit process.exit, an uncaught throw in a listener). A leaked
  // graph would hold the published port and fail every later run closed.
  const sweep = (): void => {
    if (removed) return;
    spawnSync('docker', ['rm', '--force', '--volumes', cleanupReference], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH },
    });
  };
  process.on('exit', sweep);
  let failure: unknown;
  let result: T | undefined;
  try {
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error('Docker did not return the full disposable graph container id');
    }
    cleanupReference = containerId;
    const inspection = runDocker(['inspect', '--type', 'container', containerId]);
    const parsed = JSON.parse(inspection.stdout ?? '[]') as DisposableNeo4jInspection[];
    if (parsed.length !== 1 || parsed[0]?.Id !== containerId) {
      throw new Error('Disposable graph inspection did not describe exactly the started container');
    }
    const problems = disposableNeo4jInspectionProblems(parsed[0], options);
    if (problems.length > 0) {
      throw new Error(`Disposable graph container is not isolated: ${problems.join('; ')}`);
    }
    await verifyEmptyOwnedGraph(options, runtime.readinessTimeoutMs ?? 180_000);
    result = await inner({
      containerId,
      uri: `bolt://127.0.0.1:${options.boltPort}`,
      env: disposableNeo4jChildEnv(options),
    });
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  try {
    await removeOwnedContainer(cleanupReference);
    removed = true;
  } catch (error) {
    cleanupFailures.push(error);
  } finally {
    process.off('exit', sweep);
  }
  try {
    await assertPortsFree(options, 'after cleanup', 15_000);
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (failure && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], 'Disposable graph run and cleanup both failed');
  }
  if (failure) throw failure;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Disposable graph cleanup failed');
  }
  return result as T;
}
