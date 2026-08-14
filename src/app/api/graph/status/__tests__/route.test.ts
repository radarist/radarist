/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
}));

jest.mock('@/lib/graph/service-factory', () => ({
  getGraphMode: jest.fn(),
  getGraphServiceHealth: jest.fn(),
}));

import { GET } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { getGraphMode, getGraphServiceHealth } = jest.requireMock('@/lib/graph/service-factory') as {
  getGraphMode: jest.Mock;
  getGraphServiceHealth: jest.Mock;
};

function request(): NextRequest {
  return new NextRequest('http://localhost/api/graph/status', {
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/graph/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1' });
  });

  it('waits for mode initialization before reading the selected backend health', async () => {
    const order: string[] = [];
    getGraphMode.mockImplementation(async () => {
      order.push('mode:start');
      await Promise.resolve();
      order.push('mode:end');
      return { mode: 'firestore-fallback', maxHopsAvailable: 2 };
    });
    getGraphServiceHealth.mockImplementation(async () => {
      order.push('health');
      return {
        healthy: false,
        backend: 'firestore-fallback',
        latencyMs: 3,
        checkedAt: Date.parse('2026-07-17T00:00:00.000Z'),
      };
    });

    const response = await GET(request());

    expect(order).toEqual(['mode:start', 'mode:end', 'health']);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'firestore-fallback',
      backend: 'firestore-fallback',
      healthy: false,
      maxHopsAvailable: 2,
    });
  });

  it('authenticates before initializing graph services', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(getGraphMode).not.toHaveBeenCalled();
    expect(getGraphServiceHealth).not.toHaveBeenCalled();
  });
});
