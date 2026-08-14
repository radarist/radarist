'use client';

/**
 * @file components/activity/activity-table-shell.tsx
 * @description Shared table-shell primitives for the Activity surfaces
 * (`/agents/runs` → Agent Runs, `/agents/jobs` → Jobs).
 *
 * UX-068 moved Background Verifications off the Agent Runs page onto its own
 * Jobs page. Both pages must read as the SAME table — same card header, same
 * toolbar row, same sortable header affordance and `aria-sort` wiring, same
 * scroll/sticky-header treatment, same empty/error/retry shape, and the same
 * `DataPagination` footer. Copying `RunsTable`'s markup into a second file
 * would have made that parity a matter of discipline; extracting the shell
 * makes it a matter of fact — a change to the header or the sort affordance
 * lands on both surfaces or on neither.
 *
 * Only the *shell* lives here. Column sets, row rendering, filter semantics and
 * the domain vocabulary stay with each table: Agent Runs and Jobs describe
 * different things and must be free to say so.
 */

import * as React from 'react';
import { AlertCircle, RefreshCw, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { cn } from '@/lib/utils';

export type ActivitySortDirection = 'asc' | 'desc';

// ============================================================================
// CARD HEADER (CONV-HEADER)
// ============================================================================

/**
 * Card header — title + muted subtitle left, controls right, one row.
 * The `<h1>` is the page's heading: these tables own the page-level title
 * block rather than floating a `PageHeader` above the card (see `RunsTable`'s
 * CONV-HEADER note).
 */
export function ActivityTableCardHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border p-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="shrink-0 space-y-1 lg:pt-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {children && (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">{children}</div>
      )}
    </div>
  );
}

/** Search box for a card header's control cluster. */
export function ActivityTableSearch({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name — the placeholder alone is not a label. */
  label: string;
  testId: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        data-testid={testId}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full pl-10 sm:w-[220px]"
      />
    </div>
  );
}

/**
 * The strip between the card header and the table — active filter chips, the
 * "showing x of y" summary, Reset. Rendered only when it has something to say.
 */
export function ActivityTableToolbarRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">{children}</div>;
}

// ============================================================================
// SORTABLE COLUMN HEADER
// ============================================================================

/**
 * `TableHead` wrapper around the shared library `SortableHeader` — identical
 * look to the library tables, with `aria-sort` kept on the `<th>` (its correct
 * ARIA home) and a stable per-surface test id (`${testIdPrefix}-${field}`).
 * `align="right"` matches the `justify-end` idiom the library tables use for
 * right-aligned numeric sortable columns.
 */
export function ActivityTableSortableHead<Field extends string>({
  label,
  field,
  currentField,
  currentDirection,
  onSort,
  testIdPrefix,
  className,
  align = 'left',
}: {
  label: string;
  field: Field;
  currentField: Field;
  currentDirection: ActivitySortDirection;
  onSort: (field: Field) => void;
  testIdPrefix: string;
  className?: string;
  align?: 'left' | 'right';
}) {
  const isActive = currentField === field;

  return (
    <TableHead
      className={cn('px-4 py-3', className)}
      aria-sort={isActive ? (currentDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`${testIdPrefix}-${field}`}
    >
      <SortableHeader
        label={label}
        sortKey={field}
        currentSort={{ key: currentField, direction: currentDirection }}
        // `SortableHeader` echoes back the `sortKey` it was given, so forwarding
        // `field` directly keeps the callback typed without a cast.
        onSort={() => onSort(field)}
        className={align === 'right' ? 'justify-end' : undefined}
      />
    </TableHead>
  );
}

/**
 * Toggles sort state for a click on `field`: same column flips direction,
 * a new column starts at `desc` (most-recent/largest first, which is what a
 * reader means by "sort by this").
 */
export function nextSortState<Field extends string>(
  current: { field: Field; direction: ActivitySortDirection },
  field: Field
): { field: Field; direction: ActivitySortDirection } {
  if (current.field === field) {
    return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { field, direction: 'desc' };
}

// ============================================================================
// TABLE BODY SHELL
// ============================================================================

/**
 * Scroll container + `<Table>` + sticky header row. Bounded horizontal
 * overflow lives here so a narrow viewport scrolls the table rather than the
 * page.
 */
export function ActivityTableFrame({
  ariaLabel,
  head,
  children,
}: {
  ariaLabel: string;
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-auto">
      <Table aria-label={ariaLabel}>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="border-b border-border hover:bg-transparent">{head}</TableRow>
        </TableHeader>
        {children}
      </Table>
    </div>
  );
}

// ============================================================================
// ERROR STATE
// ============================================================================

/**
 * The table could not be loaded at all. Distinct from an empty result: it says
 * the surface is unavailable and offers the one action that can change that.
 */
export function ActivityTableUnavailable({
  title,
  description,
  onRetry,
  testId,
}: {
  title: string;
  description: string;
  onRetry: () => void;
  testId: string;
}) {
  return (
    <div className="space-y-4 p-6" role="alert" data-testid={testId}>
      <div className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      <Button onClick={onRetry} variant="outline" size="sm">
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
      </Button>
    </div>
  );
}
