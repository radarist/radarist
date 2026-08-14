'use client';

/**
 * @file hooks/useReportsPage.ts
 * @description Page-level state management for the Reports page.
 * Follows the same pattern as useDocumentsPage.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import type { Report } from '@/lib/schemas/report';
import {
  useReports,
  useDeleteReport,
  useBulkDeleteReports,
  useUpdateReport,
  ReportFetchError,
} from '@/hooks/useReports';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { buildDownloadHtml } from '@/lib/reports/build-download-html';

// ============================================================================
// TYPES
// ============================================================================

type SortField = 'title' | 'createdAt';
type SortDirection = 'asc' | 'desc';

export interface ReportSortState {
  key: SortField;
  direction: SortDirection;
}

// ============================================================================
// UTILITIES
// ============================================================================

export function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ============================================================================
// HOOK
// ============================================================================

export function useReportsPage() {
  // Data
  const { data: reports = [], isLoading, error, refetch } = useReports();
  const deleteReportMutation = useDeleteReport();
  const bulkDeleteMutation = useBulkDeleteReports();
  const updateReportMutation = useUpdateReport();

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Sorting
  const [sortState, setSortState] = useState<ReportSortState>({
    key: 'createdAt',
    direction: 'desc',
  });

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState<string>('all');
  const [sharedFilter, setSharedFilter] = useState<string>('all');

  // Selection
  const { selectedIds, isSelected, toggleSelection, handleSelectAllChange, clearSelection, selectedCount } =
    useTableSelection<Report>({ getItemId: (r) => r.id });

  // Bulk delete dialog
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // ============================================================================
  // FILTERING + SORTING + PAGINATION
  // ============================================================================

  const filteredReports = useMemo(() => {
    let filtered = [...reports];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (r) => r.title.toLowerCase().includes(q) || r.metadata?.description?.toLowerCase().includes(q)
      );
    }

    if (createdByFilter !== 'all') {
      filtered = filtered.filter((r) => r.createdBy === createdByFilter);
    }

    if (sharedFilter === 'shared') {
      filtered = filtered.filter((r) => r.shared === true);
    } else if (sharedFilter === 'private') {
      filtered = filtered.filter((r) => r.shared !== true);
    }

    filtered.sort((a, b) => {
      const direction = sortState.direction === 'asc' ? 1 : -1;
      if (sortState.key === 'title') return direction * a.title.localeCompare(b.title);
      if (sortState.key === 'createdAt') {
        const aTime = new Date(String(a.createdAt)).getTime();
        const bTime = new Date(String(b.createdAt)).getTime();
        return direction * (aTime - bTime);
      }
      return 0;
    });

    return filtered;
  }, [reports, searchQuery, createdByFilter, sharedFilter, sortState]);

  const paginatedReports = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredReports.slice(start, start + pageSize);
  }, [filteredReports, pageIndex, pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(selectedIds, paginatedReports, (r) => r.id);

  // Reset page on filter change
  useEffect(() => {
    setPageIndex(0);
  }, [searchQuery, createdByFilter, sharedFilter, sortState]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const toggleSort = useCallback((key: string) => {
    const sortKey = key as SortField;
    setSortState((prev) => ({
      key: sortKey,
      direction: prev.key === sortKey && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, []);

  const handleDeleteReport = useCallback(
    async (report: Report) => {
      try {
        await deleteReportMutation.mutateAsync(report.id);
        toast.success('Report deleted');
      } catch {
        toast.error('Failed to delete report');
      }
    },
    [deleteReportMutation]
  );

  const handleBulkDelete = useCallback(async () => {
    try {
      await bulkDeleteMutation.mutateAsync(selectedIds);
      toast.success(`${selectedIds.length} report${selectedIds.length > 1 ? 's' : ''} deleted`);
      clearSelection();
      setShowBulkDeleteDialog(false);
    } catch {
      toast.error('Failed to delete reports');
    }
  }, [bulkDeleteMutation, selectedIds, clearSelection]);

  const handleShareReport = useCallback(
    async (report: Report) => {
      const newShared = !report.shared;
      try {
        await updateReportMutation.mutateAsync({
          id: report.id,
          updates: { shared: newShared },
        });
        if (newShared) {
          const url = `${window.location.origin}/share/report/${report.id}`;
          await navigator.clipboard.writeText(url);
          toast.success('Public link copied to clipboard');
        } else {
          toast.success('Public link disabled');
        }
      } catch (error) {
        // REPORT-002: a 409 means the server refused to share a needs-review
        // draft — say so instead of a generic failure the user can't act on.
        if (error instanceof ReportFetchError && error.status === 409) {
          toast.error('This draft needs review before it can be shared', {
            description: 'Open the report and approve it first.',
          });
          return;
        }
        toast.error('Failed to update sharing');
      }
    },
    [updateReportMutation]
  );

  const handleDownloadReport = useCallback(async (report: Report) => {
    try {
      const user = (await import('@/lib/firebase')).auth.currentUser;
      if (!user) throw new Error('Not authenticated');
      const res = await fetchWithAuth(`/api/reports/${report.id}`, {
        headers: {},
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // Inline the brand stylesheet so the downloaded file is
      // self-contained — relative `/css/report-brand.css` references
      // 404 when the file is opened from disk and the editorial
      // typography / hero / gold accents disappear.
      const brandCss = await fetch('/css/report-brand.css')
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null);
      const downloadHtml = buildDownloadHtml(data.html ?? '', report.title, { brandCss });
      const blob = new Blob([downloadHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch {
      toast.error('Failed to download report');
    }
  }, []);

  const hasActiveFilters = !!searchQuery || createdByFilter !== 'all' || sharedFilter !== 'all';

  return {
    // Data
    reports: paginatedReports,
    filteredCount: filteredReports.length,
    totalCount: reports.length,
    isLoading,
    error,
    refetch,

    // Pagination
    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    // Sorting
    sortState,
    toggleSort,

    // Filters
    searchQuery,
    setSearchQuery,
    createdByFilter,
    setCreatedByFilter,
    sharedFilter,
    setSharedFilter,
    hasActiveFilters,

    // Selection
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    selectedCount,
    isAllSelected,
    isSomeSelected,

    // Actions
    handleDeleteReport,
    handleShareReport,
    handleDownloadReport,

    // Bulk
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  };
}
