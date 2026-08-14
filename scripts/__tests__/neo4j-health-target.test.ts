/**
 * @jest-environment node
 *
 * LOCAL-011 — the Neo4j health gate must honor the selected runtime profile.
 * Covers default, shifted, and self-test profile resolution plus missing,
 * ambiguous, foreign-host, and mismatched-identity refusals, proving the
 * command never falls back to a default instance.
 */
import type { CommandRunner } from '../benchmark/snapshot';
import { LOCAL_RUNTIME_DOCKER_LABEL } from '../lib/local-runtime-profile';
import {
  buildNeo4jHealthTarget,
  checkNeo4jHealth,
  inspectNeo4jContainerIdentity,
  resolveNeo4jHealthSelection,
  type Neo4jHealthTarget,
} from '../lib/neo4j-health-target';

const IMAGE = 'neo4j:5.15.0-community';

interface FakeDockerOptions {
  present?: boolean;
  image?: string;
  runtimeLabel?: string;
  httpHostPort?: string;
  boltHostPort?: string;
  hostIp?: string;
  extraPorts?: string[];
  mounts?: Array<{ Destination: string; Name: string; Type: string }>;
  volumeLabels?: Record<string, string | undefined>;
  running?: boolean;
  health?: string;
  inspectError?: string;
  configEnv?: unknown;
}

class FakeDockerRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly options: FakeDockerOptions = {}) {}

  run(command: string, argsInput: readonly string[]): string {
    const args = [...argsInput];
    this.calls.push({ command, args });
    if (command !== 'docker') throw new Error(`Unexpected executable ${command}`);
    if (args[0] === 'inspect' && args.length === 2) {
      if (this.options.inspectError) throw new Error(this.options.inspectError);
      if (this.options.present === false) {
        throw new Error(`docker exited with code 1: Error: No such object: ${args[1]}`);
      }
      return JSON.stringify([this.inspectEntry()]);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volume = args.at(-1)!;
      if (this.options.volumeLabels) {
        if (!(volume in this.options.volumeLabels)) {
          throw new Error(`docker exited with code 1: Error: No such volume: ${volume}`);
        }
        const label = this.options.volumeLabels[volume];
        if (label === undefined) {
          throw new Error(`docker exited with code 1: Error: No such volume: ${volume}`);
        }
        return `${label}\n`;
      }
      return `${this.options.runtimeLabel ?? 'durable:default'}\n`;
    }
    throw new Error(`Unexpected docker invocation: ${args.join(' ')}`);
  }

  private inspectEntry(): Record<string, unknown> {
    const options = this.options;
    const configEnv = Object.prototype.hasOwnProperty.call(options, 'configEnv')
      ? options.configEnv
      : ['NEO4J_AUTH=neo4j/test', 'NEO4J_PLUGINS=["apoc"]'];
    const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
      '7474/tcp': [{ HostIp: options.hostIp ?? '127.0.0.1', HostPort: options.httpHostPort ?? '7474' }],
      '7687/tcp': [{ HostIp: options.hostIp ?? '127.0.0.1', HostPort: options.boltHostPort ?? '7687' }],
    };
    for (const extra of options.extraPorts ?? []) {
      bindings[extra] = [{ HostIp: '127.0.0.1', HostPort: '9999' }];
    }
    return {
      Name: '/radarist-neo4j',
      Config: {
        Image: options.image ?? IMAGE,
        Labels: { [LOCAL_RUNTIME_DOCKER_LABEL]: options.runtimeLabel ?? 'durable:default' },
        Env: configEnv,
      },
      HostConfig: { PortBindings: bindings },
      Mounts:
        options.mounts ??
        [
          { Destination: '/data', Name: 'radarist_neo4j_data', Type: 'volume' },
          { Destination: '/logs', Name: 'radarist_neo4j_logs', Type: 'volume' },
          { Destination: '/var/lib/neo4j/import', Name: 'radarist_neo4j_import', Type: 'volume' },
          { Destination: '/plugins', Name: 'radarist_neo4j_plugins', Type: 'volume' },
        ],
      State: { Running: options.running ?? true, Health: options.health ? { Status: options.health } : undefined },
    };
  }
}

function defaultTarget(): Neo4jHealthTarget {
  return buildNeo4jHealthTarget(
    { name: 'default', projectId: 'demo-radarist', ports: { neo4jHttp: 7474, neo4jBolt: 7687 } },
    ''
  );
}

