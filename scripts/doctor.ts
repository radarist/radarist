#!/usr/bin/env npx tsx

import {
  buildDemoEnv,
  assertOptionalAgentRuntimePreflight,
  buildPinnedGdsDownloadEnvironment,
  commandAvailable,
  isSupportedPinnedGdsCurlVersion,
  isPlaceholder,
  isTcpOpen,
  PINNED_NEO4J_GDS_MIN_CURL_VERSION,
  PINNED_NEO4J_GDS_VERSION,
  parseProfileArg,
  readEnvFile,
  resolvePinnedGdsCurlCommand,
  probePinnedGdsCurlVersion,
  validateNeo4jDockerPluginEnv,
  validateDemoEnv,
  type DoctorCheck,
} from './lib/local-demo';
import {
  waitForNeo4jGdsReadiness,
  type Neo4jGdsReadinessEnv,
  type Neo4jGdsReadinessOptions,
} from './lib/neo4j-gds-readiness';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const RELEASE_BOOTSTRAP_CONTAINER_FLAG = '--release-bootstrap-neo4j-container';
const RELEASE_BOOTSTRAP_CONTAINER_RE = /^radarist-test020-[a-f0-9]{12}-[a-f0-9]{8}$/;

export interface DoctorOptions {
  readonly profile: ReturnType<typeof parseProfileArg>;
  readonly releaseBootstrapContainer?: string;
}

/**
 * TEST-020 owns a unique disposable graph later in its workflow. Its doctor
 * preflight may inspect only that exact absent name, never the unrelated
 * retained selftest container. Ordinary doctor invocations keep the existing
 * profile-container password and plugin checks unchanged.
 */
export function parseDoctorOptions(args: string[]): DoctorOptions {
  const flagIndexes = args.flatMap((arg, index) => (arg === RELEASE_BOOTSTRAP_CONTAINER_FLAG ? [index] : []));
  if (flagIndexes.length === 0) return { profile: parseProfileArg(args) };
  if (flagIndexes.length !== 1) throw new Error(`${RELEASE_BOOTSTRAP_CONTAINER_FLAG} must be provided exactly once.`);

  const flagIndex = flagIndexes[0];
  const container = args[flagIndex + 1];
  if (!container || container.startsWith('--')) {
    throw new Error(`${RELEASE_BOOTSTRAP_CONTAINER_FLAG} requires an exact TEST-020 container name.`);
  }
  const profileArgs = args.filter((_arg, index) => index !== flagIndex && index !== flagIndex + 1);
  const profile = parseProfileArg(profileArgs);
  if (profile.name !== 'selftest') {
    throw new Error(`${RELEASE_BOOTSTRAP_CONTAINER_FLAG} is restricted to the selftest profile.`);
  }
  if (!RELEASE_BOOTSTRAP_CONTAINER_RE.test(container)) {
    throw new Error(`${RELEASE_BOOTSTRAP_CONTAINER_FLAG} requires a unique radarist-test020 container name.`);
  }
  return { profile, releaseBootstrapContainer: container };
}

export function releaseBootstrapNeo4jAbsenceCheck(status: number | null, stderr: string): DoctorCheck {
  if (status === 0) {
    return {
      level: 'fail',
      label: 'release-bootstrap neo4j target',
      detail: 'unique TEST-020 container name already exists; bootstrap will not adopt it',
    };
  }
  if (/No such (?:object|container)/i.test(stderr)) {
    return {
      level: 'pass',
      label: 'release-bootstrap neo4j target',
      detail: 'unique TEST-020 container name is absent before launch',
    };
  }
  return {
    level: 'fail',
    label: 'release-bootstrap neo4j target',
    detail: 'could not prove the unique TEST-020 container name is absent',
  };
}

function addCheck(checks: DoctorCheck[], level: DoctorCheck['level'], label: string, detail: string): void {
  checks.push({ level, label, detail });
}

export const MIN_NODE_VERSION = '20.19.0';
export const MIN_NODE_22_VERSION = '22.12.0';
export const MIN_NODE_24_VERSION = '24.0.0';
export const NODE_VERSION_REQUIREMENT = 'Node 20.19+, Node 22.12+, or Node 24.x';

function isVersionAtLeast(current: number[], minimumVersion: string): boolean {
  const minimum = minimumVersion.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;

  const current = match.slice(1, 4).map(Number);
  if (current[0] === 20) return isVersionAtLeast(current, MIN_NODE_VERSION);
  if (current[0] === 22) return isVersionAtLeast(current, MIN_NODE_22_VERSION);
  if (current[0] === 24) return isVersionAtLeast(current, MIN_NODE_24_VERSION);
  return false;
}

