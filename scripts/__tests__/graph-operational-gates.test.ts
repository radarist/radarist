/** @jest-environment node */

import type { ChildProcess } from 'node:child_process';
import {
  GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS,
  GRAPH_OPERATIONAL_OWNED_PORTS,
  assertGraphOperationalPortsClosed,
  buildGraphOperationalEnv,
  signalProcessTree,
  terminateProcessTree,
} from '../testing/run-graph-operational-gates';

describe('graph operational gate environment', () => {
  it('pins all mutating services to the isolated selftest profile', () => {
    const env = buildGraphOperationalEnv({
      NEO4J_URI: 'bolt://127.0.0.1:17687',
      NEO4J_USER: 'neo4j',
      NEO4J_PASSWORD: 'test-password',
    });

    expect(env).toEqual(
      expect.objectContaining({
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
        GRAPH_CANARY_APP_URL: 'http://127.0.0.1:9012',
        GRAPH_CANARY_INNGEST_URL: 'http://127.0.0.1:18288',
        GRAPH_CANARY_DISPOSABLE: 'true',
        GRAPH_HEALTH_RELATION_LOCKS: '1',
        NEO4J_INTEGRATION_DISPOSABLE: 'true',
        NEO4J_URI: 'bolt://127.0.0.1:17687',
      })
    );
  });

  it('refuses an explicit normal-profile Neo4j target', () => {
    expect(() =>
      buildGraphOperationalEnv({
        NEO4J_URI: 'bolt://127.0.0.1:7687',
        NEO4J_USER: 'neo4j',
        NEO4J_PASSWORD: 'test-password',
      })
    ).toThrow('protected default Bolt port 7687');
  });

  it('fails before service startup when disposable Neo4j credentials are incomplete', () => {
    expect(() =>
      buildGraphOperationalEnv({
        NEO4J_URI: 'bolt://127.0.0.1:17687',
        NEO4J_USER: 'neo4j',
      })
    ).toThrow('NEO4J_PASSWORD');
  });

  it('fails before startup when any owned selftest port already has a listener', async () => {
    const occupiedPort = 9012;
    const probe = jest.fn(async (_host: string, port: number) => port === occupiedPort);

    await expect(assertGraphOperationalPortsClosed(probe)).rejects.toThrow('already listening: 9012');
    expect(probe).toHaveBeenCalledTimes(GRAPH_OPERATIONAL_OWNED_PORTS.length);
  });

  it('accepts a fully closed selftest port set', async () => {
    await expect(assertGraphOperationalPortsClosed(async () => false)).resolves.toBeUndefined();
  });

  it('signals a detached POSIX process group instead of only its wrapper PID', () => {
    const killProcess = jest.fn(() => true);
    const child = { pid: 4242 } as ChildProcess;

    expect(signalProcessTree(child, 'SIGINT', { platform: 'linux', killProcess })).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGINT');
  });

  it('escalates bounded teardown through SIGINT, SIGTERM, and SIGKILL', async () => {
    let alive = true;
    const killProcess = jest.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGKILL') alive = false;
      return true;
    });
    const child = { pid: 4242, exitCode: null, signalCode: null } as ChildProcess;

    await expect(
      terminateProcessTree(child, {
        platform: 'linux',
        killProcess,
        graceMs: { SIGINT: 1, SIGTERM: 1, SIGKILL: 1 },
        pollIntervalMs: 1,
        sleep: async () => undefined,
      })
    ).resolves.toBe(true);
    expect(killProcess.mock.calls.filter(([, signal]) => signal !== 0).map(([, signal]) => signal)).toEqual([
      'SIGINT',
      'SIGTERM',
      'SIGKILL',
    ]);
  });

  it('assigns a finite timeout to every one-shot operational command', () => {
    expect(Object.values(GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS)).toHaveLength(6);
    for (const timeoutMs of Object.values(GRAPH_OPERATIONAL_COMMAND_TIMEOUT_MS)) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(8 * 60_000);
    }
  });
});
