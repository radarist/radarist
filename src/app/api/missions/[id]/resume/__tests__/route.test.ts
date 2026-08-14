/**
 * @jest-environment node
 */

/**
 * Route-level acceptance for bounded build recovery. Authentication and the
 * recovery core are mocked; the paid-action gate is deliberately real so the
 * session cookie, exact phrase, later-request rule, and one-time redemption are
 * exercised together.
 */

import { NextRequest, type NextResponse } from 'next/server';

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

const mockResumeBuildMission = jest.fn();
jest.mock('@/lib/build-mission-iterate', () => ({
  resumeBuildMission: (...args: unknown[]) => mockResumeBuildMission(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { PAID_ACTION_SESSION_COOKIE, _resetConfirmationStore } from '@/lib/ai/destructive-confirmation';
import { POST } from '../route';

const ENDPOINT = 'http://localhost:3000/api/missions/m1/resume';
const params = { params: Promise.resolve({ id: 'm1' }) };

function request(body: unknown = {}, cookie?: string): NextRequest {
  const headers = new Headers({
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  });
  if (cookie) headers.set('Cookie', cookie);
  return new NextRequest(new URL(ENDPOINT), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: NextResponse): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('expected a Set-Cookie header');
  const cookie = header.split(';', 1)[0];
  if (!cookie.startsWith(`${PAID_ACTION_SESSION_COOKIE}=`)) {
    throw new Error(`unexpected paid-action cookie: ${cookie}`);
  }
  return cookie;
}

function successfulCoreResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    missionId: 'm1',
    additionalTurns: 40,
    additionalBudgetUsd: 0,
    authorizedMaxTurns: 40,
    capUsd: 50,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfirmationStore();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'test-user-123' });
});

afterAll(() => {
  _resetConfirmationStore();
});