/**
 * Extracts the password half of NEO4J_AUTH from `docker inspect <container>`
 * JSON output. Returns undefined when auth is disabled ("none"), the env var
 * is absent, or the output is not parseable.
 */
export function parseNeo4jAuthPassword(inspectStdout: string): string | undefined {
  const envList = parseNeo4jInspectEnv(inspectStdout);
  if (!envList) return undefined;
  const auth = envList.find((entry) => entry.startsWith('NEO4J_AUTH='));
  if (!auth) return undefined;
  const value = auth.slice('NEO4J_AUTH='.length);
  const separator = value.indexOf('/');
  if (separator < 0) return undefined;
  return value.slice(separator + 1);
}

function parseNeo4jInspectEnv(inspectStdout: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(inspectStdout);
    if (!Array.isArray(parsed)) return undefined;
    const first = parsed[0] as { Config?: { Env?: unknown } } | undefined;
    const envList = first?.Config?.Env;
    return Array.isArray(envList) && envList.every((entry) => typeof entry === 'string')
      ? envList
      : undefined;
  } catch {
    return undefined;
  }
}

export function isNeo4jContainerRunning(inspectStdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(inspectStdout);
    if (!Array.isArray(parsed)) return false;
    const first = parsed[0] as { State?: { Running?: unknown } } | undefined;
    return first?.State?.Running === true;
  } catch {
    return false;
  }
}

export function neo4jPluginConfigurationCheck(inspectStdout: string): DoctorCheck {
  const validation = validateNeo4jDockerPluginEnv(parseNeo4jInspectEnv(inspectStdout));
  if (validation.valid && validation.provisioning === 'pinned') {
    return {
      level: 'warn',
      label: 'neo4j plugins',
      detail:
        `container is stopped; config includes exactly ${validation.plugins.join(' and ')}, ` +
        `but the pinned artifact and live GDS ${PINNED_NEO4J_GDS_VERSION} runtime are unverified`,
    };
  }
  if (validation.valid) {
    return {
      level: 'fail',
      label: 'neo4j plugins',
      detail:
        'container uses the legacy mutable GDS plugin resolver; run demo:full to perform ' +
        'the guarded data-preserving migration to the pinned plugin contract',
    };
  }
  return {
    level: 'fail',
    label: 'neo4j plugins',
    detail:
      `container is stopped and its plugin configuration is invalid: ${validation.reason}; ` +
      'recreate the profile-owned container without deleting its named data volumes',
  };
}

export type Neo4jGdsRuntimeObservation =
  | { kind: 'ready'; version: unknown }
  | { kind: 'unavailable' };

const SAFE_GDS_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * Classify only bounded, non-sensitive runtime evidence. Probe errors are
 * intentionally represented without their message so driver diagnostics can
 * never echo credentials or connection strings through the doctor output.
 */
export function classifyNeo4jGdsRuntime(
  observation: Neo4jGdsRuntimeObservation
): DoctorCheck {
  if (observation.kind === 'ready' && observation.version === PINNED_NEO4J_GDS_VERSION) {
    return {
      level: 'pass',
      label: 'neo4j gds runtime',
      detail: `authenticated gds.version() returned ${PINNED_NEO4J_GDS_VERSION}`,
    };
  }

  if (
    observation.kind === 'ready' &&
    typeof observation.version === 'string' &&
    SAFE_GDS_VERSION_PATTERN.test(observation.version)
  ) {
    return {
      level: 'fail',
      label: 'neo4j gds runtime',
      detail:
        `authenticated gds.version() returned ${observation.version}; ` +
        `exactly ${PINNED_NEO4J_GDS_VERSION} is required`,
    };
  }

  return {
    level: 'fail',
    label: 'neo4j gds runtime',
    detail:
      `authenticated gds.version() did not prove exact version ${PINNED_NEO4J_GDS_VERSION}; ` +
      'the required plugin may be missing or unavailable',
  };
}

export const DOCTOR_NEO4J_GDS_PROBE_OPTIONS = {
  timeoutMs: 5_000,
  attemptTimeoutMs: 2_000,
  pollIntervalMs: 250,
} as const satisfies Neo4jGdsReadinessOptions;

export type DoctorNeo4jGdsProbe = (
  env: Neo4jGdsReadinessEnv,
  options: Neo4jGdsReadinessOptions
) => Promise<string>;

