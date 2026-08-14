/** @jest-environment node */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_RUNTIME_PROFILES,
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
} from '../lib/local-runtime-profile';
import {
  STANDALONE_FIREBASE_PORT_NAMES,
  STANDALONE_RESERVED_PORT_NAMES,
  StandaloneCheckpointQueue,
  assertStandaloneFirebasePortsAvailable,
  buildStandaloneFirebaseEnvironment,
  buildStandaloneFirebaseLaunchPlan,
  findOccupiedStandaloneFirebasePorts,
  isStandaloneChildRunning,
  parseStandalonePersistenceOptions,
  prepareStandaloneRuntimeOwnership,
  removeStaleEphemeralSessions,
} from '../emulators-persist';

describe('standalone Firebase persistence runner', () => {
  it('defaults to the canonical default profile in durable mode', () => {
    expect(parseStandalonePersistenceOptions([])).toEqual({
      profile: LOCAL_RUNTIME_PROFILES.default,
      mode: 'durable',
    });
  });

  it('accepts only default/selftest identities and an explicit ephemeral mode', () => {
    expect(parseStandalonePersistenceOptions(['--profile', 'selftest', '--ephemeral'])).toEqual({
      profile: LOCAL_RUNTIME_PROFILES.selftest,
      mode: 'ephemeral',
    });
    expect(parseStandalonePersistenceOptions(['--profile=default'])).toEqual({
      profile: LOCAL_RUNTIME_PROFILES.default,
      mode: 'durable',
    });

    expect(() => parseStandalonePersistenceOptions(['--profile', 'production'])).toThrow(
      'Unknown local runtime profile'
    );
    expect(() => parseStandalonePersistenceOptions(['--profile'])).toThrow(
      'requires an explicit profile name'
    );
    expect(() =>
      parseStandalonePersistenceOptions(['--profile=default', '--profile=selftest'])
    ).toThrow('exactly once');
    expect(() => parseStandalonePersistenceOptions(['--ephemeral', '--ephemeral'])).toThrow(
      'at most once'
    );
  });

  it('rejects legacy shared-directory and arbitrary Firebase passthrough options', () => {
    for (const args of [
      ['--data-dir', './emulator-data'],
      ['--persist'],
      ['--', '--only', 'firestore'],
      ['--only=firestore'],
    ]) {
      expect(() => parseStandalonePersistenceOptions(args)).toThrow('Unsupported option');
    }
  });

  it('uses only the canonical profile project, config, Firebase services, and verified import', () => {
    const configPath = join('/private', 'profile', 'runtime', 'config', 'firebase.json');
    const importPath = join('/private', 'profile', 'checkpoints', 'generations', 'cp-safe');
    const plan = buildStandaloneFirebaseLaunchPlan({
      profile: LOCAL_RUNTIME_PROFILES.selftest,
      configPath,
      importPath,
    });

    expect(plan).toEqual({
      command: 'npx',
      args: [
        'firebase',
        'emulators:start',
        '--project',
        'demo-radarist-selftest',
        '--config',
        configPath,
        '--only',
        'firestore,auth,storage',
        '--import',
        importPath,
      ],
      importPath,
    });
    expect(plan.args).not.toContain('--export-on-exit');
    expect(plan.args.join(' ')).not.toContain('./emulator-data');

    const ephemeralPlan = buildStandaloneFirebaseLaunchPlan({
      profile: LOCAL_RUNTIME_PROFILES.selftest,
      configPath,
    });
    expect(ephemeralPlan.importPath).toBeUndefined();
    expect(ephemeralPlan.args).not.toContain('--import');
  });

  it('overrides inherited live targets with the selected demo profile', () => {
    const env = buildStandaloneFirebaseEnvironment(LOCAL_RUNTIME_PROFILES.selftest, {
      GCLOUD_PROJECT: 'live-project',
      FIRESTORE_EMULATOR_HOST: 'remote.example:8080',
      FIREBASE_AUTH_EMULATOR_HOST: 'remote.example:9099',
      FIREBASE_STORAGE_EMULATOR_HOST: 'remote.example:9199',
    });

    expect(env).toMatchObject({
      GCLOUD_PROJECT: 'demo-radarist-selftest',
      GOOGLE_CLOUD_PROJECT: 'demo-radarist-selftest',
      FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
      FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
    });
  });

  it('probes every and only Firebase-owned profile port and fails closed on occupancy', async () => {
    const probed: number[] = [];
    const occupied = await findOccupiedStandaloneFirebasePorts(
      LOCAL_RUNTIME_PROFILES.default,
      async (host, port) => {
        expect(host).toBe('127.0.0.1');
        probed.push(port);
        return port === 8080 || port === 4500;
      }
    );

    expect(STANDALONE_FIREBASE_PORT_NAMES).toEqual([
      'firebaseUi',
      'firebaseFirestoreWebsocket',
      'firebaseHub',
      'firebaseLogging',
      'firestore',
      'auth',
      'storage',
    ]);
    expect(probed).toEqual(
      STANDALONE_FIREBASE_PORT_NAMES.map((name) => LOCAL_RUNTIME_PROFILES.default.ports[name])
    );
    expect(probed).not.toContain(LOCAL_RUNTIME_PROFILES.default.ports.app);
    expect(probed).not.toContain(LOCAL_RUNTIME_PROFILES.default.ports.neo4jBolt);
    expect(occupied).toEqual([
      { name: 'firebaseLogging', port: 4500 },
      { name: 'firestore', port: 8080 },
    ]);
    await expect(
      assertStandaloneFirebasePortsAvailable(
        LOCAL_RUNTIME_PROFILES.default,
        async (_host, port) => port === 8080
      )
    ).rejects.toThrow('firestore:8080');
    expect(STANDALONE_RESERVED_PORT_NAMES).toEqual([
      ...STANDALONE_FIREBASE_PORT_NAMES,
      'app',
      'inngest',
    ]);
    await expect(
      assertStandaloneFirebasePortsAvailable(
        LOCAL_RUNTIME_PROFILES.default,
        async (_host, port) => port === LOCAL_RUNTIME_PROFILES.default.ports.app
      )
    ).rejects.toThrow('app:9002');
  });

  it('claims lifecycle ownership before probing reserved writer ports', async () => {
    const calls: string[] = [];
    const lifecycle = {
      runtimeId: 'runtime-0123456789abcdef',
      registerProcess: jest.fn(),
      refreshProcess: jest.fn(),
      stopOwnedProcesses: jest.fn(async () => undefined),
      finalizeStoppedRuntime: jest.fn(),
    };
    const paths = deriveLocalRuntimePaths('/private/repository', 'selftest', '/private/runtime-data');
    await expect(
      prepareStandaloneRuntimeOwnership(
        {
          paths,
          profile: LOCAL_RUNTIME_PROFILES.selftest,
          runtimeId: lifecycle.runtimeId,
          acquiredAt: '2026-07-19T08:00:00.000Z',
        },
        {
          claim: async () => {
            calls.push('claim');
            return lifecycle;
          },
          assertPorts: async () => {
            calls.push('ports');
          },
        }
      )
    ).resolves.toBe(lifecycle);
    expect(calls).toEqual(['claim', 'ports']);
    expect(lifecycle.stopOwnedProcesses).not.toHaveBeenCalled();
  });

  it('releases a launcher-only lifecycle when reserved-port validation fails', async () => {
    const calls: string[] = [];
    const lifecycle = {
      runtimeId: 'runtime-0123456789abcdef',
      registerProcess: jest.fn(),
      refreshProcess: jest.fn(),
      stopOwnedProcesses: jest.fn(async () => {
        calls.push('stop');
      }),
      finalizeStoppedRuntime: jest.fn(() => {
        calls.push('finalize');
      }),
    };
    await expect(
      prepareStandaloneRuntimeOwnership(
        {
          paths: deriveLocalRuntimePaths('/private/repository', 'selftest', '/private/runtime-data'),
          profile: LOCAL_RUNTIME_PROFILES.selftest,
          runtimeId: lifecycle.runtimeId,
          acquiredAt: '2026-07-19T08:00:00.000Z',
        },
        {
          claim: async () => {
            calls.push('claim');
            return lifecycle;
          },
          assertPorts: async () => {
            calls.push('ports');
            throw new Error('port occupied');
          },
        }
      )
    ).rejects.toThrow('port occupied');
    expect(calls).toEqual(['claim', 'ports', 'stop', 'finalize']);
  });

  it('coalesces overlapping requests through the shared checkpoint scheduler contract', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let calls = 0;
    let clock = 0;
    const queue = new StandaloneCheckpointQueue(
      async () => {
        calls += 1;
        if (calls === 1) await firstGate;
      },
      () => new Date(1_753_000_000_000 + clock++ * 1_000)
    );

    const first = queue.request('first');
    const second = queue.request('second');
    const third = queue.request('third');
    expect(queue.snapshot()).toMatchObject({
      running: true,
      pendingRequestCount: 2,
      totalStarted: 1,
      totalCoalesced: 2,
    });
    releaseFirst?.();
    await Promise.all([first, second, third]);

    expect(calls).toBe(2);
    expect(queue.snapshot()).toMatchObject({
      running: false,
      pendingRequestCount: 0,
      totalStarted: 2,
      totalCompleted: 2,
      totalCoalesced: 2,
    });
  });

  it('returns to idle after a failed checkpoint so the next request can recover', async () => {
    let calls = 0;
    let clock = 0;
    const queue = new StandaloneCheckpointQueue(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('export failed');
      },
      () => new Date(1_753_000_000_000 + clock++ * 1_000)
    );

    await expect(queue.request('failure')).rejects.toThrow('export failed');
    expect(queue.snapshot().running).toBe(false);
    await expect(queue.request('retry')).resolves.toBeUndefined();
    expect(queue.snapshot()).toMatchObject({ totalStarted: 2, totalCompleted: 2 });
  });

  it('treats both numeric and signal child termination as stopped', () => {
    expect(isStandaloneChildRunning({ exitCode: null, signalCode: null })).toBe(true);
    expect(isStandaloneChildRunning({ exitCode: 0, signalCode: null })).toBe(false);
    expect(isStandaloneChildRunning({ exitCode: 1, signalCode: null })).toBe(false);
    expect(isStandaloneChildRunning({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
  });

  it('removes only stale real ephemeral session directories after profile isolation', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'radarist-emulators-persist-'));
    try {
      const paths = ensurePrivateLocalRuntimeLayout(
        deriveLocalRuntimePaths(sandbox, 'selftest')
      );
      mkdirSync(join(paths.runtime, 'ephemeral-101'), { mode: 0o700 });
      mkdirSync(join(paths.runtime, 'ephemeral-202'), { mode: 0o700 });
      mkdirSync(join(paths.runtime, 'keep-me'), { mode: 0o700 });

      expect(removeStaleEphemeralSessions(paths)).toEqual(['ephemeral-101', 'ephemeral-202']);
      expect(existsSync(join(paths.runtime, 'ephemeral-101'))).toBe(false);
      expect(existsSync(join(paths.runtime, 'keep-me'))).toBe(true);

      symlinkSync(join(paths.runtime, 'keep-me'), join(paths.runtime, 'ephemeral-303'), 'dir');
      expect(() => removeStaleEphemeralSessions(paths)).toThrow('real directories');
      expect(existsSync(join(paths.runtime, 'keep-me'))).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