describe('POST /api/missions/[id]/resume', () => {
  it('returns 401 before parsing or dispatching when authentication fails', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'No token' });

    const response = await POST(request({ additionalTurns: 40 }), params);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'No token' });
    expect(mockResumeBuildMission).not.toHaveBeenCalled();
  });

  it.each([
    ['zero turns', { additionalTurns: 0 }],
    ['too many turns', { additionalTurns: 161 }],
    ['fractional turns', { additionalTurns: 1.5 }],
    ['string turns', { additionalTurns: '40' }],
    ['negative budget', { additionalBudgetUsd: -1 }],
    ['excessive budget', { additionalBudgetUsd: 151 }],
    ['string budget', { additionalBudgetUsd: '10' }],
    ['oversized confirmation', { confirmationText: 'x'.repeat(501) }],
    ['unknown key', { additionalTurns: 40, unexpected: true }],
  ])('returns 400 for %s without calling the recovery core', async (_label, body) => {
    const response = await POST(request(body), params);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ fieldErrors: expect.any(Object), formErrors: expect.any(Array) }),
    });
    expect(mockResumeBuildMission).not.toHaveBeenCalled();
  });

  it('dispatches the safe default turns-only recovery immediately with zero added USD', async () => {
    mockResumeBuildMission.mockResolvedValue(successfulCoreResult());

    const response = await POST(request({}), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successfulCoreResult());
    expect(mockResumeBuildMission).toHaveBeenCalledTimes(1);
    expect(mockResumeBuildMission).toHaveBeenCalledWith({
      missionId: 'm1',
      userId: 'test-user-123',
      additionalTurns: 40,
      additionalBudgetUsd: 0,
      confirmedBy: undefined,
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns the requested turn and cap evidence from a successful turns-only recovery', async () => {
    const result = successfulCoreResult({
      additionalTurns: 72,
      authorizedMaxTurns: 72,
      capUsd: 63.5,
    });
    mockResumeBuildMission.mockResolvedValue(result);

    const response = await POST(request({ additionalTurns: 72, additionalBudgetUsd: 0 }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mockResumeBuildMission).toHaveBeenCalledWith({
      missionId: 'm1',
      userId: 'test-user-123',
      additionalTurns: 72,
      additionalBudgetUsd: 0,
      confirmedBy: undefined,
    });
  });

  it('stages a paid recovery with an exact phrase and secure session cookie without calling the core', async () => {
    const response = await POST(request({ additionalTurns: 55, additionalBudgetUsd: 12.5 }), params);
    const body = await response.json();
    const setCookie = response.headers.get('set-cookie');

    expect(response.status).toBe(428);
    expect(body).toMatchObject({
      requiresConfirmation: true,
      amountUsd: 12.5,
      confirmationPhrase: expect.stringMatching(
        /^CONFIRM SPEND \$12\.50 resumeBuildMission%3A[a-f0-9]{64}$/
      ),
    });
    expect(setCookie).toEqual(expect.stringMatching(new RegExp(`^${PAID_ACTION_SESSION_COOKIE}=`)));
    expect(setCookie).toEqual(expect.stringMatching(/HttpOnly/i));
    expect(setCookie).toEqual(expect.stringMatching(/SameSite=strict/i));
    expect(setCookie).toEqual(expect.stringMatching(/Path=\/api\/missions/i));
    expect(mockResumeBuildMission).not.toHaveBeenCalled();
  });

  it('redeems the exact phrase only on a later request with the same cookie and passes bounded authority', async () => {
    const paidRequest = { additionalTurns: 55, additionalBudgetUsd: 12.5 };
    const staged = await POST(request(paidRequest), params);
    const stagedBody = await staged.json();
    const cookie = sessionCookie(staged);
    mockResumeBuildMission.mockResolvedValue(
      successfulCoreResult({
        additionalTurns: 55,
        additionalBudgetUsd: 12.5,
        authorizedMaxTurns: 55,
        capUsd: 62.5,
      })
    );

    const response = await POST(
      request({ ...paidRequest, confirmationText: stagedBody.confirmationPhrase }, cookie),
      params
    );

    expect(response.status).toBe(200);
    expect(mockResumeBuildMission).toHaveBeenCalledTimes(1);
    expect(mockResumeBuildMission).toHaveBeenCalledWith({
      missionId: 'm1',
      userId: 'test-user-123',
      additionalTurns: 55,
      additionalBudgetUsd: 12.5,
      confirmedBy: 'test-user-123',
      confirmationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await response.json()).toEqual({
      ok: true,
      missionId: 'm1',
      additionalTurns: 55,
      additionalBudgetUsd: 12.5,
      authorizedMaxTurns: 55,
      capUsd: 62.5,
    });
  });

  it('rejects a wrong phrase in the same session and never calls the recovery core', async () => {
    const paidRequest = { additionalTurns: 40, additionalBudgetUsd: 10 };
    const staged = await POST(request(paidRequest), params);
    const body = await staged.json();
    const cookie = sessionCookie(staged);

    const response = await POST(
      request({ ...paidRequest, confirmationText: `${body.confirmationPhrase}-altered` }, cookie),
      params
    );

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ requiresConfirmation: true, amountUsd: 10 });
    expect(mockResumeBuildMission).not.toHaveBeenCalled();
  });

  it('rejects replay of an already-consumed phrase in the same session', async () => {
    const paidRequest = { additionalTurns: 40, additionalBudgetUsd: 10 };
    const staged = await POST(request(paidRequest), params);
    const body = await staged.json();
    const cookie = sessionCookie(staged);
    mockResumeBuildMission.mockResolvedValue(
      successfulCoreResult({ additionalBudgetUsd: 10, capUsd: 60 })
    );

    const redeemed = await POST(
      request({ ...paidRequest, confirmationText: body.confirmationPhrase }, cookie),
      params
    );
    const replay = await POST(
      request({ ...paidRequest, confirmationText: body.confirmationPhrase }, cookie),
      params
    );

    expect(redeemed.status).toBe(200);
    expect(replay.status).toBe(428);
    expect(await replay.json()).toMatchObject({ requiresConfirmation: true, amountUsd: 10 });
    expect(mockResumeBuildMission).toHaveBeenCalledTimes(1);
  });

  it('rejects the exact phrase from a different paid-action session', async () => {
    const paidRequest = { additionalTurns: 40, additionalBudgetUsd: 10 };
    const staged = await POST(request(paidRequest), params);
    const body = await staged.json();

    const response = await POST(
      request(
        { ...paidRequest, confirmationText: body.confirmationPhrase },
        `${PAID_ACTION_SESSION_COOKIE}=different-session-1234`
      ),
      params
    );

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ requiresConfirmation: true, amountUsd: 10 });
    expect(mockResumeBuildMission).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404],
    ['forbidden', 403],
    ['not-build', 400],
    ['running', 409],
    ['no-sandbox', 409],
    ['sandbox-reclaimed', 410],
    ['budget-exhausted', 409],
    ['brief-too-long', 400],
    ['operation-in-progress', 409],
    ['not-limitless', 400],
    ['not-failed', 409],
    ['published', 409],
    ['invalid-recovery', 400],
    ['confirmation-required', 428],
    ['dispatch-failed', 503],
  ])('maps core failure %s to HTTP %i', async (code, status) => {
    mockResumeBuildMission.mockResolvedValue({ ok: false, code, error: `failure: ${code}` });

    const response = await POST(request({ additionalTurns: 40, additionalBudgetUsd: 0 }), params);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: `failure: ${code}` });
    expect(mockResumeBuildMission).toHaveBeenCalledTimes(1);
  });

  it('returns 500 without inventing success evidence when the core throws', async () => {
    mockResumeBuildMission.mockRejectedValue(new Error('firestore down'));

    const response = await POST(request({ additionalTurns: 40 }), params);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to resume mission' });
  });
});
