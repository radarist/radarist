/**
 * Component render tests for CompanyCompetitors (React Testing Library)
 *
 * Regression coverage for the Competitors-tab ErrorBoundary crash:
 * `company.industry.slice(...).join is not a function`. The persisted
 * `industry` field carries mixed shapes (legacy/AI-imported docs store a
 * plain string; curated docs store the declared array). The tab must render
 * for BOTH shapes, and the Add Competitor flow must work end-to-end against
 * a mixed-shape company list.
 *
 * Note: CompanyCompetitors.test.ts (node env) covers the pure business
 * logic; this file covers actual rendering behavior.
 */

// ============================================================================
// MOCKS
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default. Mock
// every icon with a simple <svg> stub so the component module graph can load.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

// The toast fn must be referentially stable across renders: the component's
// loadCompetitors useCallback depends on it, and an unstable reference would
// re-trigger the load effect on every render (infinite loading loop).
jest.mock('@/hooks/use-toast', () => {
  const stableToast = jest.fn();
  return { useToast: () => ({ toast: stableToast }) };
});

// Break the firebase import chain — services are exercised via these mocks.
jest.mock('@/lib/companies', () => ({
  getCompanies: jest.fn(),
  getCompanyById: jest.fn(),
}));

jest.mock('@/lib/relations', () => ({
  createRelation: jest.fn(),
  getRelationsForEntity: jest.fn(),
  deleteRelation: jest.fn(),
}));

// ============================================================================
// IMPORTS
// ============================================================================

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CompanyCompetitors } from '../CompanyCompetitors';
import { getCompanies, getCompanyById } from '@/lib/companies';
import { createRelation, getRelationsForEntity } from '@/lib/relations';
import type { Company, Relation } from '@/lib/types';

// Radix ScrollArea (Add Competitor dialog) requires ResizeObserver, which
// jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockGetCompanies = getCompanies as jest.MockedFunction<typeof getCompanies>;
const mockGetCompanyById = getCompanyById as jest.MockedFunction<typeof getCompanyById>;
const mockCreateRelation = createRelation as jest.MockedFunction<typeof createRelation>;
const mockGetRelationsForEntity = getRelationsForEntity as jest.MockedFunction<typeof getRelationsForEntity>;

// ============================================================================
// FIXTURES
// ============================================================================

function buildCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'company-2',
    name: 'Competitor Corp',
    slug: 'competitor-corp',
    description: 'A rival company',
    website: 'https://rival.example.com',
    type: ['sme'],
    industry: ['technology'],
    size: 'small',
    stage: 'private',
    location: { city: 'Zurich', country: 'Switzerland' },
    status: 'Watching',
    tags: [],
    socialLinks: {},
    technologyStack: [],
    documents: [],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  } as Company;
}

/** Legacy/AI-imported shape: `industry` persisted as a plain string. */
function buildLegacyStringIndustryCompany(overrides: Partial<Company> = {}): Company {
  const company = buildCompany(overrides);
  return { ...company, industry: 'energy' as unknown as Company['industry'] };
}

