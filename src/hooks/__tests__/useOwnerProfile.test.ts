/**
 * @file useOwnerProfile.test.ts
 * @description UX-062 — pins the owner-profile hook: auth-state gating (no
 * fetch until the persisted session is restored), success → profile data, and
 * error propagation.
 *
 * @jest-environment jsdom
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: (...a: unknown[]) => mockFetch(...a) }));

import { useOwnerProfile } from '../useOwnerProfile';
import { userKeys } from '@/lib/query-keys';

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

describe('useOwnerProfile (UX-062)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  it('does not fetch while Firebase auth is still restoring the session (retained reload)', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when auth has resolved but no user is signed in', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    expect(result.current.isFetching).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches the owner profile once auth has resolved with a signed-in user', async () => {
    const profile = { uid: 'user-claudio', displayName: 'Real Operator', email: 'real@example.com', photoURL: null };
    mockFetch.mockResolvedValueOnce(ok({ profile }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(profile);
    expect(mockFetch).toHaveBeenCalledWith('/api/user/profile');
  });

  it('exposes a null profile (not an error) when the owner doc does not exist (fresh signup)', async () => {
    mockFetch.mockResolvedValueOnce(ok({ profile: null }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('propagates a fetch failure as an error state', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keys the cache per uid so a user switch cannot serve another account identity', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useOwnerProfile(), { wrapper: wrapper(qc) });

    expect(qc.getQueryCache().getAll()[0].queryKey).toEqual(userKeys.profile('user-claudio'));
  });
});
