/**
 * @file lib/__tests__/fetch-with-auth.revoked.test.ts
 * @description UX-056 — recovery from a server-confirmed stale cached credential.
 *
 * The retained-runtime failure this pins: a browser holds an ID token minted
 * before the Auth emulator restarted, every authenticated request comes back
 * 401 `token-revoked`, and nothing forces a refresh. These cases fix the exact
 * boundary of the allowed repair — one force-refreshed retry, only for a request
 * whose replay is demonstrably safe.
 *
 * @jest-environment jsdom
 */

const mockGetIdToken = jest.fn();
const mockAuth: {
  currentUser: { getIdToken: typeof mockGetIdToken } | null;
  authStateReady: jest.Mock<Promise<void>, []>;
} = {
  currentUser: null,
  authStateReady: jest.fn().mockResolvedValue(undefined),
};

jest.mock('firebase/auth', () => ({
  getAuth: () => mockAuth,
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { AUTH_FAILURE_REASON_HEADER, type AuthFailureReason } from '../auth-failure';
import { clearAuthSessionRecovery, onAuthSessionRecovery, pendingAuthSessionRecovery } from '../auth-session-recovery';
import { fetchWithAuth } from '../fetch-with-auth';

/**
 * Minimal response double. jsdom implements no `fetch`, so there is no global
 * `Response`; `fetchWithAuth` only reads `status`, `headers.get`, and `body`,
 * and asserting against exactly that surface keeps the test honest about which
 * parts of a response the recovery rule is allowed to depend on.
 */
function fakeResponse(status: number, reasonHeader?: string): Response {
  const headers = new Headers();
  if (reasonHeader) headers.set(AUTH_FAILURE_REASON_HEADER, reasonHeader);
  return { status, headers, body: null } as unknown as Response;
}

function unauthorized(reason: AuthFailureReason): Response {
  return fakeResponse(401, reason);
}

function ok(): Response {
  return fakeResponse(200);
}

function signedIn(): void {
  Object.defineProperty(mockAuth, 'currentUser', {
    value: { getIdToken: mockGetIdToken },
    writable: true,
    configurable: true,
  });
}

/** Bearer token sent on the Nth fetch call (0-indexed). */
function sentToken(call: number): string | null {
  const headers = mockFetch.mock.calls[call][1].headers as Headers;
  return headers.get('Authorization');
}

describe('fetchWithAuth stale-credential recovery (UX-056)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAuthSessionRecovery();
    mockAuth.authStateReady.mockResolvedValue(undefined);
    mockGetIdToken.mockImplementation((force?: boolean) => Promise.resolve(force ? 'refreshed-token' : 'stale-token'));
    signedIn();
  });

  it('force-refreshes and retries a GET once when the server confirms revocation', async () => {
    mockFetch.mockResolvedValueOnce(unauthorized('token-revoked')).mockResolvedValueOnce(ok());

    const response = await fetchWithAuth('/api/reports');

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sentToken(0)).toBe('Bearer stale-token');
    expect(sentToken(1)).toBe('Bearer refreshed-token');
    expect(mockGetIdToken).toHaveBeenCalledWith(true);
    // A recovered request must not drag the operator to a sign-in screen.
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('retries at most once and then hands the operator a sign-in transition', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));
    const seen: AuthFailureReason[] = [];
    const unsubscribe = onAuthSessionRecovery((reason) => seen.push(reason));

    const response = await fetchWithAuth('/api/reports');
    unsubscribe();

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['token-revoked']);
  });

  it('never replays a mutation — it transitions to sign-in instead', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));

    const response = await fetchWithAuth('/api/relations', {
      method: 'POST',
      body: JSON.stringify({ relationType: 'uses' }),
    });

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGetIdToken).not.toHaveBeenCalledWith(true);
    expect(pendingAuthSessionRecovery()).toBe('token-revoked');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('never replays a %s', async (method) => {
    mockFetch.mockResolvedValue(unauthorized('token-expired'));

    await fetchWithAuth('/api/relations', { method });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('never refreshes or replays a caller-supplied Authorization header', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));

    const response = await fetchWithAuth('/api/reports', {
      headers: { Authorization: 'Bearer caller-owned-credential' },
    });

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGetIdToken).not.toHaveBeenCalled();
    // We do not own that credential, so we must not clear the user's session
    // over its rejection either.
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('does not retry or reset for a permissions denial', async () => {
    mockFetch.mockResolvedValue(unauthorized('insufficient-permissions'));

    await fetchWithAuth('/api/admin/backfill-concepts');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('does not retry or reset while sign-in verification is unavailable', async () => {
    mockFetch.mockResolvedValue(unauthorized('verification-unavailable'));

    await fetchWithAuth('/api/reports');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('resets the session for an unverifiable credential without retrying', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-invalid'));

    await fetchWithAuth('/api/reports');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBe('token-invalid');
  });

  it('ignores an unclassified 401 rather than guessing from the body', async () => {
    mockFetch.mockResolvedValue(fakeResponse(401));

    const response = await fetchWithAuth('/api/reports');

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('latches concurrent stale 401s into exactly one sign-in transition', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));
    const seen: AuthFailureReason[] = [];
    const unsubscribe = onAuthSessionRecovery((reason) => seen.push(reason));

    await Promise.all([fetchWithAuth('/api/reports'), fetchWithAuth('/api/signals'), fetchWithAuth('/api/radars')]);
    unsubscribe();

    expect(seen).toEqual(['token-revoked']);
  });

  it('surfaces the original 401 when the forced refresh itself fails', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));
    mockGetIdToken.mockImplementation((force?: boolean) =>
      force ? Promise.reject(new Error('network down')) : Promise.resolve('stale-token')
    );

    const response = await fetchWithAuth('/api/reports');

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBe('token-revoked');
  });

  it('leaves a signed-out browser alone — there is no credential to refresh', async () => {
    Object.defineProperty(mockAuth, 'currentUser', { value: null, writable: true, configurable: true });
    mockFetch.mockResolvedValue(unauthorized('missing-credential'));

    await fetchWithAuth('/api/reports');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('leaves a successful response untouched', async () => {
    mockFetch.mockResolvedValue(ok());

    const response = await fetchWithAuth('/api/reports');

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGetIdToken).not.toHaveBeenCalledWith(true);
  });
});
