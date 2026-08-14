import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import net from 'net';
import { dirname, isAbsolute, resolve } from 'path';
import * as dotenv from 'dotenv';
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD } from '@/lib/demo-credentials';
import { isPlaceholderKey } from '@/lib/ai/key-resolution';
import { assertAgentRuntimeAvailable } from '@/lib/agent-import';
import {
  LOCAL_RUNTIME_PROFILES,
  LOCAL_RUNTIME_NEO4J_IMAGE,
  assertLocalRuntimePathContained,
  deriveLocalRuntimeNeo4jDockerIdentity,
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
  getLocalRuntimeProfile,
  parseLocalRuntimeProfileArg,
  resolveLocalRuntimeEnvFileDirectory,
  resolveLocalRuntimeNameSuffix,
  type LocalRuntimePaths,
} from './local-runtime-profile';
import {
  LEGACY_NEO4J_AUTO_PLUGINS,
  PINNED_NEO4J_GDS_CONTAINER_PATH,
  PINNED_NEO4J_GDS_HOST_FILE_NAME,
  PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES,
  PINNED_NEO4J_GDS_MIN_CURL_VERSION,
  PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE,
  PINNED_NEO4J_GDS_SHA256,
  PINNED_NEO4J_GDS_SIZE_BYTES,
  PINNED_NEO4J_GDS_URL,
  PINNED_NEO4J_GDS_VERSION,
  SUPPORTED_NEO4J_PLUGINS,
} from './neo4j-gds-contract';

export {
  LEGACY_NEO4J_AUTO_PLUGINS,
  PINNED_NEO4J_GDS_CONTAINER_PATH,
  PINNED_NEO4J_GDS_HOST_FILE_NAME,
  PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES,
  PINNED_NEO4J_GDS_MIN_CURL_VERSION,
  PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE,
  PINNED_NEO4J_GDS_SHA256,
  PINNED_NEO4J_GDS_SIZE_BYTES,
  PINNED_NEO4J_GDS_URL,
  PINNED_NEO4J_GDS_VERSION,
  SUPPORTED_NEO4J_PLUGINS,
} from './neo4j-gds-contract';

// TEST-024 disposable override: suffix durable Docker resource names so
// acceptance stacks can never collide with the canonical containers/volumes.
// Unset env keeps the checked-in names byte-identical.
const RUNTIME_NAME_SUFFIX = resolveLocalRuntimeNameSuffix(process.env);

// LOCAL-011: container/volume naming derives from the canonical runtime-profile
// authority so health, backup, and launchers can never drift apart.
const DEFAULT_NEO4J_IDENTITY = deriveLocalRuntimeNeo4jDockerIdentity(
  LOCAL_RUNTIME_PROFILES.default,
  RUNTIME_NAME_SUFFIX
);
const SELFTEST_NEO4J_IDENTITY = deriveLocalRuntimeNeo4jDockerIdentity(
  LOCAL_RUNTIME_PROFILES.selftest,
  RUNTIME_NAME_SUFFIX
);

// LOCAL-009 disposable override: relocate the profile env files into an owned
// directory so acceptance launcher runs never read or rewrite the developer's
// repo-root `.env.local` / `.env.selftest.local`. Unset env keeps the
// checked-in repo-root filenames byte-identical.
const ENV_FILE_DIRECTORY = resolveLocalRuntimeEnvFileDirectory(process.env);

function profileEnvFile(fileName: string): string {
  return ENV_FILE_DIRECTORY ? resolve(ENV_FILE_DIRECTORY, fileName) : fileName;
}

// Demo login identity lives in `src/lib/demo-credentials.ts` (single source of
// truth shared with the login page). Re-exported here so existing script
// importers keep working.
export { DEMO_USER_EMAIL, DEMO_USER_PASSWORD, DEMO_USER_UID } from '@/lib/demo-credentials';

export type DemoProfileName = 'default' | 'selftest';
export type EnvMap = Record<string, string>;
export type DemoSeedMode = 'blank' | 'showcase';
export type DemoDurabilityMode = 'durable' | 'ephemeral';

export interface FirebasePorts {
  ui: number;
  websocket: number;
  hub: number;
  logging: number;
  firestore: number;
  auth: number;
  storage: number;
}

export interface Neo4jPorts {
  http: number;
  bolt: number;
}

export interface ExpectedDockerPortBinding {
  containerPort: number;
  hostPort: number;
}

export interface ExpectedDockerNamedVolumeMount {
  name: string;
  destination: string;
}

export interface DockerVolumeIdentity {
  name: string;
  runtimeLabel: string | undefined;
  driver: string | undefined;
  scope: string | undefined;
  optionsJson: string | undefined;
}

/**
 * Wrap a teardown action so concurrent shutdown paths share one immutable
 * Promise and the underlying operation executes at most once.
 */
export function createIdempotentAsyncAction<T>(
  action: () => Promise<T>
): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    inFlight ??= Promise.resolve().then(action);
    return inFlight;
  };
}

/** Run the initial graph audit once and propagate its first failure verbatim. */
export async function requireInitialGraphAudit(
  audit: () => Promise<void>
): Promise<void> {
  await audit();
}

// Match Neo4j's conventional plugin destination. Guarded migration changes a
// retained container to APOC-only before its next start, so the entrypoint
// cannot overwrite this artifact through the mutable upstream GDS manifest.
const OWNED_NEO4J_PLUGIN_VOLUME_PATTERN =
  /^radarist_neo4j(?:_[a-z0-9][a-z0-9_]{0,80})?_plugins$/;
const PINNED_NEO4J_GDS_PROBE_SCRIPT = String.raw`
set -eu

target="$1"
expected_sha="$2"
owner_id="$3"
group_id="$4"
plugin_dir="$(dirname -- "$target")"

checksum_matches() {
  printf '%s  %s\n' "$expected_sha" "$1" | sha256sum --check --status
}

if [ -f "$target" ] && [ ! -L "$target" ] && checksum_matches "$target"; then
  chown "$owner_id:$group_id" "$plugin_dir"
  chmod 0755 "$plugin_dir"
  chown "$owner_id:$group_id" "$target"
  chmod 0644 "$target"
  exit 0
fi

exit ${PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE}
`;

