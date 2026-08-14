'use client';

import { LayoutGrid, LayoutList, Search, Lightbulb } from 'lucide-react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { UseCasesTable, UseCasesTableSkeleton } from '@/components/library/use-cases/UseCasesTable';
import { UseCasesGrid, UseCasesGridSkeleton } from '@/components/library/use-cases/UseCasesGrid';
import { UseCaseSheet } from '@/components/sheets/UseCaseSheet';
import { useEntityNotes } from '@/hooks/useEntityNotes';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { useUseCasesPage } from '@/hooks/useUseCasesPage';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';

export default function LibraryUseCasesPage() {
  const {
    graphSyncRecoveries,
    maxGraphSyncRetries,
    graphSyncEntityTypeLabel,
    getGraphSyncRecoveryLabel,
    retryGraphSync,
    useCases: _useCases,
    relationsMap,
    sortedUseCases,
    paginatedUseCases,
    isLoading,

    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortConfig,
    handleSort,
    hasActiveFilters,

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

    selectedUseCase,
    isSheetOpen,
    isAddingNew,
    handleSheetOpenChange,
    handleSelectUseCase,
    handleAddNew,
    handleSave,

    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    useCaseToDelete,
    confirmDelete,
    handleDelete,

    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,

    handleAddRelation,
    handleRemoveRelation,
    handleEntityClick,
  } = useUseCasesPage();

  // UX-003: real note persistence for the selected use case (page passed no handlers).
  const useCaseNotes = useEntityNotes('use-cases', selectedUseCase?.id);

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 data-testid="page-title" className="text-2xl font-semibold tracking-tight">
                Opportunity Areas
              </h1>
              <p className="text-sm text-muted-foreground">
                Spaces where emerging technologies can solve business challenges.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search use cases..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

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

              <Button data-testid="create-use-case-button" size="sm" className="h-9" onClick={handleAddNew}>
                +
              </Button>
            </div>
          </div>

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
                <UseCasesTableSkeleton />
              ) : (
                <UseCasesGridSkeleton />
              )
            ) : sortedUseCases.length === 0 ? (
              <EmptyState
                icon={Lightbulb}
                title={hasActiveFilters ? 'No use cases found' : 'No use cases yet'}
                description={
                  hasActiveFilters
                    ? "Try adjusting your search to find what you're looking for."
                    : 'Create your first use case to identify opportunity areas.'
                }
                action={
                  hasActiveFilters
                    ? { label: 'Clear filters', onClick: () => setSearchQuery('') }
                    : { label: 'Add use case', onClick: handleAddNew }
                }
              />
            ) : viewMode === 'table' ? (
              <>
                <UseCasesTable
                  useCases={paginatedUseCases}
                  relationsMap={relationsMap}
                  onSelectUseCase={handleSelectUseCase}
                  onDeleteUseCase={confirmDelete}
                  sortConfig={sortConfig}
                  onSort={handleSort}
                  isSelected={(id) => isSelected({ id } as import('@/lib/types').UseCase)}
                  onToggleSelection={(id) => toggleSelection({ id } as import('@/lib/types').UseCase)}
                  isAllSelected={isAllSelected}
                  isSomeSelected={isSomeSelected}
                  onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedUseCases)}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedUseCases.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="use cases"
                />
              </>
            ) : (
              <>
                <UseCasesGrid
                  useCases={paginatedUseCases}
                  relationsMap={relationsMap}
                  onSelectUseCase={handleSelectUseCase}
                  onDeleteUseCase={confirmDelete}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedUseCases.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="use cases"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Use Case Sheet */}
      <UseCaseSheet
        open={isSheetOpen || isAddingNew}
        onOpenChange={(open) => {
          if (!open) {
            handleSheetOpenChange(false);
          }
        }}
        useCase={isAddingNew ? undefined : selectedUseCase}
        relations={selectedUseCase ? relationsMap.get(selectedUseCase.id) || [] : []}
        onSave={handleSave}
        onDelete={
          selectedUseCase
            ? async () => {
                // F76: actually delete. The footer Delete used to only reload +
                // close, so nothing was removed. Route through the same
                // confirm→deleteUseCase flow the table row uses.
                handleSheetOpenChange(false);
                confirmDelete(selectedUseCase);
              }
            : undefined
        }
        onAddRelation={handleAddRelation}
        onRemoveRelation={handleRemoveRelation}
        notes={useCaseNotes.notes}
        onAddNote={useCaseNotes.onAddNote}
        onUpdateNote={useCaseNotes.onUpdateNote}
        onDeleteNote={useCaseNotes.onDeleteNote}
        onEntityClick={handleEntityClick}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Use Case</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{useCaseToDelete?.title}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Actions */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="use case"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="use case"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />
    </SmartLayout>
  );
}
