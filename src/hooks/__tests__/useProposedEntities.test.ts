/**
 * @file useProposedEntities.test.ts
 * @description Pins the auth-gating contract (P-A4) for the proposed-Entity
 * triage reads: the query must stay disabled until Firebase auth-state
 * restoration completes (`useAuth()`), matching `useBriefing`/`useDigests`/
 * `useAssessments`. Without this gate, TanStack Query fires on mount before
 * `onAuthStateChanged` restores the session, `fetchWithAuth` ships with no
 * Authorization header, and `/api/triage/entities` 401s — the sidebar-badge
 * console noise this test guards against regressing.
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
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }));

import { usePendingProposedEntitiesCount } from '../useProposedEntities';

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

describe('useProposedEntities auth gating (P-A4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  it('does not fetch while Firebase auth is still restoring the session', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => usePendingProposedEntitiesCount(), { wrapper: wrapper(qc) });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when auth has resolved but no user is signed in', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => usePendingProposedEntitiesCount(), { wrapper: wrapper(qc) });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches once auth has resolved with a signed-in user — the session the app actually sends', async () => {
    mockFetch.mockResolvedValueOnce(ok({ entities: [{ id: 'pe-1', status: 'pending' }] }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => usePendingProposedEntitiesCount(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/triage/entities?status=pending');
  });
});
