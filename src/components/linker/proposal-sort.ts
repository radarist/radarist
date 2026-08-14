/**
 * @file components/linker/proposal-sort.ts
 * @description Pure sort helpers for the Linker proposals table.
 *
 * Sort semantics (canonical library-table conventions — reference:
 * `compareCompanies` in useCompaniesPage):
 *   - source / target — entity display name, localeCompare
 *   - relation — relation type label (underscores read as spaces), localeCompare
 *   - confidence — numeric
 *   - createdAt — timestamp
 *
 * Ties return 0 so Array.prototype.sort (spec-stable) preserves input order.
 *
 * @author Radarist Team
 * @created 2026-06-10
 */

import type { SortConfig, SortDirection } from '@/components/library/shared/types';
import type { ProposedRelation } from '@/lib/types';

export const PROPOSAL_SORT_FIELDS = ['source', 'target', 'relation', 'confidence', 'createdAt'] as const;

export type ProposalSortField = (typeof PROPOSAL_SORT_FIELDS)[number];

export function isProposalSortField(key: string): key is ProposalSortField {
  return (PROPOSAL_SORT_FIELDS as readonly string[]).includes(key);
}

/** Default sort for the proposals list: newest first. */
export const DEFAULT_PROPOSAL_SORT: SortConfig = { key: 'createdAt', direction: 'desc' };

/**
 * First-click direction when activating a new column: numeric/date columns
 * start descending (highest confidence / newest first), text columns start
 * ascending — same convention as the infographics table alignment.
 */
export function defaultProposalSortDirection(field: ProposalSortField): SortDirection {
  return field === 'confidence' || field === 'createdAt' ? 'desc' : 'asc';
}

/** Relation type as displayed (underscores render as word separators). */
function relationLabel(proposal: ProposedRelation): string {
  return proposal.relationType.replace(/_/g, ' ');
}

/**
 * Pure comparator for proposals — exported for unit tests and used by the
 * Linker page before pagination. Unknown sort keys compare equal (no-op),
 * and equal values return 0 so the sort stays stable.
 */
export function compareProposals(a: ProposedRelation, b: ProposedRelation, sort: SortConfig): number {
  const direction = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'source':
      return direction * (a.sourceSnapshot?.name ?? '').localeCompare(b.sourceSnapshot?.name ?? '');
    case 'target':
      return direction * (a.targetSnapshot?.name ?? '').localeCompare(b.targetSnapshot?.name ?? '');
    case 'relation':
      return direction * relationLabel(a).localeCompare(relationLabel(b));
    case 'confidence':
      return direction * (a.confidence - b.confidence);
    case 'createdAt':
      return direction * (a.createdAt - b.createdAt);
    default:
      return 0;
  }
}
