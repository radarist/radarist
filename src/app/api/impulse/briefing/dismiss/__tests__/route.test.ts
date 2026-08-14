/**
 * @file dismiss/__tests__/route.test.ts
 * @description Tests for the dismiss / undismiss endpoint (Option A step A.2).
 *
 * Pins:
 *   1. POST sets consumed=true; idempotent on re-dismiss; writes +1 per topic.
 *   2. DELETE sets consumed=false; returns {noop:true} when not consumed;
 *      decrements `dismissed_count` only on the topics recorded by the
 *      previous dismiss (via `lastDismissWroteTopics` marker).
 *   3. Standard guards: 401, 400, 404, 429.
 *
 * @jest-environment node
 */

const mockSetInsightConsumedState = jest.fn();
const mockGetInsightEntityTypes = jest.fn();
const mockAdjustInsightEngagement = jest.fn();
const mockTrackInsightEngagement = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  setInsightConsumedState: (...args: unknown[]) => mockSetInsightConsumedState(...args),
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
  return new NextRequest('http://localhost/api/impulse/briefing/dismiss', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST/DELETE /api/impulse/briefing/dismiss', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
    mockGetInsightEntityTypes.mockResolvedValue(['technology', 'company']);
    mockAdjustInsightEngagement.mockResolvedValue(undefined);
    mockTrackInsightEngagement.mockResolvedValue(undefined);
  });

  describe('POST (dismiss)', () => {
    it('H12: flips consumed false → true and MERGEs +1 dismissed per topic (creates the row on first touch)', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: false,
        previousTopics: [],
      });

      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      expect(res.status).toBe(200);
      const body = await res.json();

      // The route persists the topic list on the insight node so undo can
      // roll back exactly those rows.
      expect(mockSetInsightConsumedState).toHaveBeenCalledWith('pi-1', true, 'user-claudio', {
        topics: ['technology', 'company'],
      });
      expect(body).toEqual({
        success: true,
        consumed: true,
        previousConsumed: false,
        changed: true,
        topicsWritten: 2,
      });
      // The dismissal is THE key negative signal — it must land even when no
      // UserPreference row exists yet, so it goes through the MERGE-capable
      // trackInsightEngagement, not the MATCH-only adjuster (silent no-op on miss).
      expect(mockTrackInsightEngagement).toHaveBeenCalledTimes(2);
      expect(mockTrackInsightEngagement).toHaveBeenNthCalledWith(1, 'user-claudio', 'pi-1', 'dismissed', 'technology');
      expect(mockTrackInsightEngagement).toHaveBeenNthCalledWith(2, 'user-claudio', 'pi-1', 'dismissed', 'company');
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });

    it('is idempotent — re-dismissing an already-consumed insight does not double-write', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: true,
        previousTopics: ['technology', 'company'],
      });

      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.previousConsumed).toBe(true);
      expect(body.changed).toBe(false);
      expect(body.topicsWritten).toBe(0);
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
      expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    });

    it('returns 404 when the insight does not exist', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: false,
        previousConsumed: false,
        previousTopics: [],
      });
      const res = await POST(makeRequest('POST', { insightId: 'missing' }));
      expect(res.status).toBe(404);
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });
  });

  describe('DELETE (undismiss)', () => {
    it('flips consumed true → false and rolls back via the MATCH-only adjuster (never resurrects rows)', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: true,
        previousTopics: ['technology', 'company'],
      });

      const res = await DELETE(makeRequest('DELETE', { insightId: 'pi-1' }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockSetInsightConsumedState).toHaveBeenCalledWith('pi-1', false, 'user-claudio');
      expect(body).toEqual({
        success: true,
        consumed: false,
        previousConsumed: true,
        changed: true,
        topicsRolledBack: 2,
      });
      expect(mockAdjustInsightEngagement).toHaveBeenCalledTimes(2);
      expect(mockAdjustInsightEngagement).toHaveBeenNthCalledWith(
        1,
        'user-claudio',
        'technology',
        'dismissed_count',
        -1
      );
      expect(mockAdjustInsightEngagement).toHaveBeenNthCalledWith(2, 'user-claudio', 'company', 'dismissed_count', -1);
      // The rollback path must stay MATCH-only — never MERGE a row back to life.
      expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    });

    it('returns {noop:true} when the insight was not consumed', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: false,
        previousTopics: [],
      });

      const res = await DELETE(makeRequest('DELETE', { insightId: 'pi-1' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        consumed: false,
        previousConsumed: false,
        noop: true,
      });
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });

    it('skips preference rollback for legacy dismisses with empty previousTopics', async () => {
      // Older dismisses (pre-A.2) never wrote `lastDismissWroteTopics`, so
      // the marker comes back empty. Undo flips consumed=false but does
      // NOT touch preferences — we never decrement what we never wrote.
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: true,
        previousTopics: [],
      });

      const res = await DELETE(makeRequest('DELETE', { insightId: 'pi-legacy' }));
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.consumed).toBe(false);
      expect(body.topicsRolledBack).toBe(0);
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });

    it('returns 404 when the insight does not exist', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: false,
        previousConsumed: false,
        previousTopics: [],
      });
      const res = await DELETE(makeRequest('DELETE', { insightId: 'missing' }));
      expect(res.status).toBe(404);
    });
  });

  describe('guards', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
      const res = await POST(makeRequest('POST', { insightId: 'pi-1' }));
      expect(res.status).toBe(401);
      expect(mockSetInsightConsumedState).not.toHaveBeenCalled();
    });

    it('returns 400 when insightId is missing or wrong type', async () => {
      const res1 = await POST(makeRequest('POST', {}));
      const res2 = await POST(makeRequest('POST', { insightId: 123 }));
      expect(res1.status).toBe(400);
      expect(res2.status).toBe(400);
    });

    it('returns 429 once the per-user budget is exhausted', async () => {
      mockSetInsightConsumedState.mockResolvedValue({
        exists: true,
        previousConsumed: false,
        previousTopics: [],
      });
      for (let i = 0; i < 60; i++) {
        const res = await POST(makeRequest('POST', { insightId: `pi-${i}` }));
        expect(res.status).toBe(200);
      }
      const limited = await POST(makeRequest('POST', { insightId: 'pi-overflow' }));
      expect(limited.status).toBe(429);
    });
  });
});
