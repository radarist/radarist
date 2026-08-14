/**
 * @jest-environment node
 */

const mockGetChangedSince = jest.fn();
const mockGetEntityTimeline = jest.fn();

jest.mock('@/lib/graph/temporal-queries', () => ({
  __esModule: true,
  getChangedSince: (...args: unknown[]) => mockGetChangedSince(...args),
  getEntityTimeline: (...args: unknown[]) => mockGetEntityTimeline(...args),
}));

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'test@test.com' }),
}));

import { NextRequest } from 'next/server';
const { GET } = require('../route');

describe('GET /api/graph/temporal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should return changes since date', async () => {
    mockGetChangedSince.mockResolvedValue([
      { sourceId: 'tech-1', targetId: 'co-1', relType: 'USES', t_observed: '2026-03-14' },
    ]);

    const request = new NextRequest('http://localhost/api/graph/temporal?since=2026-03-13T00:00:00Z');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.changes).toHaveLength(1);
  });

  it('should return entity timeline', async () => {
    mockGetEntityTimeline.mockResolvedValue([
      { relType: 'USES', connectedEntityId: 'co-1', connectedEntityName: 'Acme' },
    ]);

    const request = new NextRequest('http://localhost/api/graph/temporal?entityId=tech-1');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timeline).toHaveLength(1);
  });

  it('should return 400 when no params provided', async () => {
    const request = new NextRequest('http://localhost/api/graph/temporal');
    const response = await GET(request);

    expect(response.status).toBe(400);
  });
});
