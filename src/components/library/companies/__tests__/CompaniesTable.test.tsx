/**
 * @file CompaniesTable.test.tsx
 * @description Pins the Research column + Location sort behavior of the
 * companies table (ported from the technologies table pattern).
 *
 * Pins:
 *   1. A company WITH persisted research shows an honest "AI draft" badge —
 *      never "Researched" or "Verified" (AI-028: research is an unverified draft
 *      requiring human source review, not a verified fact).
 *   2. A company WITHOUT research shows the sparkle "Research" action; clicking
 *      it fires onResearchCompany for that row and does NOT open the row
 *      (stopPropagation).
 *   3. A company whose id is in researchingCompanyIds shows "Researching...".
 *   4. Legacy `aiResearch`-only data also renders "AI draft", not "Researched".
 *   5. The "AI draft" badge carries an accessible source-review label.
 *   6. The row's "..." menu no longer contains a Research item (moved to the
 *      Research column).
 *   7. The Location header is sortable and emits onSort('location').
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { CompaniesTable } from '../CompaniesTable';
import type { Company } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';

// ============================================================================
// JSDOM POLYFILLS (Radix dropdown menu)
// ============================================================================

beforeAll(() => {
  // Radix UI primitives touch these APIs which jsdom does not implement.
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// ============================================================================
// FIXTURES
// ============================================================================

function makeCompany(overrides: Partial<Company> & { id: string; name: string }): Company {
  return {
    slug: overrides.id,
    description: '',
    website: '',
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
    updatedAt: 1,
    ...overrides,
  } as Company;
}

const RESEARCHED = makeCompany({
  id: 'c-researched',
  name: 'Researched Co',
  research: { lastResearched: 1, version: 1 },
});

const LEGACY_RESEARCHED = makeCompany({
  id: 'c-legacy',
  name: 'Legacy Co',
  aiResearch: { lastResearched: 1, data: {} },
});

const UNRESEARCHED = makeCompany({
  id: 'c-unresearched',
  name: 'Unresearched Co',
  location: { city: 'Berlin', country: 'Germany' },
});

const SORT: SortConfig = { key: 'name', direction: 'asc' };

function renderTable(companies: Company[], overrides: Partial<React.ComponentProps<typeof CompaniesTable>> = {}) {
  const props: React.ComponentProps<typeof CompaniesTable> = {
    companies,
    relations: {},
    onSelectCompany: jest.fn(),
    onDeleteCompany: jest.fn(),
    onResearchCompany: jest.fn(),
    researchingCompanyIds: new Set<string>(),
    isSelected: () => false,
    onToggleSelection: jest.fn(),
    isAllSelected: false,
    isSomeSelected: false,
    onSelectAllChange: jest.fn(),
    sortState: SORT,
    onSort: jest.fn(),
    ...overrides,
  };
  render(<CompaniesTable {...props} />);
  return props;
}

// ============================================================================
// RESEARCH COLUMN
// ============================================================================

describe('CompaniesTable — Research column', () => {
  it('renders a Research column header', () => {
    renderTable([UNRESEARCHED]);
    expect(screen.getByRole('columnheader', { name: 'Research' })).toBeInTheDocument();
  });

  it('shows an "AI draft" badge — never "Researched" or "Verified" — when research exists', () => {
    renderTable([RESEARCHED]);
    expect(screen.getByText('AI draft')).toBeInTheDocument();
    expect(screen.queryByText('Researched')).toBeNull();
    expect(screen.queryByText(/verified/i)).toBeNull();
    // A draft is a disclosure, not a research action: no "Research" button.
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull();
  });

  it('renders "AI draft" for a legacy aiResearch-only company (never "Researched")', () => {
    renderTable([LEGACY_RESEARCHED]);
    expect(screen.getByText('AI draft')).toBeInTheDocument();
    expect(screen.queryByText('Researched')).toBeNull();
    expect(screen.queryByText(/verified/i)).toBeNull();
  });

  it('exposes the "AI draft" badge to assistive tech with a source-review label', () => {
    renderTable([RESEARCHED]);
    // role="img" + aria-label yields a reliably-announced accessible name; a bare
    // aria-label on a role-less Badge div is not consistently announced by AT.
    expect(screen.getByRole('img', { name: /source review required/i })).toBeInTheDocument();
  });

  it('shows a clickable "Research" action when no research exists', () => {
    const props = renderTable([UNRESEARCHED]);
    const researchButton = screen.getByRole('button', { name: 'Research' });

    fireEvent.click(researchButton);

    expect(props.onResearchCompany).toHaveBeenCalledTimes(1);
    expect(props.onResearchCompany).toHaveBeenCalledWith(UNRESEARCHED);
    // stopPropagation: the row click (open sheet) must NOT fire.
    expect(props.onSelectCompany).not.toHaveBeenCalled();
  });

  it('shows "Researching..." while the company id is in researchingCompanyIds', () => {
    renderTable([UNRESEARCHED], { researchingCompanyIds: new Set([UNRESEARCHED.id]) });
    expect(screen.getByText('Researching...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull();
  });

  it('no longer offers Research in the row "..." menu', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable([UNRESEARCHED]);

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    // Menu is open (Edit is always present) but Research moved to the column.
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Research' })).toBeNull();
  });
});

// ============================================================================
// INDUSTRY PILL (canonical label map)
// ============================================================================

describe('CompaniesTable — Industry pill', () => {
  it('resolves the canonical COMPANY_INDUSTRY_LABELS name, not a naive title-case', () => {
    const company = makeCompany({ id: 'c-tech', name: 'Tech Co', industry: ['technology'] });
    renderTable([company]);
    expect(screen.getByText('Technology & Software')).toBeInTheDocument();
    expect(screen.queryByText('Technology')).not.toBeInTheDocument();
  });
});

// ============================================================================
// LOCATION SORT
// ============================================================================

describe('CompaniesTable — Location sort', () => {
  it('renders Location as a sortable header that emits onSort("location")', () => {
    const props = renderTable([UNRESEARCHED]);
    const locationHeader = screen.getByRole('button', { name: 'Location' });

    fireEvent.click(locationHeader);

    expect(props.onSort).toHaveBeenCalledWith('location');
  });

  it('still renders the location cell as "City, Country"', () => {
    renderTable([UNRESEARCHED]);
    expect(screen.getByText('Berlin, Germany')).toBeInTheDocument();
  });
});
