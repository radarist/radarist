#!/usr/bin/env npx tsx
/**
 * Run the Firebase emulators as a profile-owned local workspace.
 *
 * Durable mode is the default: restore the newest verified generation, create
 * an initial checkpoint, checkpoint every ten minutes, and checkpoint once
 * more before a clean shutdown. `--ephemeral` starts from a fresh private temp
 * directory and never reads or writes durable generations.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INITIAL_CHECKPOINT_SCHEDULER_STATE,
  finishCheckpoint,
  requestCheckpoint,
  type CheckpointSchedulerState,
} from './lib/firebase-checkpoints';
import {
  resolveCheckpointIntervalMs,
  checkpointBudgetFromEnvironment,
  createFirebaseCheckpoint,
  prepareFirebaseCheckpointRecovery,
} from './lib/firebase-checkpoint-runtime';
import {
  acquireCheckpointBarrier,
  clearRestoredCheckpointBarrier,
  createFirestoreCheckpointBarrierStore,
} from './lib/local-checkpoint-barrier';
import {
  buildLocalRuntimeExecutionContext,
  createEphemeralLocalRuntimeExecutionContext,
  deriveLocalRuntimePaths,
  resolveLocalRuntimeDataRoot,
  ensurePrivateLocalRuntimeLayout,
  parseLocalRuntimeProfileArg,
  removeEphemeralLocalRuntimeSession,
  removeStaleEphemeralLocalRuntimeSessions,
  type LocalRuntimePaths,
  type LocalRuntimeProfile,
  type LocalRuntimePortName,
  type LocalRuntimePortProbe,
} from './lib/local-runtime-profile';
import { assertFirebaseOnlyResetMarkerAbsent } from './lib/local-reset-marker';
import { LocalRuntimeLifecycle } from './lib/local-runtime-lifecycle';
import { DEMO_PROFILES, isTcpOpen, waitForTcp, writeFirebaseEmulatorConfig } from './lib/local-demo';

export type StandalonePersistenceMode = 'durable' | 'ephemeral';

export interface StandalonePersistenceOptions {
  profile: LocalRuntimeProfile;
  mode: StandalonePersistenceMode;
}

export interface StandaloneFirebaseLaunchPlan {
  command: 'npx';
  args: string[];
  importPath?: string;
}

export const STANDALONE_FIREBASE_PORT_NAMES = [
  'firebaseUi',
  'firebaseFirestoreWebsocket',
  'firebaseHub',
  'firebaseLogging',
  'firestore',
  'auth',
  'storage',
] as const satisfies readonly LocalRuntimePortName[];
export const STANDALONE_RESERVED_PORT_NAMES = [
  ...STANDALONE_FIREBASE_PORT_NAMES,
  'app',
  'inngest',
] as const satisfies readonly LocalRuntimePortName[];

export interface StandaloneRuntimeOwnership {
  readonly runtimeId: string;
  registerProcess(role: 'firebase', pid: number): void;
  refreshProcess(pid: number): void;
  stopOwnedProcesses(): Promise<void>;
  finalizeStoppedRuntime(): void;
}

export interface StandaloneRuntimeOwnershipDependencies {
  readonly claim: (input: {
    paths: LocalRuntimePaths;
    runtimeId: string;
    acquiredAt: string;
  }) => Promise<StandaloneRuntimeOwnership>;
  readonly assertPorts: (profile: LocalRuntimeProfile) => Promise<void>;
}

export async function prepareStandaloneRuntimeOwnership(
  input: {
    paths: LocalRuntimePaths;
    profile: LocalRuntimeProfile;
    runtimeId: string;
    acquiredAt: string;
  },
  dependencies: Partial<StandaloneRuntimeOwnershipDependencies> = {}
): Promise<StandaloneRuntimeOwnership> {
  const claim = dependencies.claim ?? ((claimInput) => LocalRuntimeLifecycle.claim(claimInput));
  const assertPorts = dependencies.assertPorts ?? assertStandaloneFirebasePortsAvailable;
  const lifecycle = await claim({
    paths: input.paths,
    runtimeId: input.runtimeId,
    acquiredAt: input.acquiredAt,
  });
  try {
    await assertPorts(input.profile);
    return lifecycle;
  } catch (error) {
    await lifecycle.stopOwnedProcesses();
    lifecycle.finalizeStoppedRuntime();
    throw error;
  }
}

const EXPORT_TIMEOUT_MS = 4 * 60_000;

function optionName(argument: string): string {
  return argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
}

export function parseStandalonePersistenceOptions(args: readonly string[]): StandalonePersistenceOptions {
  const profile = parseLocalRuntimeProfileArg(args);
  const mode: StandalonePersistenceMode = args.includes('--ephemeral') ? 'ephemeral' : 'durable';
  const allowed = new Set(['--profile', '--ephemeral']);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = optionName(argument);
    if (!allowed.has(name)) {
      throw new Error(
        `Unsupported option "${argument}". This runner accepts only --profile default|selftest and --ephemeral.`
      );
    }
    if (name === '--profile' && argument === '--profile') index += 1;
  }

  if (args.filter((argument) => argument === '--ephemeral').length > 1) {
    throw new Error('Specify --ephemeral at most once.');
  }
  return { profile, mode };
}

export async function findOccupiedStandaloneFirebasePorts(
  profile: LocalRuntimeProfile,
  probe: LocalRuntimePortProbe = isTcpOpen
): Promise<Array<{ name: LocalRuntimePortName; port: number }>> {
  const occupied = await Promise.all(
    STANDALONE_FIREBASE_PORT_NAMES.map(async (name) => ({
      name,
      port: profile.ports[name],
      occupied: await probe('127.0.0.1', profile.ports[name]),
    }))
  );
  return occupied.filter((claim) => claim.occupied).map(({ name, port }) => ({ name, port }));
}

export async function assertStandaloneFirebasePortsAvailable(
  profile: LocalRuntimeProfile,
  probe: LocalRuntimePortProbe = isTcpOpen
): Promise<void> {
  const occupied = await Promise.all(
    STANDALONE_RESERVED_PORT_NAMES.map(async (name) => ({
      name,
      port: profile.ports[name],
      occupied: await probe('127.0.0.1', profile.ports[name]),
    }))
  ).then((claims) => claims.filter((claim) => claim.occupied));
  if (occupied.length === 0) return;
  throw new Error(
    `Refusing to start profile ${profile.name}; owned Firebase or writer ports are already in use: ${occupied
      .map(({ name, port }) => `${name}:${port}`)
      .join(', ')}.`
  );
}

export function buildStandaloneFirebaseEnvironment(
  profile: LocalRuntimeProfile,
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...source,
    GCLOUD_PROJECT: profile.projectId,
    GOOGLE_CLOUD_PROJECT: profile.projectId,
    FIREBASE_PROJECT_ID: profile.projectId,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: profile.projectId,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${profile.ports.firestore}`,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${profile.ports.auth}`,
    FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${profile.ports.storage}`,
  };
}

export function buildStandaloneFirebaseLaunchPlan(input: {
  profile: LocalRuntimeProfile;
  configPath: string;
  importPath?: string;
}): StandaloneFirebaseLaunchPlan {
  const args = [
    'firebase',
    'emulators:start',
    '--project',
    input.profile.projectId,
    '--config',
    resolve(input.configPath),
    '--only',
    'firestore,auth,storage',
  ];
  if (input.importPath) args.push('--import', resolve(input.importPath));
  return { command: 'npx', args, importPath: input.importPath && resolve(input.importPath) };
}

export class StandaloneCheckpointQueue {
  private state: CheckpointSchedulerState = { ...INITIAL_CHECKPOINT_SCHEDULER_STATE };
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly checkpoint: () => Promise<void>,
    private readonly now: () => Date = () => new Date()
  ) {}

  request(reason: string): Promise<void> {
    const request = requestCheckpoint(this.state, this.now().toISOString());
    this.state = request.state;
    if (request.action === 'coalesced') {
      console.log(`[emulators:persist] Coalesced checkpoint request (${reason}).`);
      return this.inFlight ?? Promise.resolve();
    }

    this.inFlight = (async () => {
      let failure: unknown;
      let continueRunning = true;
      while (continueRunning) {
        try {
          await this.checkpoint();
        } catch (error) {
          failure ??= error;
        }
        const finished = finishCheckpoint(this.state, this.now().toISOString());
        this.state = finished.state;
        continueRunning = finished.action === 'start-coalesced';
      }
      if (failure) throw failure;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  snapshot(): CheckpointSchedulerState {
    return { ...this.state };
  }
}

function buildEphemeralEnvironment(
  paths: LocalRuntimePaths,
  source: NodeJS.ProcessEnv,
  pid: number
): ReturnType<typeof createEphemeralLocalRuntimeExecutionContext> {
  return createEphemeralLocalRuntimeExecutionContext(paths, source, String(pid));
}

export function removeStaleEphemeralSessions(paths: LocalRuntimePaths): string[] {
  return removeStaleEphemeralLocalRuntimeSessions(paths);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, 'SIGTERM');
      forceTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 5_000);
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code === 0 && !timedOut) resolvePromise();
      else if (timedOut) reject(new Error(`${command} ${args.join(' ')} timed out.`));
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code ?? 'unknown'}.`));
    });
  });
}

export function isStandaloneChildRunning(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || !isStandaloneChildRunning(child)) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { profile, mode } = parseStandalonePersistenceOptions(args);
  const repositoryRoot = process.cwd();
  const selectedPaths = deriveLocalRuntimePaths(
    repositoryRoot,
    profile.name,
    resolveLocalRuntimeDataRoot(repositoryRoot, process.env)
  );
  if (mode === 'durable') assertFirebaseOnlyResetMarkerAbsent(selectedPaths);
  const paths = ensurePrivateLocalRuntimeLayout(selectedPaths);
  const lifecycle = await prepareStandaloneRuntimeOwnership({
    paths,
    profile,
    runtimeId: `runtime-${randomBytes(16).toString('hex')}`,
    acquiredAt: new Date().toISOString(),
  });
  let lifecycleFinalized = false;

  try {
    removeStaleEphemeralSessions(paths);

    const privateContext = buildLocalRuntimeExecutionContext(paths, process.env);
    const baseEnvironment = buildStandaloneFirebaseEnvironment(profile, privateContext.env);
    const ephemeralExecution =
      mode === 'ephemeral' ? buildEphemeralEnvironment(paths, baseEnvironment, process.pid) : undefined;
    // Durable mode must run on the Firebase-aware environment too (TEST-024
    // scheduler soak): the checkpoint barrier and export read
    // FIRESTORE_EMULATOR_HOST from this env, and `privateContext.env` lacks
    // it — every durable checkpoint then dies on `host.trim()` of undefined.
    const runtimeContext = ephemeralExecution?.context ?? {
      cwd: privateContext.cwd,
      env: baseEnvironment,
    };
    const runtimeEnvironment = runtimeContext.env;
    const configPath = writeFirebaseEmulatorConfig(DEMO_PROFILES[profile.name], ephemeralExecution?.paths ?? paths);

    let importPath: string | undefined;
    if (mode === 'durable') {
      const recovery = await prepareFirebaseCheckpointRecovery({
        profileRoot: paths.checkpoints,
        profile: profile.name,
        projectId: profile.projectId,
      });
      importPath = recovery.selected?.path;
      if (!importPath && (recovery.invalidCandidates.length > 0 || recovery.interruptedStages.length > 0)) {
        throw new Error('No valid Firebase checkpoint remains; corrupt candidates were quarantined.');
      }
    }

    const launch = buildStandaloneFirebaseLaunchPlan({ profile, configPath, importPath });
    console.log(
      `[emulators:persist] Starting ${profile.name} (${mode}) on Firestore ${profile.ports.firestore}, Auth ${profile.ports.auth}, Storage ${profile.ports.storage}.`
    );
    if (importPath) console.log('[emulators:persist] Restoring the newest verified checkpoint.');
    if (mode === 'ephemeral') {
      console.log('[emulators:persist] Ephemeral mode starts empty and will not touch durable checkpoints.');
    }

    const firebase = spawn(launch.command, launch.args, {
      cwd: runtimeContext.cwd,
      env: runtimeEnvironment,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    try {
      if (!firebase.pid) throw new Error('Firebase emulator spawn did not expose an owned PID.');
      lifecycle.registerProcess('firebase', firebase.pid);
    } catch (error) {
      if (firebase.pid) {
        try {
          if (process.platform === 'win32') firebase.kill('SIGKILL');
          else process.kill(-firebase.pid, 'SIGKILL');
        } catch (signalError) {
          if ((signalError as NodeJS.ErrnoException).code !== 'ESRCH') throw signalError;
        }
      }
      throw error;
    }
    const firebaseExit = new Promise<{ code: number; error?: Error }>((resolvePromise) => {
      firebase.once('error', (error) => resolvePromise({ code: 1, error }));
      firebase.once('exit', (code, signal) => {
        resolvePromise({
          code: code ?? 1,
          error: code === 0 ? undefined : new Error(`Firebase emulators exited with ${signal ?? code ?? 'unknown'}.`),
        });
      });
    });

    let scheduler: StandaloneCheckpointQueue | undefined;
    let interval: NodeJS.Timeout | undefined;
    let shuttingDown = false;
    let shutdownInFlight: Promise<void> | null = null;
    const shutdown = (initialExitCode: number): Promise<void> => {
      if (shuttingDown) {
        console.log('[emulators:persist] Shutdown already in progress; please wait.');
        return shutdownInFlight ?? Promise.resolve();
      }
      shuttingDown = true;
      shutdownInFlight = (async () => {
        let exitCode = initialExitCode;
        if (interval) clearInterval(interval);
        if (scheduler && isStandaloneChildRunning(firebase)) {
          console.log('[emulators:persist] Creating final verified checkpoint.');
          try {
            await scheduler.request('clean shutdown');
          } catch (error) {
            console.error(
              '[emulators:persist] Final checkpoint failed; older verified generations remain recoverable:',
              error instanceof Error ? error.message : String(error)
            );
            exitCode = 1;
          }
        }
        try {
          await lifecycle.stopOwnedProcesses();
          lifecycle.finalizeStoppedRuntime();
          lifecycleFinalized = true;
        } catch (error) {
          console.error(
            '[emulators:persist] Owned process cleanup failed:',
            error instanceof Error ? error.message : String(error)
          );
          exitCode = 1;
        }
        if (ephemeralExecution && lifecycleFinalized) {
          removeEphemeralLocalRuntimeSession(paths, ephemeralExecution.sessionRoot);
        }
        process.exitCode = exitCode;
      })();
      return shutdownInFlight;
    };

    const onInterrupt = () => void shutdown(130);
    const onTerminate = () => void shutdown(143);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    try {
      await Promise.race([
        Promise.all(STANDALONE_FIREBASE_PORT_NAMES.map((name) => waitForTcp('127.0.0.1', profile.ports[name], 90_000))),
        firebaseExit.then(({ error }) => {
          throw error ?? new Error('Firebase emulators exited during startup.');
        }),
      ]);
      lifecycle.refreshProcess(firebase.pid!);

      if (importPath) {
        await clearRestoredCheckpointBarrier(
          runtimeEnvironment.FIRESTORE_EMULATOR_HOST!,
          profile.projectId,
          profile.name
        );
      }

      if (mode === 'durable') {
        scheduler = new StandaloneCheckpointQueue(async () => {
          const checkpoint = await createFirebaseCheckpoint({
            profileRoot: paths.checkpoints,
            profile: profile.name,
            projectId: profile.projectId,
            budget: checkpointBudgetFromEnvironment(runtimeEnvironment),
            async exportTo(stagePath) {
              const store = await createFirestoreCheckpointBarrierStore(
                runtimeEnvironment.FIRESTORE_EMULATOR_HOST!,
                profile.projectId
              );
              const lease = await acquireCheckpointBarrier({
                profile: profile.name,
                store,
                ttlMs: 5 * 60_000,
              });
              try {
                await runCommand(
                  'npx',
                  [
                    'firebase',
                    'emulators:export',
                    stagePath,
                    '--project',
                    profile.projectId,
                    '--config',
                    configPath,
                    '--force',
                  ],
                  {
                    cwd: runtimeContext.cwd,
                    env: runtimeEnvironment,
                    timeoutMs: EXPORT_TIMEOUT_MS,
                  }
                );
              } finally {
                await lease.release();
              }
            },
          });
          console.log(`[emulators:persist] Verified ${checkpoint.manifest.kind} checkpoint ${checkpoint.id}.`);
        });
        await scheduler.request('startup baseline');
        interval = setInterval(() => {
          void scheduler!.request('ten-minute schedule').catch((error) => {
            console.error(
              '[emulators:persist] Scheduled checkpoint failed:',
              error instanceof Error ? error.message : String(error)
            );
          });
        }, resolveCheckpointIntervalMs(process.env));
      }

      const result = await firebaseExit;
      if (shuttingDown) {
        await shutdownInFlight;
      } else {
        if (interval) clearInterval(interval);
        await lifecycle.stopOwnedProcesses();
        lifecycle.finalizeStoppedRuntime();
        lifecycleFinalized = true;
        if (ephemeralExecution) {
          removeEphemeralLocalRuntimeSession(paths, ephemeralExecution.sessionRoot);
        }
        process.exitCode = result.code;
        if (result.error) throw result.error;
      }
    } catch (error) {
      if (shuttingDown) {
        await shutdownInFlight;
        return;
      }
      await shutdown(1);
      throw error;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
  } catch (error) {
    if (!lifecycleFinalized) {
      try {
        await lifecycle.stopOwnedProcesses();
        lifecycle.finalizeStoppedRuntime();
        lifecycleFinalized = true;
      } catch (cleanupError) {
        throw new AggregateError(
          [
            error instanceof Error ? error : new Error(String(error)),
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          ],
          'Standalone runtime failed and lifecycle cleanup was incomplete.'
        );
      }
    }
    throw error;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[emulators:persist] Fatal:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
