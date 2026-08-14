/**
 * @file components/linker/proposal-scope.ts
 * @description UX-037 — the single derivation of "the proposals the operator is
 * acting on" for the Linker triage page.
 *
 * The page previously derived the visible list from one query
 * (`useProposedRelations` + filters) and the Approve-High mutation set from a
 * different, unfiltered one (`usePendingProposedRelations`). Those two sets
 * diverge the moment any filter is active, so `handleBulkApprove` wrote
 * proposals the operator could not see.
 *
 * The rule this module exists to enforce:
 *
 *   visible scope == authorized mutation set
 *
 * Every consumer — list rows, triage queue, the Approve-High count, the
 * confirmation copy, and the bulk mutations — reads the SAME array produced by
 * `filterProposals`. `selectHighConfidence` and `intersectSelection` only ever
 * narrow that array, so no derived set can escape it.
 *
 * Pure functions only: no React, no query client, no I/O. That is what makes
 * the scope contract testable without rendering the page.
 */

import type { ProposedRelation } from '@/lib/types';
import type { LinkerFiltersState } from './LinkerFilters';

/**
 * The subset of the page's filter state that narrows the proposal set.
 * `sortBy` is deliberately excluded — ordering changes what the operator reads
 * first, never which proposals they are authorized to mutate.
 */
export type ProposalScopeFilters = Omit<LinkerFiltersState, 'sortBy'>;

export const DEFAULT_PROPOSAL_SCOPE_FILTERS: ProposalScopeFilters = {
  status: 'pending',
  sourceType: 'all',
  targetType: 'all',
  relationType: 'all',
  discoveredBy: 'all',
  minConfidence: 0,
};

export interface ProposalScopeInput {
  /** Free-text search over source name, target name, and relation type. */
  searchQuery: string;
  filters: ProposalScopeFilters;
}

/** Human-readable facet labels for the confirmation copy. */
const FACET_LABELS: Record<keyof Omit<ProposalScopeFilters, 'minConfidence'>, string> = {
  status: 'status',
  sourceType: 'source type',
  targetType: 'target type',
  relationType: 'relation type',
  discoveredBy: 'source',
};

/**
 * The visible scope: every proposal that matches the active search and facets.
 *
 * Pagination is deliberately NOT applied here. A page is a viewport over this
 * scope, not a narrowing of it — the footer counts this array, and the operator
 * navigating to page 2 has not deselected page 1. Sorting is applied by the
 * caller, since ordering does not change membership.
 */
export function filterProposals(
  proposals: readonly ProposedRelation[],
  { searchQuery, filters }: ProposalScopeInput
): ProposedRelation[] {
  const query = searchQuery.trim().toLowerCase();

  return proposals.filter((proposal) => {
    if (query) {
      const haystack = [proposal.sourceSnapshot?.name, proposal.targetSnapshot?.name, proposal.relationType];
      if (!haystack.some((value) => value?.toLowerCase().includes(query))) return false;
    }

    if (filters.status !== 'all' && proposal.status !== filters.status) return false;
    if (filters.sourceType !== 'all' && proposal.sourceType !== filters.sourceType) return false;
    if (filters.targetType !== 'all' && proposal.targetType !== filters.targetType) return false;
    if (filters.relationType !== 'all' && proposal.relationType !== filters.relationType) return false;
    if (filters.discoveredBy !== 'all' && proposal.discoveredBy !== filters.discoveredBy) return false;
    if (filters.minConfidence > 0 && proposal.confidence < filters.minConfidence) return false;

    return true;
  });
}

/**
 * The Approve-High set: the pending proposals inside `visible` that clear the
 * threshold. Takes the already-scoped array rather than the raw query result
 * precisely so it cannot reach a hidden proposal.
 */
export function selectHighConfidence(visible: readonly ProposedRelation[], threshold: number): ProposedRelation[] {
  return visible.filter((proposal) => proposal.status === 'pending' && proposal.confidence >= threshold);
}

/**
 * Narrow a selection to the ids still present in the visible scope.
 *
 * Selection outlives a filter change, so this runs both when the scope changes
 * (to keep the toolbar count honest) and again at mutation time (so a race
 * between a refetch and a click cannot widen the write). Returns the original
 * array when nothing was dropped, which keeps the `useEffect` that prunes
 * selection from looping on a fresh identity.
 */
export function intersectSelection(selectedIds: readonly string[], visible: readonly ProposedRelation[]): string[] {
  const visibleIds = new Set(visible.map((proposal) => proposal.id));
  const kept = selectedIds.filter((id) => visibleIds.has(id));
  return kept.length === selectedIds.length ? (selectedIds as string[]) : kept;
}

/**
 * One-line description of the active scope, for confirmation dialogs.
 *
 * The dialog has to state what it is about to write. "Approve all
 * high-confidence proposals" is only honest when nothing is filtered; once a
 * facet is active the operator needs to read the narrowing back before
 * confirming.
 */
export function describeProposalScope(searchQuery: string, filters: ProposalScopeFilters): string {
  const parts: string[] = [];

  const query = searchQuery.trim();
  if (query) parts.push(`matching "${query}"`);

  for (const [key, label] of Object.entries(FACET_LABELS) as [keyof typeof FACET_LABELS, string][]) {
    const value = filters[key];
    if (value !== 'all') parts.push(`${label} ${value}`);
  }

  if (filters.minConfidence > 0) parts.push(`confidence ≥ ${filters.minConfidence}%`);

  return parts.length === 0 ? 'all proposals' : parts.join(', ');
}
