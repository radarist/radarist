/**
 * @file useAssessments.test.ts
 * @description Pins the Assessment triage hooks: list fetch, approve optimistic
 * remove-from-pending + rollback on error, and the resolve POST payload.
 *
 * Also pins the auth-gating contract (P-A4): reads must stay disabled until
 * Firebase auth-state restoration completes (`useAuth()`), matching the
 * `useBriefing`/`useDigests` pattern. Without this gate, TanStack Query fires
 * on mount before `onAuthStateChanged` restores the session, `fetchWithAuth`
 * ships with no Authorization header, and `/api/triage/assessments` 401s —
 * the sidebar-badge console noise this test guards against regressing.
 *
 * @jest-environment jsdom
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: (...a: unknown[]) => mockFetch(...a) }));
const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import { usePendingAssessments, usePendingAssessmentsCount, useApproveAssessment } from '../useAssessments';
import { assessmentKeys } from '@/lib/query-keys';

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const SIGNED_IN_USER = { uid: 'user-claudio' } as const;

describe('useAssessments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: SIGNED_IN_USER, loading: false });
  });

  describe('auth gating (P-A4 — the same session the badges poll with)', () => {
    it('does not fetch while Firebase auth is still restoring the session', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: true });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => usePendingAssessmentsCount(), { wrapper: wrapper(qc) });

      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not fetch when auth has resolved but no user is signed in', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: false });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => usePendingAssessmentsCount(), { wrapper: wrapper(qc) });

      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches once auth has resolved with a signed-in user — the session the app actually sends', async () => {
      mockFetch.mockResolvedValueOnce(ok({ assessments: [{ id: 'pa-1', status: 'pending' }] }));
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const { result } = renderHook(() => usePendingAssessmentsCount(), { wrapper: wrapper(qc) });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/triage/assessments?status=pending');
    });
  });

  it('lists pending assessments via the API', async () => {
    mockFetch.mockResolvedValueOnce(ok({ assessments: [{ id: 'pa-1', status: 'pending' }] }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePendingAssessments(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'pa-1', status: 'pending' }]);
    expect(mockFetch).toHaveBeenCalledWith('/api/triage/assessments?status=pending');
  });

  it('approve optimistically removes from pending and POSTs the action', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(assessmentKeys.pending(), [{ id: 'pa-1' }, { id: 'pa-2' }]);
    mockFetch.mockResolvedValueOnce(ok({ assessment: { id: 'pa-1', status: 'approved' } }));

    const { result } = renderHook(() => useApproveAssessment(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'pa-1', radarId: 'r1', quadrantId: 'q1' });
    });

    expect(qc.getQueryData(assessmentKeys.pending())).toEqual([{ id: 'pa-2' }]);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/assessments/pa-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'approve', id: 'pa-1', radarId: 'r1', quadrantId: 'q1' }),
      })
    );
  });

  // BUILD-005 — the confirmation must tell the truth about whether a placement
  // was actually applied, not always claim "applied to the radar".
  it('confirms "Applied to the radar" only when a placement was actually created/updated', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mockFetch.mockResolvedValueOnce(
      ok({ assessment: { id: 'pa-1', status: 'approved', appliedPlacementId: 'placement-9', proposedRing: 'trial' } })
    );

    const { result } = renderHook(() => useApproveAssessment(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'pa-1' });
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Applied to the radar' }));
  });

  it('confirms "Verdict recorded" (not "applied") when approval placed nothing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // No appliedPlacementId → the tech was not on a radar and none resolved.
    mockFetch.mockResolvedValueOnce(ok({ assessment: { id: 'pa-1', status: 'approved' } }));

    const { result } = renderHook(() => useApproveAssessment(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'pa-1' });
    });

    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).toContain('Verdict recorded');
    expect(titles).not.toContain('Applied to the radar');
  });

  it('does not claim "isn\'t on a radar" when a target resolved but the placement write failed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // A radar target resolved (radarId set) but no appliedPlacementId → the
    // placement write didn't land. Must not tell the reviewer to add the tech.
    mockFetch.mockResolvedValueOnce(ok({ assessment: { id: 'pa-1', status: 'approved', radarId: 'radar-1' } }));

    const { result } = renderHook(() => useApproveAssessment(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'pa-1' });
    });

    const call = mockToast.mock.calls.find((c) => (c[0] as { title?: string }).title === 'Verdict recorded');
    expect(call).toBeTruthy();
    const description = (call![0] as { description?: string }).description ?? '';
    expect(description).toMatch(/couldn't apply/i);
    expect(description).not.toMatch(/isn't on a radar/i);
  });

  it('rolls back the pending list when the resolve call fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(assessmentKeys.pending(), [{ id: 'pa-1' }, { id: 'pa-2' }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const { result } = renderHook(() => useApproveAssessment(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'pa-1' }).catch(() => undefined);
    });

    expect(qc.getQueryData(assessmentKeys.pending())).toEqual([{ id: 'pa-1' }, { id: 'pa-2' }]);
  });
});
