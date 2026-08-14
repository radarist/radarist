/**
 * @jest-environment node
 *
 * DISC-016 — on-demand Graph Discovery scout. The route FAILS CLOSED: a request
 * without a usable (non-empty, well-formed) view context is rejected 400 before
 * ANY Firestore read, lock write, or event send — an unscoped or malformed
 * click can never reach candidate selection. Valid requests keep the original
 * contract: 200 fires the sweep + sets the per-user debounce lock; 401 unauth;
 * 429 within the debounce window (no event fired).
 */
jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/discovery/discovery-config', () => ({ getDiscoveryConfig: jest.fn() }));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: jest.fn(), createFunction: jest.fn() } }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const lockGet = jest.fn();
const lockSet = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  db: { collection: () => ({ doc: () => ({ get: lockGet, set: lockSet }) }) },
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as { getAuthenticatedUser: jest.Mock };
const { getDiscoveryConfig } = jest.requireMock('@/lib/discovery/discovery-config') as {
  getDiscoveryConfig: jest.Mock;
};
const { inngest } = jest.requireMock('@/lib/inngest/client') as { inngest: { send: jest.Mock } };

function req(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/discovery/scout', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** A minimal valid view context — what a graph click with entities in view sends. */
const VALID_CONTEXT = { focusEntityIds: ['tech-1'], focusTopics: ['graph-db'] };

describe('POST /api/discovery/scout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    getDiscoveryConfig.mockReturnValue({ enabled: true, scoutDebounceMs: 4 * 60 * 60 * 1000 });
    lockGet.mockResolvedValue({
      exists: true,
      data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 10 } }),
    });
    lockSet.mockResolvedValue(undefined);
    inngest.send.mockResolvedValue(undefined);
  });

  it('returns 401 and fires nothing when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  describe('fail-closed context validation (DISC-016)', () => {
    it.each([
      ['missing body', undefined],
      ['empty object body', {}],
      ['radarId without context (unscoped)', { radarId: 'agentic-ai-radar-1' }],
      ['non-object context', { context: 'not-an-object' }],
      ['array context', { context: ['tech-1'] }],
      ['context clamping to nothing (wrong item types)', { context: { focusEntityIds: [42], focusTopics: [null] } }],
      ['context with empty lists', { context: { focusEntityIds: [], focusTopics: [] } }],
      // DISC-016 P2 fix: ids alone are not scope — without topics the sweep
      // could only fall back to the generic profile ranking, which the UI
      // presents as view-scoped. Topics are required.
      ['ids-only context (no topics)', { context: { focusEntityIds: ['tech-1'] } }],
    ])('rejects %s with 400 before any read, lock, or event', async (_name, body) => {
      const res = await POST(req(body as Record<string, unknown> | undefined));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'invalid_context', dispatched: false });
      // The rejection happens BEFORE locks or events — nothing was read or written.
      expect(lockGet).not.toHaveBeenCalled();
      expect(lockSet).not.toHaveBeenCalled();
      expect(inngest.send).not.toHaveBeenCalled();
    });
  });

  it('returns 200, sets the lock, and fires the sweep event for a valid context', async () => {
    lockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: true } }) })
      .mockResolvedValueOnce({ exists: false, data: () => undefined });
    const res = await POST(req({ context: VALID_CONTEXT }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ dispatched: true });
    expect(lockSet).toHaveBeenCalled();
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/discovery.sweep.requested',
      data: { userId: 'u1', radarId: undefined, context: VALID_CONTEXT },
    });
  });

  it('forwards a radarId alongside a valid context', async () => {
    lockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: true } }) })
      .mockResolvedValueOnce({ exists: false, data: () => undefined });
    const res = await POST(req({ radarId: 'agentic-ai-radar-1782234764199', context: VALID_CONTEXT }));
    expect(res.status).toBe(200);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/discovery.sweep.requested',
      data: {
        userId: 'u1',
        radarId: 'agentic-ai-radar-1782234764199',
        context: VALID_CONTEXT,
      },
    });
  });

  it('clamps an oversized (but well-formed) context instead of rejecting it', async () => {
    lockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: true } }) })
      .mockResolvedValueOnce({ exists: false, data: () => undefined });

    const oversized = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const res = await POST(req({ context: { focusEntityIds: oversized, focusTopics: ['graph-db'] } }));
    expect(res.status).toBe(200);
    const sent = inngest.send.mock.calls[0][0] as { data: { context?: { focusEntityIds?: string[] } } };
    expect(sent.data.context?.focusEntityIds).toHaveLength(20);
  });

  it('does NOT commit the debounce lock when the sweep dispatch fails (no false lockout)', async () => {
    lockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: true } }) })
      .mockResolvedValueOnce({ exists: false, data: () => undefined });
    inngest.send.mockRejectedValue(new Error('inngest down'));
    const res = await POST(req({ context: VALID_CONTEXT }));
    expect(res.status).toBe(500);
    expect(lockSet).not.toHaveBeenCalled(); // user stays un-debounced, can retry
  });

  it('returns 429 with retryAfterMs and fires nothing within the debounce window', async () => {
    lockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: true } }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ lastScoutAt: Date.now() }) });
    const res = await POST(req({ context: VALID_CONTEXT }));
    const json = await res.json();
    expect(res.status).toBe(429);
    expect(json.retryAfterMs).toBeGreaterThan(0);
    expect(inngest.send).not.toHaveBeenCalled();
    expect(lockSet).not.toHaveBeenCalled();
  });

  it('refuses with maintenance_paused BEFORE dispatch when the environment guard is on (scoped env, restored after)', async () => {
    // The worker-side isMaintenancePaused() guard would otherwise silently skip a
    // sweep the UI already reported as queued. Set the env var ONLY inside this
    // test (never globally — that flips every ambient handler suite) and restore it.
    const previous = process.env.MAINTENANCE_PAUSED;
    process.env.MAINTENANCE_PAUSED = '1';
    try {
      const res = await POST(req({ context: VALID_CONTEXT }));
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'maintenance_paused', dispatched: false });
      expect(inngest.send).not.toHaveBeenCalled();
      expect(lockSet).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MAINTENANCE_PAUSED;
      else process.env.MAINTENANCE_PAUSED = previous;
    }
  });

  it('does not dispatch or debounce when the automation master switch is paused', async () => {
    lockGet.mockResolvedValueOnce({ exists: true, data: () => ({ sweep: { enabled: false } }) });

    const res = await POST(req({ context: VALID_CONTEXT }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'automation_paused', dispatched: false });
    expect(inngest.send).not.toHaveBeenCalled();
    expect(lockSet).not.toHaveBeenCalled();
  });

  it('fails closed without a debounce lock when the automation policy cannot be read', async () => {
    lockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await POST(req({ context: VALID_CONTEXT }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'automation_policy_unavailable', dispatched: false });
    expect(inngest.send).not.toHaveBeenCalled();
    expect(lockSet).not.toHaveBeenCalled();
  });

  it('does not dispatch when discovery is disabled', async () => {
    getDiscoveryConfig.mockReturnValue({ enabled: false, scoutDebounceMs: 4 * 60 * 60 * 1000 });

    const res = await POST(req({ context: VALID_CONTEXT }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'discovery_disabled', dispatched: false });
    expect(inngest.send).not.toHaveBeenCalled();
    expect(lockSet).not.toHaveBeenCalled();
  });
});
