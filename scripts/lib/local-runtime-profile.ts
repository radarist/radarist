import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const LOCAL_RUNTIME_PROFILE_NAMES = ['default', 'selftest'] as const;

export type LocalRuntimeProfileName = (typeof LOCAL_RUNTIME_PROFILE_NAMES)[number];

export const LOCAL_RUNTIME_PORT_NAMES = [
  'app',
  'inngest',
  'firebaseUi',
  'firebaseFirestoreWebsocket',
  'firebaseHub',
  'firebaseLogging',
  'firestore',
  'auth',
  'storage',
  'neo4jHttp',
  'neo4jBolt',
] as const;

export type LocalRuntimePortName = (typeof LOCAL_RUNTIME_PORT_NAMES)[number];
export type LocalRuntimePortInventory = Readonly<Record<LocalRuntimePortName, number>>;

export interface LocalRuntimeProfile {
  readonly name: LocalRuntimeProfileName;
  readonly projectId: string;
  readonly ports: LocalRuntimePortInventory;
}

const BASE_LOCAL_RUNTIME_PROFILES: Readonly<Record<LocalRuntimeProfileName, LocalRuntimeProfile>> = {
  default: {
    name: 'default',
    projectId: 'demo-radarist',
    ports: {
      app: 9002,
      inngest: 8288,
      firebaseUi: 4000,
      firebaseFirestoreWebsocket: 9150,
      firebaseHub: 4400,
      firebaseLogging: 4500,
      firestore: 8080,
      auth: 9099,
      storage: 9199,
      neo4jHttp: 7474,
      neo4jBolt: 7687,
    },
  },
  selftest: {
    name: 'selftest',
    projectId: 'demo-radarist-selftest',
    ports: {
      app: 9012,
      inngest: 18288,
      firebaseUi: 14000,
      firebaseFirestoreWebsocket: 14150,
      firebaseHub: 14400,
      firebaseLogging: 14500,
      firestore: 18080,
      auth: 19099,
      storage: 19199,
      neo4jHttp: 17474,
      neo4jBolt: 17687,
    },
  },
};

// ============================================================================
// Disposable runtime overrides (TEST-024 / LOCAL-009 acceptance)
//
// Destructive acceptance must never touch the canonical profile ports or the
// durable Neo4j containers/volumes. These strictly-validated env knobs let a
// harness launch REAL default/selftest stacks on shifted ports with distinctly
// named Docker resources, while an unset environment stays byte-identical to
// the checked-in tables.
// ============================================================================

export const LOCAL_RUNTIME_PORT_OFFSET_ENV = 'RADARIST_LOCAL_RUNTIME_PORT_OFFSET';
export const LOCAL_RUNTIME_NAME_SUFFIX_ENV = 'RADARIST_LOCAL_RUNTIME_NAME_SUFFIX';
export const LOCAL_RUNTIME_DATA_ROOT_ENV = 'RADARIST_LOCAL_RUNTIME_DATA_ROOT';
export const LOCAL_RUNTIME_ENV_DIR_ENV = 'RADARIST_LOCAL_RUNTIME_ENV_DIR';

/**
 * Optional directory override for the profile env files (`.env.local` /
 * `.env.selftest.local`). Disposable acceptance stacks point this at an owned
 * temp directory so a launcher run can never read or rewrite the developer's
 * real repo-root env files. Unset keeps the checked-in repo-root behavior
 * byte-identical.
 */
export function resolveLocalRuntimeEnvFileDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[LOCAL_RUNTIME_ENV_DIR_ENV];
  if (raw === undefined || raw === '') return undefined;
  if (!isAbsolute(raw)) {
    throw new Error(`Invalid local runtime env directory "${raw}": expected an absolute path.`);
  }
  return resolve(raw);
}

/**
 * Optional data-root override for disposable acceptance stacks. Launchers root
 * profile state at `<repo>/emulator-data` unless this absolute path is set;
 * acceptance harnesses point it at an owned temp directory so destructive runs
 * can never touch the canonical durable workspaces.
 */
