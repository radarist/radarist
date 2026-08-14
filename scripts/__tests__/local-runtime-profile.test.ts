/**
 * @jest-environment node
 */

import { existsSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LOCAL_RUNTIME_PORT_NAMES,
  LOCAL_RUNTIME_PROFILES,
  assertLocalRuntimePathContained,
  assertNoLocalRuntimePortCollisions,
  buildLocalRuntimeExecutionContext,
  createEphemeralLocalRuntimeExecutionContext,
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
  findLocalRuntimePortCollisions,
  findOccupiedLocalRuntimePorts,
  buildLocalRuntimeProfiles,
  deriveLocalRuntimeNeo4jDockerIdentity,
  getLocalRuntimeProfile,
  parseLocalRuntimeProfileArg,
  resolveLocalRuntimeNameSuffix,
  resolveLocalRuntimePortOffset,
  removeEphemeralLocalRuntimeSession,
  removeStaleEphemeralLocalRuntimeSessions,
  type LocalRuntimeProfile,
} from '../lib/local-runtime-profile';

describe('LOCAL-007 local runtime profile contract', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'radarist-runtime-profile-'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('defaults only when the profile selector is absent and rejects unknown explicit names', () => {
    expect(parseLocalRuntimeProfileArg([])).toBe(LOCAL_RUNTIME_PROFILES.default);
    expect(parseLocalRuntimeProfileArg(['--blank', '--profile', 'selftest'])).toBe(LOCAL_RUNTIME_PROFILES.selftest);
    expect(parseLocalRuntimeProfileArg(['--profile=selftest'])).toBe(LOCAL_RUNTIME_PROFILES.selftest);

    expect(() => getLocalRuntimeProfile('windows')).toThrow('Unknown local runtime profile "windows"');
    expect(() => parseLocalRuntimeProfileArg(['--profile'])).toThrow('requires an explicit profile name');
    expect(() => parseLocalRuntimeProfileArg(['--profile='])).toThrow('requires an explicit profile name');
    expect(() => parseLocalRuntimeProfileArg(['--profile', 'default', '--profile=selftest'])).toThrow('exactly once');
  });

  it('owns every explicit product and Firebase auxiliary port without checked-in collisions', () => {
    expect(LOCAL_RUNTIME_PORT_NAMES).toEqual([
      'app',
      'inngest',
      'firebaseUi',
      'firebaseFirestoreWebsocket',
      'firebaseHub',
      'firebaseLogging',
      'firestore',
      'auth',
      'storage',
      'neo4jHttp',
      'neo4jBolt',
    ]);
    expect(LOCAL_RUNTIME_PROFILES.default.ports.firebaseHub).toBe(4400);
    expect(LOCAL_RUNTIME_PROFILES.default.ports.firebaseLogging).toBe(4500);
    expect(LOCAL_RUNTIME_PROFILES.default.ports.firebaseFirestoreWebsocket).toBe(9150);
    expect(LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseHub).toBe(14400);
    expect(LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseLogging).toBe(14500);
    expect(LOCAL_RUNTIME_PROFILES.selftest.ports.firebaseFirestoreWebsocket).toBe(14150);
    expect(findLocalRuntimePortCollisions(Object.values(LOCAL_RUNTIME_PROFILES))).toEqual([]);
    expect(() => assertNoLocalRuntimePortCollisions(Object.values(LOCAL_RUNTIME_PROFILES))).not.toThrow();
  });

  it('reports collisions with both owners instead of silently rebinding a Firebase port', () => {
    const colliding: LocalRuntimeProfile = {
      ...LOCAL_RUNTIME_PROFILES.selftest,
      ports: {
        ...LOCAL_RUNTIME_PROFILES.selftest.ports,
        firebaseHub: LOCAL_RUNTIME_PROFILES.default.ports.app,
      },
    };

    expect(findLocalRuntimePortCollisions([LOCAL_RUNTIME_PROFILES.default, colliding])).toEqual([
      {
        port: 9002,
        claims: [
          { profileName: 'default', name: 'app', port: 9002 },
          { profileName: 'selftest', name: 'firebaseHub', port: 9002 },
        ],
      },
    ]);
    expect(() => assertNoLocalRuntimePortCollisions([LOCAL_RUNTIME_PROFILES.default, colliding])).toThrow(
      'default.app, selftest.firebaseHub'
    );
  });

  it('probes the complete inventory and reports occupied names deterministically', async () => {
    const probed: number[] = [];
    const occupied = await findOccupiedLocalRuntimePorts(LOCAL_RUNTIME_PROFILES.default, async (host, port) => {
      expect(host).toBe('127.0.0.1');
      probed.push(port);
      return port === 4400 || port === 9199;
    });

    expect(probed).toHaveLength(LOCAL_RUNTIME_PORT_NAMES.length);
    expect(occupied).toEqual([
      { profileName: 'default', name: 'firebaseHub', port: 4400 },
      { profileName: 'default', name: 'storage', port: 9199 },
    ]);
  });

  it('creates a profile-owned 0700 layout and relocates temp, Storage, home, cache, status, and PID state', () => {
    const dataRoot = join(sandbox, 'emulator-data');
    const paths = deriveLocalRuntimePaths(sandbox, 'selftest', dataRoot);
    ensurePrivateLocalRuntimeLayout(paths);

    expect(paths.root).toBe(join(dataRoot, 'selftest'));
    expect(paths.storageBlobs).toBe(join(paths.temp, 'firebase', 'storage', 'blobs'));
    expect(paths.processManifest).toBe(join(paths.pids, 'processes.json'));
    expect(paths.runtimeLease).toBe(join(paths.pids, 'lifetime.lock'));
    for (const directory of [
      paths.root,
      paths.runtime,
      paths.home,
      paths.temp,
      paths.storageBlobs,
      paths.workingDirectory,
      paths.exports,
      paths.checkpoints,
      paths.status,
      paths.pids,
      paths.logs,
      paths.config,
      paths.cache,
    ]) {
      expect(lstatSync(directory).isDirectory()).toBe(true);
      expect(lstatSync(directory).isSymbolicLink()).toBe(false);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(assertLocalRuntimePathContained(paths, directory)).toBe(resolve(directory));
    }

    const context = buildLocalRuntimeExecutionContext(paths, { PATH: '/usr/bin' });
    expect(context.cwd).toBe(paths.workingDirectory);
    expect(context.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: paths.home,
      TMPDIR: paths.temp,
      TMP: paths.temp,
      TEMP: paths.temp,
      XDG_CONFIG_HOME: paths.config,
      XDG_CACHE_HOME: paths.cache,
      RADARIST_LOCAL_RUNTIME_PROFILE: 'selftest',
      RADARIST_LOCAL_RUNTIME_ROOT: paths.root,
    });
  });

  it('rejects lexical escapes and existing symlinks beneath the profile root', () => {
    const paths = deriveLocalRuntimePaths(sandbox, 'default');
    ensurePrivateLocalRuntimeLayout(paths);
    expect(() => assertLocalRuntimePathContained(paths, join(paths.root, '..', 'selftest'))).toThrow('must be a child');

    rmSync(paths.storageBlobs, { recursive: true, force: true });
    const outside = join(sandbox, 'outside-storage');
    symlinkSync(outside, paths.storageBlobs, 'dir');
    expect(() => ensurePrivateLocalRuntimeLayout(paths)).toThrow('must not be a symbolic link');
  });

  it('gives every ephemeral launch a fresh private execution tree and removes only that tree', () => {
    const paths = ensurePrivateLocalRuntimeLayout(deriveLocalRuntimePaths(sandbox, 'default'));
    const first = createEphemeralLocalRuntimeExecutionContext(paths, { PATH: '/bin' }, 'run-one');
    const second = createEphemeralLocalRuntimeExecutionContext(paths, { PATH: '/bin' }, 'run-two');

    expect(first.sessionRoot).not.toBe(second.sessionRoot);
    expect(first.context.cwd).toBe(first.paths.workingDirectory);
    expect(first.context.env).toMatchObject({
      HOME: first.paths.home,
      TMPDIR: first.paths.temp,
      XDG_CONFIG_HOME: first.paths.config,
      XDG_CACHE_HOME: first.paths.cache,
    });
    expect(second.context.env.TMPDIR).toBe(second.paths.temp);
    expect(first.paths.storageBlobs).not.toBe(second.paths.storageBlobs);
    expect(statSync(first.sessionRoot).mode & 0o777).toBe(0o700);

    removeEphemeralLocalRuntimeSession(paths, first.sessionRoot);
    expect(existsSync(first.sessionRoot)).toBe(false);
    expect(existsSync(second.sessionRoot)).toBe(true);
    expect(removeStaleEphemeralLocalRuntimeSessions(paths)).toEqual(['ephemeral-run-two']);
    expect(existsSync(second.sessionRoot)).toBe(false);
    expect(existsSync(paths.checkpoints)).toBe(true);
  });

  it('refuses all stale ephemeral cleanup when any candidate is a symlink', () => {
    const paths = ensurePrivateLocalRuntimeLayout(deriveLocalRuntimePaths(sandbox, 'selftest'));
    const valid = createEphemeralLocalRuntimeExecutionContext(paths, {}, 'valid');
    const outside = join(sandbox, 'outside-ephemeral');
    symlinkSync(outside, join(paths.runtime, 'ephemeral-link'), 'dir');

    expect(() => removeStaleEphemeralLocalRuntimeSessions(paths)).toThrow('must be real directories');
    expect(existsSync(valid.sessionRoot)).toBe(true);
  });
});

