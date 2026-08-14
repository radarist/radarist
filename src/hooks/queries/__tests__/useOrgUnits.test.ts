/**
 * @file useOrgUnits.test.ts
 * @description Tests for the Org Unit query hooks.
 *
 * Pins:
 *   1. `selectBusinessUnitNames` filters to type === 'business_unit',
 *      de-duplicates, and sorts alphabetically.
 *   2. `useBusinessUnitNames` applies the selector over the shared
 *      `orgUnitKeys.all` cache entry.
 *   3. `useOrgUnits` returns the raw org-unit list.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import type { OrgUnit } from '@/lib/types';

const mockGetOrgUnits = jest.fn();
jest.mock('@/lib/org-units', () => ({
  getOrgUnits: (...args: unknown[]) => mockGetOrgUnits(...args),
}));

import { useOrgUnits, useBusinessUnitNames, selectBusinessUnitNames } from '../useOrgUnits';

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
  makeOrgUnit({ id: 'ou-4', name: 'Platform Team', type: 'team' }),
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('selectBusinessUnitNames', () => {
  it('filters to business_unit type and sorts alphabetically', () => {
    expect(selectBusinessUnitNames(ORG_UNITS)).toEqual(['Animal Nutrition & Health', 'Digital and Tech']);
  });

  it('de-duplicates repeated names', () => {
    const units = [
      makeOrgUnit({ id: 'a', name: 'Digital and Tech', type: 'business_unit' }),
      makeOrgUnit({ id: 'b', name: 'Digital and Tech', type: 'business_unit' }),
    ];
    expect(selectBusinessUnitNames(units)).toEqual(['Digital and Tech']);
  });

  it('returns an empty array when no business units exist', () => {
    const units = [makeOrgUnit({ id: 'a', name: 'Platform Team', type: 'team' })];
    expect(selectBusinessUnitNames(units)).toEqual([]);
  });
});

describe('useOrgUnits', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all org units', async () => {
    mockGetOrgUnits.mockResolvedValue(ORG_UNITS);

    const { result } = renderHook(() => useOrgUnits(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(ORG_UNITS);
  });
});

describe('useBusinessUnitNames', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only business-unit names, sorted', async () => {
    mockGetOrgUnits.mockResolvedValue(ORG_UNITS);

    const { result } = renderHook(() => useBusinessUnitNames(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(['Animal Nutrition & Health', 'Digital and Tech']);
  });

  it('surfaces query errors', async () => {
    mockGetOrgUnits.mockRejectedValue(new Error('firestore down'));

    const { result } = renderHook(() => useBusinessUnitNames(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
