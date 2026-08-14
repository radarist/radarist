/**
 * @file [id]/view/__tests__/route.test.ts
 * @description Tests for the debounced view-tracker endpoint (Q1).
 *
 * Pins:
 *   1. First call in a session → `recorded: true`, +1 preference per topic.
 *   2. Second call in the same session → `recorded: false`, no prefs.
 *   3. 404 when the insight doesn't exist.
 *   4. 401 unauth, 429 rate-limited.
 *
 * @jest-environment node
 */

const mockRecordInsightView = jest.fn();
const mockGetOrCreateActiveSession = jest.fn();
const mockAdjustInsightEngagement = jest.fn();
const mockTrackInsightEngagement = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  recordInsightView: (...args: unknown[]) => mockRecordInsightView(...args),
}));

jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getOrCreateActiveSession: (...args: unknown[]) => mockGetOrCreateActiveSession(...args),
}));

jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  adjustInsightEngagement: (...args: unknown[]) => mockAdjustInsightEngagement(...args),
  trackInsightEngagement: (...args: unknown[]) => mockTrackInsightEngagement(...args),
}));

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
const { POST } = require('../route');

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/impulse/briefing/pi-1/view', { method: 'POST' });
}

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/impulse/briefing/[id]/view', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
    mockGetOrCreateActiveSession.mockResolvedValue({ id: 'sess-1', userId: 'user-claudio', startedAt: 'now' });
    mockAdjustInsightEngagement.mockResolvedValue(undefined);
    mockTrackInsightEngagement.mockResolvedValue(undefined);
  });

  it('viewing an insight does not move preference weights', async () => {
    mockRecordInsightView.mockResolvedValue({ exists: true, recorded: true });

    const res = await POST(makeRequest(), makeCtx('pi-1'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetOrCreateActiveSession).toHaveBeenCalledWith('user-claudio');
    expect(mockRecordInsightView).toHaveBeenCalledWith('sess-1', 'pi-1', 'user-claudio');
    // Viewing is not an endorsement — no preference weight is recorded.
    expect(body).toEqual({ recorded: true, topicsWritten: 0 });
    // The route must NOT call any preference-tracking function on view.
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
  });

  it('debounces a second view in the same session — no preference write', async () => {
    mockRecordInsightView.mockResolvedValue({ exists: true, recorded: false });

    const res = await POST(makeRequest(), makeCtx('pi-1'));
    const body = await res.json();

    expect(body).toEqual({ recorded: false, topicsWritten: 0 });
    expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
  });

  it('returns 404 when the insight does not exist', async () => {
    mockRecordInsightView.mockResolvedValue({ exists: false, recorded: false });
    const res = await POST(makeRequest(), makeCtx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
    const res = await POST(makeRequest(), makeCtx('pi-1'));
    expect(res.status).toBe(401);
    expect(mockRecordInsightView).not.toHaveBeenCalled();
  });

  it('returns 429 once the per-user budget is exhausted', async () => {
    mockRecordInsightView.mockResolvedValue({ exists: true, recorded: false });
    for (let i = 0; i < 60; i++) {
      const res = await POST(makeRequest(), makeCtx(`pi-${i}`));
      expect(res.status).toBe(200);
    }
    const limited = await POST(makeRequest(), makeCtx('pi-overflow'));
    expect(limited.status).toBe(429);
  });
});
