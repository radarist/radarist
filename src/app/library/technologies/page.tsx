/**
 * @file app/library/technologies/page.tsx
 * @description Library Technologies page - Browse and manage all scouted technologies
 *
 * Decomposed architecture:
 * - State & logic: src/hooks/useTechnologiesPage.ts
 * - Badges: src/components/library/technologies/badges.tsx
 * - Table view: src/components/library/technologies/TechnologiesTable.tsx
 * - Grid view: src/components/library/technologies/TechnologiesGrid.tsx
 * - Empty state: src/components/library/technologies/TechnologiesEmptyState.tsx
 * - Pagination: src/components/library/shared/DataPagination.tsx
 * - Sort header: src/components/library/shared/SortableHeader.tsx
 */

'use client';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LayoutGrid, LayoutList, Search } from 'lucide-react';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { TechnologySheet } from '@/components/sheets/TechnologySheet';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { TechnologiesTable } from '@/components/library/technologies/TechnologiesTable';
import { TechnologiesGrid } from '@/components/library/technologies/TechnologiesGrid';
import { TechnologiesEmptyState } from '@/components/library/technologies/TechnologiesEmptyState';
import { useTechnologiesPage } from '@/hooks/useTechnologiesPage';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';
import { useRouter } from 'next/navigation';

