/**
 * @file bulk-dismiss/__tests__/route.test.ts
 * @description Tests for bulk dismiss / undismiss (Option A step A.2, Q3).
 *
 * Pins:
 *   1. POST sets consumed=true for the batch, no preference writes.
 *   2. DELETE sets consumed=false for the batch, no preference rollback.
 *   3. Input validation: empty array → 400, oversized batch → 400,
 *      non-string entries → 400. Duplicates are de-duped silently.
 *   4. 401, 429 guards.
 *
 * @jest-environment node
 */

const mockBulkSetInsightsConsumed = jest.fn();
const mockAdjustInsightEngagement = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  bulkSetInsightsConsumed: (...args: unknown[]) => mockBulkSetInsightsConsumed(...args),
}));

jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  adjustInsightEngagement: (...args: unknown[]) => mockAdjustInsightEngagement(...args),
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
  return new NextRequest('http://localhost/api/impulse/briefing/bulk-dismiss', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST/DELETE /api/impulse/briefing/bulk-dismiss', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
    mockAdjustInsightEngagement.mockResolvedValue(undefined);
  });

  describe('POST (bulk dismiss)', () => {
    it('marks the batch consumed=true and skips preference writes (Q3)', async () => {
      mockBulkSetInsightsConsumed.mockResolvedValue({ changed: 3 });

      const res = await POST(makeRequest('POST', { insightIds: ['pi-1', 'pi-2', 'pi-3'] }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockBulkSetInsightsConsumed).toHaveBeenCalledWith(['pi-1', 'pi-2', 'pi-3'], true, 'user-claudio');
      expect(body).toEqual({
        success: true,
        consumed: true,
        requested: 3,
        changed: 3,
      });
      // Q3 contract — bulk skips preference writes entirely.
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });

    it('de-duplicates ids in the batch before forwarding to the DB layer', async () => {
      mockBulkSetInsightsConsumed.mockResolvedValue({ changed: 2 });

      await POST(makeRequest('POST', { insightIds: ['pi-1', 'pi-2', 'pi-1', 'pi-2'] }));

      const [forwarded] = mockBulkSetInsightsConsumed.mock.calls[0];
      expect(forwarded).toHaveLength(2);
      expect(new Set(forwarded)).toEqual(new Set(['pi-1', 'pi-2']));
    });
  });

  describe('DELETE (bulk undismiss)', () => {
    it('marks the batch consumed=false and skips preference rollback', async () => {
      mockBulkSetInsightsConsumed.mockResolvedValue({ changed: 2 });

      const res = await DELETE(makeRequest('DELETE', { insightIds: ['pi-1', 'pi-2'] }));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(mockBulkSetInsightsConsumed).toHaveBeenCalledWith(['pi-1', 'pi-2'], false, 'user-claudio');
      expect(body).toEqual({
        success: true,
        consumed: false,
        requested: 2,
        changed: 2,
      });
      expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
      const res = await POST(makeRequest('POST', { insightIds: ['pi-1'] }));
      expect(res.status).toBe(401);
      expect(mockBulkSetInsightsConsumed).not.toHaveBeenCalled();
    });

    it('returns 400 when insightIds is missing', async () => {
      const res = await POST(makeRequest('POST', {}));
      expect(res.status).toBe(400);
    });

    it('returns 400 when insightIds is not an array', async () => {
      const res = await POST(makeRequest('POST', { insightIds: 'pi-1' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when insightIds is empty', async () => {
      const res = await POST(makeRequest('POST', { insightIds: [] }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when an entry is not a non-empty string', async () => {
      const res1 = await POST(makeRequest('POST', { insightIds: ['pi-1', 123] }));
      const res2 = await POST(makeRequest('POST', { insightIds: ['pi-1', ''] }));
      expect(res1.status).toBe(400);
      expect(res2.status).toBe(400);
    });

    it('returns 400 when the batch exceeds the max size (200)', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => `pi-${i}`);
      const res = await POST(makeRequest('POST', { insightIds: ids }));
      expect(res.status).toBe(400);
      expect(mockBulkSetInsightsConsumed).not.toHaveBeenCalled();
    });

    it('returns 429 once the per-user budget is exhausted', async () => {
      mockBulkSetInsightsConsumed.mockResolvedValue({ changed: 1 });
      for (let i = 0; i < 60; i++) {
        const res = await POST(makeRequest('POST', { insightIds: [`pi-${i}`] }));
        expect(res.status).toBe(200);
      }
      const limited = await POST(makeRequest('POST', { insightIds: ['pi-overflow'] }));
      expect(limited.status).toBe(429);
    });
  });
});
