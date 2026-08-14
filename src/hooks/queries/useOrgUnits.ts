/**
 * @file useOrgUnits.ts
 * @description TanStack Query hooks for Org Units
 *
 * Provides data fetching for organizational units, plus a derived
 * selector for Business Unit names (org units with type 'business_unit')
 * used by selectors such as the PrototypeSheet "Business Unit" field.
 *
 * @author Radarist Team
 * @created 2026-06-10
 */

import { useQuery } from '@tanstack/react-query';
import { orgUnitKeys } from '@/lib/query-keys';
import { getOrgUnits } from '@/lib/org-units';
import type { OrgUnit } from '@/lib/types';

// ============================================================================
// SELECTORS
// ============================================================================

/**
 * Derive the sorted, de-duplicated list of Business Unit names from org units.
 *
 * Exported separately so the filtering logic is unit-testable without
 * rendering a component.
 */
export function selectBusinessUnitNames(orgUnits: OrgUnit[]): string[] {
  const names = orgUnits.filter((unit) => unit.type === 'business_unit').map((unit) => unit.name);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all org units.
 *
 * Uses `orgUnitKeys.all` — the same key the Org Units library page queries —
 * so both surfaces share one cache entry and one Firestore read.
 *
 * @example
 * const { data: orgUnits, isLoading } = useOrgUnits()
 */
export function useOrgUnits() {
  return useQuery({
    queryKey: orgUnitKeys.all,
    queryFn: getOrgUnits,
  });
}

/**
 * Fetch the names of all Business Unit org units (type === 'business_unit'),
 * sorted alphabetically.
 *
 * Shares the `orgUnitKeys.all` cache entry with {@link useOrgUnits} — the
 * `select` transform is applied per-observer and does not fork the cache.
 *
 * @example
 * const { data: businessUnits, isLoading, isError } = useBusinessUnitNames()
 */
export function useBusinessUnitNames() {
  return useQuery({
    queryKey: orgUnitKeys.all,
    queryFn: getOrgUnits,
    select: selectBusinessUnitNames,
  });
}
