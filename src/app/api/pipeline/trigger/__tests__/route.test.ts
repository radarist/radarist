/**
 * @file route.test.ts
 * @description Unit tests for POST /api/pipeline/trigger
 *
 * This route triggers the daily pipeline manually via Inngest.
 * It uses inngest.send() directly (not the sendEvent helper).
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { POST } from '../route';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: jest.fn(),
  },
}));

const { inngest } = jest.requireMock('@/lib/inngest/client');

function createMockRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/pipeline/trigger', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer test-token' },
  });
}

describe('POST /api/pipeline/trigger', () => {
  beforeEach(() => jest.clearAllMocks());

  it('triggers pipeline and returns success', async () => {
    inngest.send.mockResolvedValue(undefined);

    const res = await POST(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toBe('Pipeline triggered successfully');
    expect(json.triggeredAt).toBeDefined();
    expect(typeof json.triggeredAt).toBe('number');
    expect(typeof json.requestId).toBe('string');
  });

  it('sends correct event to inngest with source and metadata', async () => {
    inngest.send.mockResolvedValue(undefined);

    await POST(createMockRequest());

    expect(inngest.send).toHaveBeenCalledTimes(1);
    const sentEvent = inngest.send.mock.calls[0][0];
    expect(sentEvent.name).toBe('app/pipeline.trigger');
    expect(sentEvent.data.source).toBe('manual');
    expect(sentEvent.data.triggeredBy).toBe('api');
    expect(sentEvent.data.triggeredAt).toBeDefined();
    expect(typeof sentEvent.data.triggeredAt).toBe('number');
    expect(typeof sentEvent.data.requestId).toBe('string');
  });

  it('returns 500 when inngest.send throws', async () => {
    inngest.send.mockRejectedValue(new Error('Inngest service down'));

    const res = await POST(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to trigger pipeline');
  });

  it('returns 401 when user is not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });
});
