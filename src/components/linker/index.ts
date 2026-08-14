/**
 * @file components/linker/index.ts
 * @description Linker component exports
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

export { ProposedRelationCard } from './ProposedRelationCard';
export { LinkerTriageQueue } from './LinkerTriageQueue';
export { LinkerProposalsTable } from './LinkerProposalsTable';
export { LinkerFilters, countActiveFilters } from './LinkerFilters';
export type { LinkerFiltersState } from './LinkerFilters';
export { LinkerStats, LinkerStatsSkeleton } from './LinkerStats';
export { LinkerSkeleton, LinkerListSkeleton } from './LinkerSkeleton';
export { RejectionReasonModal } from './RejectionReasonModal';
export {
  PROPOSAL_SORT_FIELDS,
  DEFAULT_PROPOSAL_SORT,
  isProposalSortField,
  defaultProposalSortDirection,
  compareProposals,
} from './proposal-sort';
export type { ProposalSortField } from './proposal-sort';
export {
  DEFAULT_PROPOSAL_SCOPE_FILTERS,
  describeProposalScope,
  filterProposals,
  intersectSelection,
  selectHighConfidence,
} from './proposal-scope';
export type { ProposalScopeFilters, ProposalScopeInput } from './proposal-scope';
