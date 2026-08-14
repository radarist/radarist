#!/usr/bin/env npx tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const GENERIC_E2E_OWNED_PORTS = Object.freeze([9002, 9099, 8080, 9199, 4400, 4500]);

export type RuntimeSignal = 'SIGINT' | 'SIGTERM';
type StopSignal = 'SIGTERM' | 'SIGKILL';

type SupervisorError = Error & { exitCode?: number };

export interface ProcessGroupControls {
  readonly groupExists: (processGroupId: number) => boolean;
  readonly signalGroup: (processGroupId: number, signal: StopSignal) => void;
  readonly wait: (milliseconds: number) => Promise<void>;
}

function defaultPortIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export async function assertGenericOwnedPortsFree(
  phase: 'before launch' | 'after cleanup',
  portIsListening: (port: number) => Promise<boolean> = defaultPortIsListening,
  ports: readonly number[] = GENERIC_E2E_OWNED_PORTS
): Promise<void> {
  const states = await Promise.all(
    ports.map(async (port) => ({ port, listening: await portIsListening(port) }))
  );
  const occupied = states.filter(({ listening }) => listening).map(({ port }) => port);
  if (occupied.length > 0) {
    throw new Error(`Generic E2E owned ports occupied ${phase}: ${occupied.join(', ')}`);
  }
}

function defaultGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function defaultSignalGroup(processGroupId: number, signal: StopSignal): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export interface GenericRuntimeInterruptController {
  readonly firstSignal: () => RuntimeSignal | undefined;
  readonly handle: (signal: RuntimeSignal) => void;
}

/**
 * Start the normal bounded cleanup on the first interrupt. A second operator
 * interrupt is an explicit request to skip the grace window, so it kills only
 * the detached process group owned by this supervisor.
 */
export function createGenericRuntimeInterruptController(options: {
  readonly processGroupId: () => number | undefined;
  readonly requestCleanup: () => Promise<void>;
  readonly signalGroup?: (processGroupId: number, signal: StopSignal) => void;
}): GenericRuntimeInterruptController {
  let firstSignal: RuntimeSignal | undefined;
  const signalGroup = options.signalGroup ?? defaultSignalGroup;

  return {
    firstSignal: () => firstSignal,
    handle: (signal) => {
      if (firstSignal) {
        const processGroupId = options.processGroupId();
        if (processGroupId) signalGroup(processGroupId, 'SIGKILL');
        return;
      }

      firstSignal = signal;
      // Teardown awaits this same cached promise below. Suppress only the
      // event-handler rejection so Node does not report it as unhandled first.
      void options.requestCleanup().catch(() => undefined);
    },
  };
}

export function combineGenericRuntimeFailures(
  primaryFailure: unknown,
  cleanupFailures: readonly unknown[]
): unknown {
  if (primaryFailure && cleanupFailures.length > 0) {
    const combined = new AggregateError(
      [primaryFailure, ...cleanupFailures],
      'Generic E2E runtime and cleanup both failed'
    ) as SupervisorError;
    const primaryExitCode = (primaryFailure as SupervisorError | undefined)?.exitCode;
    if (primaryExitCode !== undefined) combined.exitCode = primaryExitCode;
    return combined;
  }
  if (primaryFailure) return primaryFailure;
  if (cleanupFailures.length === 1) return cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    return new AggregateError(cleanupFailures, 'Generic E2E runtime cleanup failed');
  }
  return undefined;
}

/** Stop only the detached process group created by this supervisor. */
export async function stopGenericRuntimeGroup(
  processGroupId: number,
  controls: ProcessGroupControls = {
    groupExists: defaultGroupExists,
    signalGroup: defaultSignalGroup,
    wait: delay,
  }
): Promise<void> {
  if (!controls.groupExists(processGroupId)) return;
  controls.signalGroup(processGroupId, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await controls.wait(100);
    if (!controls.groupExists(processGroupId)) return;
  }

  controls.signalGroup(processGroupId, 'SIGKILL');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await controls.wait(100);
    if (!controls.groupExists(processGroupId)) return;
  }
  throw new Error(`Generic E2E process group ${processGroupId} survived SIGKILL`);
}

export function genericFirebaseInvocation(firebaseCli: string): readonly string[] {
  return [
    firebaseCli,
    'emulators:exec',
    '--only',
    'auth,firestore,storage',
    '--project',
    'demo-radarist',
    'node node_modules/tsx/dist/cli.mjs scripts/testing/run-generic-e2e-inner.ts',
  ];
}

