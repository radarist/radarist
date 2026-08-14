/**
 * @file InsightTable.tsx
 * @description Column-based list view for briefing insights.
 *
 * Table layout matches the canonical library-table pattern
 * (reference: CompaniesTable + library/shared/SortableHeader):
 *
 *   - Plain-text sortable headers (Title / Type / Agent / Confidence /
 *     Detected) via the shared `SortableHeader`, with `aria-sort` on the
 *     `TableHead` and stable `insights-sort-*` test ids
 *   - Sticky `bg-background` header row (48px recipe: `px-4 py-3` cells,
 *     `hover:bg-transparent` header row)
 *   - Shared `DataPagination` footer (`itemLabel="insights"`)
 *
 * Owns:
 *
 *   - Sort state (column + direction), URL-persisted via `useUrlParams`
 *     (pure helpers in ./insight-sort).
 *   - Pagination state (`page`, `pageSize`), also URL-persisted so a
 *     shared link reproduces the same page slice.
 *   - Per-row selection state (lifted from rows via props so the
 *     bulk-action toolbar can read + clear it).
 *
 * Sort + paginate live here; filter lives in BriefingFeed (Chunk 4) so
 * the toolbar can stay above the table. Keyboard nav (Chunk 5) feeds
 * the focused id in via `focusedId`.
 */

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { SortableHeader } from '@/components/library/shared/SortableHeader';

import { InsightTableRow } from './InsightTableRow';
import {
  compareInsights,
  defaultInsightSortDirection,
  isInsightSortField,
  parseInsightSort,
  serializeInsightSort,
  type InsightSortField,
} from './insight-sort';
import { useUrlParams } from '@/hooks/useUrlState';
import type { SortConfig } from '@/components/library/shared/types';
import type { BriefingInsight } from '@/hooks/useBriefing';
import { cn } from '@/lib/utils';

/** Page-size default matches the shared DataPagination options (10/20/50). */
const PAGE_SIZE_OPTIONS = [10, 20, 50];
const DEFAULT_PAGE_SIZE = 10;

