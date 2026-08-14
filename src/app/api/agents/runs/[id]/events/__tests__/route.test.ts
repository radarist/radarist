/**
 * @jest-environment node
 */

const mockGetEventsForRun = jest.fn();

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  getEventsForRun: (...args: unknown[]) => mockGetEventsForRun(...args),
}));

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
const { GET } = require('../route');

function makeRequest(id: string) {
  const request = new NextRequest(`http://localhost/api/agents/runs/${id}/events`);
  return { request, ctx: { params: Promise.resolve({ id }) } };
}

describe('/api/agents/runs/[id]/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'test@test.com' });
  });

  it('GET returns the run events scoped to the authenticated user', async () => {
    mockGetEventsForRun.mockResolvedValue({
      events: [
        { id: 'evt-1', type: 'agent.started', userId: 'user-1', missionId: 'mission-1', sequence: 10, data: {} },
        { id: 'evt-2', type: 'agent.completed', userId: 'user-1', missionId: 'mission-1', sequence: 20, data: {} },
      ],
      truncated: false,
    });

    const { request, ctx } = makeRequest('mission-1');
    const response = await GET(request, ctx);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.events).toHaveLength(2);
    expect(data.events[0].id).toBe('evt-1');
    expect(data.truncated).toBe(false);
    expect(mockGetEventsForRun).toHaveBeenCalledWith('user-1', 'mission-1');
  });

  it('GET returns an empty list for an unknown or expired-history run (not 404)', async () => {
    mockGetEventsForRun.mockResolvedValue({ events: [], truncated: false });

    const { request, ctx } = makeRequest('nonexistent');
    const response = await GET(request, ctx);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.events).toEqual([]);
    expect(data.truncated).toBe(false);
  });

  it('GET passes truncated: true through when the run exceeded the 500-event query cap', async () => {
    mockGetEventsForRun.mockResolvedValue({
      events: [
        { id: 'evt-1', type: 'agent.started', userId: 'user-1', missionId: 'mission-1', sequence: 10, data: {} },
      ],
      truncated: true,
    });

    const { request, ctx } = makeRequest('mission-1');
    const response = await GET(request, ctx);
    const data = await response.json();

    expect(data.truncated).toBe(true);
  });

  it('GET returns 401 when unauthenticated and never queries', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Missing token' });

    const { request, ctx } = makeRequest('mission-1');
    const response = await GET(request, ctx);

    expect(response.status).toBe(401);
    expect(mockGetEventsForRun).not.toHaveBeenCalled();
  });

  it('GET returns 500 when the event query throws', async () => {
    mockGetEventsForRun.mockRejectedValue(new Error('firestore down'));

    const { request, ctx } = makeRequest('mission-1');
    const response = await GET(request, ctx);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to get run events');
  });
});
