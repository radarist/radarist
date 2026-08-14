/**
 * @file useInbox.archive.test.ts
 * @description Pins the auth-gating contract (P-A4) for `useInboxArchive` — the
 * Assessments Archive fan-out (`/api/triage/{entities,assessments,artifacts}` across
 * approved/rejected/dismissed). The query must stay disabled until Firebase
 * auth-state restoration completes (`useAuth()`), matching the three pending-lane
 * hooks it composes (`useAssessments`/`useProposedEntities`/`useProposedArtifacts`).
 * Without this gate, TanStack Query fires on mount before `onAuthStateChanged`
 * restores the session, `fetchWithAuth` ships with no Authorization header, and
 * the triage list routes 401 — the console noise this test guards against regressing.
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

import { useInboxArchive } from '../useInbox';

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

describe('useInboxArchive auth gating (P-A4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  it('does not fetch while Firebase auth is still restoring the session', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useInboxArchive(), { wrapper: wrapper(qc) });

    expect(result.current.rows).toEqual([]);
    // Consumers key the skeleton off this flag — it must stay up while the
    // gate holds so the page never flashes the empty state during auth restore.
    expect(result.current.isLoading).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when auth has resolved but no user is signed in', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useInboxArchive(), { wrapper: wrapper(qc) });

    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fans out the resolved-status fetches once auth has resolved with a signed-in user', async () => {
    // One shared body works for all nine calls — each reader picks its own key.
    mockFetch.mockResolvedValue(ok({ entities: [], assessments: [], artifacts: [] }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useInboxArchive(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.rows).toEqual([]);
    // 3 kinds × 3 resolved statuses = 9 authenticated calls.
    expect(mockFetch).toHaveBeenCalledTimes(9);
    for (const endpoint of ['/api/triage/entities', '/api/triage/assessments', '/api/triage/artifacts']) {
      for (const status of ['approved', 'rejected', 'dismissed']) {
        expect(mockFetch).toHaveBeenCalledWith(`${endpoint}?status=${status}`);
      }
    }
  });
});
