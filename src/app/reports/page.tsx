'use client';

import { Search, FileText } from 'lucide-react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ReportsTable, ReportsTableSkeleton } from '@/components/reports/ReportsTable';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { useReportsPage } from '@/hooks/useReportsPage';

// ============================================================================
// PAGE
// ============================================================================

export default function ReportsPage() {
  const {
    reports,
    filteredCount,
    isLoading,
    error,
    refetch,

    searchQuery,
    setSearchQuery,
    createdByFilter,
    setCreatedByFilter,
    sharedFilter,
    setSharedFilter,
    hasActiveFilters,

    sortState,
    toggleSort,

    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    selectedCount,
    isAllSelected,
    isSomeSelected,

    handleDeleteReport,
    handleShareReport,
    handleDownloadReport,

    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  } = useReportsPage();

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row — matches Documents page exactly */}
          <div
            data-testid="reports-page"
            className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between"
          >
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
              <p className="text-sm text-muted-foreground">View and manage agent-generated reports</p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search reports..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              <Select value={createdByFilter} onValueChange={setCreatedByFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="All Creators" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Creators</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                </SelectContent>
              </Select>

              <Select value={sharedFilter} onValueChange={setSharedFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Content */}
          <ErrorBoundary>
            {isLoading ? (
              <ReportsTableSkeleton />
            ) : error ? (
              // AUDIT-008: a failed fetch is not "no reports" — surface it honestly.
              <EmptyState
                icon={FileText}
                title="Could not load reports"
                description={error instanceof Error ? error.message : 'Unknown error'}
                action={{ label: 'Retry', onClick: () => void refetch() }}
              />
            ) : reports.length === 0 ? (
              hasActiveFilters ? (
                <EmptyState
                  icon={FileText}
                  title="No matching reports"
                  description="Try adjusting your search or filters"
                  action={{
                    label: 'Clear filters',
                    onClick: () => {
                      setSearchQuery('');
                      setCreatedByFilter('all');
                      setSharedFilter('all');
                    },
                  }}
                />
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No reports yet"
                  description="Reports are generated by AI agents during missions"
                  action={{
                    label: 'Go to Agent Runs',
                    onClick: () => {
                      window.location.href = '/agents/runs';
                    },
                  }}
                />
              )
            ) : (
              <>
                <ReportsTable
                  reports={reports}
                  onDeleteReport={handleDeleteReport}
                  onShareReport={handleShareReport}
                  onDownloadReport={handleDownloadReport}
                  isSelected={isSelected}
                  onToggleSelection={toggleSelection}
                  isAllSelected={isAllSelected}
                  isSomeSelected={isSomeSelected}
                  onSelectAllChange={(checked) => handleSelectAllChange(checked, reports)}
                  sortState={sortState}
                  onSort={toggleSort}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={filteredCount}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="reports"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Bulk Actions */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="report"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="report"
        onConfirm={handleBulkDelete}
      />
    </SmartLayout>
  );
}
