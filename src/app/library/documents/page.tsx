'use client';

import dynamic from 'next/dynamic';
import { LayoutGrid, LayoutList, Search, FileText, Unlink } from 'lucide-react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';

import { DataPagination } from '@/components/library/shared/DataPagination';
import { DocumentsTable, DocumentsTableSkeleton } from '@/components/library/documents/DocumentsTable';
import { DocumentsGrid, DocumentsGridSkeleton } from '@/components/library/documents/DocumentsGrid';
import { DocumentUploadButton } from '@/components/documents/DocumentUploadButton';
import { DocumentSheet } from '@/components/sheets/DocumentSheet';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { useDocumentsPage } from '@/hooks/useDocumentsPage';

// Lazy-loaded: the preview dialog statically imports react-markdown and
// dynamically imports mammoth/exceljs — none of it belongs in the page bundle.
const DocumentPreviewDialog = dynamic(
  () => import('@/components/library/documents/DocumentPreviewDialog').then((m) => m.DocumentPreviewDialog),
  { ssr: false }
);

export default function LibraryDocumentsPage() {
  const {
    documents,
    filteredDocuments,
    paginatedDocuments,
    isLoading,
    loadDocuments,

    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    selectedType,
    setSelectedType,
    selectedStatus,
    setSelectedStatus,
    showOrphansOnly,
    setShowOrphansOnly,
    sortState,
    toggleSort,
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

    selectedDocumentId,
    isSheetOpen,
    setIsSheetOpen,
    handleViewDocument,

    handleProcessDocument,
    handleDownloadDocument,
    handleRetryDocument,
    handleDeleteDocument,
    handleRefreshDocument,

    previewDocument,
    isPreviewOpen,
    setPreviewOpen,
    handlePreviewDocument,

    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  } = useDocumentsPage();

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
              <p className="text-sm text-muted-foreground">Manage knowledge for semantic search & citations.</p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              <Select value={selectedType} onValueChange={setSelectedType}>
                <SelectTrigger className="h-9 w-full sm:w-[120px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="docx">DOCX</SelectItem>
                  <SelectItem value="pptx">PPTX</SelectItem>
                  <SelectItem value="url">URL</SelectItem>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="transcript">Transcript</SelectItem>
                  <SelectItem value="deep-research">Deep Research</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="uploaded">Pending</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="processed">Processed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectContent>
              </Select>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={showOrphansOnly ? 'secondary' : 'outline'}
                      size="icon"
                      onClick={() => setShowOrphansOnly(!showOrphansOnly)}
                      className="h-9 w-9"
                      aria-label="Show unlinked documents only"
                      aria-pressed={showOrphansOnly}
                    >
                      <Unlink className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Show unlinked documents only</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

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

              <DocumentUploadButton size="icon" label="" className="h-9 w-9" onUploadComplete={() => loadDocuments()} />
            </div>
          </div>

          {/* Content */}
          <ErrorBoundary>
            {isLoading ? (
              viewMode === 'table' ? (
                <DocumentsTableSkeleton />
              ) : (
                <DocumentsGridSkeleton />
              )
            ) : filteredDocuments.length === 0 ? (
              <EmptyState
                icon={FileText}
                title={hasActiveFilters ? 'No documents found' : 'No documents yet'}
                description={
                  hasActiveFilters
                    ? "Try adjusting your search or filters to find what you're looking for."
                    : 'Upload your first document to get started with evidence-based analysis.'
                }
                action={
                  hasActiveFilters
                    ? {
                        label: 'Clear filters',
                        onClick: () => {
                          setSearchQuery('');
                          setSelectedType('all');
                          setSelectedStatus('all');
                          setShowOrphansOnly(false);
                        },
                      }
                    : { label: 'Upload', onClick: () => loadDocuments() }
                }
              />
            ) : viewMode === 'table' ? (
              <>
                <DocumentsTable
                  documents={paginatedDocuments}
                  onSelectDocument={handleViewDocument}
                  onProcessDocument={handleProcessDocument}
                  onRetryDocument={handleRetryDocument}
                  onDeleteDocument={handleDeleteDocument}
                  onDownloadDocument={handleDownloadDocument}
                  onRefreshDocument={handleRefreshDocument}
                  onPreviewDocument={handlePreviewDocument}
                  isSelected={isSelected}
                  onToggleSelection={toggleSelection}
                  isAllSelected={isAllSelected}
                  isSomeSelected={isSomeSelected}
                  onSelectAllChange={(checked) => handleSelectAllChange(checked, paginatedDocuments)}
                  sortState={sortState}
                  onSort={toggleSort}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={filteredDocuments.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="documents"
                />
              </>
            ) : (
              <>
                <DocumentsGrid
                  documents={paginatedDocuments}
                  onSelectDocument={handleViewDocument}
                  onProcessDocument={handleProcessDocument}
                  onRetryDocument={handleRetryDocument}
                  onDeleteDocument={handleDeleteDocument}
                  onDownloadDocument={handleDownloadDocument}
                  onRefreshDocument={handleRefreshDocument}
                  onPreviewDocument={handlePreviewDocument}
                />
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={filteredDocuments.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="documents"
                />
              </>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Bulk Actions */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="document"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={clearSelection}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedCount}
        entityType="document"
        onConfirm={handleBulkDelete}
        showCascadeWarning={true}
      />

      {/* Preview Dialog — conditional render keeps the dynamic chunk (and the
          mammoth/exceljs imports behind it) unloaded until first preview. */}
      {previewDocument && (
        <DocumentPreviewDialog
          document={previewDocument}
          open={isPreviewOpen}
          onOpenChange={setPreviewOpen}
          onDownload={handleDownloadDocument}
        />
      )}

      {/* Document Details Sheet */}
      <DocumentSheet
        documentId={selectedDocumentId}
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        onDelete={() => loadDocuments()}
        onProcess={(id) => {
          const doc = documents.find((d) => d.id === id);
          if (doc) handleProcessDocument(doc);
        }}
        // UX-036: the list behind the sheet used to keep the pre-retry status
        // until a manual reload, so the same retry could be fired repeatedly.
        onProcessingQueued={() => loadDocuments()}
      />
    </SmartLayout>
  );
}
