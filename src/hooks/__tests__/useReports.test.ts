/**
 * Unit Tests for useReports Hooks
 *
 * Tests all report hooks wired to /api/reports:
 * - useReports (list) — fetchReports calls API with auth header, returns Report[], handles errors
 * - useReport (detail) — fetchReport calls /api/reports/{id}, handles null id (disabled), errors
 * - useUpdateReport — PUT /api/reports/{id} with JSON body, returns updated Report, handles errors
 * - useDeleteReport — DELETE /api/reports/{id}, resolves on success, handles errors
 * - useBulkDeleteReports — POST /api/reports/bulk-delete with { ids }, resolves on success, handles errors
 * - reportKeys factory — all, list, detail key shapes
 * - Hook and key exports
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// MOCKS
// ============================================================================

const mockGetIdToken = jest.fn().mockResolvedValue('mock-token');

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    currentUser: {
      getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    },
  },
}));

// Auth gate (mirrors useDigests / useBriefing): queries are disabled until
// Firebase Auth restores the session, so they never fire token-less requests.
const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock global fetch
const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// Import AFTER mocks
import {
  useReports,
  useReport,
  useUpdateReport,
  useDeleteReport,
  useBulkDeleteReports,
  reportKeys,
  ReportFetchError,
} from '../useReports';
import type { Report } from '@/lib/schemas/report';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient = createTestQueryClient()) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const MOCK_REPORT: Report = {
  id: 'report-001',
  title: 'Q1 Technology Landscape',
  html: '<html><body><h1>Report</h1></body></html>',
  createdAt: '2026-02-25T10:00:00.000Z',
  createdBy: 'agent',
  shared: false,
  agentType: 'creator',
  missionId: 'mission-001',
  entityIds: ['tech-1', 'tech-2'],
  metadata: {
    description: 'Quarterly technology landscape overview',
    dataSnapshotAt: '2026-02-25T09:00:00.000Z',
  },
};

const MOCK_REPORTS: Report[] = [
  MOCK_REPORT,
  {
    id: 'report-002',
    title: 'Strategy Assessment',
    html: '<html><body><h1>Strategy</h1></body></html>',
    createdAt: '2026-02-24T08:00:00.000Z',
    createdBy: 'user',
    shared: false,
    entityIds: ['strategy-1'],
    metadata: {
      description: 'Strategy deep dive',
      dataSnapshotAt: '2026-02-24T07:00:00.000Z',
    },
  },
];

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useReports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
    mockUseAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false });
  });

  // ==========================================================================
  // AUTH GATING (mirrors the useDigests gate)
  // ==========================================================================

  describe('auth gating', () => {
    it('useReports does not fetch while Firebase auth is still restoring the session', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: true });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      // Disabled query: stays pending, never hits the network.
      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('useReports does not fetch when auth has resolved but no user is signed in', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: false });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isPending).toBe(true);
      expect(result.current.isFetching).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('useReport does not fetch while auth is restoring, even with a valid id', () => {
      mockUseAuth.mockReturnValue({ user: null, loading: true });

      const { result } = renderHook(() => useReport('report-001'), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('useReports fetches once auth is restored with a signed-in user', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORTS,
      });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockFetch).toHaveBeenCalledWith('/api/reports');
    });
  });

  // ==========================================================================
  // QUERY KEY FACTORY
  // ==========================================================================

  describe('reportKeys', () => {
    it('should produce correct key shapes', () => {
      expect(reportKeys.all).toEqual(['reports']);
      expect(reportKeys.list()).toEqual(['reports', 'list']);
    });

    it('should produce detail key with id', () => {
      expect(reportKeys.detail('report-001')).toEqual(['reports', 'detail', 'report-001']);
      expect(reportKeys.detail('abc')).toEqual(['reports', 'detail', 'abc']);
    });
  });

  // ==========================================================================
  // fetchReports (via useReports hook)
  // ==========================================================================

  describe('fetchReports', () => {
    it('should call /api/reports with Authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORTS,
      });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/reports');
    });

    it('should return array from API response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORTS,
      });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(MOCK_REPORTS);
      expect(result.current.data).toHaveLength(2);
    });

    it('should return empty array when API returns non-array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ reports: MOCK_REPORTS }),
      });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([]);
    });

    it('should enter error state when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain('Failed to fetch reports');
      expect(result.current.error?.message).toContain('500');
    });

    it('should enter error state when user is not authenticated', async () => {
      const firebase = jest.requireMock<{ auth: { currentUser: unknown } }>('@/lib/firebase');
      const originalUser = firebase.auth.currentUser;
      firebase.auth.currentUser = null;

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Not authenticated');
      expect(mockFetch).not.toHaveBeenCalled();

      firebase.auth.currentUser = originalUser;
    });

    it('should enter error state on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useReports(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('Network error');
    });
  });

  // ==========================================================================
  // HOOK EXPORTS
  // ==========================================================================

  describe('hook exports', () => {
    it('should export useReports as a function', () => {
      expect(typeof useReports).toBe('function');
    });

    it('should export reportKeys factory', () => {
      expect(typeof reportKeys).toBe('object');
      expect(typeof reportKeys.list).toBe('function');
    });
  });

  // ==========================================================================
  // useReport (single report query)
  // ==========================================================================

  describe('useReport', () => {
    it('should call /api/reports/{id} with Authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORT,
      });

      const { result } = renderHook(() => useReport('report-001'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/reports/report-001');
    });

    it('should return Report on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORT,
      });

      const { result } = renderHook(() => useReport('report-001'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(MOCK_REPORT);
      expect(result.current.data?.id).toBe('report-001');
    });

    it('should not fetch when id is null', async () => {
      const { result } = renderHook(() => useReport(null), {
        wrapper: createWrapper(),
      });

      // Should stay in idle/loading state without fetching
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should enter error state with a typed 404 status on not-found', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const { result } = renderHook(() => useReport('report-001'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      // UX-017: the UI branches on the typed status to tell "not found" (404)
      // apart from a transient failure — so the status must survive the throw.
      expect(result.current.error).toBeInstanceOf(ReportFetchError);
      expect((result.current.error as ReportFetchError).status).toBe(404);
      expect(result.current.error?.message).toContain('Failed to fetch report');
      expect(result.current.error?.message).toContain('404');
    });

    it('should carry a non-404 status through so the UI can offer Retry', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      const { result } = renderHook(() => useReport('report-001'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(ReportFetchError);
      expect((result.current.error as ReportFetchError).status).toBe(503);
    });
  });

  // ==========================================================================
  // useUpdateReport (mutation)
  // ==========================================================================

  describe('useUpdateReport', () => {
    it('should call PUT /api/reports/{id} with auth header and JSON body', async () => {
      const updatedReport: Report = { ...MOCK_REPORT, title: 'Updated Title' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updatedReport,
      });

      const { result } = renderHook(() => useUpdateReport(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate({
          id: 'report-001',
          updates: { title: 'Updated Title' },
        });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/reports/report-001', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Updated Title' }),
      });
    });

    it('should return updated Report on success', async () => {
      const updatedReport: Report = { ...MOCK_REPORT, title: 'Updated Title' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updatedReport,
      });

      const { result } = renderHook(() => useUpdateReport(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate({
          id: 'report-001',
          updates: { title: 'Updated Title' },
        });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(updatedReport);
    });

    it('should enter error state on API failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { result } = renderHook(() => useUpdateReport(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate({
          id: 'report-001',
          updates: { title: 'Updated Title' },
        });
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain('Failed to update report');
    });
  });

  // ==========================================================================
  // useDeleteReport (mutation)
  // ==========================================================================

  describe('useDeleteReport', () => {
    it('should call DELETE /api/reports/{id} with auth header', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const { result } = renderHook(() => useDeleteReport(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate('report-001');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/reports/report-001', {
        method: 'DELETE',
      });
    });

    it('should resolve on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const { result } = renderHook(() => useDeleteReport(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate('report-001');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Delete returns void
      expect(result.current.data).toBeUndefined();
    });

    it('should enter error state on API failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      const queryClient = createTestQueryClient();
      const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useDeleteReport(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate('report-001');
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain('Failed to delete report');
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: reportKeys.all });
    });
  });

  // ==========================================================================
  // useBulkDeleteReports (mutation)
  // ==========================================================================

  describe('useBulkDeleteReports', () => {
    it('should call POST /api/reports/bulk-delete with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const ids = ['report-001', 'report-002'];

      const { result } = renderHook(() => useBulkDeleteReports(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate(ids);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/api/reports/bulk-delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids }),
      });
    });

    it('should resolve on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const { result } = renderHook(() => useBulkDeleteReports(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        result.current.mutate(['report-001', 'report-002']);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBeUndefined();
    });

    it('should enter error state on API failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const queryClient = createTestQueryClient();
      const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBulkDeleteReports(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate(['report-001']);
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain('Failed to bulk delete reports');
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: reportKeys.all });
    });
  });
});
