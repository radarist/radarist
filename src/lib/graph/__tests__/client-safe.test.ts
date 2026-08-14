/**
 * @file client-safe.test.ts
 * @description Tests for the browser-side graph access module (P5-D graph
 * panel revival).
 *
 * Pins:
 *   1. `checkGraphAvailability` reads `/api/graph/status` and returns true
 *      only for a healthy, non-unavailable backend; network errors → false.
 *   2. `getNeighbors` calls `/api/graph/neighbors` with nodeId/depth/limit
 *      and returns the neighbors array; non-OK responses throw.
 *   3. `explainGraphConnection` calls `/api/graph/path` with from/to and
 *      returns the result; non-OK responses throw.
 *
 * @jest-environment jsdom
 */

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { checkGraphAvailability, getNeighbors, explainGraphConnection } from '../client-safe';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

describe('checkGraphAvailability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true for a healthy backend', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ mode: 'neo4j', healthy: true }));

    await expect(checkGraphAvailability()).resolves.toBe(true);
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/graph/status');
  });

  it('returns false when the backend is unhealthy', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ mode: 'neo4j', healthy: false }));

    await expect(checkGraphAvailability()).resolves.toBe(false);
  });

  it('returns false when the backend mode is unavailable', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ mode: 'unavailable', healthy: false }));

    await expect(checkGraphAvailability()).resolves.toBe(false);
  });

  it('returns false on non-OK responses', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    await expect(checkGraphAvailability()).resolves.toBe(false);
  });

  it('returns false when the request throws', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));

    await expect(checkGraphAvailability()).resolves.toBe(false);
  });
});

describe('getNeighbors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches neighbors with depth and limit params', async () => {
    const neighbors = [{ id: 'n1', labels: ['Entity'], properties: { name: 'A' } }];
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, neighbors }));

    const result = await getNeighbors('tech-1', { depth: 2, limit: 10 });

    expect(result).toEqual(neighbors);
    const url = mockFetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/api/graph/neighbors?');
    expect(url).toContain('nodeId=tech-1');
    expect(url).toContain('depth=2');
    expect(url).toContain('limit=10');
  });

  it('omits depth/limit params when not provided', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, neighbors: [] }));

    await getNeighbors('tech-1');

    const url = mockFetchWithAuth.mock.calls[0][0] as string;
    expect(url).not.toContain('depth=');
    expect(url).not.toContain('limit=');
  });

  it('throws on a degraded (503) response', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: false, degraded: true, error: 'unavailable' }, 503));

    await expect(getNeighbors('tech-1')).rejects.toThrow();
  });
});

describe('explainGraphConnection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the connection explanation', async () => {
    const result = {
      connected: true,
      explanation: 'A is connected to B.',
      pathNodes: [],
      pathRelations: [],
      hops: 1,
    };
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: true, result }));

    const explanation = await explainGraphConnection('a', 'b');

    expect(explanation).toEqual(result);
    const url = mockFetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/api/graph/path?');
    expect(url).toContain('from=a');
    expect(url).toContain('to=b');
  });

  it('throws on non-OK responses', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ success: false, error: 'boom' }, 500));

    await expect(explainGraphConnection('a', 'b')).rejects.toThrow();
  });
});
