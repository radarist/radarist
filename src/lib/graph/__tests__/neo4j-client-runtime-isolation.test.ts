/** @jest-environment node */

import { spawnSync } from 'child_process';

const mockDriverFactory = jest.fn();
const mockSessionFactory = jest.fn();

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: mockDriverFactory,
    auth: { basic: jest.fn(() => ({})) },
    session: { READ: 'READ', WRITE: 'WRITE' },
    isInt: jest.fn(() => false),
    isDate: jest.fn(() => false),
    isDateTime: jest.fn(() => false),
    isLocalDateTime: jest.fn(() => false),
    isNode: jest.fn(() => false),
    isRelationship: jest.fn(() => false),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('Neo4j client runtime isolation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockDriverFactory.mockReturnValue({ session: mockSessionFactory, close: jest.fn() });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    { mode: 'disabled', uri: 'bolt://localhost:7687' },
    { mode: 'disabled', uri: 'bolt://127.0.0.1:17687' },
    { mode: undefined, uri: undefined },
    { mode: undefined, uri: '' },
  ])('fails before constructing a driver or session for $mode / $uri', async ({ mode, uri }) => {
    if (mode === undefined) delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    else process.env.RADARIST_GRAPH_RUNTIME_MODE = mode;
    if (uri === undefined) delete process.env.NEO4J_URI;
    else process.env.NEO4J_URI = uri;

    const { checkHealth, getDriver, getSession } = await import('../neo4j-client');

    expect(() => getDriver()).toThrow();
    expect(() => getSession('WRITE')).toThrow();
    await expect(checkHealth()).resolves.toMatchObject({ healthy: false });
    expect(mockDriverFactory).not.toHaveBeenCalled();
    expect(mockSessionFactory).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'disabled', uri: 'bolt://localhost:7687', backend: 'disabled' },
    { mode: undefined, uri: '', backend: 'unconfigured' },
  ])('maps intentional read unavailability to the canonical typed error for $backend', async ({ mode, uri, backend }) => {
    if (mode === undefined) delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    else process.env.RADARIST_GRAPH_RUNTIME_MODE = mode;
    process.env.NEO4J_URI = uri;

    const { runReadTransaction } = await import('../neo4j-client');

    await expect(runReadTransaction('RETURN 1 AS value')).rejects.toMatchObject({
      name: 'GraphUnavailableError',
      operation: 'read',
      backend,
    });
    expect(mockDriverFactory).not.toHaveBeenCalled();
  });

  it('does not disguise an invalid runtime value as graph unavailability', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'invalid';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    const { runReadTransaction } = await import('../neo4j-client');

    await expect(runReadTransaction('RETURN 1 AS value')).rejects.toMatchObject({
      name: 'GraphRuntimeConfigurationError',
    });
    expect(mockDriverFactory).not.toHaveBeenCalled();
  });

  it('re-checks disabled mode before using an already-created driver', async () => {
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    process.env.NEO4J_URI = 'bolt://127.0.0.1:17687';
    const { getDriver, getSession } = await import('../neo4j-client');

    expect(getDriver()).toBeDefined();
    expect(mockDriverFactory).toHaveBeenCalledTimes(1);

    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
    process.env.NEO4J_URI = 'bolt://localhost:7687';

    expect(() => getDriver()).toThrow(/graph runtime is disabled/i);
    expect(() => getSession('WRITE')).toThrow(/graph runtime is disabled/i);
    expect(mockDriverFactory).toHaveBeenCalledTimes(1);
    expect(mockSessionFactory).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'disabled', uri: 'bolt://localhost:7687', expected: 'GraphRuntimeDisabledError' },
    { mode: undefined, uri: '', expected: 'GraphRuntimeUnconfiguredError' },
    { mode: 'neo4j', uri: 'bolt://localhost:7687', expected: 'bolt://localhost:7687' },
    { mode: undefined, uri: 'bolt://127.0.0.1:17687', expected: 'bolt://127.0.0.1:17687' },
  ])('enforces the runtime matrix in a plain Node + tsx process', ({ mode, uri, expected }) => {
    const env: NodeJS.ProcessEnv = { ...originalEnv, NODE_ENV: 'test', NEO4J_URI: uri };
    if (mode === undefined) delete env.RADARIST_GRAPH_RUNTIME_MODE;
    else env.RADARIST_GRAPH_RUNTIME_MODE = mode;

    const source = `
      import('./src/lib/graph/neo4j-client.ts').then((loaded) => {
        const api = loaded.getNeo4jConfig ? loaded : loaded.default;
        try { console.log(api.getNeo4jConfig().uri); }
        catch (error) { console.log(error instanceof Error ? error.name : 'UnknownError'); }
      });
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', source], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });
});
