/**
 * @file hooks/useReports.ts
 * @description TanStack Query hooks for reports (list, detail, mutations)
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { auth } from '@/lib/firebase';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useAuth } from '@/components/providers/AuthProvider';
import type { Report, ReportVersion, ReportVersionSummary, UpdateReportInput } from '@/lib/schemas/report';

// ============================================================================
// ERRORS
// ============================================================================

/**
 * Error thrown by the report detail fetch, carrying the HTTP status so the UI
 * can distinguish a genuine 404 (report not found) from a transient failure
 * (network / 401 / 429 / 5xx) that should offer Retry rather than claim the
 * report does not exist (UX-017). `status` is undefined for a network-level
 * failure (fetch rejected before any response).
 */
export class ReportFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ReportFetchError';
  }
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

export const reportKeys = {
  all: ['reports'] as const,
  list: () => [...reportKeys.all, 'list'] as const,
  detail: (id: string) => [...reportKeys.all, 'detail', id] as const,
  // DISC-014 version history — nested under the report so invalidating a report
  // (reportKeys.all) also refreshes its history after a restore.
  versions: (id: string) => [...reportKeys.detail(id), 'versions'] as const,
  version: (id: string, versionId: string) => [...reportKeys.detail(id), 'versions', versionId] as const,
};

// ============================================================================
// FETCH FUNCTIONS
// ============================================================================

async function fetchReports(): Promise<Report[]> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Not authenticated');
  }
  const response = await fetchWithAuth('/api/reports');
  if (!response.ok) {
    throw new Error(`Failed to fetch reports: ${response.status}`);
  }
  const data = await response.json();
  // API returns Report[] directly (not wrapped in { reports: [...] })
  return Array.isArray(data) ? data : [];
}

async function fetchReport(id: string): Promise<Report> {
  const response = await fetchWithAuth(`/api/reports/${id}`);
  if (!response.ok) throw new ReportFetchError(`Failed to fetch report: ${response.status}`, response.status);
  return response.json();
}

async function apiUpdateReport(id: string, updates: UpdateReportInput): Promise<Report> {
  const response = await fetchWithAuth(`/api/reports/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  // REPORT-002: carry the status so callers can tell a refused share of a
  // needs-review draft (409) from a generic failure and say which it was.
  if (!response.ok) throw new ReportFetchError(`Failed to update report: ${response.status}`, response.status);
  return response.json();
}

async function fetchReportVersions(id: string): Promise<ReportVersionSummary[]> {
  const response = await fetchWithAuth(`/api/reports/${id}/versions`);
  if (!response.ok) throw new Error(`Failed to fetch report versions: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.versions) ? data.versions : [];
}

async function fetchReportVersion(id: string, versionId: string): Promise<ReportVersion> {
  const response = await fetchWithAuth(`/api/reports/${id}/versions/${versionId}`);
  if (!response.ok) throw new Error(`Failed to fetch report version: ${response.status}`);
  return response.json();
}

async function apiRestoreReport(id: string, versionId?: string): Promise<Report> {
  const response = await fetchWithAuth(`/api/reports/${id}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(versionId ? { body: JSON.stringify({ versionId }) } : {}),
  });
  if (!response.ok) throw new Error(`Failed to restore report: ${response.status}`);
  return response.json();
}

async function apiDeleteReport(id: string): Promise<void> {
  const response = await fetchWithAuth(`/api/reports/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`Failed to delete report: ${response.status}`);
}

async function apiBulkDeleteReports(ids: string[]): Promise<void> {
  const response = await fetchWithAuth('/api/reports/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error(`Failed to bulk delete reports: ${response.status}`);
}

// ============================================================================
// HOOKS
// ============================================================================

export function useReports() {
  // Gate on auth being restored — otherwise the query fires before Firebase
  // Auth resolves and ships with no Authorization header, returning 401 on
  // every page (same pattern as useUnreadDigests in useDigests.ts).
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: reportKeys.list(),
    queryFn: fetchReports,
    enabled: !loading && !!user,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useReport(id: string | null) {
  // Same auth gate as useReports — the detail endpoint also requires a token.
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: reportKeys.detail(id ?? ''),
    queryFn: () => fetchReport(id!),
    enabled: !!id && !loading && !!user,
    staleTime: 30 * 1000,
  });
}

/** DISC-014: a report's version history (metadata only — no html bodies). */
export function useReportVersions(id: string | null, enabled = true) {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: reportKeys.versions(id ?? ''),
    queryFn: () => fetchReportVersions(id!),
    enabled: !!id && enabled && !loading && !!user,
    staleTime: 30 * 1000,
  });
}

/** DISC-014: a single stored version incl. its html, for point-in-time preview. */
export function useReportVersion(id: string | null, versionId: string | null) {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: reportKeys.version(id ?? '', versionId ?? ''),
    queryFn: () => fetchReportVersion(id!, versionId!),
    // Stored versions are immutable, so cache them aggressively.
    staleTime: 5 * 60 * 1000,
    enabled: !!id && !!versionId && !loading && !!user,
  });
}

/**
 * DISC-014: restore a report — to a specific `versionId`, or (omitted) the
 * legacy previous-version swap. Invalidates the report + its history.
 */
export function useRestoreReportVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, versionId }: { id: string; versionId?: string }) => apiRestoreReport(id, versionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

export function useUpdateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: UpdateReportInput }) => apiUpdateReport(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

export function useDeleteReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDeleteReport(id),
    // recursiveDelete is not atomic and can reject after removing part of a
    // report tree, so re-read the list after both success and failure.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

export function useBulkDeleteReports() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => apiBulkDeleteReports(ids),
    // A bulk request can partially complete before another recursive delete
    // fails. Always invalidate so the UI reflects Firestore's committed state.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}