const PINNED_NEO4J_GDS_IMPORT_SCRIPT = String.raw`
set -eu

source="$1"
target="$2"
expected_sha="$3"
owner_id="$4"
group_id="$5"
plugin_dir="$(dirname -- "$target")"
temp=""

checksum_matches() {
  printf '%s  %s\n' "$expected_sha" "$1" | sha256sum --check --status
}

cleanup() {
  if [ -n "$temp" ]; then
    rm -f -- "$temp"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ ! -f "$source" ] || [ -L "$source" ] || ! checksum_matches "$source"; then
  echo "Host-downloaded pinned Neo4j GDS artifact failed checksum verification; refusing to install." >&2
  exit 1
fi

chown "$owner_id:$group_id" "$plugin_dir"
chmod 0755 "$plugin_dir"

if [ -f "$target" ] && [ ! -L "$target" ] && checksum_matches "$target"; then
  chown "$owner_id:$group_id" "$target"
  chmod 0644 "$target"
  exit 0
fi

temp="$(mktemp "$target".tmp.XXXXXX)"
cp -- "$source" "$temp"

if ! checksum_matches "$temp"; then
  echo "Copied pinned Neo4j GDS artifact failed checksum verification; refusing to install." >&2
  exit 1
fi

chown "$owner_id:$group_id" "$temp"
chmod 0644 "$temp"
mv -f -- "$temp" "$target"
temp=""
`;

function assertOwnedNeo4jPluginVolume(ownedPluginVolume: string): void {
  if (
    typeof ownedPluginVolume !== 'string' ||
    !OWNED_NEO4J_PLUGIN_VOLUME_PATTERN.test(ownedPluginVolume)
  ) {
    throw new Error(
      'Invalid owned Neo4j plugin volume name: expected a canonical Radarist local-runtime *_plugins volume.'
    );
  }
}

function assertSafeAbsolutePath(path: string, label: string): void {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    /[\r\n,]/.test(path)
  ) {
    throw new Error(`${label} must be a safe absolute path.`);
  }
}

/**
 * Use macOS' system curl so corporate certificates installed in Keychain are
 * honored. Other supported hosts resolve the real curl executable through
 * PATH; shell aliases are intentionally not accepted.
 */
export function resolvePinnedGdsCurlCommand(platform = process.platform): string {
  return platform === 'darwin' ? '/usr/bin/curl' : 'curl';
}

export function parseCurlVersion(output: string): string | undefined {
  const match = /^curl\s+(\d+\.\d+\.\d+)(?:\s|$)/m.exec(output);
  return match?.[1];
}

