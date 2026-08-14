/**
 * @file route.test.ts
 * @description Unit tests for POST /api/agents/feedback
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn(() => ({ id: 'fb-123', set: mockSet }));

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({ doc: mockDoc })),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agents/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/agents/feedback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates feedback with positive rating', async () => {
    const res = await POST(createRequest({ missionId: 'mission-1', rating: 'positive' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.id).toBe('fb-123');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-1',
        rating: 'positive',
        comment: null,
        userId: 'test-user-123',
      })
    );
  });

  it('creates feedback with negative rating and comment', async () => {
    const res = await POST(createRequest({ missionId: 'mission-2', rating: 'negative', comment: 'Not helpful' }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-2',
        rating: 'negative',
        comment: 'Not helpful',
      })
    );
  });

  it('returns 400 when missionId is missing', async () => {
    const res = await POST(createRequest({ rating: 'positive' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
  });

  it('returns 400 when rating is invalid', async () => {
    const res = await POST(createRequest({ missionId: 'mission-1', rating: 'maybe' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Unauthorized',
    });

    const res = await POST(createRequest({ missionId: 'mission-1', rating: 'positive' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });

  it('returns 500 on Firestore error', async () => {
    mockSet.mockRejectedValueOnce(new Error('Firestore write failed'));

    const res = await POST(createRequest({ missionId: 'mission-1', rating: 'positive' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to record feedback');
  });
});
