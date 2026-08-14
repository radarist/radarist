'use client';

import { AlertTriangle, Search, LayoutGrid, LayoutList, Trash2, ChevronDown } from 'lucide-react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/feedback/EmptyState';

import { DataPagination } from '@/components/library/shared/DataPagination';
import { PainPointsTable, PainPointsTableSkeleton } from '@/components/library/pain-points/PainPointsTable';
import { PainPointsGrid, PainPointsGridSkeleton } from '@/components/library/pain-points/PainPointsGrid';
import { PainPointSheet } from '@/components/sheets/PainPointSheet';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { painPointKeys } from '@/lib/query-keys';
import { useEntityNotes } from '@/hooks/useEntityNotes';
import {
  usePainPointsPage,
  PAIN_POINT_SEVERITIES,
  PAIN_POINT_STATUSES,
  PAIN_POINT_CATEGORIES,
} from '@/hooks/usePainPointsPage';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';

// ============================================================================
// PAGE COMPONENT (pure composition)
// ============================================================================

export default function PainPointsPage() {
  const {
    graphSyncRecoveries,
    maxGraphSyncRetries,
    graphSyncEntityTypeLabel,
    getGraphSyncRecoveryLabel,
    retryGraphSync,
    // Data
    sortedPainPoints,
    paginatedPainPoints,
    orgUnits,
    isLoading,
    error,

    // View state
    viewMode,
    setViewMode,
    searchQuery,
    handleSearchChange,
    sortConfig,
    handleSort,
    hasFilters,
    clearFilters,

    // Filters
    selectedSeverities,
    selectedStatuses,
    selectedCategories,
    toggleSeverityFilter,
    toggleStatusFilter,
    toggleCategoryFilter,

    // Pagination
    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    // Selection
    selectedIds,
    handleSelectAll,
    handleSelectOne,

    // Sheet
    sheetOpen,
    setSheetOpen,
    editingPainPoint,
    handleCreateNew,
    handleEdit,
    handleSave,
    handleSheetDelete,
    painPointRelations,
    handleAddRelation,
    handleRemoveRelation,

    // Delete dialog
    deleteDialogOpen,
    setDeleteDialogOpen,
    painPointToDelete,
    handleDeleteClick,
    handleConfirmDelete,

    // Bulk operations
    handleBulkDelete,
    bulkDeleteMutation,

    queryClient,
  } = usePainPointsPage();

  // Notes for the selected pain point (UX-026) — shared entity-notes contract.
  // Handlers are undefined until a pain point is selected; the sheet treats
  // that as read-only.
  const { notes, onAddNote, onUpdateNote, onDeleteNote } = useEntityNotes('painPoints', editingPainPoint?.id);

  // Error state
  if (error) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent>
            <EmptyState
              icon={AlertTriangle}
              title="Failed to load pain points"
              description={error instanceof Error ? error.message : 'Unknown error occurred'}
              action={{
                label: 'Try Again',
                onClick: () => queryClient.invalidateQueries({ queryKey: painPointKeys.all }),
              }}
            />
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Pain Points</h1>
              <p className="text-sm text-muted-foreground">
                Business problems and opportunities that drive innovation initiatives.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search pain points..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              {/* Severity filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Severity
                    {selectedSeverities.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedSeverities.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {PAIN_POINT_SEVERITIES.map((s) => (
                    <DropdownMenuItem key={s.value} onClick={() => toggleSeverityFilter(s.value)} className="gap-2">
                      <Checkbox checked={selectedSeverities.includes(s.value)} className="pointer-events-none" />
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Status filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Status
                    {selectedStatuses.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedStatuses.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {PAIN_POINT_STATUSES.map((s) => (
                    <DropdownMenuItem key={s.value} onClick={() => toggleStatusFilter(s.value)} className="gap-2">
                      <Checkbox checked={selectedStatuses.includes(s.value)} className="pointer-events-none" />
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Category filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Category
                    {selectedCategories.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedCategories.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {PAIN_POINT_CATEGORIES.map((c) => (
                    <DropdownMenuItem key={c.value} onClick={() => toggleCategoryFilter(c.value)} className="gap-2">
                      <Checkbox checked={selectedCategories.includes(c.value)} className="pointer-events-none" />
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* View Toggle */}
              <div className="flex items-center rounded-md border">
                <Button
                  variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('table')}
                  aria-label="Table view"
                  className="rounded-r-none h-9 px-3"
                >
                  <LayoutList className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                  className="rounded-l-none h-9 px-3"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
              </div>

              {/* Add Button — icon-only "+", matches Companies header button (CONV-ADD) */}
              <Button onClick={handleCreateNew} size="sm" className="h-9" aria-label="Add pain point">
                +
              </Button>
            </div>
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-4 p-3 mx-4 mt-4 bg-muted rounded-lg">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={bulkDeleteMutation.isPending}
                className="gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Delete Selected
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleSelectAll()}>
                Clear Selection
              </Button>
            </div>
          )}

          {/* Content */}
          <EntityGraphSyncRecoveryBanner
            recoveries={graphSyncRecoveries}
            maxRetryAttempts={maxGraphSyncRetries}
            entityTypeLabel={graphSyncEntityTypeLabel}
            getLabel={getGraphSyncRecoveryLabel}
            onRetry={retryGraphSync}
          />

          <ErrorBoundary>
            {isLoading ? (
              viewMode === 'table' ? (
                <PainPointsTableSkeleton />
              ) : (
                <PainPointsGridSkeleton />
              )
            ) : sortedPainPoints.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title={hasFilters ? 'No pain points match your filters' : 'No pain points yet'}
                description={
                  hasFilters
                    ? 'Try adjusting your search or filters'
                    : 'Document business problems to drive problem-pull innovation'
                }
                action={
                  hasFilters
                    ? { label: 'Clear Filters', onClick: clearFilters }
                    : { label: 'New pain point', onClick: handleCreateNew }
                }
              />
            ) : viewMode === 'table' ? (
              <>
                <PainPointsTable
                  painPoints={paginatedPainPoints}
                  selectedIds={selectedIds}
                  sortConfig={sortConfig}
                  onSort={handleSort}
                  onSelectAll={handleSelectAll}
                  onSelectOne={handleSelectOne}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedPainPoints.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="pain points"
                />
              </>
            ) : (
              <>
                <PainPointsGrid
                  painPoints={paginatedPainPoints}
                  selectedIds={selectedIds}
                  onSelectOne={handleSelectOne}
                  onEdit={handleEdit}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedPainPoints.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="pain points"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Pain Point Sheet */}
      <PainPointSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        painPoint={editingPainPoint}
        onSave={handleSave}
        onDelete={handleSheetDelete}
        orgUnits={orgUnits.map((unit) => ({ id: unit.id, name: unit.name }))}
        relations={editingPainPoint ? painPointRelations[editingPainPoint.id] || [] : []}
        onAddRelation={handleAddRelation}
        onRemoveRelation={handleRemoveRelation}
        notes={notes}
        onAddNote={onAddNote}
        onUpdateNote={onUpdateNote}
        onDeleteNote={onDeleteNote}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Pain Point</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{painPointToDelete?.title}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SmartLayout>
  );
}