export function genericRuntimeEnv(
  credentialRoot: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    HOME: join(credentialRoot, 'home'),
    CLAUDE_CONFIG_DIR: join(credentialRoot, 'claude'),
    XDG_CONFIG_HOME: join(credentialRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(credentialRoot, 'xdg-cache'),
    XDG_DATA_HOME: join(credentialRoot, 'xdg-data'),
    XDG_STATE_HOME: join(credentialRoot, 'xdg-state'),
    CLOUDSDK_CONFIG: join(credentialRoot, 'gcloud'),
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    RADARIST_GRAPH_RUNTIME_MODE: 'disabled',
    NEO4J_URI: '',
    INNGEST_ENABLED: 'false',
    NEXT_PUBLIC_INNGEST_ENABLED: 'false',
    INNGEST_EVENT_KEY: '',
    INNGEST_SIGNING_KEY: '',
    INNGEST_DEV_URL: '',
    INNGEST_DEV_SERVER_URL: '',
    CLAUDE_CHAT_ENABLED: 'false',
    DEFENSE_MINISTER_ENABLED: 'false',
    GOOGLE_API_KEY: '',
    GOOGLE_GENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    FIREBASE_SERVICE_ACCOUNT_KEY: '',
    FIREBASE_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENROUTER_API_KEY: '',
    OPENAI_API_KEY: '',
    EXA_API_KEY: '',
    FIRECRAWL_API_KEY: '',
    TAVILY_API_KEY: '',
    BRAVE_API_KEY: '',
    SERPAPI_KEY: '',
    NEWS_API_KEY: '',
    GITHUB_TOKEN: '',
    NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
    // Explicitly enables the identifier-free graph geometry seam used only by
    // the disposable browser acceptance. The component also requires a live
    // Auth-emulator connection before returning any snapshot.
    NEXT_PUBLIC_E2E_GRAPH_DIAGNOSTICS: 'true',
    NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-radarist.firebaseapp.com',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-radarist.appspot.com',
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:0000000000000000000000',
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    FIREBASE_PROJECT_ID: 'demo-radarist',
    GOOGLE_CLOUD_PROJECT: 'demo-radarist',
    GCLOUD_PROJECT: 'demo-radarist',
    E2E_USER_EMAIL: 'demo@radarist.local',
    E2E_USER_PASSWORD: 'radarist-demo-password',
    E2E_RUNTIME_LANE: 'generic',
    E2E_BLOCK_EXTERNAL_NETWORK: 'true',
    E2E_APP_ORIGIN: 'http://127.0.0.1:9002',
  };
  // OPS-003 removed this deprecated alias. Delete inherited operator values so
  // a generic lane cannot re-admit the warning storm through `...source`.
  delete env.INNGEST_DEVSERVER_URL;
  return env;
}

function waitForRuntime(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function interruptExitCode(signal: RuntimeSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

export async function runGenericE2ESupervisor(): Promise<void> {
  await assertGenericOwnedPortsFree('before launch');
  const credentialRoot = mkdtempSync(join(tmpdir(), 'radarist-generic-e2e-credentials-'));
  for (const directory of ['home', 'claude', 'xdg-config', 'xdg-cache', 'xdg-data', 'xdg-state', 'gcloud']) {
    mkdirSync(join(credentialRoot, directory), { recursive: true });
  }

  let child: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const requestCleanup = () => {
    const processGroupId = child?.pid;
    if (!processGroupId) return Promise.resolve();
    cleanupPromise ??= stopGenericRuntimeGroup(processGroupId);
    return cleanupPromise;
  };
  const interrupts = createGenericRuntimeInterruptController({
    processGroupId: () => child?.pid,
    requestCleanup,
  });
  const onSigint = () => interrupts.handle('SIGINT');
  const onSigterm = () => interrupts.handle('SIGTERM');

  let primaryFailure: unknown;

  try {
    const firebaseCli = require.resolve('firebase-tools/lib/bin/firebase');
    child = spawn(process.execPath, [...genericFirebaseInvocation(firebaseCli)], {
      cwd: process.cwd(),
      env: genericRuntimeEnv(credentialRoot),
      stdio: 'inherit',
      detached: true,
    });
    if (!child.pid) throw new Error('Generic E2E runtime did not expose an owned process group');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const result = await waitForRuntime(child);
    const interrupted = interrupts.firstSignal();
    if (interrupted) {
      const error = new Error(`Generic E2E interrupted by ${interrupted}`) as SupervisorError;
      error.exitCode = interruptExitCode(interrupted);
      throw error;
    }
    if (result.code !== 0) {
      throw new Error(`Generic E2E runtime exited ${String(result.code ?? result.signal)}`);
    }
  } catch (error) {
    primaryFailure = error;
  }

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  const cleanupFailures: unknown[] = [];
  try {
    await requestCleanup();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await assertGenericOwnedPortsFree('after cleanup');
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    rmSync(credentialRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }

  const failure = combineGenericRuntimeFailures(primaryFailure, cleanupFailures);
  if (failure) throw failure;
}

if (require.main === module) {
  runGenericE2ESupervisor().catch((error: Error & { exitCode?: number }) => {
    process.stderr.write(`[generic-e2e] ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
