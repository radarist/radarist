#!/usr/bin/env npx tsx

import { spawnSync, type ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import neo4j from 'neo4j-driver';
import {
  assertOptionalAgentRuntimePreflight,
  assertFreshFirebaseGraphCompatibility,
  buildPinnedGdsArtifactImportArgs,
  buildPinnedGdsArtifactProbeArgs,
  buildPinnedGdsDownloadEnvironment,
  buildDemoAppLaunchPlan,
  buildInngestLaunchPlan,
  commandAvailable,
  createIdempotentAsyncAction,
  ensureDemoEnvFile,
  envForChild,
  downloadPinnedGdsArtifact,
  hasExactNeo4jDockerAuth,
  hasExpectedDockerNamedVolumeMounts,
  hasExpectedDockerLoopbackBindings,
  isChildProcessRunning,
  isTcpOpen,
  parseDemoFullOptions,
  PINNED_NEO4J_GDS_CONTAINER_PATH,
  PINNED_NEO4J_GDS_HOST_FILE_NAME,
  PINNED_NEO4J_GDS_MIN_CURL_VERSION,
  PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE,
  PINNED_NEO4J_GDS_SHA256,
  PINNED_NEO4J_GDS_SIZE_BYTES,
  PINNED_NEO4J_GDS_VERSION,
  planLegacyGdsMigrationRecovery,
  requireInitialGraphAudit,
  planMissingDockerVolumes,
  isSupportedPinnedGdsCurlVersion,
  probePinnedGdsCurlVersion,
  resolvePinnedGdsCurlCommand,
  runCommand,
  spawnManaged,
  validateNeo4jDockerPluginEnv,
  waitForHttp,
  waitForHealthyLocalRuntime,
  waitForTcp,
  writeFirebaseEmulatorConfig,
  type DemoProfileConfig,
  type EnvMap,
} from './lib/local-demo';
import { waitForNeo4jGdsReadiness } from './lib/neo4j-gds-readiness';
import {
  LOCAL_RUNTIME_NEO4J_IMAGE,
  buildLocalRuntimeExecutionContext,
  createEphemeralLocalRuntimeExecutionContext,
  deriveLocalRuntimePaths,
  resolveLocalRuntimeDataRoot,
  ensurePrivateLocalRuntimeLayout,
  removeEphemeralLocalRuntimeSession,
  removeStaleEphemeralLocalRuntimeSessions,
  type EphemeralLocalRuntimeExecutionContext,
  type LocalRuntimePaths,
} from './lib/local-runtime-profile';
import { LOCAL_RUNTIME_EPOCH_ENV } from '@/lib/inngest/runtime-epoch';
import {
  type LocalRuntimePausableProcessRole,
  type OwnedLocalProcessIdentity,
} from './lib/local-process-supervisor';
import {
  LocalRuntimeLifecycle,
  shouldRemoveRetiredEphemeralNeo4j,
  type LocalRuntimeProcessPauseToken,
} from './lib/local-runtime-lifecycle';
import {
  INITIAL_CHECKPOINT_SCHEDULER_STATE,
  finishCheckpoint,
  requestCheckpoint,
  type CheckpointSchedulerState,
  type ValidatedCheckpointGeneration,
} from './lib/firebase-checkpoints';
import {
  describeCheckpointContract,
  resolveCheckpointIntervalMs,
  checkpointBudgetFromEnvironment,
  createFirebaseCheckpoint,
  prepareFirebaseCheckpointRecovery,
} from './lib/firebase-checkpoint-runtime';
import { describeLocalLogin, listLocalAuthAccountEmails } from './lib/local-auth-accounts';
import {
  DEFAULT_CHECKPOINT_DRAIN_MS,
  acquireCheckpointBarrier,
  clearRestoredCheckpointBarrier,
  createFirestoreCheckpointBarrierStore,
} from './lib/local-checkpoint-barrier';
import {
  EMPTY_RUNTIME_RESIDUE,
  buildShutdownAcknowledgement,
  formatShutdownAcknowledgement,
  type FinalCheckpointAcknowledgement,
  type OwnedProcessCensusEntry,
  type RuntimeResidue,
  type ShutdownStepStatus,
} from './lib/retained-runtime-shutdown-receipt';
import { stopAndRemoveDockerContainer } from './lib/docker-container-cleanup';
import type { LocalRuntimeStatusFile } from '@/lib/local-runtime-status';
import { assertFirebaseOnlyResetMarkerAbsent } from './lib/local-reset-marker';

const children: Array<{
  name: string;
  role: OwnedLocalProcessIdentity['role'];
  child: ChildProcess;
}> = [];

// Durable persistence is the normal launcher mode. Checkpoints are explicit,
// verified full generations; Firebase's clean-exit-only export is not used.
let persistEnabled = false;
let firebaseChild: ChildProcess | null = null;
let runtimePaths: LocalRuntimePaths | null = null;
let runtimeLifecycle: LocalRuntimeLifecycle | null = null;
let runtimeStatus: LocalRuntimeStatusFile | null = null;
let checkpointTimer: NodeJS.Timeout | null = null;
let graphHealthTimer: NodeJS.Timeout | null = null;
let runtimeHeartbeatTimer: NodeJS.Timeout | null = null;
let checkpointState: CheckpointSchedulerState = { ...INITIAL_CHECKPOINT_SCHEDULER_STATE };
let checkpointInFlight: Promise<void> | null = null;
let graphHealthInFlight: Promise<void> | null = null;
/**
 * LOCAL-012: the checkpoint runner now RETURNS the verified generation it created
 * so the shutdown acknowledgement can name it. Previously the result was
 * discarded, which is why a final checkpoint could only ever be announced, never
 * confirmed.
 */
let runCheckpoint: (() => Promise<ValidatedCheckpointGeneration>) | null = null;
/** Newest generation this process verified, used by the shutdown receipt. */
let lastVerifiedGeneration: ValidatedCheckpointGeneration | null = null;
let ephemeralNeo4jContainer: string | null = null;
let ephemeralNeo4jOwner: string | null = null;
let ephemeralNeo4jPluginVolume: string | null = null;
let ephemeralNeo4jRuntimeLabel: string | null = null;
let ephemeralExecution: EphemeralLocalRuntimeExecutionContext | null = null;
let pendingLegacyMigration:
  | {
      profile: DemoProfileConfig;
      env: EnvMap;
      backupContainer: string;
    }
  | null = null;

const LOCAL_RUNTIME_DOCKER_LABEL = 'com.radarist.local-runtime';
// Pinned image identity lives in the canonical runtime-profile authority so
// launchers, health, and backup can never drift apart (LOCAL-011/LOCAL-014).
const DURABLE_NEO4J_IMAGE = LOCAL_RUNTIME_NEO4J_IMAGE;
const DURABLE_NEO4J_MOUNTS = [
  { suffix: 'data', destination: '/data' },
  { suffix: 'logs', destination: '/logs' },
  { suffix: 'import', destination: '/var/lib/neo4j/import' },
  { suffix: 'plugins', destination: '/plugins' },
] as const;
const CHECKPOINT_WRITER_ROLES = [
  'next',
  'inngest',
  'assistant',
  'mcp',
  'background',
] as const satisfies readonly LocalRuntimePausableProcessRole[];

async function countNeo4jUserDataNodes(env: EnvMap): Promise<number> {
  const driver = neo4j.driver(
    env.NEO4J_URI,
    neo4j.auth.basic(env.NEO4J_USER || 'neo4j', env.NEO4J_PASSWORD)
  );
  try {
    await driver.verifyConnectivity();
    const session = driver.session({ database: env.NEO4J_DATABASE || 'neo4j' });
    try {
      const result = await session.run(
        'MATCH (n) WHERE NOT n:RelationType RETURN count(n) AS count'
      );
      const count = result.records[0]?.get('count');
      if (!neo4j.isInt(count)) throw new Error('Neo4j user-data census did not return an integer.');
      return count.toNumber();
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

function writeRuntimeStatus(): void {
  if (!runtimePaths || !runtimeStatus) return;
  const target = join(runtimePaths.status, 'health.json');
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(runtimeStatus, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  const directory = openSync(runtimePaths.status, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function updateRuntimeStatus(
  mutator: (current: LocalRuntimeStatusFile) => LocalRuntimeStatusFile
): void {
  if (!runtimeStatus) return;
  runtimeStatus = mutator(runtimeStatus);
  writeRuntimeStatus();
}

function queueCheckpoint(reason: string): Promise<void> {
  if (!runCheckpoint) return Promise.resolve();
  const request = requestCheckpoint(checkpointState, new Date().toISOString());
  checkpointState = request.state;
  if (request.action === 'coalesced') {
    console.log(`[demo:full] Coalesced checkpoint request (${reason})`);
    return checkpointInFlight ?? Promise.resolve();
  }

  checkpointInFlight = (async () => {
    let continueRunning = true;
    let lastError: unknown;
    while (continueRunning) {
      updateRuntimeStatus((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        checkpoint: { ...current.checkpoint, state: 'pending' },
      }));
      try {
        lastVerifiedGeneration = await runCheckpoint!();
        lastError = undefined;
        const completedAt = new Date().toISOString();
        updateRuntimeStatus((current) => ({
          ...current,
          updatedAt: completedAt,
          checkpoint: { state: 'healthy', lastSuccessAt: completedAt },
        }));
      } catch (error) {
        lastError = error;
        const failedAt = new Date().toISOString();
        console.error(
          '[demo:full] Checkpoint failed:',
          error instanceof Error ? error.message : String(error)
        );
        updateRuntimeStatus((current) => ({
          ...current,
          updatedAt: failedAt,
          checkpoint: {
            ...current.checkpoint,
            state: 'degraded',
            lastFailureAt: failedAt,
          },
        }));
      }
      const finished = finishCheckpoint(checkpointState, new Date().toISOString());
      checkpointState = finished.state;
      continueRunning = finished.action === 'start-coalesced';
    }
    if (lastError !== undefined) throw lastError;
  })().finally(() => {
    checkpointInFlight = null;
  });
  return checkpointInFlight;
}

function runGraphConsistencyAudit(
  env: EnvMap,
  failureMode: 'propagate' | 'degrade'
): Promise<void> {
  if (graphHealthInFlight) return graphHealthInFlight;
  graphHealthInFlight = runCommand(
    'npm',
    ['run', 'graph:health'],
    { ...env, GRAPH_HEALTH_COUNT_DIFF: '1' },
    {
      cwd: process.cwd(),
      timeoutMs: failureMode === 'propagate' ? 30_000 : 2 * 60_000,
    }
  )
    .then(() => {
      updateRuntimeStatus((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        supervisor: current.supervisor.unexpectedExit
          ? current.supervisor
          : { ...current.supervisor, state: 'running' },
      }));
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (failureMode === 'propagate') {
        console.error(
          '[demo:full] Initial cross-store graph audit failed; startup cannot become healthy.',
          detail
        );
      } else {
        console.error(
          '[demo:full] Periodic cross-store graph audit failed; readiness is degraded. ' +
            'Allow the local reconciliation job to run, then use `npm run graph:health` to verify recovery.',
          detail
        );
      }
      updateRuntimeStatus((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        supervisor: { ...current.supervisor, state: 'degraded' },
      }));
      if (failureMode === 'propagate') throw error;
    })
    .finally(() => {
      graphHealthInFlight = null;
    });
  return graphHealthInFlight;
}

function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || !isChildProcessRunning(child)) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function runSync(command: string, args: string[], env: EnvMap): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: envForChild(env),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status ?? 'unknown'}; arguments were redacted`
    );
  }
}

function assertSupportedPinnedGdsCurl(
  command: string,
  env: NodeJS.ProcessEnv
): void {
  const version = probePinnedGdsCurlVersion(command, env);
  if (!version || !isSupportedPinnedGdsCurlVersion(version)) {
    throw new Error(
      `curl ${PINNED_NEO4J_GDS_MIN_CURL_VERSION}+ is required for independently size-bounded, host-trusted GDS provisioning.`
    );
  }
}

async function assertProductPortsAvailable(
  profile: DemoProfileConfig,
  skipInngest: boolean,
  includeNeo4j: boolean
): Promise<void> {
  const ports = [
    ['app', profile.appPort],
    ...(!skipInngest ? ([['inngest', profile.inngestPort]] as const) : []),
    ['firebase-ui', profile.firebase.ui],
    ['firebase-websocket', profile.firebase.websocket],
    ['firebase-hub', profile.firebase.hub],
    ['firebase-logging', profile.firebase.logging],
    ['firestore', profile.firebase.firestore],
    ['auth', profile.firebase.auth],
    ['storage', profile.firebase.storage],
    ...(includeNeo4j
      ? ([
          ['neo4j-http', profile.neo4j.http],
          ['neo4j-bolt', profile.neo4j.bolt],
        ] as const)
      : []),
  ] as const;
  const occupied: string[] = [];
  for (const [name, port] of ports) {
    if (await isTcpOpen('127.0.0.1', port)) occupied.push(`${name}:${port}`);
  }
  if (occupied.length > 0) {
    throw new Error(`Local runtime profile ports are already occupied: ${occupied.join(', ')}.`);
  }
}

function dockerContainerExists(name: string): boolean {
  return spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status === 0;
}

function dockerVolumeExists(name: string): boolean {
  return (
    spawnSync('docker', ['volume', 'inspect', name], { stdio: 'ignore' }).status === 0
  );
}

function expectedDurableNeo4jMounts(profile: DemoProfileConfig) {
  return DURABLE_NEO4J_MOUNTS.map(({ suffix, destination }) => ({
    name: `${profile.neo4jVolumePrefix}_${suffix}`,
    destination,
  }));
}

function assertExistingDurableNeo4jIdentity(
  profile: DemoProfileConfig,
  env: EnvMap,
  container = profile.neo4jContainer
): 'pinned' | 'legacy-auto' {
  const portResult = spawnSync(
    'docker',
    ['inspect', '--format', '{{json .HostConfig.PortBindings}}', container],
    { encoding: 'utf8' }
  );
  const mountResult = spawnSync(
    'docker',
    ['inspect', '--format', '{{json .Mounts}}', container],
    { encoding: 'utf8' }
  );
  const imageResult = spawnSync(
    'docker',
    ['inspect', '--format', '{{.Config.Image}}', container],
    { encoding: 'utf8' }
  );
  const envResult = spawnSync(
    'docker',
    ['inspect', '--format', '{{json .Config.Env}}', container],
    { encoding: 'utf8' }
  );
  let inspectedEnvironment: unknown;
  let pluginProvisioning: 'pinned' | 'legacy-auto' | undefined;
  if (!envResult.error && envResult.status === 0) {
    try {
      inspectedEnvironment = JSON.parse(envResult.stdout);
      const validation = validateNeo4jDockerPluginEnv(inspectedEnvironment);
      if (validation.valid) pluginProvisioning = validation.provisioning;
    } catch {
      pluginProvisioning = undefined;
    }
  }
  const expected = [
    { containerPort: 7474, hostPort: profile.neo4j.http },
    { containerPort: 7687, hostPort: profile.neo4j.bolt },
  ];
  const expectedMounts = expectedDurableNeo4jMounts(profile);
  const runtimeLabel = `durable:${profile.name}`;
  if (
    portResult.error ||
    portResult.status !== 0 ||
    mountResult.error ||
    mountResult.status !== 0 ||
    imageResult.error ||
    imageResult.status !== 0 ||
    pluginProvisioning === undefined ||
    !hasExactNeo4jDockerAuth(inspectedEnvironment, env.NEO4J_PASSWORD) ||
    imageResult.stdout.trim() !== DURABLE_NEO4J_IMAGE ||
    !hasExpectedDockerLoopbackBindings(portResult.stdout, expected) ||
    !hasExpectedDockerNamedVolumeMounts(mountResult.stdout, expectedMounts) ||
    inspectDockerLabel(container, LOCAL_RUNTIME_DOCKER_LABEL) !== runtimeLabel ||
    expectedMounts.some(({ name }) => {
      const identity = inspectDockerVolumeIdentity(name);
      return (
        identity.runtimeLabel !== runtimeLabel ||
        identity.driver !== 'local' ||
        identity.scope !== 'local' ||
        !['null', '{}'].includes(identity.optionsJson ?? '')
      );
    })
  ) {
    throw new Error(
      `Existing container ${container} does not have the expected durable identity: profile ownership label, ` +
        `exact image ${DURABLE_NEO4J_IMAGE}, matching retained authentication, canonical or migratable plugin intent, 127.0.0.1-only port bindings, exact local named-volume mounts, and matching volume ownership labels are all required. ` +
        'Refusing to start or modify it; preserve its data and resolve the mismatched Docker objects explicitly.'
    );
  }
  return pluginProvisioning;
}

function inspectDockerLabel(container: string, label: string): string | undefined {
  const result = spawnSync(
    'docker',
    ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, container],
    { encoding: 'utf8' }
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function inspectDockerVolumeLabel(volume: string, label: string): string | undefined {
  const result = spawnSync(
    'docker',
    ['volume', 'inspect', '--format', `{{index .Labels "${label}"}}`, volume],
    { encoding: 'utf8' }
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function inspectDockerVolumeField(volume: string, format: string): string | undefined {
  const result = spawnSync('docker', ['volume', 'inspect', '--format', format, volume], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function inspectDockerVolumeIdentity(volume: string) {
  return {
    name: volume,
    runtimeLabel: inspectDockerVolumeLabel(volume, LOCAL_RUNTIME_DOCKER_LABEL),
    driver: inspectDockerVolumeField(volume, '{{.Driver}}'),
    scope: inspectDockerVolumeField(volume, '{{.Scope}}'),
    optionsJson: inspectDockerVolumeField(volume, '{{json .Options}}'),
  };
}

function listDockerVolumeNames(): Set<string> {
  const result = spawnSync('docker', ['volume', 'ls', '--quiet'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Unable to enumerate Docker volumes before durable Neo4j provisioning.');
  }
  return new Set(result.stdout.split(/\r?\n/).filter((name) => name.length > 0));
}

function ensureDurableNeo4jVolumes(profile: DemoProfileConfig, env: EnvMap): void {
  const expectedMounts = expectedDurableNeo4jMounts(profile);
  const expectedNames = expectedMounts.map(({ name }) => name);
  const runtimeLabel = `durable:${profile.name}`;
  const existingNames = listDockerVolumeNames();
  const existingCanonicalVolumes = expectedNames
    .filter((name) => existingNames.has(name))
    .map(inspectDockerVolumeIdentity);
  const missing = planMissingDockerVolumes(
    expectedNames,
    existingCanonicalVolumes,
    runtimeLabel
  );

  for (const name of missing) {
    runSync(
      'docker',
      ['volume', 'create', '--label', `${LOCAL_RUNTIME_DOCKER_LABEL}=${runtimeLabel}`, name],
      env
    );
  }

  planMissingDockerVolumes(
    expectedNames,
    expectedNames.map(inspectDockerVolumeIdentity),
    runtimeLabel
  );
}

function isDockerContainerRunning(container: string): boolean {
  const result = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Running}}', container],
    { encoding: 'utf8' }
  );
  return result.status === 0 && result.stdout.trim() === 'true';
}

function hasPinnedGdsArtifactInRunningContainer(container: string): boolean {
  const result = spawnSync(
    'docker',
    ['exec', container, 'sha256sum', PINNED_NEO4J_GDS_CONTAINER_PATH],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (result.error || result.status !== 0) return false;
  const [observed] = result.stdout.trim().split(/\s+/, 1);
  return observed === PINNED_NEO4J_GDS_SHA256;
}

function hasPinnedGdsArtifactInOwnedVolume(
  pluginVolume: string,
  env: EnvMap
): boolean {
  const result = spawnSync(
    'docker',
    buildPinnedGdsArtifactProbeArgs(pluginVolume),
    {
      cwd: process.cwd(),
      env: envForChild(env),
      stdio: 'ignore',
    }
  );
  if (result.error) {
    throw new Error('Unable to launch the isolated pinned GDS volume probe.');
  }
  if (result.status === 0) return true;
  if (result.status === PINNED_NEO4J_GDS_PROBE_MISMATCH_EXIT_CODE) return false;
  throw new Error(
    `Pinned GDS volume probe exited with unexpected code ${result.status ?? 'unknown'}.`
  );
}

function assertPinnedGdsHostArtifact(artifactPath: string): void {
  const entry = lstatSync(artifactPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('Pinned GDS download did not produce a regular file.');
  }
  const size = statSync(artifactPath).size;
  if (size !== PINNED_NEO4J_GDS_SIZE_BYTES) {
    throw new Error(
      `Pinned GDS download has unexpected size ${size}; expected ${PINNED_NEO4J_GDS_SIZE_BYTES}.`
    );
  }
  const observed = createHash('sha256')
    .update(readFileSync(artifactPath))
    .digest('hex');
  if (observed !== PINNED_NEO4J_GDS_SHA256) {
    throw new Error(
      'Host-downloaded pinned Neo4j GDS artifact failed checksum verification; refusing to install.'
    );
  }
}

function provisionPinnedGdsArtifact(pluginVolume: string, env: EnvMap): void {
  console.log(
    `[demo:full] Verifying pinned Neo4j GDS ${PINNED_NEO4J_GDS_VERSION} artifact`
  );
  if (hasPinnedGdsArtifactInOwnedVolume(pluginVolume, env)) {
    console.log('[demo:full] Reusing checksum-verified Neo4j GDS artifact');
    return;
  }
  if (!runtimePaths) {
    throw new Error('Local runtime paths are unavailable for pinned GDS staging.');
  }

  const stagingDirectory = mkdtempSync(join(runtimePaths.temp, 'gds-download-'));
  const artifactPath = join(stagingDirectory, PINNED_NEO4J_GDS_HOST_FILE_NAME);

  try {
    chmodSync(stagingDirectory, 0o700);
    const descriptor = openSync(artifactPath, 'wx', 0o600);
    closeSync(descriptor);
    const curlCommand = resolvePinnedGdsCurlCommand();
    const curlEnvironment = buildPinnedGdsDownloadEnvironment({
      ...envForChild(env),
      ...process.env,
    });
    assertSupportedPinnedGdsCurl(curlCommand, curlEnvironment);
    downloadPinnedGdsArtifact(
      curlCommand,
      artifactPath,
      curlEnvironment,
      130_000
    );
    chmodSync(artifactPath, 0o600);
    assertPinnedGdsHostArtifact(artifactPath);
    runSync(
      'docker',
      buildPinnedGdsArtifactImportArgs(pluginVolume, artifactPath),
      env
    );
    if (!hasPinnedGdsArtifactInOwnedVolume(pluginVolume, env)) {
      throw new Error(
        'Pinned Neo4j GDS artifact import did not survive the isolated volume verification.'
      );
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function buildDurableNeo4jCreateArgs(
  profile: DemoProfileConfig,
  env: EnvMap
): string[] {
  const expectedMounts = expectedDurableNeo4jMounts(profile);
  return [
    'create',
    '--name',
    profile.neo4jContainer,
    '--label',
    `${LOCAL_RUNTIME_DOCKER_LABEL}=durable:${profile.name}`,
    '-p',
    `127.0.0.1:${profile.neo4j.http}:7474`,
    '-p',
    `127.0.0.1:${profile.neo4j.bolt}:7687`,
    '-e',
    `NEO4J_AUTH=neo4j/${env.NEO4J_PASSWORD}`,
    '-e',
    'NEO4J_server_memory_heap_initial__size=512m',
    '-e',
    'NEO4J_server_memory_heap_max__size=2G',
    '-e',
    'NEO4J_server_memory_pagecache_size=1G',
    '-e',
    'NEO4J_db_transaction_timeout=30s',
    '-e',
    'NEO4J_dbms_security_procedures_unrestricted=apoc.*,gds.*',
    '-e',
    'NEO4J_dbms_security_procedures_allowlist=apoc.*,gds.*',
    '-e',
    'NEO4J_PLUGINS=["apoc"]',
    ...expectedMounts.flatMap(({ name, destination }) => ['-v', `${name}:${destination}`]),
    DURABLE_NEO4J_IMAGE,
  ];
}

function legacyMigrationBackupName(profile: DemoProfileConfig): string {
  return `${profile.neo4jContainer}-legacy-gds-migration`;
}

function reconcileInterruptedLegacyMigration(
  profile: DemoProfileConfig,
  env: EnvMap
): void {
  const backupContainer = legacyMigrationBackupName(profile);
  if (!dockerContainerExists(backupContainer)) return;

  const backupProvisioning = assertExistingDurableNeo4jIdentity(
    profile,
    env,
    backupContainer
  );
  const canonicalProvisioning = dockerContainerExists(profile.neo4jContainer)
    ? assertExistingDurableNeo4jIdentity(profile, env)
    : 'missing';
  const action = planLegacyGdsMigrationRecovery({
    canonical: canonicalProvisioning,
    backup: backupProvisioning,
    backupRunning: isDockerContainerRunning(backupContainer),
  });

  if (action === 'restore-legacy-name') {
    runSync('docker', ['rename', backupContainer, profile.neo4jContainer], env);
    console.log(
      `[demo:full] Recovered interrupted Neo4j migration checkpoint ${profile.neo4jContainer}`
    );
    return;
  }
  if (action === 'resume-pinned-replacement') {
    pendingLegacyMigration = { profile, env, backupContainer };
    console.log(
      `[demo:full] Resuming verification of interrupted GDS migration for ${profile.neo4jContainer}`
    );
  }
}

function finalizePendingLegacyMigration(): void {
  if (!pendingLegacyMigration) return;
  const { profile, env, backupContainer } = pendingLegacyMigration;
  if (!dockerContainerExists(backupContainer)) {
    pendingLegacyMigration = null;
    return;
  }
  const provisioning = assertExistingDurableNeo4jIdentity(
    profile,
    env,
    backupContainer
  );
  if (
    provisioning !== 'legacy-auto' ||
    isDockerContainerRunning(backupContainer)
  ) {
    throw new Error(
      `Refusing to finalize unverified Neo4j migration backup ${backupContainer}.`
    );
  }
  runSync('docker', ['rm', backupContainer], env);
  pendingLegacyMigration = null;
  console.log(
    `[demo:full] Finalized pinned GDS migration for ${profile.neo4jContainer}; named data volumes were preserved`
  );
}

function rollbackPendingLegacyMigration(): void {
  if (!pendingLegacyMigration) return;
  const { profile, env, backupContainer } = pendingLegacyMigration;
  if (!dockerContainerExists(backupContainer)) {
    pendingLegacyMigration = null;
    return;
  }
  const backupProvisioning = assertExistingDurableNeo4jIdentity(
    profile,
    env,
    backupContainer
  );
  if (
    backupProvisioning !== 'legacy-auto' ||
    isDockerContainerRunning(backupContainer)
  ) {
    throw new Error(
      `Refusing to roll back unverified Neo4j migration backup ${backupContainer}.`
    );
  }
  if (dockerContainerExists(profile.neo4jContainer)) {
    const replacementProvisioning = assertExistingDurableNeo4jIdentity(profile, env);
    if (replacementProvisioning !== 'pinned') {
      throw new Error(
        `Refusing to remove unverified Neo4j migration replacement ${profile.neo4jContainer}.`
      );
    }
    if (isDockerContainerRunning(profile.neo4jContainer)) {
      runSync('docker', ['stop', '--time', '10', profile.neo4jContainer], env);
    }
    runSync('docker', ['rm', profile.neo4jContainer], env);
  }
  runSync('docker', ['rename', backupContainer, profile.neo4jContainer], env);
  pendingLegacyMigration = null;
  console.log(
    `[demo:full] Restored stopped legacy Neo4j container ${profile.neo4jContainer}; data volumes were preserved`
  );
}

/**
 * Replace only the Docker container configuration inherited from pre-LOCAL-016
 * releases. All four profile-owned named volumes remain mounted and untouched.
 * A stopped, renamed original container is retained until the APOC-only
 * replacement is running with the exact pinned JAR. Any failure removes the
 * replacement and restores the original name, but deliberately leaves the
 * unsafe legacy container stopped rather than invoking its mutable downloader.
 */
function migrateLegacyDurableNeo4jContainer(
  profile: DemoProfileConfig,
  env: EnvMap,
  pluginVolume: string
): void {
  const backupContainer = legacyMigrationBackupName(profile);
  if (dockerContainerExists(backupContainer)) {
    throw new Error(
      `Refusing legacy GDS migration because guarded backup container ${backupContainer} already exists.`
    );
  }

  provisionPinnedGdsArtifact(pluginVolume, env);
  const wasRunning = isDockerContainerRunning(profile.neo4jContainer);
  if (wasRunning) {
    console.log(
      `[demo:full] Stopping ${profile.neo4jContainer} for a data-preserving GDS configuration migration`
    );
    runSync('docker', ['stop', '--time', '30', profile.neo4jContainer], env);
  }
  runSync('docker', ['rename', profile.neo4jContainer, backupContainer], env);
  pendingLegacyMigration = { profile, env, backupContainer };

  try {
    runSync('docker', buildDurableNeo4jCreateArgs(profile, env), env);
    runSync('docker', ['start', profile.neo4jContainer], env);
    if (!hasPinnedGdsArtifactInRunningContainer(profile.neo4jContainer)) {
      throw new Error(
        `replacement container did not retain checksum-pinned GDS ${PINNED_NEO4J_GDS_VERSION}`
      );
    }
    console.log(
      `[demo:full] Staged ${profile.neo4jContainer} on pinned GDS; retaining the stopped migration backup until live runtime verification`
    );
  } catch (error) {
    let rollbackFailure: string | undefined;
    try {
      rollbackPendingLegacyMigration();
    } catch {
      rollbackFailure = 'guarded container rollback failed';
    }
    const detail = error instanceof Error ? error.message : 'unknown migration failure';
    throw new Error(
      `Neo4j legacy GDS configuration migration failed: ${detail}. ` +
        'The named data volumes were not removed and the legacy container was not restarted.' +
        (rollbackFailure ? ` Manual recovery required: ${rollbackFailure}.` : '')
    );
  }
}

function removeRetiredEphemeralNeo4j(
  profile: DemoProfileConfig,
  retiredRuntimeId: string | undefined
): void {
  const container = `${profile.neo4jContainer}-ephemeral`;
  if (dockerContainerExists(container)) {
    shouldRemoveRetiredEphemeralNeo4j({
      profileName: profile.name,
      retiredRuntimeId,
      runtimeLabel: inspectDockerLabel(container, 'com.radarist.local-runtime'),
      ownerLabel: inspectDockerLabel(container, 'com.radarist.owner'),
    });
    runSync('docker', ['rm', '-f', container], {});
  }
  if (!retiredRuntimeId) return;
  const volumePrefix = `${profile.neo4jVolumePrefix}_ephemeral_`;
  for (const volume of listDockerVolumeNames()) {
    if (!volume.startsWith(volumePrefix) || !volume.endsWith('_plugins')) continue;
    const runtimeLabel = inspectDockerVolumeLabel(volume, LOCAL_RUNTIME_DOCKER_LABEL);
    const ownerLabel = inspectDockerVolumeLabel(volume, 'com.radarist.owner');
    if (runtimeLabel === `ephemeral:${profile.name}` && ownerLabel === retiredRuntimeId) {
      runSync('docker', ['volume', 'rm', volume], {});
    }
  }
}

function startEphemeralNeo4j(profile: DemoProfileConfig, env: EnvMap, owner: string): string {
  const container = `${profile.neo4jContainer}-ephemeral`;
  if (dockerContainerExists(container)) {
    throw new Error(`Refusing to replace unretired Neo4j container ${container}.`);
  }
  const ownerSuffix = owner.replace(/^runtime-/, '').slice(-16);
  const pluginVolume = `${profile.neo4jVolumePrefix}_ephemeral_${ownerSuffix}_plugins`;
  const runtimeLabel = `ephemeral:${profile.name}`;
  // Track intended identities before the first mutation so main cleanup can
  // retry an interrupted create/provision/remove path without guessing.
  ephemeralNeo4jContainer = container;
  ephemeralNeo4jOwner = owner;
  ephemeralNeo4jPluginVolume = pluginVolume;
  ephemeralNeo4jRuntimeLabel = runtimeLabel;
  runSync(
    'docker',
    [
      'volume',
      'create',
      '--label',
      `${LOCAL_RUNTIME_DOCKER_LABEL}=${runtimeLabel}`,
      '--label',
      `com.radarist.owner=${owner}`,
      pluginVolume,
    ],
    env
  );
  const pluginVolumeIdentity = inspectDockerVolumeIdentity(pluginVolume);
  if (
    pluginVolumeIdentity.runtimeLabel !== runtimeLabel ||
    pluginVolumeIdentity.driver !== 'local' ||
    pluginVolumeIdentity.scope !== 'local' ||
    !['null', '{}'].includes(pluginVolumeIdentity.optionsJson ?? '') ||
    inspectDockerVolumeLabel(pluginVolume, 'com.radarist.owner') !== owner
  ) {
    throw new Error(
      `Refusing to provision mismatched ephemeral Neo4j plugin volume ${pluginVolume}.`
    );
  }
  try {
    provisionPinnedGdsArtifact(pluginVolume, env);
  } catch (error) {
    runSync('docker', ['volume', 'rm', pluginVolume], env);
    ephemeralNeo4jPluginVolume = null;
    throw error;
  }
  console.log(`[demo:full] Creating disposable Neo4j container ${container}`);
  try {
    runSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        container,
        '--label',
        `${LOCAL_RUNTIME_DOCKER_LABEL}=${runtimeLabel}`,
        '--label',
        `com.radarist.owner=${owner}`,
        '--tmpfs',
        '/data:rw,noexec,nosuid,size=2g',
        '--tmpfs',
        '/logs:rw,noexec,nosuid,size=256m',
        '--tmpfs',
        '/var/lib/neo4j/import:rw,noexec,nosuid,size=256m',
        '-v',
        `${pluginVolume}:/plugins`,
        '-p',
        `127.0.0.1:${profile.neo4j.http}:7474`,
        '-p',
        `127.0.0.1:${profile.neo4j.bolt}:7687`,
        '-e',
        `NEO4J_AUTH=neo4j/${env.NEO4J_PASSWORD}`,
        '-e',
        'NEO4J_server_memory_heap_initial__size=512m',
        '-e',
        'NEO4J_server_memory_heap_max__size=2G',
        '-e',
        'NEO4J_server_memory_pagecache_size=1G',
        '-e',
        'NEO4J_db_transaction_timeout=30s',
        '-e',
        'NEO4J_dbms_security_procedures_unrestricted=apoc.*,gds.*',
        '-e',
        'NEO4J_dbms_security_procedures_allowlist=apoc.*,gds.*',
        '-e',
        'NEO4J_PLUGINS=["apoc"]',
        DURABLE_NEO4J_IMAGE,
      ],
      env
    );
  } catch (error) {
    runSync('docker', ['volume', 'rm', pluginVolume], env);
    ephemeralNeo4jPluginVolume = null;
    throw error;
  }
  return container;
}

function startNeo4j(
  profile: DemoProfileConfig,
  env: EnvMap,
  durabilityMode: 'durable' | 'ephemeral',
  owner: string
): void {
  if (!commandAvailable('docker', ['info'])) {
    throw new Error('Docker Desktop is not running or the Docker daemon is unreachable.');
  }

  if (durabilityMode === 'ephemeral') {
    startEphemeralNeo4j(profile, env, owner);
    return;
  }

  const pluginVolume = `${profile.neo4jVolumePrefix}_plugins`;
  reconcileInterruptedLegacyMigration(profile, env);
  if (dockerContainerExists(profile.neo4jContainer)) {
    const provisioning = assertExistingDurableNeo4jIdentity(profile, env);
    if (provisioning === 'legacy-auto') {
      migrateLegacyDurableNeo4jContainer(profile, env, pluginVolume);
      return;
    }
    const alreadyRunning = isDockerContainerRunning(profile.neo4jContainer);
    if (
      alreadyRunning &&
      !hasPinnedGdsArtifactInRunningContainer(profile.neo4jContainer)
    ) {
      console.log(
        `[demo:full] Stopping ${profile.neo4jContainer} to repair its owned GDS plugin volume`
      );
      runSync('docker', ['stop', '--time', '30', profile.neo4jContainer], env);
    }
    if (!alreadyRunning || !hasPinnedGdsArtifactInRunningContainer(profile.neo4jContainer)) {
      provisionPinnedGdsArtifact(pluginVolume, env);
    }
    if (!isDockerContainerRunning(profile.neo4jContainer)) {
      console.log(`[demo:full] Starting existing Neo4j container ${profile.neo4jContainer}`);
      runSync('docker', ['start', profile.neo4jContainer], env);
    } else {
      console.log(`[demo:full] Reusing running Neo4j container ${profile.neo4jContainer}`);
    }
    return;
  }

  ensureDurableNeo4jVolumes(profile, env);
  provisionPinnedGdsArtifact(pluginVolume, env);
  console.log(`[demo:full] Creating Neo4j container ${profile.neo4jContainer}`);
  runSync('docker', buildDurableNeo4jCreateArgs(profile, env), env);
  runSync('docker', ['start', profile.neo4jContainer], env);
}

function startChild(
  name: string,
  role: Exclude<OwnedLocalProcessIdentity['role'], 'launcher'>,
  command: string,
  args: string[],
  env: EnvMap,
  cwd = process.cwd()
): ChildProcess {
  console.log(`[demo:full] Starting ${name}`);
  const child = spawnManaged(name, command, args, env, { cwd, detached: true });
  children.push({ name, role, child });
  try {
    if (!child.pid) throw new Error(`${name} did not expose an owned PID.`);
    if (!runtimeLifecycle) throw new Error('Local runtime lifecycle was not claimed before spawn.');
    runtimeLifecycle.registerProcess(role, child.pid);
  } catch (error) {
    children.pop();
    signalChildGroup(child, 'SIGKILL');
    throw error;
  }
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    updateRuntimeStatus((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      supervisor: { ...current.supervisor, state: 'degraded', unexpectedExit: true },
    }));
    console.error(
      `[demo:full] ${name} exited unexpectedly (${signal ?? code ?? 'unknown'}); health is degraded.`
    );
  });
  return child;
}

/**
 * LOCAL-012 — what the last cleanup was able to prove.
 *
 * Captured by `performCleanup` and consumed by `shutdown`, which prints it as the
 * final thing an operator sees. The two are separate because cleanup can throw:
 * the receipt has to survive that path, since a failed cleanup is exactly when
 * the operator most needs to be told what was left behind.
 */
let shutdownCheckpointAck: FinalCheckpointAcknowledgement = {
  status: 'skipped',
  detail: 'no checkpoint was attempted',
};
let shutdownProcessCensus: OwnedProcessCensusEntry[] = [];
let shutdownProcessStatus: ShutdownStepStatus = 'skipped';
let shutdownContainerStatus: ShutdownStepStatus = 'skipped';
let shutdownStoppedContainers: string[] = [];
let shutdownStoppedVolumes: string[] = [];
let shutdownResidue: RuntimeResidue = EMPTY_RUNTIME_RESIDUE;

async function performCleanup(): Promise<void> {
  const errors: Error[] = [];
  const capture = (label: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[demo:full] ${label}: ${detail}`);
    errors.push(new Error(`${label}: ${detail}`));
  };
  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = null;
  if (graphHealthTimer) clearInterval(graphHealthTimer);
  graphHealthTimer = null;
  if (runtimeHeartbeatTimer) clearInterval(runtimeHeartbeatTimer);
  runtimeHeartbeatTimer = null;
  if (pendingLegacyMigration) {
    try {
      rollbackPendingLegacyMigration();
    } catch (error) {
      capture('Could not roll back the pending Neo4j GDS migration', error);
    }
  }
  if (persistEnabled && runCheckpoint && firebaseChild && isChildProcessRunning(firebaseChild)) {
    console.log('[demo:full] Creating a final verified checkpoint...');
    // The generation that would survive if this attempt fails, captured BEFORE it
    // runs so a failure can still name what a restart will load.
    const generationBefore = lastVerifiedGeneration?.id;
    try {
      await queueCheckpoint('shutdown');
      // LOCAL-012: acknowledge COMPLETION, not just the attempt. The base tree
      // printed the line above and exited, so an operator could not tell a
      // finished checkpoint from an abandoned one.
      shutdownCheckpointAck = lastVerifiedGeneration
        ? {
            status: 'ok',
            generationId: lastVerifiedGeneration.id,
            manifestSha256: lastVerifiedGeneration.manifestSha256,
          }
        : {
            status: 'failed',
            detail: 'the checkpoint reported success but produced no verified generation',
            ...(generationBefore ? { retainedGenerationId: generationBefore } : {}),
          };
    } catch (error) {
      capture('Final checkpoint failed; an older verified generation remains available', error);
      shutdownCheckpointAck = {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        ...(lastVerifiedGeneration?.id ?? generationBefore
          ? { retainedGenerationId: lastVerifiedGeneration?.id ?? generationBefore }
          : {}),
      };
    }
  } else {
    shutdownCheckpointAck = {
      status: 'skipped',
      detail: persistEnabled
        ? 'the Firebase emulator was not running, so no final checkpoint could be exported'
        : 'durability mode is ephemeral',
    };
  }
  let ownedProcessesStopped = children.length === 0;
  if (runtimeLifecycle) {
    try {
      await runtimeLifecycle.stopOwnedProcesses();
      ownedProcessesStopped = true;
      shutdownProcessStatus = 'ok';
    } catch (error) {
      capture('Could not stop the complete owned process set', error);
      shutdownProcessStatus = 'failed';
    }
    // LOCAL-012: read the census on BOTH paths. On success it acknowledges the
    // teardown; on failure it names the exact pids and groups the supervisor
    // already identified — the detail an operator previously had to hunt for.
    try {
      const report = runtimeLifecycle.describeOwnedProcesses();
      shutdownProcessCensus = report.census;
      shutdownResidue = report.residue;
    } catch (error) {
      // Never let reporting turn a recoverable teardown into a failed one.
      shutdownResidue = {
        ...EMPTY_RUNTIME_RESIDUE,
        reasons: [`owned-process census unavailable: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  } else if (children.length > 0) {
    capture('Could not stop owned processes', new Error('process manifest is unavailable'));
    shutdownProcessStatus = 'failed';
    shutdownResidue = { ...EMPTY_RUNTIME_RESIDUE, reasons: ['the owned-process manifest is unavailable'] };
  }
  let ephemeralContainerStopped = ephemeralNeo4jContainer === null;
  if (ephemeralNeo4jContainer && ephemeralNeo4jOwner) {
    try {
      if (dockerContainerExists(ephemeralNeo4jContainer)) {
        const ownership = inspectDockerLabel(ephemeralNeo4jContainer, 'com.radarist.owner');
        if (ownership !== ephemeralNeo4jOwner) {
          throw new Error(`Refusing to stop unowned Neo4j container ${ephemeralNeo4jContainer}.`);
        }
        console.log(`[demo:full] Stopping disposable Neo4j container ${ephemeralNeo4jContainer}`);
        shutdownStoppedContainers = [ephemeralNeo4jContainer];
        await stopAndRemoveDockerContainer(ephemeralNeo4jContainer, {
          stop: (reference) => {
            runSync('docker', ['stop', '--time', '10', reference], {});
          },
          forceRemove: (reference) => {
            runSync('docker', ['rm', '--force', '--volumes', reference], {});
          },
          exists: dockerContainerExists,
        });
      }
      ephemeralNeo4jContainer = null;
      ephemeralContainerStopped = true;
      shutdownContainerStatus = 'ok';
    } catch (error) {
      capture('Could not remove the disposable Neo4j container', error);
      shutdownContainerStatus = 'failed';
      // Name the container so the operator does not have to find it: a surviving
      // one holds the Bolt port and blocks the next start.
      shutdownResidue = {
        ...shutdownResidue,
        containers: ephemeralNeo4jContainer ? [ephemeralNeo4jContainer] : shutdownResidue.containers,
      };
    }
  } else if (ephemeralNeo4jContainer === null) {
    shutdownContainerStatus = 'skipped';
  }
  if (ephemeralNeo4jPluginVolume && ephemeralNeo4jOwner && ephemeralContainerStopped) {
    try {
      if (!dockerVolumeExists(ephemeralNeo4jPluginVolume)) {
        ephemeralNeo4jPluginVolume = null;
      } else {
        const volumeOwner = inspectDockerVolumeLabel(
          ephemeralNeo4jPluginVolume,
          'com.radarist.owner'
        );
        const runtimeLabel = inspectDockerVolumeLabel(
          ephemeralNeo4jPluginVolume,
          LOCAL_RUNTIME_DOCKER_LABEL
        );
        if (
          volumeOwner !== ephemeralNeo4jOwner ||
          runtimeLabel !== ephemeralNeo4jRuntimeLabel
        ) {
          throw new Error(
            `Refusing to remove unowned Neo4j plugin volume ${ephemeralNeo4jPluginVolume}.`
          );
        }
        runSync('docker', ['volume', 'rm', ephemeralNeo4jPluginVolume], {});
        shutdownStoppedVolumes = [ephemeralNeo4jPluginVolume];
        ephemeralNeo4jPluginVolume = null;
      }
    } catch (error) {
      capture('Could not remove the disposable Neo4j plugin volume', error);
      shutdownContainerStatus = 'failed';
      shutdownResidue = {
        ...shutdownResidue,
        volumes: ephemeralNeo4jPluginVolume ? [ephemeralNeo4jPluginVolume] : shutdownResidue.volumes,
      };
    }
  }
  if (ephemeralNeo4jContainer === null && ephemeralNeo4jPluginVolume === null) {
    ephemeralNeo4jOwner = null;
    ephemeralNeo4jRuntimeLabel = null;
  }
  const ownedResourcesStopped =
    ownedProcessesStopped &&
    ephemeralNeo4jContainer === null &&
    ephemeralNeo4jPluginVolume === null &&
    pendingLegacyMigration === null;
  if (ownedResourcesStopped && runtimeLifecycle) {
    try {
      runtimeLifecycle.finalizeStoppedRuntime();
      runtimeLifecycle = null;
    } catch (error) {
      capture('Could not release the local runtime lease', error);
    }
  }
  if (!persistEnabled && ownedResourcesStopped && runtimePaths && ephemeralExecution) {
    try {
      removeEphemeralLocalRuntimeSession(runtimePaths, ephemeralExecution.sessionRoot);
      ephemeralExecution = null;
    } catch (error) {
      capture('Could not remove the disposable execution workspace', error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Local runtime cleanup was incomplete.');
}

const cleanup = createIdempotentAsyncAction(performCleanup);

let shuttingDown = false;
async function shutdown(code: number, signal = 'exit'): Promise<void> {
  // Re-entrancy guard: a second Ctrl+C must not re-run cleanup and re-signal the
  // Firebase emulator mid-export (which would make it abandon the export).
  if (shuttingDown) {
    console.log('[demo:full] Already shutting down — please wait...');
    return;
  }
  shuttingDown = true;
  try {
    await cleanup();
  } catch (error) {
    console.error('[demo:full] Cleanup failed:', error instanceof Error ? error.message : String(error));
    if (code === 0) code = 1;
  }

  // LOCAL-012 — acknowledge before exiting.
  //
  // This is the last thing the operator sees, and it exists because the base tree
  // announced a final checkpoint and then exited: nothing confirmed the checkpoint
  // landed, nothing named the children, and four surviving process groups had to
  // be found by hand. The receipt is printed on EVERY path, including a failed
  // cleanup, because that is when it matters most.
  try {
    const acknowledgement = buildShutdownAcknowledgement({
      signal,
      exitCode: code,
      checkpoint: shutdownCheckpointAck,
      processes: { status: shutdownProcessStatus, census: shutdownProcessCensus },
      containers: {
        status: shutdownContainerStatus,
        stoppedContainers: shutdownStoppedContainers,
        stoppedVolumes: shutdownStoppedVolumes,
      },
      residue: shutdownResidue,
    });
    for (const line of formatShutdownAcknowledgement(acknowledgement)) {
      console.log(`[demo:full] ${line}`);
    }
    // A shutdown that left residue must not exit 0 and read as success to a
    // supervising script.
    if (!acknowledgement.clean && code === 0) code = 1;
  } catch (error) {
    console.error(
      '[demo:full] Could not assemble the shutdown acknowledgement:',
      error instanceof Error ? error.message : String(error)
    );
    if (code === 0) code = 1;
  }

  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130, 'SIGINT'));
process.on('SIGTERM', () => void shutdown(143, 'SIGTERM'));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { profile, seedMode, durabilityMode, devMode, skipInngest } =
    parseDemoFullOptions(args);
  const repositoryRoot = process.cwd();
  persistEnabled = durabilityMode === 'durable';

  const selectedRuntimePaths = deriveLocalRuntimePaths(
    repositoryRoot,
    profile.name,
    resolveLocalRuntimeDataRoot(repositoryRoot, process.env)
  );
  if (durabilityMode === 'durable') assertFirebaseOnlyResetMarkerAbsent(selectedRuntimePaths);
  runtimePaths = ensurePrivateLocalRuntimeLayout(selectedRuntimePaths);
  const startedAt = new Date().toISOString();
  const runtimeId = `runtime-${randomBytes(16).toString('hex')}`;
  runtimeLifecycle = await LocalRuntimeLifecycle.claim({
    paths: runtimePaths,
    runtimeId,
    acquiredAt: startedAt,
  });
  removeRetiredEphemeralNeo4j(profile, runtimeLifecycle.retiredRuntimeId);
  await assertProductPortsAvailable(
    profile,
    skipInngest,
    durabilityMode === 'ephemeral' || !dockerContainerExists(profile.neo4jContainer)
  );
  if (durabilityMode === 'ephemeral') {
    removeStaleEphemeralLocalRuntimeSessions(runtimePaths);
  }

  if (!existsSync(resolve(process.cwd(), profile.envFile))) {
    console.log(`[demo:full] ${profile.envFile} missing — generating it (same as npm run setup:local)`);
  }
  const env = ensureDemoEnvFile(profile).env;
  assertOptionalAgentRuntimePreflight(env, repositoryRoot);
  ephemeralExecution =
    durabilityMode === 'ephemeral'
      ? createEphemeralLocalRuntimeExecutionContext(runtimePaths, envForChild(env), runtimeId)
      : null;
  const context =
    ephemeralExecution?.context ?? buildLocalRuntimeExecutionContext(runtimePaths, envForChild(env));
  const runtimeEnv = Object.fromEntries(
    Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const statusFile = join(runtimePaths.status, 'health.json');
  Object.assign(runtimeEnv, {
    RADARIST_LOCAL_RUNTIME_STATUS_FILE: statusFile,
    FIREBASE_EMULATOR_HUB: `127.0.0.1:${profile.firebase.hub}`,
    FIREBASE_EMULATOR_LOGGING: `127.0.0.1:${profile.firebase.logging}`,
    // LOCAL-013: identity of THIS runtime, stamped onto every job-run at start.
    // Interrupted-run recovery reads it to tell work this runtime owns from
    // work a previous runtime left behind.
    [LOCAL_RUNTIME_EPOCH_ENV]: runtimeId,
  });
  if (!devMode) {
    // `next start` requires the normal production-server artifact. Keep this
    // flag in the shared child environment so build and serve cannot disagree.
    runtimeEnv.RADARIST_LOCAL_PRODUCTION_BUILD = 'true';
  }
  runtimeStatus = {
    schemaVersion: 1,
    profile: profile.name,
    projectId: profile.projectId,
    startedAt,
    updatedAt: startedAt,
    supervisor: { state: 'starting', unexpectedExit: false, orphanCount: 0 },
    checkpoint: {
      state: persistEnabled ? 'pending' : 'ephemeral',
    },
  };
  writeRuntimeStatus();
  runtimeHeartbeatTimer = setInterval(() => {
    try {
      const ownership = runtimeLifecycle?.inspectOwnership();
      if (!ownership) throw new Error('Local runtime lifecycle is unavailable.');
      updateRuntimeStatus((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        supervisor: {
          ...current.supervisor,
          state:
            ownership.ambiguous || ownership.orphanCount > 0
              ? 'degraded'
              : current.supervisor.state,
          orphanCount: ownership.orphanCount,
        },
      }));
    } catch (error) {
      console.error(
        '[demo:full] Runtime heartbeat failed:',
        error instanceof Error ? error.message : String(error)
      );
      void shutdown(1);
    }
  }, 15_000);
  runtimeHeartbeatTimer.unref();
  if (process.platform !== 'darwin') {
    console.warn(
      `[demo:full] Mac-first script running on ${process.platform}; WSL2/Linux may work but is not primary.`
    );
  }

  if (!commandAvailable('java', ['-version'])) {
    throw new Error('Java is required for Firebase emulators. Install a JDK before running demo:full.');
  }

  if (!devMode) {
    console.log('[demo:full] Building the production workspace (use --dev only for HMR).');
    await runCommand('npm', ['run', 'build'], runtimeEnv, { cwd: repositoryRoot });
  }

  let importPath: string | undefined;
  let restoredAuthEmails: readonly string[] | undefined;
  if (persistEnabled) {
    const recovery = await prepareFirebaseCheckpointRecovery({
      profileRoot: runtimePaths.checkpoints,
      profile: profile.name,
      projectId: profile.projectId,
    });
    if (recovery.selected) {
      importPath = recovery.selected.path;
    } else if (recovery.invalidCandidates.length > 0 || recovery.interruptedStages.length > 0) {
      throw new Error('No valid Firebase checkpoint remains; corrupt candidates were quarantined.');
    } else if (existsSync(join(runtimePaths.root, 'firebase-export-metadata.json'))) {
      throw new Error(
        'Found an unhashed legacy Firebase export. It was left untouched, but automatic recovery is refused because its file inventory cannot be verified. ' +
          'Back it up and migrate it into a verified checkpoint generation before starting this profile.'
      );
    }
  }

  // Validate and quarantine Firebase recovery candidates before starting or
  // schema-mutating Neo4j. A corrupt Firebase workspace must fail without
  // changing the separately durable graph.
  startNeo4j(profile, runtimeEnv, durabilityMode, runtimeLifecycle.runtimeId);
  await waitForHttp(`http://127.0.0.1:${profile.neo4j.http}`, 120_000, {
    attemptTimeoutMs: 2_000,
    pollIntervalMs: 500,
    assertWaitingStillValid: () => {
      const container =
        durabilityMode === 'ephemeral'
          ? `${profile.neo4jContainer}-ephemeral`
          : profile.neo4jContainer;
      if (!isDockerContainerRunning(container)) {
        throw new Error(
          `Neo4j container ${container} exited before HTTP readiness. ` +
            `Inspect \`docker logs --tail 250 ${container}\` for the startup failure.`
        );
      }
    },
  });
  let gdsVersion: string;
  try {
    gdsVersion = await waitForNeo4jGdsReadiness(runtimeEnv, {
      timeoutMs: 60_000,
      attemptTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Neo4j started, but its required GDS plugin is unavailable: ${detail}. ` +
        `Inspect \`docker logs --tail 250 ${profile.neo4jContainer}\` for the plugin download/load failure. ` +
        'The launcher will not start Firebase, Next.js, or Inngest against an incomplete graph runtime.'
    );
  }
  if (gdsVersion !== PINNED_NEO4J_GDS_VERSION) {
    throw new Error(
      `Neo4j loaded unsupported GDS ${gdsVersion}; expected the checksum-pinned ` +
        `${PINNED_NEO4J_GDS_VERSION}. Refusing to start dependent services.`
    );
  }
  console.log(`[demo:full] Neo4j GDS ${gdsVersion} is ready.`);
  const graphUserNodeCount = await countNeo4jUserDataNodes(runtimeEnv);
  assertFreshFirebaseGraphCompatibility({
    durabilityMode,
    firebaseImportPath: importPath,
    graphUserNodeCount,
  });
  finalizePendingLegacyMigration();
  await runCommand('npx', ['tsx', 'scripts/init-neo4j-schema.ts'], runtimeEnv, {
    cwd: repositoryRoot,
  });

  const firebaseConfigPath = writeFirebaseEmulatorConfig(
    profile,
    ephemeralExecution?.paths ?? runtimePaths
  );
  const emulatorArgs = [
    'firebase',
    'emulators:start',
    '--project',
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    '--config',
    firebaseConfigPath,
    '--only',
    'firestore,auth,storage',
  ];
  if (importPath) {
    emulatorArgs.push('--import', importPath);
    console.log('[demo:full] Restoring the newest verified Firebase workspace checkpoint.');
  }
  firebaseChild = startChild(
    'Firebase emulators',
    'firebase',
    'npx',
    emulatorArgs,
    runtimeEnv,
    context.cwd
  );
  await waitForTcp('127.0.0.1', profile.firebase.firestore, 90_000);
  await waitForTcp('127.0.0.1', profile.firebase.auth, 90_000);
  await waitForTcp('127.0.0.1', profile.firebase.storage, 90_000);
  await waitForTcp('127.0.0.1', profile.firebase.hub, 90_000);
  runtimeLifecycle.refreshProcess(firebaseChild.pid!);

  if (importPath) {
    await clearRestoredCheckpointBarrier(
      runtimeEnv.FIRESTORE_EMULATOR_HOST,
      profile.projectId,
      profile.name
    );
    console.log('[demo:full] Restored state is authoritative; startup mode will not reseed it.');
    // Restored Auth accounts are whatever the checkpoint captured. Inspect
    // them so the startup banner can never advertise a login this profile
    // lacks. A failed inspection degrades to an explicitly unknown banner
    // rather than failing the launch or repeating the seeded-path claim.
    try {
      restoredAuthEmails = await listLocalAuthAccountEmails(
        runtimeEnv.FIREBASE_AUTH_EMULATOR_HOST,
        profile.projectId
      );
    } catch (error) {
      restoredAuthEmails = undefined;
      console.warn(
        '[demo:full] Could not inspect restored Auth accounts:',
        error instanceof Error ? error.message : String(error)
      );
    }
  } else {
    await runCommand(
      'npx',
      ['tsx', 'scripts/seed-auth-emulator.ts', '--profile', profile.name],
      runtimeEnv,
      { cwd: repositoryRoot }
    );
    if (seedMode === 'showcase') {
      await runCommand(
        'npx',
        ['tsx', 'scripts/seed-showcase.ts', '--profile', profile.name],
        runtimeEnv,
        { cwd: repositoryRoot }
      );
    } else {
      console.log('[demo:full] Blank mode: local operator auth created; no showcase entities seeded.');
    }
  }

  const appLaunch = buildDemoAppLaunchPlan(profile, devMode);
  const nextChild = startChild(
    'Next.js',
    'next',
    appLaunch.command,
    appLaunch.args,
    runtimeEnv,
    repositoryRoot
  );
  await waitForHttp(`http://127.0.0.1:${profile.appPort}/api/health?shallow=true`, 120_000);
  runtimeLifecycle.refreshProcess(nextChild.pid!);

  if (!skipInngest) {
    // LOCAL-013: `--persist` keeps the queue across restarts, and the plan's
    // profile-contained cwd is what keeps that persisted state private, since
    // the dev server writes it relative to its working directory.
    // Ephemeral runs get a session-private tree; use whichever layout the rest
    // of this runtime's children were given so the queue cannot land elsewhere.
    const inngestLaunch = buildInngestLaunchPlan(profile, ephemeralExecution?.paths ?? runtimePaths!);
    const inngestChild = startChild(
      'Inngest dev server',
      'inngest',
      inngestLaunch.command,
      inngestLaunch.args,
      runtimeEnv,
      inngestLaunch.cwd
    );
    await waitForTcp('127.0.0.1', profile.inngestPort, 120_000);
    runtimeLifecycle.refreshProcess(inngestChild.pid!);

    console.log(
      `[demo:full] Inngest queue persisted at ${inngestLaunch.statePath} ` +
        `(${inngestLaunch.queueStateCarriedOver ? 'resumed prior state' : 'fresh state'})`
    );

    // Only meaningful once the queue is known not to have carried state over:
    // anything the queue can still resume must not be terminalized.
    if (!inngestLaunch.queueStateCarriedOver) {
      await runCommand(
        'npx',
        ['tsx', 'scripts/recover-interrupted-job-runs.ts', '--profile', profile.name],
        runtimeEnv,
        { cwd: repositoryRoot }
      );
    }
  }

  if (persistEnabled) {
    runCheckpoint = async () => {
      return createFirebaseCheckpoint({
        profileRoot: runtimePaths!.checkpoints,
        profile: profile.name,
        projectId: profile.projectId,
        budget: checkpointBudgetFromEnvironment(runtimeEnv),
        async exportTo(stagePath) {
          const lifecycle = runtimeLifecycle;
          if (!lifecycle) {
            throw new Error('Local runtime lifecycle is unavailable for checkpoint suspension.');
          }
          const store = await createFirestoreCheckpointBarrierStore(
            runtimeEnv.FIRESTORE_EMULATOR_HOST,
            profile.projectId
          );
          const lease = await acquireCheckpointBarrier({
            profile: profile.name,
            store,
            ttlMs: 5 * 60_000,
            drainMs: DEFAULT_CHECKPOINT_DRAIN_MS,
          });
          let pauseToken: LocalRuntimeProcessPauseToken | null = null;
          let exportError: unknown;
          try {
            pauseToken = lifecycle.pauseProcessGroups(CHECKPOINT_WRITER_ROLES);
            // Browser writes have drained before owned server/job groups are
            // suspended, so accepted work can finish instead of being frozen
            // during the drain window.
            await runCommand(
              'npx',
              [
                'firebase',
                'emulators:export',
                stagePath,
                '--project',
                profile.projectId,
                '--config',
                firebaseConfigPath,
                '--force',
              ],
              runtimeEnv,
              { cwd: context.cwd, timeoutMs: 4 * 60_000 }
            );
          } catch (error) {
            exportError = error;
          }
          const cleanupErrors: Error[] = [];
          try {
            if (pauseToken) lifecycle.resumeProcessGroups(pauseToken);
            else lifecycle.recoverPausedProcessGroups();
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
          try {
            await lease.release();
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
          if (exportError !== undefined) {
            cleanupErrors.unshift(
              exportError instanceof Error ? exportError : new Error(String(exportError))
            );
          }
          if (cleanupErrors.length === 1) throw cleanupErrors[0];
          if (cleanupErrors.length > 1) {
            throw new AggregateError(cleanupErrors, 'Checkpoint export cleanup was incomplete.');
          }
        },
      });
    };
    checkpointTimer = setInterval(
      () => void queueCheckpoint('ten-minute schedule').catch(() => undefined),
      resolveCheckpointIntervalMs(process.env)
    );
    checkpointTimer.unref();
  }

  updateRuntimeStatus((current) => ({
    ...current,
    updatedAt: new Date().toISOString(),
    supervisor: { ...current.supervisor, state: 'running' },
  }));
  await requireInitialGraphAudit(() =>
    runGraphConsistencyAudit(runtimeEnv, 'propagate')
  );
  graphHealthTimer = setInterval(
    () => void runGraphConsistencyAudit(runtimeEnv, 'degrade'),
    15 * 60_000
  );
  graphHealthTimer.unref();
  if (persistEnabled) await queueCheckpoint('startup baseline');
  const healthUrl = `http://127.0.0.1:${profile.appPort}/api/health`;
  if (skipInngest) {
    // `--skip-inngest` intentionally reports degraded health. It is ready when
    // the bounded endpoint responds without a server failure.
    await waitForHttp(healthUrl, 120_000);
  } else {
    await waitForHealthyLocalRuntime(healthUrl, 120_000);
  }

  console.log('');
  console.log(`[demo:full] Local ${seedMode} workspace is running.`);
  console.log(`  App:           http://localhost:${profile.appPort}`);
  const login = describeLocalLogin({
    seeded: !importPath,
    expectedEmail: env.E2E_USER_EMAIL,
    expectedPassword: env.E2E_USER_PASSWORD,
    restoredEmails: restoredAuthEmails,
  });
  console.log(`  Login:         ${login.line}`);
  console.log(`  Firebase UI:   http://localhost:${profile.firebase.ui}`);
  console.log(`  Neo4j Browser: http://localhost:${profile.neo4j.http}`);
  if (!skipInngest) console.log(`  Inngest UI:    http://localhost:${profile.inngestPort}`);
  const durability = persistEnabled
    ? describeCheckpointContract(resolveCheckpointIntervalMs(process.env))
    : 'ephemeral (discarded on exit)';
  console.log(`  Firebase:      ${durability}`);
  console.log(`  App mode:      ${devMode ? 'development/HMR' : 'production build'}`);
  console.log('');
  console.log('[demo:full] Press Ctrl+C for bounded cleanup. Neo4j stays running for durable reuse.');

  await new Promise(() => undefined);
}

main().catch(async (error) => {
  // Cleanup intentionally terminates every owned child. Mark teardown before
  // signalling them so their exit(0) events are never reported as crashes.
  shuttingDown = true;
  console.error('[demo:full] Failed:', error instanceof Error ? error.message : String(error));
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error(
      '[demo:full] Cleanup after startup failure was incomplete:',
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    );
  }
  process.exit(1);
});