export function resolveLocalRuntimeDataRoot(repositoryRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[LOCAL_RUNTIME_DATA_ROOT_ENV];
  if (raw === undefined || raw === '') return resolve(repositoryRoot, 'emulator-data');
  if (!isAbsolute(raw)) {
    throw new Error(`Invalid local runtime data root "${raw}": expected an absolute path.`);
  }
  return resolve(raw);
}
/** Highest base port is 19199; cap keeps every shifted port under 65536. */
export const MAX_LOCAL_RUNTIME_PORT_OFFSET = 40_000;

export function resolveLocalRuntimePortOffset(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LOCAL_RUNTIME_PORT_OFFSET_ENV];
  // Empty string is "unset", matching every sibling override resolver — an
  // exported-but-empty variable must not crash module load for npm run demo.
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid local runtime port offset "${raw}": expected a non-negative integer.`);
  }
  const offset = Number(raw);
  if (offset > MAX_LOCAL_RUNTIME_PORT_OFFSET) {
    throw new Error(`Invalid local runtime port offset ${offset}: maximum is ${MAX_LOCAL_RUNTIME_PORT_OFFSET}.`);
  }
  return offset;
}

export function assertLocalRuntimeNameSuffix(raw: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw)) {
    throw new Error(
      `Invalid local runtime name suffix "${raw}": expected 1-32 lowercase alphanumeric/dash characters starting alphanumeric.`
    );
  }
  return raw;
}

export function resolveLocalRuntimeNameSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[LOCAL_RUNTIME_NAME_SUFFIX_ENV];
  if (raw === undefined || raw === '') return '';
  return assertLocalRuntimeNameSuffix(raw);
}

export function shiftLocalRuntimeProfilePorts(profile: LocalRuntimeProfile, offset: number): LocalRuntimeProfile {
  if (offset === 0) return profile;
  const ports = Object.fromEntries(
    LOCAL_RUNTIME_PORT_NAMES.map((name) => {
      const shifted = profile.ports[name] + offset;
      assertPort(`${profile.name}.${name}`, shifted);
      return [name, shifted];
    })
  ) as Record<LocalRuntimePortName, number>;
  return { ...profile, ports };
}

export function buildLocalRuntimeProfiles(
  env: NodeJS.ProcessEnv = process.env
): Readonly<Record<LocalRuntimeProfileName, LocalRuntimeProfile>> {
  const offset = resolveLocalRuntimePortOffset(env);
  const profiles = {
    default: shiftLocalRuntimeProfilePorts(BASE_LOCAL_RUNTIME_PROFILES.default, offset),
    selftest: shiftLocalRuntimeProfilePorts(BASE_LOCAL_RUNTIME_PROFILES.selftest, offset),
  } as const;
  assertNoLocalRuntimePortCollisions(Object.values(profiles));
  return profiles;
}

/**
 * The active profile table for this process. Built once at module load from
 * the process environment so every consumer (launchers, doctor, harnesses,
 * DEMO_PROFILES) sees one consistent inventory; an unset environment yields
 * exactly the checked-in canonical ports.
 */
export const LOCAL_RUNTIME_PROFILES: Readonly<Record<LocalRuntimeProfileName, LocalRuntimeProfile>> =
  buildLocalRuntimeProfiles(process.env);

export interface LocalRuntimePaths {
  readonly profileName: LocalRuntimeProfileName;
  readonly dataRoot: string;
  readonly root: string;
  readonly runtime: string;
  readonly home: string;
  readonly temp: string;
  /** Firebase Storage uses `${os.tmpdir()}/firebase/storage/blobs`. */
  readonly storageBlobs: string;
  readonly workingDirectory: string;
  /**
   * LOCAL-013 — working directory for the Inngest dev server.
   *
   * `inngest dev --persist` writes its queue state to `<cwd>/.inngest/`, which
   * is CWD-relative rather than `$HOME`-relative. Giving it a dedicated
   * directory inside the profile root is therefore what makes the persisted
   * queue profile-private, and keeps its state out of the shared work tree.
   */
  readonly inngestState: string;
  readonly exports: string;
  readonly checkpoints: string;
  readonly status: string;
  readonly pids: string;
  readonly logs: string;
  readonly config: string;
  readonly cache: string;
  readonly processManifest: string;
  readonly runtimeLease: string;
}

export interface LocalRuntimeExecutionContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface EphemeralLocalRuntimeExecutionContext {
  readonly sessionRoot: string;
  readonly paths: LocalRuntimePaths;
  readonly context: LocalRuntimeExecutionContext;
}

export interface LocalRuntimePortClaim {
  readonly profileName: string;
  readonly name: LocalRuntimePortName;
  readonly port: number;
}

export interface LocalRuntimePortCollision {
  readonly port: number;
  readonly claims: readonly LocalRuntimePortClaim[];
}

export type LocalRuntimePortProbe = (host: string, port: number) => Promise<boolean>;

const PRIVATE_DIRECTORY_MODE = 0o700;

function isProfileName(value: unknown): value is LocalRuntimeProfileName {
  return typeof value === 'string' && (LOCAL_RUNTIME_PROFILE_NAMES as readonly string[]).includes(value);
}

export function parseLocalRuntimeProfileName(value: unknown): LocalRuntimeProfileName {
  if (!isProfileName(value)) {
    const printable = typeof value === 'string' && value.trim() ? ` "${value}"` : '';
    throw new Error(
      `Unknown local runtime profile${printable}. Expected one of: ${LOCAL_RUNTIME_PROFILE_NAMES.join(', ')}.`
    );
  }
  return value;
}

export function getLocalRuntimeProfile(value: unknown): LocalRuntimeProfile {
  return LOCAL_RUNTIME_PROFILES[parseLocalRuntimeProfileName(value)];
}

/**
 * Parse one optional profile selector. Unlike the legacy demo helper, an
 * explicit unknown or missing value never falls back to the default workspace.
 * The profile table is injectable so callers can resolve against an env-scoped
 * (shifted/suffixed) inventory instead of the process-level singleton.
 */
export function parseLocalRuntimeProfileArg(
  args: readonly string[],
  profiles: Readonly<Record<LocalRuntimeProfileName, LocalRuntimeProfile>> = LOCAL_RUNTIME_PROFILES
): LocalRuntimeProfile {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('The --profile option requires an explicit profile name.');
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length);
      if (!value) throw new Error('The --profile option requires an explicit profile name.');
      values.push(value);
    }
  }

  if (values.length > 1) throw new Error('Specify --profile exactly once.');
  if (values.length === 0) return profiles.default;
  const name = parseLocalRuntimeProfileName(values[0]);
  return profiles[name];
}

// ============================================================================
// Canonical Neo4j Docker identity (LOCAL-011 / LOCAL-014)
//
// The health command and the guarded backup/restore command must resolve the
// SAME container/volume identity the launchers create. That identity derives
// deterministically from the selected profile plus the disposable name suffix;
// deriving it here keeps one naming authority instead of overlapping copies in
// local-demo, health, and backup code.
// ============================================================================

/** Pinned Neo4j image shared by the compose file, launchers, health, and backup. */
export const LOCAL_RUNTIME_NEO4J_IMAGE = 'neo4j:5.15.0-community';

/**
 * Pinned Inngest version (LOCAL-013).
 *
 * The persisted queue is a versioned on-disk store, so the CLI the supported
 * launcher runs and the image the Compose stack runs must agree. `inngest-cli`
 * is pinned to this version in `devDependencies`; a regression test asserts all
 * three stay in step.
 */
export const LOCAL_RUNTIME_INNGEST_VERSION = '1.36.0';

/** Pinned Inngest image for the Compose stack, derived from the same version. */
export const LOCAL_RUNTIME_INNGEST_IMAGE = `inngest/inngest:v${LOCAL_RUNTIME_INNGEST_VERSION}`;

/** Docker label that binds containers/volumes to a runtime profile. */
export const LOCAL_RUNTIME_DOCKER_LABEL = 'com.radarist.local-runtime';

export interface LocalRuntimeNeo4jVolumeMount {
  readonly name: string;
  readonly destination: string;
}

export interface LocalRuntimeNeo4jDockerIdentity {
  readonly container: string;
  readonly volumePrefix: string;
  readonly volumes: readonly LocalRuntimeNeo4jVolumeMount[];
  readonly durableRuntimeLabel: string;
  readonly ephemeralRuntimeLabel: string;
}

const NEO4J_VOLUME_MOUNTS = [
  { suffix: 'data', destination: '/data' },
  { suffix: 'logs', destination: '/logs' },
  { suffix: 'import', destination: '/var/lib/neo4j/import' },
  { suffix: 'plugins', destination: '/plugins' },
] as const;

export function deriveLocalRuntimeNeo4jDockerIdentity(
  profile: Pick<LocalRuntimeProfile, 'name'>,
  rawNameSuffix = ''
): LocalRuntimeNeo4jDockerIdentity {
  const nameSuffix = rawNameSuffix === '' ? '' : assertLocalRuntimeNameSuffix(rawNameSuffix);
  const containerSuffix = nameSuffix ? `-${nameSuffix}` : '';
  const volumeSuffix = nameSuffix ? `_${nameSuffix.replace(/-/g, '_')}` : '';
  const container =
    profile.name === 'default'
      ? `radarist-neo4j${containerSuffix}`
      : `radarist-neo4j-${profile.name}${containerSuffix}`;
  const volumePrefix =
    profile.name === 'default'
      ? `radarist_neo4j${volumeSuffix}`
      : `radarist_neo4j_${profile.name}${volumeSuffix}`;
  return {
    container,
    volumePrefix,
    volumes: NEO4J_VOLUME_MOUNTS.map(({ suffix, destination }) => ({
      name: `${volumePrefix}_${suffix}`,
      destination,
    })),
    durableRuntimeLabel: `durable:${profile.name}`,
    ephemeralRuntimeLabel: `ephemeral:${profile.name}`,
  };
}

function assertPort(name: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid local runtime port ${name}: ${String(port)}.`);
  }
}

