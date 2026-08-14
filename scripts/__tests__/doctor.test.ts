/**
 * @jest-environment node
 *
 * @file doctor.test.ts
 * @description Unit tests for the Neo4j password-parity pre-flight (the
 * documented first-boot trap: the container keeps the password from its first
 * boot, so a rotated NEO4J_PASSWORD in the env file fails auth until
 * `npm run neo4j:reset`). Uses mocked `docker inspect` output — no Docker.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkInspectedNeo4jGds,
  checkLiveNeo4jGdsRuntime,
  classifyNeo4jGdsRuntime,
  curlPrerequisiteCheck,
  DOCTOR_NEO4J_GDS_PROBE_OPTIONS,
  isNeo4jContainerRunning,
  isSupportedNodeVersion,
  MIN_NODE_22_VERSION,
  MIN_NODE_24_VERSION,
  MIN_NODE_VERSION,
  NODE_VERSION_REQUIREMENT,
  neo4jPasswordParityCheck,
  neo4jPluginConfigurationCheck,
  optionalAgentRuntimeCheck,
  parseDoctorOptions,
  parseNeo4jAuthPassword,
  releaseBootstrapNeo4jAbsenceCheck,
} from '../doctor';

describe('TEST-051 release-bootstrap Neo4j doctor isolation', () => {
  const ownedContainer = `radarist-test020-${'a'.repeat(12)}-${'b'.repeat(8)}`;

  it('selects only an exact unique selftest target while ordinary doctor keeps the retained profile target', () => {
    const ordinary = parseDoctorOptions(['--profile', 'selftest']);
    expect(ordinary.profile).toMatchObject({ name: 'selftest', neo4jContainer: 'radarist-neo4j-selftest' });
    expect(ordinary.releaseBootstrapContainer).toBeUndefined();
    expect(
      parseDoctorOptions(['--profile', 'selftest', '--release-bootstrap-neo4j-container', ownedContainer])
    ).toMatchObject({
      profile: { name: 'selftest', neo4jContainer: 'radarist-neo4j-selftest' },
      releaseBootstrapContainer: ownedContainer,
    });
  });

  it('fails closed for broad, default-profile, missing, or duplicate bootstrap targets', () => {
    expect(() =>
      parseDoctorOptions(['--profile', 'default', '--release-bootstrap-neo4j-container', ownedContainer])
    ).toThrow('restricted to the selftest profile');
    expect(() =>
      parseDoctorOptions(['--profile', 'selftest', '--release-bootstrap-neo4j-container', 'radarist-neo4j-selftest'])
    ).toThrow('requires a unique radarist-test020 container name');
    expect(() => parseDoctorOptions(['--profile', 'selftest', '--release-bootstrap-neo4j-container'])).toThrow(
      'requires an exact TEST-020 container name'
    );
    expect(() =>
      parseDoctorOptions([
        '--profile',
        'selftest',
        '--release-bootstrap-neo4j-container',
        ownedContainer,
        '--release-bootstrap-neo4j-container',
        ownedContainer,
      ])
    ).toThrow('must be provided exactly once');
  });

  it('passes only a Docker-proven absent owned name and refuses adoption or ambiguous inspection failures', () => {
    expect(releaseBootstrapNeo4jAbsenceCheck(1, `Error: No such object: ${ownedContainer}`)).toEqual({
      level: 'pass',
      label: 'release-bootstrap neo4j target',
      detail: 'unique TEST-020 container name is absent before launch',
    });
    expect(releaseBootstrapNeo4jAbsenceCheck(0, '')).toMatchObject({
      level: 'fail',
      detail: expect.stringContaining('will not adopt'),
    });
    expect(releaseBootstrapNeo4jAbsenceCheck(null, 'permission denied private-password')).toEqual({
      level: 'fail',
      label: 'release-bootstrap neo4j target',
      detail: 'could not prove the unique TEST-020 container name is absent',
    });
  });
});

describe('curlPrerequisiteCheck', () => {
  it('passes when host curl supports bounded unknown-length downloads', () => {
    expect(curlPrerequisiteCheck('8.7.1')).toEqual({
      level: 'pass',
      label: 'host HTTPS client',
      detail: 'curl 8.7.1 supports checksum-pinned GDS provisioning',
    });
  });

  it('fails with an actionable prerequisite when curl is unavailable', () => {
    expect(curlPrerequisiteCheck(undefined)).toEqual({
      level: 'fail',
      label: 'host HTTPS client',
      detail:
        'curl 8.4.0+ is required for host-trusted, size-bounded GDS provisioning; install it and ensure the executable is available',
    });
  });

  it('fails closed when curl cannot enforce the independent size cap', () => {
    expect(curlPrerequisiteCheck('8.3.0')).toEqual({
      level: 'fail',
      label: 'host HTTPS client',
      detail:
        'curl 8.4.0+ is required for host-trusted, size-bounded GDS provisioning; found 8.3.0',
    });
  });
});

describe('optionalAgentRuntimeCheck', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('fails early with the setup command when Anthropic is configured but the runtime is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'radarist-doctor-agent-'));
    roots.push(root);
    expect(optionalAgentRuntimeCheck({ ANTHROPIC_API_KEY: 'configured-key' }, root)).toMatchObject({
      level: 'fail',
      label: 'optional agent runtime',
      detail: expect.stringContaining('npm run setup:agents'),
    });
  });

  it('passes once dependencies and the compiled orchestrator are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'radarist-doctor-agent-'));
    roots.push(root);
    mkdirSync(join(root, 'agent', 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'agent', 'dist'), { recursive: true });
    writeFileSync(join(root, 'agent', 'dist', 'orchestrator-lite.js'), 'export {};\n');
    expect(optionalAgentRuntimeCheck({ ANTHROPIC_API_KEY: 'configured-key' }, root)).toEqual({
      level: 'pass',
      label: 'optional agent runtime',
      detail: 'compiled mission runtime is available',
    });
  });
});

function inspectOutput(env: string[], running = false): string {
  return JSON.stringify([{ Config: { Env: env }, State: { Running: running } }]);
}

describe('neo4jPluginConfigurationCheck', () => {
  it('blocks a stopped legacy container until the guarded migration runs', () => {
    expect(
      neo4jPluginConfigurationCheck(
        inspectOutput([
          'NEO4J_AUTH=neo4j/test',
          'NEO4J_PLUGINS=[ "graph-data-science", "apoc" ]',
        ])
      )
    ).toEqual({
      level: 'fail',
      label: 'neo4j plugins',
      detail:
        'container uses the legacy mutable GDS plugin resolver; run demo:full to perform ' +
        'the guarded data-preserving migration to the pinned plugin contract',
    });
  });

  it('warns only for a stopped canonical container whose live runtime cannot be probed', () => {
    expect(
      neo4jPluginConfigurationCheck(
        inspectOutput(['NEO4J_AUTH=neo4j/test', 'NEO4J_PLUGINS=["apoc"]'])
      )
    ).toEqual({
      level: 'warn',
      label: 'neo4j plugins',
      detail:
        'container is stopped; config includes exactly apoc, ' +
        'but the pinned artifact and live GDS 2.6.9 runtime are unverified',
    });
  });

  it.each([
    ['malformed plugin JSON', inspectOutput(['NEO4J_PLUGINS=[apoc]'])],
    ['invalid inspect JSON', 'not json'],
  ])('fails without exposing retained-container configuration for %s', (_case, inspectStdout) => {
    const check = neo4jPluginConfigurationCheck(inspectStdout);
    expect(check).toMatchObject({
      level: 'fail',
      label: 'neo4j plugins',
      detail: expect.stringContaining('plugin configuration is invalid'),
    });
    expect(check.detail).not.toContain('private');
  });
});

describe('live Neo4j GDS runtime diagnosis', () => {
  it('distinguishes running containers from stopped or malformed inspect output', () => {
    expect(isNeo4jContainerRunning(inspectOutput([], true))).toBe(true);
    expect(isNeo4jContainerRunning(inspectOutput([], false))).toBe(false);
    expect(isNeo4jContainerRunning('not json')).toBe(false);
  });

  it('passes only the exact pinned live version', () => {
    expect(classifyNeo4jGdsRuntime({ kind: 'ready', version: '2.6.9' })).toEqual({
      level: 'pass',
      label: 'neo4j gds runtime',
      detail: 'authenticated gds.version() returned 2.6.9',
    });
  });

  it.each(['2.6.8', '2.7.0', '3.0.0'])(
    'blocks a running container with wrong GDS version %s',
    (version) => {
      expect(classifyNeo4jGdsRuntime({ kind: 'ready', version })).toEqual({
        level: 'fail',
        label: 'neo4j gds runtime',
        detail: `authenticated gds.version() returned ${version}; exactly 2.6.9 is required`,
      });
    }
  );

  it('fails closed without reflecting invalid version or error-shaped secrets', () => {
    const secret = 'private-password';
    const invalidVersion = `${secret}\n`;
    const check = classifyNeo4jGdsRuntime({ kind: 'ready', version: invalidVersion });
    expect(check).toMatchObject({ level: 'fail', label: 'neo4j gds runtime' });
    expect(check.detail).not.toContain(secret);
  });

  it('uses the bounded authenticated probe and preserves no credential in its verdict', async () => {
    const env = {
      NEO4J_URI: 'bolt://127.0.0.1:7687',
      NEO4J_USER: 'neo4j',
      NEO4J_PASSWORD: 'private-password',
      NEO4J_DATABASE: 'neo4j',
    };
    const probe = jest.fn().mockResolvedValue('2.6.9');

    await expect(checkLiveNeo4jGdsRuntime(env, probe)).resolves.toEqual({
      level: 'pass',
      label: 'neo4j gds runtime',
      detail: 'authenticated gds.version() returned 2.6.9',
    });
    expect(probe).toHaveBeenCalledWith(env, DOCTOR_NEO4J_GDS_PROBE_OPTIONS);
    expect(DOCTOR_NEO4J_GDS_PROBE_OPTIONS).toEqual({
      timeoutMs: 5_000,
      attemptTimeoutMs: 2_000,
      pollIntervalMs: 250,
    });
  });

  it('probes only canonical running intent and blocks legacy intent without probing', async () => {
    const probe = jest.fn().mockResolvedValue('2.6.9');
    const env = { NEO4J_PASSWORD: 'private-password', NEO4J_URI: 'bolt://127.0.0.1:7687' };

    await expect(
      checkInspectedNeo4jGds(
        inspectOutput(['NEO4J_PLUGINS=["apoc"]'], true),
        env,
        probe
      )
    ).resolves.toMatchObject({ level: 'pass', label: 'neo4j gds runtime' });
    expect(probe).toHaveBeenCalledTimes(1);

    await expect(
      checkInspectedNeo4jGds(
        inspectOutput(['NEO4J_PLUGINS=["apoc"]'], false),
        env,
        probe
      )
    ).resolves.toMatchObject({ level: 'warn', label: 'neo4j plugins' });
    expect(probe).toHaveBeenCalledTimes(1);

    await expect(
      checkInspectedNeo4jGds(
        inspectOutput(['NEO4J_PLUGINS=["apoc","graph-data-science"]'], true),
        env,
        probe
      )
    ).resolves.toMatchObject({
      level: 'fail',
      label: 'neo4j plugins',
      detail: expect.stringContaining('legacy mutable GDS plugin resolver'),
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('blocks malformed running plugin intent before attempting the live probe', async () => {
    const probe = jest.fn().mockResolvedValue('2.6.9');
    const check = await checkInspectedNeo4jGds(
      inspectOutput(
        [
          'NEO4J_AUTH=neo4j/test',
          'NEO4J_PLUGINS=["apoc","graph-data-science","unknown"]',
        ],
        true
      ),
      {
        NEO4J_PASSWORD: 'private-password',
        NEO4J_URI: 'bolt://127.0.0.1:7687',
      },
      probe
    );

    expect(check).toMatchObject({
      level: 'fail',
      label: 'neo4j plugins',
      detail: expect.stringContaining('recreate the profile-owned Neo4j container'),
    });
    expect(check.detail).not.toContain('private');
    expect(probe).not.toHaveBeenCalled();
  });

  it('turns missing-plugin/auth/timeout failures into a blocking redacted verdict', async () => {
    const secret = 'private-password';
    const probe = jest.fn().mockRejectedValue(
      new Error(`Procedure gds.version missing for neo4j/${secret}`)
    );
    const check = await checkLiveNeo4jGdsRuntime(
      {
        NEO4J_URI: 'bolt://127.0.0.1:7687',
        NEO4J_USER: 'neo4j',
        NEO4J_PASSWORD: secret,
      },
      probe
    );

    expect(check).toEqual({
      level: 'fail',
      label: 'neo4j gds runtime',
      detail:
        'authenticated gds.version() did not prove exact version 2.6.9; ' +
        'the required plugin may be missing or unavailable',
    });
    expect(check.detail).not.toContain(secret);
  });
});

describe('parseNeo4jAuthPassword', () => {
  it('extracts the password half of NEO4J_AUTH from docker inspect output', () => {
    const stdout = inspectOutput(['PATH=/usr/bin', 'NEO4J_AUTH=neo4j/super-secret', 'NEO4J_PLUGINS=["apoc"]']);
    expect(parseNeo4jAuthPassword(stdout)).toBe('super-secret');
  });

  it('keeps slashes inside the password (splits on the first separator only)', () => {
    expect(parseNeo4jAuthPassword(inspectOutput(['NEO4J_AUTH=neo4j/a/b/c']))).toBe('a/b/c');
  });

  it('returns undefined when auth is disabled ("none")', () => {
    expect(parseNeo4jAuthPassword(inspectOutput(['NEO4J_AUTH=none']))).toBeUndefined();
  });

  it('returns undefined when NEO4J_AUTH is absent', () => {
    expect(parseNeo4jAuthPassword(inspectOutput(['PATH=/usr/bin']))).toBeUndefined();
  });

  it('returns undefined for unparseable or unexpected output', () => {
    expect(parseNeo4jAuthPassword('not json')).toBeUndefined();
    expect(parseNeo4jAuthPassword('{}')).toBeUndefined();
    expect(parseNeo4jAuthPassword('[]')).toBeUndefined();
    expect(parseNeo4jAuthPassword(JSON.stringify([{ Config: {} }]))).toBeUndefined();
  });
});

describe('isSupportedNodeVersion', () => {
  it('matches the locked dependency floors on supported Node release lines', () => {
    expect(MIN_NODE_VERSION).toBe('20.19.0');
    expect(MIN_NODE_22_VERSION).toBe('22.12.0');
    expect(MIN_NODE_24_VERSION).toBe('24.0.0');
    expect(NODE_VERSION_REQUIREMENT).toBe('Node 20.19+, Node 22.12+, or Node 24.x');
    expect(isSupportedNodeVersion('20.18.1')).toBe(false);
    expect(isSupportedNodeVersion('20.19.0')).toBe(true);
    expect(isSupportedNodeVersion('20.19.5')).toBe(true);
    expect(isSupportedNodeVersion('21.0.0')).toBe(false);
    expect(isSupportedNodeVersion('22.11.0')).toBe(false);
    expect(isSupportedNodeVersion('22.12.0')).toBe(true);
    expect(isSupportedNodeVersion('23.11.0')).toBe(false);
    expect(isSupportedNodeVersion('24.0.0')).toBe(true);
    expect(isSupportedNodeVersion('24.7.0')).toBe(true);
    expect(isSupportedNodeVersion('25.0.0')).toBe(false);
  });

  it('fails closed on malformed versions', () => {
    expect(isSupportedNodeVersion('20')).toBe(false);
    expect(isSupportedNodeVersion('20.19.0-rc.1')).toBe(false);
    expect(isSupportedNodeVersion('unknown')).toBe(false);
  });
});

describe('neo4jPasswordParityCheck', () => {
  it('passes when the container password matches the env file', () => {
    const check = neo4jPasswordParityCheck('secret', 'secret', '.env.local');
    expect(check).toEqual({
      level: 'pass',
      label: 'neo4j password',
      detail: 'container NEO4J_AUTH matches .env.local',
    });
  });

  it('fails with the exact fix instruction on mismatch', () => {
    const check = neo4jPasswordParityCheck('old-secret', 'new-secret', '.env.local');
    expect(check).toEqual({
      level: 'fail',
      label: 'neo4j password',
      detail: 'password mismatch between running container and .env.local — run npm run neo4j:reset',
    });
  });

  it('names the profile env file in the mismatch detail', () => {
    const check = neo4jPasswordParityCheck('a', 'b', '.env.selftest.local');
    expect(check?.detail).toBe(
      'password mismatch between running container and .env.selftest.local — run npm run neo4j:reset'
    );
  });

  it('silently skips (null) when either side is unknown', () => {
    expect(neo4jPasswordParityCheck(undefined, 'secret', '.env.local')).toBeNull();
    expect(neo4jPasswordParityCheck('secret', undefined, '.env.local')).toBeNull();
    expect(neo4jPasswordParityCheck(undefined, undefined, '.env.local')).toBeNull();
  });
});
