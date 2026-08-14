/**
 * @file sec-008-ownership.route.test.ts
 * @description SEC-008 — insight ownership enforcement across the briefing
 * routes (detail, like, dismiss, bulk-dismiss, view) and the preference
 * endpoint.
 *
 * Contract:
 *   1. Every insight read/mutation threads the authenticated uid into the
 *      graph layer — ownership is bound inside the Cypher MATCH, never
 *      post-filtered in the route.
 *   2. Foreign and absent insight ids are indistinguishable: the service
 *      reports the same miss for both, and the route returns the same
 *      status and body, so existence of another user's insight never leaks.
 *   3. Preference writes stay bound to the caller's own uid.
 *
 * @jest-environment node
 */

const mockGetInsightById = jest.fn();
const mockSetInsightLikedState = jest.fn();
const mockSetInsightConsumedState = jest.fn();
const mockBulkSetInsightsConsumed = jest.fn();
const mockRecordInsightView = jest.fn();
const mockGetInsightTopics = jest.fn();
const mockTrackInsightEngagement = jest.fn();
const mockAdjustInsightEngagement = jest.fn();
const mockGetOrCreateActiveSession = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  getInsightById: (...args: unknown[]) => mockGetInsightById(...args),
  setInsightLikedState: (...args: unknown[]) => mockSetInsightLikedState(...args),
  setInsightConsumedState: (...args: unknown[]) => mockSetInsightConsumedState(...args),
  bulkSetInsightsConsumed: (...args: unknown[]) => mockBulkSetInsightsConsumed(...args),
  recordInsightView: (...args: unknown[]) => mockRecordInsightView(...args),
  getInsightTopics: (...args: unknown[]) => mockGetInsightTopics(...args),
}));

jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  trackInsightEngagement: (...args: unknown[]) => mockTrackInsightEngagement(...args),
  adjustInsightEngagement: (...args: unknown[]) => mockAdjustInsightEngagement(...args),
}));

jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getOrCreateActiveSession: (...args: unknown[]) => mockGetOrCreateActiveSession(...args),
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

const { GET: getDetail } = require('../[id]/route');
const { POST: postLike } = require('../like/route');
const { POST: postDismiss, DELETE: deleteDismiss } = require('../dismiss/route');
const { POST: postBulk } = require('../bulk-dismiss/route');
const { POST: postView } = require('../[id]/view/route');
const { POST: postPreference } = require('../../../graph/preference/route');

const UID = 'user-owner-a';

function jsonRequest(url: string, method: 'POST' | 'DELETE', body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function snapshot(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

describe('SEC-008 — uid is threaded into every insight read/mutation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: UID });
    mockGetInsightTopics.mockResolvedValue(['ai-infrastructure']);
    mockTrackInsightEngagement.mockResolvedValue(undefined);
    mockAdjustInsightEngagement.mockResolvedValue(undefined);
    mockGetOrCreateActiveSession.mockResolvedValue({ id: 'sess-1', userId: UID, startedAt: 'now' });
  });

  it('detail GET resolves the insight with the caller uid', async () => {
    mockGetInsightById.mockResolvedValue(null);
    await getDetail(new NextRequest('http://localhost/api/impulse/briefing/pi-1'), makeCtx('pi-1'));
    expect(mockGetInsightById).toHaveBeenCalledWith('pi-1', UID);
  });

  it('like POST sets liked state and derives topics with the caller uid', async () => {
    mockSetInsightLikedState.mockResolvedValue({ exists: true, previousLiked: false });
    await postLike(jsonRequest('http://localhost/api/impulse/briefing/like', 'POST', { insightId: 'pi-9' }));
    expect(mockSetInsightLikedState).toHaveBeenCalledWith('pi-9', true, UID);
    expect(mockGetInsightTopics).toHaveBeenCalledWith('pi-9', UID);
  });

  it('dismiss POST sets consumed state and derives topics with the caller uid', async () => {
    mockSetInsightConsumedState.mockResolvedValue({ exists: true, previousConsumed: false, previousTopics: [] });
    await postDismiss(jsonRequest('http://localhost/api/impulse/briefing/dismiss', 'POST', { insightId: 'pi-9' }));
    expect(mockGetInsightTopics).toHaveBeenCalledWith('pi-9', UID);
    expect(mockSetInsightConsumedState).toHaveBeenCalledWith('pi-9', true, UID, { topics: ['ai-infrastructure'] });
  });

  it('undismiss DELETE sets consumed state with the caller uid', async () => {
    mockSetInsightConsumedState.mockResolvedValue({
      exists: true,
      previousConsumed: true,
      previousTopics: ['ai-infrastructure'],
    });
    await deleteDismiss(jsonRequest('http://localhost/api/impulse/briefing/dismiss', 'DELETE', { insightId: 'pi-9' }));
    expect(mockSetInsightConsumedState).toHaveBeenCalledWith('pi-9', false, UID);
  });

  it('bulk-dismiss POST passes the caller uid alongside the batch', async () => {
    mockBulkSetInsightsConsumed.mockResolvedValue({ changed: 1 });
    await postBulk(
      jsonRequest('http://localhost/api/impulse/briefing/bulk-dismiss', 'POST', { insightIds: ['pi-1', 'pi-2'] })
    );
    expect(mockBulkSetInsightsConsumed).toHaveBeenCalledWith(['pi-1', 'pi-2'], true, UID);
  });

  it('view POST records the view bound to the caller uid', async () => {
    mockRecordInsightView.mockResolvedValue({ exists: true, recorded: true });
    await postView(
      new NextRequest('http://localhost/api/impulse/briefing/pi-1/view', { method: 'POST' }),
      makeCtx('pi-1')
    );
    expect(mockRecordInsightView).toHaveBeenCalledWith('sess-1', 'pi-1', UID);
  });

  it('preference POST derives topics with the caller uid', async () => {
    mockGetInsightTopics.mockResolvedValue([]);
    await postPreference(
      jsonRequest('http://localhost/api/graph/preference', 'POST', { insightId: 'ins-1', action: 'clicked' })
    );
    expect(mockGetInsightTopics).toHaveBeenCalledWith('ins-1', UID);
  });
});

