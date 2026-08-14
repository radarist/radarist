#!/usr/bin/env npx tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDemoEnv,
  DEMO_PROFILES,
  envForChild,
  isTcpOpen,
  waitForTcp,
  writeFirebaseEmulatorConfig,
  type EnvMap,
} from '../lib/local-demo';

interface DisposableTargetGuard {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): { uri: string; hostname: string; port: number };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetGuard = require('./neo4j-integration-target.cjs') as DisposableTargetGuard;

const PROFILE = DEMO_PROFILES.selftest;
const REPORT_DIR = resolve(process.cwd(), 'reports', 'graph-integration');
const children: Array<{ name: string; child: ChildProcess; log: WriteStream }> = [];

export const GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS = {
  fixtureSeed: 90_000,
  graphHealth: 90_000,
  graphBenchmark: 120_000,
  cypherBenchmark: 120_000,
  graphCanary: 8 * 60_000,
  fixtureCleanup: 90_000,
} as const;

const PROCESS_STOP_GRACE_MS: Record<'SIGINT' | 'SIGTERM' | 'SIGKILL', number> = {
  SIGINT: 5_000,
  SIGTERM: 5_000,
  SIGKILL: 2_000,
};

type ProcessTreeSignal = NodeJS.Signals | 0;
type KillProcess = (pid: number, signal: ProcessTreeSignal) => boolean;

interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  killProcess?: KillProcess;
  graceMs?: Partial<typeof PROCESS_STOP_GRACE_MS>;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface OperationalSummary {
  status: 'starting' | 'running' | 'passed' | 'failed';
  phase: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  cleanupError?: string;
  teardownError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processTreeAlive(child: ChildProcess, options: ProcessTreeOptions): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return child.exitCode === null && child.signalCode === null;
  if (!child.pid) return false;
  try {
    (options.killProcess ?? (process.kill as KillProcess))(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: ProcessTreeOptions = {}
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return child.kill(signal);
  if (!child.pid) return false;
  try {
    return (options.killProcess ?? (process.kill as KillProcess))(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return false;
  }
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  timeoutMs: number,
  options: ProcessTreeOptions
): Promise<boolean> {
  const pollIntervalMs = Math.max(1, Math.min(options.pollIntervalMs ?? 100, timeoutMs));
  const wait = options.sleep ?? sleep;
  if (!processTreeAlive(child, options)) return true;
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += pollIntervalMs) {
    await wait(Math.min(pollIntervalMs, timeoutMs - elapsed));
    if (!processTreeAlive(child, options)) return true;
  }
  return !processTreeAlive(child, options);
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeOptions = {}
): Promise<boolean> {
  const stages: Array<'SIGINT' | 'SIGTERM' | 'SIGKILL'> = ['SIGINT', 'SIGTERM', 'SIGKILL'];
  for (const signal of stages) {
    if (!processTreeAlive(child, options)) return true;
    signalProcessTree(child, signal, options);
    const graceMs = options.graceMs?.[signal] ?? PROCESS_STOP_GRACE_MS[signal];
    if (await waitForProcessTreeExit(child, graceMs, options)) return true;
  }
  return !processTreeAlive(child, options);
}

function writeOperationalSummary(summary: OperationalSummary): void {
  writeFileSync(resolve(REPORT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

function processEnvMap(env: NodeJS.ProcessEnv): EnvMap {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function buildGraphOperationalEnv(base: NodeJS.ProcessEnv = process.env): EnvMap {
  const missingCredentials = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD'].filter(
    (key) => !base[key]?.trim()
  );
  if (missingCredentials.length > 0) {
    throw new Error(
      `Graph operational gates require explicit disposable Neo4j credentials: ${missingCredentials.join(', ')}`
    );
  }
  const generated = buildDemoEnv(PROFILE, processEnvMap(base));
  const env: EnvMap = {
    ...generated,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROFILE.projectId,
    FIREBASE_PROJECT_ID: PROFILE.projectId,
    GOOGLE_CLOUD_PROJECT: PROFILE.projectId,
    GCLOUD_PROJECT: PROFILE.projectId,
    NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${PROFILE.firebase.firestore}`,
    NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: `127.0.0.1:${PROFILE.firebase.firestore}`,
    NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${PROFILE.appPort}`,
    GRAPH_CANARY_APP_URL: `http://127.0.0.1:${PROFILE.appPort}`,
    INNGEST_ENABLED: 'true',
    INNGEST_DEV: `http://127.0.0.1:${PROFILE.inngestPort}`,
    INNGEST_DEV_SERVER_URL: `http://127.0.0.1:${PROFILE.inngestPort}`,
    GRAPH_CANARY_INNGEST_URL: `http://127.0.0.1:${PROFILE.inngestPort}`,
    GRAPH_CANARY_DISPOSABLE: 'true',
    GRAPH_HEALTH_RELATION_LOCKS: '1',
    NEO4J_INTEGRATION_DISPOSABLE: 'true',
    NODE_ENV: 'development',
  };
  // The GitHub service and local selftest profile both publish Bolt on 17687.
  // Never let buildDemoEnv silently replace explicit CI credentials.
  env.NEO4J_URI = base.NEO4J_URI!.trim();
  env.NEO4J_USER = base.NEO4J_USER!.trim();
  env.NEO4J_PASSWORD = base.NEO4J_PASSWORD!;
  targetGuard.assertDisposableNeo4jIntegrationTarget(env);
  return env;
}

function pipeOutput(child: ChildProcess, log: WriteStream): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
}

function startLogged(name: string, command: string, args: string[], env: EnvMap): ChildProcess {
  const log = createWriteStream(resolve(REPORT_DIR, `${name}.log`), { flags: 'w' });
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: envForChild(env),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeOutput(child, log);
  child.on('error', (error) => log.write(`\n[start error] ${error.message}\n`));
  children.push({ name, child, log });
  return child;
}

export const GRAPH_OPERATIONAL_OWNED_PORTS = Object.freeze([
  PROFILE.appPort,
  PROFILE.inngestPort,
  PROFILE.firebase.ui,
  PROFILE.firebase.firestore,
  PROFILE.firebase.auth,
  PROFILE.firebase.storage,
]);

export async function assertGraphOperationalPortsClosed(
  probe: (host: string, port: number) => Promise<boolean> = isTcpOpen
): Promise<void> {
  const occupied: number[] = [];
  for (const port of GRAPH_OPERATIONAL_OWNED_PORTS) {
    if (await probe('127.0.0.1', port)) occupied.push(port);
  }
  if (occupied.length > 0) {
    throw new Error(
      `Graph operational selftest requires exclusive service ports; already listening: ${occupied.join(', ')}`
    );
  }
}

async function waitForChildReady(child: ChildProcess, name: string, readiness: Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(new Error(`${name} failed to start: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`${name} exited before readiness: ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`));

    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once('error', onError);
    child.once('exit', onExit);
    void readiness.then(
      () => {
        cleanup();
        resolvePromise();
      },
      (error) => fail(error instanceof Error ? error : new Error(String(error)))
    );
  });
}

function runLogged(name: string, command: string, args: string[], env: EnvMap, timeoutMs: number): Promise<void> {
  const log = createWriteStream(resolve(REPORT_DIR, `${name}.log`), { flags: 'w' });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: envForChild(env),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeOutput(child, log);
    let settled = false;
    let timingOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      log.end();
      if (error) reject(error);
      else resolvePromise();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timingOut) return;
      if (code === 0) finish();
      else finish(new Error(`${name} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`));
    };
    const timer = setTimeout(() => {
      timingOut = true;
      log.write(`\n[timeout] ${name} exceeded ${timeoutMs}ms; terminating process tree\n`);
      void terminateProcessTree(child).then((stopped) => {
        finish(
          new Error(
            `${name} timed out after ${timeoutMs}ms${stopped ? '' : ' and its process tree did not exit after SIGKILL'}`
          )
        );
      });
    }, timeoutMs);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForOk(url: string, label: string, timeoutMs: number, rejectBody?: RegExp): Promise<void> {
  const started = Date.now();
  let last = 'not started';
  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      if (response.ok && !(rejectBody?.test(text) ?? false)) return;
      last = `HTTP ${response.status}${rejectBody?.test(text) ? ' (rejected body)' : ''}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${last}`);
}

async function stopChildren(): Promise<void> {
  const failures: string[] = [];
  for (const { name, child, log } of [...children].reverse()) {
    if (!(await terminateProcessTree(child))) failures.push(name);
    log.end();
  }
  children.length = 0;
  if (failures.length > 0) {
    throw new Error(`Process trees did not exit after SIGKILL: ${failures.join(', ')}`);
  }
}

export async function main(baseEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const summary: OperationalSummary = {
    status: 'starting',
    phase: 'initialize',
    startedAt: new Date().toISOString(),
  };
  writeOperationalSummary(summary);

  let scriptEnv: EnvMap | undefined;
  let runError: Error | undefined;
  let cleanupError: Error | undefined;
  let teardownError: Error | undefined;
  const setPhase = (phase: string) => {
    summary.status = 'running';
    summary.phase = phase;
    writeOperationalSummary(summary);
  };

  try {
    setPhase('validate-environment');
    const env = buildGraphOperationalEnv(baseEnv);
    const serverEnv = { ...env };
    scriptEnv = {
      ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
    };
    setPhase('validate-ports');
    await assertGraphOperationalPortsClosed();
    const firebaseConfig = writeFirebaseEmulatorConfig(PROFILE);

    setPhase('start-firestore');
    const firebase = startLogged(
      'firebase',
      'npx',
      ['firebase', 'emulators:start', '--project', PROFILE.projectId, '--config', firebaseConfig, '--only', 'firestore'],
      serverEnv
    );
    await waitForChildReady(
      firebase,
      'firebase',
      waitForTcp('127.0.0.1', PROFILE.firebase.firestore, 90_000)
    );

    setPhase('start-next');
    const next = startLogged(
      'next',
      'npx',
      ['next', 'dev', '--turbopack', '-H', '127.0.0.1', '-p', String(PROFILE.appPort)],
      serverEnv
    );
    await waitForChildReady(
      next,
      'next',
      waitForOk(
        `http://127.0.0.1:${PROFILE.appPort}/api/inngest`,
        'compiled Inngest route',
        180_000,
        /inngest disabled/i
      )
    );

    setPhase('start-inngest');
    const inngest = startLogged(
      'inngest',
      'npx',
      [
        'inngest-cli@1.36.0',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(PROFILE.inngestPort),
        '-u',
        `http://127.0.0.1:${PROFILE.appPort}/api/inngest`,
      ],
      serverEnv
    );
    await waitForChildReady(
      inngest,
      'inngest',
      waitForOk(`http://127.0.0.1:${PROFILE.inngestPort}/`, 'Inngest dev server', 120_000)
    );
    await waitForOk(
      `http://127.0.0.1:${PROFILE.appPort}/api/inngest`,
      'registered Inngest route',
      120_000,
      /inngest disabled/i
    );

    setPhase('seed-fixture');
    await runLogged(
      'fixture-seed',
      'npx',
      ['tsx', 'scripts/smoke-seed-graph-sync.ts', 'seed'],
      scriptEnv,
      GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.fixtureSeed
    );
    setPhase('graph-health');
    await runLogged(
      'graph-health',
      'npx',
      ['tsx', 'scripts/graph-health.ts'],
      scriptEnv,
      GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.graphHealth
    );
    setPhase('graph-benchmark');
    await runLogged(
      'graph-benchmark',
      'npx',
      [
        'tsx',
        'scripts/graph-benchmark.ts',
        '--strict',
        '--label',
        'ci-fixture',
        '--json',
        resolve(REPORT_DIR, 'benchmark.json'),
      ],
      scriptEnv,
      GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.graphBenchmark
    );
    setPhase('cypher-benchmark');
    await runLogged(
      'graph-cypher-benchmark',
      'npx',
      [
        'tsx',
        'scripts/graph-cypher-benchmark.ts',
        '--label',
        'ci-fixture',
        '--json',
        resolve(REPORT_DIR, 'cypher-benchmark.json'),
      ],
      scriptEnv,
      GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.cypherBenchmark
    );
    setPhase('graph-canary');
    await runLogged(
      'graph-canary',
      'npx',
      [
        'tsx',
        '--conditions=react-server',
        'scripts/graph-canary.ts',
        '--include-dedicated',
        '--json',
        resolve(REPORT_DIR, 'canary.json'),
      ],
      scriptEnv,
      GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.graphCanary
    );
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
    summary.error = runError.message;
  } finally {
    if (scriptEnv) {
      try {
        setPhase('fixture-cleanup');
        await runLogged(
          'fixture-cleanup',
          'npx',
          ['tsx', 'scripts/smoke-seed-graph-sync.ts', 'cleanup'],
          scriptEnv,
          GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS.fixtureCleanup
        );
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        summary.cleanupError = cleanupError.message;
      }
    }
    try {
      setPhase('service-teardown');
      await stopChildren();
    } catch (error) {
      teardownError = error instanceof Error ? error : new Error(String(error));
      summary.teardownError = teardownError.message;
    }
    summary.status = runError || cleanupError || teardownError ? 'failed' : 'passed';
    summary.phase = 'complete';
    summary.finishedAt = new Date().toISOString();
    writeOperationalSummary(summary);
  }

  if (runError || cleanupError || teardownError) {
    throw new Error(
      [
        runError?.message,
        cleanupError && `fixture cleanup failed: ${cleanupError.message}`,
        teardownError && `service teardown failed: ${teardownError.message}`,
      ]
        .filter(Boolean)
        .join('; ')
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[graph-operational] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