interface InsightTableProps {
  insights: BriefingInsight[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  focusedId?: string | null;
}

export function InsightTable({ insights, selectedIds, onSelectedIdsChange, focusedId }: InsightTableProps) {
  // All three URL params share one writer so changes batch into a
  // single `router.replace`. Earlier implementation used three
  // independent `useUrlState` hooks; firing two of them back-to-back
  // (`onPageSizeChange` then `onPageChange(0)`) raced because each
  // setValue read its own snapshot of `searchParams` — the second
  // call clobbered the first. `useUrlParams.setParams` updates many
  // keys in one go off the same snapshot.
  const { params, setParams } = useUrlParams();

  const rawSort = params.get('sort') ?? undefined;
  const rawPage = params.get('page');
  const rawPageSize = params.get('pageSize');

  const sort = parseInsightSort(rawSort);
  const pageIndex = Math.max(0, parseInt(rawPage ?? '0', 10) || 0);
  const pageSize = (() => {
    const parsed = parseInt(rawPageSize ?? '', 10);
    return PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
  })();

  // The shared library DataPagination fires `onPageSizeChange(size)` then
  // `onPageChange(0)` back-to-back in the same tick. Both writes read the
  // same (stale) `searchParams` snapshot, so a page write that only set
  // `page` would silently drop the `pageSize` the first write just made.
  // The ref carries the just-written size into the follow-up page write so
  // every pagination write contains the full {page, pageSize} pair.
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  const handleSortClick = useCallback(
    (key: string) => {
      if (!isInsightSortField(key)) return;
      const next: SortConfig =
        sort.key === key
          ? { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: defaultInsightSortDirection(key) };
      // Reset to the first page in the same write (canonical convention —
      // re-sorting from page 3 would otherwise show an arbitrary slice).
      setParams({ sort: serializeInsightSort(next), page: null });
    },
    [sort.key, sort.direction, setParams]
  );

  const handlePageChange = useCallback(
    (next: number) => {
      // `null` clears the param so the default-page URL stays bare.
      const size = pageSizeRef.current;
      setParams({
        page: next === 0 ? null : String(next),
        pageSize: size === DEFAULT_PAGE_SIZE ? null : String(size),
      });
    },
    [setParams]
  );

  const handlePageSizeChange = useCallback(
    (nextSize: number) => {
      // Batch: reset to page 0 in the same write so the two updates
      // can't race each other (the very bug this refactor fixes).
      pageSizeRef.current = nextSize;
      setParams({
        pageSize: nextSize === DEFAULT_PAGE_SIZE ? null : String(nextSize),
        page: null,
      });
    },
    [setParams]
  );

  const { key: sortKey, direction: sortDirection } = sort;
  const sortedInsights = useMemo(() => {
    const copy = [...insights];
    copy.sort((a, b) => compareInsights(a, b, { key: sortKey, direction: sortDirection }));
    return copy;
  }, [insights, sortKey, sortDirection]);

  // Slice the sorted list for the current page. Clamp `pageIndex` so a
  // shared link with a now-stale page param falls back to a valid page
  // rather than rendering an empty body.
  const totalPages = Math.max(1, Math.ceil(sortedInsights.length / pageSize));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = safePageIndex * pageSize;
  const pageInsights = sortedInsights.slice(pageStart, pageStart + pageSize);

  const allSelected = pageInsights.length > 0 && pageInsights.every((i) => selectedIds.has(i.id));
  const someSelected = !allSelected && pageInsights.some((i) => selectedIds.has(i.id));

  const toggleAll = useCallback(() => {
    if (allSelected) {
      const next = new Set(selectedIds);
      for (const i of pageInsights) next.delete(i.id);
      onSelectedIdsChange(next);
    } else {
      const next = new Set(selectedIds);
      for (const i of pageInsights) next.add(i.id);
      onSelectedIdsChange(next);
    }
  }, [allSelected, selectedIds, pageInsights, onSelectedIdsChange]);

  const toggleRow = useCallback(
    (id: string, selected: boolean) => {
      const next = new Set(selectedIds);
      if (selected) next.add(id);
      else next.delete(id);
      onSelectedIdsChange(next);
    },
    [selectedIds, onSelectedIdsChange]
  );

  if (sortedInsights.length === 0) {
    return (
      <div data-testid="insight-table-empty" className="p-8 text-center text-muted-foreground">
        No insights to show.
      </div>
    );
  }

  // No outer rounded card here — the page (`triage/insights/page.tsx`)
  // already wraps the toolbar + table + pagination in a single
  // `PageShell` container. Nesting another rounded border produced the
  // "card inside a card" look the design audit (2026-05-13) flagged.
  return (
    <div data-testid="insight-table" className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label={allSelected ? 'Clear all selections' : 'Select all rows'}
                className={cn(someSelected && 'opacity-50')}
                data-testid="insight-table-select-all"
              />
            </TableHead>
            <SortableHead field="title" label="Title" sort={sort} onSortClick={handleSortClick} />
            <SortableHead field="type" label="Type" sort={sort} onSortClick={handleSortClick} />
            <SortableHead field="agentName" label="Agent" sort={sort} onSortClick={handleSortClick} />
            <SortableHead field="confidenceScore" label="Confidence" sort={sort} onSortClick={handleSortClick} />
            <SortableHead field="createdAt" label="Detected" sort={sort} onSortClick={handleSortClick} />
            <TableHead className="w-[50px] px-4 py-3 font-medium text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageInsights.map((insight) => (
            <InsightTableRow
              key={insight.id}
              insight={insight}
              selected={selectedIds.has(insight.id)}
              focused={focusedId === insight.id}
              onSelectedChange={(s) => toggleRow(insight.id, s)}
            />
          ))}
        </TableBody>
      </Table>

      <DataPagination
        pageIndex={safePageIndex}
        pageSize={pageSize}
        totalCount={sortedInsights.length}
        itemLabel="insights"
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
      />
    </div>
  );
}

/**
 * `TableHead` wrapper around the shared library `SortableHeader` —
 * identical look to CompaniesTable headers, with `aria-sort` kept on
 * the `<th>` (its correct ARIA home) and a stable test id.
 */
function SortableHead({
  field,
  label,
  sort,
  onSortClick,
}: {
  field: InsightSortField;
  label: string;
  sort: SortConfig;
  onSortClick: (key: string) => void;
}) {
  const active = sort.key === field;
  return (
    <TableHead
      className="px-4 py-3"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`insights-sort-${field}`}
    >
      <SortableHeader label={label} sortKey={field} currentSort={sort} onSort={onSortClick} />
    </TableHead>
  );
}

export function StandaloneInsightTable({ insights }: { insights: BriefingInsight[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  return <InsightTable insights={insights} selectedIds={selectedIds} onSelectedIdsChange={setSelectedIds} />;
}
