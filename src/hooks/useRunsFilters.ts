/**
 * @file useRunsFilters.ts
 * @description ARUN-026 — multi-select Agent / Kind / Status facet state
 * for the Runs table.
 *
 * Semantics: OR within a facet, AND across facets (the table ANDs the
 * search box on top). An empty facet means "no constraint", so the
 * default state matches everything.
 *
 * Precedence: URL state wins outright over the saved preference — never a
 * merge. A shared link must reproduce exactly what the sender saw, and a
 * merge would silently widen or narrow it against the recipient's own
 * stored filters. With no facet params in the URL, the uid-scoped saved
 * preference applies.
 *
 * The preference is keyed by uid so an account switch can't inherit
 * another account's view (the same isolation rule as the UX-046 caches).
 *
 * Unknown / retired values are RETAINED (so their chip stays visible and
 * removable) but match nothing: a filter the reader can't see would make
 * a partial list look complete, and silently dropping the value would
 * broaden results beyond what the URL says.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { useUrlParams } from '@/hooks/useUrlState';
import { createLogger } from '@/lib/logger';

/**
 * The only fields this hook filters on. Declared structurally rather than
 * imported from `RunsTable`: the table imports THIS hook, so taking its row
 * type would close an import cycle — and the hook genuinely needs nothing
 * beyond these three facets.
 */
export interface RunsFilterableRow {
  agent: string;
  kind: string;
  status: string;
}

const log = createLogger('hooks/useRunsFilters');

export interface RunsFilterState {
  agents: string[];
  kinds: string[];
  statuses: string[];
}

export type RunsFacet = keyof RunsFilterState;

/** Facet ↔ URL param name. Short names keep shared links readable. */
const FACET_PARAM: Record<RunsFacet, string> = {
  agents: 'agent',
  kinds: 'kind',
  statuses: 'status',
};

const FACETS = Object.keys(FACET_PARAM) as RunsFacet[];

const EMPTY_FILTERS: RunsFilterState = { agents: [], kinds: [], statuses: [] };

/** Per-account storage key — an account switch must not inherit filters. */
export function runsFilterPreferenceKey(uid: string): string {
  return `radarist:runs-filters:${uid}`;
}

/** Parse a comma list from the URL, dropping blanks and duplicates. */
function parseParamList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Read the stored preference, tolerating corrupt or wrong-shaped payloads. */
function readPreference(uid: string): RunsFilterState | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(runsFilterPreferenceKey(uid));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const next: RunsFilterState = { ...EMPTY_FILTERS };
    for (const facet of FACETS) {
      const value = record[facet];
      if (value === undefined) continue;
      // A wrong-shaped facet invalidates the whole preference rather than
      // silently applying a partial filter the user never chose.
      if (!isStringArray(value)) return null;
      next[facet] = value;
    }
    return next;
  } catch (error) {
    log.warn('discarding unreadable runs-filter preference', { error: String(error) });
    return null;
  }
}

function writePreference(uid: string, filters: RunsFilterState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(runsFilterPreferenceKey(uid), JSON.stringify(filters));
  } catch (error) {
    // A full/blocked storage quota must not break filtering.
    log.warn('could not persist runs-filter preference', { error: String(error) });
  }
}

function clearPreference(uid: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(runsFilterPreferenceKey(uid));
  } catch (error) {
    log.warn('could not clear runs-filter preference', { error: String(error) });
  }
}

export interface UseRunsFiltersResult {
  filters: RunsFilterState;
  /** Where the active filters came from — drives nothing but is worth asserting. */
  source: 'url' | 'preference' | 'none';
  /** Total selected values across every facet. */
  activeCount: number;
  /** `persist: false` applies the facet WITHOUT saving it as the account's
   * preference — for state the user did not explicitly choose. */
  setFacet: (facet: RunsFacet, values: string[], options?: { persist?: boolean }) => void;
  toggleValue: (facet: RunsFacet, value: string) => void;
  reset: () => void;
  /** True when the row satisfies every facet (OR within, AND across). */
  matches: (row: RunsFilterableRow) => boolean;
}