export async function checkLiveNeo4jGdsRuntime(
  env: Neo4jGdsReadinessEnv,
  probe: DoctorNeo4jGdsProbe = waitForNeo4jGdsReadiness
): Promise<DoctorCheck> {
  try {
    const version = await probe(env, DOCTOR_NEO4J_GDS_PROBE_OPTIONS);
    return classifyNeo4jGdsRuntime({ kind: 'ready', version });
  } catch {
    return classifyNeo4jGdsRuntime({ kind: 'unavailable' });
  }
}

export async function checkInspectedNeo4jGds(
  inspectStdout: string,
  env: Neo4jGdsReadinessEnv,
  probe: DoctorNeo4jGdsProbe = waitForNeo4jGdsReadiness
): Promise<DoctorCheck> {
  if (!isNeo4jContainerRunning(inspectStdout)) {
    return neo4jPluginConfigurationCheck(inspectStdout);
  }
  const configuration = validateNeo4jDockerPluginEnv(
    parseNeo4jInspectEnv(inspectStdout)
  );
  if (!configuration.valid) {
    return {
      level: 'fail',
      label: 'neo4j plugins',
      detail:
        `${configuration.reason}; recreate the profile-owned Neo4j container ` +
        'without deleting its data volumes',
    };
  }
  if (configuration.provisioning === 'legacy-auto') {
    return {
      level: 'fail',
      label: 'neo4j plugins',
      detail:
        'container uses the legacy mutable GDS plugin resolver; run demo:full to perform ' +
        'the guarded data-preserving migration to the pinned plugin contract',
    };
  }
  return checkLiveNeo4jGdsRuntime(env, probe);
}

/**
 * The documented first-boot trap (docs/getting-started.md): Neo4j persists the
 * password from its first boot in the data volume, so rotating NEO4J_PASSWORD
 * in the env file leaves the running container on the old credential and every
 * bolt connection fails with Neo.ClientError.Security.Unauthorized. Returns
 * null when there is nothing to compare (container password unknown or env
 * file has no NEO4J_PASSWORD) — the caller silently skips the check.
 */
export function neo4jPasswordParityCheck(
  containerPassword: string | undefined,
  envFilePassword: string | undefined,
  envFile: string
): DoctorCheck | null {
  if (!containerPassword || !envFilePassword) return null;
  if (containerPassword === envFilePassword) {
    return { level: 'pass', label: 'neo4j password', detail: `container NEO4J_AUTH matches ${envFile}` };
  }
  return {
    level: 'fail',
    label: 'neo4j password',
    detail: `password mismatch between running container and ${envFile} — run npm run neo4j:reset`,
  };
}

export function optionalAgentRuntimeCheck(
  env: Record<string, string>,
  repositoryRoot: string
): DoctorCheck {
  try {
    assertOptionalAgentRuntimePreflight(env, repositoryRoot);
    const configured = !isPlaceholder(env.ANTHROPIC_API_KEY);
    return {
      level: configured ? 'pass' : 'warn',
      label: 'optional agent runtime',
      detail: configured
        ? 'compiled mission runtime is available'
        : 'Anthropic is not configured; paid missions stay unavailable',
    };
  } catch (error) {
    return {
      level: 'fail',
      label: 'optional agent runtime',
      detail: error instanceof Error ? error.message : 'run npm run setup:agents',
    };
  }
}

export function curlPrerequisiteCheck(version: string | undefined): DoctorCheck {
  return version && isSupportedPinnedGdsCurlVersion(version)
    ? {
        level: 'pass',
        label: 'host HTTPS client',
        detail: `curl ${version} supports checksum-pinned GDS provisioning`,
      }
    : {
        level: 'fail',
        label: 'host HTTPS client',
        detail:
          `curl ${PINNED_NEO4J_GDS_MIN_CURL_VERSION}+ is required for host-trusted, size-bounded GDS provisioning` +
          (version ? `; found ${version}` : '; install it and ensure the executable is available'),
      };
}

function printCheck(check: DoctorCheck): void {
  const marker = check.level === 'pass' ? 'PASS' : check.level === 'warn' ? 'WARN' : 'FAIL';
  const stream = check.level === 'fail' ? console.error : console.log;
  stream(`[${marker}] ${check.label}: ${check.detail}`);
}

