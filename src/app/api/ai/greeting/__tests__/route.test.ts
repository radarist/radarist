/**
 * @file route.test.ts
 * @description Unit tests for GET /api/ai/greeting
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

// --- Mocks (hoisted above imports) ---

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/firebase', () => ({
  db: {},
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {},
  adminAuth: {},
  adminApp: {},
}));

jest.mock('@/lib/signals-admin', () => ({
  adminGetRecentSignals: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/agent-runs', () => ({
  listAgentRuns: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/ai/client', () => ({
  generateContent: jest
    .fn()
    .mockResolvedValue('Welcome back! 3 new signals were detected and 2 agent runs completed since yesterday.'),
}));

jest.mock('@/lib/ai/key-resolution', () => ({
  resolveGeminiApiKey: jest.fn(() => 'test-api-key'),
}));

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { adminGetRecentSignals: getRecentSignals } = jest.requireMock('@/lib/signals-admin');
const { listAgentRuns } = jest.requireMock('@/lib/agent-runs');
const { generateContent } = jest.requireMock('@/lib/ai/client');
const { resolveGeminiApiKey } = jest.requireMock('@/lib/ai/key-resolution');

import { GET } from '../route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost/api/ai/greeting', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/ai/greeting', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns greeting with stats when activity exists', async () => {
    const now = Date.now();
    const recentIso = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    getRecentSignals.mockResolvedValueOnce([
      { id: 'sig-1', title: 'AI breakthrough', detectedAt: now - 3600000 },
      { id: 'sig-2', title: 'New patent filed', detectedAt: now - 7200000 },
      { id: 'sig-3', title: 'Funding round', detectedAt: now - 10800000 },
    ]);

    listAgentRuns.mockResolvedValueOnce([
      {
        id: 'run-1',
        agentName: 'scout',
        status: 'completed',
        createdAt: recentIso,
        tokenUsage: { input: 100, output: 50 },
        costUsd: 0.001,
      },
      {
        id: 'run-2',
        agentName: 'evaluator',
        status: 'completed',
        createdAt: recentIso,
        tokenUsage: { input: 200, output: 100 },
        costUsd: 0.002,
      },
    ]);

    generateContent.mockResolvedValueOnce(
      '3 new signals detected including an AI breakthrough, with 2 agent runs completed.'
    );

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.greeting).toBe('3 new signals detected including an AI breakthrough, with 2 agent runs completed.');
    expect(json.stats).toEqual({ newSignals: 3, completedRuns: 2 });
    expect(json.generatedAt).toBeDefined();
    expect(new Date(json.generatedAt).getTime()).not.toBeNaN();

    // Verify AI was called with correct prompt
    expect(generateContent).toHaveBeenCalledWith(
      expect.stringContaining('New signals: 3'),
      expect.objectContaining({
        model: 'gemini-3.5-flash',
        maxOutputTokens: 200,
        temperature: 0.7,
      })
    );
    expect(generateContent).toHaveBeenCalledWith(
      expect.stringContaining('Agent runs completed: 2'),
      expect.any(Object)
    );
  });

  it('returns empty state when no activity without calling AI', async () => {
    getRecentSignals.mockResolvedValueOnce([]);
    listAgentRuns.mockResolvedValueOnce([]);

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.greeting).toBe('No new activity since yesterday.');
    expect(json.stats).toEqual({ newSignals: 0, completedRuns: 0 });
    expect(json.generatedAt).toBeDefined();

    // AI should NOT have been called
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('handles AI generation failure gracefully', async () => {
    getRecentSignals.mockResolvedValueOnce([{ id: 'sig-1', title: 'Test signal', detectedAt: Date.now() }]);
    listAgentRuns.mockResolvedValueOnce([]);

    generateContent.mockRejectedValueOnce(new Error('Gemini API rate limit exceeded'));

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.greeting).toBeNull();
    expect(json.stats).toEqual({ newSignals: 1, completedRuns: 0 });
    expect(json.generatedAt).toBeDefined();
  });

  it('short-circuits to the null-greeting response when keyless, without entering the reliability path', async () => {
    getRecentSignals.mockResolvedValueOnce([{ id: 'sig-1', title: 'Test signal', detectedAt: Date.now() }]);
    listAgentRuns.mockResolvedValueOnce([]);

    // No usable Gemini key (absent or setup-script placeholder)
    resolveGeminiApiKey.mockReturnValueOnce(undefined);

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.greeting).toBeNull();
    expect(json.stats).toEqual({ newSignals: 1, completedRuns: 0 });
    expect(json.generatedAt).toBeDefined();

    // generateContent is the ONLY path into withReliability (circuit breaker /
    // rate limiter) from this route — asserting it was never called proves the
    // keyless state never reaches the reliability layer.
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('filters agent runs to last 24 hours only', async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();

    getRecentSignals.mockResolvedValueOnce([]);
    listAgentRuns.mockResolvedValueOnce([
      {
        id: 'run-recent',
        agentName: 'scout',
        status: 'completed',
        createdAt: twoHoursAgo,
        tokenUsage: { input: 100, output: 50 },
        costUsd: 0.001,
      },
      {
        id: 'run-old',
        agentName: 'scout',
        status: 'completed',
        createdAt: twoDaysAgo,
        tokenUsage: { input: 100, output: 50 },
        costUsd: 0.001,
      },
    ]);

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Only the recent run should count
    expect(json.stats.completedRuns).toBe(1);
  });

  it('returns 500 when data fetching fails', async () => {
    getRecentSignals.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await GET(createRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal error');
  });
});
