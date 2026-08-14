/**
 * Unit tests for the graph service factory.
 *
 * Sticky-backend recovery contract: after a transient Neo4j failure locks the
 * process onto the Firestore fallback, getGraphService() must re-probe Neo4j
 * health on a cooldown and switch back to Neo4jGraphService once it recovers —
 * instead of staying on the fallback forever.
 *
 * @jest-environment node
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(() => ({})),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(async () => ({ docs: [] })),
  query: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
}));

const mockCheckNeo4jHealth = jest.fn();

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  checkHealth: (...args: unknown[]) => mockCheckNeo4jHealth(...args),
  getNeo4jConfig: jest.fn(() => ({
    uri: 'bolt://localhost:7687',
    username: 'neo4j',
    password: 'test',
    database: 'neo4j',
  })),
}));

const mockNeo4jConnect = jest.fn();
const mockNeo4jIsHealthy = jest.fn();
const mockNeo4jDisconnect = jest.fn();

jest.mock('../neo4j-graph-service', () => ({
  __esModule: true,
  Neo4jGraphService: class MockNeo4jGraphService {
    connect = (...args: unknown[]) => mockNeo4jConnect(...args);
    isHealthy = (...args: unknown[]) => mockNeo4jIsHealthy(...args);
    disconnect = (...args: unknown[]) => mockNeo4jDisconnect(...args);
    getHealthDetails = jest.fn(async () => ({
      healthy: true,
      latencyMs: 1,
      backend: 'neo4j',
    }));
  },
}));

// Import AFTER mocks
import {
  getGraphMode,
  getGraphService,
  getGraphServiceHealth,
  resetGraphService,
} from '../service-factory';
import { FirestoreFallbackService } from '../firestore-fallback-service';
import { Neo4jGraphService } from '../neo4j-graph-service';

describe('service-factory sticky-backend recovery', () => {
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    delete process.env.NEXT_PUBLIC_GRAPH_BACKEND;
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    mockNeo4jConnect.mockResolvedValue(undefined);
    mockNeo4jIsHealthy.mockResolvedValue(true);
    mockNeo4jDisconnect.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await resetGraphService();
    nowSpy.mockRestore();
    delete process.env.NEO4J_URI;
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    delete process.env.NEXT_PUBLIC_GRAPH_BACKEND;
  });

  it('falls back to Firestore when Neo4j health check fails', async () => {
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });

    const service = await getGraphService();

    expect(service).toBeInstanceOf(FirestoreFallbackService);
  });

  it('keeps cold concurrent mode and health reads on the same initialized backend', async () => {
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });

    const [mode, health] = await Promise.all([getGraphMode(), getGraphServiceHealth()]);

    expect(mode).toMatchObject({ mode: 'firestore-fallback', maxHopsAvailable: 2 });
    expect(health).toMatchObject({ healthy: false, backend: 'firestore-fallback' });
    expect(mockCheckNeo4jHealth).toHaveBeenCalledTimes(1);
  });

  it('stays on the fallback within the re-probe cooldown (no health probe)', async () => {
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });
    await getGraphService();
    const initProbeCount = mockCheckNeo4jHealth.mock.calls.length;

    // Neo4j comes back, but we're still inside the cooldown window
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: true, latencyMs: 1 });
    nowSpy.mockReturnValue(130_000); // +30s < 60s cooldown

    const service = await getGraphService();

    expect(service).toBeInstanceOf(FirestoreFallbackService);
    expect(mockCheckNeo4jHealth.mock.calls.length).toBe(initProbeCount);
  });

  it('switches back to Neo4jGraphService once health recovers after the cooldown', async () => {
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });
    const degraded = await getGraphService();
    expect(degraded).toBeInstanceOf(FirestoreFallbackService);

    // Neo4j recovers; cooldown elapses
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: true, latencyMs: 1 });
    nowSpy.mockReturnValue(161_000); // +61s > 60s cooldown

    const recovered = await getGraphService();

    expect(recovered).toBeInstanceOf(Neo4jGraphService);
    expect(mockNeo4jConnect).toHaveBeenCalled();

    // Subsequent calls keep returning the recovered service
    const again = await getGraphService();
    expect(again).toBe(recovered);
  });

  it('stays on the fallback when the post-cooldown probe still fails', async () => {
    mockCheckNeo4jHealth.mockResolvedValue({ healthy: false, latencyMs: 1 });
    const fallback = await getGraphService();

    nowSpy.mockReturnValue(161_000);
    const service = await getGraphService();

    expect(service).toBe(fallback);
    expect(service).toBeInstanceOf(FirestoreFallbackService);
    expect(mockNeo4jConnect).not.toHaveBeenCalled();
  });

  it('never probes Neo4j when the fallback backend is explicitly forced', async () => {
    process.env.NEXT_PUBLIC_GRAPH_BACKEND = 'firestore-fallback';
    const service = await getGraphService();
    expect(service).toBeInstanceOf(FirestoreFallbackService);

    nowSpy.mockReturnValue(1_000_000); // far past any cooldown
    const stillFallback = await getGraphService();

    expect(stillFallback).toBeInstanceOf(FirestoreFallbackService);
    expect(mockCheckNeo4jHealth).not.toHaveBeenCalled();
  });

  it('never probes Neo4j when the server runtime is explicitly disabled', async () => {
    process.env.RADARIST_GRAPH_RUNTIME_MODE = 'disabled';
    // A retained/default target may still exist in `.env.local`; disabled wins.
    process.env.NEO4J_URI = 'bolt://localhost:7687';

    const service = await getGraphService();
    nowSpy.mockReturnValue(1_000_000);
    const stillFallback = await getGraphService();

    expect(service).toBeInstanceOf(FirestoreFallbackService);
    expect(stillFallback).toBe(service);
    expect(mockCheckNeo4jHealth).not.toHaveBeenCalled();
  });
});
