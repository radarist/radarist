/** @jest-environment node */
/**
 * LOCAL-014 — guarded Neo4j backup/restore must honor the exact runtime
 * profile. Covers the fail-closed refusals (missing/ambiguous/malformed/
 * foreign/default-mismatch/container-mismatch/volume-mismatch/checksum-
 * mismatch/database-mismatch/protected/stale-manifest), the mutation flows,
 * post-restore identity read-back, and idempotent verification.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandRunner } from '../benchmark/snapshot';
import {
  OPERATOR_RESTORE_CONFIRMATION,
  assertOperatorApplyWritersQuiesced,
  assertOperatorPrimaryTarget,
  createOperatorNeo4jBackup,
  planOperatorNeo4jBackup,
  planOperatorBackupRestoreToDisposable,
  restoreOperatorBackupToDisposable,
  verifyOperatorBackupManifest,
} from '../lib/operator-neo4j-backup';

const IMAGE = 'neo4j:5.15.0-community';
const DEFAULT_PROFILE_ARGS = ['--profile', 'default'];
const SELFTEST_PROFILE_ARGS = ['--profile', 'selftest'];

const BACKUP_ENV = {
  NEO4J_OPERATOR_BACKUP_CONFIRM: 'backup-radarist-neo4j-offline',
  NEO4J_URI: 'bolt://127.0.0.1:7687',
  NEO4J_DATABASE: 'neo4j',
};

const SHIFTED_ENV = {
  RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '60',
  RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: 'k3test-x',
};

const SHIFTED_BACKUP_ENV = {
  ...BACKUP_ENV,
  ...SHIFTED_ENV,
  NEO4J_URI: 'bolt://127.0.0.1:7747',
};

const DISPOSABLE_RESTORE_ENV = {
  NEO4J_OPERATOR_RESTORE_CONFIRM: OPERATOR_RESTORE_CONFIRMATION,
  NEO4J_URI: 'bolt://127.0.0.1:17687',
  NEO4J_DATABASE: 'neo4j',
};

const DEFAULT_VOLUMES = [
  { name: 'radarist_neo4j_data', destination: '/data' },
  { name: 'radarist_neo4j_logs', destination: '/logs' },
  { name: 'radarist_neo4j_import', destination: '/var/lib/neo4j/import' },
  { name: 'radarist_neo4j_plugins', destination: '/plugins' },
];
const SELFTEST_VOLUMES = [
  { name: 'radarist_neo4j_selftest_data', destination: '/data' },
  { name: 'radarist_neo4j_selftest_logs', destination: '/logs' },
  { name: 'radarist_neo4j_selftest_import', destination: '/var/lib/neo4j/import' },
  { name: 'radarist_neo4j_selftest_plugins', destination: '/plugins' },
];
const SHIFTED_VOLUMES = [
  { name: 'radarist_neo4j_k3test_x_data', destination: '/data' },
  { name: 'radarist_neo4j_k3test_x_logs', destination: '/logs' },
  { name: 'radarist_neo4j_k3test_x_import', destination: '/var/lib/neo4j/import' },
  { name: 'radarist_neo4j_k3test_x_plugins', destination: '/plugins' },
];

interface FakeContainerSpec {
  image?: string;
  runtimeLabel?: string;
  hostIp?: string;
  httpHostPort?: string;
  boltHostPort?: string;
  extraPorts?: string[];
  mounts?: Array<{ Destination: string; Name: string; Type: string }>;
  running?: boolean;
  health?: string;
  healthAfterStart?: string;
  forcedKill?: boolean;
}

class FakeDockerRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  containers = new Map<string, FakeContainerSpec>();
  volumeLabels = new Map<string, string | undefined>();
  databaseIds = new Map<string, string>();
  archiveError = false;
  restoreError = false;
  archiveListing = './databases/neo4j/neostore\n./transactions/neo4j/';
  afterStop: (() => void) | undefined;

  constructor() {
    this.addContainer('radarist-neo4j', {
      httpHostPort: '7474',
      boltHostPort: '7687',
      mounts: DEFAULT_VOLUMES.map((v) => ({ Destination: v.destination, Name: v.name, Type: 'volume' })),
    });
    this.addContainer('radarist-neo4j-selftest', {
      runtimeLabel: 'durable:selftest',
      httpHostPort: '17474',
      boltHostPort: '17687',
      mounts: SELFTEST_VOLUMES.map((v) => ({ Destination: v.destination, Name: v.name, Type: 'volume' })),
    });
    this.addContainer('radarist-neo4j-k3test-x', {
      httpHostPort: '7534',
      boltHostPort: '7747',
      mounts: SHIFTED_VOLUMES.map((v) => ({ Destination: v.destination, Name: v.name, Type: 'volume' })),
    });
    for (const volume of [...DEFAULT_VOLUMES, ...SELFTEST_VOLUMES, ...SHIFTED_VOLUMES]) {
      const label = volume.name.includes('selftest') ? 'durable:selftest' : 'durable:default';
      this.volumeLabels.set(volume.name, label);
    }
  }

  addContainer(name: string, spec: FakeContainerSpec): void {
    this.containers.set(name, { running: true, ...spec });
    this.databaseIds.set(name, `database-id-${name}`);
  }

  isRunning(container: string): boolean {
    return this.containers.get(container)?.running === true;
  }

  run(command: string, argsInput: readonly string[]): string {
    const args = [...argsInput];
    this.calls.push({ command, args });
    if (command !== 'docker') throw new Error(`Unexpected executable ${command}`);
    if (args[0] === 'ps') {
      return [...this.containers.entries()]
        .filter(([, spec]) => spec.running)
        .map(([name]) => name)
        .join('\n');
    }
    if (args[0] === 'inspect') {
      const entries = args.slice(1).map((container) => {
        const spec = this.containers.get(container);
        if (!spec) throw new Error(`docker exited with code 1: Error: No such object: ${container}`);
        return this.inspectEntry(container, spec);
      });
      return JSON.stringify(entries);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volume = args.at(-1)!;
      if (!this.volumeLabels.has(volume)) {
        throw new Error(`docker exited with code 1: Error: No such volume: ${volume}`);
      }
      return `${this.volumeLabels.get(volume) ?? ''}|local|local\n`;
    }
    if (args[0] === 'stop') {
      const container = args.at(-1)!;
      const spec = this.containers.get(container);
      if (!spec) throw new Error(`No such container ${container}`);
      spec.running = false;
      this.afterStop?.();
      return container;
    }
    if (args[0] === 'start') {
      const container = args[1];
      const spec = this.containers.get(container);
      if (!spec) throw new Error(`No such container ${container}`);
      spec.running = true;
      spec.health = spec.healthAfterStart ?? 'healthy';
      return container;
    }
    if (args[0] === 'exec') {
      if (args.includes('database-id-read')) {
        const container = args[1];
        return `result\n"RADARIST_DATABASE_ID=${this.databaseIds.get(container) ?? 'database-unknown'}"\n1 row\n`;
      }
      return '';
    }
    if (args[0] !== 'run') throw new Error(`Unexpected Docker command ${args[0]}`);
    if (args.includes('operator-backup-archive')) {
      if (this.archiveError) throw new Error('tar failed');
      const mount = args.find((arg) => arg.includes('dst=/backup') && !arg.includes('readonly'));
      const archive = args[args.indexOf('operator-backup-archive') + 1];
      const directory = mount?.match(/src=([^,]+),dst=\/backup/)?.[1];
      if (!directory || !archive) throw new Error('Missing backup archive arguments');
      // A real archive snapshots the source volume's database identity.
      const sourceVolume = args.find((arg) => arg.includes('dst=/source'))?.match(/src=([^,]+),dst=\/source/)?.[1];
      this.archivedDatabaseId = this.databaseIdForVolume(sourceVolume);
      fs.writeFileSync(path.join(directory, path.basename(archive)), 'verified-operator-backup');
      return '';
    }
    if (args.includes('-tzf')) return this.archiveListing;
    if (args.includes('operator-backup-restore')) {
      if (this.restoreError) throw new Error('restore tar failed');
      // A real volume replacement makes the target's database identity equal
      // to the archived source identity.
      const targetVolume = args.find((arg) => arg.includes('dst=/target'))?.match(/src=([^,]+),dst=\/target/)?.[1];
      const container = this.containerForVolume(targetVolume);
      if (container && this.archivedDatabaseId) {
        this.databaseIds.set(container, this.archivedDatabaseId);
      }
      return '';
    }
    throw new Error(`Unexpected Docker run: ${args.join(' ')}`);
  }

  archivedDatabaseId: string | undefined;

  private databaseIdForVolume(volume: string | undefined): string | undefined {
    const container = this.containerForVolume(volume);
    return container ? this.databaseIds.get(container) : undefined;
  }

  private containerForVolume(volume: string | undefined): string | undefined {
    for (const [name, spec] of this.containers.entries()) {
      if (spec.mounts?.some((mount) => mount.Destination === '/data' && mount.Name === volume)) return name;
    }
    return undefined;
  }

  private inspectEntry(container: string, spec: FakeContainerSpec): Record<string, unknown> {
    const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
      '7474/tcp': [{ HostIp: spec.hostIp ?? '127.0.0.1', HostPort: spec.httpHostPort ?? '7474' }],
      '7687/tcp': [{ HostIp: spec.hostIp ?? '127.0.0.1', HostPort: spec.boltHostPort ?? '7687' }],
    };
    for (const extra of spec.extraPorts ?? []) {
      bindings[extra] = [{ HostIp: '127.0.0.1', HostPort: '9999' }];
    }
    const running = spec.running === true;
    return {
      Name: `/${container}`,
      Config: {
        Image: spec.image ?? IMAGE,
        Labels: { 'com.radarist.local-runtime': spec.runtimeLabel ?? 'durable:default' },
      },
      HostConfig: { PortBindings: bindings },
      NetworkSettings: {
        Ports: { '7687/tcp': [{ HostIp: spec.hostIp ?? '127.0.0.1', HostPort: spec.boltHostPort ?? '7687' }] },
      },
      Mounts: spec.mounts ?? [],
      State: {
        Running: running,
        ExitCode: running ? 0 : spec.forcedKill ? 137 : 0,
        OOMKilled: !running && spec.forcedKill === true,
        Health: { Status: running ? (spec.health ?? 'healthy') : undefined },
      },
    };
  }
}

function noMutationCalls(runner: FakeDockerRunner): boolean {
  return !runner.calls.some(
    ({ args }) =>
      args[0] === 'stop' ||
      args[0] === 'start' ||
      (args[0] === 'run' && (args.includes('operator-backup-archive') || args.includes('operator-backup-restore')))
  );
}

describe('LOCAL-014 backup source guard', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radarist-operator-backup-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function create(runner = new FakeDockerRunner(), profileArgs = DEFAULT_PROFILE_ARGS, env = BACKUP_ENV) {
    const verified = createOperatorNeo4jBackup('before-integrity-repair', profileArgs, outputDir, {
      env,
      runner,
      listeningPorts: () => [],
      sleep: () => undefined,
    });
    return { runner, verified };
  }

  it('refuses to select a graph without an explicit --profile', () => {
    const runner = new FakeDockerRunner();
    expect(() =>
      createOperatorNeo4jBackup('blocked', [], outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('explicit --profile');
    expect(runner.calls).toEqual([]);
  });

  it('refuses ambiguous, unknown, and malformed profile selections before any Docker call', () => {
    const runner = new FakeDockerRunner();
    expect(() =>
      createOperatorNeo4jBackup('blocked', ['--profile', 'default', '--profile=selftest'], outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('exactly once');
    expect(() =>
      createOperatorNeo4jBackup('blocked', ['--profile', 'retained'], outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('Unknown local runtime profile "retained"');
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: { ...BACKUP_ENV, RADARIST_LOCAL_RUNTIME_PORT_OFFSET: 'NaN-ish' },
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('Invalid local runtime port offset');
    expect(runner.calls).toEqual([]);
  });

  it('requires the exact operator confirmation before Docker inspection', () => {
    const runner = new FakeDockerRunner();
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: { NEO4J_URI: BACKUP_ENV.NEO4J_URI },
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('NEO4J_OPERATOR_BACKUP_CONFIRM=backup-radarist-neo4j-offline');
    expect(runner.calls).toEqual([]);
  });

  it('plans a complete backup dry-run without confirmation or Docker or file mutation', () => {
    const runner = new FakeDockerRunner();
    const plannedOutput = path.join(outputDir, 'not-created');
    const plan = planOperatorNeo4jBackup('dry-run', DEFAULT_PROFILE_ARGS, plannedOutput, {
      env: { NEO4J_URI: BACKUP_ENV.NEO4J_URI, NEO4J_DATABASE: 'neo4j' },
      runner,
      listeningPorts: () => [],
    });
    expect(plan).toMatchObject({
      dryRun: true,
      label: 'dry-run',
      target: {
        container: 'radarist-neo4j',
        dataVolume: 'radarist_neo4j_data',
        database: 'neo4j',
      },
      writerPorts: [8288, 9002],
    });
    expect(plan.archivePath).toBe(path.join(plannedOutput, 'neo4j-operator-dry-run.tar.gz'));
    expect(fs.existsSync(plannedOutput)).toBe(false);
    expect(noMutationCalls(runner)).toBe(true);
    expect(runner.isRunning('radarist-neo4j')).toBe(true);
  });

  it('checks the selected profile writer ports, not hard-coded ones', () => {
    const runner = new FakeDockerRunner();
    // Shifted default profile: writers live on 8348 (inngest) and 9062 (app).
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: SHIFTED_BACKUP_ENV,
        runner,
        listeningPorts: () => [9062],
      })
    ).toThrow('writers may be active on ports 9062');
    // The unshifted default writer port being busy is irrelevant for the shifted profile.
    const { verified } = create(new FakeDockerRunner(), DEFAULT_PROFILE_ARGS, {
      ...SHIFTED_BACKUP_ENV,
    });
    expect(verified.manifest.safety.checkedPorts).toEqual([8348, 9062]);
    expect(runner.calls).toEqual([]);
  });

  it.each(['starting', 'unknown'])('refuses a backup source whose Docker health is %s', (health) => {
    const runner = new FakeDockerRunner();
    runner.containers.get('radarist-neo4j')!.health = health;
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
      })
    ).toThrow(`must report healthy, found ${health}`);
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('rechecks writer ports behind a separate exact apply confirmation', () => {
    expect(() =>
      assertOperatorApplyWritersQuiesced({
        env: {},
        listeningPorts: () => [],
      })
    ).toThrow('NEO4J_OPERATOR_APPLY_CONFIRM=graph-integrity-writers-stopped');
    expect(() =>
      assertOperatorApplyWritersQuiesced({
        env: { NEO4J_OPERATOR_APPLY_CONFIRM: 'graph-integrity-writers-stopped' },
        listeningPorts: () => [8288],
      })
    ).toThrow('writers may be active on ports 8288');
    expect(
      assertOperatorApplyWritersQuiesced({
        env: { NEO4J_OPERATOR_APPLY_CONFIRM: 'graph-integrity-writers-stopped' },
        listeningPorts: () => [],
      })
    ).toEqual([8288, 9002]);
  });

  it.each([
    ['remote host', 'bolt://graph.example.test:7687'],
    ['default-mismatched port', 'bolt://127.0.0.1:17687'],
    ['embedded credentials', 'bolt://neo4j:secret@127.0.0.1:7687'],
  ])('rejects a %s NEO4J_URI before accepting the backup source', (_label, uri) => {
    const runner = new FakeDockerRunner();
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: { ...BACKUP_ENV, NEO4J_URI: uri },
        runner,
        listeningPorts: () => [],
      })
    ).toThrow(/NEO4J_URI/);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ['remote host', 'bolt://graph.example.test:7687'],
    ['non-default port', 'bolt://127.0.0.1:17687'],
    ['embedded credentials', 'bolt://neo4j:secret@127.0.0.1:7687'],
  ])('rejects a %s before accepting the protected primary target', (_label, uri) => {
    const runner = new FakeDockerRunner();
    expect(() =>
      assertOperatorPrimaryTarget({
        env: { ...BACKUP_ENV, NEO4J_URI: uri },
        runner,
      })
    ).toThrow(/NEO4J_URI/);
    expect(runner.calls).toEqual([]);
  });

  it('refuses container identity mismatches before stopping anything', () => {
    const scenarios: Array<{ name: string; mutate: (runner: FakeDockerRunner) => void; fragment: string }> = [
      {
        name: 'wrong image',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.image = 'neo4j:4.4.0';
        },
        fragment: 'image "neo4j:4.4.0"',
      },
      {
        name: 'missing runtime label',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.runtimeLabel = '';
        },
        fragment: 'runtime label "<none>"',
      },
      {
        name: 'foreign interface binding',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.hostIp = '0.0.0.0';
        },
        fragment: 'non-loopback interface "0.0.0.0"',
      },
      {
        name: 'wrong host port',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.httpHostPort = '17474';
        },
        fragment: 'publishes host port 17474, expected 7474',
      },
      {
        name: 'partial volume selection',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.mounts = [
            { Destination: '/data', Name: 'radarist_neo4j_data', Type: 'volume' },
          ];
        },
        fragment: 'missing expected volume mount at /logs',
      },
      {
        name: 'unexpected foreign mount',
        mutate: (runner) => {
          runner.containers.get('radarist-neo4j')!.mounts = [
            ...(DEFAULT_VOLUMES.map((v) => ({ Destination: v.destination, Name: v.name, Type: 'volume' }))),
            { Destination: '/var/lib/neo4j/import', Name: 'radarist_neo4j_rc2_import', Type: 'volume' },
          ].filter((m) => m.Destination !== '/var/lib/neo4j/import' || m.Name === 'radarist_neo4j_rc2_import');
        },
        fragment: 'mount /var/lib/neo4j/import must be named volume radarist_neo4j_import',
      },
      {
        name: 'unlabeled data volume',
        mutate: (runner) => {
          runner.volumeLabels.set('radarist_neo4j_data', '');
        },
        fragment: 'volume radarist_neo4j_data has runtime label "<none>"',
      },
      {
        name: 'missing volume',
        mutate: (runner) => {
          runner.volumeLabels.delete('radarist_neo4j_logs');
        },
        fragment: 'volume radarist_neo4j_logs does not exist',
      },
    ];
    for (const scenario of scenarios) {
      const runner = new FakeDockerRunner();
      scenario.mutate(runner);
      expect(() =>
        createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
          env: BACKUP_ENV,
          runner,
          listeningPorts: () => [],
        })
      ).toThrow(scenario.fragment);
      expect(noMutationCalls(runner)).toBe(true);
    }
  });

  it('fails before stop when another running container mounts the profile data volume', () => {
    const runner = new FakeDockerRunner();
    runner.addContainer('volume-thief', {
      mounts: [{ Destination: '/data', Name: 'radarist_neo4j_data', Type: 'volume' }],
    });
    expect(() =>
      createOperatorNeo4jBackup('blocked', DEFAULT_PROFILE_ARGS, outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
      })
    ).toThrow('another running container mounts radarist_neo4j_data: volume-thief');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('writes an owner-only, checksummed, profile-bound manifest and restarts the graph', () => {
    const { runner, verified } = create();
    expect(fs.statSync(verified.archivePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(verified.manifestPath).mode & 0o777).toBe(0o600);
    expect(verified.manifest).toMatchObject({
      schemaVersion: 3,
      kind: 'radarist-neo4j-operator-backup',
      profile: { name: 'default', projectId: 'demo-radarist', portOffset: 0, nameSuffix: '' },
      source: {
        container: 'radarist-neo4j',
        dataVolume: 'radarist_neo4j_data',
        database: 'neo4j',
        databaseId: 'database-id-radarist-neo4j',
        image: IMAGE,
        runtimeLabel: 'durable:default',
        ports: { http: 7474, bolt: 7687 },
        volumes: DEFAULT_VOLUMES,
      },
      archive: { volume: 'radarist_neo4j_data' },
      safety: { offline: true, writersQuiesced: true, checkedPorts: [8288, 9002] },
    });
    expect(verified.manifest.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runner.isRunning('radarist-neo4j')).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop' && args.includes('radarist-neo4j'))).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'start' && args.includes('radarist-neo4j'))).toBe(true);
  });

  it('binds the shifted profile identity into the manifest', () => {
    const { verified } = create(new FakeDockerRunner(), DEFAULT_PROFILE_ARGS, SHIFTED_BACKUP_ENV);
    expect(verified.manifest).toMatchObject({
      profile: { name: 'default', projectId: 'demo-radarist', portOffset: 60, nameSuffix: 'k3test-x' },
      source: {
        container: 'radarist-neo4j-k3test-x',
        dataVolume: 'radarist_neo4j_k3test_x_data',
        runtimeLabel: 'durable:default',
        ports: { http: 7534, bolt: 7747 },
        volumes: SHIFTED_VOLUMES,
      },
      safety: { checkedPorts: [8348, 9062] },
    });
  });

  it('fsyncs the archive and manifest before publishing and the directory before acknowledging', () => {
    const runner = new FakeDockerRunner();
    const durabilityEvents: string[] = [];
    const verified = createOperatorNeo4jBackup('durable', DEFAULT_PROFILE_ARGS, outputDir, {
      env: BACKUP_ENV,
      runner,
      listeningPorts: () => [],
      sleep: () => undefined,
      syncFile: (filePath) => {
        expect(fs.existsSync(filePath)).toBe(true);
        durabilityEvents.push(`file:${path.basename(filePath)}`);
      },
      syncDirectory: (directory) => {
        expect(fs.existsSync(path.join(directory, 'neo4j-operator-durable.tar.gz'))).toBe(true);
        expect(fs.existsSync(path.join(directory, 'neo4j-operator-durable.tar.gz.manifest.json'))).toBe(true);
        durabilityEvents.push(`directory:${directory}`);
      },
    });

    expect(durabilityEvents).toHaveLength(3);
    expect(durabilityEvents[0]).toMatch(/^file:.*partial\.tar\.gz$/);
    expect(durabilityEvents[1]).toMatch(/^file:.*manifest\.json\..*\.partial$/);
    expect(durabilityEvents[2]).toBe(`directory:${path.resolve(outputDir)}`);
    expect(verifyOperatorBackupManifest(verified.manifestPath)).toEqual(verified);
  });

  it('restarts the graph and removes partial artifacts when archiving fails', () => {
    const runner = new FakeDockerRunner();
    runner.archiveError = true;
    expect(() =>
      createOperatorNeo4jBackup('failed', DEFAULT_PROFILE_ARGS, outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
        sleep: () => undefined,
      })
    ).toThrow('[operator-backup] tar failed');
    expect(runner.isRunning('radarist-neo4j')).toBe(true);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('rejects a forced container kill as an offline backup boundary', () => {
    const runner = new FakeDockerRunner();
    runner.containers.get('radarist-neo4j')!.forcedKill = true;
    expect(() =>
      createOperatorNeo4jBackup('forced-stop', DEFAULT_PROFILE_ARGS, outputDir, {
        env: BACKUP_ENV,
        runner,
        listeningPorts: () => [],
        sleep: () => undefined,
      })
    ).toThrow('forcibly killed');
    expect(runner.isRunning('radarist-neo4j')).toBe(true);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });
});

describe('LOCAL-014 manifest verification', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radarist-operator-verify-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function createVerified() {
    const runner = new FakeDockerRunner();
    const verified = createOperatorNeo4jBackup('verify-target', DEFAULT_PROFILE_ARGS, outputDir, {
      env: BACKUP_ENV,
      runner,
      listeningPorts: () => [],
      sleep: () => undefined,
    });
    return verified;
  }

  function rewriteManifest(manifestPath: string, mutator: (manifest: Record<string, unknown>) => void): void {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    mutator(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    fs.chmodSync(manifestPath, 0o600);
  }

  it('is idempotent and performs no mutation', () => {
    const verified = createVerified();
    const first = verifyOperatorBackupManifest(verified.manifestPath);
    const second = verifyOperatorBackupManifest(verified.manifestPath);
    expect(second).toEqual(first);
    expect(second.manifestPath).toBe(first.manifestPath);
    expect(second.archivePath).toBe(first.archivePath);
  });

  it('detects archive tampering through checksum and size', () => {
    const verified = createVerified();
    fs.appendFileSync(verified.archivePath, 'tampered');
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('archive size does not match');
  });

  it('detects same-size archive corruption through the checksum', () => {
    const verified = createVerified();
    const contents = fs.readFileSync(verified.archivePath);
    contents[0] = contents[0] ^ 0xff;
    fs.writeFileSync(verified.archivePath, contents, { mode: 0o600 });
    fs.chmodSync(verified.archivePath, 0o600);
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('archive checksum does not match');
  });

  it('rejects manifest archive path traversal', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      (manifest.archive as { fileName: string }).fileName = '../backup.tar.gz';
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('fileName must be a basename');
  });

  it('rejects a stale schema-version manifest', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      manifest.schemaVersion = 2;
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('unsupported or incomplete schema');
  });

  it('rejects a manifest missing required source identity fields', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      delete (manifest.source as Record<string, unknown>).databaseId;
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('unsupported or incomplete schema');
  });

  it('rejects a manifest whose source diverges from the canonical profile derivation', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      (manifest.source as { container: string }).container = 'radarist-neo4j-foreign';
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow(
      'container does not match the canonical profile derivation'
    );
  });

  it('rejects a manifest whose runtime label diverges from its profile', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      (manifest.source as { runtimeLabel: string }).runtimeLabel = 'durable:selftest';
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow(
      'runtime label does not match the canonical profile derivation'
    );
  });

  it('rejects a manifest with an inconsistent /data volume identity', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      (manifest.source as { dataVolume: string }).dataVolume = 'radarist_neo4j_other_data';
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow('/data volume identity is inconsistent');
  });

  it('rejects a manifest whose volumes omit a profile-owned volume', () => {
    const verified = createVerified();
    rewriteManifest(verified.manifestPath, (manifest) => {
      const source = manifest.source as { volumes: Array<{ name: string; destination: string }> };
      source.volumes = source.volumes.filter((volume) => volume.destination !== '/logs');
    });
    expect(() => verifyOperatorBackupManifest(verified.manifestPath)).toThrow(
      'volumes do not match the canonical profile derivation'
    );
  });
});

describe('LOCAL-014 disposable restore guard', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radarist-operator-restore-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function createVerified() {
    const runner = new FakeDockerRunner();
    const verified = createOperatorNeo4jBackup('restore-target', DEFAULT_PROFILE_ARGS, outputDir, {
      env: BACKUP_ENV,
      runner,
      listeningPorts: () => [],
      sleep: () => undefined,
    });
    return { runner, verified };
  }

  it('refuses restore without an explicit --profile', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, [], {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
      })
    ).toThrow('explicit --profile');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore without the exact restore confirmation', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: { NEO4J_URI: DISPOSABLE_RESTORE_ENV.NEO4J_URI },
        runner,
      })
    ).toThrow('NEO4J_OPERATOR_RESTORE_CONFIRM=replace-disposable-neo4j-data');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('plans a complete restore dry-run without confirmation or Docker mutation', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    const plan = planOperatorBackupRestoreToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
      env: { NEO4J_URI: DISPOSABLE_RESTORE_ENV.NEO4J_URI, NEO4J_DATABASE: 'neo4j' },
      runner,
      listeningPorts: () => [],
    });
    expect(plan).toMatchObject({
      dryRun: true,
      target: {
        container: 'radarist-neo4j-selftest',
        dataVolume: 'radarist_neo4j_selftest_data',
        database: 'neo4j',
      },
      writerPorts: [9012, 18288],
    });
    expect(noMutationCalls(runner)).toBe(true);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(true);
  });

  it('refuses restore while a selected-profile writer port is active', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        listeningPorts: () => [18288],
      })
    ).toThrow('writers may be active on ports 18288');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore into a target without a disposable marker (protected default)', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, DEFAULT_PROFILE_ARGS, {
        env: { ...DISPOSABLE_RESTORE_ENV, NEO4J_URI: 'bolt://127.0.0.1:7687' },
        runner,
      })
    ).toThrow('does not resolve to a proven disposable target');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore into a retained-style shifted default without a marker', () => {
    const { runner, verified } = createVerified();
    runner.addContainer('radarist-neo4j-rc2', {
      httpHostPort: '7494',
      boltHostPort: '7707',
      mounts: [
        { Destination: '/data', Name: 'radarist_neo4j_rc2_data', Type: 'volume' },
        { Destination: '/logs', Name: 'radarist_neo4j_rc2_logs', Type: 'volume' },
        { Destination: '/var/lib/neo4j/import', Name: 'radarist_neo4j_rc2_import', Type: 'volume' },
        { Destination: '/plugins', Name: 'radarist_neo4j_rc2_plugins', Type: 'volume' },
      ],
    });
    for (const volume of ['data', 'logs', 'import', 'plugins']) {
      runner.volumeLabels.set(`radarist_neo4j_rc2_${volume}`, 'durable:default');
    }
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, DEFAULT_PROFILE_ARGS, {
        env: {
          ...DISPOSABLE_RESTORE_ENV,
          RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '20',
          RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: 'rc2',
          NEO4J_URI: 'bolt://127.0.0.1:7707',
        },
        runner,
      })
    ).toThrow('does not resolve to a proven disposable target');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore when the target database does not match the manifest', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: { ...DISPOSABLE_RESTORE_ENV, NEO4J_DATABASE: 'otherdb' },
        runner,
      })
    ).toThrow('database does not match');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore when the target container identity mismatches the profile', () => {
    const { runner, verified } = createVerified();
    runner.containers.get('radarist-neo4j-selftest')!.boltHostPort = '7699';
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
      })
    ).toThrow('does not match the selected selftest runtime profile');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('refuses restore while another running container mounts the disposable volume', () => {
    const { runner, verified } = createVerified();
    runner.addContainer('disposable-volume-thief', {
      mounts: [{ Destination: '/data', Name: 'radarist_neo4j_selftest_data', Type: 'volume' }],
    });
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
      })
    ).toThrow('another running container mounts radarist_neo4j_selftest_data: disposable-volume-thief');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('checks archive contents before stopping the disposable target', () => {
    const { runner, verified } = createVerified();
    runner.archiveListing = './databases/system/neostore\n';
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
      })
    ).toThrow('does not contain database neo4j');
    expect(noMutationCalls(runner)).toBe(true);
  });

  it('restores a verified backup into the proven disposable profile and reads back identity', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    expect(
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        sleep: () => undefined,
      })
    ).toBe(true);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop' && args.includes('radarist-neo4j-selftest'))).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop' && args.includes('radarist-neo4j'))).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes('operator-backup-restore'))).toBe(true);
    // The read-back used the restored container's own database identity.
    const readback = runner.calls.find(({ args }) => args[0] === 'exec' && args.includes('database-id-read'));
    expect(readback?.args[1]).toBe('radarist-neo4j-selftest');
  });

  it('stops the target and fails when the read-back identity does not match the manifest', () => {
    const { runner, verified } = createVerified();
    // Simulate a swapped/foreign archive: the volume contents carry a database
    // identity that does not match the manifest's recorded source identity.
    runner.archivedDatabaseId = 'database-id-foreign';
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        sleep: () => undefined,
      })
    ).toThrow('must not be treated as healthy');
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
  });

  it('leaves the disposable target stopped when replacement fails', () => {
    const { runner, verified } = createVerified();
    runner.restoreError = true;
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        sleep: () => undefined,
      })
    ).toThrow('was left stopped');
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
    expect(runner.isRunning('radarist-neo4j')).toBe(true);
  });

  it('rechecks archive size and checksum after stop before deleting target data', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    runner.afterStop = () => {
      fs.appendFileSync(verified.archivePath, 'changed-after-plan');
      runner.afterStop = undefined;
    };
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        listeningPorts: () => [],
        sleep: () => undefined,
      })
    ).toThrow('archive size changed after restore planning');
    expect(runner.calls.some(({ args }) => args.includes('operator-backup-restore'))).toBe(false);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(true);
  });

  it('rechecks exclusive volume ownership after stop before deleting target data', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    runner.afterStop = () => {
      runner.addContainer('late-volume-thief', {
        mounts: [{ Destination: '/data', Name: 'radarist_neo4j_selftest_data', Type: 'volume' }],
      });
      runner.afterStop = undefined;
    };
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        listeningPorts: () => [],
        sleep: () => undefined,
      })
    ).toThrow('another running container mounts radarist_neo4j_selftest_data: late-volume-thief');
    expect(runner.calls.some(({ args }) => args.includes('operator-backup-restore'))).toBe(false);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
  });

  it('rechecks writer quiescence after stop immediately before deleting target data', () => {
    const { runner, verified } = createVerified();
    runner.calls = [];
    let writerProbe = 0;
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        listeningPorts: () => {
          writerProbe += 1;
          return writerProbe === 1 ? [] : [18288];
        },
        sleep: () => undefined,
      })
    ).toThrow('writers may be active on ports 18288');
    expect(writerProbe).toBe(2);
    expect(runner.calls.some(({ args }) => args.includes('operator-backup-restore'))).toBe(false);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
  });

  it('restores a stopped target and returns it to a stopped, verified state', () => {
    const { runner, verified } = createVerified();
    runner.containers.get('radarist-neo4j-selftest')!.running = false;
    runner.databaseIds.set('radarist-neo4j-selftest', 'database-id-radarist-neo4j');
    runner.calls = [];
    expect(
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        sleep: () => undefined,
      })
    ).toBe(true);
    // Booted for verification, then returned to stopped.
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === 'start' && args.includes('radarist-neo4j-selftest'))).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === 'stop' && args.includes('radarist-neo4j-selftest'))).toBe(true);
  });

  it('does not declare a restarted target ready while Docker health is still starting', () => {
    const { runner, verified } = createVerified();
    runner.containers.get('radarist-neo4j-selftest')!.healthAfterStart = 'starting';
    runner.calls = [];
    expect(() =>
      restoreOperatorBackupToDisposable(verified.manifestPath, SELFTEST_PROFILE_ARGS, {
        env: DISPOSABLE_RESTORE_ENV,
        runner,
        listeningPorts: () => [],
        sleep: () => {
          throw new Error('health wait observed');
        },
      })
    ).toThrow('health wait observed');
    expect(
      runner.calls.some(
        ({ args }) => args[0] === 'exec' && args.includes('wget') && args.includes('http://127.0.0.1:7474')
      )
    ).toBe(false);
    expect(runner.isRunning('radarist-neo4j-selftest')).toBe(false);
  });
});
