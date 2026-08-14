/**
 * @jest-environment node
 *
 * The fake runner models Docker state but never invokes Docker. These tests
 * prove that every mutating command stays behind the disposable-target guard.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertArchiveContainsDatabase,
  assertSafeBenchmarkTarget,
  restoreNeo4j,
  snapshotNeo4j,
  type CommandRunner,
} from '../benchmark/snapshot';

const BASE_ENV = {
  NEO4J_BENCHMARK_CONFIRM_DISPOSABLE: '1',
  NEO4J_BENCHMARK_CONTAINER: 'radarist-neo4j-selftest',
  NEO4J_BENCHMARK_DATA_VOLUME: 'radarist_neo4j_selftest_data',
  NEO4J_URI: 'bolt://127.0.0.1:17687',
  NEO4J_DATABASE: 'neo4j',
};

class FakeDockerRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  running = true;
  archiveError = false;
  inspectErrorWhenStopped = false;
  archiveListing = './databases/neo4j/neostore\n./transactions/neo4j/';

  run(command: string, argsInput: readonly string[]): string {
    const args = [...argsInput];
    this.calls.push({ command, args });
    if (command !== 'docker') throw new Error(`Unexpected executable ${command}`);

    if (args[0] === 'inspect') {
      if (!this.running && this.inspectErrorWhenStopped) {
        this.inspectErrorWhenStopped = false;
        throw new Error('inspect failed after stop');
      }
      return JSON.stringify([
        {
          Name: '/radarist-neo4j-selftest',
          Config: { Image: 'neo4j:5.15.0-community' },
          State: { Running: this.running, Health: { Status: this.running ? 'healthy' : undefined } },
          Mounts: [
            { Destination: '/data', Name: 'radarist_neo4j_selftest_data', Type: 'volume' },
          ],
          NetworkSettings: {
            Ports: { '7687/tcp': [{ HostIp: '127.0.0.1', HostPort: '17687' }] },
          },
        },
      ]);
    }
    if (args[0] === 'stop') {
      this.running = false;
      return 'radarist-neo4j-selftest';
    }
    if (args[0] === 'start') {
      this.running = true;
      return 'radarist-neo4j-selftest';
    }
    if (args[0] === 'exec') return '';
    if (args[0] !== 'run') throw new Error(`Unexpected Docker command ${args[0]}`);

    if (args.includes('snapshot-archive')) {
      if (this.archiveError) throw new Error('tar failed');
      const backupMount = args.find((arg) => arg.includes('dst=/backup') && !arg.includes('readonly'));
      const containerArchive = args[args.indexOf('snapshot-archive') + 1];
      if (!backupMount || !containerArchive) throw new Error('Missing archive arguments');
      const hostDirectory = backupMount.match(/src=([^,]+),dst=\/backup/)?.[1];
      if (!hostDirectory) throw new Error('Missing host backup directory');
      fs.writeFileSync(path.join(hostDirectory, path.basename(containerArchive)), 'verified-test-archive');
      return '';
    }
    if (args.includes('-tzf')) return this.archiveListing;
    if (args.includes('/bin/sh')) return '';
    throw new Error(`Unexpected Docker run: ${args.join(' ')}`);
  }
}

describe('schema benchmark Neo4j snapshot safety', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radarist-snapshot-test-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('fails before Docker inspection without explicit disposable confirmation', () => {
    const runner = new FakeDockerRunner();

    expect(() =>
      assertSafeBenchmarkTarget({}, { env: { ...BASE_ENV, NEO4J_BENCHMARK_CONFIRM_DISPOSABLE: undefined }, runner })
    ).toThrow('NEO4J_BENCHMARK_CONFIRM_DISPOSABLE=1');
    expect(runner.calls).toEqual([]);
  });

  it('always rejects the normal local container and data volume', () => {
    const runner = new FakeDockerRunner();

    expect(() =>
      assertSafeBenchmarkTarget(
        {},
        {
          env: {
            ...BASE_ENV,
            NEO4J_BENCHMARK_CONTAINER: 'radarist-neo4j',
            NEO4J_BENCHMARK_DATA_VOLUME: 'radarist_neo4j_data',
          },
          runner,
        }
      )
    ).toThrow('Refusing to target protected Neo4j container');
    expect(runner.calls).toEqual([]);
  });

  it('rejects the protected default Bolt port before Docker inspection', () => {
    const runner = new FakeDockerRunner();

    expect(() =>
      assertSafeBenchmarkTarget({}, { env: { ...BASE_ENV, NEO4J_URI: 'bolt://127.0.0.1:7687' }, runner })
    ).toThrow('protected default Bolt port 7687');
    expect(runner.calls).toEqual([]);
  });

  it('rejects credentials embedded in the disposable URI before Docker inspection', () => {
    const runner = new FakeDockerRunner();

    expect(() =>
      assertSafeBenchmarkTarget(
        {},
        { env: { ...BASE_ENV, NEO4J_URI: 'bolt://neo4j:secret@127.0.0.1:17687' }, runner }
      )
    ).toThrow('must not embed credentials');
    expect(runner.calls).toEqual([]);
  });

  it('binds graph access to the inspected disposable container and volume', () => {
    const runner = new FakeDockerRunner();

    expect(assertSafeBenchmarkTarget({}, { env: BASE_ENV, runner })).toMatchObject({
      container: 'radarist-neo4j-selftest',
      dataVolume: 'radarist_neo4j_selftest_data',
      database: 'neo4j',
      boltUri: 'bolt://127.0.0.1:17687',
      running: true,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: 'docker',
      args: ['inspect', 'radarist-neo4j-selftest'],
    });
  });

  it('creates a non-empty verified archive and restarts the disposable graph', () => {
    const runner = new FakeDockerRunner();

    const archive = snapshotNeo4j('before-migration', outputDir, {
      env: BASE_ENV,
      runner,
      sleep: () => undefined,
    });

    expect(fs.statSync(archive).size).toBeGreaterThan(0);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${archive}.manifest.json`).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      container: 'radarist-neo4j-selftest',
      dataVolume: 'radarist_neo4j_selftest_data',
      database: 'neo4j',
      sizeBytes: fs.statSync(archive).size,
    });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runner.running).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop')).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'start')).toBe(true);
    expect(runner.calls.flatMap(({ args }) => args)).not.toContain('neo4j-admin');
  });

  it('fails closed, removes partial artifacts, and restarts after archive failure', () => {
    const runner = new FakeDockerRunner();
    runner.archiveError = true;

    expect(() =>
      snapshotNeo4j('failed', outputDir, { env: BASE_ENV, runner, sleep: () => undefined })
    ).toThrow('[snapshot] tar failed');
    expect(runner.running).toBe(true);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('restarts when Docker stop succeeds but stopped-state inspection fails', () => {
    const runner = new FakeDockerRunner();
    runner.inspectErrorWhenStopped = true;

    expect(() =>
      snapshotNeo4j('stop-inspect-failed', outputDir, { env: BASE_ENV, runner, sleep: () => undefined })
    ).toThrow('inspect failed after stop');
    expect(runner.running).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'start')).toBe(true);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('does not accept a tar listing without the requested database store', () => {
    const runner = new FakeDockerRunner();
    runner.archiveListing = './databases/system/neostore\n';

    expect(() =>
      snapshotNeo4j('wrong-database', outputDir, { env: BASE_ENV, runner, sleep: () => undefined })
    ).toThrow('does not contain database neo4j');
    expect(runner.running).toBe(true);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('requires a separate restore confirmation before stopping the target', () => {
    const runner = new FakeDockerRunner();

    expect(() => restoreNeo4j(path.join(outputDir, 'missing.tar.gz'), { env: BASE_ENV, runner })).toThrow(
      'NEO4J_BENCHMARK_CONFIRM_RESTORE=replace-disposable-data'
    );
    expect(runner.calls).toEqual([]);
  });

  it('detects archive tampering before stopping the target', () => {
    const runner = new FakeDockerRunner();
    const archive = snapshotNeo4j('tamper-check', outputDir, {
      env: BASE_ENV,
      runner,
      sleep: () => undefined,
    });
    fs.appendFileSync(archive, 'tampered');
    runner.calls = [];

    expect(() =>
      restoreNeo4j(archive, {
        env: { ...BASE_ENV, NEO4J_BENCHMARK_CONFIRM_RESTORE: 'replace-disposable-data' },
        runner,
      })
    ).toThrow('size does not match');
    expect(runner.calls.some(({ args }) => args[0] === 'stop')).toBe(false);
  });

  it('restores only through the guarded raw-volume path and restarts the target', () => {
    const runner = new FakeDockerRunner();
    const archive = snapshotNeo4j('restore-check', outputDir, {
      env: BASE_ENV,
      runner,
      sleep: () => undefined,
    });
    runner.calls = [];

    expect(
      restoreNeo4j(archive, {
        env: { ...BASE_ENV, NEO4J_BENCHMARK_CONFIRM_RESTORE: 'replace-disposable-data' },
        runner,
        sleep: () => undefined,
      })
    ).toBe(true);
    expect(runner.running).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop')).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'start')).toBe(true);
    expect(runner.calls.flatMap(({ args }) => args)).not.toContain('neo4j-admin');
    expect(runner.calls.some(({ args }) => args.includes('snapshot-restore'))).toBe(true);
  });

  it('validates database content rather than accepting any non-empty archive', () => {
    expect(() => assertArchiveContainsDatabase('./databases/system/neostore\n', 'neo4j')).toThrow(
      'does not contain database neo4j'
    );
    expect(() => assertArchiveContainsDatabase('./databases/neo4j/neostore\n', 'neo4j')).not.toThrow();
  });
});
