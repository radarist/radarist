/**
 * @jest-environment node
 *
 * Regression tests for the /api/graph/preference endpoint.
 *
 * Regression: the endpoint must derive the
 * preference TOPIC from the insight's linked entity types, not from the action
 * string. The old code was `trackInsightEngagement(uid, id, action, action)` —
 * every click bucketed under `topic='clicked'` and every dismiss under
 * `topic='dismissed'`, making the per-topic weights useless for biasing
 * future agent missions.
 */

import { NextRequest } from 'next/server';

const mockGetAuth = jest.fn();
const mockGetEntityTypes = jest.fn();
const mockTrackEngagement = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuth(...args),
}));

jest.mock('@/lib/graph/proactive-insights', () => ({
  getInsightTopics: (...args: unknown[]) => mockGetEntityTypes(...args),
}));

jest.mock('@/lib/graph/preferences', () => ({
  trackInsightEngagement: (...args: unknown[]) => mockTrackEngagement(...args),
}));

import { POST } from '../route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/graph/preference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/graph/preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({ authenticated: true, uid: 'user-claudio' });
    mockTrackEngagement.mockResolvedValue(undefined);
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockGetAuth.mockResolvedValue({ authenticated: false, error: 'No token' });

    const res = await POST(makeRequest({ insightId: 'ins-1', action: 'clicked' }));

    expect(res.status).toBe(401);
    expect(mockTrackEngagement).not.toHaveBeenCalled();
    expect(mockGetEntityTypes).not.toHaveBeenCalled();
  });

  it('rejects missing insightId or action with 400', async () => {
    const noId = await POST(makeRequest({ action: 'clicked' }));
    const noAction = await POST(makeRequest({ insightId: 'ins-1' }));

    expect(noId.status).toBe(400);
    expect(noAction.status).toBe(400);
    expect(mockTrackEngagement).not.toHaveBeenCalled();
  });

  it('rejects unknown actions with 400', async () => {
    const res = await POST(makeRequest({ insightId: 'ins-1', action: 'wat' }));

    expect(res.status).toBe(400);
    expect(mockTrackEngagement).not.toHaveBeenCalled();
  });

  it('derives topic from the insight entity types and writes one row per type', async () => {
    // The insight links a company to a technology — clicking it should bump
    // BOTH `company` and `technology` topic counters, not a single `clicked`
    // bucket.
    mockGetEntityTypes.mockResolvedValue(['company', 'technology']);

    const res = await POST(makeRequest({ insightId: 'ins-1', action: 'clicked' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, topicsWritten: 2 });
    expect(mockGetEntityTypes).toHaveBeenCalledWith('ins-1', 'user-claudio');
    expect(mockTrackEngagement).toHaveBeenCalledTimes(2);
    expect(mockTrackEngagement).toHaveBeenCalledWith('user-claudio', 'ins-1', 'acted', 'company');
    expect(mockTrackEngagement).toHaveBeenCalledWith('user-claudio', 'ins-1', 'acted', 'technology');

    // Regression guard: never pass the raw action verb as the topic.
    for (const call of mockTrackEngagement.mock.calls) {
      const [, , canonicalAction, topic] = call;
      expect(topic).not.toBe(canonicalAction);
      expect(['clicked', 'dismissed', 'acted_on']).not.toContain(topic);
    }
  });

  it('canonicalises "clicked" and "acted_on" to "acted"; "dismissed" stays', async () => {
    mockGetEntityTypes.mockResolvedValue(['technology']);

    await POST(makeRequest({ insightId: 'ins-1', action: 'clicked' }));
    await POST(makeRequest({ insightId: 'ins-1', action: 'acted_on' }));
    await POST(makeRequest({ insightId: 'ins-1', action: 'dismissed' }));

    const actions = mockTrackEngagement.mock.calls.map((c) => c[2]);
    expect(actions).toEqual(['acted', 'acted', 'dismissed']);
  });

  it('skips the write (and reports topicsWritten=0) when the insight has no linked entities', async () => {
    mockGetEntityTypes.mockResolvedValue([]);

    const res = await POST(makeRequest({ insightId: 'ins-orphan', action: 'clicked' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, topicsWritten: 0 });
    expect(mockTrackEngagement).not.toHaveBeenCalled();
  });

  it('returns 500 when trackInsightEngagement throws', async () => {
    mockGetEntityTypes.mockResolvedValue(['technology']);
    mockTrackEngagement.mockRejectedValue(new Error('Neo4j unavailable'));

    const res = await POST(makeRequest({ insightId: 'ins-1', action: 'clicked' }));

    expect(res.status).toBe(500);
  });
});
