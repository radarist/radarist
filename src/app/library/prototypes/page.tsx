'use client'

import {
  LayoutGrid,
  LayoutList,
  Search,
  FlaskConical,
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
import { PrototypesTable, PrototypesTableSkeleton } from '@/components/library/prototypes/PrototypesTable'
import { PrototypesGrid, PrototypesGridSkeleton } from '@/components/library/prototypes/PrototypesGrid'
import { PrototypeSheet } from '@/components/sheets/PrototypeSheet'
import { useEntityNotes } from '@/hooks/useEntityNotes'
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions'
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary'
import { usePrototypesPage } from '@/hooks/usePrototypesPage'
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';

export default function LibraryPrototypesPage() {
  const {
    graphSyncRecoveries,
    maxGraphSyncRetries,
    graphSyncEntityTypeLabel,
    getGraphSyncRecoveryLabel,
    retryGraphSync,
    sortedPrototypes,
    paginatedPrototypes,
    relationsMap,
    handleAddRelation,
    handleRemoveRelation,
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
    selectedPrototype,
    handleSelectPrototype,
    handleAddNew,
    handleSheetOpenChange,
    setIsAddingNew,
    handleSave,
    handleSheetDelete,

    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    prototypeToDelete,
    confirmDelete,
    handleDelete,

    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  } = usePrototypesPage()

  // UX-002: real note persistence for the selected prototype (was a no-op).
  const prototypeNotes = useEntityNotes('prototypes', selectedPrototype?.id)

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 data-testid="page-title" className="text-2xl font-semibold tracking-tight">Experiments</h1>
              <p className="text-sm text-muted-foreground">
                Concepts, POCs, and pilots tested to validate innovation hypotheses.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search experiments..."
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

              <Button data-testid="create-prototype-button" size="sm" className="h-9" onClick={handleAddNew}>
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
            viewMode === 'table' ? <PrototypesTableSkeleton /> : <PrototypesGridSkeleton />
          ) : sortedPrototypes.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title={hasActiveFilters ? 'No experiments found' : 'No experiments yet'}
              description={
                hasActiveFilters
                  ? "Try adjusting your search to find what you're looking for."
                  : 'Create your first experiment to validate innovation hypotheses.'
              }
              action={
                hasActiveFilters
                  ? { label: 'Clear filters', onClick: clearFilters }
                  : { label: 'New prototype', onClick: handleAddNew }
              }
            />
          ) : viewMode === 'table' ? (
            <>
              <PrototypesTable
                prototypes={paginatedPrototypes}
                relationsMap={relationsMap}
                onSelectPrototype={handleSelectPrototype}
                onDeletePrototype={confirmDelete}
                sortConfig={sortConfig}
                onSort={handleSort}
                isSelected={(id) => isSelected({ id } as Parameters<typeof isSelected>[0])}
                onToggleSelection={(id) => toggleSelection({ id } as Parameters<typeof toggleSelection>[0])}
                isAllSelected={isAllSelected}
                isSomeSelected={isSomeSelected}
                onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedPrototypes)}
              />
              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={sortedPrototypes.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="experiments"
              />
            </>
          ) : (
            <>
              <PrototypesGrid
                prototypes={paginatedPrototypes}
                relationsMap={relationsMap}
                onSelectPrototype={handleSelectPrototype}
                onDeletePrototype={confirmDelete}
              />
              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={sortedPrototypes.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="experiments"
              />
            </>
          )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Prototype Sheet */}
      <PrototypeSheet
        open={isSheetOpen || isAddingNew}
        onOpenChange={(open) => {
          if (!open) {
            handleSheetOpenChange(false)
            setIsAddingNew(false)
          }
        }}
        prototype={isAddingNew ? undefined : selectedPrototype}
        relations={selectedPrototype ? relationsMap.get(selectedPrototype.id) || [] : []}
        onAddRelation={handleAddRelation}
        onRemoveRelation={handleRemoveRelation}
        onSave={handleSave}
        onDelete={handleSheetDelete}
        notes={prototypeNotes.notes}
        onAddNote={prototypeNotes.onAddNote}
        onUpdateNote={prototypeNotes.onUpdateNote}
        onDeleteNote={prototypeNotes.onDeleteNote}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Experiment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{prototypeToDelete?.name}&quot;? This action cannot be undone.
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
        entityType="prototype"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="prototype"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />
    </SmartLayout>
  )
}
