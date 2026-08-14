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

// Mock technology admin service (route migrated client→admin SDK)
jest.mock('@/lib/technology-admin', () => ({
  adminGetTechnologyById: jest.fn(),
}));

const { adminGetTechnologyById: getTechnologyById } = jest.requireMock('@/lib/technology-admin');

import { GET } from '../route';

function createMockRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/technologies/tech-1');
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/technologies/[id]', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'tech-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 404 when technology not found', async () => {
    getTechnologyById.mockResolvedValue(null);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'nonexistent-tech' }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Technology nonexistent-tech not found');
  });

  it('returns 200 with technology data on success', async () => {
    const mockTechnology = {
      id: 'tech-1',
      name: 'React',
      category: 'Frontend',
      status: 'active',
      description: 'A JavaScript library for building user interfaces',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    };
    getTechnologyById.mockResolvedValue(mockTechnology);

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'tech-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(mockTechnology);
    expect(json.id).toBe('tech-1');
    expect(json.name).toBe('React');
  });

  it('returns 500 on server error', async () => {
    getTechnologyById.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest(), {
      params: Promise.resolve({ id: 'tech-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to fetch technology');
  });
});
