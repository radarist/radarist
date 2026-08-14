/**
 * @file app/library/companies/page.tsx
 * @description Library Companies page - Browse and manage scouted companies
 *
 * Decomposed architecture:
 * - State & logic: src/hooks/useCompaniesPage.ts
 * - Badges: src/components/library/companies/badges.tsx
 * - Table view: src/components/library/companies/CompaniesTable.tsx
 * - Grid view: src/components/library/companies/CompaniesGrid.tsx
 * - Empty state: src/components/library/companies/CompaniesEmptyState.tsx
 * - Pagination: src/components/library/shared/DataPagination.tsx
 * - Sort header: src/components/library/shared/SortableHeader.tsx
 */

'use client';

import * as React from 'react';
import type { Company } from '@/lib/types';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LayoutGrid, LayoutList, Search } from 'lucide-react';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { CompanySheet } from '@/components/sheets/CompanySheet';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { CompaniesTable } from '@/components/library/companies/CompaniesTable';
import { CompaniesGrid } from '@/components/library/companies/CompaniesGrid';
import { CompaniesEmptyState } from '@/components/library/companies/CompaniesEmptyState';
import { CompanyReviewQueue } from '@/components/library/companies/CompanyReviewQueue';
import { resolveIndustryLabel } from '@/components/library/companies/badges';
import { useCompaniesPage } from '@/hooks/useCompaniesPage';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';

