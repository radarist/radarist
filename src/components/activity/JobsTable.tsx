'use client';

/**
 * @file components/activity/JobsTable.tsx
 * @description Activity → Jobs table (UX-068) — one row per Defense Minister
 * background verification JobRun.
 *
 * Replaces the stacked `DefenseVerificationsPanel` that used to sit under the
 * Agent Runs table on `/agents/runs`. Two stacked tables on one page made
 * neither readable, and the lower one was a plain list: no sort, no search, no
 * rows-per-page, no result range, and a single "Next" button that could only go
 * forward. This is the same experience rebuilt on the Agent Runs table shell
 * (`activity-table-shell.tsx`), so the two Activity surfaces are the same table
 * with different columns rather than two tables that merely resemble each other.
 *
 * What did NOT change: the bounded, cursor-paginated
 * `/api/activity/defense-verifications` query, its server-side kind/status
 * filters, the lineage fields (target, endpoints, verifier pipeline version kept
 * separate from provider model, graph result), and the honest cost vocabulary —
 * settled / estimated / incomplete / partial / unavailable, with an em dash
 * rather than a fabricated `$0`.
 *
 * Sort, search and pagination are client-side over the loaded window. That is a
 * real limit, so the table states it: when the server reports more rows beyond
 * the window, the toolbar says so and offers to load the next page, and the
 * footer counts "loaded jobs" rather than claiming a total it cannot see.
 */

import * as React from 'react';
import { format } from 'date-fns';
import { Search, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTableSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { formatDuration } from '@/components/activity/run-formatters';
import {
  ActivityTableCardHeader,
  ActivityTableFrame,
  ActivityTableSearch,
  ActivityTableSortableHead,
  ActivityTableToolbarRow,
  ActivityTableUnavailable,
  nextSortState,
  type ActivitySortDirection,
} from './activity-table-shell';
import type { DefenseVerificationJobsFilters } from '@/hooks/useDefenseVerifications';
import type {
  DefenseVerificationCostState,
  DefenseVerificationKind,
  DefenseVerificationPartialReason,
  DefenseVerificationRow,
  DefenseVerificationStatus,
} from '@/lib/activity/defense-verification-types';

// ============================================================================
// VOCABULARY (unchanged from the panel this replaces)
// ============================================================================

const STATUS_META: Record<DefenseVerificationStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400',
  },
  retrying: {
    label: 'Retrying',
    className: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  },
  failed: {
    label: 'Failed',
    className: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-muted text-muted-foreground border-border',
  },
  // LOCAL-013 — the runtime stopped while this run was in flight and the
  // persisted queue did not survive, so it will never resume. Distinct from
  // Failed: the function did not run and throw.
  interrupted: {
    label: 'Interrupted',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

/** The statuses the route's query schema accepts — the filter cannot offer more. */
const FILTERABLE_STATUSES: DefenseVerificationStatus[] = ['running', 'retrying', 'completed', 'failed', 'cancelled'];

const KIND_LABEL: Record<DefenseVerificationKind, string> = { entity: 'Entity', edge: 'Edge' };

const COST_STATE_TONE: Record<DefenseVerificationCostState, 'muted' | 'success' | 'warning'> = {
  estimated: 'muted',
  settled: 'success',
  incomplete: 'warning',
  partial: 'warning',
  unavailable: 'muted',
};

const PARTIAL_REASON_LABEL: Partial<Record<DefenseVerificationPartialReason, string>> = {
  'no-receipts': 'No receipt',
  'no-graph-result': 'No graph result',
  'ambiguous-graph-result': 'Ambiguous result',
  'mismatched-graph-result': 'Mismatched result',
  'incomplete-accounting': 'Accounting incomplete',
  'mixed-currency': 'Mixed currency',
  'conflicted-settlement': 'Settlements conflicted',
  'dependency-outage': 'Dependency outage',
  'malformed-output': 'Malformed output',
  'hostile-output': 'Unsafe output',
  'orphan-target': 'Orphan target',
};

const EM_DASH = '—';

// ============================================================================
// SORTING
// ============================================================================

/** All 9 visible columns are sortable, matching the Agent Runs table. */
type JobSortField = 'target' | 'kind' | 'status' | 'provider' | 'verifier' | 'result' | 'cost' | 'duration' | 'started';

/**
 * Ascending comparators; the table negates for 'desc'. Unknown values sort
 * lowest so "we do not know" never masquerades as a small real value.
 *
 * Cost compares currency before amount: raw micro-units are only comparable
 * within one currency, and ordering `$5 CAD` against `$6 USD` by their integers
 * would state an exchange rate the ledger never established.
 */
function compareJobs(a: DefenseVerificationRow, b: DefenseVerificationRow, field: JobSortField): number {
  switch (field) {
    case 'target':
      return (a.targetId ?? '').localeCompare(b.targetId ?? '');
    case 'kind':
      return KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]);
    case 'status':
      return STATUS_META[a.status].label.localeCompare(STATUS_META[b.status].label);
    case 'provider':
      return a.providers.join(', ').localeCompare(b.providers.join(', '));
    case 'verifier':
      return (a.verifierModel ?? '').localeCompare(b.verifierModel ?? '');
    case 'result': {
      const byStatus = (a.resultStatus ?? '').localeCompare(b.resultStatus ?? '');
      if (byStatus !== 0) return byStatus;
      return (a.resultScore ?? -1) - (b.resultScore ?? -1);
    }
    case 'cost': {
      const byCurrency = (a.cost.currency ?? '').localeCompare(b.cost.currency ?? '');
      if (byCurrency !== 0) return byCurrency;
      return (a.cost.amountMicros ?? -1) - (b.cost.amountMicros ?? -1);
    }
    case 'duration':
      return (a.durationMs ?? -1) - (b.durationMs ?? -1);
    case 'started':
      return (a.startedAt ?? 0) - (b.startedAt ?? 0);
  }
}