export function isSupportedPinnedGdsCurlVersion(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const minimum = PINNED_NEO4J_GDS_MIN_CURL_VERSION.split('.').map(Number);
  if (!parsed || parsed.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

/** Build the bounded HTTPS-only host download invocation for the pinned JAR. */
export function buildPinnedGdsDownloadArgs(outputPath: string): string[] {
  assertSafeAbsolutePath(outputPath, 'Pinned GDS download path');
  return [
    '--disable',
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--tlsv1.2',
    '--connect-timeout',
    '20',
    '--max-time',
    '120',
    '--retry',
    '2',
    '--retry-delay',
    '1',
    '--retry-max-time',
    '120',
    '--max-redirs',
    '3',
    '--max-filesize',
    String(PINNED_NEO4J_GDS_MAX_DOWNLOAD_BYTES),
    '--output',
    outputPath,
    '--url',
    PINNED_NEO4J_GDS_URL,
  ];
}

const PINNED_GDS_CURL_ENV_KEYS = [
  'PATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

/**
 * Give the downloader only trust/proxy configuration. Provider credentials,
 * Firebase secrets, and Neo4j authentication never enter the network process.
 */
export function buildPinnedGdsDownloadEnvironment(
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PINNED_GDS_CURL_ENV_KEYS.flatMap((key) => {
      const value = source[key];
      return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
    })
  );
}

/** Probe curl without inheriting ambient secrets or allowing an unbounded child. */
export function probePinnedGdsCurlVersion(
  command: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 5_000
): string | undefined {
  const result = spawnSync(command, ['--version'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
  return !result.error && result.status === 0 && typeof result.stdout === 'string'
    ? parseCurlVersion(result.stdout)
    : undefined;
}

/**
 * Download only the pinned artifact under the exact filtered environment.
 * The outer timeout is independent of curl's retry timers.
 */
export function downloadPinnedGdsArtifact(
  command: string,
  outputPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 130_000
): void {
  const result = spawnSync(command, buildPinnedGdsDownloadArgs(outputPath), {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    throw new Error(
      timedOut
        ? `${command} exceeded its ${timeoutMs}ms wall-clock limit; arguments were redacted`
        : `${command} exited with code ${result.status ?? 'unknown'}; arguments were redacted`
    );
  }
}

/**
 * Build the network-isolated Docker probe for an already-correct artifact.
 *
 * The strict volume namespace check prevents `--mount` option injection and
 * accidental bind mounts. A checksum mismatch has its own stable exit code so
 * Docker/runtime failures cannot be misread as a cache miss.
 */
export function buildPinnedGdsArtifactProbeArgs(ownedPluginVolume: string): string[] {
  assertOwnedNeo4jPluginVolume(ownedPluginVolume);
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '0:0',
    '--mount',
    `type=volume,source=${ownedPluginVolume},target=/plugins,volume-nocopy`,
    '--entrypoint',
    '/bin/sh',
    LOCAL_RUNTIME_NEO4J_IMAGE,
    '-euc',
    PINNED_NEO4J_GDS_PROBE_SCRIPT,
    'radarist-pinned-gds-probe',
    PINNED_NEO4J_GDS_CONTAINER_PATH,
    PINNED_NEO4J_GDS_SHA256,
    '7474',
    '7474',
  ];
}

/**
 * Build the network-isolated, double-checksummed atomic import of one
 * host-verified regular file into the owned plugin volume.
 */
export function buildPinnedGdsArtifactImportArgs(
  ownedPluginVolume: string,
  hostArtifactPath: string
): string[] {
  assertOwnedNeo4jPluginVolume(ownedPluginVolume);
  assertSafeAbsolutePath(hostArtifactPath, 'Pinned GDS host artifact');
  const entry = lstatSync(hostArtifactPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('Pinned GDS host artifact must be a regular non-symbolic-link file.');
  }
  const canonicalHostArtifactPath = realpathSync(hostArtifactPath);
  assertSafeAbsolutePath(canonicalHostArtifactPath, 'Pinned GDS host artifact');

  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '0:0',
    '--mount',
    `type=volume,source=${ownedPluginVolume},target=/plugins,volume-nocopy`,
    '--mount',
    `type=bind,source=${canonicalHostArtifactPath},target=/gds-source.jar,readonly`,
    '--entrypoint',
    '/bin/sh',
    LOCAL_RUNTIME_NEO4J_IMAGE,
    '-euc',
    PINNED_NEO4J_GDS_IMPORT_SCRIPT,
    'radarist-pinned-gds-import',
    '/gds-source.jar',
    PINNED_NEO4J_GDS_CONTAINER_PATH,
    PINNED_NEO4J_GDS_SHA256,
    '7474',
    '7474',
  ];
}

export type Neo4jDockerPluginEnvValidation =
  | {
      valid: true;
      plugins: readonly string[];
      provisioning: 'pinned' | 'legacy-auto';
    }
  | { valid: false; reason: string };

export type LegacyGdsMigrationRecoveryAction =
  | 'none'
  | 'restore-legacy-name'
  | 'resume-pinned-replacement';

/**
 * Resolve only fully identity-validated crash states from the guarded legacy
 * migration. This is intentionally pure so every interruption window can be
 * exhaustively tested without mutating Docker.
 */
export function planLegacyGdsMigrationRecovery(input: {
  canonical: 'missing' | 'pinned' | 'legacy-auto';
  backup: 'missing' | 'pinned' | 'legacy-auto';
  backupRunning: boolean;
}): LegacyGdsMigrationRecoveryAction {
  if (input.backup === 'missing') return 'none';
  if (input.backupRunning) {
    throw new Error('Legacy GDS migration backup must be stopped before recovery.');
  }
  if (input.backup !== 'legacy-auto') {
    throw new Error('Legacy GDS migration backup does not contain legacy plugin intent.');
  }
  if (input.canonical === 'missing') return 'restore-legacy-name';
  if (input.canonical === 'pinned') return 'resume-pinned-replacement';
  throw new Error('Legacy GDS migration has two legacy containers and is ambiguous.');
}

/**
 * Compare retained Docker authentication intent without ever returning or
 * formatting the credential. Migration may rebuild only the container
 * configuration; it must refuse when the retained password and current
 * profile disagree because Neo4j persists the first-boot password in /data.
 */
export function hasExactNeo4jDockerAuth(
  env: unknown,
  expectedPassword: string
): boolean {
  if (
    !Array.isArray(env) ||
    !env.every((entry) => typeof entry === 'string') ||
    expectedPassword.length === 0
  ) {
    return false;
  }
  const entries = env.filter((entry) => entry.startsWith('NEO4J_AUTH='));
  return (
    entries.length === 1 &&
    entries[0] === `NEO4J_AUTH=neo4j/${expectedPassword}`
  );
}

/**
 * Validate the immutable plugin contract captured in Docker Config.Env.
 *
 * Docker stores NEO4J_PLUGINS as a JSON array string. Parse it semantically so
 * harmless whitespace/order changes are accepted while malformed JSON,
 * substring lookalikes, duplicates, and extra plugins fail closed. New
 * runtimes auto-install APOC only and receive GDS from the checksum-pinned
 * provisioning boundary. The previous APOC+GDS declaration is classified
 * separately solely so the launcher can perform a guarded container-config
 * migration while preserving all data volumes. It is never considered a
 * ready steady-state contract because Neo4j's entrypoint resolves that plugin
 * through a mutable upstream manifest on every start. Other environment
 * values may contain credentials and are never returned or included in
 * diagnostics.
 */
export function validateNeo4jDockerPluginEnv(env: unknown): Neo4jDockerPluginEnvValidation {
  if (!Array.isArray(env) || !env.every((entry) => typeof entry === 'string')) {
    return { valid: false, reason: 'Docker Config.Env must be an array of strings' };
  }

  const entries = env.filter((entry) => entry.startsWith('NEO4J_PLUGINS='));
  if (entries.length !== 1) {
    return {
      valid: false,
      reason:
        entries.length === 0
          ? 'NEO4J_PLUGINS is not configured'
          : 'NEO4J_PLUGINS must be configured exactly once',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(entries[0].slice('NEO4J_PLUGINS='.length));
  } catch {
    return { valid: false, reason: 'NEO4J_PLUGINS must be a valid JSON array' };
  }

  if (!Array.isArray(parsed) || !parsed.every((plugin) => typeof plugin === 'string')) {
    return { valid: false, reason: 'NEO4J_PLUGINS must be a JSON array of strings' };
  }

  const configured = new Set(parsed);
  const exactSet = (expected: readonly string[]) =>
    parsed.length === expected.length &&
    configured.size === expected.length &&
    expected.every((plugin) => configured.has(plugin));
  if (exactSet(SUPPORTED_NEO4J_PLUGINS)) {
    return {
      valid: true,
      plugins: SUPPORTED_NEO4J_PLUGINS,
      provisioning: 'pinned',
    };
  }
  if (exactSet(LEGACY_NEO4J_AUTO_PLUGINS)) {
    return {
      valid: true,
      plugins: LEGACY_NEO4J_AUTO_PLUGINS,
      provisioning: 'legacy-auto',
    };
  }
  return {
    valid: false,
    reason:
      'NEO4J_PLUGINS must contain exactly apoc; the legacy apoc and ' +
      'graph-data-science declaration is accepted only for retained-container migration',
  };
}

export interface DemoProfileConfig {
  name: DemoProfileName;
  envFile: string;
  projectId: string;
  appPort: number;
  inngestPort: number;
  firebase: FirebasePorts;
  neo4j: Neo4jPorts;
  neo4jContainer: string;
  neo4jVolumePrefix: string;
}

export interface DoctorCheck {
  level: 'pass' | 'warn' | 'fail';
  label: string;
  detail: string;
}

export const DEMO_PROFILES: Record<DemoProfileName, DemoProfileConfig> = {
  default: {
    name: 'default',
    envFile: profileEnvFile('.env.local'),
    projectId: LOCAL_RUNTIME_PROFILES.default.projectId,
    appPort: LOCAL_RUNTIME_PROFILES.default.ports.app,
    inngestPort: LOCAL_RUNTIME_PROFILES.default.ports.inngest,
    firebase: {
      ui: LOCAL_RUNTIME_PROFILES.default.ports.firebaseUi,
      websocket: LOCAL_RUNTIME_PROFILES.default.ports.firebaseFirestoreWebsocket,
      hub: LOCAL_RUNTIME_PROFILES.default.ports.firebaseHub,
      logging: LOCAL_RUNTIME_PROFILES.default.ports.firebaseLogging,
      firestore: LOCAL_RUNTIME_PROFILES.default.ports.firestore,
      auth: LOCAL_RUNTIME_PROFILES.default.ports.auth,
      storage: LOCAL_RUNTIME_PROFILES.default.ports.storage,
    },
    neo4j: {
      http: LOCAL_RUNTIME_PROFILES.default.ports.neo4jHttp,
      bolt: LOCAL_RUNTIME_PROFILES.default.ports.neo4jBolt,
    },
    neo4jContainer: DEFAULT_NEO4J_IDENTITY.container,
    neo4jVolumePrefix: DEFAULT_NEO4J_IDENTITY.volumePrefix,
  },
  selftest: {
    name: 'selftest',
    envFile: profileEnvFile('.env.selftest.local'),
    projectId: LOCAL_RUNTIME_PROFILES.selftest.projectId,
    appPort: LOCAL_RUNTIME_PROFILES.selftest.ports.app,
    inngestPort: LOCAL_RUNTIME_PROFILES.selftest.ports.inngest,
    firebase: {
      ui: LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseUi,
      websocket: LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseFirestoreWebsocket,
      hub: LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseHub,
      logging: LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseLogging,
      firestore: LOCAL_RUNTIME_PROFILES.selftest.ports.firestore,
      auth: LOCAL_RUNTIME_PROFILES.selftest.ports.auth,
      storage: LOCAL_RUNTIME_PROFILES.selftest.ports.storage,
    },
    neo4j: {
      http: LOCAL_RUNTIME_PROFILES.selftest.ports.neo4jHttp,
      bolt: LOCAL_RUNTIME_PROFILES.selftest.ports.neo4jBolt,
    },
    neo4jContainer: SELFTEST_NEO4J_IDENTITY.container,
    neo4jVolumePrefix: SELFTEST_NEO4J_IDENTITY.volumePrefix,
  },
};

export function hasExpectedDockerLoopbackBindings(rawBindings: string, expected: ExpectedDockerPortBinding[]): boolean {
  if (expected.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBindings);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;

  const bindingsByPort = parsed as Record<string, unknown>;
  const expectedKeys = new Set(expected.map(({ containerPort }) => `${containerPort}/tcp`));
  const observedKeys = Object.keys(bindingsByPort);
  if (observedKeys.length !== expectedKeys.size || observedKeys.some((key) => !expectedKeys.has(key))) {
    return false;
  }
  return expected.every(({ containerPort, hostPort }) => {
    const bindings = bindingsByPort[`${containerPort}/tcp`];
    return (
      Array.isArray(bindings) &&
      bindings.length === 1 &&
      bindings.every(
        (binding) =>
          typeof binding === 'object' &&
          binding !== null &&
          !Array.isArray(binding) &&
          (binding as Record<string, unknown>).HostIp === '127.0.0.1' &&
          (binding as Record<string, unknown>).HostPort === String(hostPort)
      )
    );
  });
}

export function hasExpectedDockerNamedVolumeMounts(
  rawMounts: string,
  expected: readonly ExpectedDockerNamedVolumeMount[]
): boolean {
  if (expected.length === 0) return false;

  const expectedByName = new Map<string, string>();
  const expectedDestinations = new Set<string>();
  for (const mount of expected) {
    if (
      mount.name.length === 0 ||
      mount.destination.length === 0 ||
      expectedByName.has(mount.name) ||
      expectedDestinations.has(mount.destination)
    ) {
      return false;
    }
    expectedByName.set(mount.name, mount.destination);
    expectedDestinations.add(mount.destination);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMounts);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== expected.length) return false;

  const observedNames = new Set<string>();
  const observedDestinations = new Set<string>();
  for (const mount of parsed) {
    if (typeof mount !== 'object' || mount === null || Array.isArray(mount)) return false;
    const fields = mount as Record<string, unknown>;
    const name = fields.Name;
    const destination = fields.Destination;
    if (
      fields.Type !== 'volume' ||
      fields.RW !== true ||
      typeof name !== 'string' ||
      typeof destination !== 'string' ||
      observedNames.has(name) ||
      observedDestinations.has(destination) ||
      expectedByName.get(name) !== destination
    ) {
      return false;
    }
    observedNames.add(name);
    observedDestinations.add(destination);
  }

  return observedNames.size === expected.length;
}

export function planMissingDockerVolumes(
  expectedNames: readonly string[],
  observed: readonly DockerVolumeIdentity[],
  expectedRuntimeLabel: string
): string[] {
  if (expectedRuntimeLabel.length === 0) {
    throw new Error('Expected Docker volume ownership label must not be empty.');
  }

  const expected = new Set<string>();
  for (const name of expectedNames) {
    if (name.length === 0) throw new Error('Expected Docker volume name must not be empty.');
    if (expected.has(name)) throw new Error(`Found duplicate expected Docker volume ${name}.`);
    expected.add(name);
  }

  const observedByName = new Map<string, DockerVolumeIdentity>();
  for (const identity of observed) {
    if (observedByName.has(identity.name)) {
      throw new Error(`Found duplicate observed Docker volume ${identity.name}.`);
    }
    observedByName.set(identity.name, identity);
  }

  const missing: string[] = [];
  for (const name of expectedNames) {
    const identity = observedByName.get(name);
    if (!identity) {
      missing.push(name);
      continue;
    }
    if (identity.runtimeLabel !== expectedRuntimeLabel) {
      throw new Error(
        `Existing Docker volume ${name} does not have the expected ownership label ${expectedRuntimeLabel}; refusing to adopt or relabel it.`
      );
    }
    if (
      identity.driver !== 'local' ||
      identity.scope !== 'local' ||
      !['null', '{}'].includes(identity.optionsJson ?? '')
    ) {
      throw new Error(
        `Existing Docker volume ${name} must use the local driver, local scope, and no driver options; refusing to adopt it.`
      );
    }
  }
  return missing;
}

/**
 * Managed keys, grouped by the section they are written under.
 *
 * The generated-file sections are derived from these groups rather than from
 * positional slices of a flat list: a positional scheme silently re-sections
 * every later key whenever one is added or removed.
 */
const MANAGED_ENV_SECTIONS = [
  {
    title: '# Firebase emulator',
    keys: [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      'NEXT_PUBLIC_USE_FIREBASE_EMULATOR',
      'NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST',
      'NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST',
      'NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
      'FIREBASE_EMULATOR_UI_HOST',
      'FIREBASE_PROJECT_ID',
      'GOOGLE_CLOUD_PROJECT',
      'GCLOUD_PROJECT',
    ],
  },
  {
    title: '# Neo4j',
    keys: ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'RADARIST_GRAPH_RUNTIME_MODE'],
  },
  {
    title: '# AI keys',
    keys: ['GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  {
    title: '# Inngest and internal service auth',
    keys: [
      'INNGEST_ENABLED',
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_DEV_URL',
      'INNGEST_DEV_SERVER_URL',
      'INNGEST_DEV',
      'IMPULSE_INTERNAL_KEY',
    ],
  },
  {
    title: '# Safe showcase feature flags',
    keys: ['CLAUDE_CHAT_ENABLED', 'DISCOVERY_FEEDBACK_ENABLED'],
  },
  {
    title: '# Demo login and app URL',
    keys: ['E2E_USER_EMAIL', 'E2E_USER_PASSWORD', 'NEXT_PUBLIC_APP_URL', 'IMPULSE_MCP_BASE_URL'],
  },
] as const;

export const MANAGED_ENV_KEYS = [
  ...MANAGED_ENV_SECTIONS[0].keys,
  ...MANAGED_ENV_SECTIONS[1].keys,
  ...MANAGED_ENV_SECTIONS[2].keys,
  ...MANAGED_ENV_SECTIONS[3].keys,
  ...MANAGED_ENV_SECTIONS[4].keys,
  ...MANAGED_ENV_SECTIONS[5].keys,
] as const;

const PROFILE_IDENTITY_ENV_KEYS = new Set<string>([
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'FIREBASE_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST',
  'NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST',
  'NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'FIREBASE_EMULATOR_UI_HOST',
  'NEO4J_URI',
  'INNGEST_DEV_URL',
  'INNGEST_DEV_SERVER_URL',
  'INNGEST_DEV',
  'NEXT_PUBLIC_APP_URL',
  // OPS-004: the internal MCP base is a profile identity value — the active
  // runtime profile's app port is its single authority. Always regenerate it so
  // a stale developer `.env.local` value can never outlive a profile switch and
  // misroute mission MCP traffic to a port nothing is listening on.
  'IMPULSE_MCP_BASE_URL',
]);

export function getProfileConfig(name: string | undefined): DemoProfileConfig {
  if (name === undefined) return DEMO_PROFILES.default;
  return DEMO_PROFILES[getLocalRuntimeProfile(name).name];
}

export function parseProfileArg(args: string[]): DemoProfileConfig {
  return DEMO_PROFILES[parseLocalRuntimeProfileArg(args).name];
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parseDemoSeedMode(args: readonly string[]): DemoSeedMode {
  const blank = args.includes('--blank');
  const showcase = args.includes('--showcase');
  if (blank && showcase) throw new Error('Choose exactly one startup mode: --blank or --showcase.');
  // Backward-compatible evaluator default; the first-workspace guide makes the
  // blank choice explicit and neither path ever reseeds a restored profile.
  return blank ? 'blank' : 'showcase';
}

export function parseDemoDurabilityMode(args: readonly string[]): DemoDurabilityMode {
  const ephemeral = args.includes('--ephemeral');
  const legacyPersist = args.includes('--persist');
  if (ephemeral && legacyPersist) throw new Error('--ephemeral and legacy --persist cannot be combined.');
  return ephemeral ? 'ephemeral' : 'durable';
}

export interface DemoFullOptions {
  profile: DemoProfileConfig;
  seedMode: DemoSeedMode;
  durabilityMode: DemoDurabilityMode;
  devMode: boolean;
  skipInngest: boolean;
}

export function assertFreshFirebaseGraphCompatibility(input: {
  readonly durabilityMode: 'durable' | 'ephemeral';
  readonly firebaseImportPath?: string;
  readonly graphUserNodeCount: number;
}): void {
  if (!Number.isSafeInteger(input.graphUserNodeCount) || input.graphUserNodeCount < 0) {
    throw new Error('Neo4j user-data census returned an invalid count.');
  }
  if (!input.firebaseImportPath && input.graphUserNodeCount > 0) {
    throw new Error(
      `Fresh Firebase workspace refused because durable Neo4j still contains ${input.graphUserNodeCount} user-data node(s). Restore the matching Firebase checkpoint or run the guarded full reset with --include-neo4j.`
    );
  }
}

export function parseDemoFullOptions(args: string[]): DemoFullOptions {
  const valueOptions = new Set(['--profile']);
  const flags = new Set(['--blank', '--showcase', '--ephemeral', '--persist', '--dev', '--skip-inngest']);
  const counts = new Map<string, number>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (flags.has(argument)) {
      counts.set(argument, (counts.get(argument) ?? 0) + 1);
      continue;
    }
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires an explicit profile name.`);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('--profile=')) continue;
    throw new Error(`Unknown demo:full argument: ${argument}`);
  }
  const repeated = [...counts.entries()].filter(([, count]) => count > 1).map(([flag]) => flag);
  if (repeated.length > 0) {
    throw new Error(`Specify each demo:full flag at most once: ${repeated.join(', ')}.`);
  }
  return {
    profile: parseProfileArg(args),
    seedMode: parseDemoSeedMode(args),
    durabilityMode: parseDemoDurabilityMode(args),
    devMode: args.includes('--dev'),
    skipInngest: args.includes('--skip-inngest'),
  };
}

export function buildDemoAppLaunchPlan(
  profile: DemoProfileConfig,
  devMode: boolean
): { command: 'npx'; args: string[] } {
  return {
    command: 'npx',
    args: devMode
      ? ['next', 'dev', '--turbopack', '-H', '127.0.0.1', '-p', String(profile.appPort)]
      : ['next', 'start', '-H', '127.0.0.1', '-p', String(profile.appPort)],
  };
}

/**
 * LOCAL-013 — how the Inngest dev server is launched and where its queue lives.
 *
 * Without `--persist` the dev server holds the entire queue in memory, so every
 * graceful restart and every forced interruption silently discards queued
 * events, in-flight functions, and pending retries. Enabling it is what makes
 * local background work survive a restart at all.
 *
 * `inngest dev --persist` writes to `<cwd>/.inngest/` — CWD-relative, not
 * `$HOME`-relative — so the working directory is the whole privacy mechanism.
 * Pointing it at the profile's own `inngestState` directory makes the queue
 * profile-private by containment, using the layout authority that already
 * enforces the boundary rather than a second ad-hoc path rule.
 *
 * `queueStateCarriedOver` reports whether state from a previous runtime is
 * present. It is the only signal that separates "this run will resume" from
 * "this run is lost", and interrupted-run recovery is gated on it.
 */
export interface InngestLaunchPlan {
  readonly command: 'inngest';
  readonly args: string[];
  readonly cwd: string;
  /** Directory the dev server creates for its persisted queue. */
  readonly statePath: string;
  readonly queueStateCarriedOver: boolean;
}

export function buildInngestLaunchPlan(
  profile: DemoProfileConfig,
  paths: LocalRuntimePaths
): InngestLaunchPlan {
  const cwd = assertLocalRuntimePathContained(paths, paths.inngestState);
  const statePath = assertLocalRuntimePathContained(paths, resolve(cwd, '.inngest'), {
    allowMissingLeaf: true,
  });
  return {
    command: 'inngest',
    args: [
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(profile.inngestPort),
      '-u',
      `http://127.0.0.1:${profile.appPort}/api/inngest`,
      '--persist',
    ],
    cwd,
    statePath,
    queueStateCarriedOver: existsSync(statePath),
  };
}

export function assertOptionalAgentRuntimePreflight(env: EnvMap, repositoryRoot: string): void {
  if (isPlaceholder(env.ANTHROPIC_API_KEY)) return;
  assertAgentRuntimeAvailable('orchestrator-lite.js', repositoryRoot);
}

export function getFlagValue(args: string[], flag: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

export function readEnvFile(filePath: string): EnvMap {
  const absolute = resolve(process.cwd(), filePath);
  if (!existsSync(absolute)) return {};
  return dotenv.parse(readFileSync(absolute, 'utf8'));
}

// Placeholder detection shares the canonical predicate with the runtime
// (src/lib/ai/key-resolution.ts) so scaffold values added in one place are
// recognized everywhere. Exported under the script-side name; also used
// internally below.
export const isPlaceholder = isPlaceholderKey;

// Doctor output is public terminal/log surface. Keep this allowlist narrow so
// newly added credentials are redacted by default rather than relying on an
// ever-growing list of secret-looking key names.
const DISPLAYABLE_DOCTOR_ENV_KEYS = new Set([
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_USE_FIREBASE_EMULATOR',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'NEO4J_URI',
  'NEO4J_USER',
  'RADARIST_GRAPH_RUNTIME_MODE',
  'INNGEST_ENABLED',
  'INNGEST_DEV_URL',
  // OPS-004: the internal MCP base is a local loopback URL, not a secret — show
  // it in doctor output so a profile/port mismatch is diagnosable at a glance.
  'IMPULSE_MCP_BASE_URL',
]);

/**
 * OPS-004: a well-formed internal MCP base is an http(s) URL whose path ends at
 * the platform `/api/mcp` mount. The doctor validates the generated value so a
 * blanked or malformed base (which would misroute every mission MCP call) is
 * caught locally before a paid mission ever dispatches.
 */
export function isValidMcpBaseUrl(value: string | undefined): boolean {
  const url = asHttpUrl(value);
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/api/mcp');
  } catch {
    return false;
  }
}

const LOCAL_DEMO_PLACEHOLDERS: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string[]>> = {
  IMPULSE_INTERNAL_KEY: ['replace-with-any-random-string'],
};

function isManagedPlaceholder(key: string, value: string | undefined): boolean {
  if (isPlaceholder(value)) return true;
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    (LOCAL_DEMO_PLACEHOLDERS[key as (typeof MANAGED_ENV_KEYS)[number]] ?? []).includes(normalized)
  );
}

export interface InngestSdkRouting {
  key: 'INNGEST_BASE_URL' | 'INNGEST_DEV';
  url: string;
}

function asHttpUrl(value: string | undefined): string | undefined {
  if (isPlaceholder(value)) return undefined;
  try {
    const parsed = new URL(value as string);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value?.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve deterministic URL-based routing supported by local demo profiles. */
export function resolveInngestSdkRouting(env: EnvMap): InngestSdkRouting | undefined {
  const configuredBaseUrl = env.INNGEST_BASE_URL?.trim();
  if (configuredBaseUrl) {
    const baseUrl = asHttpUrl(configuredBaseUrl);
    return baseUrl ? { key: 'INNGEST_BASE_URL', url: baseUrl } : undefined;
  }

  const devUrl = asHttpUrl(env.INNGEST_DEV);
  return devUrl ? { key: 'INNGEST_DEV', url: devUrl } : undefined;
}

export function formatDoctorEnvDetail(key: string, value: string | undefined, placeholderDetail: string): string {
  if (isPlaceholder(value)) return placeholderDetail;
  return DISPLAYABLE_DOCTOR_ENV_KEYS.has(key) ? (value ?? placeholderDetail) : 'configured';
}

function generatedSecret(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString('hex')}`;
}

function firstUsable(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => !isPlaceholder(value));
}

export function buildDemoEnv(profile: DemoProfileConfig, existing: EnvMap = {}): EnvMap {
  const appUrl = `http://127.0.0.1:${profile.appPort}`;
  const inngestUrl = `http://127.0.0.1:${profile.inngestPort}`;
  const firestoreHost = `127.0.0.1:${profile.firebase.firestore}`;
  const authHost = `127.0.0.1:${profile.firebase.auth}`;
  const storageHost = `127.0.0.1:${profile.firebase.storage}`;
  const projectId = profile.projectId;
  const geminiKey =
    firstUsable(existing.GOOGLE_API_KEY, existing.GEMINI_API_KEY, existing.GOOGLE_GENAI_API_KEY) ||
    'your-google-genai-api-key';
  const internalKey = isManagedPlaceholder('IMPULSE_INTERNAL_KEY', existing.IMPULSE_INTERNAL_KEY)
    ? generatedSecret('radarist-internal')
    : existing.IMPULSE_INTERNAL_KEY;

  return {
    ...existing,
    NEXT_PUBLIC_FIREBASE_API_KEY: existing.NEXT_PUBLIC_FIREBASE_API_KEY || 'demo-api-key',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${profile.projectId}.firebaseapp.com`,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${profile.projectId}.appspot.com`,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: existing.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
    NEXT_PUBLIC_FIREBASE_APP_ID: existing.NEXT_PUBLIC_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000000000',
    NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
    NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: firestoreHost,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: authHost,
    NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: storageHost,
    FIRESTORE_EMULATOR_HOST: firestoreHost,
    FIREBASE_AUTH_EMULATOR_HOST: authHost,
    FIREBASE_STORAGE_EMULATOR_HOST: storageHost,
    FIREBASE_EMULATOR_UI_HOST: `127.0.0.1:${profile.firebase.ui}`,
    FIREBASE_PROJECT_ID: projectId,
    GOOGLE_CLOUD_PROJECT: projectId,
    GCLOUD_PROJECT: projectId,
    NEO4J_URI: `bolt://127.0.0.1:${profile.neo4j.bolt}`,
    NEO4J_USER: existing.NEO4J_USER || 'neo4j',
    NEO4J_PASSWORD: firstUsable(existing.NEO4J_PASSWORD) || generatedSecret('radarist-neo4j'),
    RADARIST_GRAPH_RUNTIME_MODE: 'neo4j',
    GOOGLE_GENAI_API_KEY: geminiKey,
    GOOGLE_API_KEY: geminiKey,
    GEMINI_API_KEY: geminiKey,
    ANTHROPIC_API_KEY: existing.ANTHROPIC_API_KEY || 'your-anthropic-api-key',
    INNGEST_ENABLED: 'true',
    INNGEST_EVENT_KEY: existing.INNGEST_EVENT_KEY || 'local-dev',
    INNGEST_SIGNING_KEY: existing.INNGEST_SIGNING_KEY || 'local-dev',
    INNGEST_DEV_URL: inngestUrl,
    INNGEST_DEV_SERVER_URL: inngestUrl,
    INNGEST_DEV: inngestUrl,
    IMPULSE_INTERNAL_KEY: internalKey,
    CLAUDE_CHAT_ENABLED: existing.CLAUDE_CHAT_ENABLED || 'false',
    DISCOVERY_FEEDBACK_ENABLED: existing.DISCOVERY_FEEDBACK_ENABLED || 'true',
    E2E_USER_EMAIL: existing.E2E_USER_EMAIL || DEMO_USER_EMAIL,
    E2E_USER_PASSWORD: existing.E2E_USER_PASSWORD || DEMO_USER_PASSWORD,
    NEXT_PUBLIC_APP_URL: appUrl,
    // OPS-004: derive the mission runtime's internal MCP base from the SAME
    // active-profile app port the launcher starts the app on. `agent/src/config.ts`
    // treats this explicit environment value as the authority over any ignored
    // YAML base_url, so missions always route to the running app.
    IMPULSE_MCP_BASE_URL: `${appUrl}/api/mcp`,
  };
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function serializeDemoEnv(env: EnvMap): string {
  const managed = new Set<string>(MANAGED_ENV_KEYS);
  const lines = [
    '# =============================================================================',
    '# Radarist local demo environment',
    '# Generated by `npm run setup:local`. Values are local-only and gitignored.',
    '# =============================================================================',
  ];

  for (const section of MANAGED_ENV_SECTIONS) {
    lines.push('', section.title);
    for (const key of section.keys) {
      lines.push(`${key}=${formatEnvValue(env[key] || '')}`);
    }
  }

  const extraKeys = Object.keys(env)
    .filter((key) => !managed.has(key))
    .sort();
  if (extraKeys.length > 0) {
    lines.push('', '# Existing local values preserved by setup:local');
    for (const key of extraKeys) {
      lines.push(`${key}=${formatEnvValue(env[key] || '')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function writeDemoEnvFile(filePath: string, env: EnvMap): void {
  const absolute = resolve(process.cwd(), filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, serializeDemoEnv(env));
}

export interface EnsureDemoEnvResult {
  created: boolean;
  env: EnvMap;
}

function mergeMissingManagedEnv(existing: EnvMap, generated: EnvMap): EnvMap {
  const merged: EnvMap = { ...existing };

  for (const key of MANAGED_ENV_KEYS) {
    const existingValue = existing[key];
    const generatedValue = generated[key];
    const missing = existingValue === undefined || existingValue.trim() === '';
    const replacePlaceholder = isManagedPlaceholder(key, existingValue) && !isManagedPlaceholder(key, generatedValue);
    const repairInvalidInngestDev =
      key === 'INNGEST_DEV' && asHttpUrl(existingValue) === undefined && asHttpUrl(generatedValue) !== undefined;

    if (PROFILE_IDENTITY_ENV_KEYS.has(key) || missing || replacePlaceholder || repairInvalidInngestDev) {
      merged[key] = generatedValue ?? '';
    }
  }

  return merged;
}

/**
 * Guarantees the profile env file has every managed local-demo value. Missing
 * values are generated with the exact pipeline `npm run setup:local` uses,
 * while existing explicit values and custom keys are preserved.
 */
export function ensureDemoEnvFile(profile: DemoProfileConfig): EnsureDemoEnvResult {
  const created = !existsSync(resolve(process.cwd(), profile.envFile));
  const existing = readEnvFile(profile.envFile);
  const generated = buildDemoEnv(profile, existing);
  const persisted = mergeMissingManagedEnv(existing, generated);
  const changed = MANAGED_ENV_KEYS.some((key) => persisted[key] !== existing[key]);

  if (created || changed) writeDemoEnvFile(profile.envFile, persisted);
  const env = buildDemoEnv(profile, persisted);
  return { created, env };
}

/**
 * Environment keys the installed Inngest SDK recognizes only to deprecate. It
 * re-warns on EVERY request it handles, which floods local logs (OPS-003).
 *
 * `buildDemoEnv` no longer mints these, but a developer shell or a stale
 * `.env.local` can still export one and `envForChild` inherits the whole parent
 * environment — so they are stripped at the single place every managed child's
 * environment is constructed. SDK dev routing stays on `INNGEST_DEV`; the
 * health and config endpoints read the app-local `INNGEST_DEV_SERVER_URL`
 * alias, which the SDK does not recognize and therefore never warns about.
 */
export const DEPRECATED_INNGEST_SDK_ENV_KEYS = ['INNGEST_DEVSERVER_URL'] as const;

export function envForChild(env: EnvMap): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of DEPRECATED_INNGEST_SDK_ENV_KEYS) delete merged[key];
  return merged;
}

export function validateDemoEnv(env: EnvMap, persistedRequiredEnv: EnvMap = env): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const required = [
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_USE_FIREBASE_EMULATOR',
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST',
    'NEO4J_URI',
    'NEO4J_USER',
    'NEO4J_PASSWORD',
    'RADARIST_GRAPH_RUNTIME_MODE',
    'INNGEST_ENABLED',
    'IMPULSE_INTERNAL_KEY',
  ];

  for (const key of required) {
    const placeholder = isManagedPlaceholder(key, persistedRequiredEnv[key]);
    checks.push({
      level: placeholder ? 'fail' : 'pass',
      label: key,
      detail: placeholder ? 'missing or placeholder' : formatDoctorEnvDetail(key, env[key], 'missing or placeholder'),
    });
  }

  const inngestRouting = resolveInngestSdkRouting(persistedRequiredEnv);
  checks.push({
    level: inngestRouting ? 'pass' : 'fail',
    label: 'INNGEST SDK routing',
    detail: inngestRouting
      ? `${inngestRouting.key} configured`
      : 'set INNGEST_DEV or INNGEST_BASE_URL to a valid http(s) URL',
  });

  // OPS-004: the mission runtime routes every internal MCP call to this base.
  // A blank or malformed value silently misroutes missions, so the doctor
  // fails closed on it.
  const mcpBaseValid = isValidMcpBaseUrl(persistedRequiredEnv.IMPULSE_MCP_BASE_URL);
  checks.push({
    level: mcpBaseValid ? 'pass' : 'fail',
    label: 'IMPULSE_MCP_BASE_URL',
    detail: mcpBaseValid
      ? formatDoctorEnvDetail('IMPULSE_MCP_BASE_URL', env.IMPULSE_MCP_BASE_URL, 'missing or malformed')
      : "set to the running app's http(s) /api/mcp base URL",
  });

  for (const key of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    const placeholder = isPlaceholder(env[key]);
    checks.push({
      level: placeholder ? 'warn' : 'pass',
      label: key,
      detail: formatDoctorEnvDetail(key, env[key], 'placeholder; AI features will be limited'),
    });
  }

  return checks;
}

export function writeFirebaseEmulatorConfig(
  profile: DemoProfileConfig,
  runtimePaths: LocalRuntimePaths = ensurePrivateLocalRuntimeLayout(
    deriveLocalRuntimePaths(process.cwd(), profile.name)
  )
): string {
  const target = resolve(runtimePaths.config, 'firebase.json');
  mkdirSync(dirname(target), { recursive: true });
  // Firebase resolves rules paths relative to THIS config file's directory
  // (tmp/local-demo/), not the repo root — so use absolute paths to the
  // repo-root rule files, otherwise the emulator aborts with "File not found".
  const root = process.cwd();
  writeFileSync(
    target,
    JSON.stringify(
      {
        firestore: {
          rules: resolve(root, 'firestore.rules'),
          indexes: resolve(root, 'firestore.indexes.json'),
        },
        storage: { rules: resolve(root, 'storage.rules') },
        emulators: {
          auth: { host: '127.0.0.1', port: profile.firebase.auth },
          firestore: {
            host: '127.0.0.1',
            port: profile.firebase.firestore,
            websocketPort: profile.firebase.websocket,
          },
          storage: { host: '127.0.0.1', port: profile.firebase.storage },
          ui: { enabled: true, host: '127.0.0.1', port: profile.firebase.ui },
          hub: { host: '127.0.0.1', port: profile.firebase.hub },
          logging: { host: '127.0.0.1', port: profile.firebase.logging },
          singleProjectMode: true,
        },
      },
      null,
      2
    )
  );
  return target;
}

export function commandAvailable(command: string, args: string[] = ['--version']): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

export function waitForTcp(host: string, port: number, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 1000);
        }
      });
    };
    attempt();
  });
}

export function isTcpOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(false);
    });
  });
}

export interface WaitForHttpOptions {
  attemptTimeoutMs?: number;
  pollIntervalMs?: number;
  assertWaitingStillValid?: () => void;
}

export async function waitForHttp(
  url: string,
  timeoutMs = 60_000,
  options: WaitForHttpOptions = {}
): Promise<void> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs <= 0
  ) {
    throw new Error('HTTP readiness budgets must be positive integers');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    options.assertWaitingStillValid?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status < 500) return;
    } catch {
      // keep waiting
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function waitForHealthyLocalRuntime(url: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url);
      const body: unknown = await response.json();
      if (
        response.ok &&
        body !== null &&
        typeof body === 'object' &&
        (body as { status?: unknown }).status === 'healthy'
      ) {
        return;
      }
    } catch {
      // Keep waiting until the owned dependency set reports healthy.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Timed out waiting for healthy local runtime at ${url}`);
}

export function isChildProcessRunning(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function runCommand(
  command: string,
  args: string[],
  env: EnvMap,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      reject(new Error('Command timeout must be a positive integer.'));
      return;
    }
    const detached = options.timeoutMs !== undefined && process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: envForChild(env),
      stdio: 'inherit',
      detached,
    });
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid || !isChildProcessRunning(child)) return;
      try {
        if (detached) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        signal('SIGTERM');
        forceKill = setTimeout(() => signal('SIGKILL'), 2_000);
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimers();
      if (timedOut) {
        reject(
          new Error(
            `${command} exceeded its ${options.timeoutMs}ms timeout and was stopped; ` +
              'arguments were redacted'
          )
        );
        return;
      }
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command} exited with code ${code ?? 'unknown'}; arguments were redacted`
          )
        );
      }
    });
  });
}

export interface ManagedSpawnOptions {
  cwd?: string;
  detached?: boolean;
}

export function spawnManaged(
  name: string,
  command: string,
  args: string[],
  env: EnvMap,
  options: ManagedSpawnOptions = {}
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: envForChild(env),
    stdio: 'inherit',
    detached: options.detached ?? false,
  });
  child.on('error', (error) => {
    console.error(`[demo:full] ${name} failed to start: ${error.message}`);
  });
  return child;
}