async function main(): Promise<void> {
  const options = parseDoctorOptions(process.argv.slice(2));
  const profile = options.profile;
  const envFileExists = existsSync(resolve(process.cwd(), profile.envFile));
  const fileEnv = readEnvFile(profile.envFile);
  const env = buildDemoEnv(profile, fileEnv);
  const checks: DoctorCheck[] = [];

  addCheck(
    checks,
    envFileExists ? 'pass' : 'fail',
    profile.envFile,
    envFileExists ? 'local env file exists' : `missing; run npm run setup:local -- --profile ${profile.name}`
  );

  addCheck(
    checks,
    process.platform === 'darwin' ? 'pass' : 'warn',
    'platform',
    process.platform === 'darwin' ? 'macOS detected' : `Mac-first scripts running on ${process.platform}`
  );

  const nodeSupported = isSupportedNodeVersion(process.versions.node);
  addCheck(
    checks,
    nodeSupported ? 'pass' : 'fail',
    'node',
    nodeSupported
      ? `Node ${process.versions.node} (${NODE_VERSION_REQUIREMENT})`
      : `Node ${process.versions.node}; ${NODE_VERSION_REQUIREMENT} required`
  );
  addCheck(checks, commandAvailable('npm') ? 'pass' : 'fail', 'npm', 'npm command available');
  addCheck(checks, commandAvailable('docker', ['--version']) ? 'pass' : 'fail', 'docker', 'Docker CLI available');
  addCheck(
    checks,
    commandAvailable('docker', ['info']) ? 'pass' : 'fail',
    'docker daemon',
    'Docker Desktop daemon reachable'
  );
  addCheck(checks, commandAvailable('java', ['-version']) ? 'pass' : 'fail', 'java', 'Java runtime available');
  const curlCommand = resolvePinnedGdsCurlCommand();
  checks.push(
    curlPrerequisiteCheck(
      probePinnedGdsCurlVersion(
        curlCommand,
        buildPinnedGdsDownloadEnvironment(process.env)
      )
    )
  );

  // Ordinary profiles retain the password/plugin preflight for their durable
  // container. TEST-020 instead proves its exact unique name is absent before
  // launch and never inspects the unrelated retained selftest container.
  try {
    const inspect = spawnSync('docker', ['inspect', options.releaseBootstrapContainer ?? profile.neo4jContainer], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.releaseBootstrapContainer ? 'pipe' : 'ignore'],
    });
    if (options.releaseBootstrapContainer) {
      checks.push(releaseBootstrapNeo4jAbsenceCheck(inspect.status, String(inspect.stderr ?? '')));
    } else if (inspect.status === 0 && typeof inspect.stdout === 'string') {
      checks.push(await checkInspectedNeo4jGds(inspect.stdout, env));
      const parity = neo4jPasswordParityCheck(
        parseNeo4jAuthPassword(inspect.stdout),
        fileEnv.NEO4J_PASSWORD,
        profile.envFile
      );
      if (parity) checks.push(parity);
    }
  } catch {
    if (options.releaseBootstrapContainer) {
      checks.push(releaseBootstrapNeo4jAbsenceCheck(null, ''));
    }
    // Ordinary doctor: docker inspect unavailable means there is no retained
    // profile-container evidence to compare. Docker availability is checked
    // separately above and remains blocking when the daemon is unavailable.
  }

  // Runtime defaults must not hide an incomplete env file. Generated secrets
  // must be persisted, and Inngest must have an SDK-effective routing URL (the
  // health/script helper aliases do not route SDK event sends).
  checks.push(...validateDemoEnv(env, fileEnv));
  checks.push(optionalAgentRuntimeCheck(env, process.cwd()));

  const portChecks = [
    ['app', profile.appPort],
    ['firebase ui', profile.firebase.ui],
    ['firestore', profile.firebase.firestore],
    ['auth', profile.firebase.auth],
    ['storage', profile.firebase.storage],
    ['neo4j http', profile.neo4j.http],
    ['neo4j bolt', profile.neo4j.bolt],
    ['inngest', profile.inngestPort],
  ] as const;

  for (const [label, port] of portChecks) {
    const open = await isTcpOpen('127.0.0.1', port);
    addCheck(
      checks,
      open ? 'warn' : 'pass',
      `port ${port}`,
      open ? `${label} port is already in use` : `${label} port is available`
    );
  }

  console.log(`[doctor] Profile: ${profile.name} (${profile.envFile})`);
  for (const check of checks) printCheck(check);

  const failed = checks.filter((check) => check.level === 'fail');
  if (failed.length > 0) {
    console.error(`[doctor] ${failed.length} blocking check(s) failed.`);
    process.exit(1);
  }

  console.log('[doctor] No blocking local demo issues found.');
}

// Only run when executed directly (keeps the parity helpers importable in tests)
if (require.main === module) {
  main().catch((error) => {
    console.error('[doctor] Failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
