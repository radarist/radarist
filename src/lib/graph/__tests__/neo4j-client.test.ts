/**
 * @file neo4j-client.test.ts
 * @description Boot-time guard tests for getNeo4jConfig().
 *
 * Guarantees:
 *   - Throws when NEO4J_PASSWORD is the placeholder ('change-me-required')
 *     AND NODE_ENV === 'production'.
 *   - Never invents the protected default URI when NEO4J_URI is blank/unset.
 *   - Explicit graph-disable mode wins even when a URI is present.
 *   - Returns config when a URI is explicit and the placeholder password is in
 *     use under development so normal local full-stack startup keeps working.
 */

describe('getNeo4jConfig — placeholder password guard', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_DATABASE;
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: ORIGINAL_NODE_ENV });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('getNeo4jConfig throws when NEO4J_PASSWORD is the placeholder and NODE_ENV is production', async () => {
    process.env.NEO4J_PASSWORD = 'change-me-required';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production' });

    const { getNeo4jConfig } = await import('../neo4j-client');

    expect(() => getNeo4jConfig()).toThrow(/NEO4J_PASSWORD must be set to a real value when NODE_ENV=production/);
  });

  it.each([undefined, '', '   '])('refuses an unset or blank NEO4J_URI instead of defaulting to port 7687', async (uri) => {
    if (uri === undefined) delete process.env.NEO4J_URI;
    else process.env.NEO4J_URI = uri;
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development' });

    const { getNeo4jConfig } = await import('../neo4j-client');

    expect(() => getNeo4jConfig()).toThrow(/NEO4J_URI is not configured/);
  });

  it('explicit disabled mode wins over a protected default-port URI', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
    process.env.NEO4J_URI = 'bolt://localhost:7687';

    const { getNeo4jConfig } = await import('../neo4j-client');

    expect(() => getNeo4jConfig()).toThrow(/graph runtime is disabled/i);
  });

  it('getNeo4jConfig succeeds for an explicit local URI in development', async () => {
    process.env.NEO4J_PASSWORD = 'change-me-required';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development' });

    const { getNeo4jConfig } = await import('../neo4j-client');

    const config = getNeo4jConfig();
    expect(config.password).toBe('change-me-required');
    expect(config.username).toBe('neo4j');
    expect(config.uri).toBe('bolt://localhost:7687');
  });
});
