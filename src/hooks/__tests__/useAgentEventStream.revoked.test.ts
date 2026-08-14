/**
 * @file useAgentEventStream.revoked.test.ts
 * @jest-environment jsdom
 * @description UX-056 — the SSE stream must recover or terminate, never storm.
 *
 * On the base tree a 401 put the stream into an unbounded reconnect loop: the
 * backoff caps at 30s and `mounted` stays true, so a browser holding a revoked
 * credential re-requests the stream forever, never refreshing and never
 * stopping. `fetch-with-auth` already spends the one permitted force-refreshed
 * retry, so by the time a classified 401 reaches this hook the only correct move
 * is to stop and hand over to the sign-in transition.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

const mockGetIdToken = jest.fn().mockResolvedValue('mock-token');

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    currentUser: {
      getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    },
  },
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

import { AUTH_FAILURE_REASON_HEADER } from '@/lib/auth-failure';
import { clearAuthSessionRecovery, pendingAuthSessionRecovery } from '@/lib/auth-session-recovery';
import { useAgentEventStream } from '../useAgentEventStream';

function unauthorized(reason?: string): Response {
  const headers = new Headers();
  if (reason) headers.set(AUTH_FAILURE_REASON_HEADER, reason);
  return { ok: false, status: 401, statusText: 'Unauthorized', body: null, headers } as unknown as Response;
}

function serverError(): Response {
  return {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    body: null,
    headers: new Headers(),
  } as unknown as Response;
}

/** Advance past the largest backoff several times over. */
async function letReconnectsFire(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
  }
}

describe('useAgentEventStream stale-credential termination (UX-056)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    clearAuthSessionRecovery();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops reconnecting after a server-classified stale-credential 401', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => expect(result.current.sessionEnded).toBe(true));
    await letReconnectsFire();

    // One attempt total: the wrapper already spent the permitted retry.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
  });

  it('raises exactly one sign-in transition rather than one per attempt', async () => {
    mockFetch.mockResolvedValue(unauthorized('token-revoked'));

    renderHook(() => useAgentEventStream(true));

    await waitFor(() => expect(pendingAuthSessionRecovery()).toBe('token-revoked'));
    await letReconnectsFire();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps reconnecting through an ordinary server failure', async () => {
    // Only an authentication verdict is terminal. A 503 is transient and the
    // backoff must survive it, or a restarting dev server never reconnects.
    mockFetch.mockResolvedValue(serverError());

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => expect(result.current.connectionError).toBe(true));
    await letReconnectsFire();

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.sessionEnded).toBe(false);
  });

  it('terminates on an unclassified 401 too — an auth verdict is never retryable here', async () => {
    mockFetch.mockResolvedValue(unauthorized());

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => expect(result.current.sessionEnded).toBe(true));
    await letReconnectsFire();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // No classified reason means no basis for clearing the session; only the
    // stream stops.
    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('does not reset the session for a permissions denial', async () => {
    mockFetch.mockResolvedValue(unauthorized('insufficient-permissions'));

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => expect(result.current.sessionEnded).toBe(true));
    await letReconnectsFire();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pendingAuthSessionRecovery()).toBeNull();
  });
});