export function listLocalRuntimePortClaims(profile: LocalRuntimeProfile): LocalRuntimePortClaim[] {
  return LOCAL_RUNTIME_PORT_NAMES.map((name) => {
    const port = profile.ports[name];
    assertPort(`${profile.name}.${name}`, port);
    return { profileName: profile.name, name, port };
  });
}

export function findLocalRuntimePortCollisions(profiles: readonly LocalRuntimeProfile[]): LocalRuntimePortCollision[] {
  const claimsByPort = new Map<number, LocalRuntimePortClaim[]>();
  for (const profile of profiles) {
    for (const claim of listLocalRuntimePortClaims(profile)) {
      const claims = claimsByPort.get(claim.port) ?? [];
      claims.push(claim);
      claimsByPort.set(claim.port, claims);
    }
  }
  return [...claimsByPort.entries()]
    .filter(([, claims]) => claims.length > 1)
    .map(([port, claims]) => ({ port, claims }))
    .sort((left, right) => left.port - right.port);
}

export function assertNoLocalRuntimePortCollisions(profiles: readonly LocalRuntimeProfile[]): void {
  const collisions = findLocalRuntimePortCollisions(profiles);
  if (collisions.length === 0) return;
  const detail = collisions
    .map(({ port, claims }) => `${port} (${claims.map((claim) => `${claim.profileName}.${claim.name}`).join(', ')})`)
    .join('; ');
  throw new Error(`Local runtime port inventory contains collisions: ${detail}.`);
}