describe('SEC-008 — foreign and absent ids are indistinguishable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitForTests();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: UID });
    mockGetInsightTopics.mockResolvedValue([]);
    mockGetOrCreateActiveSession.mockResolvedValue({ id: 'sess-1', userId: UID, startedAt: 'now' });
  });

  it('detail GET: a miss (foreign or absent — the graph layer cannot tell them apart) yields one identical 404', async () => {
    mockGetInsightById.mockResolvedValue(null);
    const foreign = await snapshot(
      await getDetail(new NextRequest('http://localhost/api/impulse/briefing/pi-of-user-b'), makeCtx('pi-of-user-b'))
    );
    const absent = await snapshot(
      await getDetail(new NextRequest('http://localhost/api/impulse/briefing/never-existed'), makeCtx('never-existed'))
    );

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.body).toEqual(absent.body);
    expect(foreign.body).toEqual({ error: 'Insight not found' });
  });

  it('like POST: a miss yields one identical 404 and never writes preferences', async () => {
    mockSetInsightLikedState.mockResolvedValue({ exists: false, previousLiked: false });
    const foreign = await snapshot(
      await postLike(jsonRequest('http://localhost/api/impulse/briefing/like', 'POST', { insightId: 'pi-of-user-b' }))
    );
    const absent = await snapshot(
      await postLike(jsonRequest('http://localhost/api/impulse/briefing/like', 'POST', { insightId: 'never-existed' }))
    );

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(absent);
    expect(foreign.body).toEqual({ error: 'Insight not found' });
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    expect(mockAdjustInsightEngagement).not.toHaveBeenCalled();
  });

  it('dismiss POST and view POST: a miss yields the same not-found shape as the detail route', async () => {
    mockSetInsightConsumedState.mockResolvedValue({ exists: false, previousConsumed: false, previousTopics: [] });
    mockRecordInsightView.mockResolvedValue({ exists: false, recorded: false });

    const dismissMiss = await snapshot(
      await postDismiss(jsonRequest('http://localhost/api/impulse/briefing/dismiss', 'POST', { insightId: 'x' }))
    );
    const viewMiss = await snapshot(
      await postView(new NextRequest('http://localhost/api/impulse/briefing/x/view', { method: 'POST' }), makeCtx('x'))
    );

    expect(dismissMiss.status).toBe(404);
    expect(viewMiss.status).toBe(404);
    expect(dismissMiss.body).toEqual({ error: 'Insight not found' });
    expect(viewMiss.body).toEqual({ error: 'Insight not found' });
  });
});
