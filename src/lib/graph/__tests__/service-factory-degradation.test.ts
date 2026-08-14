/**
 * Tests for F.4 — fail-loud-on-silent-firestore-fallback.
 *
 * Guarantees:
 *   - Every silent fallback increments degradationCount
 *   - IMPULSE_GRAPH_STRICT=true refuses fallbacks outright
 *   - getGraphDegradationStats exposes the counter for /health
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  getNeo4jConfig: jest.fn(),
  checkHealth: jest.fn(),
}));

jest.mock('../neo4j-graph-service', () => ({
  __esModule: true,
  Neo4jGraphService: jest.fn(),
}));

jest.mock('../firestore-fallback-service', () => ({
  __esModule: true,
  FirestoreFallbackService: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isHealthy: jest.fn().mockResolvedValue(true),
    getHealthDetails: jest.fn().mockResolvedValue({ healthy: true, backend: 'firestore-fallback', latencyMs: 0 }),
  })),
}));

jest.mock('../mock-graph-service', () => ({
  __esModule: true,
  MockGraphService: jest.fn(),
  SAMPLE_GRAPH_FIXTURE: {},
}));

/**
 * Load the service-factory fresh per test (jest.resetModules clears the
 * module cache, and we also need to re-grab the mocked neo4j-client so
 * both modules share the same mock functions).
 */
async function loadFactory() {
  const client = await import('../neo4j-client');
  const factory = await import('../service-factory');
  return {
    getNeo4jConfig: client.getNeo4jConfig as jest.Mock,
    checkHealth: client.checkHealth as jest.Mock,
    ...factory,
  };
}

describe('service-factory — F.4 fail-loud degradation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.NEO4J_URI = 'bolt://x';
    delete process.env.IMPULSE_GRAPH_STRICT;
    delete process.env.NEXT_PUBLIC_GRAPH_BACKEND;
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('getGraphDegradationStats starts at zero on a fresh import', async () => {
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: 'bolt://x', username: 'u', password: 'p' });
    const stats = m.getGraphDegradationStats();
    expect(stats.degradationCount).toBe(0);
    expect(stats.lastDegradationAt).toBeNull();
    expect(stats.strict).toBe(false);
  });

  it('getGraphServiceConfig with NEO4J_URI unset increments degradation and returns firestore-fallback', async () => {
    delete process.env.NEO4J_URI;
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: undefined, username: '', password: '' });
    const cfg = m.getGraphServiceConfig();
    expect(cfg.backend).toBe('firestore-fallback');
    expect(m.getGraphDegradationStats().degradationCount).toBe(1);
    expect(m.getGraphDegradationStats().lastDegradationReason).toMatch(/NEO4J_URI not set/);
  });

  it('getGraphServiceConfig with NEO4J_URI set returns neo4j without counting a degradation', async () => {
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: 'bolt://x', username: 'u', password: 'p' });
    const cfg = m.getGraphServiceConfig();
    expect(cfg.backend).toBe('neo4j');
    expect(m.getGraphDegradationStats().degradationCount).toBe(0);
  });

  it('IMPULSE_GRAPH_STRICT=true + NEO4J_URI unset throws instead of falling back', async () => {
    process.env.IMPULSE_GRAPH_STRICT = 'true';
    delete process.env.NEO4J_URI;
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: undefined, username: '', password: '' });
    expect(() => m.getGraphServiceConfig()).toThrow(/IMPULSE_GRAPH_STRICT=true but NEO4J_URI is unset/);
    expect(m.getGraphDegradationStats().degradationCount).toBe(1);
    expect(m.getGraphDegradationStats().strict).toBe(true);
  });

  it('initializeNeo4jWithFallback — Neo4j unhealthy in non-strict mode lands on Firestore + records degradation', async () => {
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: 'bolt://x', username: 'u', password: 'p' });
    m.checkHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });

    const svc = await m.getGraphService();
    expect(svc).toBeDefined();
    const stats = m.getGraphDegradationStats();
    expect(stats.degradationCount).toBe(1);
    expect(stats.lastDegradationReason).toMatch(/Neo4j health check failed/);
  });

  it('initializeNeo4jWithFallback — Neo4j unhealthy in strict mode throws loud', async () => {
    process.env.IMPULSE_GRAPH_STRICT = 'true';
    const m = await loadFactory();
    m.getNeo4jConfig.mockReturnValue({ uri: 'bolt://x', username: 'u', password: 'p' });
    m.checkHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });

    await expect(m.getGraphService()).rejects.toThrow(/IMPULSE_GRAPH_STRICT=true refuses silent fallback/);
    expect(m.getGraphDegradationStats().degradationCount).toBe(1);
  });

  it('explicit disabled mode is intentional fallback and never calls the Neo4j client', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    const m = await loadFactory();

    const cfg = m.getGraphServiceConfig();

    expect(cfg.backend).toBe('firestore-fallback');
    expect(cfg.neo4j).toBeUndefined();
    expect(m.getNeo4jConfig).not.toHaveBeenCalled();
    expect(m.checkHealth).not.toHaveBeenCalled();
    expect(m.getGraphDegradationStats().degradationCount).toBe(0);
  });

  it('disabled mode overrides a retained public Neo4j backend preference', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    process.env.NEXT_PUBLIC_GRAPH_BACKEND = 'neo4j';
    const m = await loadFactory();

    const service = await m.getGraphService();

    expect(service).toBeDefined();
    expect(m.getGraphServiceConfig().backend).toBe('firestore-fallback');
    expect(m.getNeo4jConfig).not.toHaveBeenCalled();
    expect(m.checkHealth).not.toHaveBeenCalled();
    expect(m.getGraphDegradationStats().degradationCount).toBe(0);
  });

  it('unconfigured mode falls back without a health probe or recovery probe', async () => {
    delete process.env.NEO4J_URI;
    const m = await loadFactory();

    const first = await m.getGraphService();
    const second = await m.getGraphService();

    expect(first).toBe(second);
    expect(m.getNeo4jConfig).not.toHaveBeenCalled();
    expect(m.checkHealth).not.toHaveBeenCalled();
    expect(m.getGraphDegradationStats().degradationCount).toBe(1);
    expect(m.getGraphDegradationStats().lastDegradationReason).toMatch(/NEO4J_URI not set/);
  });
});
