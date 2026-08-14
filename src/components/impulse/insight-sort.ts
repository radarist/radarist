/**
 * @file components/impulse/insight-sort.ts
 * @description Pure sort helpers for the briefing InsightTable.
 *
 * Sort semantics (canonical library-table conventions — reference:
 * `compareProposals` in components/linker/proposal-sort):
 *   - title / type / agentName — string, localeCompare
 *   - confidenceScore — numeric
 *   - createdAt — ISO-8601 string; lexicographic compare === chronological
 *
 * Ties return 0 so Array.prototype.sort (spec-stable) preserves input order.
 * The `parse`/`serialize` pair backs the URL persistence (`?sort=key:dir`)
 * the table has had since Chunk 4 — a shared link reproduces the same order.
 *
 * @author Radarist Team
 * @created 2026-06-10
 */

import type { SortConfig, SortDirection } from '@/components/library/shared/types';
import type { BriefingInsight } from '@/hooks/useBriefing';

export const INSIGHT_SORT_FIELDS = ['title', 'type', 'agentName', 'confidenceScore', 'createdAt'] as const;

export type InsightSortField = (typeof INSIGHT_SORT_FIELDS)[number];

export function isInsightSortField(key: string): key is InsightSortField {
  return (INSIGHT_SORT_FIELDS as readonly string[]).includes(key);
}

/** Default sort for the insights list: newest first. */
export const DEFAULT_INSIGHT_SORT: SortConfig = { key: 'createdAt', direction: 'desc' };

/**
 * First-click direction when activating a new column: numeric/date columns
 * start descending (highest confidence / newest first), text columns start
 * ascending — same convention as the linker/infographics table alignments.
 */
export function defaultInsightSortDirection(field: InsightSortField): SortDirection {
  return field === 'confidenceScore' || field === 'createdAt' ? 'desc' : 'asc';
}

/**
 * Parse the URL `sort` param (`key:direction`). Anything malformed —
 * unknown key, bad direction, missing value — falls back to the default
 * so a hand-edited or stale shared link can't break the table.
 */
export function parseInsightSort(raw: string | null | undefined): SortConfig {
  if (!raw) return DEFAULT_INSIGHT_SORT;
  const [key, direction] = raw.split(':');
  if (!isInsightSortField(key)) return DEFAULT_INSIGHT_SORT;
  if (direction !== 'asc' && direction !== 'desc') return DEFAULT_INSIGHT_SORT;
  return { key, direction };
}

/** Serialize a sort config into the URL `sort` param value. */
export function serializeInsightSort(sort: SortConfig): string {
  return `${sort.key}:${sort.direction}`;
}

/**
 * Pure comparator for insights — exported for unit tests and used by the
 * InsightTable before pagination. Unknown sort keys compare equal (no-op),
 * and equal values return 0 so the sort stays stable.
 */
export function compareInsights(a: BriefingInsight, b: BriefingInsight, sort: SortConfig): number {
  if (!isInsightSortField(sort.key)) return 0;
  const direction = sort.direction === 'asc' ? 1 : -1;
  const av = a[sort.key];
  const bv = b[sort.key];
  if (typeof av === 'number' && typeof bv === 'number') return direction * (av - bv);
  return direction * String(av ?? '').localeCompare(String(bv ?? ''));
}