export async function findOccupiedLocalRuntimePorts(
  profile: LocalRuntimeProfile,
  probe: LocalRuntimePortProbe,
  host = '127.0.0.1'
): Promise<LocalRuntimePortClaim[]> {
  const claims = listLocalRuntimePortClaims(profile);
  const occupied = await Promise.all(
    claims.map(async (claim) => ((await probe(host, claim.port)) ? claim : undefined))
  );
  return occupied.filter((claim): claim is LocalRuntimePortClaim => claim !== undefined);
}

export function deriveLocalRuntimePaths(
  repositoryRoot: string,
  profileValue: unknown,
  dataRoot = resolve(repositoryRoot, 'emulator-data')
): LocalRuntimePaths {
  const profileName = parseLocalRuntimeProfileName(profileValue);
  const absoluteDataRoot = resolve(dataRoot);
  const root = resolve(absoluteDataRoot, profileName);
  assertLexicallyContained(absoluteDataRoot, root, 'profile root');
  const runtime = join(root, 'runtime');
  const temp = join(runtime, 'tmp');
  const pids = join(runtime, 'pids');
  return {
    profileName,
    dataRoot: absoluteDataRoot,
    root,
    runtime,
    home: join(runtime, 'home'),
    temp,
    storageBlobs: join(temp, 'firebase', 'storage', 'blobs'),
    workingDirectory: join(runtime, 'work'),
    inngestState: join(runtime, 'inngest'),
    exports: join(root, 'exports'),
    checkpoints: join(root, 'checkpoints'),
    status: join(runtime, 'status'),
    pids,
    logs: join(runtime, 'logs'),
    config: join(runtime, 'config'),
    cache: join(runtime, 'cache'),
    processManifest: join(pids, 'processes.json'),
    runtimeLease: join(pids, 'lifetime.lock'),
  };
}

