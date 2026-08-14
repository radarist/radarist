import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const mockSetShowOrphansOnly = jest.fn();

jest.mock('next/dynamic', () => () => () => null);
jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);
jest.mock('@/components/layout/AppLayoutV2', () => ({
  SmartLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PageContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <>{placeholder}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/feedback/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/components/library/shared/DataPagination', () => ({ DataPagination: () => null }));
jest.mock('@/components/library/documents/DocumentsTable', () => ({
  DocumentsTable: () => null,
  DocumentsTableSkeleton: () => null,
}));
jest.mock('@/components/library/documents/DocumentsGrid', () => ({
  DocumentsGrid: () => null,
  DocumentsGridSkeleton: () => null,
}));
jest.mock('@/components/documents/DocumentUploadButton', () => ({ DocumentUploadButton: () => null }));
jest.mock('@/components/sheets/DocumentSheet', () => ({ DocumentSheet: () => null }));
jest.mock('@/components/bulk-actions', () => ({
  BulkActionToolbar: () => null,
  BulkDeleteDialog: () => null,
}));
jest.mock('@/hooks/useDocumentsPage', () => ({
  useDocumentsPage: () => ({
    documents: [],
    filteredDocuments: [],
    paginatedDocuments: [],
    isLoading: false,
    loadDocuments: jest.fn(),
    viewMode: 'table',
    setViewMode: jest.fn(),
    searchQuery: '',
    setSearchQuery: jest.fn(),
    selectedType: 'all',
    setSelectedType: jest.fn(),
    selectedStatus: 'all',
    setSelectedStatus: jest.fn(),
    showOrphansOnly: false,
    setShowOrphansOnly: mockSetShowOrphansOnly,
    sortState: { key: 'createdAt', direction: 'desc' },
    toggleSort: jest.fn(),
    hasActiveFilters: false,
    pageIndex: 0,
    setPageIndex: jest.fn(),
    pageSize: 25,
    setPageSize: jest.fn(),
    isSelected: jest.fn(),
    toggleSelection: jest.fn(),
    handleSelectAllChange: jest.fn(),
    clearSelection: jest.fn(),
    selectedCount: 0,
    isAllSelected: false,
    isSomeSelected: false,
    selectedDocumentId: null,
    isSheetOpen: false,
    setIsSheetOpen: jest.fn(),
    handleViewDocument: jest.fn(),
    handleProcessDocument: jest.fn(),
    handleDownloadDocument: jest.fn(),
    handleRetryDocument: jest.fn(),
    handleDeleteDocument: jest.fn(),
    handleRefreshDocument: jest.fn(),
    previewDocument: null,
    isPreviewOpen: false,
    setPreviewOpen: jest.fn(),
    handlePreviewDocument: jest.fn(),
    showBulkDeleteDialog: false,
    setShowBulkDeleteDialog: jest.fn(),
    handleBulkDelete: jest.fn(),
  }),
}));

import LibraryDocumentsPage from '../page';

describe('LibraryDocumentsPage compact filters', () => {
  it('names the orphan filter, exposes its toggle state, and enables it', () => {
    render(<LibraryDocumentsPage />);

    const filter = screen.getByRole('button', { name: 'Show unlinked documents only' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(filter);
    expect(mockSetShowOrphansOnly).toHaveBeenCalledWith(true);
  });
});
