/**
 * @jest-environment node
 *
 * `demo:reset` must never let one local profile delete another profile's
 * checkpoints, runtime files, or graph volume by accident.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  deriveResetTargets,
  parseDemoResetOptions,
  runDemoReset,
} from '../demo-reset';
import {
  firebaseOnlyResetMarkerPath,
  writeFirebaseOnlyResetMarker,
} from '../lib/local-reset-marker';
import { deriveLocalRuntimePaths } from '../lib/local-runtime-profile';

describe('demo:reset profile safety', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repositoryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'radarist-demo-reset-'));
    roots.push(root);
    return root;
  }

  it('derives only the canonical private root for the selected profile', () => {
    const root = repositoryRoot();
    const defaultTargets = deriveResetTargets('default', root);
    const selftestTargets = deriveResetTargets('selftest', root);

    expect(defaultTargets.container).toBe('radarist-neo4j');
    expect(defaultTargets.migrationBackupContainer).toBe(
      'radarist-neo4j-legacy-gds-migration'
    );
    expect(defaultTargets.volumes).toEqual([
      'radarist_neo4j_data',
      'radarist_neo4j_logs',
      'radarist_neo4j_import',
      'radarist_neo4j_plugins',
    ]);
    expect(defaultTargets.directories).toEqual([join(root, 'emulator-data', 'default')]);
    expect(selftestTargets.container).toBe('radarist-neo4j-selftest');
    expect(selftestTargets.migrationBackupContainer).toBe(
      'radarist-neo4j-selftest-legacy-gds-migration'
    );
    expect(selftestTargets.directories).toEqual([join(root, 'emulator-data', 'selftest')]);
    expect(defaultTargets.directories).not.toContain(join(root, 'tmp', 'local-demo'));
  });

  it('is a dry run by default and requires exact profile confirmation to apply', () => {
    const preview = parseDemoResetOptions(['--profile', 'selftest']);
    expect(preview).toMatchObject({
      profile: { name: 'selftest' },
      apply: false,
      includeNeo4j: false,
      firebaseOnly: false,
    });
    expect(() =>
      parseDemoResetOptions(['--profile', 'selftest', '--apply'])
    ).toThrow(/--confirm-profile selftest/);
    expect(() =>
      parseDemoResetOptions(['--apply', '--confirm-profile', 'default'])
    ).toThrow(/Select --profile explicitly/);
    expect(() =>
      parseDemoResetOptions([
        '--profile',
        'selftest',
        '--apply',
        '--confirm-profile',
        'default',
      ])
    ).toThrow(/Destructive reset refused/);
    expect(() =>
      parseDemoResetOptions([
        '--profile=selftest',
        '--apply',
        '--confirm-profile=selftest',
      ])
    ).toThrow(/Choose --include-neo4j.*--firebase-only/);
    expect(
      parseDemoResetOptions([
        '--profile=selftest',
        '--apply',
        '--confirm-profile=selftest',
        '--firebase-only',
      ]).apply
    ).toBe(true);
    expect(() =>
      parseDemoResetOptions(['--profile=selftest', '--include-neo4j', '--firebase-only'])
    ).toThrow(/exactly one reset scope/);
  });

  it('rejects unknown profiles, duplicate selectors, conflicting modes, and typoed flags', () => {
    expect(() => parseDemoResetOptions(['--profile', 'production'])).toThrow(
      /Unknown local runtime profile/
    );
    expect(() =>
      parseDemoResetOptions(['--profile', 'default', '--profile', 'selftest'])
    ).toThrow(/Specify --profile exactly once/);
    expect(() => parseDemoResetOptions(['--apply', '--dry-run'])).toThrow(
      /either --apply or --dry-run/
    );
    expect(() => parseDemoResetOptions(['--aplly'])).toThrow(/Unknown demo:reset argument/);
  });

  it('does not mutate either profile during a preview, including a Neo4j preview', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    const other = join(root, 'emulator-data', 'default');
    mkdirSync(selected, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(selected, 'marker'), 'selected');
    writeFileSync(join(other, 'marker'), 'other');
    const dockerCalls: string[][] = [];

    const result = runDemoReset(
      parseDemoResetOptions(['--profile', 'selftest', '--include-neo4j']),
      root,
      {
        dockerAvailable: () => true,
        dockerCommand: (args) => {
          dockerCalls.push([...args]);
          return {
            ok: true,
            stderr: '',
            stdout: args[0] === 'ps' ? 'radarist-neo4j-selftest' : 'durable:selftest',
          };
        },
        pathExists: () => true,
        removeDirectory: () => {
          throw new Error('dry-run attempted a removal');
        },
      }
    );

    expect(result.dryRun).toBe(true);
    expect(result.planned).toContain('Docker volume radarist_neo4j_selftest_data');
    expect(dockerCalls).toEqual([]);
    expect(readFileSync(join(selected, 'marker'), 'utf8')).toBe('selected');
    expect(readFileSync(join(other, 'marker'), 'utf8')).toBe('other');
  });

  it('removes exactly the confirmed Firebase root and leaves a durable preserved-graph marker', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    const other = join(root, 'emulator-data', 'default');
    mkdirSync(join(selected, 'runtime'), { recursive: true });
    mkdirSync(join(selected, 'checkpoints'), { recursive: true });
    mkdirSync(join(selected, 'exports'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'marker'), 'other');
    const dockerCalls: string[][] = [];

    const result = runDemoReset(
      parseDemoResetOptions([
        '--profile',
        'selftest',
        '--apply',
        '--confirm-profile',
        'selftest',
        '--firebase-only',
      ]),
      root,
      {
        dockerAvailable: () => true,
        dockerCommand: (args) => {
          dockerCalls.push([...args]);
          return { ok: true, stderr: '' };
        },
        pathExists: (path) => path === selected,
        removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
      }
    );

    expect(result.removed).toEqual(['Profile data ./emulator-data/selftest']);
    expect(dockerCalls).toEqual([]);
    expect(existsSync(selected)).toBe(false);
    expect(
      existsSync(
        firebaseOnlyResetMarkerPath(deriveLocalRuntimePaths(root, 'selftest'))
      )
    ).toBe(true);
    expect(readFileSync(join(other, 'marker'), 'utf8')).toBe('other');
  });

  it('requires the separate Neo4j opt-in before issuing exact profile Docker commands', () => {
    const root = repositoryRoot();
    const paths = deriveLocalRuntimePaths(root, 'selftest');
    const marker = writeFirebaseOnlyResetMarker(paths);
    const dockerCalls: string[][] = [];
    const result = runDemoReset(
      parseDemoResetOptions([
        '--profile',
        'selftest',
        '--apply',
        '--confirm-profile',
        'selftest',
        '--include-neo4j',
      ]),
      root,
      {
        dockerAvailable: () => true,
        dockerCommand: (args) => {
          dockerCalls.push([...args]);
          return {
            ok: true,
            stderr: '',
            stdout: args[0] === 'ps' ? 'radarist-neo4j-selftest' : 'durable:selftest',
          };
        },
        pathExists: () => false,
        removeDirectory: () => undefined,
      }
    );

    expect(result.removed).toContain('Docker volume radarist_neo4j_selftest_data');
    expect(existsSync(marker)).toBe(false);
    expect(dockerCalls).toEqual([
      [
        'container',
        'inspect',
        '--format',
        '{{index .Config.Labels "com.radarist.local-runtime"}}',
        'radarist-neo4j-selftest',
      ],
      [
        'container',
        'inspect',
        '--format',
        '{{index .Config.Labels "com.radarist.local-runtime"}}',
        'radarist-neo4j-selftest-legacy-gds-migration',
      ],
      [
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "com.radarist.local-runtime"}}',
        'radarist_neo4j_selftest_data',
      ],
      [
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "com.radarist.local-runtime"}}',
        'radarist_neo4j_selftest_logs',
      ],
      [
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "com.radarist.local-runtime"}}',
        'radarist_neo4j_selftest_import',
      ],
      [
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "com.radarist.local-runtime"}}',
        'radarist_neo4j_selftest_plugins',
      ],
      [
        'ps',
        '--all',
        '--filter',
        'volume=radarist_neo4j_selftest_data',
        '--format',
        '{{.Names}}',
      ],
      [
        'ps',
        '--all',
        '--filter',
        'volume=radarist_neo4j_selftest_logs',
        '--format',
        '{{.Names}}',
      ],
      [
        'ps',
        '--all',
        '--filter',
        'volume=radarist_neo4j_selftest_import',
        '--format',
        '{{.Names}}',
      ],
      [
        'ps',
        '--all',
        '--filter',
        'volume=radarist_neo4j_selftest_plugins',
        '--format',
        '{{.Names}}',
      ],
      ['rm', '-f', 'radarist-neo4j-selftest'],
      ['rm', '-f', 'radarist-neo4j-selftest-legacy-gds-migration'],
      ['volume', 'rm', 'radarist_neo4j_selftest_data'],
      ['volume', 'rm', 'radarist_neo4j_selftest_logs'],
      ['volume', 'rm', 'radarist_neo4j_selftest_import'],
      ['volume', 'rm', 'radarist_neo4j_selftest_plugins'],
    ]);
  });

  it('removes an ownership-verified interrupted migration backup before its volumes', () => {
    const root = repositoryRoot();
    const backup = 'radarist-neo4j-selftest-legacy-gds-migration';
    const dockerCalls: string[][] = [];
    const result = runDemoReset(
      parseDemoResetOptions([
        '--profile',
        'selftest',
        '--apply',
        '--confirm-profile',
        'selftest',
        '--include-neo4j',
      ]),
      root,
      {
        dockerAvailable: () => true,
        dockerCommand: (args) => {
          dockerCalls.push([...args]);
          if (
            args[0] === 'container' &&
            args.at(-1) === 'radarist-neo4j-selftest'
          ) {
            return {
              ok: false,
              missing: true,
              stderr: 'No such container',
              stdout: '',
            };
          }
          if (args[0] === 'ps') {
            return { ok: true, stderr: '', stdout: backup };
          }
          return { ok: true, stderr: '', stdout: 'durable:selftest' };
        },
        pathExists: () => false,
        removeDirectory: () => undefined,
      }
    );

    expect(result.removed).toContain(
      `Neo4j migration backup container ${backup}`
    );
    expect(result.skipped).toContain(
      'Neo4j container radarist-neo4j-selftest (not present)'
    );
    const removeBackup = dockerCalls.findIndex(
      (args) => args[0] === 'rm' && args.at(-1) === backup
    );
    const removeFirstVolume = dockerCalls.findIndex(
      (args) => args[0] === 'volume' && args[1] === 'rm'
    );
    expect(removeBackup).toBeGreaterThan(-1);
    expect(removeBackup).toBeLessThan(removeFirstVolume);
  });

  it('refuses all deletion before the first Docker mutation when any volume has a foreign referrer', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    mkdirSync(selected, { recursive: true });
    const dockerCalls: string[][] = [];
    let filesystemRemoved = false;

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => true,
          dockerCommand: (args) => {
            dockerCalls.push([...args]);
            if (args[0] === 'ps') {
              return {
                ok: true,
                stderr: '',
                stdout: args[3] === 'volume=radarist_neo4j_selftest_logs'
                  ? 'foreign-container'
                  : 'radarist-neo4j-selftest',
              };
            }
            return { ok: true, stderr: '', stdout: 'durable:selftest' };
          },
          pathExists: (path) => path === selected,
          removeDirectory: () => {
            filesystemRemoved = true;
          },
        }
      )
    ).toThrow(/unexpected container.*Nothing was removed/);

    expect(dockerCalls.some((args) => args[0] === 'rm')).toBe(false);
    expect(dockerCalls.some((args) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
    expect(filesystemRemoved).toBe(false);
    expect(existsSync(selected)).toBe(true);
  });

  it('fails before deleting Firebase when an explicitly requested graph reset cannot be preflighted', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    mkdirSync(selected, { recursive: true });
    let filesystemRemoved = false;

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => true,
          dockerCommand: () => ({ ok: false, stderr: 'daemon inspection failed' }),
          pathExists: (path) => path === selected,
          removeDirectory: () => {
            filesystemRemoved = true;
          },
        }
      )
    ).toThrow(/Nothing was removed/);
    expect(filesystemRemoved).toBe(false);
    expect(existsSync(selected)).toBe(true);
  });

  it('refuses same-named Docker resources without the selected profile ownership label', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    mkdirSync(selected, { recursive: true });

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => true,
          dockerCommand: () => ({ ok: true, stderr: '', stdout: 'durable:default' }),
          pathExists: (path) => path === selected,
          removeDirectory: () => {
            throw new Error('unowned target attempted a removal');
          },
        }
      )
    ).toThrow(/Refusing unowned Neo4j container/);
    expect(existsSync(selected)).toBe(true);
  });

  it('fails before deleting Firebase when Docker is unavailable for a requested graph reset', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    mkdirSync(selected, { recursive: true });

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => false,
          dockerCommand: () => ({ ok: true, stderr: '' }),
          pathExists: (path) => path === selected,
          removeDirectory: () => {
            throw new Error('filesystem deletion should not run');
          },
        }
      )
    ).toThrow(/Docker is not available/);
    expect(existsSync(selected)).toBe(true);
  });

  it('refuses to delete data or Docker volumes while the selected profile is running', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    const processManifest = join(selected, 'runtime', 'pids', 'processes.json');
    mkdirSync(join(selected, 'runtime', 'pids'), { recursive: true });
    writeFileSync(processManifest, '{}');
    const dockerCalls: string[][] = [];

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => true,
          dockerCommand: (args) => {
            dockerCalls.push([...args]);
            return { ok: true, stderr: '' };
          },
          pathExists: (path) => path === selected || path === processManifest,
          removeDirectory: () => {
            throw new Error('active profile attempted a removal');
          },
        }
      )
    ).toThrow(/runtime process manifest is present/);
    expect(dockerCalls).toEqual([]);
    expect(existsSync(selected)).toBe(true);
  });

  it('fails closed when a runtime lease remains without a process manifest', () => {
    const root = repositoryRoot();
    const selected = join(root, 'emulator-data', 'selftest');
    const runtimeLease = join(selected, 'runtime', 'pids', 'lifetime.lock');
    mkdirSync(join(selected, 'runtime', 'pids'), { recursive: true });
    writeFileSync(runtimeLease, '{}');
    const dockerCalls: string[][] = [];

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--include-neo4j',
        ]),
        root,
        {
          dockerAvailable: () => true,
          dockerCommand: (args) => {
            dockerCalls.push([...args]);
            return { ok: true, stderr: '' };
          },
          pathExists: (path) => path === selected || path === runtimeLease,
          removeDirectory: () => {
            throw new Error('leased profile attempted a removal');
          },
        }
      )
    ).toThrow(/runtime lease is present/);
    expect(dockerCalls).toEqual([]);
    expect(existsSync(selected)).toBe(true);
  });

  it('refuses a symlinked profile root instead of following it', () => {
    const root = repositoryRoot();
    const outside = join(root, 'outside');
    const dataRoot = join(root, 'emulator-data');
    mkdirSync(outside);
    mkdirSync(dataRoot);
    writeFileSync(join(outside, 'marker'), 'keep');
    symlinkSync(outside, join(dataRoot, 'selftest'));

    expect(() =>
      runDemoReset(
        parseDemoResetOptions([
          '--profile',
          'selftest',
          '--apply',
          '--confirm-profile',
          'selftest',
          '--firebase-only',
        ]),
        root
      )
    ).toThrow(/symbolic-link selftest profile root/);
    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('keep');
  });

  it('rechecks authorization at execution time for programmatic callers', () => {
    const options = parseDemoResetOptions(['--profile', 'default']);
    expect(() =>
      runDemoReset({ ...options, apply: true, confirmedProfile: 'selftest' }, repositoryRoot())
    ).toThrow(/profile confirmation does not match/);
  });
});