function assertLexicallyContained(parent: string, candidate: string, label: string): void {
  const fromParent = relative(resolve(parent), resolve(candidate));
  if (!fromParent || fromParent === '..' || fromParent.startsWith(`..${sep}`) || isAbsolute(fromParent)) {
    throw new Error(`${label} must be a child of the local runtime data root.`);
  }
}

function assertDirectoryNotSymlink(path: string, label: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!entry.isDirectory()) throw new Error(`${label} must be a directory.`);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ensureDataRoot(dataRoot: string): void {
  if (!pathEntryExists(dataRoot)) mkdirSync(dataRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertDirectoryNotSymlink(dataRoot, 'Local runtime data root');
}

function ensurePrivateDirectory(dataRoot: string, target: string): void {
  assertLexicallyContained(dataRoot, target, 'Runtime directory');
  const segments = relative(dataRoot, target).split(sep).filter(Boolean);
  let current = dataRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (pathEntryExists(current)) {
      assertDirectoryNotSymlink(current, 'Runtime directory');
    } else {
      mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    }
    chmodSync(current, PRIVATE_DIRECTORY_MODE);
  }
}

export function assertLocalRuntimePathContained(
  paths: LocalRuntimePaths,
  candidate: string,
  options: { allowMissingLeaf?: boolean } = {}
): string {
  const absoluteCandidate = resolve(candidate);
  if (absoluteCandidate !== resolve(paths.root)) {
    assertLexicallyContained(paths.root, absoluteCandidate, 'Runtime path');
  }
  const candidateExists = pathEntryExists(absoluteCandidate);
  if (candidateExists && lstatSync(absoluteCandidate).isSymbolicLink()) {
    throw new Error('Runtime path must not be a symbolic link.');
  }
  if (!options.allowMissingLeaf && !candidateExists) throw new Error('Runtime path does not exist.');
  const parent = options.allowMissingLeaf ? resolve(absoluteCandidate, '..') : absoluteCandidate;
  if (!existsSync(parent)) throw new Error('Runtime path parent does not exist.');

  const realRoot = realpathSync(paths.root);
  const realParent = realpathSync(parent);
  const fromRoot = relative(realRoot, realParent);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Runtime path escapes the profile root through a symbolic link.');
  }
  return absoluteCandidate;
}

export function ensurePrivateLocalRuntimeLayout(paths: LocalRuntimePaths): LocalRuntimePaths {
  ensureDataRoot(paths.dataRoot);
  const directories = [
    paths.root,
    paths.runtime,
    paths.home,
    paths.temp,
    paths.storageBlobs,
    paths.workingDirectory,
    paths.inngestState,
    paths.exports,
    paths.checkpoints,
    paths.status,
    paths.pids,
    paths.logs,
    paths.config,
    paths.cache,
  ];
  for (const directory of directories) ensurePrivateDirectory(paths.dataRoot, directory);

  const realRoot = realpathSync(paths.root);
  for (const directory of directories) {
    const realDirectory = realpathSync(directory);
    const fromRoot = relative(realRoot, realDirectory);
    if (directory !== paths.root && (!fromRoot || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))) {
      throw new Error('Runtime directory escapes the profile root.');
    }
    if ((statSync(directory).mode & 0o077) !== 0) {
      throw new Error('Runtime directories must not be accessible by group or other users.');
    }
  }
  return paths;
}