export default function LibraryTechnologiesPage() {
  const router = useRouter();
  const {
    // Data
    graphSyncRecoveries,
    maxGraphSyncRetries,
    graphSyncEntityTypeLabel,
    getGraphSyncRecoveryLabel,
    retryGraphSync,
    relationsMap,
    placementsMap,
    isLoading,
    loadFailed,
    retryLoad,
    radarNames,
    // View
    viewMode,
    setViewMode,
    // Pagination
    pagination,
    paginatedTechnologies,
    sortedTechnologies,
    handlePageChange,
    handlePageSizeChange,
    // Sorting
    sortConfig,
    handleSort,
    // Filters
    searchQuery,
    setSearchQuery,
    selectedRadar,
    setSelectedRadar,
    hasActiveFilters,
    clearFilters,
    // Selection
    selectedCount,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    isAllSelected,
    isSomeSelected,
    // Delete
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    handleBulkDelete,
    handleDeleteTechnologyClick,
    handleDeleteTechnology,
    // Research
    researchingTechIds,
    handleResearchTechnology,
    // Edit sheet
    isEditSheetOpen,
    setIsEditSheetOpen,
    selectedTechnology,
    setSelectedTechnology,
    isAddingNew,
    setIsAddingNew,
    handleEditTechnology,
    // Sheet operations
    openCreateSheet,
    handleCreateTechnology,
    getSheetTechnologyProps,
    handleSheetAddRelation,
    handleSheetRemoveRelation,
    handleSheetSave,
    handleSheetAddNote,
    handleSheetUpdateNote,
    handleSheetDeleteNote,
    handleSheetAIResearch,
  } = useTechnologiesPage();

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row: Title + Filters + Actions */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            {/* Left: Title */}
            <div className="space-y-1 shrink-0">
              <h1 data-testid="page-title" className="text-2xl font-semibold tracking-tight">
                Scouted Tech
              </h1>
              <p className="text-sm text-muted-foreground">Key enablers shaping your innovation roadmap.</p>
            </div>

            {/* Right: Search, Radar Filter, View Toggle, Add Button */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search technologies..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              <Select value={selectedRadar} onValueChange={setSelectedRadar}>
                <SelectTrigger className="h-9 w-full sm:w-[160px]">
                  <SelectValue placeholder="All Radars" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Radars</SelectItem>
                  {radarNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

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

              <Button data-testid="create-technology-button" size="sm" className="h-9" onClick={openCreateSheet}>
                +
              </Button>
            </div>
          </div>

          <EntityGraphSyncRecoveryBanner
            recoveries={graphSyncRecoveries}
            maxRetryAttempts={maxGraphSyncRetries}
            entityTypeLabel={graphSyncEntityTypeLabel}
            getLabel={getGraphSyncRecoveryLabel}
            onRetry={retryGraphSync}
          />

          {/* Content Area */}
          <ErrorBoundary>
            {isLoading ? (
              viewMode === 'table' ? (
                <div className="p-4 space-y-2">
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} className="h-[68px] w-full" />
                  ))}
                </div>
              ) : (
                <TechnologiesGrid
                  technologies={[]}
                  relationsMap={new Map()}
                  onSelectTechnology={() => {}}
                  isLoading={true}
                />
              )
            ) : loadFailed || sortedTechnologies.length === 0 ? (
              <TechnologiesEmptyState
                hasFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                onCreateTechnology={openCreateSheet}
                onAddViaRadar={() => router.push('/radar')}
                loadFailed={loadFailed}
                onRetry={retryLoad}
              />
            ) : viewMode === 'table' ? (
              <>
                <TechnologiesTable
                  technologies={paginatedTechnologies}
                  relationsMap={relationsMap}
                  placementsMap={placementsMap}
                  onSelectTechnology={handleEditTechnology}
                  onDeleteTechnology={handleDeleteTechnologyClick}
                  onResearchTechnology={handleResearchTechnology}
                  researchingTechIds={researchingTechIds}
                  sortConfig={sortConfig}
                  onSort={handleSort}
                  isSelected={isSelected}
                  onToggleSelection={toggleSelection}
                  isAllSelected={isAllSelected}
                  isSomeSelected={isSomeSelected}
                  onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedTechnologies)}
                />
                <DataPagination
                  pageIndex={pagination.pageIndex}
                  pageSize={pagination.pageSize}
                  totalCount={sortedTechnologies.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  itemLabel="technologies"
                />
              </>
            ) : (
              <>
                <TechnologiesGrid
                  technologies={paginatedTechnologies}
                  relationsMap={relationsMap}
                  onSelectTechnology={handleEditTechnology}
                />
                <DataPagination
                  pageIndex={pagination.pageIndex}
                  pageSize={pagination.pageSize}
                  totalCount={sortedTechnologies.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  itemLabel="technologies"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Edit/Create Technology Sheet */}
      {selectedTechnology || isAddingNew
        ? (() => {
            if (isAddingNew && !selectedTechnology) {
              return (
                <TechnologySheet
                  open={isEditSheetOpen}
                  onOpenChange={(open) => {
                    setIsEditSheetOpen(open);
                    if (!open) setIsAddingNew(false);
                  }}
                  onSave={handleCreateTechnology}
                />
              );
            }

            if (!selectedTechnology) return null;

            const sheetProps = getSheetTechnologyProps();
            if (!sheetProps) return null;

            const { originalTechId, technologyProp, techPlacements, relations } = sheetProps;

            return (
              <TechnologySheet
                open={isEditSheetOpen}
                onOpenChange={(open) => {
                  setIsEditSheetOpen(open);
                  if (!open) setSelectedTechnology(null);
                }}
                technology={technologyProp}
                placements={techPlacements}
                relations={relations}
                onAddRelation={(targetId, targetType, relationType) =>
                  handleSheetAddRelation(originalTechId, targetId, targetType, relationType)
                }
                onRemoveRelation={handleSheetRemoveRelation}
                onSave={(data) => handleSheetSave(originalTechId, data)}
                // The sheet already owns the named confirmation. Delete its exact
                // subject directly so a second modal is not mounted while the
                // sheet/confirmation pair is tearing down.
                onDelete={() => handleDeleteTechnology(selectedTechnology)}
                notes={technologyProp.notes || []}
                onAddNote={(content) => handleSheetAddNote(originalTechId, content, technologyProp.notes || [])}
                onUpdateNote={(noteId, content) =>
                  handleSheetUpdateNote(originalTechId, noteId, content, technologyProp.notes || [])
                }
                onDeleteNote={(noteId) => handleSheetDeleteNote(originalTechId, noteId, technologyProp.notes || [])}
                onAIResearch={handleSheetAIResearch}
              />
            );
          })()
        : null}

      {/* Bulk Actions */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="technology"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="technology"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />

      <BulkDeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        count={1}
        entityType="technology"
        onConfirm={handleDeleteTechnology}
        showCascadeWarning={true}
      />
    </SmartLayout>
  );
}
