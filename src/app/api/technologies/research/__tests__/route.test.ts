/**
 * @file route.test.ts
 * @description Unit tests for POST /api/technologies/research
 *
 * This route triggers background AI research for a technology.
 * Supports two research types:
 * - Deep research (default): Basic AI research
 * - Comprehensive research: Full 12-section research with Google Search grounding
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';

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

jest.mock('@/lib/technology-admin', () => ({
  adminGetTechnologyById: jest.fn(),
}));

jest.mock('@/lib/technology-research-admin', () => ({
  claimResearchDispatch: jest.fn(),
  releaseResearchPending: jest.fn(),
}));

const { inngest } = jest.requireMock('@/lib/inngest/client');
const { adminGetTechnologyById: getTechnologyById } = jest.requireMock('@/lib/technology-admin');
const { claimResearchDispatch, releaseResearchPending } = jest.requireMock('@/lib/technology-research-admin');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/technologies/research', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const mockTechnology = {
  id: 'tech-123',
  name: 'React',
  description: 'A JavaScript library for building user interfaces',
  category: 'Frontend',
  websiteUrl: 'https://react.dev',
  researchStatus: null,
  researchStartedAt: null,
};

describe('POST /api/technologies/research', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTechnologyById.mockResolvedValue({ ...mockTechnology });
    claimResearchDispatch.mockImplementation(async (_id: string, startedAt: number) => ({
      claimed: true,
      reason: 'idle',
      startedAt,
    }));
    releaseResearchPending.mockResolvedValue({ released: true });
    inngest.send.mockResolvedValue(undefined);
  });

  // ---- Successful deep research ----

  it('triggers deep research by default', async () => {
    const res = await POST(createRequest({ technologyId: 'tech-123' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.researchType).toBe('deep');
    expect(json.status).toBe('pending');
    expect(json.technologyId).toBe('tech-123');
    expect(json.technologyName).toBe('React');
    expect(json.startedAt).toBeDefined();
  });

  it('sends deep research event to inngest', async () => {
    await POST(createRequest({ technologyId: 'tech-123' }));

    expect(inngest.send).toHaveBeenCalledTimes(1);
    const sentEvent = inngest.send.mock.calls[0][0];
    expect(sentEvent.name).toBe('app/technology.research.requested');
    expect(sentEvent.data.technologyId).toBe('tech-123');
    expect(sentEvent.data.technologyName).toBe('React');
    expect(sentEvent.data.category).toBe('Frontend');
    expect(sentEvent.data.websiteUrl).toBe('https://react.dev');
    expect(sentEvent.data.triggeredAt).toEqual(expect.any(Number));
  });

  it('threads the exact claimed attempt token into the event and response', async () => {
    const attempt = 1_800_000_000_123;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(attempt);
    try {
      const res = await POST(createRequest({ technologyId: 'tech-123' }));
      const json = await res.json();
      const sentEvent = inngest.send.mock.calls[0][0];

      expect(claimResearchDispatch).toHaveBeenCalledWith('tech-123', attempt);
      expect(sentEvent.data.triggeredAt).toBe(attempt);
      expect(json.startedAt).toBe(attempt);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // ---- Comprehensive research ----

  it('triggers comprehensive research when flag is set', async () => {
    const res = await POST(createRequest({ technologyId: 'tech-123', comprehensive: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.researchType).toBe('comprehensive');
    expect(json.message).toContain('Comprehensive');
  });

  it('sends comprehensive research event to inngest', async () => {
    await POST(createRequest({ technologyId: 'tech-123', comprehensive: true }));

    const sentEvent = inngest.send.mock.calls[0][0];
    expect(sentEvent.name).toBe('app/technology.comprehensive-research.requested');
  });

  // ---- Canonical entity identity ----

  it('ignores client-supplied identity fields and researches the canonical technology', async () => {
    await POST(
      createRequest({
        technologyId: 'tech-123',
        technologyName: 'Different Technology',
        technologyDescription: 'Untrusted stale description',
      })
    );

    const sentEvent = inngest.send.mock.calls[0][0];
    expect(sentEvent.data.technologyName).toBe('React');
    expect(sentEvent.data.technologyDescription).toBe('A JavaScript library for building user interfaces');
  });

  it('returns 400 for a malformed JSON body without claiming or dispatching', async () => {
    const request = new NextRequest('http://localhost/api/technologies/research', {
      method: 'POST',
      body: '{not-json',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(claimResearchDispatch).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---- Updates research status ----

  it('atomically claims the research slot before triggering the job', async () => {
    await POST(createRequest({ technologyId: 'tech-123' }));

    expect(claimResearchDispatch).toHaveBeenCalledWith('tech-123', expect.any(Number));
    const claimCallOrder = claimResearchDispatch.mock.invocationCallOrder[0];
    const sendCallOrder = inngest.send.mock.invocationCallOrder[0];
    expect(claimCallOrder).toBeLessThan(sendCallOrder);
  });

  // ---- Validation errors ----

  it('returns 400 when technologyId is missing', async () => {
    const res = await POST(createRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('technologyId is required');
    expect(getTechnologyById).not.toHaveBeenCalled();
  });

  it('returns 404 when technology does not exist', async () => {
    getTechnologyById.mockResolvedValue(null);

    const res = await POST(createRequest({ technologyId: 'tech-nonexistent' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
  });

  // ---- Duplicate prevention ----

  it('returns 409 when research is already pending', async () => {
    claimResearchDispatch.mockResolvedValue({
      claimed: false,
      reason: 'already-running',
      startedAt: Date.now() - 1000,
    });

    const res = await POST(createRequest({ technologyId: 'tech-123' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toContain('already in progress');
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // TEST-022: the old 10-minute window sat INSIDE the job's own 15-minute
  // budget, so a healthy run was re-dispatchable before it could finish.
  it('refuses a pending run that is still inside the job budget', async () => {
    claimResearchDispatch.mockResolvedValue({
      claimed: false,
      reason: 'already-running',
      startedAt: Date.now() - 14 * 60 * 1000,
    });

    const res = await POST(createRequest({ technologyId: 'tech-123' }));

    expect(res.status).toBe(409);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('allows re-triggering once the transactional claim marks a run abandoned', async () => {

    const res = await POST(createRequest({ technologyId: 'tech-123' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(inngest.send).toHaveBeenCalled();
  });

  it('returns 404 when the technology disappears before the transactional claim', async () => {
    claimResearchDispatch.mockResolvedValue({ claimed: false, reason: 'not-found' });

    expect((await POST(createRequest({ technologyId: 'tech-123' }))).status).toBe(404);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // TEST-022: pending is written BEFORE dispatch, so a send failure used to
  // strand the technology at "Researching..." with no job able to clear it.
  it('releases the technology from pending when dispatch fails', async () => {
    (inngest.send as jest.Mock).mockRejectedValueOnce(new Error('inngest unreachable'));

    const res = await POST(createRequest({ technologyId: 'tech-123' }));

    expect(res.status).toBe(500);
    expect(releaseResearchPending).toHaveBeenCalledWith('tech-123', 'dispatch-failed', expect.any(Number));
  });

  // ---- Error handling ----

  it('returns 500 when an unexpected error occurs', async () => {
    getTechnologyById.mockRejectedValue(new Error('Firestore error'));

    const res = await POST(createRequest({ technologyId: 'tech-123' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to trigger research');
  });

  it('returns 500 when inngest.send fails', async () => {
    inngest.send.mockRejectedValue(new Error('Inngest timeout'));

    const res = await POST(createRequest({ technologyId: 'tech-123' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to trigger research');
  });
});