/** Every field a search term is matched against, lowercased once per row. */
function searchCorpus(job: DefenseVerificationRow): string {
  return [
    job.id,
    job.targetId,
    job.targetSubIds?.sourceEntityId,
    job.targetSubIds?.targetEntityId,
    job.resultId,
    job.resultStatus,
    job.verifierModel,
    KIND_LABEL[job.kind],
    STATUS_META[job.status].label,
    ...job.providers,
    ...job.models,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
}

// ============================================================================
// CELLS
// ============================================================================

/** Absolute date for record tables (CONV-DATE) — never relative. */
function formatStartedAt(startedAt: number | null): string {
  if (startedAt === null) return EM_DASH;
  try {
    return format(new Date(startedAt), 'MMM d, yyyy');
  } catch {
    return EM_DASH;
  }
}

/** Kind — a classification, so a neutral outline pill (CONV-BADGE). */
function KindPill({ kind }: { kind: DefenseVerificationKind }) {
  return (
    <Badge variant="outline" className="text-xs font-normal">
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/** Status — a state, so a tinted outline pill (CONV-BADGE). */
function StatusPill({ status }: { status: DefenseVerificationStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={`text-xs font-normal ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}

function TargetCell({ job }: { job: DefenseVerificationRow }) {
  if (!job.targetId) {
    return <span className="text-muted-foreground">{EM_DASH}</span>;
  }
  return (
    <div className="min-w-0">
      <span className="block truncate font-mono text-xs" title={job.targetId}>
        {job.targetId}
      </span>
      {job.targetSubIds?.sourceEntityId && job.targetSubIds?.targetEntityId && (
        <span className="block truncate text-xs text-muted-foreground">
          {job.targetSubIds.sourceEntityId} → {job.targetSubIds.targetEntityId}
        </span>
      )}
    </div>
  );
}

function ProvidersCell({ job }: { job: DefenseVerificationRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs">{job.providers.join(', ') || EM_DASH}</span>
      <span className="text-xs text-muted-foreground">{job.models.join(', ') || EM_DASH}</span>
    </div>
  );
}

function ResultCell({ job }: { job: DefenseVerificationRow }) {
  if (!job.resultId) {
    return <span className="text-muted-foreground">{EM_DASH}</span>;
  }
  return (
    <div className="min-w-0">
      <span className="block max-w-[10rem] truncate font-mono text-xs" title={job.resultId}>
        {job.resultId}
      </span>
      <span className="text-xs text-muted-foreground">
        {job.resultStatus} {job.resultScore != null ? `(${job.resultScore})` : ''}
      </span>
    </div>
  );
}

function CostCell({ job }: { job: DefenseVerificationRow }) {
  const tone = COST_STATE_TONE[job.cost.state];
  const toneClass =
    tone === 'success' ? 'text-emerald-600' : tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground';
  const partialLabel = job.partialReason ? PARTIAL_REASON_LABEL[job.partialReason] : undefined;
  // OBS-007 — name the unreadable field(s). A row can carry BOTH a primary
  // degradation reason and a field gap, and an operator who sees only
  // "Malformed output" cannot tell whether the target was lost or just the score.
  const degradedLabel =
    job.degradedFields && job.degradedFields.length > 0 ? `Unreadable: ${job.degradedFields.join(', ')}` : undefined;
  return (
    <div className="flex flex-col items-end gap-0.5" data-testid="cost-cell">
      <span className={toneClass}>{job.cost.display}</span>
      {partialLabel && <span className="text-xs text-muted-foreground">{partialLabel}</span>}
      {degradedLabel && (
        <span className="text-xs text-muted-foreground" data-testid="degraded-fields">
          {degradedLabel}
        </span>
      )}
    </div>
  );
}

function JobRow({ job }: { job: DefenseVerificationRow }) {
  return (
    <TableRow
      className="cursor-default border-b border-border/40 transition-colors hover:bg-accent/30"
      data-testid={`job-row-${job.id}`}
    >
      <TableCell className="w-full max-w-0 px-4 py-3">
        <TargetCell job={job} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 sm:table-cell">
        <KindPill kind={job.kind} />
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusPill status={job.status} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 md:table-cell">
        <ProvidersCell job={job} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 lg:table-cell">
        <span className="block max-w-[10rem] truncate font-mono text-xs text-muted-foreground">
          {job.verifierModel || EM_DASH}
        </span>
      </TableCell>
      <TableCell className="hidden px-4 py-3 md:table-cell">
        <ResultCell job={job} />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap px-4 py-3 text-right text-sm lg:table-cell">
        <CostCell job={job} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 text-right text-sm text-muted-foreground lg:table-cell">
        {formatDuration(job.durationMs)}
      </TableCell>
      <TableCell className="w-[132px] whitespace-nowrap px-4 py-3 text-right text-sm text-muted-foreground">
        {formatStartedAt(job.startedAt)}
      </TableCell>
    </TableRow>
  );
}

// ============================================================================
// TABLE
// ============================================================================

export interface JobsTableProps {
  jobs: DefenseVerificationRow[];
  /** Server-side kind/status filters; owned by the page because they are query inputs. */
  filters: DefenseVerificationJobsFilters;
  onFiltersChange: (filters: DefenseVerificationJobsFilters) => void;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  /** The server reports rows beyond the loaded window. */
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}

const TITLE = 'Jobs';
const DESCRIPTION =
  'Background verification jobs run by the Defense Minister. Provider model and verifier pipeline version are reported separately.';

export function JobsTable({
  jobs,
  filters,
  onFiltersChange,
  isLoading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  isLoadingMore,
}: JobsTableProps) {
  const [search, setSearch] = React.useState('');
  const [sortField, setSortField] = React.useState<JobSortField>('started');
  const [sortDirection, setSortDirection] = React.useState<ActivitySortDirection>('desc');
  const [pageIndex, setPageIndex] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(10);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) => searchCorpus(job).includes(q));
  }, [jobs, search]);

  const sorted = React.useMemo(() => {
    const comparable = [...filtered];
    comparable.sort((a, b) => {
      const comparison = compareJobs(a, b, sortField);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return comparable;
  }, [filtered, sortField, sortDirection]);

  // The search box or a server-side filter narrowed the set — the previous page
  // offset may now be past its end, so snap back to page 1.
  const filterKey = `${filters.kind ?? ''}|${filters.status ?? ''}`;
  React.useEffect(() => {
    setPageIndex(0);
  }, [search, filterKey]);

  const activeFilterCount = (filters.kind ? 1 : 0) + (filters.status ? 1 : 0);
  const hasSearch = search.trim().length > 0;

  // One noun for the toolbar summary and the footer range: while rows remain
  // beyond the window the counts are of LOADED jobs, and both must say so.
  const countedNoun = hasMore ? 'loaded jobs' : jobs.length === 1 ? 'job' : 'jobs';

  const clearAllFilters = () => {
    setSearch('');
    onFiltersChange({});
  };

  const handleSort = (field: JobSortField) => {
    const next = nextSortState({ field: sortField, direction: sortDirection }, field);
    setSortField(next.field);
    setSortDirection(next.direction);
  };

  const pageRows = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  const sortHeadProps = (field: JobSortField) => ({
    field,
    currentField: sortField,
    currentDirection: sortDirection,
    onSort: handleSort,
    testIdPrefix: 'jobs-sort',
  });

  return (
    <div data-testid="jobs-table">
      <ActivityTableCardHeader title={TITLE} description={DESCRIPTION}>
        <Select
          value={filters.kind ?? 'all'}
          onValueChange={(value) =>
            onFiltersChange({ ...filters, kind: value === 'all' ? undefined : (value as DefenseVerificationKind) })
          }
        >
          <SelectTrigger className="h-9 w-[10rem]" aria-label="Filter by kind" data-testid="jobs-kind-filter">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {(Object.keys(KIND_LABEL) as DefenseVerificationKind[]).map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.status ?? 'all'}
          onValueChange={(value) =>
            onFiltersChange({
              ...filters,
              status: value === 'all' ? undefined : (value as DefenseVerificationStatus),
            })
          }
        >
          <SelectTrigger className="h-9 w-[10rem]" aria-label="Filter by status" data-testid="jobs-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {FILTERABLE_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_META[status].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <ActivityTableSearch
          testId="jobs-search-input"
          label="Search jobs"
          placeholder="Search jobs…"
          value={search}
          onChange={setSearch}
        />
      </ActivityTableCardHeader>

      {(activeFilterCount > 0 || hasSearch || hasMore) && !isLoading && !error && (
        <ActivityTableToolbarRow>
          {/* The visible count is stated against the total actually held. While
              a window is open that total is qualified as "loaded" — and the
              notice beside it says why — so a narrowed view can never read as
              the complete verification history. */}
          <span data-testid="jobs-filter-summary" className="text-xs text-muted-foreground">
            Showing {filtered.length} of {jobs.length} {countedNoun}
          </span>

          {hasMore && (
            <>
              <span data-testid="jobs-window-notice" className="text-xs text-muted-foreground">
                · More jobs exist beyond this window — search and sort cover the loaded rows only.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadMore}
                disabled={isLoadingMore}
                data-testid="jobs-load-more"
                className="h-7 px-2 text-xs"
              >
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </>
          )}

          {(activeFilterCount > 0 || hasSearch) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              data-testid="jobs-filter-reset"
              className="h-7 px-2 text-xs"
            >
              Reset
            </Button>
          )}
        </ActivityTableToolbarRow>
      )}

      {isLoading ? (
        <div className="p-4" data-testid="jobs-table-skeleton">
          <DataTableSkeleton rows={6} columns={5} />
        </div>
      ) : error ? (
        <ActivityTableUnavailable
          testId="jobs-table-unavailable"
          title="Background verifications unavailable"
          description="Could not load verification jobs right now. Please retry."
          onRetry={onRetry}
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={jobs.length === 0 && activeFilterCount === 0 && !hasSearch ? ShieldCheck : Search}
          title={
            jobs.length === 0 && activeFilterCount === 0 && !hasSearch
              ? 'No background verification jobs yet'
              : 'No matching jobs'
          }
          description={
            jobs.length === 0 && activeFilterCount === 0 && !hasSearch
              ? 'Entity and edge verifications will appear here once the Defense Minister starts running them.'
              : 'Try a different search term or clear the filters.'
          }
          action={
            jobs.length === 0 && activeFilterCount === 0 && !hasSearch
              ? { label: 'Refresh', onClick: onRetry }
              : { label: 'Clear filters', onClick: clearAllFilters }
          }
          size="sm"
        />
      ) : (
        <>
          <ActivityTableFrame
            ariaLabel="Background verification jobs"
            head={
              <>
                <ActivityTableSortableHead label="Target" {...sortHeadProps('target')} className="w-full" />
                <ActivityTableSortableHead label="Kind" {...sortHeadProps('kind')} className="hidden sm:table-cell" />
                <ActivityTableSortableHead label="Status" {...sortHeadProps('status')} />
                <ActivityTableSortableHead
                  label="Provider / Model"
                  {...sortHeadProps('provider')}
                  className="hidden md:table-cell"
                />
                <ActivityTableSortableHead
                  label="Verifier"
                  {...sortHeadProps('verifier')}
                  className="hidden lg:table-cell"
                />
                <ActivityTableSortableHead
                  label="Result"
                  {...sortHeadProps('result')}
                  className="hidden md:table-cell"
                />
                <ActivityTableSortableHead
                  label="Cost"
                  {...sortHeadProps('cost')}
                  className="hidden lg:table-cell"
                  align="right"
                />
                <ActivityTableSortableHead
                  label="Duration"
                  {...sortHeadProps('duration')}
                  className="hidden lg:table-cell"
                  align="right"
                />
                {/* Fixed width sized for the widest CONV-DATE string
                    ("Dec 31, 2026") + whitespace-nowrap so dates never wrap to
                    two lines at ≤1280 viewports; the Target column's w-full
                    absorbs the rebalance. Matches the Agent Runs table. */}
                <ActivityTableSortableHead
                  label="Started"
                  {...sortHeadProps('started')}
                  className="w-[132px] whitespace-nowrap"
                  align="right"
                />
              </>
            }
          >
            <TableBody>
              {pageRows.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </TableBody>
          </ActivityTableFrame>

          <DataPagination
            pageIndex={pageIndex}
            pageSize={pageSize}
            totalCount={sorted.length}
            onPageChange={setPageIndex}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPageIndex(0);
            }}
            itemLabel={hasMore ? 'loaded jobs' : 'jobs'}
          />
        </>
      )}
    </div>
  );
}