describe('LOCAL-011 profile resolution', () => {
  it('resolves the default profile with the checked-in ports and Docker identity', () => {
    const selection = resolveNeo4jHealthSelection([], {});
    expect(selection.target).toMatchObject({
      profile: 'default',
      projectId: 'demo-radarist',
      httpUrl: 'http://127.0.0.1:7474',
      boltUri: 'bolt://127.0.0.1:7687',
      container: 'radarist-neo4j',
      durableRuntimeLabel: 'durable:default',
    });
    expect(selection.target.volumes.map((volume) => volume.name)).toEqual([
      'radarist_neo4j_data',
      'radarist_neo4j_logs',
      'radarist_neo4j_import',
      'radarist_neo4j_plugins',
    ]);
  });

  it('resolves the self-test profile explicitly', () => {
    const selection = resolveNeo4jHealthSelection(['--profile', 'selftest'], {});
    expect(selection.target).toMatchObject({
      profile: 'selftest',
      httpUrl: 'http://127.0.0.1:17474',
      boltUri: 'bolt://127.0.0.1:17687',
      container: 'radarist-neo4j-selftest',
      durableRuntimeLabel: 'durable:selftest',
    });
    expect(selection.target.volumes[0].name).toBe('radarist_neo4j_selftest_data');
  });

  it('resolves a shifted profile through the sanctioned env overrides', () => {
    const selection = resolveNeo4jHealthSelection([], {
      RADARIST_LOCAL_RUNTIME_PORT_OFFSET: '20',
      RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: 'rc2',
    });
    expect(selection.target).toMatchObject({
      profile: 'default',
      httpUrl: 'http://127.0.0.1:7494',
      boltUri: 'bolt://127.0.0.1:7707',
      container: 'radarist-neo4j-rc2',
    });
    expect(selection.target.volumes.map((volume) => volume.name)).toEqual([
      'radarist_neo4j_rc2_data',
      'radarist_neo4j_rc2_logs',
      'radarist_neo4j_rc2_import',
      'radarist_neo4j_rc2_plugins',
    ]);
  });

  it('refuses an ambiguous profile selection', () => {
    expect(() => resolveNeo4jHealthSelection(['--profile', 'default', '--profile=selftest'], {})).toThrow(
      'exactly once'
    );
  });

  it('refuses an unknown profile name', () => {
    expect(() => resolveNeo4jHealthSelection(['--profile', 'retained'], {})).toThrow(
      'Unknown local runtime profile "retained"'
    );
  });

  it('refuses malformed shift overrides instead of silently using canonical ports', () => {
    expect(() =>
      resolveNeo4jHealthSelection([], { RADARIST_LOCAL_RUNTIME_PORT_OFFSET: 'not-a-number' })
    ).toThrow('Invalid local runtime port offset');
    expect(() =>
      resolveNeo4jHealthSelection([], { RADARIST_LOCAL_RUNTIME_NAME_SUFFIX: 'UPPER_BAD!' })
    ).toThrow('Invalid local runtime name suffix');
  });

  it('refuses a non-loopback host when constructing a target', () => {
    expect(() =>
      buildNeo4jHealthTarget(
        { name: 'default', projectId: 'demo-radarist', ports: { neo4jHttp: 7474, neo4jBolt: 7687 } },
        '',
        '192.168.1.50'
      )
    ).toThrow('Refusing non-loopback Neo4j health target host');
    expect(() =>
      buildNeo4jHealthTarget(
        { name: 'default', projectId: 'demo-radarist', ports: { neo4jHttp: 7474, neo4jBolt: 7687 } },
        '',
        '0.0.0.0'
      )
    ).toThrow('Refusing non-loopback Neo4j health target host');
  });
});

