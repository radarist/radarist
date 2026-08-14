/**
 * @jest-environment node
 *
 * TEST-023 — the caller-owned disposable graph contract.
 *
 * The defect these pin: the browser-acceptance lanes declared a
 * `caller-owned-disposable` Neo4j on port 17687, which is ALSO the Bolt port of
 * the canonical `selftest` local-runtime profile. Nothing provisioned that
 * graph, so the lanes could never run inside `npm run e2e:partition-proof`, and
 * when they did run by hand against a live 17687 they seeded and deleted
 * fixtures inside retained data while every existing disposability guard
 * (loopback, not-7687, opt-in flag) reported success.
 */
import {
  BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT,
  BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT,
  BROWSER_ACCEPTANCE_NEO4J_URI,
  DISPOSABLE_NEO4J_IMAGE,
  DISPOSABLE_NEO4J_LABEL_KEY,
  assertDisposableNeo4jPorts,
  disposableNeo4jChildEnv,
  disposableNeo4jContainerName,
  disposableNeo4jInspectionProblems,
  disposableNeo4jRunArgs,
  type DisposableNeo4jInspection,
  type DisposableNeo4jOptions,
} from '../lib/disposable-neo4j-runtime';

const OPTIONS: DisposableNeo4jOptions = {
  containerName: 'radarist-partition-graph-abc-0011aabb-ephemeral',
  boltPort: BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT,
  httpPort: BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT,
  password: 'disposable-deadbeefdeadbeefdeadbeef',
  labelValue: 'demo',
};

function inspection(overrides: Partial<DisposableNeo4jInspection> = {}): DisposableNeo4jInspection {
  return {
    Id: 'a'.repeat(64),
    State: { Running: true },
    HostConfig: { AutoRemove: true },
    Config: {
      Image: DISPOSABLE_NEO4J_IMAGE,
      Labels: { [DISPOSABLE_NEO4J_LABEL_KEY]: OPTIONS.labelValue },
      Env: [`NEO4J_AUTH=neo4j/${OPTIONS.password}`],
    },
    Mounts: [
      { Type: 'tmpfs', Destination: '/data' },
      { Type: 'tmpfs', Destination: '/logs' },
    ],
    NetworkSettings: {
      Ports: {
        '7687/tcp': [{ HostIp: '127.0.0.1', HostPort: String(OPTIONS.boltPort) }],
        '7474/tcp': [{ HostIp: '127.0.0.1', HostPort: String(OPTIONS.httpPort) }],
      },
    },
    ...overrides,
  };
}

describe('browser-acceptance disposable graph endpoint', () => {
  it('does not publish onto a durable local-runtime profile port', () => {
    // 7687 is the protected default graph; 17687 is the selftest profile's Bolt
    // port AND the repository-wide disposable integration port — which is
    // exactly why a "disposable" claim on it cannot be trusted here.
    expect(BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT).not.toBe(7687);
    expect(BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT).not.toBe(17687);
    expect(BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT).not.toBe(7474);
    expect(BROWSER_ACCEPTANCE_NEO4J_HTTP_PORT).not.toBe(17474);
    expect(BROWSER_ACCEPTANCE_NEO4J_URI).toBe(`bolt://127.0.0.1:${BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT}`);
  });

  it('refuses to be pointed back at a durable profile port', () => {
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, boltPort: 7687 })).toThrow(/durable/);
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, boltPort: 17687 })).toThrow(/durable/);
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, httpPort: 7474 })).toThrow(/durable/);
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, httpPort: 17474 })).toThrow(/durable/);
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, httpPort: BROWSER_ACCEPTANCE_NEO4J_BOLT_PORT })).toThrow(
      /must differ/
    );
    expect(() => assertDisposableNeo4jPorts({ ...OPTIONS, boltPort: 80 })).toThrow(/usable unprivileged/);
  });
});

describe('disposableNeo4jContainerName', () => {
  it('is unique per process so a crashed run cannot be adopted', () => {
    expect(disposableNeo4jContainerName('radarist-partition-graph', 4242, '0011aabb')).toBe(
      'radarist-partition-graph-39u-0011aabb-ephemeral'
    );
  });

  it('rejects identity components it cannot vouch for', () => {
    expect(() => disposableNeo4jContainerName('Bad_Prefix', 1, '0011aabb')).toThrow(/kebab-case/);
    expect(() => disposableNeo4jContainerName('radarist-partition-graph', 0, '0011aabb')).toThrow(/pid/);
    expect(() => disposableNeo4jContainerName('radarist-partition-graph', 1, 'nothex')).toThrow(/nonce/);
  });
});

