/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock pipeline dependencies
jest.mock('@/lib/trends-admin', () => ({
  adminGetTrendStats: jest.fn(),
}));

jest.mock('@/lib/graph', () => ({
  getGraphServiceHealth: jest.fn(),
}));

jest.mock('@/lib/pipeline', () => ({
  getGraphRefreshStats: jest.fn(),
  verifyGraphIntegrity: jest.fn(),
}));

const { adminGetTrendStats } = jest.requireMock('@/lib/trends-admin');
const { getGraphServiceHealth } = jest.requireMock('@/lib/graph');
const { getGraphRefreshStats, verifyGraphIntegrity } = jest.requireMock('@/lib/pipeline');

import { GET } from '../route';

function createMockRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/pipeline/status', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/pipeline/status', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns full pipeline status with all components', async () => {
    adminGetTrendStats.mockResolvedValue({
      total: 10,
      emerging: 3,
      growing: 4,
      stable: 2,
      declining: 1,
    });
    getGraphServiceHealth.mockResolvedValue({
      healthy: true,
      backend: 'neo4j',
      latencyMs: 25,
    });
    getGraphRefreshStats.mockResolvedValue({
      nodeCount: 100,
      claimCount: 50,
      relationCount: 75,
    });
    verifyGraphIntegrity.mockResolvedValue({
      healthy: true,
      issues: [],
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.trends).toEqual({
      total: 10,
      emerging: 3,
      growing: 4,
      stable: 2,
      declining: 1,
    });
    expect(json.stats.graph).toEqual({
      nodes: 100,
      claims: 50,
      relations: 75,
    });
    expect(json.stats.integrity).toEqual({
      healthy: true,
      issues: 0,
    });
    expect(json.components.graphRefresh.healthy).toBe(true);
    expect(json.nextRun.source).toBe('cron');
    expect(json.nextRun.scheduledAt).toBeGreaterThan(0);
  });

  it('handles trend stats failure gracefully', async () => {
    adminGetTrendStats.mockRejectedValue(new Error('Trends service down'));
    getGraphServiceHealth.mockResolvedValue({ healthy: true, backend: 'neo4j', latencyMs: 10 });
    getGraphRefreshStats.mockResolvedValue({ nodeCount: 0, claimCount: 0, relationCount: 0 });
    verifyGraphIntegrity.mockResolvedValue({ healthy: true, issues: [] });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Falls back to default zeros
    expect(json.stats.trends).toEqual({
      total: 0,
      emerging: 0,
      growing: 0,
      stable: 0,
      declining: 0,
    });
  });

  it('handles graph health failure gracefully', async () => {
    adminGetTrendStats.mockResolvedValue({ total: 5, emerging: 1, growing: 2, stable: 1, declining: 1 });
    getGraphServiceHealth.mockRejectedValue(new Error('Neo4j down'));
    getGraphRefreshStats.mockResolvedValue({ nodeCount: 0, claimCount: 0, relationCount: 0 });
    verifyGraphIntegrity.mockResolvedValue({ healthy: true, issues: [] });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // graphRefresh should be unhealthy since getGraphServiceHealth defaults to healthy: false
    expect(json.components.graphRefresh.healthy).toBe(false);
  });

  it('handles graph refresh stats failure gracefully', async () => {
    adminGetTrendStats.mockResolvedValue({ total: 0, emerging: 0, growing: 0, stable: 0, declining: 0 });
    getGraphServiceHealth.mockResolvedValue({ healthy: true, backend: 'neo4j', latencyMs: 10 });
    getGraphRefreshStats.mockRejectedValue(new Error('Stats unavailable'));
    verifyGraphIntegrity.mockResolvedValue({ healthy: true, issues: [] });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.graph).toEqual({ nodes: 0, claims: 0, relations: 0 });
  });

  it('handles integrity verification failure gracefully', async () => {
    adminGetTrendStats.mockResolvedValue({ total: 0, emerging: 0, growing: 0, stable: 0, declining: 0 });
    getGraphServiceHealth.mockResolvedValue({ healthy: true, backend: 'neo4j', latencyMs: 10 });
    getGraphRefreshStats.mockResolvedValue({ nodeCount: 0, claimCount: 0, relationCount: 0 });
    verifyGraphIntegrity.mockRejectedValue(new Error('Integrity check failed'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.integrity).toEqual({ healthy: true, issues: 0 });
  });

  it('reports integrity issues count correctly', async () => {
    adminGetTrendStats.mockResolvedValue({ total: 0, emerging: 0, growing: 0, stable: 0, declining: 0 });
    getGraphServiceHealth.mockResolvedValue({ healthy: true, backend: 'neo4j', latencyMs: 10 });
    getGraphRefreshStats.mockResolvedValue({ nodeCount: 0, claimCount: 0, relationCount: 0 });
    verifyGraphIntegrity.mockResolvedValue({
      healthy: false,
      issues: ['Orphan node found', 'Dangling relation'],
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.integrity.healthy).toBe(false);
    expect(json.stats.integrity.issues).toBe(2);
  });
});
