/**
 * @file route.test.ts
 * @jest-environment node
 * @description Unit tests for the SSE streaming endpoint.
 *
 * @phase Phase 3: SSE Event Gateway
 */

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
}));

jest.mock('@/lib/agent-events', () => ({
  getEventsAfterSequence: jest.fn(),
}));

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { getEventsAfterSequence } = jest.requireMock('@/lib/agent-events') as {
  getEventsAfterSequence: jest.Mock;
};

import { NextRequest } from 'next/server';

const { GET } = require('../route');

/** Active abort controllers — cleaned up after each test */
const controllers: AbortController[] = [];

function createRequest(lastSequence?: number): NextRequest {
  const url =
    lastSequence !== undefined
      ? `http://localhost/api/events/stream?lastSequence=${lastSequence}`
      : 'http://localhost/api/events/stream';
  const ac = new AbortController();
  controllers.push(ac);
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
    signal: ac.signal,
  });
}

async function readStream(response: Response, maxChunks = 10): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for (let i = 0; i < maxChunks; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  reader.releaseLock();
  return chunks;
}

describe('GET /api/events/stream', () => {
  beforeEach(() => jest.clearAllMocks());

  afterEach(() => {
    // Abort all active streams to prevent dangling setTimeout
    for (const ac of controllers) ac.abort();
    controllers.length = 0;
  });

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: false,
      error: 'Not authenticated',
      reason: 'token-revoked',
    });

    const res = await GET(createRequest());
    expect(res.status).toBe(401);
    // UX-056: the stream body is plain text, so the bounded reason has to travel
    // in a header — it is the only thing that lets the client hook tell a stale
    // credential apart from a genuine sign-out and stop reconnecting.
    expect(res.headers.get('x-radarist-auth-reason')).toBe('token-revoked');
  });

  it('returns SSE content-type headers', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });
    getEventsAfterSequence
      .mockResolvedValueOnce([{ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} }])
      .mockResolvedValue([]);

    const res = await GET(createRequest(0));

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
  });

  it('streams events in SSE format', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });

    const mockEvent = {
      id: 'evt-1',
      type: 'agent.started',
      sequence: 1,
      userId: 'user-1',
      data: { agentName: 'scout' },
    };

    getEventsAfterSequence.mockResolvedValueOnce([mockEvent]).mockResolvedValue([]);

    const res = await GET(createRequest(0));
    const chunks = await readStream(res, 2);

    const firstChunk = chunks[0];
    expect(firstChunk).toContain('id: evt-1');
    expect(firstChunk).toContain('data: ');
    expect(firstChunk).toContain('"agentName":"scout"');
  });

  it('uses lastSequence query param as cursor', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });
    getEventsAfterSequence.mockResolvedValue([]);

    await GET(createRequest(42));

    expect(getEventsAfterSequence).toHaveBeenCalledWith('user-1', 42);
  });

  it('defaults lastSequence to 0 when not provided', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });
    getEventsAfterSequence.mockResolvedValue([]);

    await GET(createRequest());

    expect(getEventsAfterSequence).toHaveBeenCalledWith('user-1', 0);
  });

  it('sends keepalive comments on empty polls', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });
    getEventsAfterSequence.mockResolvedValue([]);

    const res = await GET(createRequest(0));
    const chunks = await readStream(res, 2);

    expect(chunks[0]).toContain(': keepalive');
  });

  it('closes stream when getEventsAfterSequence throws', async () => {
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'user-1',
      email: 'test@example.com',
    });
    getEventsAfterSequence.mockRejectedValue(new Error('Firestore error'));

    const res = await GET(createRequest(0));
    const chunks = await readStream(res, 1);

    // Stream should close gracefully — no chunks or empty
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});
