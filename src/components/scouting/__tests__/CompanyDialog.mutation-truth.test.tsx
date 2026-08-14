/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Company } from '@/lib/types';

const mockToast = jest.fn();
const mockRecordRecovery = jest.fn();
const mockClearRecovery = jest.fn();
const mockRetryGraphSync = jest.fn();
const mockUseEntityGraphSyncRecoveries = jest.fn((_options?: unknown) => ({
  recoveries: [],
  recordRecovery: mockRecordRecovery,
  clearRecovery: mockClearRecovery,
  retryGraphSync: mockRetryGraphSync,
  maxRetryAttempts: 3,
}));

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/hooks/useEntityGraphSyncRecoveries', () => ({
  useEntityGraphSyncRecoveries: (...args: unknown[]) => mockUseEntityGraphSyncRecoveries(...args),
}));
jest.mock('@/lib/company-mutation-outcome', () => ({
  resolveCompanyCreateOutcome: jest.fn(),
  resolveCompanyUpdateOutcome: jest.fn(),
}));
jest.mock('@/lib/companies', () => ({ deleteCompany: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}));

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          const Icon = () => <span aria-hidden="true" />;
          Icon.displayName = String(prop);
          return Icon;
        },
      }
    )
);

jest.mock('@/components/scouting/CompanyOverview', () => ({
  CompanyOverview: ({ onSave }: { onSave: (updates: Partial<Company>) => Promise<void> }) => (
    <button onClick={() => onSave({ name: 'Committed Company' })}>Persist overview</button>
  ),
}));
jest.mock('@/components/scouting/ContactManager', () => ({ ContactManager: () => null }));
jest.mock('@/components/scouting/CompanyRadarLinks', () => ({ CompanyRadarLinks: () => null }));
jest.mock('@/components/scouting/NotesTimeline', () => ({ NotesTimeline: () => null }));
jest.mock('@/components/scouting/DocumentManager', () => ({ DocumentManager: () => null }));
jest.mock('@/components/scouting/UseCaseManager', () => ({ UseCaseManager: () => null }));
jest.mock('@/components/scouting/AICompanyResearch', () => ({ AICompanyResearch: () => null }));
jest.mock('@/components/scouting/CompanySWOTAnalysis', () => ({ CompanySWOTAnalysis: () => null }));
jest.mock('@/components/scouting/CompanyCompetitors', () => ({ CompanyCompetitors: () => null }));
jest.mock('@/components/graphs/ContextualGraph', () => ({ ContextualGraph: () => null }));
jest.mock('@/components/documents/DocumentUploadDialog', () => ({ DocumentUploadDialog: () => null }));
jest.mock('@/components/library/shared/EntityGraphSyncWarning', () => ({ EntityGraphSyncWarning: () => null }));

import { CompanyDialog } from '@/components/scouting/CompanyDialog';
import { resolveCompanyUpdateOutcome } from '@/lib/company-mutation-outcome';

const mockedResolveCompanyUpdateOutcome = jest.mocked(resolveCompanyUpdateOutcome);

const company = {
  id: 'company-1',
  slug: 'company-1',
  name: 'Original Company',
  description: '',
  website: '',
  logo: '',
  type: ['startup'],
  industry: [],
  industryCustom: [],
  size: 'small',
  stage: 'seed',
  location: { city: '', country: '' },
  status: 'Watching',
  tags: [],
  socialLinks: {},
  technologyStack: [],
  documents: [],
  createdAt: 1,
  updatedAt: 1,
} as Company;

describe('CompanyDialog mutation truth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rehydrates only Company graph-sync recoveries', () => {
    render(
      <CompanyDialog
        isOpen
        onOpenChange={jest.fn()}
        company={company}
        isNew={false}
        onSaved={jest.fn()}
        onDeleted={jest.fn()}
      />
    );

    expect(mockUseEntityGraphSyncRecoveries).toHaveBeenCalledWith({ entityType: 'company' });
  });

  it('keeps an AI-draft warning visible outside the research tab', () => {
    render(
      <CompanyDialog
        isOpen
        onOpenChange={jest.fn()}
        company={{
          ...company,
          research: {
            lastResearched: 2,
            version: 1,
            executiveSummary: { overview: 'Generated draft', keyHighlights: [] },
          },
        }}
        isNew={false}
        onSaved={jest.fn()}
        onDeleted={jest.fn()}
      />
    );

    expect(screen.getByText(/This company includes an unverified AI research draft/i)).toBeInTheDocument();
    expect(screen.getByText(/Review its source references before relying on generated fields/i)).toBeInTheDocument();
  });

  it('keeps the dialog workflow active and records recovery after a committed local save', async () => {
    const user = userEvent.setup();
    const onSaved = jest.fn();
    const committed = { ...company, name: 'Committed Company' };
    mockedResolveCompanyUpdateOutcome.mockResolvedValue({
      status: 'saved-locally',
      entityType: 'company',
      entityId: company.id,
      operation: 'update',
      entity: committed,
      graphSyncError: new Error('unacknowledged') as never,
    });

    render(
      <CompanyDialog
        isOpen
        onOpenChange={jest.fn()}
        company={company}
        isNew={false}
        onSaved={onSaved}
        onDeleted={jest.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Persist overview' }));

    expect(mockRecordRecovery).toHaveBeenCalledWith(expect.objectContaining({ entity: committed }), 'save');
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved locally' }));
  });

  it('finishes the dialog workflow after Firestore save and queue acknowledgement', async () => {
    const user = userEvent.setup();
    const onSaved = jest.fn();
    const committed = { ...company, name: 'Committed Company' };
    mockedResolveCompanyUpdateOutcome.mockResolvedValue({
      status: 'saved-and-queued',
      entityType: 'company',
      entityId: company.id,
      operation: 'update',
      entity: committed,
    });

    render(
      <CompanyDialog
        isOpen
        onOpenChange={jest.fn()}
        company={company}
        isNew={false}
        onSaved={onSaved}
        onDeleted={jest.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Persist overview' }));

    // Queue acknowledgement is not graph convergence; only the worker may
    // retire the durable recovery anchor.
    expect(mockClearRecovery).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not mislabel an unverifiable post-commit state as a rejected save', async () => {
    const user = userEvent.setup();
    const onSaved = jest.fn();
    mockedResolveCompanyUpdateOutcome.mockRejectedValue(new Error('authoritative read unavailable'));

    render(
      <CompanyDialog
        isOpen
        onOpenChange={jest.fn()}
        company={company}
        isNew={false}
        onSaved={onSaved}
        onDeleted={jest.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Persist overview' }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Save status unavailable', variant: 'destructive' })
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Company not saved' }));
  });
});