export function useRunsFilters(): UseRunsFiltersResult {
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';
  const { params, setParams } = useUrlParams();
  const pathname = usePathname();
  const router = useRouter();
  // Bumped on every preference write so a preference-only change re-renders.
  // The URL is the primary channel, but `router.replace` lands asynchronously
  // (and a preference write changes nothing in the URL at all), so reading
  // localStorage alone would leave the control showing a stale selection.
  const [preferenceTick, setPreferenceTick] = useState(0);
  /**
   * The selection just applied, held until the URL reflects it.
   *
   * `router.replace` lands asynchronously, so between the click and the
   * navigation `useSearchParams` still reports the OLD facets — which would
   * win over the new selection and leave the control showing stale chips
   * (most visibly: pressing Reset appeared to do nothing). Holding the
   * applied value makes every change take effect at once, and it is dropped
   * as soon as the URL agrees.
   */
  const [pendingFilters, setPendingFilters] = useState<RunsFilterState | null>(null);

  const urlFilters = useMemo<RunsFilterState>(
    () => ({
      agents: parseParamList(params.get(FACET_PARAM.agents)),
      kinds: parseParamList(params.get(FACET_PARAM.kinds)),
      statuses: parseParamList(params.get(FACET_PARAM.statuses)),
    }),
    [params]
  );

  const urlHasFacets = FACETS.some((facet) => urlFilters[facet].length > 0);

  const filters = useMemo<RunsFilterState>(() => {
    if (pendingFilters) return pendingFilters;
    if (urlHasFacets) return urlFilters;
    return readPreference(uid) ?? EMPTY_FILTERS;
  }, [pendingFilters, urlHasFacets, urlFilters, uid, preferenceTick]);

  // Drop the override the moment the URL agrees with it.
  const pendingKey = pendingFilters ? JSON.stringify(pendingFilters) : null;
  const urlKey = JSON.stringify(urlFilters);
  useEffect(() => {
    if (pendingKey !== null && pendingKey === urlKey) setPendingFilters(null);
  }, [pendingKey, urlKey]);

  const source: 'url' | 'preference' | 'none' = urlHasFacets
    ? 'url'
    : FACETS.some((facet) => filters[facet].length > 0)
      ? 'preference'
      : 'none';

  const applyFilters = useCallback(
    (next: RunsFilterState, options: { persist?: boolean } = {}) => {
      setParams({
        [FACET_PARAM.agents]: next.agents,
        [FACET_PARAM.kinds]: next.kinds,
        [FACET_PARAM.statuses]: next.statuses,
      });
      // `persist: false` is for state the USER did not choose — a deep link's
      // `?tab=` shorthand, say. Saving that would turn a one-off link into a
      // durable filter the operator never set and would later have to
      // discover and undo.
      if (options.persist !== false) {
        writePreference(uid, next);
        setPreferenceTick((tick) => tick + 1);
      }
      setPendingFilters(next);
    },
    [setParams, uid]
  );

  const setFacet = useCallback(
    (facet: RunsFacet, values: string[], options: { persist?: boolean } = {}) => {
      applyFilters({ ...filters, [facet]: [...new Set(values)] }, options);
    },
    [applyFilters, filters]
  );

  const toggleValue = useCallback(
    (facet: RunsFacet, value: string) => {
      const current = filters[facet];
      const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
      applyFilters({ ...filters, [facet]: next });
    },
    [applyFilters, filters]
  );

  const reset = useCallback(() => {
    // Clear from what is ACTUALLY in the address bar, not from React's
    // snapshot of it. `useSearchParams` can lag a just-completed navigation
    // (arriving on `?kind=mission` and pressing Reset in the same beat), and
    // rebuilding the URL from a stale snapshot left the param in place — so
    // the filter came back on the next reload, and for whoever opened the
    // shared link. Only the facet params are dropped; an unrelated deep-link
    // param (e.g. `?build=<id>`) is not this control's to discard.
    const current = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : params.toString());
    for (const facet of FACETS) current.delete(FACET_PARAM[facet]);
    const query = current.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    // Keep the App Router state in sync, then synchronously commit the exact
    // same URL below so an immediate reload cannot observe the old facets.
    router.replace(target, { scroll: false });
    if (typeof window !== 'undefined') {
      // Next's App Router integrates the native History API with
      // `useSearchParams`. Using it here makes the address-bar mutation
      // synchronous, so a reload immediately after Reset cannot resurrect the
      // facet from a navigation that was still pending.
      // Pass a caller-owned state value so Next's patched History API also
      // updates its canonical URL. Reusing `window.history.state` carries
      // Next's `__NA` marker, which makes the patch treat this as an internal
      // write and lets a later router commit restore the stale facet query.
      window.history.replaceState(null, '', target);
    }

    clearPreference(uid);
    setPreferenceTick((tick) => tick + 1);
    setPendingFilters(EMPTY_FILTERS);
  }, [params, pathname, router, uid]);

  const matches = useCallback(
    (row: RunsFilterableRow) => {
      if (filters.agents.length > 0 && !filters.agents.includes(row.agent)) return false;
      if (filters.kinds.length > 0 && !filters.kinds.includes(row.kind)) return false;
      if (filters.statuses.length > 0 && !filters.statuses.includes(row.status)) return false;
      return true;
    },
    [filters]
  );

  const activeCount = FACETS.reduce((total, facet) => total + filters[facet].length, 0);

  return { filters, source, activeCount, setFacet, toggleValue, reset, matches };
}
