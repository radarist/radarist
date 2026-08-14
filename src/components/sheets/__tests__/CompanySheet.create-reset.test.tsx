/**
 * Regression tests for the stale-create-form bug (pre-release visual review).
 *
 * Bug: opening a company (edit mode) calls `form.reset(companyValues)`, which
 * in react-hook-form REPLACES the stored defaultValues. The create-mode branch
 * then called a bare `form.reset()`, restoring the last-opened company's data
 * into the "New Company" sheet (user saw Accelera by Cummins' full data under
 * the "New Company / Create a new company" title).
 *
 * Fix: create mode resets to an explicit EMPTY_COMPANY_FORM_VALUES constant.
 *
 * Scenarios covered:
 * 1. edit A → create mode → form fields are empty defaults
 * 2. edit A → edit B (direct switch) → fields show B, not A
 * 3. edit A → sheet closed → reopened in create mode → fields empty (exact user repro)
 * 4. edit A on a non-Overview tab → create mode → active tab resets to Overview
 *    (same stale-mounted-instance bug class, but for activeTab state)
 *
 * Mocking strategy mirrors TechnologySheet.test.tsx: mock heavy transitive
 * dependencies (tabs, scouting components, hooks) so the real form +
 * OverviewTab render in jsdom.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ============================================================================
// MOCKS — must come before component import
// ============================================================================

// Mock session tracking so EntitySheetShell doesn't fetch / need getIdToken
jest.mock('@/hooks/useTrackEntityView', () => ({
  useTrackEntityView: jest.fn(),
}));

// Break Firebase auth chain
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'test-user' } },
}));

// Mock lucide-react with a Proxy so any icon import works
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

// Mock ErrorBoundary (used by EntitySheetShell)
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock VerificationBadge (avoids firebase import chain)
jest.mock('@/components/impulse/VerificationBadge', () => ({
  VerificationBadge: () => null,
}));

// Mock the shared sheet tabs (Notes/Relations/Knowledge/Research) — heavy chains
jest.mock('@/components/sheets/tabs', () => ({
  NotesTab: ({ onUpdateNote }: { onUpdateNote?: (id: string, content: string) => Promise<void> }) => (
    <button type="button" onClick={() => onUpdateNote?.('note-1', 'Edited note')}>
      Trigger note update
    </button>
  ),
  RelationsTab: () => <div data-testid="relations-tab" />,
  KnowledgeTab: () => <div data-testid="knowledge-tab" />,
  ResearchTab: () => <div data-testid="research-tab" />,
}));

// Mock scouting components (Firebase chains)
jest.mock('@/components/scouting/ContactManager', () => ({
  ContactManager: () => <div data-testid="contact-manager" />,
}));
jest.mock('@/components/scouting/CompanyCompetitors', () => ({
  CompanyCompetitors: () => <div data-testid="company-competitors" />,
}));

// Mock the Graph dialog (P-C3c) — same heavy Firebase/force-graph chain that
// TechnologySheet.test.tsx already stubs out.
jest.mock('@/components/graphs/EntityRelationshipPanel', () => ({
  EntityRelationshipPanel: () => <div data-testid="entity-relationship-panel" />,
}));

// Mock entity search hook (fetch chain)
jest.mock('@/hooks/useEntitySearch', () => ({
  useEntitySearch: jest.fn(() => ({
    searchEntities: jest.fn(),
  })),
}));

// ============================================================================
// IMPORT COMPONENT (after mocks)
// ============================================================================

import { CompanySheet } from '../CompanySheet';
import type { Company } from '@/lib/types';

// ============================================================================
// FIXTURES
// ============================================================================

const companyA: Company = {
  id: 'company-a',
  slug: 'accelera-by-cummins',
  name: 'Accelera by Cummins',
  description: 'Zero-emissions business segment of Cummins.',
  website: 'https://www.accelerazero.com',
  logo: '',
  type: ['enterprise'],
  industry: ['energy'],
  size: 'enterprise',
  stage: 'public',
  location: { city: 'Columbus', country: 'USA' },
  status: 'Watching',
  tags: ['electrolyzers'],
  socialLinks: { linkedin: '', twitter: '', github: '' },
  technologyStack: [],
  documents: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as unknown as Company;

const companyB: Company = {
  ...companyA,
  id: 'company-b',
  slug: 'electric-hydrogen',
  name: 'Electric Hydrogen',
  description: 'Green hydrogen electrolyzer manufacturer.',
  website: 'https://eh2.com',
  location: { city: 'Natick', country: 'USA' },
} as unknown as Company;

const companyWithResearchDraft: Company = {
  ...companyA,
  id: 'company-research-draft',
  research: {
    lastResearched: 2,
    version: 1,
    executiveSummary: { overview: 'Generated draft', keyHighlights: [] },
  },
} as unknown as Company;

const defaultProps = {
  open: true,
  onOpenChange: jest.fn(),
  onSave: jest.fn().mockResolvedValue(undefined),
};

// Form field queries (placeholders are unique within the Overview tab)
const nameInput = () => screen.getByPlaceholderText('Enter company name') as HTMLInputElement;
const descriptionInput = () =>
  screen.getByPlaceholderText('Brief description of the company...') as HTMLTextAreaElement;
const websiteInput = () => screen.getByPlaceholderText('https://example.com') as HTMLInputElement;
const cityInput = () => screen.getByPlaceholderText('City') as HTMLInputElement;

// ============================================================================
// TESTS
// ============================================================================

describe('CompanySheet form reset between edit and create mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the company data when opened in edit mode', () => {
    render(<CompanySheet {...defaultProps} company={companyA} />);

    expect(screen.getByText('Accelera by Cummins')).toBeInTheDocument(); // sheet title
    expect(nameInput().value).toBe('Accelera by Cummins');
    expect(descriptionInput().value).toBe('Zero-emissions business segment of Cummins.');
    expect(websiteInput().value).toBe('https://www.accelerazero.com');
    expect(cityInput().value).toBe('Columbus');
  });

  it('discloses the AI research draft on the default Overview tab', () => {
    render(<CompanySheet {...defaultProps} company={companyWithResearchDraft} />);

    expect(screen.getByText(/This company has an AI research draft/i)).toBeInTheDocument();
    expect(screen.getByText(/review the Research tab and source references/i)).toBeInTheDocument();
  });

  it('resets to empty defaults when switching from edit mode to create mode', () => {
    const { rerender } = render(<CompanySheet {...defaultProps} company={companyA} />);

    // Sanity: edit mode shows company A
    expect(nameInput().value).toBe('Accelera by Cummins');

    // Switch to create mode (page passes company={undefined} when isAddingNew)
    rerender(<CompanySheet {...defaultProps} company={undefined} />);

    expect(screen.getByText('New Company')).toBeInTheDocument();
    expect(nameInput().value).toBe('');
    expect(descriptionInput().value).toBe('');
    expect(websiteInput().value).toBe('');
    expect(cityInput().value).toBe('');
  });

  it('resets to empty defaults when sheet is closed after edit and reopened in create mode', () => {
    // Exact user repro: view company A → close sheet → click "+" (create)
    const { rerender } = render(<CompanySheet {...defaultProps} company={companyA} />);
    expect(nameInput().value).toBe('Accelera by Cummins');

    // Close the sheet (selection cleared)
    rerender(<CompanySheet {...defaultProps} open={false} company={undefined} />);

    // Reopen in create mode
    rerender(<CompanySheet {...defaultProps} open={true} company={undefined} />);

    expect(screen.getByText('New Company')).toBeInTheDocument();
    expect(nameInput().value).toBe('');
    expect(descriptionInput().value).toBe('');
    expect(websiteInput().value).toBe('');
  });

  it('resets the active tab to Overview when switching from edit mode to create mode', async () => {
    // Repro: open company → switch to Competitors tab → close → "+ New Company"
    // The mounted instance kept the previous session's tab, so the create
    // sheet opened on the Competitors placeholder instead of Overview.
    const user = userEvent.setup();
    const { rerender } = render(<CompanySheet {...defaultProps} company={companyA} />);

    // Switch to a non-Overview tab (Competitors is enabled in edit mode)
    await user.click(screen.getByRole('tab', { name: /competitors/i }));
    expect(screen.getByRole('tab', { name: /competitors/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'false');

    // Switch to create mode (page passes company={undefined} when isAddingNew)
    rerender(<CompanySheet {...defaultProps} company={undefined} />);

    expect(screen.getByText('New Company')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /competitors/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the second company data when switching directly between two companies', () => {
    const { rerender } = render(<CompanySheet {...defaultProps} company={companyA} />);
    expect(nameInput().value).toBe('Accelera by Cummins');

    rerender(<CompanySheet {...defaultProps} company={companyB} />);

    expect(nameInput().value).toBe('Electric Hydrogen');
    expect(descriptionInput().value).toBe('Green hydrogen electrolyzer manufacturer.');
    expect(websiteInput().value).toBe('https://eh2.com');
    expect(cityInput().value).toBe('Natick');
  });
});

describe('CompanySheet mutation boundaries', () => {
  it('keeps the sheet open when its owner rejects a save', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const onSave = jest.fn().mockRejectedValue(new Error('write rejected'));
    render(<CompanySheet {...defaultProps} company={undefined} onOpenChange={onOpenChange} onSave={onSave} />);

    await user.type(nameInput(), 'Uncommitted Company');
    await user.click(screen.getByText('Startup'));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(nameInput()).toHaveValue('Uncommitted Company');
  });

  it('keeps the sheet open when delete reports failure', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const onDelete = jest.fn().mockResolvedValue(false);
    render(<CompanySheet {...defaultProps} company={companyA} onOpenChange={onOpenChange} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('CompanySheet note editing', () => {
  it('passes the persisted update callback to NotesTab', async () => {
    const user = userEvent.setup();
    const onUpdateNote = jest.fn().mockResolvedValue(undefined);
    render(<CompanySheet {...defaultProps} company={companyA} onUpdateNote={onUpdateNote} />);

    await user.click(screen.getByRole('tab', { name: /notes/i }));
    await user.click(screen.getByRole('button', { name: 'Trigger note update' }));

    expect(onUpdateNote).toHaveBeenCalledWith('note-1', 'Edited note');
  });
});
