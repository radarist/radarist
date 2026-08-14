/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = () => <span aria-hidden="true" data-icon={prop} />;
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
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/sheets/CompanySheet', () => ({ CompanySheet: () => null }));
jest.mock('@/components/bulk-actions', () => ({
  BulkActionToolbar: () => null,
  BulkDeleteDialog: () => null,
}));
jest.mock('@/components/library/companies/CompaniesTable', () => ({
  CompaniesTable: () => <div>Companies table</div>,
}));
jest.mock('@/components/library/companies/CompaniesGrid', () => ({ CompaniesGrid: () => null }));
jest.mock('@/components/library/companies/CompaniesEmptyState', () => ({ CompaniesEmptyState: () => null }));
jest.mock('@/components/library/shared/DataPagination', () => ({ DataPagination: () => null }));
jest.mock('@/hooks/useCompaniesPage', () => ({ useCompaniesPage: jest.fn() }));

import LibraryCompaniesPage from '../page';
import { useCompaniesPage } from '@/hooks/useCompaniesPage';
import type { Company } from '@/lib/types';

const mockUseCompaniesPage = useCompaniesPage as jest.Mock;

const COMMITTED_COMPANY = {
  id: 'company-1',
  slug: 'acme-committed',
  name: 'Acme Committed',
  description: 'Authoritative data',
  website: '',
  logo: '',
  type: ['startup'],
  industry: [],
  size: 'small',
  stage: 'seed',
  location: { city: '', country: '' },
  status: 'Watching',
  tags: [],
  socialLinks: { linkedin: '', twitter: '', github: '' },
  technologyStack: [],
  documents: [],
  createdAt: 1,
  updatedAt: 2,
} as Company;

describe('LibraryCompaniesPage graph handoff recovery', () => {
  it('shows the Firestore-committed company and wires graph-only retry', async () => {
    const user = userEvent.setup();
    const retryGraphSync = jest.fn().mockResolvedValue(undefined);
    mockUseCompaniesPage.mockReturnValue({
      filteredCompanies: [COMMITTED_COMPANY],
      isLoading: false,
      companyRelations: {},
      companyNotes: {},
      industries: [],
      viewMode: 'table',
      setViewMode: jest.fn(),
      pagination: { pageIndex: 0, pageSize: 10 },
      paginatedCompanies: [COMMITTED_COMPANY],
      handlePageChange: jest.fn(),
      handlePageSizeChange: jest.fn(),
      sortState: { key: 'name', direction: 'asc' },
      toggleSort: jest.fn(),
      searchQuery: '',
      setSearchQuery: jest.fn(),
      selectedIndustry: 'all',
      setSelectedIndustry: jest.fn(),
      selectedCount: 0,
      isSelected: jest.fn(),
      toggleSelection: jest.fn(),
      handleSelectAllChange: jest.fn(),
      clearSelection: jest.fn(),
      isAllSelected: false,
      isSomeSelected: false,
      selectedCompany: undefined,
      isSheetOpen: false,
      isAddingNew: false,
      setIsAddingNew: jest.fn(),
      handleSheetOpenChange: jest.fn(),
      handleAddCompany: jest.fn(),
      handleEditCompany: jest.fn(),
      handleDeleteCompany: jest.fn(),
      handleResearchFromMenu: jest.fn(),
      researchingCompanyIds: new Set(),
      handleBulkDelete: jest.fn(),
      showBulkDeleteDialog: false,
      setShowBulkDeleteDialog: jest.fn(),
      handleAddRelation: jest.fn(),
      handleRemoveRelation: jest.fn(),
      handleAddNote: undefined,
      handleUpdateNote: undefined,
      handleDeleteNote: undefined,
      handleSave: jest.fn(),
      handleDelete: undefined,
      handleAIResearch: undefined,
      handleApplyResearch: jest.fn(),
      isResearchLoading: false,
      graphSyncRecoveries: [
        {
          status: 'saved-locally',
          entityType: 'company',
          entityId: COMMITTED_COMPANY.id,
          operation: 'update',
          entity: COMMITTED_COMPANY,
          graphSyncError: new Error('unacknowledged'),
          retryAttempts: 0,
          isRetrying: false,
          context: undefined,
        },
      ],
      retryGraphSync,
      maxGraphSyncRetries: 3,
    });

    render(<LibraryCompaniesPage />);

    expect(screen.getByRole('alert')).toHaveTextContent('Acme Committed');
    expect(screen.getByText('Companies table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry graph sync' }));
    expect(retryGraphSync).toHaveBeenCalledWith(COMMITTED_COMPANY.id);
  });
});