export default function LibraryCompaniesPage() {
  const {
    // Data
    filteredCompanies,
    isLoading,
    companyRelations,
    companyNotes,
    industries,
    // View
    viewMode,
    setViewMode,
    // Pagination
    pagination,
    paginatedCompanies,
    handlePageChange,
    handlePageSizeChange,
    // Sorting
    sortState,
    toggleSort,
    // Filters
    searchQuery,
    setSearchQuery,
    selectedIndustry,
    setSelectedIndustry,
    // Selection
    selectedCount,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    isAllSelected,
    isSomeSelected,
    // Sheet state
    selectedCompany,
    isSheetOpen,
    isAddingNew,
    setIsAddingNew,
    handleSheetOpenChange,
    // Handlers
    handleAddCompany,
    handleEditCompany,
    handleDeleteCompany,
    handleResearchFromMenu,
    researchingCompanyIds,
    handleBulkDelete,
    // Bulk delete dialog
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    // Relation handlers
    handleAddRelation,
    handleRemoveRelation,
    // Sheet handlers
    handleAddNote,
    handleUpdateNote,
    handleDeleteNote,
    handleSave,
    handleDelete,
    handleAIResearch,
    handleApplyResearch,
    isResearchLoading,
    graphSyncRecoveries,
    retryGraphSync,
    maxGraphSyncRetries,
  } = useCompaniesPage();

  // AI-043 — the review queue opens the sheet directly on the Research tab; the
  // list opens on Overview.
  const [sheetInitialTab, setSheetInitialTab] = React.useState<'overview' | 'research'>('overview');
  const openCompanyOverview = (company: Company) => {
    setSheetInitialTab('overview');
    handleEditCompany(company);
  };
  const openCompanyReview = (company: Company) => {
    setSheetInitialTab('research');
    handleEditCompany(company);
  };
  // Adding a new company always opens on Overview — reset the tab so a prior
  // "Review" open (which set it to 'research') can't leave the New Company sheet
  // stuck on the create-mode-disabled Research tab.
  const openAddCompany = () => {
    setSheetInitialTab('overview');
    handleAddCompany();
  };

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row: Title + Filters + Actions */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            {/* Left: Title */}
            <div className="space-y-1 shrink-0">
              <h1 data-testid="page-title" className="text-2xl font-semibold tracking-tight">
                Scouted Companies
              </h1>
              <p className="text-sm text-muted-foreground">
                Partners, vendors, competitors, and startups in your ecosystem.
              </p>
            </div>

            {/* Right: Search, Filters, Actions */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search companies..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              {/* Industry Filter */}
              <Select value={selectedIndustry} onValueChange={setSelectedIndustry}>
                <SelectTrigger className="h-9 w-full sm:w-[160px]">
                  <SelectValue placeholder="All Industries" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Industries</SelectItem>
                  {industries.map((industry, index) => (
                    <SelectItem key={`industry-${industry || 'empty'}-${index}`} value={industry || ''}>
                      {industry ? resolveIndustryLabel(industry) : 'Unknown'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

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

              {/* Add Button */}
              <Button data-testid="create-company-button" onClick={openAddCompany} size="sm" className="h-9">
                +
              </Button>
            </div>
          </div>

          <EntityGraphSyncRecoveryBanner
            recoveries={graphSyncRecoveries}
            maxRetryAttempts={maxGraphSyncRetries}
            entityTypeLabel="company"
            getLabel={(recovery) => recovery.entity?.name ?? recovery.entityId}
            onRetry={retryGraphSync}
          />

          {/* AI-043 — source-review queue facet: companies with an AI research
              draft awaiting human source review. Links each to its review panel. */}
          {!isLoading && <CompanyReviewQueue companies={filteredCompanies} onReview={openCompanyReview} />}

          {/* Content Area */}
          <ErrorBoundary>
            {isLoading ? (
              // Loading state - show appropriate skeleton for current view
              viewMode === 'table' ? (
                <div className="p-4 space-y-2">
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} className="h-[68px] w-full" />
                  ))}
                </div>
              ) : (
                <CompaniesGrid companies={[]} relations={{}} onSelectCompany={() => {}} isLoading={true} />
              )
            ) : filteredCompanies.length === 0 ? (
              // Empty state - shared between views
              <CompaniesEmptyState
                hasFilters={!!searchQuery || selectedIndustry !== 'all'}
                onAddCompany={openAddCompany}
              />
            ) : viewMode === 'table' ? (
              <>
                <CompaniesTable
                  companies={paginatedCompanies}
                  relations={companyRelations}
                  onSelectCompany={openCompanyOverview}
                  onDeleteCompany={handleDeleteCompany}
                  onResearchCompany={handleResearchFromMenu}
                  researchingCompanyIds={researchingCompanyIds}
                  isSelected={isSelected}
                  onToggleSelection={toggleSelection}
                  isAllSelected={isAllSelected}
                  isSomeSelected={isSomeSelected}
                  onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedCompanies)}
                  sortState={sortState}
                  onSort={toggleSort}
                />
                <DataPagination
                  pageIndex={pagination.pageIndex}
                  pageSize={pagination.pageSize}
                  totalCount={filteredCompanies.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  itemLabel="companies"
                />
              </>
            ) : (
              <>
                <CompaniesGrid
                  companies={paginatedCompanies}
                  relations={companyRelations}
                  onSelectCompany={openCompanyOverview}
                />
                <DataPagination
                  pageIndex={pagination.pageIndex}
                  pageSize={pagination.pageSize}
                  totalCount={filteredCompanies.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  itemLabel="companies"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Company Sheet */}
      <CompanySheet
        open={isSheetOpen || isAddingNew}
        initialTab={sheetInitialTab}
        onOpenChange={(open) => {
          if (!open) {
            handleSheetOpenChange(false);
            setIsAddingNew(false);
          }
        }}
        company={isAddingNew ? undefined : selectedCompany}
        relations={selectedCompany ? companyRelations[selectedCompany.id] || [] : []}
        notes={selectedCompany ? companyNotes[selectedCompany.id] || [] : []}
        onAddNote={handleAddNote}
        onUpdateNote={handleUpdateNote}
        onDeleteNote={handleDeleteNote}
        onSave={handleSave}
        onDelete={handleDelete}
        onAddRelation={handleAddRelation}
        onRemoveRelation={handleRemoveRelation}
        onAIResearch={handleAIResearch}
        onApplyResearch={handleApplyResearch}
        isResearchLoading={isResearchLoading}
      />

      {/* Bulk Actions */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="company"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="company"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />
    </SmartLayout>
  );
}