describe('TEST-024 disposable runtime overrides', () => {
  it('resolves no port offset and no name suffix when the env vars are unset', () => {
    expect(resolveLocalRuntimePortOffset({})).toBe(0);
    expect(resolveLocalRuntimeNameSuffix({})).toBe('');
  });

  it('parses a valid port offset and rejects malformed or oversized values', () => {
    expect(resolveLocalRuntimePortOffset({ RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '20000' })).toBe(20_000);
    // Empty string is "unset" — consistent with the sibling override resolvers.
    expect(resolveLocalRuntimePortOffset({ RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '' })).toBe(0);
    for (const bad of ['abc', '-5', '1.5', '40001', '999999']) {
      expect(() => resolveLocalRuntimePortOffset({ RADARIST_LOCAL_RUNTIME_PORT_OFFSET: bad })).toThrow(/port offset/i);
    }
  });

  it('shifts every port of both profiles by the offset without collisions', () => {
    const profiles = buildLocalRuntimeProfiles({ RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '20000' });
    for (const name of LOCAL_RUNTIME_PORT_NAMES) {
      expect(profiles.default.ports[name]).toBe(LOCAL_RUNTIME_PROFILES.default.ports[name] + 20_000);
      expect(profiles.selftest.ports[name]).toBe(LOCAL_RUNTIME_PROFILES.selftest.ports[name] + 20_000);
    }
    expect(profiles.default.projectId).toBe('demo-radarist');
    expect(profiles.selftest.projectId).toBe('demo-radarist-selftest');
    expect(findLocalRuntimePortCollisions([profiles.default, profiles.selftest])).toEqual([]);
  });

  it('builds the checked-in table byte-identically when no offset is set', () => {
    expect(buildLocalRuntimeProfiles({})).toEqual(LOCAL_RUNTIME_PROFILES);
  });

  it('parses a bounded path-safe name suffix and rejects hostile values', () => {
    expect(resolveLocalRuntimeNameSuffix({ RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: 'test024-a' })).toBe('test024-a');
    for (const bad of ['UPPER', 'has space', 'dot.dot', '-leading', 'a'.repeat(33), '../x']) {
      expect(() => resolveLocalRuntimeNameSuffix({ RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: bad })).toThrow(/name suffix/i);
    }
  });
});