describe('LOCAL-011 container identity verification', () => {
  it('matches a correctly configured default container', () => {
    const identity = inspectNeo4jContainerIdentity(defaultTarget(), new FakeDockerRunner());
    expect(identity).toMatchObject({
      state: 'matched',
      container: 'radarist-neo4j',
      image: IMAGE,
      runtimeLabel: 'durable:default',
      running: true,
      volumes: ['radarist_neo4j_data', 'radarist_neo4j_logs', 'radarist_neo4j_import', 'radarist_neo4j_plugins'],
    });
  });

  it('reports a missing container without probing anything else', () => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({ present: false })
    );
    expect(identity).toEqual({ state: 'missing', container: 'radarist-neo4j' });
  });

  it('rejects a container publishing the wrong host ports', () => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({ httpHostPort: '17474' })
    );
    expect(identity.state).toBe('mismatched');
    if (identity.state === 'mismatched') {
      expect(identity.problems.join('\n')).toContain('publishes host port 17474, expected 7474');
    }
  });

  it('rejects a container bound to a foreign interface', () => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({ hostIp: '0.0.0.0' })
    );
    expect(identity.state).toBe('mismatched');
    if (identity.state === 'mismatched') {
      expect(identity.problems.join('\n')).toContain('non-loopback interface "0.0.0.0"');
    }
  });

  it('rejects unexpected published ports, images, labels, mounts, and volume labels', () => {
    const base = defaultTarget();
    const cases: Array<{ name: string; options: FakeDockerOptions; fragment: string }> = [
      {
        name: 'extra port',
        options: { extraPorts: ['8080/tcp'] },
        fragment: 'unexpected published container port 8080/tcp',
      },
      { name: 'image', options: { image: 'neo4j:4.4.0' }, fragment: 'image "neo4j:4.4.0"' },
      {
        name: 'runtime label',
        options: { runtimeLabel: 'durable:selftest' },
        fragment: 'runtime label "durable:selftest"',
      },
      {
        name: 'mount name',
        options: {
          mounts: [
            { Destination: '/data', Name: 'radarist_neo4j_OTHER_data', Type: 'volume' },
            { Destination: '/logs', Name: 'radarist_neo4j_logs', Type: 'volume' },
            { Destination: '/var/lib/neo4j/import', Name: 'radarist_neo4j_import', Type: 'volume' },
            { Destination: '/plugins', Name: 'radarist_neo4j_plugins', Type: 'volume' },
          ],
        },
        fragment: 'mount /data must be named volume radarist_neo4j_data',
      },
      {
        name: 'volume label',
        options: { volumeLabels: { radarist_neo4j_data: 'durable:selftest' } },
        fragment: 'volume radarist_neo4j_data has runtime label "durable:selftest"',
      },
      {
        name: 'missing volume',
        options: { volumeLabels: { radarist_neo4j_logs: undefined } },
        fragment: 'volume radarist_neo4j_logs does not exist',
      },
    ];
    for (const testCase of cases) {
      const identity = inspectNeo4jContainerIdentity(base, new FakeDockerRunner(testCase.options));
      expect(identity.state).toBe('mismatched');
      if (identity.state === 'mismatched') {
        expect(identity.problems.join('\n')).toContain(testCase.fragment);
      }
    }
  });

  it.each([
    ['missing Config.Env', undefined, 'Docker Config.Env must be an array of strings'],
    ['GDS only', ['NEO4J_PLUGINS=["graph-data-science"]'], 'must contain exactly apoc'],
    [
      'substring lookalike',
      ['NEO4J_PLUGINS=["apoc","not-graph-data-science-extra"]'],
      'must contain exactly apoc',
    ],
    ['malformed JSON', ['NEO4J_PLUGINS=[apoc]'], 'must be a valid JSON array'],
    [
      'duplicate settings',
      ['NEO4J_PLUGINS=["apoc","graph-data-science"]', 'NEO4J_PLUGINS=["apoc","graph-data-science"]'],
      'must be configured exactly once',
    ],
  ])('rejects retained container plugin configuration with %s', (_case, configEnv, fragment) => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({ configEnv })
    );
    expect(identity.state).toBe('mismatched');
    if (identity.state === 'mismatched') {
      expect(identity.problems.join('\n')).toContain('plugin configuration invalid');
      expect(identity.problems.join('\n')).toContain(fragment);
    }
  });

  it('rejects the legacy mutable GDS resolver even though it is migration-readable', () => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({
        configEnv: [
          'NEO4J_AUTH=neo4j/test',
          'NEO4J_PLUGINS=["apoc","graph-data-science"]',
        ],
      })
    );
    expect(identity.state).toBe('mismatched');
    if (identity.state === 'mismatched') {
      expect(identity.problems.join('\n')).toContain('legacy mutable GDS resolver');
    }
  });

  it('treats a Docker daemon failure as a bounded mismatch diagnostic', () => {
    const identity = inspectNeo4jContainerIdentity(
      defaultTarget(),
      new FakeDockerRunner({ inspectError: 'docker could not start: daemon unreachable' })
    );
    expect(identity.state).toBe('mismatched');
    if (identity.state === 'mismatched') {
      expect(identity.problems[0]).toContain('Docker inspection failed');
    }
  });
});

