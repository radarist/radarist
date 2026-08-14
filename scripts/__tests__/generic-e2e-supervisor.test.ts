import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertGenericOwnedPortsFree,
  combineGenericRuntimeFailures,
  createGenericRuntimeInterruptController,
  GENERIC_E2E_OWNED_PORTS,
  genericFirebaseInvocation,
  genericRuntimeEnv,
  stopGenericRuntimeGroup,
} from '../testing/run-generic-e2e-supervisor';

describe('generic E2E supervisor', () => {
  it('owns every app and Firebase runtime port named by the lane contract', () => {
    expect(GENERIC_E2E_OWNED_PORTS).toEqual([9002, 9099, 8080, 9199, 4400, 4500]);
  });

  it('refuses launch or successful cleanup while any owned listener remains', async () => {
    await expect(
      assertGenericOwnedPortsFree('before launch', async (port) => port === 8080 || port === 4500)
    ).rejects.toThrow('Generic E2E owned ports occupied before launch: 8080, 4500');
  });

  it('detects an actual temporary listener during preflight', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        assertGenericOwnedPortsFree('before launch', undefined, [port])
      ).rejects.toThrow(`Generic E2E owned ports occupied before launch: ${port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('launches the exact emulator set and inner runner without a shell-built command', () => {
    expect(genericFirebaseInvocation('/owned/firebase.js')).toEqual([
      '/owned/firebase.js',
      'emulators:exec',
      '--only',
      'auth,firestore,storage',
      '--project',
      'demo-radarist',
      'node node_modules/tsx/dist/cli.mjs scripts/testing/run-generic-e2e-inner.ts',
    ]);
  });

  it('blanks paid credentials and isolates operator configuration', () => {
    const env = genericRuntimeEnv('/private/owned', {
      GOOGLE_API_KEY: 'live-google',
      ANTHROPIC_API_KEY: 'live-anthropic',
      INNGEST_DEVSERVER_URL: 'http://127.0.0.1:9999',
      HOME: '/operator',
    });
    expect(env.GOOGLE_API_KEY).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.HOME).toBe('/private/owned/home');
    expect(env.RADARIST_GRAPH_RUNTIME_MODE).toBe('disabled');
    expect(env.INNGEST_ENABLED).toBe('false');
    expect(env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR).toBe('true');
    expect(env.NEXT_PUBLIC_E2E_GRAPH_DIAGNOSTICS).toBe('true');
    expect(env.E2E_BLOCK_EXTERNAL_NETWORK).toBe('true');
    expect(env).not.toHaveProperty('INNGEST_DEVSERVER_URL');
  });

  it('terminates the owned group gracefully when TERM succeeds', async () => {
    const signals: string[] = [];
    await stopGenericRuntimeGroup(123, {
      groupExists: () => signals.length === 0,
      signalGroup: (_group, signal) => signals.push(signal),
      wait: async () => undefined,
    });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('escalates only the owned process group when TERM does not converge', async () => {
    const signals: string[] = [];
    await stopGenericRuntimeGroup(456, {
      groupExists: () => !signals.includes('SIGKILL'),
      signalGroup: (_group, signal) => signals.push(signal),
      wait: async () => undefined,
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('preserves the primary exit code and both failures when runtime and cleanup fail', () => {
    const primary = Object.assign(new Error('runtime failed'), { exitCode: 130 });
    const cleanup = new Error('cleanup failed');
    const failure = combineGenericRuntimeFailures(primary, [cleanup]) as AggregateError & {
      exitCode?: number;
    };

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([primary, cleanup]);
    expect(failure.exitCode).toBe(130);
  });

  it('uses a second interrupt to bypass the grace window for a real detached group', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (!parent.pid) throw new Error('test child did not expose a process group');
    await new Promise<void>((resolve, reject) => {
      parent.stdout?.once('data', () => resolve());
      parent.once('error', reject);
      parent.once('exit', (code, signal) =>
        reject(new Error(`test child exited before readiness: ${String(code ?? signal)}`))
      );
    });

    let cleanupPromise: Promise<void> | undefined;
    const requestCleanup = () => {
      cleanupPromise ??= stopGenericRuntimeGroup(parent.pid!);
      return cleanupPromise;
    };
    const interrupts = createGenericRuntimeInterruptController({
      processGroupId: () => parent.pid,
      requestCleanup,
    });

    try {
      interrupts.handle('SIGINT');
      await delay(100);
      expect(interrupts.firstSignal()).toBe('SIGINT');
      expect(() => process.kill(-parent.pid!, 0)).not.toThrow();

      const escalationStartedAt = Date.now();
      interrupts.handle('SIGTERM');
      await requestCleanup();

      expect(Date.now() - escalationStartedAt).toBeLessThan(2_000);
      expect(() => process.kill(-parent.pid!, 0)).toThrow();
    } finally {
      try {
        process.kill(-parent.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }, 10_000);

  it('kills a TERM-resistant detached parent and descendant listener as one owned group', async () => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve()))
    );

    const descendantSource = [
      "const { createServer } = require('node:net');",
      "process.on('SIGTERM', () => {});",
      "createServer(() => {}).listen(Number(process.argv[1]), '127.0.0.1');",
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, process.argv[1]], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const parent = spawn(process.execPath, ['-e', parentSource, String(port)], {
      detached: true,
      stdio: 'ignore',
    });
    if (!parent.pid) throw new Error('test child did not expose a process group');

    const portIsListening = async () => {
      try {
        await assertGenericOwnedPortsFree('before launch', undefined, [port]);
        return false;
      } catch {
        return true;
      }
    };
    try {
      for (let attempt = 0; attempt < 100 && !(await portIsListening()); attempt += 1) {
        await delay(10);
      }
      expect(await portIsListening()).toBe(true);

      await stopGenericRuntimeGroup(parent.pid, {
        groupExists: (processGroupId) => {
          try {
            process.kill(-processGroupId, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
            throw error;
          }
        },
        signalGroup: (processGroupId, signal) => process.kill(-processGroupId, signal),
        wait: async () => delay(10),
      });
      await assertGenericOwnedPortsFree('after cleanup', undefined, [port]);
    } finally {
      try {
        process.kill(-parent.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }, 10_000);
});