export function buildLocalRuntimeExecutionContext(
  paths: LocalRuntimePaths,
  source: NodeJS.ProcessEnv = process.env
): LocalRuntimeExecutionContext {
  assertLocalRuntimePathContained(paths, paths.workingDirectory);
  assertLocalRuntimePathContained(paths, paths.temp);
  return {
    cwd: paths.workingDirectory,
    env: {
      ...source,
      HOME: paths.home,
      TMPDIR: paths.temp,
      TMP: paths.temp,
      TEMP: paths.temp,
      XDG_CONFIG_HOME: paths.config,
      XDG_CACHE_HOME: paths.cache,
      RADARIST_LOCAL_RUNTIME_PROFILE: paths.profileName,
      RADARIST_LOCAL_RUNTIME_ROOT: paths.root,
    },
  };
}

function assertEphemeralSessionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Ephemeral runtime session IDs must be bounded path-safe identifiers.');
  }
}

function ephemeralSessionPaths(paths: LocalRuntimePaths, sessionId: string): LocalRuntimePaths {
  assertEphemeralSessionId(sessionId);
  const runtime = join(paths.runtime, `ephemeral-${sessionId}`);
  const temp = join(runtime, 'tmp');
  const pids = join(runtime, 'pids');
  return {
    ...paths,
    runtime,
    home: join(runtime, 'home'),
    temp,
    storageBlobs: join(temp, 'firebase', 'storage', 'blobs'),
    workingDirectory: join(runtime, 'work'),
    inngestState: join(runtime, 'inngest'),
    status: join(runtime, 'status'),
    pids,
    logs: join(runtime, 'logs'),
    config: join(runtime, 'config'),
    cache: join(runtime, 'cache'),
    processManifest: join(pids, 'processes.json'),
    runtimeLease: join(pids, 'lifetime.lock'),
  };
}

/**
 * Create a one-run execution tree while retaining the profile root only as the
 * containment boundary. No temp, Storage blob, HOME, config, cache, or working
 * directory from a prior durable or ephemeral run is reused.
 */
export function createEphemeralLocalRuntimeExecutionContext(
  paths: LocalRuntimePaths,
  source: NodeJS.ProcessEnv,
  sessionId: string
): EphemeralLocalRuntimeExecutionContext {
  const sessionPaths = ephemeralSessionPaths(paths, sessionId);
  if (pathEntryExists(sessionPaths.runtime)) {
    throw new Error('Ephemeral runtime session path already exists; refusing to reuse stale state.');
  }
  ensurePrivateLocalRuntimeLayout(sessionPaths);
  return {
    sessionRoot: sessionPaths.runtime,
    paths: sessionPaths,
    context: buildLocalRuntimeExecutionContext(sessionPaths, source),
  };
}

function assertEphemeralSessionCandidate(paths: LocalRuntimePaths, candidate: string): string {
  let absoluteCandidate: string;
  try {
    absoluteCandidate = assertLocalRuntimePathContained(paths, candidate);
  } catch (error) {
    if (pathEntryExists(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Stale ephemeral runtime candidates must be real directories.');
    }
    throw error;
  }
  const entry = lstatSync(absoluteCandidate);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Stale ephemeral runtime candidates must be real directories.');
  }
  const name = absoluteCandidate.slice(resolve(paths.runtime).length + 1);
  if (!/^ephemeral-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error('Refusing to remove a path that is not an ephemeral runtime session.');
  }
  return absoluteCandidate;
}

export function removeEphemeralLocalRuntimeSession(paths: LocalRuntimePaths, sessionRoot: string): void {
  const candidate = assertEphemeralSessionCandidate(paths, sessionRoot);
  rmSync(candidate, { recursive: true, force: false });
}

/**
 * Call only after this launcher owns the profile lease and has proved all
 * profile ports vacant. Those two witnesses make abandoned session cleanup
 * exclusive without guessing from PIDs.
 */
export function removeStaleEphemeralLocalRuntimeSessions(paths: LocalRuntimePaths): string[] {
  const names = readdirSync(paths.runtime)
    .filter((name) => /^ephemeral-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
    .sort();
  const candidates = names.map((name) => assertEphemeralSessionCandidate(paths, join(paths.runtime, name)));
  for (const candidate of candidates) rmSync(candidate, { recursive: true, force: false });
  return names;
}

// Fail at module load if a checked-in profile ever gains an implicit collision.
assertNoLocalRuntimePortCollisions(Object.values(LOCAL_RUNTIME_PROFILES));