describe('disposableNeo4jRunArgs', () => {
  it('creates a self-removing, loopback-only container with no durable storage', () => {
    const args = disposableNeo4jRunArgs(OPTIONS);
    expect(args).toContain('--rm');
    expect(args).toContain('--detach');
    expect(args.at(-1)).toBe(DISPOSABLE_NEO4J_IMAGE);
    // Both VOLUME paths the image declares must be tmpfs; an uncovered one
    // becomes an anonymous Docker volume and shows up as residue.
    expect(args.join(' ')).toContain('--mount type=tmpfs,destination=/data');
    expect(args.join(' ')).toContain('--mount type=tmpfs,destination=/logs');
    expect(args).not.toContain('--tmpfs');
    expect(args.join(' ')).toContain(`127.0.0.1:${OPTIONS.boltPort}:7687`);
    expect(args.join(' ')).toContain(`127.0.0.1:${OPTIONS.httpPort}:7474`);
    // No named volume and no bind mount: the graph cannot outlive the container.
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('-v');
  });
});

describe('disposableNeo4jInspectionProblems', () => {
  it('accepts a container that matches the isolation contract exactly', () => {
    expect(disposableNeo4jInspectionProblems(inspection(), OPTIONS)).toEqual([]);
  });

  it.each([
    ['a stopped container', { State: { Running: false } }, /not running/],
    ['a container that survives its run', { HostConfig: { AutoRemove: false } }, /automatic removal/],
    [
      'an unpinned image',
      { Config: { Image: 'neo4j:latest', Labels: { [DISPOSABLE_NEO4J_LABEL_KEY]: 'demo' }, Env: [] } },
      /image must be/,
    ],
    [
      'an anonymous volume left by an uncovered VOLUME path',
      {
        Mounts: [
          { Type: 'tmpfs', Destination: '/data' },
          { Type: 'volume', Destination: '/logs' },
        ],
      },
      /bind and volume mounts are forbidden/,
    ],
  ])('refuses %s', (_label, overrides, expected) => {
    const problems = disposableNeo4jInspectionProblems(
      inspection(overrides as Partial<DisposableNeo4jInspection>),
      OPTIONS
    );
    expect(problems.join('; ')).toMatch(expected);
  });

  it('refuses a graph published beyond loopback', () => {
    const problems = disposableNeo4jInspectionProblems(
      inspection({
        NetworkSettings: {
          Ports: {
            '7687/tcp': [{ HostIp: '0.0.0.0', HostPort: String(OPTIONS.boltPort) }],
            '7474/tcp': [{ HostIp: '127.0.0.1', HostPort: String(OPTIONS.httpPort) }],
          },
        },
      }),
      OPTIONS
    );
    expect(problems.join('; ')).toMatch(/published beyond loopback/);
  });

  it('refuses a container whose credentials are not this run’s', () => {
    const problems = disposableNeo4jInspectionProblems(
      inspection({
        Config: {
          Image: DISPOSABLE_NEO4J_IMAGE,
          Labels: { [DISPOSABLE_NEO4J_LABEL_KEY]: OPTIONS.labelValue },
          Env: ['NEO4J_AUTH=neo4j/some-other-password'],
        },
      }),
      OPTIONS
    );
    expect(problems.join('; ')).toMatch(/credentials do not match/);
  });
});

describe('disposableNeo4jChildEnv', () => {
  it('hands the lane the owned graph and nothing inherited', () => {
    expect(disposableNeo4jChildEnv(OPTIONS)).toEqual({
      RADARIST_GRAPH_RUNTIME_MODE: 'neo4j',
      NEO4J_URI: `bolt://127.0.0.1:${OPTIONS.boltPort}`,
      NEO4J_USER: 'neo4j',
      NEO4J_PASSWORD: OPTIONS.password,
      NEO4J_DATABASE: 'neo4j',
      NEO4J_INTEGRATION_DISPOSABLE: 'true',
    });
  });
});