function buildCompetitorRelation(sourceId: string, targetId: string, targetName: string): Relation {
  return {
    id: `rel-${sourceId}-${targetId}`,
    relationType: 'competes_with',
    sourceSnapshot: { type: 'company', id: sourceId, name: 'ABB', snapshotAt: Date.now() },
    targetSnapshot: { type: 'company', id: targetId, name: targetName, snapshotAt: Date.now() },
    confidence: 100,
    aiSuggested: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Relation;
}

// ============================================================================
// TESTS
// ============================================================================

describe('CompanyCompetitors rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRelationsForEntity.mockResolvedValue([]);
    mockGetCompanies.mockResolvedValue([]);
  });

  it('renders a linked competitor whose industry is a plain string (legacy shape) without crashing', async () => {
    const relation = buildCompetitorRelation('company-1', 'company-2', 'Legacy Energy Co');
    mockGetRelationsForEntity.mockResolvedValue([relation]);
    mockGetCompanyById.mockResolvedValue(
      buildLegacyStringIndustryCompany({ id: 'company-2', name: 'Legacy Energy Co' })
    );

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);

    expect(await screen.findByText('Legacy Energy Co')).toBeInTheDocument();
    // String shape must render as a single industry badge, not crash.
    expect(screen.getByText('energy')).toBeInTheDocument();
  });

  it('renders a linked competitor with an industry array (declared shape)', async () => {
    const relation = buildCompetitorRelation('company-1', 'company-2', 'Array Energy Co');
    mockGetRelationsForEntity.mockResolvedValue([relation]);
    mockGetCompanyById.mockResolvedValue(
      buildCompany({
        id: 'company-2',
        name: 'Array Energy Co',
        industry: ['energy', 'utilities'] as Company['industry'],
      })
    );

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);

    expect(await screen.findByText('Array Energy Co')).toBeInTheDocument();
    expect(screen.getByText('energy')).toBeInTheDocument();
    expect(screen.getByText('utilities')).toBeInTheDocument();
  });

  it('renders a linked competitor with a missing industry field', async () => {
    const relation = buildCompetitorRelation('company-1', 'company-2', 'No Industry Co');
    mockGetRelationsForEntity.mockResolvedValue([relation]);
    mockGetCompanyById.mockResolvedValue(
      buildCompany({ id: 'company-2', name: 'No Industry Co', industry: undefined as unknown as Company['industry'] })
    );

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);

    expect(await screen.findByText('No Industry Co')).toBeInTheDocument();
  });

  it('Add Competitor flow works with a mixed-shape company list and writes a curated competes_with relation', async () => {
    const user = userEvent.setup();
    mockGetRelationsForEntity.mockResolvedValue([]);
    mockGetCompanies.mockResolvedValue([
      buildLegacyStringIndustryCompany({ id: 'company-2', name: 'Legacy Energy Co' }),
      buildCompany({ id: 'company-3', name: 'Array Tech Co', industry: ['technology'] as Company['industry'] }),
    ]);
    mockCreateRelation.mockResolvedValue(buildCompetitorRelation('company-1', 'company-2', 'Legacy Energy Co'));

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);

    // Empty state renders once relations load.
    await screen.findByText('No competitors linked');

    await user.click(screen.getByRole('button', { name: 'Add Competitor' }));

    // Dialog lists both companies; the legacy string industry renders inline.
    expect(await screen.findByText('Legacy Energy Co')).toBeInTheDocument();
    expect(screen.getByText('Array Tech Co')).toBeInTheDocument();
    expect(screen.getByText(/energy/)).toBeInTheDocument();

    await user.click(screen.getByText('Legacy Energy Co'));

    await waitFor(() => {
      expect(mockCreateRelation).toHaveBeenCalledWith(
        expect.objectContaining({
          relationType: 'competes_with',
          aiSuggested: false,
          claimStatus: 'curated',
          confidence: 100,
          sourceSnapshot: expect.objectContaining({ type: 'company', id: 'company-1', name: 'ABB' }),
          targetSnapshot: expect.objectContaining({ type: 'company', id: 'company-2', name: 'Legacy Energy Co' }),
        })
      );
    });
  });

  it('search filter matches against string-shaped industry without crashing', async () => {
    const user = userEvent.setup();
    mockGetRelationsForEntity.mockResolvedValue([]);
    mockGetCompanies.mockResolvedValue([
      buildLegacyStringIndustryCompany({ id: 'company-2', name: 'Legacy Energy Co' }),
      buildCompany({ id: 'company-3', name: 'Array Tech Co', industry: ['technology'] as Company['industry'] }),
    ]);

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);
    await screen.findByText('No competitors linked');
    await user.click(screen.getByRole('button', { name: 'Add Competitor' }));
    await screen.findByText('Legacy Energy Co');

    await user.type(screen.getByPlaceholderText('Search companies...'), 'energy');

    await waitFor(() => {
      expect(screen.getByText('Legacy Energy Co')).toBeInTheDocument();
      expect(screen.queryByText('Array Tech Co')).not.toBeInTheDocument();
    });
  });
});

describe('CompanyCompetitors accessible names (UX-040)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCompanies.mockResolvedValue([]);
  });

  it('names the open-website and remove-competitor icon buttons with the competitor name', async () => {
    const relation = buildCompetitorRelation('company-1', 'company-2', 'Rival Corp');
    mockGetRelationsForEntity.mockResolvedValue([relation]);
    mockGetCompanyById.mockResolvedValue(buildCompany({ id: 'company-2', name: 'Rival Corp' }));

    render(<CompanyCompetitors companyId="company-1" companyName="ABB" />);

    expect(await screen.findByRole('button', { name: /open rival corp website/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove competitor rival corp/i })).toBeInTheDocument();
  });
});