describe('LOCAL-011 health evaluation', () => {
  const okProbe = { ok: true, detail: 'fine' };

  it('reports healthy only when identity matches and both probes succeed', async () => {
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner(),
      httpProbe: async () => okProbe,
      tcpProbe: async () => okProbe,
    });
    expect(report.healthy).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.http).toEqual(okProbe);
    expect(report.bolt).toEqual(okProbe);
  });

  it('fails when the HTTP surface is down even if Bolt answers', async () => {
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner(),
      httpProbe: async () => ({ ok: false, detail: 'ECONNREFUSED' }),
      tcpProbe: async () => okProbe,
    });
    expect(report.healthy).toBe(false);
    expect(report.problems.join('\n')).toContain('HTTP probe of http://127.0.0.1:7474 failed');
  });

  it('fails when the Bolt surface is down even if HTTP answers', async () => {
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner(),
      httpProbe: async () => okProbe,
      tcpProbe: async () => ({ ok: false, detail: 'timeout' }),
    });
    expect(report.healthy).toBe(false);
    expect(report.problems.join('\n')).toContain('Bolt probe of bolt://127.0.0.1:7687 failed');
  });

  it('never probes when the requested profile container is missing (no default fallback)', async () => {
    const probed: string[] = [];
    const selftestTarget = buildNeo4jHealthTarget(
      { name: 'selftest', projectId: 'demo-radarist-selftest', ports: { neo4jHttp: 17474, neo4jBolt: 17687 } },
      ''
    );
    const report = await checkNeo4jHealth(selftestTarget, {
      runner: new FakeDockerRunner({ present: false }),
      httpProbe: async (url) => {
        probed.push(url);
        return okProbe;
      },
      tcpProbe: async (host, port) => {
        probed.push(`${host}:${port}`);
        return okProbe;
      },
    });
    expect(report.healthy).toBe(false);
    expect(report.identity.state).toBe('missing');
    expect(probed).toEqual([]);
    expect(report.problems.join('\n')).toContain('refusing to probe unowned loopback ports');
  });

  it('never probes when the container identity mismatches', async () => {
    const probed: string[] = [];
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner({ image: 'neo4j:4.4.0' }),
      httpProbe: async (url) => {
        probed.push(url);
        return okProbe;
      },
      tcpProbe: async () => {
        probed.push('tcp');
        return okProbe;
      },
    });
    expect(report.healthy).toBe(false);
    expect(report.identity.state).toBe('mismatched');
    expect(probed).toEqual([]);
  });

  it('fails a matched container that is stopped without probing', async () => {
    const probed: string[] = [];
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner({ running: false }),
      httpProbe: async () => {
        probed.push('http');
        return okProbe;
      },
      tcpProbe: async () => {
        probed.push('tcp');
        return okProbe;
      },
    });
    expect(report.healthy).toBe(false);
    expect(probed).toEqual([]);
    expect(report.problems.join('\n')).toContain('is not running');
  });

  it('flags a container-reported unhealthy status even when probes succeed', async () => {
    const report = await checkNeo4jHealth(defaultTarget(), {
      runner: new FakeDockerRunner({ health: 'unhealthy' }),
      httpProbe: async () => okProbe,
      tcpProbe: async () => okProbe,
    });
    expect(report.healthy).toBe(false);
    expect(report.problems.join('\n')).toContain('reports unhealthy');
  });

  it.each(['starting', 'unknown'])(
    'fails closed while a container health check reports %s even when both surfaces answer',
    async (health) => {
      const report = await checkNeo4jHealth(defaultTarget(), {
        runner: new FakeDockerRunner({ health }),
        httpProbe: async () => okProbe,
        tcpProbe: async () => okProbe,
      });
      expect(report.healthy).toBe(false);
      expect(report.problems.join('\n')).toContain(`reports ${health}, expected healthy`);
    }
  );
});
