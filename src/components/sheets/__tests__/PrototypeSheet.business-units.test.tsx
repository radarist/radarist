/**
 * Tests for the PrototypeSheet Business Unit selector (OverviewTab).
 *
 * The selector sources its options from live Org Units (type === 'business_unit')
 * instead of the removed hardcoded BUSINESS_UNITS constant.
 *
 * Pins:
 *   1. Options render from org units filtered to the business_unit type.
 *   2. A legacy stored value (not among current org units) stays visible
 *      and selectable, subtly marked, so editing never silently changes data.
 *   3. Loading state renders a disabled select with a loading placeholder.
 *   4. With no Business Unit org units the field falls back to free entry
 *      with a pointer to the Org Units library.
 *   5. A failed org-units fetch also falls back to free entry (no dead end).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import type { OrgUnit } from '@/lib/types';

// ============================================================================
// MOCKS — must come before component import
// ============================================================================

const mockGetOrgUnits = jest.fn();
jest.mock('@/lib/org-units', () => ({
  getOrgUnits: (...args: unknown[]) => mockGetOrgUnits(...args),
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

// ============================================================================
// IMPORT COMPONENT (after mocks)
// ============================================================================

import { OverviewTab } from '../PrototypeSheet/OverviewTab';
import { prototypeFormSchema, type PrototypeFormValues } from '../PrototypeSheet/constants';

// ============================================================================
// jsdom POLYFILLS (Radix UI)
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

function makeOrgUnit(overrides: Partial<OrgUnit> & { id: string; name: string; type: OrgUnit['type'] }): OrgUnit {
  return {
    slug: overrides.id,
    level: 2,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ORG_UNITS: OrgUnit[] = [
  makeOrgUnit({ id: 'ou-1', name: 'Digital and Tech', type: 'business_unit' }),
  makeOrgUnit({ id: 'ou-2', name: 'Animal Nutrition & Health', type: 'business_unit' }),
  makeOrgUnit({ id: 'ou-3', name: 'People Operations', type: 'department' }),
];

const EMPTY_FORM_VALUES: PrototypeFormValues = {
  name: '',
  description: '',
  status: 'Ideation',
  targetBusinessUnit: '',
  team: [],
  presentedTo: [],
  presentationDate: undefined,
  artifacts: { demoUrl: '', repoUrl: '', demoVideo: '' },
  impact: {
    type: 'Revenue Generation',
    estimatedValue: 0,
    actualValue: undefined,
    timeToImpact: '',
    confidence: 50,
    notes: '',
  },
  costs: { estimated: undefined, actual: undefined, currency: 'USD', breakdown: [] },
  jiraEpic: '',
};

function Harness({ targetBusinessUnit = '' }: { targetBusinessUnit?: string }) {
  const form = useForm<PrototypeFormValues>({
    resolver: zodResolver(prototypeFormSchema),
    defaultValues: { ...EMPTY_FORM_VALUES, targetBusinessUnit },
  });
  return <OverviewTab form={form} />;
}

function renderHarness(props: { targetBusinessUnit?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>
  );
}

function getBusinessUnitTrigger(): HTMLElement {
  // The Business Unit select trigger is the combobox following the label.
  const comboboxes = screen.getAllByRole('combobox');
  // OverviewTab renders two selects: Status first, Business Unit second.
  return comboboxes[comboboxes.length - 1];
}

// ============================================================================
// TESTS
// ============================================================================

describe('PrototypeSheet Business Unit selector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders options from org units filtered to the business_unit type', async () => {
    mockGetOrgUnits.mockResolvedValue(ORG_UNITS);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderHarness();

    // Wait for the query to settle (loading placeholder disappears)
    await waitFor(() => expect(screen.queryByText('Loading business units...')).not.toBeInTheDocument());

    await user.click(getBusinessUnitTrigger());

    expect(await screen.findByRole('option', { name: 'Animal Nutrition & Health' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Digital and Tech' })).toBeInTheDocument();
    // Non-business-unit org units must not appear
    expect(screen.queryByRole('option', { name: 'People Operations' })).not.toBeInTheDocument();
  });

  it('keeps a legacy stored value visible and selectable, marked subtly', async () => {
    mockGetOrgUnits.mockResolvedValue(ORG_UNITS);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderHarness({ targetBusinessUnit: 'Nutrition' });

    await waitFor(() => expect(screen.queryByText('Loading business units...')).not.toBeInTheDocument());

    // The stored value still displays in the closed trigger
    expect(getBusinessUnitTrigger()).toHaveTextContent('Nutrition');

    await user.click(getBusinessUnitTrigger());

    // Legacy value is prepended as a selectable option with a subtle marker
    const legacyOption = await screen.findByRole('option', { name: /Nutrition \(legacy\)/ });
    expect(legacyOption).toBeInTheDocument();
    // Current org-unit options are still offered
    expect(screen.getByRole('option', { name: 'Digital and Tech' })).toBeInTheDocument();

    // Picking a real org unit still works
    await user.click(screen.getByRole('option', { name: 'Digital and Tech' }));
    expect(getBusinessUnitTrigger()).toHaveTextContent('Digital and Tech');
  });

  it('shows a disabled loading select while org units load', () => {
    mockGetOrgUnits.mockReturnValue(new Promise(() => {})); // never resolves

    renderHarness();

    expect(screen.getByText('Loading business units...')).toBeInTheDocument();
    expect(getBusinessUnitTrigger()).toBeDisabled();
  });

  it('falls back to free entry with a hint when no business units are defined', async () => {
    mockGetOrgUnits.mockResolvedValue([makeOrgUnit({ id: 'ou-3', name: 'People Operations', type: 'department' })]);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderHarness();

    const input = await screen.findByPlaceholderText('Enter business unit');
    expect(
      screen.getByText('No Business Unit org units defined yet — add them under Library → Org Units, or type a name.')
    ).toBeInTheDocument();

    // Free entry keeps the required field usable
    await user.type(input, 'Platform Engineering');
    expect(input).toHaveValue('Platform Engineering');
  });

  it('falls back to free entry with an error hint when the fetch fails', async () => {
    mockGetOrgUnits.mockRejectedValue(new Error('firestore down'));

    renderHarness({ targetBusinessUnit: 'Nutrition' });

    const input = await screen.findByPlaceholderText('Enter business unit');
    expect(screen.getByText('Could not load Org Units — enter the business unit name manually.')).toBeInTheDocument();
    // The stored value is preserved in the free-entry input
    expect(input).toHaveValue('Nutrition');
  });
});
