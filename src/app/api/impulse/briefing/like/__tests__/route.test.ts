/**
 * @file like/__tests__/route.test.ts
 * @description Tests for the like / unlike endpoint (Option A step A.1).
 *
 * Pins four contracts:
 *   1. POST sets liked=true; DELETE sets liked=false.
 *   2. Idempotency: when previousLiked already matches the requested
 *      state, no preference write fires (`topicsWritten: 0`).
 *   3. Real transitions (false→true or true→false) call
 *      `adjustInsightEngagement` once per topic with the right delta.
 *   4. Standard route guards: 401 unauth, 400 missing body, 404 unknown
 *      insight, 429 rate-limited.
 *
 * @jest-environment node
 */

const mockSetInsightLikedState = jest.fn();
const mockGetInsightEntityTypes = jest.fn();
const mockAdjustInsightEngagement = jest.fn();
const mockTrackInsightEngagement = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  setInsightLikedState: (...args: unknown[]) => mockSetInsightLikedState(...args),
  getInsightTopics: (...args: unknown[]) => mockGetInsightEntityTypes(...args),
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
const { POST, DELETE } = require('../route');

function makeRequest(method: 'POST' | 'DELETE', body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/impulse/briefing/like', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST/DELETE /api/impulse/briefing/like', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
    mockGetInsightEntityTypes.mockResolvedValue(['technology', 'company']);
    mockAdjustInsightEngagement.mockResolvedValue(undefined);
    mockTrackInsightEngagement.mockResolvedValue(undefined);
  });

  describe('POST (set liked=true)', () => {
    it('H12: flips liked false → true and MERGEs +1 acted per topic (creates the row on first touch)', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: false });

      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockSetInsightLikedState).toHaveBeenCalledWith('pi-1', true, 'user-claudio');
      expect(body).toEqual({
        success: true,
        liked: true,
        previousLiked: false,
        changed: true,
        topicsWritten: 2,
      });
      // First-touch MUST go through trackInsightEngagement (MERGE — creates the
      // UserPreference row when absent). adjustInsightEngagement is MATCH-only
      // (silent no-op on a missing row) and is reserved for rollback paths.
      expect(mockTrackInsightEngagement).toHaveBeenCalledTimes(2);
      expect(mockTrackInsightEngagement).toHaveBeenNthCalledWith(1, 'user-claudio', 'pi-1', 'acted', 'technology');
      expect(mockTrackInsightEngagement).toHaveBeenNthCalledWith(2, 'user-claudio', 'pi-1', 'acted', 'company');
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });

    it('is idempotent — re-liking an already-liked insight does not double-write', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: true });

      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        success: true,
        liked: true,
        previousLiked: true,
        changed: false,
        topicsWritten: 0,
      });
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
      expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
      expect(mockGetInsightEntityTypes).not.toHaveBeenCalled();
    });

    it('returns 404 when the insight does not exist', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: false, previousLiked: false });
      const res = await POST(makeRequest('POST', { insightId: 'missing' }));
      expect(res.status).toBe(404);
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });
  });

  describe('DELETE (set liked=false)', () => {
    it('flips liked true → false and rolls back -1 via the MATCH-only adjuster (never resurrects rows)', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: true });

      const res = await DELETE(makeRequest('DELETE', { insightId: 'pi-1' }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockSetInsightLikedState).toHaveBeenCalledWith('pi-1', false, 'user-claudio');
      expect(body).toEqual({
        success: true,
        liked: false,
        previousLiked: true,
        changed: true,
        topicsWritten: 2,
      });
      expect(mockAdjustInsightEngagement).toHaveBeenCalledTimes(2);
      expect(mockAdjustInsightEngagement).toHaveBeenNthCalledWith(1, 'user-claudio', 'technology', 'acted_count', -1);
      expect(mockAdjustInsightEngagement).toHaveBeenNthCalledWith(2, 'user-claudio', 'company', 'acted_count', -1);
      // The rollback path must stay MATCH-only — never MERGE a row back to life.
      expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    });

    it('is idempotent — unliking an already-unliked insight is a noop', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: false });
      const res = await DELETE(makeRequest('DELETE', { insightId: 'pi-1' }));
      const body = await res.json();

      expect(body.changed).toBe(false);
      expect(body.topicsWritten).toBe(0);
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      expect(res.status).toBe(401);
      expect(mockSetInsightLikedState).not.toHaveBeenCalled();
    });

    it('returns 400 when insightId is missing', async () => {
      const res = await POST(makeRequest('POST', {}));
      expect(res.status).toBe(400);
      expect(mockSetInsightLikedState).not.toHaveBeenCalled();
    });

    it('returns 400 when insightId is not a string', async () => {
      const res = await POST(makeRequest('POST', { insightId: 123 }));
      expect(res.status).toBe(400);
    });

    it('returns 400 on malformed JSON', async () => {
      const request = new NextRequest('http://localhost/api/impulse/briefing/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const res = await POST(request);
      expect(res.status).toBe(400);
    });

    it('returns 429 once the per-user budget is exhausted', async () => {
      mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: false });
      // Default limit is 60 req/min — fire 60 then expect the next to 429.
      for (let i = 0; i < 60; i++) {
        const res = await POST(makeRequest('POST', { insightId: `pi-${i}` }));
        expect(res.status).toBe(200);
      }
      const limited = await POST(makeRequest('POST', { insightId: 'pi-overflow' }));
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBeTruthy();
    });
  });
});
