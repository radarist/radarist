'use client'

import {
  LayoutGrid,
  LayoutList,
  Search,
  Target,
} from 'lucide-react'

import { SmartLayout } from '@/components/layout/AppLayoutV2'
import { PageShell, PageContent } from '@/components/layout/PageShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/feedback/EmptyState'

import { DataPagination } from '@/components/library/shared/DataPagination'
import { StrategiesTable, StrategiesTableSkeleton } from '@/components/library/strategies/StrategiesTable'
import { StrategiesGrid, StrategiesGridSkeleton } from '@/components/library/strategies/StrategiesGrid'
import { StrategySheet } from '@/components/sheets/StrategySheet'
import { useEntityNotes } from '@/hooks/useEntityNotes'
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions'
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary'
import { useStrategiesPage } from '@/hooks/useStrategiesPage'
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';

export default function LibraryStrategiesPage() {
  const {
    graphSyncRecoveries,
    maxGraphSyncRetries,
    graphSyncEntityTypeLabel,
    getGraphSyncRecoveryLabel,
    retryGraphSync,
    sortedStrategies,
    paginatedStrategies,
    relationsMap,
    isLoading,

    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortConfig,
    handleSort,
    hasActiveFilters,
    clearFilters,

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

    isSheetOpen,
    isAddingNew,
    setIsAddingNew,
    selectedStrategy,
    handleSelectStrategy,
    handleSheetOpenChange,
    handleSave,
    handleSheetDelete,
    handleAddRelation,
    handleRemoveRelation,

    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    strategyToDelete,
    confirmDelete,
    handleDelete,

    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  } = useStrategiesPage()

  // UX-004: real note persistence for the selected strategy (page passed no handlers).
  const strategyNotes = useEntityNotes('strategies', selectedStrategy?.id)

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 data-testid="page-title" className="text-2xl font-semibold tracking-tight">Innovation Directives</h1>
              <p className="text-sm text-muted-foreground">
                Guiding principles and mandates from leaders, BUs, and strategic partners.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search strategies..."
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
                  aria-label="Table view"                  className="rounded-r-none h-9 px-3"
                >
                  <LayoutList className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"                  className="rounded-l-none h-9 px-3"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
              </div>

              <Button data-testid="create-strategy-button" size="sm" className="h-9" onClick={() => setIsAddingNew(true)}>
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
            viewMode === 'table' ? <StrategiesTableSkeleton /> : <StrategiesGridSkeleton />
          ) : sortedStrategies.length === 0 ? (
            <EmptyState
              icon={Target}
              title={hasActiveFilters ? 'No strategies found' : 'No strategies yet'}
              description={
                hasActiveFilters
                  ? "Try adjusting your search to find what you're looking for."
                  : 'Create your first strategy to define innovation directives.'
              }
              action={
                hasActiveFilters
                  ? { label: 'Clear filters', onClick: clearFilters }
                  : { label: 'New strategy', onClick: () => setIsAddingNew(true) }
              }
            />
          ) : viewMode === 'table' ? (
            <>
              <StrategiesTable
                strategies={paginatedStrategies}
                relationsMap={relationsMap}
                onSelectStrategy={handleSelectStrategy}
                onDeleteStrategy={confirmDelete}
                sortConfig={sortConfig}
                onSort={handleSort}
                isSelected={(id) => isSelected({ id } as Parameters<typeof isSelected>[0])}
                onToggleSelection={(id) => toggleSelection({ id } as Parameters<typeof toggleSelection>[0])}
                isAllSelected={isAllSelected}
                isSomeSelected={isSomeSelected}
                onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedStrategies)}
              />
              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={sortedStrategies.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="strategies"
              />
            </>
          ) : (
            <>
              <StrategiesGrid
                strategies={paginatedStrategies}
                relationsMap={relationsMap}
                onSelectStrategy={handleSelectStrategy}
                onDeleteStrategy={confirmDelete}
              />
              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={sortedStrategies.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="strategies"
              />
            </>
          )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Strategy Sheet */}
      <StrategySheet
        open={isSheetOpen || isAddingNew}
        onOpenChange={(open) => {
          if (!open) {
            handleSheetOpenChange(false)
            setIsAddingNew(false)
          }
        }}
        strategy={isAddingNew ? undefined : selectedStrategy}
        relations={selectedStrategy ? relationsMap.get(selectedStrategy.id) || [] : []}
        onSave={handleSave}
        onDelete={handleSheetDelete}
        onAddRelation={selectedStrategy ? handleAddRelation : undefined}
        onRemoveRelation={selectedStrategy ? handleRemoveRelation : undefined}
        notes={strategyNotes.notes}
        onAddNote={strategyNotes.onAddNote}
        onUpdateNote={strategyNotes.onUpdateNote}
        onDeleteNote={strategyNotes.onDeleteNote}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Strategy</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{strategyToDelete?.name}&quot;? This action cannot be undone.
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
        entityType="strategy"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="strategy"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />
    </SmartLayout>
  )
}