describe('LOCAL-011/LOCAL-014 canonical Neo4j Docker identity', () => {
  it('derives the checked-in default and selftest identities byte-identically', () => {
    const plain = deriveLocalRuntimeNeo4jDockerIdentity(LOCAL_RUNTIME_PROFILES.default, '');
    expect(plain.container).toBe('radarist-neo4j');
    expect(plain.volumePrefix).toBe('radarist_neo4j');
    expect(plain.volumes).toEqual([
      { name: 'radarist_neo4j_data', destination: '/data' },
      { name: 'radarist_neo4j_logs', destination: '/logs' },
      { name: 'radarist_neo4j_import', destination: '/var/lib/neo4j/import' },
      { name: 'radarist_neo4j_plugins', destination: '/plugins' },
    ]);
    expect(plain.durableRuntimeLabel).toBe('durable:default');
    expect(plain.ephemeralRuntimeLabel).toBe('ephemeral:default');

    const selftest = deriveLocalRuntimeNeo4jDockerIdentity(LOCAL_RUNTIME_PROFILES.selftest, '');
    expect(selftest.container).toBe('radarist-neo4j-selftest');
    expect(selftest.volumePrefix).toBe('radarist_neo4j_selftest');
    expect(selftest.volumes.map((volume) => volume.name)).toEqual([
      'radarist_neo4j_selftest_data',
      'radarist_neo4j_selftest_logs',
      'radarist_neo4j_selftest_import',
      'radarist_neo4j_selftest_plugins',
    ]);
    expect(selftest.durableRuntimeLabel).toBe('durable:selftest');
  });

  it('derives suffixed identities with dash-to-underscore volume mapping', () => {
    const shifted = deriveLocalRuntimeNeo4jDockerIdentity(LOCAL_RUNTIME_PROFILES.default, 'rc2-x');
    expect(shifted.container).toBe('radarist-neo4j-rc2-x');
    expect(shifted.volumePrefix).toBe('radarist_neo4j_rc2_x');
    expect(shifted.volumes[0].name).toBe('radarist_neo4j_rc2_x_data');

    const shiftedSelftest = deriveLocalRuntimeNeo4jDockerIdentity(LOCAL_RUNTIME_PROFILES.selftest, 'rc2-x');
    expect(shiftedSelftest.container).toBe('radarist-neo4j-selftest-rc2-x');
    expect(shiftedSelftest.volumes[0].name).toBe('radarist_neo4j_selftest_rc2_x_data');
  });

  it('refuses a hostile name suffix instead of deriving an unsafe identity', () => {
    expect(() => deriveLocalRuntimeNeo4jDockerIdentity(LOCAL_RUNTIME_PROFILES.default, '../x')).toThrow(
      /name suffix/i
    );
  });

  it('resolves explicit selections against an injected shifted profile table', () => {
    const shiftedProfiles = buildLocalRuntimeProfiles({ RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '20' });
    expect(parseLocalRuntimeProfileArg([], shiftedProfiles).ports.neo4jHttp).toBe(7494);
    expect(parseLocalRuntimeProfileArg(['--profile', 'selftest'], shiftedProfiles).ports.neo4jBolt).toBe(17707);
    expect(() => parseLocalRuntimeProfileArg(['--profile', 'bogus'], shiftedProfiles)).toThrow(
      'Unknown local runtime profile "bogus"'
    );
  });
});
