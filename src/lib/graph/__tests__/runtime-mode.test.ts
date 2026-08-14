/**
 * @jest-environment node
 */

describe('graph runtime mode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    delete process.env.NEO4J_URI;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([undefined, '', '   '])('classifies a missing or blank URI as unconfigured', async (uri) => {
    if (uri === undefined) delete process.env.NEO4J_URI;
    else process.env.NEO4J_URI = uri;

    const { resolveGraphRuntime } = await import('../runtime-mode');

    expect(resolveGraphRuntime()).toEqual({ mode: 'unconfigured' });
  });

  it.each(['bolt://localhost:7687', 'bolt://127.0.0.1:17687'])(
    'accepts an explicit normal or disposable Neo4j URI: %s',
    async (uri) => {
      process.env.NEO4J_URI = uri;

      const { resolveGraphRuntime } = await import('../runtime-mode');

      expect(resolveGraphRuntime()).toEqual({ mode: 'neo4j', uri });
    }
  );

  it.each(['bolt://localhost:7687', 'bolt://127.0.0.1:17687'])(
    'disabled mode wins over every configured target: %s',
    async (uri) => {
      process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
      process.env.NEO4J_URI = uri;

      const { resolveGraphRuntime } = await import('../runtime-mode');

      expect(resolveGraphRuntime()).toEqual({ mode: 'disabled' });
    }
  );

  it('requires a URI when explicit Neo4j mode is selected', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'neo4j';

    const { resolveGraphRuntime } = await import('../runtime-mode');

    expect(() => resolveGraphRuntime()).toThrow(/requires a non-empty NEO4J_URI/);
  });

  it('rejects unknown mode values instead of guessing', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'auto';

    const { resolveGraphRuntime } = await import('../runtime-mode');

    expect(() => resolveGraphRuntime()).toThrow(/must be either "neo4j" or "disabled"/);
  });
});
